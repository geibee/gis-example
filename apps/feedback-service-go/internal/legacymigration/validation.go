package legacymigration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
)

const defaultMaximumEvidenceBytes = 20 * 1024 * 1024

func DecodeSnapshot(reader io.Reader) (Snapshot, error) {
	if reader == nil {
		return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "snapshot readerが未設定です")
	}
	raw, err := io.ReadAll(reader)
	if err != nil {
		return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "legacy snapshot JSONを読み取れません")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "legacy snapshot JSONが不正です")
	}
	for _, name := range []string{
		"sourceSystem", "applicationKey", "environmentKey", "externalWorkspaceKey", "manifestVersion",
		"sessions", "threads", "messages", "messageVersions",
	} {
		value, exists := fields[name]
		if !exists || len(value) == 0 || string(value) == "null" {
			return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", name+"が必要です")
		}
	}
	for _, name := range []string{"evidence", "audits", "outbox"} {
		if value, exists := fields[name]; exists && string(value) == "null" {
			return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", name+"はnullにできません")
		}
	}
	snapshot := Snapshot{SchemaVersion: "1"}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "legacy snapshot JSONが不正です")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return Snapshot{}, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "legacy snapshot JSONの後に余分な値があります")
	}
	return normalizeSnapshot(snapshot), nil
}

func normalizeSnapshot(snapshot Snapshot) Snapshot {
	if snapshot.SchemaVersion == "" {
		snapshot.SchemaVersion = "1"
	}
	if snapshot.Sessions == nil {
		snapshot.Sessions = []SessionSnapshot{}
	}
	if snapshot.Threads == nil {
		snapshot.Threads = []ThreadSnapshot{}
	}
	if snapshot.Messages == nil {
		snapshot.Messages = []MessageSnapshot{}
	}
	if snapshot.MessageVersions == nil {
		snapshot.MessageVersions = []MessageVersionSnapshot{}
	}
	if snapshot.Evidence == nil {
		snapshot.Evidence = []EvidenceSnapshot{}
	}
	if snapshot.Audits == nil {
		snapshot.Audits = []AuditSnapshot{}
	}
	if snapshot.Outbox == nil {
		snapshot.Outbox = []OutboxSnapshot{}
	}
	for index := range snapshot.Sessions {
		if snapshot.Sessions[index].Scopes == nil {
			snapshot.Sessions[index].Scopes = []ScopeSnapshot{}
		}
		if snapshot.Sessions[index].Perspectives == nil {
			snapshot.Sessions[index].Perspectives = []PerspectiveSnapshot{}
		}
	}
	return snapshot
}

func validateSnapshot(snapshot Snapshot, maximumEvidenceBytes int64) ([]PlannedEvidence, error) {
	if snapshot.SchemaVersion != "1" {
		return nil, migrationError(ErrInvalidInput, "legacy.schema_version_unsupported", "未対応のlegacy snapshot schemaVersionです")
	}
	if strings.TrimSpace(snapshot.SourceSystem) == "" {
		return nil, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "sourceSystemが必要です")
	}
	if maximumEvidenceBytes <= 0 {
		maximumEvidenceBytes = defaultMaximumEvidenceBytes
	}
	ids := make([]string, 0)
	ids = append(ids, collectIDs(snapshot.Sessions, func(value SessionSnapshot) string { return value.ID })...)
	for _, session := range snapshot.Sessions {
		for _, scope := range session.Scopes {
			ids = append(ids, scope.ID)
		}
	}
	ids = append(ids, collectIDs(snapshot.Threads, func(value ThreadSnapshot) string { return value.ID })...)
	ids = append(ids, collectIDs(snapshot.Messages, func(value MessageSnapshot) string { return value.ID })...)
	ids = append(ids, collectIDs(snapshot.Evidence, func(value EvidenceSnapshot) string { return value.ID })...)
	ids = append(ids, collectIDs(snapshot.Audits, func(value AuditSnapshot) string { return value.ID })...)
	ids = append(ids, collectIDs(snapshot.Outbox, func(value OutboxSnapshot) string { return value.ID })...)
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.String() != id {
			return nil, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "resource IDがUUIDではありません")
		}
		canonical := parsed.String()
		if _, exists := seen[canonical]; exists {
			return nil, migrationError(ErrInvalidInput, "legacy.snapshot_invalid", "resource IDが重複しています")
		}
		seen[canonical] = struct{}{}
	}
	sessionIDs := stringSet(snapshot.Sessions, func(value SessionSnapshot) string { return value.ID })
	threadIDs := stringSet(snapshot.Threads, func(value ThreadSnapshot) string { return value.ID })
	messageIDs := stringSet(snapshot.Messages, func(value MessageSnapshot) string { return value.ID })
	evidenceIDs := stringSet(snapshot.Evidence, func(value EvidenceSnapshot) string { return value.ID })
	threadSessions := make(map[string]string, len(snapshot.Threads))
	messageThreads := make(map[string]string, len(snapshot.Messages))
	for _, session := range snapshot.Sessions {
		if session.Status != "draft" && session.Status != "open" && session.Status != "closed" &&
			strings.ToLower(session.Status) != "draft" && strings.ToLower(session.Status) != "open" && strings.ToLower(session.Status) != "closed" {
			return nil, invalidSnapshot("session statusが不正です")
		}
		if err := validateTimes(session.CreatedAt, session.UpdatedAt); err != nil {
			return nil, err
		}
		if session.StartAt != nil {
			if _, err := time.Parse(time.RFC3339Nano, *session.StartAt); err != nil {
				return nil, invalidSnapshot("session startAtが不正です")
			}
		}
		if session.EndAt != nil {
			if _, err := time.Parse(time.RFC3339Nano, *session.EndAt); err != nil {
				return nil, invalidSnapshot("session endAtが不正です")
			}
		}
		if session.EvidenceRetentionDays != nil && (*session.EvidenceRetentionDays < 1 || *session.EvidenceRetentionDays > 3650) {
			return nil, invalidSnapshot("evidenceRetentionDaysが範囲外です")
		}
	}
	if snapshot.ProjectEvidenceRetentionDays != nil &&
		(*snapshot.ProjectEvidenceRetentionDays < 1 || *snapshot.ProjectEvidenceRetentionDays > 3650) {
		return nil, invalidSnapshot("evidenceRetentionDaysが範囲外です")
	}
	displayNumbers := make(map[string]map[int]struct{})
	evidenceReferences := make(map[string]int)
	for _, thread := range snapshot.Threads {
		threadSessions[thread.ID] = thread.ReviewSessionID
		if _, exists := sessionIDs[thread.ReviewSessionID]; !exists {
			return nil, invalidSnapshot("threadが未知のsessionを参照しています")
		}
		if thread.DisplayNumber <= 0 {
			return nil, invalidSnapshot("thread displayNumberが不正です")
		}
		if displayNumbers[thread.ReviewSessionID] == nil {
			displayNumbers[thread.ReviewSessionID] = make(map[int]struct{})
		}
		if _, exists := displayNumbers[thread.ReviewSessionID][thread.DisplayNumber]; exists {
			return nil, invalidSnapshot("thread displayNumberが重複しています")
		}
		displayNumbers[thread.ReviewSessionID][thread.DisplayNumber] = struct{}{}
		status := strings.ToLower(thread.Status)
		if status != "open" && status != "resolved" {
			return nil, invalidSnapshot("thread statusが不正です")
		}
		if err := validateTimes(thread.CreatedAt, thread.UpdatedAt); err != nil {
			return nil, err
		}
		if thread.EvidenceID != nil {
			evidenceReferences[*thread.EvidenceID]++
		}
	}
	for id := range evidenceIDs {
		if evidenceReferences[id] != 1 {
			return nil, invalidSnapshot("evidence参照が一致しません")
		}
	}
	if len(evidenceReferences) != len(evidenceIDs) {
		return nil, invalidSnapshot("evidence参照が一致しません")
	}
	for _, message := range snapshot.Messages {
		messageThreads[message.ID] = message.ThreadID
		if _, exists := threadIDs[message.ThreadID]; !exists {
			return nil, invalidSnapshot("messageが未知のthreadを参照しています")
		}
		if _, err := time.Parse(time.RFC3339Nano, message.CreatedAt); err != nil {
			return nil, invalidSnapshot("message createdAtが不正です")
		}
		if message.EditedAt != nil {
			if _, err := time.Parse(time.RFC3339Nano, *message.EditedAt); err != nil {
				return nil, invalidSnapshot("message editedAtが不正です")
			}
		}
		versions := make([]MessageVersionSnapshot, 0)
		for _, version := range snapshot.MessageVersions {
			if version.MessageID == message.ID {
				versions = append(versions, version)
			}
		}
		slices.SortFunc(versions, func(left, right MessageVersionSnapshot) int { return left.Version - right.Version })
		if len(versions) == 0 || versions[len(versions)-1].Body != message.Body {
			return nil, invalidSnapshot("message現在版bodyが一致しません")
		}
		for index, version := range versions {
			if version.Version != index+1 {
				return nil, invalidSnapshot("message versionが連続していません")
			}
			if _, err := time.Parse(time.RFC3339Nano, version.CreatedAt); err != nil {
				return nil, invalidSnapshot("message version createdAtが不正です")
			}
		}
	}
	for _, version := range snapshot.MessageVersions {
		if _, exists := messageIDs[version.MessageID]; !exists {
			return nil, invalidSnapshot("historyが未知のmessageを参照しています")
		}
	}
	planned := make([]PlannedEvidence, 0, len(snapshot.Evidence))
	for _, value := range snapshot.Evidence {
		data, err := evidence.DecodeBase64(value.DataBase64, maximumEvidenceBytes)
		if err != nil {
			return nil, invalidSnapshot("evidence " + value.ID + ": base64またはsizeが不正です")
		}
		capturedAt, err := time.Parse(time.RFC3339Nano, value.CapturedAt)
		if err != nil {
			return nil, invalidSnapshot("evidence " + value.ID + ": capturedAtが不正です")
		}
		if _, err := time.Parse(time.RFC3339Nano, value.CreatedAt); err != nil {
			return nil, invalidSnapshot("evidence " + value.ID + ": createdAtが不正です")
		}
		if value.ExpiresAt != nil {
			if _, err := time.Parse(time.RFC3339Nano, *value.ExpiresAt); err != nil {
				return nil, invalidSnapshot("evidence " + value.ID + ": expiresAtが不正です")
			}
		}
		attachment, err := evidence.Prepare(evidence.Input{
			ContentType: value.ContentType, Data: data, ViewportWidth: value.ViewportWidth,
			ViewportHeight: value.ViewportHeight, PixelRatio: value.PixelRatio, CapturedAt: capturedAt,
		}, maximumEvidenceBytes)
		if err != nil || attachment.SHA256 != value.SHA256 {
			return nil, invalidSnapshot("evidence " + value.ID + ": SHA-256または内容が一致しません")
		}
		threadID := ""
		for _, thread := range snapshot.Threads {
			if thread.EvidenceID != nil && *thread.EvidenceID == value.ID {
				threadID = thread.ID
				break
			}
		}
		planned = append(planned, PlannedEvidence{Source: value, ThreadID: threadID, Data: data})
	}
	for _, audit := range snapshot.Audits {
		if _, err := time.Parse(time.RFC3339Nano, audit.OccurredAt); err != nil {
			return nil, invalidSnapshot("audit occurredAtが不正です")
		}
		if _, err := NormalizeAuditOutcome(audit.Outcome); err != nil {
			return nil, err
		}
		if _, err := SanitizeAuditChanges(audit.Changes); err != nil {
			return nil, err
		}
	}
	for _, outbox := range snapshot.Outbox {
		if _, exists := sessionIDs[outbox.ReviewSessionID]; !exists ||
			threadSessions[outbox.ThreadID] != outbox.ReviewSessionID {
			return nil, invalidSnapshot("outboxが未知または異なるsessionのthreadを参照しています")
		}
		if outbox.MessageID != nil && messageThreads[*outbox.MessageID] != outbox.ThreadID {
			return nil, invalidSnapshot("outboxが未知または異なるthreadのmessageを参照しています")
		}
		if _, err := NormalizeEventType(outbox.EventType); err != nil {
			return nil, err
		}
		if _, err := time.Parse(time.RFC3339Nano, outbox.CreatedAt); err != nil {
			return nil, invalidSnapshot("outbox createdAtが不正です")
		}
	}
	return planned, nil
}

func SnapshotChecksum(snapshot Snapshot) (string, error) {
	snapshot = normalizeSnapshot(snapshot)
	evidenceValues := make([]checksumEvidenceSnapshot, len(snapshot.Evidence))
	for index, value := range snapshot.Evidence {
		evidenceValues[index] = checksumEvidenceSnapshot{
			ID: value.ID, DataBase64: value.DataBase64, ContentType: value.ContentType, SHA256: value.SHA256,
			ViewportWidth: value.ViewportWidth, ViewportHeight: value.ViewportHeight,
			PixelRatio: kotlinDouble(value.PixelRatio), CapturedAt: value.CapturedAt, CreatedAt: value.CreatedAt,
			ExpiresAt: value.ExpiresAt, LegacyObjectReference: value.LegacyObjectReference,
		}
	}
	wire := checksumSnapshot{
		SchemaVersion: snapshot.SchemaVersion, SourceSystem: snapshot.SourceSystem,
		ApplicationKey: snapshot.ApplicationKey, EnvironmentKey: snapshot.EnvironmentKey,
		ExternalWorkspaceKey: snapshot.ExternalWorkspaceKey, ManifestVersion: snapshot.ManifestVersion,
		ProjectEvidenceRetentionDays: snapshot.ProjectEvidenceRetentionDays,
		Sessions:                     snapshot.Sessions, Threads: snapshot.Threads, Messages: snapshot.Messages,
		MessageVersions: snapshot.MessageVersions, Evidence: evidenceValues,
		Audits: snapshot.Audits, Outbox: snapshot.Outbox,
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(wire); err != nil {
		return "", fmt.Errorf("snapshotをencodeできません: %w", err)
	}
	hash := sha256.Sum256(bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}))
	return hex.EncodeToString(hash[:]), nil
}

// kotlinx.serializationは整数値のDoubleも小数点付きでencodeする。
type kotlinDouble float64

func (value kotlinDouble) MarshalJSON() ([]byte, error) {
	raw := strconv.FormatFloat(float64(value), 'f', -1, 64)
	if !strings.Contains(raw, ".") {
		raw += ".0"
	}
	return []byte(raw), nil
}

type checksumSnapshot struct {
	SchemaVersion                string                     `json:"schemaVersion"`
	SourceSystem                 string                     `json:"sourceSystem"`
	ApplicationKey               string                     `json:"applicationKey"`
	EnvironmentKey               string                     `json:"environmentKey"`
	ExternalWorkspaceKey         string                     `json:"externalWorkspaceKey"`
	ManifestVersion              string                     `json:"manifestVersion"`
	ProjectEvidenceRetentionDays *int                       `json:"projectEvidenceRetentionDays"`
	Sessions                     []SessionSnapshot          `json:"sessions"`
	Threads                      []ThreadSnapshot           `json:"threads"`
	Messages                     []MessageSnapshot          `json:"messages"`
	MessageVersions              []MessageVersionSnapshot   `json:"messageVersions"`
	Evidence                     []checksumEvidenceSnapshot `json:"evidence"`
	Audits                       []AuditSnapshot            `json:"audits"`
	Outbox                       []OutboxSnapshot           `json:"outbox"`
}

type checksumEvidenceSnapshot struct {
	ID                    string       `json:"id"`
	DataBase64            string       `json:"dataBase64"`
	ContentType           string       `json:"contentType"`
	SHA256                string       `json:"sha256"`
	ViewportWidth         int          `json:"viewportWidth"`
	ViewportHeight        int          `json:"viewportHeight"`
	PixelRatio            kotlinDouble `json:"pixelRatio"`
	CapturedAt            string       `json:"capturedAt"`
	CreatedAt             string       `json:"createdAt"`
	ExpiresAt             *string      `json:"expiresAt"`
	LegacyObjectReference string       `json:"legacyObjectReference"`
}

func NormalizeEventType(value string) (string, error) {
	switch strings.ToUpper(value) {
	case "THREAD_CREATED":
		return "feedback.thread.created.v1", nil
	case "MESSAGE_CREATED":
		return "feedback.message.created.v1", nil
	case "THREAD_RESOLVED":
		return "feedback.thread.resolved.v1", nil
	case "THREAD_REOPENED":
		return "feedback.thread.reopened.v1", nil
	default:
		return "", invalidSnapshot("未知のlegacy eventTypeです: " + value)
	}
}

func NormalizeAuditOutcome(value string) (string, error) {
	switch strings.ToLower(value) {
	case "allowed", "denied", "succeeded", "failed":
		return strings.ToLower(value), nil
	case "success":
		return "succeeded", nil
	case "failure":
		return "failed", nil
	default:
		return "", invalidSnapshot("未知のlegacy audit outcomeです: " + value)
	}
}

func invalidSnapshot(detail string) error {
	return migrationError(ErrInvalidInput, "legacy.snapshot_invalid", detail)
}

func validateTimes(values ...string) error {
	for _, value := range values {
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return invalidSnapshot("date-timeがRFC 3339ではありません")
		}
	}
	return nil
}

func collectIDs[T any](values []T, id func(T) string) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = id(value)
	}
	return result
}

func stringSet[T any](values []T, key func(T) string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[key(value)] = struct{}{}
	}
	return result
}
