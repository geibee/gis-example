package legacymigration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"slices"
	"strings"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

const defaultEvidencePrefix = "evidence/migration/"

// Service はstorage I/OをDB transaction外に保つlegacy migration境界である。
type Service struct {
	store    Store
	objects  objectstore.Store
	settings Settings
}

func NewService(store Store, objects objectstore.Store, settings Settings) (*Service, error) {
	if store == nil || objects == nil {
		return nil, errors.New("legacy migration dependencyが未設定です")
	}
	if settings.EvidencePrefix == "" {
		settings.EvidencePrefix = defaultEvidencePrefix
	}
	if !strings.HasSuffix(settings.EvidencePrefix, "/") || objectstore.ValidatePrefix(settings.EvidencePrefix) != nil {
		return nil, errors.New("legacy migration evidence prefixが不正です")
	}
	if settings.MaximumEvidenceBytes == 0 {
		settings.MaximumEvidenceBytes = defaultMaximumEvidenceBytes
	}
	if settings.DeleteAttempts == 0 {
		settings.DeleteAttempts = 3
	}
	if settings.MaximumEvidenceBytes < 1 || settings.StorageTimeout <= 0 ||
		settings.DeleteAttempts < 1 || settings.DeleteAttempts > 10 {
		return nil, errors.New("legacy migration settingsが不正です")
	}
	return &Service{store: store, objects: objects, settings: settings}, nil
}

func (service *Service) DryRun(ctx context.Context, snapshot Snapshot) (Report, error) {
	plan, err := service.plan(ctx, snapshot, uuid.NewString(), true)
	if err != nil {
		return Report{}, err
	}
	if err := service.store.CheckLegacyMigrationCollisions(ctx, CollisionInput{
		Snapshot: plan.Snapshot, RunID: plan.Report.RunID, SourceChecksum: plan.Report.SourceChecksum, Scope: plan.Scope,
	}); err != nil {
		return Report{}, err
	}
	if err := service.checkObjectCollisions(ctx, plan.Evidence); err != nil {
		return Report{}, err
	}
	return plan.Report, nil
}

func (service *Service) Apply(ctx context.Context, snapshot Snapshot, runID string) (Report, error) {
	if parsed, err := uuid.Parse(runID); err != nil || parsed.String() != runID {
		return Report{}, migrationError(ErrInvalidInput, "legacy.run_id_invalid", "run IDがUUIDではありません")
	}
	plan, err := service.plan(ctx, snapshot, runID, false)
	if err != nil {
		return Report{}, err
	}
	run, found, err := service.store.FindLegacyMigrationRun(ctx, runID)
	if err != nil {
		return Report{}, err
	}
	if found {
		if run.SourceChecksum != plan.Report.SourceChecksum {
			return Report{}, migrationError(ErrConflict, "legacy.run_snapshot_mismatch", "migration runとsnapshotが一致しません")
		}
		if run.Status != "applied" {
			return Report{}, migrationError(ErrConflict, "legacy.run_rolled_back", "rollback済みrun IDは再利用できません")
		}
		return service.Reconcile(ctx, plan.Snapshot, runID)
	}
	if err := service.store.CheckLegacyMigrationCollisions(ctx, CollisionInput{
		Snapshot: plan.Snapshot, RunID: runID, SourceChecksum: plan.Report.SourceChecksum, Scope: plan.Scope,
	}); err != nil {
		return Report{}, err
	}
	copied := make([]string, 0, len(plan.Evidence))
	for _, value := range plan.Evidence {
		exists, matches, inspectErr := service.inspectObject(ctx, value)
		if inspectErr != nil {
			return Report{}, inspectErr
		}
		if exists {
			if !matches {
				return Report{}, migrationError(ErrConflict, "legacy.object_collision", "evidence object keyが既に存在します")
			}
			// 前回のPut成功後に応答だけ失われた場合は同一内容を再利用する。
			copied = append(copied, value.ObjectKey)
			continue
		}
		putCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
		err := service.objects.Put(putCtx, value.ObjectKey, value.Source.ContentType, value.Data)
		cancel()
		if err != nil {
			existsAfter, matchesAfter, inspectAfterErr := service.inspectObject(ctx, value)
			if inspectAfterErr == nil && existsAfter && matchesAfter {
				copied = append(copied, value.ObjectKey)
				continue
			}
			cleanupErr := service.deleteObjects(context.WithoutCancel(ctx), copied)
			return Report{}, errors.Join(
				storageError("evidence objectをcopyできません", err), inspectAfterErr, cleanupErr,
			)
		}
		copied = append(copied, value.ObjectKey)
	}
	if err := service.store.ApplyLegacyMigration(ctx, plan); err != nil {
		// commit結果不明では、DBに参照済みかもしれないobjectを削除しない。
		if errors.Is(err, ErrCommitUnknown) {
			return Report{}, err
		}
		cleanupErr := service.deleteObjects(context.WithoutCancel(ctx), copied)
		return Report{}, errors.Join(err, cleanupErr)
	}
	return plan.Report, nil
}

func (service *Service) Reconcile(ctx context.Context, snapshot Snapshot, runID string) (Report, error) {
	if parsed, err := uuid.Parse(runID); err != nil || parsed.String() != runID {
		return Report{}, migrationError(ErrInvalidInput, "legacy.run_id_invalid", "run IDがUUIDではありません")
	}
	plan, err := service.plan(ctx, snapshot, runID, false)
	if err != nil {
		return Report{}, err
	}
	differences, err := service.store.ReconcileLegacyMigration(ctx, plan)
	if err != nil {
		return Report{}, err
	}
	for _, value := range plan.Evidence {
		if difference := service.reconcileObject(ctx, value); difference != "" {
			differences = append(differences, difference)
		}
	}
	slices.Sort(differences)
	plan.Report.Differences = differences
	return plan.Report, nil
}

func (service *Service) Rollback(ctx context.Context, snapshot Snapshot, runID string) (Report, error) {
	if parsed, err := uuid.Parse(runID); err != nil || parsed.String() != runID {
		return Report{}, migrationError(ErrInvalidInput, "legacy.run_id_invalid", "run IDがUUIDではありません")
	}
	plan, err := service.plan(ctx, snapshot, runID, false)
	if err != nil {
		return Report{}, err
	}
	run, found, err := service.store.FindLegacyMigrationRun(ctx, runID)
	if err != nil {
		return Report{}, err
	}
	if !found {
		return Report{}, migrationError(ErrInvalidInput, "legacy.run_not_found", "migration runがありません")
	}
	if run.SourceChecksum != plan.Report.SourceChecksum {
		return Report{}, migrationError(ErrConflict, "legacy.run_snapshot_mismatch", "migration runとsnapshotが一致しません")
	}
	if run.Status == "applied" {
		reconciled, err := service.Reconcile(ctx, plan.Snapshot, runID)
		if err != nil {
			return Report{}, err
		}
		if len(reconciled.Differences) != 0 {
			return Report{}, migrationError(
				ErrConflict, "legacy.rollback_drift", "copy後に差分があるためrollbackを拒否しました",
			)
		}
	}
	result, err := service.store.RollbackLegacyMigration(ctx, runID, plan.Report.SourceChecksum)
	if err != nil {
		return Report{}, err
	}
	if err := service.deleteObjects(context.WithoutCancel(ctx), result.ObjectKeys); err != nil {
		// journalはrolled-backのまま保持され、同じrollbackでobject削除だけ再試行できる。
		return Report{}, err
	}
	plan.Report.Differences = []string{}
	return plan.Report, nil
}

func (service *Service) plan(ctx context.Context, snapshot Snapshot, runID string, dryRun bool) (ApplyPlan, error) {
	if err := service.store.ValidateLegacyMigrationSchema(ctx); err != nil {
		return ApplyPlan{}, err
	}
	snapshot = normalizeSnapshot(snapshot)
	evidenceValues, err := validateSnapshot(snapshot, service.settings.MaximumEvidenceBytes)
	if err != nil {
		return ApplyPlan{}, err
	}
	scope, err := service.store.ResolveLegacyMigrationScope(ctx, snapshot)
	if err != nil {
		return ApplyPlan{}, err
	}
	threads, err := mapThreads(snapshot, scope.Manifest)
	if err != nil {
		return ApplyPlan{}, err
	}
	checksum, err := SnapshotChecksum(snapshot)
	if err != nil {
		return ApplyPlan{}, err
	}
	for index := range evidenceValues {
		evidenceValues[index].ObjectKey = service.settings.EvidencePrefix + runID + "/" + evidenceValues[index].Source.ID
		if err := objectstore.ValidateKey(evidenceValues[index].ObjectKey); err != nil {
			return ApplyPlan{}, migrationError(ErrInvalidInput, "legacy.object_key_invalid", "evidence object keyが不正です")
		}
	}
	report := Report{
		RunID: runID, SourceChecksum: checksum, DryRun: dryRun,
		Sessions: len(snapshot.Sessions), Threads: len(snapshot.Threads), Messages: len(snapshot.Messages),
		MessageVersions: len(snapshot.MessageVersions), Evidence: len(snapshot.Evidence),
		Audits: len(snapshot.Audits), Outbox: len(snapshot.Outbox), Differences: []string{},
	}
	return ApplyPlan{Snapshot: snapshot, Scope: scope, Threads: threads, Evidence: evidenceValues, Report: report}, nil
}

func (service *Service) checkObjectCollisions(ctx context.Context, values []PlannedEvidence) error {
	for _, value := range values {
		listCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
		refs, err := service.objects.List(listCtx, value.ObjectKey)
		cancel()
		if err != nil {
			return storageError("evidence object collisionを確認できません", err)
		}
		for _, ref := range refs {
			if ref.Key == value.ObjectKey {
				return migrationError(ErrConflict, "legacy.object_collision", "evidence object keyが既に存在します")
			}
		}
	}
	return nil
}

func (service *Service) reconcileObject(ctx context.Context, value PlannedEvidence) string {
	exists, matches, err := service.inspectObject(ctx, value)
	if err != nil || !exists {
		return "evidence " + value.Source.ID + ": objectを読み取れません"
	}
	if !matches {
		return "evidence " + value.Source.ID + ": object sizeまたはSHA-256が一致しません"
	}
	return ""
}

func (service *Service) inspectObject(ctx context.Context, value PlannedEvidence) (bool, bool, error) {
	getCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
	object, err := service.objects.Get(getCtx, value.ObjectKey)
	if err != nil {
		cancel()
		if errors.Is(err, objectstore.ErrNotFound) {
			return false, false, nil
		}
		return false, false, storageError("evidence objectを確認できません", err)
	}
	data, readErr := io.ReadAll(io.LimitReader(object.Body, service.settings.MaximumEvidenceBytes+1))
	closeErr := object.Body.Close()
	cancel()
	if readErr != nil || closeErr != nil || int64(len(data)) != object.Size || int64(len(data)) != int64(len(value.Data)) {
		return true, false, errors.Join(readErr, closeErr)
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != value.Source.SHA256 {
		return true, false, nil
	}
	return true, true, nil
}

func (service *Service) deleteObjects(ctx context.Context, keys []string) error {
	var result error
	for _, key := range keys {
		var last error
		for attempt := 0; attempt < service.settings.DeleteAttempts; attempt++ {
			deleteCtx, cancel := context.WithTimeout(ctx, service.settings.StorageTimeout)
			last = service.objects.Delete(deleteCtx, key)
			cancel()
			if last == nil {
				break
			}
		}
		if last != nil {
			result = errors.Join(result, storageError("evidence objectを削除できません: "+key, last))
		}
	}
	return result
}

func storageError(detail string, cause error) error {
	return errors.Join(migrationError(ErrStorageUnavailable, "legacy.storage_unavailable", detail), cause)
}
