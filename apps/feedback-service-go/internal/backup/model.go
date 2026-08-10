// Package backup はfull/incremental backupのAPI、archive、worker業務境界を提供する。
package backup

import (
	"errors"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

const (
	KindFull        = "full"
	KindIncremental = "incremental"

	StatusQueued     = "queued"
	StatusRunning    = "running"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
	StatusSuperseded = "superseded"
)

var (
	ErrInvalid            = errors.New("backup requestが不正です")
	ErrStorageUnavailable = errors.New("backup storageを利用できません")
	ErrIntegrity          = errors.New("backup archiveの整合性が不正です")
)

type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string { return err.Detail }
func (err *Error) Unwrap() error { return err.Kind }

type Policy struct {
	Enabled                    bool   `json:"enabled"`
	Timezone                   string `json:"timezone"`
	FullBackupAt               string `json:"fullBackupAt"`
	IncrementalIntervalMinutes int    `json:"incrementalIntervalMinutes"`
	IncludeEvidence            bool   `json:"includeEvidence"`
	RetentionDays              *int   `json:"retentionDays"`
}

func DefaultPolicy() Policy {
	return Policy{
		Timezone: "Asia/Tokyo", FullBackupAt: "02:00",
		IncrementalIntervalMinutes: 60, IncludeEvidence: true,
	}
}

type PolicyView struct {
	Policy            Policy  `json:"policy"`
	NextExecutionAt   *string `json:"nextExecutionAt"`
	NextFullAt        *string `json:"nextFullAt"`
	NextIncrementalAt *string `json:"nextIncrementalAt"`
	LastSuccessfulAt  *string `json:"lastSuccessfulAt"`
	ChangeCursor      int64   `json:"changeCursor"`
	AuditCursor       int64   `json:"auditCursor"`
}

type Run struct {
	ID                       string           `json:"id"`
	Kind                     string           `json:"kind"`
	Status                   string           `json:"status"`
	ScheduledFor             string           `json:"scheduledFor"`
	DownloadURL              *string          `json:"downloadUrl"`
	FromChangeSequence       int64            `json:"fromChangeSequence"`
	ToChangeSequence         *int64           `json:"toChangeSequence"`
	FromAuditSequence        int64            `json:"fromAuditSequence"`
	ToAuditSequence          *int64           `json:"toAuditSequence"`
	ArchiveSHA256            *string          `json:"archiveSha256"`
	ArchiveBytes             *int64           `json:"archiveBytes"`
	EntryCounts              map[string]int64 `json:"entryCounts"`
	HistoryCoverageStartedAt string           `json:"historyCoverageStartedAt"`
	ExpiresAt                *string          `json:"expiresAt"`
	CompletedAt              *string          `json:"completedAt"`
	CreatedAt                string           `json:"createdAt"`
	Error                    *string          `json:"error"`
}

type Page struct {
	Items      []Run   `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type StoredMetadata struct {
	ObjectKey     string
	ArchiveSHA256 string
	ArchiveBytes  int64
}

type Stored struct {
	FileName    string
	ContentType string
	Bytes       []byte
	SHA256      string
}

type MutationResult[T any] struct {
	Value T
	Scope auth.ResourceScope
}

type Claimed struct {
	ID                 string
	TenantID           string
	ApplicationID      string
	WorkspaceID        string
	Kind               string
	ScheduledFor       string
	FromChangeSequence int64
	FromAuditSequence  int64
	IncludeEvidence    bool
	ClaimToken         string
	Attempt            int
}

type CSVEntry struct {
	Path   string
	Header []string
	Rows   [][]*string
}

type EvidenceEntry struct {
	ArchivePath    string
	ObjectKey      string
	ContentType    string
	ExpectedSHA256 string
}

type PreparedArchive struct {
	RunID                    string
	Kind                     string
	ScheduledFor             string
	TenantKey                string
	ApplicationKey           string
	EnvironmentKey           string
	ExternalWorkspaceKey     string
	FromChangeSequence       int64
	ToChangeSequence         int64
	FromAuditSequence        int64
	ToAuditSequence          int64
	HistoryCoverageStartedAt string
	IncludeEvidence          bool
	CSVEntries               []CSVEntry
	EvidenceEntries          []EvidenceEntry
	RetentionDays            *int
}

type ArchiveResult struct {
	SHA256      string
	ByteSize    int64
	EntryCounts map[string]int64
}
