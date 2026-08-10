// Package retention は保存方針APIと期限切れデータ回収workerの業務境界を提供する。
package retention

import (
	"context"
	"errors"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

var ErrInvalid = errors.New("retention requestが不正です")

type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string { return err.Detail }
func (err *Error) Unwrap() error { return err.Kind }

type Policy struct {
	EvidenceRetentionDays *int `json:"evidenceRetentionDays"`
	ExportRetentionDays   int  `json:"exportRetentionDays"`
}

func DefaultPolicy() Policy { return Policy{ExportRetentionDays: 7} }

type WorkspaceInput struct {
	ApplicationKey       string
	ExternalWorkspaceKey string
	RequestID            string
}

type PolicyResult struct {
	Policy  Policy
	Version int
	Scope   auth.ResourceScope
}

type Store interface {
	ResolveRetentionWorkspaceScope(context.Context, string, string, string) (auth.ResourceScope, error)
	GetRetentionPolicy(context.Context, auth.ResourceScope) (Policy, int, error)
	PatchRetentionPolicy(context.Context, auth.ResourceScope, int, Policy) (Policy, int, error)
	RecordAudit(context.Context, usecase.AuditEvent) error
}

type DeleteObjectFunc func(context.Context, string) error

// WorkerStore は期限切れmetadataと監査を先にtransaction commitし、
// object操作をtransaction外のcallbackで行う。失敗objectはorphan sweepへ収束する。
type WorkerStore interface {
	DeleteExpiredInternalRecords(context.Context) error
	PurgeExpiredEvidence(context.Context, int, DeleteObjectFunc) (int, error)
	PurgeExpiredExports(context.Context, int, DeleteObjectFunc) (int, error)
	PurgeExpiredBackups(context.Context, int, DeleteObjectFunc) (int, error)
	EvidenceObjectExists(context.Context, string) (bool, error)
	ExportObjectExists(context.Context, string) (bool, error)
	BackupObjectExists(context.Context, string) (bool, error)
}

type WorkerSettings struct {
	EvidencePrefix string
	ExportPrefix   string
	BackupPrefix   string
	OrphanGrace    time.Duration
	BatchSize      int
}

type SweepResult struct {
	Examined int
	Deleted  int
	Retained int
}
