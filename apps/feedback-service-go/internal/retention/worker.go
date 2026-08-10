package retention

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type Worker struct {
	store           WorkerStore
	evidenceObjects objectstore.Store
	exportObjects   objectstore.Store
	settings        WorkerSettings
}

func NewWorker(
	store WorkerStore,
	evidenceObjects objectstore.Store,
	exportObjects objectstore.Store,
	settings WorkerSettings,
) (*Worker, error) {
	if store == nil || evidenceObjects == nil || exportObjects == nil {
		return nil, errors.New("retention worker dependencyが未設定です")
	}
	if settings.OrphanGrace < 5*time.Minute || settings.BatchSize < 1 || settings.BatchSize > 1000 {
		return nil, errors.New("retention worker settingsが不正です")
	}
	if !strings.HasSuffix(settings.EvidencePrefix, "/") || !strings.HasSuffix(settings.ExportPrefix, "/") ||
		!strings.HasSuffix(settings.BackupPrefix, "/") ||
		objectstore.ValidatePrefix(settings.EvidencePrefix) != nil ||
		objectstore.ValidatePrefix(settings.ExportPrefix) != nil ||
		objectstore.ValidatePrefix(settings.BackupPrefix) != nil {
		return nil, errors.New("retention object prefixが不正です")
	}
	if strings.HasPrefix(settings.ExportPrefix, settings.BackupPrefix) ||
		strings.HasPrefix(settings.BackupPrefix, settings.ExportPrefix) {
		return nil, errors.New("exportとbackupのobject prefixは重複できません")
	}
	return &Worker{
		store: store, evidenceObjects: evidenceObjects,
		exportObjects: exportObjects, settings: settings,
	}, nil
}

// RunOnce はKotlin版の1 cycleと同じ順序で、各backlogをbatch単位で排出する。
func (worker *Worker) RunOnce(ctx context.Context, now time.Time) (bool, error) {
	if err := worker.store.DeleteExpiredInternalRecords(ctx); err != nil {
		return false, err
	}
	worked := false
	steps := []func(context.Context) (int, error){
		func(stepCtx context.Context) (int, error) {
			return worker.store.PurgeExpiredEvidence(stepCtx, worker.settings.BatchSize, worker.deleteEvidence)
		},
		func(stepCtx context.Context) (int, error) {
			return worker.store.PurgeExpiredExports(stepCtx, worker.settings.BatchSize, worker.deleteExport)
		},
		func(stepCtx context.Context) (int, error) {
			return worker.store.PurgeExpiredBackups(stepCtx, worker.settings.BatchSize, worker.deleteExport)
		},
	}
	for _, step := range steps {
		for {
			if err := ctx.Err(); err != nil {
				return worked, err
			}
			count, err := step(ctx)
			if err != nil {
				return worked, err
			}
			worked = worked || count > 0
			if count < worker.settings.BatchSize {
				break
			}
		}
	}
	evidenceSweep, err := worker.sweepOrphans(
		ctx, now, worker.evidenceObjects, worker.settings.EvidencePrefix,
		worker.store.EvidenceObjectExists, "evidence",
	)
	if err != nil {
		return worked, err
	}
	exportSweep, err := worker.sweepOrphans(
		ctx, now, worker.exportObjects, worker.settings.ExportPrefix,
		worker.store.ExportObjectExists, "export",
	)
	if err != nil {
		return worked || evidenceSweep.Deleted > 0, err
	}
	backupSweep, err := worker.sweepBackupOrphans(ctx, now)
	if err != nil {
		return worked || evidenceSweep.Deleted > 0 || exportSweep.Deleted > 0, err
	}
	return worked || evidenceSweep.Deleted > 0 || exportSweep.Deleted > 0 || backupSweep.Deleted > 0, nil
}

func (worker *Worker) deleteEvidence(ctx context.Context, key string) error {
	return worker.evidenceObjects.Delete(ctx, key)
}

func (worker *Worker) deleteExport(ctx context.Context, key string) error {
	return worker.exportObjects.Delete(ctx, key)
}

func (worker *Worker) sweepBackupOrphans(ctx context.Context, now time.Time) (SweepResult, error) {
	return worker.sweepOrphans(
		ctx, now, worker.exportObjects, worker.settings.BackupPrefix,
		worker.store.BackupObjectExists, "backup",
	)
}

func (worker *Worker) sweepOrphans(
	ctx context.Context,
	now time.Time,
	objects objectstore.Store,
	prefix string,
	existsFunc func(context.Context, string) (bool, error),
	kind string,
) (SweepResult, error) {
	refs, err := objects.List(ctx, prefix)
	if err != nil {
		return SweepResult{}, fmt.Errorf("%s orphanを一覧できません: %w", kind, err)
	}
	result := SweepResult{Examined: len(refs)}
	cutoff := now.Add(-worker.settings.OrphanGrace)
	candidates := make([]string, 0, len(refs))
	for _, ref := range refs {
		if objectstore.ValidateKey(ref.Key) != nil || ref.LastModified.IsZero() {
			return result, fmt.Errorf("%s orphan metadataが不正です", kind)
		}
		if !ref.LastModified.Before(cutoff) {
			result.Retained++
			continue
		}
		exists, err := existsFunc(ctx, ref.Key)
		if err != nil {
			return result, fmt.Errorf("%s orphanをDBと照合できません: %w", kind, err)
		}
		if exists {
			result.Retained++
			continue
		}
		candidates = append(candidates, ref.Key)
	}
	var deleteErrors []error
	for _, key := range candidates {
		if err := objects.Delete(ctx, key); err != nil {
			result.Retained++
			deleteErrors = append(deleteErrors, fmt.Errorf("%s: %w", key, err))
			continue
		}
		result.Deleted++
	}
	if len(deleteErrors) > 0 {
		return result, fmt.Errorf("%s orphanを削除できません: %w", kind, errors.Join(deleteErrors...))
	}
	return result, nil
}
