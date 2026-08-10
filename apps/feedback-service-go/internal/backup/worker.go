package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type WorkerStore interface {
	ScheduleDueBackups(context.Context, time.Time) (int, error)
	ClaimBackup(context.Context) (*Claimed, error)
	PrepareBackup(context.Context, Claimed) (PreparedArchive, error)
	CompleteBackup(context.Context, Claimed, PreparedArchive, string, ArchiveResult) error
	FailBackup(context.Context, Claimed, string, int) error
}

type Worker struct {
	store           WorkerStore
	evidenceStorage objectstore.Store
	backupStorage   objectstore.Store
	keyPrefix       string
	maxAttempts     int
}

func NewWorker(
	store WorkerStore,
	evidenceStorage objectstore.Store,
	backupStorage objectstore.Store,
	keyPrefix string,
	maxAttempts int,
) (*Worker, error) {
	if store == nil || evidenceStorage == nil || backupStorage == nil {
		return nil, errors.New("backup worker dependencyが未設定です")
	}
	if !strings.HasSuffix(keyPrefix, "/") || objectstore.ValidatePrefix(keyPrefix) != nil {
		return nil, errors.New("backup key prefixが不正です")
	}
	if err := validateMaximumAttempts(maxAttempts); err != nil {
		return nil, err
	}
	return &Worker{
		store: store, evidenceStorage: evidenceStorage, backupStorage: backupStorage,
		keyPrefix: keyPrefix, maxAttempts: maxAttempts,
	}, nil
}

func (worker *Worker) RunOnce(ctx context.Context, now time.Time) (bool, error) {
	if _, err := worker.store.ScheduleDueBackups(ctx, now); err != nil {
		return false, err
	}
	claimed, err := worker.store.ClaimBackup(ctx)
	if err != nil || claimed == nil {
		return false, err
	}
	temporary, err := os.CreateTemp("", "feedback-backup-"+claimed.ID+"-*.zip")
	if err != nil {
		return true, err
	}
	path := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(path)
		return true, err
	}
	defer os.Remove(path)
	key := worker.objectKey(*claimed, now)
	if err := worker.runClaimed(ctx, *claimed, path, key); err != nil {
		message := fmt.Sprintf("backup generation failed (%T)", err)
		failErr := worker.store.FailBackup(context.WithoutCancel(ctx), *claimed, message, worker.maxAttempts)
		if failErr != nil {
			return true, errors.Join(err, failErr)
		}
		return true, nil
	}
	return true, nil
}

func (worker *Worker) runClaimed(ctx context.Context, claimed Claimed, path, objectKey string) error {
	prepared, err := worker.store.PrepareBackup(ctx, claimed)
	if err != nil {
		return err
	}
	archive, err := WriteArchive(ctx, prepared, worker.evidenceStorage, path, time.Now)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := worker.backupStorage.PutReader(ctx, objectKey, "application/zip", file, archive.ByteSize); err != nil {
		return err
	}
	// Object成功後にDB完了が失敗したobjectは、attempt固有keyのorphanとしてretention処理へ委ねる。
	return worker.store.CompleteBackup(ctx, claimed, prepared, objectKey, archive)
}

func (worker *Worker) objectKey(claimed Claimed, now time.Time) string {
	month := now.UTC().Format("2006/01")
	scheduled := strings.ReplaceAll(claimed.ScheduledFor, ":", "-")
	return fmt.Sprintf("%s%s/%s/%s/%s--%s-%s-attempt-%d-%s.zip",
		worker.keyPrefix, claimed.TenantID, claimed.WorkspaceID, month, scheduled,
		claimed.Kind, claimed.ID, claimed.Attempt, claimed.ClaimToken)
}
