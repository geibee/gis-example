package export

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type WorkerStore interface {
	ClaimExport(context.Context) (*Claimed, error)
	PrepareExport(context.Context, Claimed) (Prepared, error)
	CompleteExport(context.Context, Claimed, string, int) error
	FailExport(context.Context, Claimed, string) error
}

type Worker struct {
	store     WorkerStore
	objects   objectstore.Store
	keyPrefix string
}

func NewWorker(store WorkerStore, objects objectstore.Store, keyPrefix string) (*Worker, error) {
	if store == nil || objects == nil {
		return nil, errors.New("export worker dependencyが未設定です")
	}
	if !strings.HasSuffix(keyPrefix, "/") || objectstore.ValidatePrefix(keyPrefix) != nil {
		return nil, errors.New("export key prefixが不正です")
	}
	return &Worker{store: store, objects: objects, keyPrefix: keyPrefix}, nil
}

func (worker *Worker) RunOnce(ctx context.Context) (bool, error) {
	claimed, err := worker.store.ClaimExport(ctx)
	if err != nil || claimed == nil {
		return false, err
	}
	objectKey := fmt.Sprintf("%s%s/%s/%s-%s.%s", worker.keyPrefix, claimed.TenantID, claimed.WorkspaceID,
		claimed.ID, claimed.ClaimToken, claimed.Format)
	if err := worker.runClaimed(ctx, *claimed, objectKey); err != nil {
		message := fmt.Sprintf("export generation failed (%T)", err)
		if failErr := worker.store.FailExport(ctx, *claimed, message); failErr != nil {
			return true, errors.Join(err, failErr)
		}
		return true, nil
	}
	return true, nil
}

func (worker *Worker) runClaimed(ctx context.Context, claimed Claimed, objectKey string) error {
	prepared, err := worker.store.PrepareExport(ctx, claimed)
	if err != nil {
		return err
	}
	bytes, err := Render(claimed.Format, claimed.Locale, claimed.Timezone, prepared.Rows)
	if err != nil {
		return err
	}
	contentType := "text/csv; charset=utf-8"
	if claimed.Format == FormatXLSX {
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	_ = worker.objects.Delete(ctx, objectKey)
	if err := worker.objects.Put(ctx, objectKey, contentType, bytes); err != nil {
		return err
	}
	if err := worker.store.CompleteExport(ctx, claimed, objectKey, prepared.RetentionDays); err != nil {
		// commit結果が不明な場合に即時削除すると、completed行が参照するobjectを失い得る。
		// rollback時は参照のないattempt固有keyとしてretention orphan sweepへ委ねる。
		return err
	}
	return nil
}
