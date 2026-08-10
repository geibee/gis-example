package evidence

import (
	"context"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

type Input struct {
	ContentType    string
	Data           []byte
	ViewportWidth  int
	ViewportHeight int
	PixelRatio     float64
	CapturedAt     time.Time
}

// Attachment はobject保存後、thread作成transactionへ渡すimmutable metadataである。
type Attachment struct {
	ObjectKey      string
	ContentType    string
	ByteSize       int64
	SHA256         string
	ViewportWidth  int
	ViewportHeight int
	PixelRatio     float64
	CapturedAt     time.Time
}

type Metadata struct {
	ThreadID string
	Attachment
}

type Download struct {
	ContentType string
	Data        []byte
}

type Stager interface {
	Stage(context.Context, auth.ResourceScope, string, Input) (Attachment, error)
	Discard(context.Context, Attachment) error
}

type Repository interface {
	ResolveEvidenceScope(context.Context, string, string) (auth.ResourceScope, error)
	GetEvidenceMetadata(context.Context, string) (Metadata, error)
	EvidenceObjectExists(context.Context, string) (bool, error)
	DeleteEvidenceMetadata(context.Context, string) error
	RecordEvidenceAuthorization(context.Context, auth.ResourceScope, auth.Principal, string) error
	RecordEvidenceRead(context.Context, auth.ResourceScope, auth.Principal, string, string) error
	RecordEvidenceStorageFailure(context.Context, string) error
}

type Authorizer interface {
	Authorize(context.Context, auth.AuthorizationRequest) (auth.AuthorizedContext, error)
}

type Settings struct {
	KeyPrefix      string
	MaximumBytes   int64
	StorageTimeout time.Duration
	OrphanGrace    time.Duration
	DeleteAttempts int
}

type SweepResult struct {
	Examined int
	Deleted  int
	Retained int
}
