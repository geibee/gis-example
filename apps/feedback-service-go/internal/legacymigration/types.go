package legacymigration

import (
	"context"
	"encoding/json"
	"time"
)

const TargetFeedbackSchemaVersion = "6"

type Snapshot struct {
	SchemaVersion                string                   `json:"schemaVersion"`
	SourceSystem                 string                   `json:"sourceSystem"`
	ApplicationKey               string                   `json:"applicationKey"`
	EnvironmentKey               string                   `json:"environmentKey"`
	ExternalWorkspaceKey         string                   `json:"externalWorkspaceKey"`
	ManifestVersion              string                   `json:"manifestVersion"`
	ProjectEvidenceRetentionDays *int                     `json:"projectEvidenceRetentionDays"`
	Sessions                     []SessionSnapshot        `json:"sessions"`
	Threads                      []ThreadSnapshot         `json:"threads"`
	Messages                     []MessageSnapshot        `json:"messages"`
	MessageVersions              []MessageVersionSnapshot `json:"messageVersions"`
	Evidence                     []EvidenceSnapshot       `json:"evidence"`
	Audits                       []AuditSnapshot          `json:"audits"`
	Outbox                       []OutboxSnapshot         `json:"outbox"`
}

type SessionSnapshot struct {
	ID                    string                `json:"id"`
	Title                 string                `json:"title"`
	Description           *string               `json:"description"`
	Status                string                `json:"status"`
	StartAt               *string               `json:"startAt"`
	EndAt                 *string               `json:"endAt"`
	CreatedBy             *string               `json:"createdBy"`
	CreatedAt             string                `json:"createdAt"`
	UpdatedAt             string                `json:"updatedAt"`
	EvidenceRetentionDays *int                  `json:"evidenceRetentionDays"`
	Scopes                []ScopeSnapshot       `json:"scopes"`
	Perspectives          []PerspectiveSnapshot `json:"perspectives"`
}

type ScopeSnapshot struct {
	ID           string  `json:"id"`
	PageID       string  `json:"pageId"`
	Route        *string `json:"route"`
	Reviewable   bool    `json:"reviewable"`
	DisplayOrder int     `json:"displayOrder"`
}

type PerspectiveSnapshot struct {
	Code         string  `json:"code"`
	Label        string  `json:"label"`
	Status       string  `json:"status"`
	Guidance     *string `json:"guidance"`
	DisplayOrder int     `json:"displayOrder"`
}

type ThreadSnapshot struct {
	ID                  string          `json:"id"`
	ReviewSessionID     string          `json:"reviewSessionId"`
	DisplayNumber       int             `json:"displayNumber"`
	PageID              string          `json:"pageId"`
	PageRoute           *string         `json:"pageRoute"`
	PerspectiveCode     string          `json:"perspectiveCode"`
	TargetType          string          `json:"targetType"`
	TargetMetadata      json.RawMessage `json:"targetMetadata"`
	EvidenceID          *string         `json:"evidenceId"`
	Status              string          `json:"status"`
	ReporterPrincipalID string          `json:"reporterPrincipalId"`
	ReporterDisplayName *string         `json:"reporterDisplayName"`
	ReporterName        *string         `json:"reporterName"`
	CreatedAt           string          `json:"createdAt"`
	UpdatedAt           string          `json:"updatedAt"`
}

type MessageSnapshot struct {
	ID                string  `json:"id"`
	ThreadID          string  `json:"threadId"`
	AuthorPrincipalID string  `json:"authorPrincipalId"`
	AuthorDisplayName *string `json:"authorDisplayName"`
	ParticipantName   *string `json:"participantName"`
	Body              string  `json:"body"`
	CreatedAt         string  `json:"createdAt"`
	EditedAt          *string `json:"editedAt"`
}

type MessageVersionSnapshot struct {
	MessageID             string  `json:"messageId"`
	Version               int     `json:"version"`
	Body                  string  `json:"body"`
	EditorPrincipalID     string  `json:"editorPrincipalId"`
	EditorDisplayName     *string `json:"editorDisplayName"`
	EditorParticipantName *string `json:"editorParticipantName"`
	CreatedAt             string  `json:"createdAt"`
}

type EvidenceSnapshot struct {
	ID                    string  `json:"id"`
	DataBase64            string  `json:"dataBase64"`
	ContentType           string  `json:"contentType"`
	SHA256                string  `json:"sha256"`
	ViewportWidth         int     `json:"viewportWidth"`
	ViewportHeight        int     `json:"viewportHeight"`
	PixelRatio            float64 `json:"pixelRatio"`
	CapturedAt            string  `json:"capturedAt"`
	CreatedAt             string  `json:"createdAt"`
	ExpiresAt             *string `json:"expiresAt"`
	LegacyObjectReference string  `json:"legacyObjectReference"`
}

type AuditSnapshot struct {
	ID           string          `json:"id"`
	PrincipalID  *string         `json:"principalId"`
	Action       string          `json:"action"`
	ResourceType *string         `json:"resourceType"`
	ResourceID   *string         `json:"resourceId"`
	Outcome      string          `json:"outcome"`
	RequestID    string          `json:"requestId"`
	Changes      json.RawMessage `json:"changes"`
	OccurredAt   string          `json:"occurredAt"`
}

type OutboxSnapshot struct {
	ID               string  `json:"id"`
	ReviewSessionID  string  `json:"reviewSessionId"`
	ThreadID         string  `json:"threadId"`
	MessageID        *string `json:"messageId"`
	EventType        string  `json:"eventType"`
	ActorPrincipalID *string `json:"actorPrincipalId"`
	CreatedAt        string  `json:"createdAt"`
}

type Report struct {
	RunID           string   `json:"runId"`
	SourceChecksum  string   `json:"sourceChecksum"`
	DryRun          bool     `json:"dryRun"`
	Sessions        int      `json:"sessions"`
	Threads         int      `json:"threads"`
	Messages        int      `json:"messages"`
	MessageVersions int      `json:"messageVersions"`
	Evidence        int      `json:"evidence"`
	Audits          int      `json:"audits"`
	Outbox          int      `json:"outbox"`
	Differences     []string `json:"differences"`
}

type Scope struct {
	TenantID      string
	ApplicationID string
	EnvironmentID string
	WorkspaceID   string
	Manifest      json.RawMessage
}

type MappedThread struct {
	Source   ThreadSnapshot
	Location json.RawMessage
	Target   json.RawMessage
}

type PlannedEvidence struct {
	Source    EvidenceSnapshot
	ThreadID  string
	ObjectKey string
	Data      []byte
}

type ApplyPlan struct {
	Snapshot Snapshot
	Scope    Scope
	Threads  []MappedThread
	Evidence []PlannedEvidence
	Report   Report
}

type CollisionInput struct {
	Snapshot       Snapshot
	RunID          string
	SourceChecksum string
	Scope          Scope
}

type Run struct {
	ID             string
	SourceChecksum string
	Status         string
}

type RollbackResult struct {
	ObjectKeys        []string
	AlreadyRolledBack bool
}

type Store interface {
	ValidateLegacyMigrationSchema(context.Context) error
	ResolveLegacyMigrationScope(context.Context, Snapshot) (Scope, error)
	FindLegacyMigrationRun(context.Context, string) (Run, bool, error)
	CheckLegacyMigrationCollisions(context.Context, CollisionInput) error
	ApplyLegacyMigration(context.Context, ApplyPlan) error
	ReconcileLegacyMigration(context.Context, ApplyPlan) ([]string, error)
	RollbackLegacyMigration(context.Context, string, string) (RollbackResult, error)
}

type Settings struct {
	EvidencePrefix       string
	MaximumEvidenceBytes int64
	StorageTimeout       time.Duration
	DeleteAttempts       int
}
