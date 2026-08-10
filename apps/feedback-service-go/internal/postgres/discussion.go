package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/discussion"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/evidence"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const (
	createThreadEndpoint  = "POST /sessions/{sessionId}/threads"
	createMessageEndpoint = "POST /threads/{threadId}/messages"
)

type discussionQuerier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (d *Database) ListThreads(
	ctx context.Context,
	input discussion.ListThreadsInput,
) (discussion.ThreadPage, error) {
	filter := ""
	arguments := []any{input.SessionID}
	if input.Status != nil {
		filter = " AND thread.status = $2"
		arguments = append(arguments, *input.Status)
	}
	var total int64
	if err := d.QueryRow(ctx, `SELECT count(*)
FROM feedback.feedback_threads thread
WHERE thread.session_id = $1::uuid`+filter, arguments...).Scan(&total); err != nil {
		return discussion.ThreadPage{}, fmt.Errorf("thread件数を取得できません: %w", err)
	}

	limitPosition := len(arguments) + 1
	offsetPosition := limitPosition + 1
	query := fmt.Sprintf(`SELECT thread.id::text, thread.session_id::text, thread.display_number,
       thread.location, thread.target, thread.perspective_code, thread.status,
       thread.reporter_principal_id, thread.reporter_display_name, thread.reporter_participant_name,
       thread.created_at, thread.updated_at, thread.version
FROM feedback.feedback_threads thread
WHERE thread.session_id = $1::uuid%s
ORDER BY thread.created_at DESC, thread.id DESC
LIMIT $%d OFFSET $%d`, filter, limitPosition, offsetPosition)
	arguments = append(arguments, input.Limit, input.Offset)
	rows, err := d.Query(ctx, query, arguments...)
	if err != nil {
		return discussion.ThreadPage{}, fmt.Errorf("thread一覧を取得できません: %w", err)
	}
	items := make([]discussion.Thread, 0)
	for rows.Next() {
		item, err := scanDiscussionThread(rows)
		if err != nil {
			rows.Close()
			return discussion.ThreadPage{}, fmt.Errorf("thread一覧を読み取れません: %w", err)
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return discussion.ThreadPage{}, fmt.Errorf("thread一覧の走査に失敗しました: %w", err)
	}
	for index := range items {
		if err := loadDiscussionThreadRelations(ctx, d, &items[index]); err != nil {
			return discussion.ThreadPage{}, err
		}
	}
	page := discussion.ThreadPage{Items: items, TotalCount: total}
	if int64(input.Offset+len(items)) < total {
		next := discussion.EncodeCursor(input.Offset + len(items))
		page.NextCursor = &next
	}
	return page, nil
}

func (d *Database) GetThread(ctx context.Context, threadID string) (discussion.Thread, error) {
	return readDiscussionThread(ctx, d, threadID)
}

func (d *Database) GetThreadDeepLink(ctx context.Context, threadID string) (string, error) {
	var location, manifest []byte
	var baseURL, parameter string
	err := d.QueryRow(ctx, `SELECT thread.location, environment.base_url,
       environment.deep_link_thread_parameter, manifest.manifest
FROM feedback.feedback_threads thread
JOIN feedback.review_sessions session ON session.id = thread.session_id
JOIN feedback.application_environments environment ON environment.id = thread.environment_id
JOIN feedback.application_manifests manifest
  ON manifest.application_id = thread.application_id
 AND manifest.manifest_version = session.manifest_version
WHERE thread.id = $1::uuid`, threadID).Scan(&location, &baseURL, &parameter, &manifest)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", discussionNotFound()
	}
	if err != nil {
		return "", fmt.Errorf("thread deep link情報を取得できません: %w", err)
	}
	deepLink, err := discussion.BuildDeepLink(baseURL, parameter, manifest, location, threadID)
	if err != nil {
		return "", fmt.Errorf("thread deep linkを構築できません: %w", err)
	}
	return deepLink, nil
}

func (d *Database) CreateThread(
	ctx context.Context,
	input discussion.CreateThreadInput,
) (discussion.Mutation[discussion.Thread], error) {
	result := discussion.Mutation[discussion.Thread]{EvidenceCleanup: discussion.CleanupNone}
	if input.Evidence != nil {
		result.EvidenceCleanup = discussion.CleanupDiscardNow
	}
	mutationReady := false
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		replayed, err := loadThreadIdempotency(txCtx, tx, input, &result.Value)
		if err != nil {
			return err
		}
		if replayed {
			result.Replay = true
			return nil
		}

		var status, outOfScopePosting, manifestVersion string
		var startAt, endAt *time.Time
		err = tx.QueryRow(txCtx, `SELECT session.status, session.out_of_scope_posting,
       session.manifest_version, session.start_at, session.end_at
FROM feedback.review_sessions session
WHERE session.id = $1::uuid
  AND session.tenant_id = $2::uuid
  AND session.application_id = $3::uuid
  AND session.environment_id = $4::uuid
  AND session.workspace_id = $5::uuid`, input.SessionID, input.Scope.TenantID, input.Scope.ApplicationID,
			input.Scope.EnvironmentID, input.Scope.WorkspaceID).Scan(
			&status, &outOfScopePosting, &manifestVersion, &startAt, &endAt,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return discussionNotFound()
		}
		if err != nil {
			return fmt.Errorf("sessionを取得できません: %w", err)
		}
		if status != "open" {
			return discussionConflict("session.not_open", "open sessionにだけ投稿できます")
		}
		var now time.Time
		if err := tx.QueryRow(txCtx, `SELECT now()`).Scan(&now); err != nil {
			return fmt.Errorf("現在時刻を取得できません: %w", err)
		}
		if startAt != nil && startAt.After(now) || endAt != nil && endAt.Before(now) {
			return discussionConflict("session.outside_period", "sessionの実施期間外です")
		}

		var manifest []byte
		err = tx.QueryRow(txCtx, `SELECT manifest
FROM feedback.application_manifests
WHERE application_id = $1::uuid AND manifest_version = $2`, input.Scope.ApplicationID, manifestVersion).Scan(&manifest)
		if errors.Is(err, pgx.ErrNoRows) {
			return discussionInvalid("request.invalid", "sessionのmanifestVersionが見つかりません")
		}
		if err != nil {
			return fmt.Errorf("session manifestを取得できません: %w", err)
		}
		location, err := discussion.SanitizeLocation(input.Request.Location, manifest)
		if err != nil {
			return err
		}
		target, err := discussion.ValidateTarget(input.Request.Target)
		if err != nil {
			return err
		}
		var locationIdentity struct {
			PageKey       string `json:"pageKey"`
			RouteTemplate string `json:"routeTemplate"`
		}
		if err := json.Unmarshal(location, &locationIdentity); err != nil {
			return fmt.Errorf("sanitized locationを読み取れません: %w", err)
		}
		var reviewable bool
		err = tx.QueryRow(txCtx, `SELECT reviewable
FROM feedback.review_scopes
WHERE session_id = $1::uuid AND page_key = $2
  AND (route_template IS NULL OR route_template = $3)
ORDER BY route_template NULLS FIRST
LIMIT 1`, input.SessionID, locationIdentity.PageKey, locationIdentity.RouteTemplate).Scan(&reviewable)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("session scopeを確認できません: %w", err)
		}
		if (errors.Is(err, pgx.ErrNoRows) || !reviewable) && outOfScopePosting == "deny" {
			return &discussion.Error{
				Kind: discussion.ErrForbidden, Code: "session.out_of_scope",
				Detail: "この画面はsession scope外です",
			}
		}
		var perspectiveActive bool
		if err := tx.QueryRow(txCtx, `SELECT EXISTS (
    SELECT 1 FROM feedback.review_session_perspectives
    WHERE session_id = $1::uuid AND code = $2 AND status = 'active'
)`, input.SessionID, input.Request.PerspectiveCode).Scan(&perspectiveActive); err != nil {
			return fmt.Errorf("perspectiveを確認できません: %w", err)
		}
		if !perspectiveActive {
			return discussionInvalid("request.invalid", "activeなperspectiveCodeを指定してください")
		}
		if input.Evidence != nil {
			if input.EvidenceMaximum <= 0 {
				return discussionInvalid("request.invalid", "evidence件数上限が不正です")
			}
			if err := d.EnforceEvidenceQuota(txCtx, tx, input.Scope.WorkspaceID, input.EvidenceMaximum); err != nil {
				return err
			}
		}

		var displayNumber int
		if err := tx.QueryRow(txCtx, `INSERT INTO feedback.thread_sequences (session_id, next_number)
VALUES ($1::uuid, 2)
ON CONFLICT (session_id) DO UPDATE
SET next_number = feedback.thread_sequences.next_number + 1
RETURNING next_number - 1`, input.SessionID).Scan(&displayNumber); err != nil {
			return fmt.Errorf("thread番号を採番できません: %w", err)
		}
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.feedback_threads (
    id, tenant_id, application_id, environment_id, workspace_id, session_id,
    display_number, location, target, perspective_code,
    reporter_principal_id, reporter_display_name, reporter_participant_name
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
    $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13
)`, input.ThreadID, input.Scope.TenantID, input.Scope.ApplicationID, input.Scope.EnvironmentID,
			input.Scope.WorkspaceID, input.SessionID, displayNumber, string(location), string(target),
			input.Request.PerspectiveCode, input.Principal.Subject,
			optionalString(input.Principal.DisplayName), optionalString(input.Request.ParticipantName),
		)
		if err != nil {
			return fmt.Errorf("threadを登録できません: %w", err)
		}
		initialMessage, err := insertDiscussionMessage(
			txCtx, tx, input.ThreadID, input.Principal, input.Request.Body, input.Request.ParticipantName,
		)
		if err != nil {
			return err
		}
		if input.Evidence != nil {
			if err := d.InsertEvidenceMetadata(txCtx, tx, input.ThreadID, *input.Evidence); err != nil {
				return err
			}
		}
		if err := appendDiscussionChange(txCtx, tx, input.Scope, "feedback.thread.created.v1", "thread", input.ThreadID,
			map[string]any{"threadId": input.ThreadID, "messageId": initialMessage.ID, "evidenceIncluded": input.Evidence != nil},
		); err != nil {
			return err
		}
		if err := enqueueDiscussionEvent(
			txCtx, tx, input.Scope, "feedback.thread.created.v1", input.SessionID, input.ThreadID,
			input.Principal, &input.Request.Body, input.RequestID,
		); err != nil {
			return err
		}
		if err := incrementDiscussionMetric(txCtx, tx, "posts_total", input.Scope.TenantID); err != nil {
			return err
		}
		result.Value, err = readDiscussionThread(txCtx, tx, input.ThreadID)
		if err != nil {
			return err
		}
		if err := saveDiscussionIdempotency(
			txCtx, tx, input.Scope.TenantID, input.Principal.Subject, createThreadEndpoint,
			input.IdempotencyKey, input.RequestHash, result.Value,
		); err != nil {
			return err
		}
		mutationReady = true
		return nil
	})
	if err != nil {
		d.recordDiscussionQuotaRejection(ctx, input.Scope.TenantID, err)
		if mutationReady {
			result.EvidenceCleanup = discussion.CleanupDeferToOrphanSweep
			return result, &discussion.Error{
				Kind: discussion.ErrCommitUnknown, Code: "database.commit_unknown",
				Detail: "database commit結果を確認できません",
			}
		}
		return result, err
	}
	if input.Evidence != nil && !result.Replay {
		result.EvidenceCleanup = discussion.CleanupNone
	}
	return result, nil
}

func (d *Database) recordDiscussionQuotaRejection(ctx context.Context, tenantID string, err error) {
	if !errors.Is(err, evidence.ErrQuotaExceeded) {
		return
	}
	// KotlinのrunCatchingと同様に、元のquota errorをmetric障害で置き換えない。
	_ = d.RecordEvidenceQuotaRejection(context.WithoutCancel(ctx), tenantID)
}

func (d *Database) CreateMessage(
	ctx context.Context,
	input discussion.CreateMessageInput,
) (discussion.Mutation[discussion.Message], error) {
	result := discussion.Mutation[discussion.Message]{}
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		replayed, err := loadMessageIdempotency(txCtx, tx, input, &result.Value)
		if err != nil {
			return err
		}
		if replayed {
			result.Replay = true
			return nil
		}
		var sessionID string
		err = tx.QueryRow(txCtx, `SELECT session_id::text
FROM feedback.feedback_threads
WHERE id = $1::uuid
  AND tenant_id = $2::uuid
  AND application_id = $3::uuid
  AND environment_id = $4::uuid
  AND workspace_id = $5::uuid`, input.ThreadID, input.Scope.TenantID, input.Scope.ApplicationID,
			input.Scope.EnvironmentID, input.Scope.WorkspaceID).Scan(&sessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return discussionNotFound()
		}
		if err != nil {
			return fmt.Errorf("threadを取得できません: %w", err)
		}
		result.Value, err = insertDiscussionMessage(
			txCtx, tx, input.ThreadID, input.Principal, input.Request.Body, input.Request.ParticipantName,
		)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(txCtx, `UPDATE feedback.feedback_threads
SET version = version + 1, updated_at = now()
WHERE id = $1::uuid`, input.ThreadID); err != nil {
			return fmt.Errorf("thread版を更新できません: %w", err)
		}
		if err := enqueueDiscussionEvent(
			txCtx, tx, input.Scope, "feedback.message.created.v1", sessionID, input.ThreadID,
			input.Principal, &input.Request.Body, input.RequestID,
		); err != nil {
			return err
		}
		if err := appendDiscussionChange(txCtx, tx, input.Scope, "feedback.message.created.v1", "message", result.Value.ID,
			map[string]any{"threadId": input.ThreadID},
		); err != nil {
			return err
		}
		if err := incrementDiscussionMetric(txCtx, tx, "posts_total", input.Scope.TenantID); err != nil {
			return err
		}
		if err := saveDiscussionIdempotency(
			txCtx, tx, input.Scope.TenantID, input.Principal.Subject, createMessageEndpoint,
			input.IdempotencyKey, input.RequestHash, result.Value,
		); err != nil {
			return err
		}
		return nil
	})
	return result, err
}

func (d *Database) PatchMessage(
	ctx context.Context,
	input discussion.PatchMessageInput,
) (discussion.Message, error) {
	var updated discussion.Message
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := ensureDiscussionMessageScope(txCtx, tx, input.MessageID, input.Scope); err != nil {
			return err
		}
		current, err := readDiscussionMessage(txCtx, tx, input.MessageID, true)
		if err != nil {
			return err
		}
		if current.Version != input.ExpectedVersion {
			return discussionVersionMismatch()
		}
		if current.Author.PrincipalID != input.Principal.Subject {
			return &discussion.Error{
				Kind: discussion.ErrForbidden, Code: "message.not_owner",
				Detail: "自分のmessageだけを編集できます",
			}
		}
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.feedback_message_versions (
    message_id, thread_id, version, author_principal_id, author_display_name,
    author_participant_name, body, created_at, edited_at
)
SELECT id, thread_id, version, author_principal_id, author_display_name,
       author_participant_name, body, created_at, edited_at
FROM feedback.feedback_messages WHERE id = $1::uuid`, input.MessageID)
		if err != nil {
			return fmt.Errorf("message履歴を登録できません: %w", err)
		}
		commandTag, err := tx.Exec(txCtx, `UPDATE feedback.feedback_messages
SET body = $1, author_participant_name = $2, version = version + 1, edited_at = now()
WHERE id = $3::uuid AND version = $4`, strings.TrimSpace(input.Request.Body),
			optionalString(input.Request.ParticipantName), input.MessageID, input.ExpectedVersion,
		)
		if err != nil {
			return fmt.Errorf("messageを更新できません: %w", err)
		}
		if commandTag.RowsAffected() != 1 {
			return discussionVersionMismatch()
		}
		if _, err := tx.Exec(txCtx, `UPDATE feedback.feedback_threads
SET version = version + 1, updated_at = now()
WHERE id = (SELECT thread_id FROM feedback.feedback_messages WHERE id = $1::uuid)`, input.MessageID); err != nil {
			return fmt.Errorf("thread版を更新できません: %w", err)
		}
		updated, err = readDiscussionMessage(txCtx, tx, input.MessageID, false)
		if err != nil {
			return err
		}
		return appendDiscussionChange(txCtx, tx, input.Scope, "feedback.message.updated.v1", "message", input.MessageID,
			map[string]any{"threadId": updated.ThreadID, "fromVersion": current.Version, "toVersion": updated.Version},
		)
	})
	return updated, err
}

func (d *Database) ListMessageVersions(
	ctx context.Context,
	messageID string,
) ([]discussion.MessageVersion, error) {
	rows, err := d.Query(ctx, `SELECT version.message_id::text, version.thread_id::text,
       version.author_principal_id, version.author_display_name, version.author_participant_name,
       version.body, version.created_at, version.edited_at, version.version
FROM feedback.feedback_message_versions version
WHERE version.message_id = $1::uuid
ORDER BY version.version`, messageID)
	if err != nil {
		return nil, fmt.Errorf("message履歴を取得できません: %w", err)
	}
	versions := make([]discussion.MessageVersion, 0)
	for rows.Next() {
		version, err := scanDiscussionMessageVersion(rows, false)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("message履歴を読み取れません: %w", err)
		}
		versions = append(versions, version)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, fmt.Errorf("message履歴の走査に失敗しました: %w", err)
	}
	current, err := readDiscussionMessage(ctx, d, messageID, false)
	if err != nil {
		return nil, err
	}
	versions = append(versions, discussion.MessageVersion{
		ID: current.ID, ThreadID: current.ThreadID, Author: current.Author, Body: current.Body,
		CreatedAt: current.CreatedAt, EditedAt: current.EditedAt, Version: current.Version, Current: true,
	})
	return versions, nil
}

func (d *Database) PatchThreadStatus(
	ctx context.Context,
	input discussion.PatchThreadStatusInput,
) (discussion.Thread, error) {
	var updated discussion.Thread
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		if err := ensureDiscussionThreadScope(txCtx, tx, input.ThreadID, input.Scope); err != nil {
			return err
		}
		current, err := readDiscussionThread(txCtx, tx, input.ThreadID)
		if err != nil {
			return err
		}
		if current.Version != input.ExpectedVersion {
			return discussionVersionMismatch()
		}
		commandTag, err := tx.Exec(txCtx, `UPDATE feedback.feedback_threads
SET status = $1, version = version + 1, updated_at = now()
WHERE id = $2::uuid AND version = $3`, input.Status, input.ThreadID, input.ExpectedVersion)
		if err != nil {
			return fmt.Errorf("thread statusを更新できません: %w", err)
		}
		if commandTag.RowsAffected() != 1 {
			return discussionVersionMismatch()
		}
		eventType := "feedback.thread.reopened.v1"
		if input.Status == "resolved" {
			eventType = "feedback.thread.resolved.v1"
		}
		if err := appendDiscussionChange(txCtx, tx, input.Scope, eventType, "thread", input.ThreadID,
			map[string]any{"fromStatus": current.Status, "toStatus": input.Status},
		); err != nil {
			return err
		}
		if err := enqueueDiscussionEvent(
			txCtx, tx, input.Scope, eventType, current.SessionID, input.ThreadID,
			input.Principal, nil, input.RequestID,
		); err != nil {
			return err
		}
		updated, err = readDiscussionThread(txCtx, tx, input.ThreadID)
		return err
	})
	return updated, err
}

func ensureDiscussionThreadScope(
	ctx context.Context,
	querier discussionQuerier,
	threadID string,
	scope auth.ResourceScope,
) error {
	var exists bool
	if err := querier.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.feedback_threads
    WHERE id = $1::uuid
      AND tenant_id = $2::uuid
      AND application_id = $3::uuid
      AND environment_id = $4::uuid
      AND workspace_id = $5::uuid
)`, threadID, scope.TenantID, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID).Scan(&exists); err != nil {
		return fmt.Errorf("thread scopeを確認できません: %w", err)
	}
	if !exists {
		return discussionNotFound()
	}
	return nil
}

func ensureDiscussionMessageScope(
	ctx context.Context,
	querier discussionQuerier,
	messageID string,
	scope auth.ResourceScope,
) error {
	var exists bool
	if err := querier.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1
    FROM feedback.feedback_messages message
    JOIN feedback.feedback_threads thread ON thread.id = message.thread_id
    WHERE message.id = $1::uuid
      AND thread.tenant_id = $2::uuid
      AND thread.application_id = $3::uuid
      AND thread.environment_id = $4::uuid
      AND thread.workspace_id = $5::uuid
)`, messageID, scope.TenantID, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID).Scan(&exists); err != nil {
		return fmt.Errorf("message scopeを確認できません: %w", err)
	}
	if !exists {
		return discussionNotFound()
	}
	return nil
}

func (d *Database) EnforceWriteRateLimit(
	ctx context.Context,
	input discussion.RateLimitInput,
) ([]string, error) {
	type dimension struct {
		name    string
		subject string
		limit   int
	}
	dimensions := []dimension{
		{name: "tenant", subject: input.Scope.TenantID, limit: input.TenantLimitPerMinute},
		{name: "principal", subject: input.Principal.Subject, limit: input.PrincipalLimitPerMinute},
		{name: "ip", subject: input.RemoteAddress, limit: input.IPLimitPerMinute},
	}
	exceeded := make([]string, 0, len(dimensions))
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		for _, item := range dimensions {
			hash := sha256.Sum256([]byte(item.subject))
			var count int
			err := tx.QueryRow(txCtx, `INSERT INTO feedback.write_rate_limit_counters (
    tenant_id, dimension, subject_hash, window_epoch, request_count
) VALUES ($1::uuid, $2, $3, floor(extract(epoch FROM now()) / 60)::bigint, 1)
ON CONFLICT (tenant_id, dimension, subject_hash, window_epoch)
DO UPDATE SET request_count = feedback.write_rate_limit_counters.request_count + 1
RETURNING request_count`, input.Scope.TenantID, item.name, hex.EncodeToString(hash[:])).Scan(&count)
			if err != nil {
				return fmt.Errorf("%s write rate counterを更新できません: %w", item.name, err)
			}
			if count > item.limit {
				exceeded = append(exceeded, item.name)
			}
		}
		return nil
	})
	if err != nil || len(exceeded) == 0 {
		return exceeded, err
	}
	if _, err := d.Exec(ctx, `INSERT INTO feedback.operational_metric_counters (
    metric_name, tenant_id, value, updated_at
) VALUES ('rate_limit_rejections_total', $1::uuid, 1, now())
ON CONFLICT (metric_name, tenant_id) DO UPDATE
SET value = feedback.operational_metric_counters.value + 1,
    updated_at = now()`, input.Scope.TenantID); err != nil {
		return nil, fmt.Errorf("rate limit rejection metricを更新できません: %w", err)
	}
	changes, marshalErr := json.Marshal(map[string]any{"dimensions": exceeded})
	if marshalErr != nil {
		return nil, fmt.Errorf("rate limit監査差分を生成できません: %w", marshalErr)
	}
	scope := input.Scope
	requestID := input.RequestID
	if requestID == "" {
		requestID = "unknown"
	}
	if err := d.RecordAudit(ctx, usecase.AuditEvent{
		Scope: &scope, PrincipalID: input.Principal.Subject, Action: "rate_limit",
		ResourceType: "workspace", ResourceID: input.Scope.WorkspaceID,
		Outcome: "denied", RequestID: requestID, Changes: changes,
	}); err != nil {
		return nil, err
	}
	return exceeded, err
}

func loadThreadIdempotency(
	ctx context.Context,
	tx Tx,
	input discussion.CreateThreadInput,
	value *discussion.Thread,
) (bool, error) {
	return loadDiscussionIdempotency(
		ctx, tx, input.Scope.TenantID, input.Principal.Subject, createThreadEndpoint,
		input.IdempotencyKey, input.RequestHash, value,
	)
}

func loadMessageIdempotency(
	ctx context.Context,
	tx Tx,
	input discussion.CreateMessageInput,
	value *discussion.Message,
) (bool, error) {
	return loadDiscussionIdempotency(
		ctx, tx, input.Scope.TenantID, input.Principal.Subject, createMessageEndpoint,
		input.IdempotencyKey, input.RequestHash, value,
	)
}

func loadDiscussionIdempotency(
	ctx context.Context,
	tx Tx,
	tenantID string,
	principalID string,
	endpoint string,
	key string,
	requestHash string,
	response any,
) (bool, error) {
	lockValue := principalID + "\x1f" + endpoint + "\x1f" + key
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockValue); err != nil {
		return false, fmt.Errorf("idempotency lockを取得できません: %w", err)
	}
	var existingHash string
	var body []byte
	err := tx.QueryRow(ctx, `SELECT request_hash, response_body
FROM feedback.idempotency_records
WHERE tenant_id = $1::uuid AND principal_id = $2 AND endpoint = $3 AND idempotency_key = $4
  AND expires_at > now()`, tenantID, principalID, endpoint, key).Scan(&existingHash, &body)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("idempotency recordを取得できません: %w", err)
	}
	if existingHash != requestHash {
		return false, discussionConflict(
			"idempotency.mismatch", "同じIdempotency-Keyが異なるrequestに使われました",
		)
	}
	if err := json.Unmarshal(body, response); err != nil {
		return false, fmt.Errorf("idempotency responseを復元できません: %w", err)
	}
	return true, nil
}

func saveDiscussionIdempotency(
	ctx context.Context,
	tx Tx,
	tenantID string,
	principalID string,
	endpoint string,
	key string,
	requestHash string,
	response any,
) error {
	body, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("idempotency responseを生成できません: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO feedback.idempotency_records (
    tenant_id, principal_id, endpoint, idempotency_key, request_hash,
    response_status, response_body, expires_at
) VALUES ($1::uuid, $2, $3, $4, $5, 201, $6::jsonb, now() + interval '24 hours')`,
		tenantID, principalID, endpoint, key, requestHash, string(body),
	)
	if err != nil {
		return fmt.Errorf("idempotency responseを登録できません: %w", err)
	}
	return nil
}

func readDiscussionThread(
	ctx context.Context,
	querier discussionQuerier,
	threadID string,
) (discussion.Thread, error) {
	row := querier.QueryRow(ctx, `SELECT thread.id::text, thread.session_id::text, thread.display_number,
       thread.location, thread.target, thread.perspective_code, thread.status,
       thread.reporter_principal_id, thread.reporter_display_name, thread.reporter_participant_name,
       thread.created_at, thread.updated_at, thread.version
FROM feedback.feedback_threads thread
WHERE thread.id = $1::uuid`, threadID)
	thread, err := scanDiscussionThread(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return discussion.Thread{}, discussionNotFound()
	}
	if err != nil {
		return discussion.Thread{}, fmt.Errorf("threadを読み取れません: %w", err)
	}
	if err := loadDiscussionThreadRelations(ctx, querier, &thread); err != nil {
		return discussion.Thread{}, err
	}
	return thread, nil
}

type discussionScanner interface {
	Scan(...any) error
}

func scanDiscussionThread(scanner discussionScanner) (discussion.Thread, error) {
	var thread discussion.Thread
	var location, target []byte
	var createdAt, updatedAt time.Time
	err := scanner.Scan(
		&thread.ID, &thread.SessionID, &thread.DisplayNumber, &location, &target,
		&thread.PerspectiveCode, &thread.Status, &thread.Reporter.PrincipalID,
		&thread.Reporter.DisplayName, &thread.Reporter.ParticipantName,
		&createdAt, &updatedAt, &thread.Version,
	)
	if err != nil {
		return discussion.Thread{}, err
	}
	thread.Location = append(json.RawMessage(nil), location...)
	thread.Target = append(json.RawMessage(nil), target...)
	thread.CreatedAt = javaInstant(createdAt)
	thread.UpdatedAt = javaInstant(updatedAt)
	thread.Messages = make([]discussion.Message, 0)
	return thread, nil
}

func loadDiscussionThreadRelations(
	ctx context.Context,
	querier discussionQuerier,
	thread *discussion.Thread,
) error {
	rows, err := querier.Query(ctx, `SELECT message.id::text, message.thread_id::text,
       message.author_principal_id, message.author_display_name, message.author_participant_name,
       message.body, message.created_at, message.edited_at, message.version
FROM feedback.feedback_messages message
WHERE message.thread_id = $1::uuid
ORDER BY message.created_at, message.id`, thread.ID)
	if err != nil {
		return fmt.Errorf("thread messageを取得できません: %w", err)
	}
	messages := make([]discussion.Message, 0)
	for rows.Next() {
		message, err := scanDiscussionMessage(rows)
		if err != nil {
			rows.Close()
			return fmt.Errorf("thread messageを読み取れません: %w", err)
		}
		messages = append(messages, message)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fmt.Errorf("thread messageの走査に失敗しました: %w", err)
	}
	thread.Messages = messages
	if err := querier.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.review_evidence WHERE thread_id = $1::uuid
)`, thread.ID).Scan(&thread.EvidenceAvailable); err != nil {
		return fmt.Errorf("thread evidence有無を取得できません: %w", err)
	}
	return nil
}

func insertDiscussionMessage(
	ctx context.Context,
	tx Tx,
	threadID string,
	principal auth.Principal,
	body string,
	participantName *string,
) (discussion.Message, error) {
	messageID := uuid.NewString()
	_, err := tx.Exec(ctx, `INSERT INTO feedback.feedback_messages (
    id, thread_id, author_principal_id, author_display_name, author_participant_name, body
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`, messageID, threadID, principal.Subject,
		optionalString(principal.DisplayName), optionalString(participantName), strings.TrimSpace(body),
	)
	if err != nil {
		return discussion.Message{}, fmt.Errorf("messageを登録できません: %w", err)
	}
	return readDiscussionMessage(ctx, tx, messageID, false)
}

func readDiscussionMessage(
	ctx context.Context,
	querier discussionQuerier,
	messageID string,
	forUpdate bool,
) (discussion.Message, error) {
	query := `SELECT message.id::text, message.thread_id::text,
       message.author_principal_id, message.author_display_name, message.author_participant_name,
       message.body, message.created_at, message.edited_at, message.version
FROM feedback.feedback_messages message
WHERE message.id = $1::uuid`
	if forUpdate {
		query += " FOR UPDATE"
	}
	message, err := scanDiscussionMessage(querier.QueryRow(ctx, query, messageID))
	if errors.Is(err, pgx.ErrNoRows) {
		return discussion.Message{}, discussionNotFound()
	}
	if err != nil {
		return discussion.Message{}, fmt.Errorf("messageを読み取れません: %w", err)
	}
	return message, nil
}

func scanDiscussionMessage(scanner discussionScanner) (discussion.Message, error) {
	var message discussion.Message
	var createdAt time.Time
	var editedAt *time.Time
	err := scanner.Scan(
		&message.ID, &message.ThreadID, &message.Author.PrincipalID,
		&message.Author.DisplayName, &message.Author.ParticipantName, &message.Body,
		&createdAt, &editedAt, &message.Version,
	)
	if err != nil {
		return discussion.Message{}, err
	}
	message.CreatedAt = javaInstant(createdAt)
	message.EditedAt = instantPointer(editedAt)
	return message, nil
}

func scanDiscussionMessageVersion(
	scanner discussionScanner,
	current bool,
) (discussion.MessageVersion, error) {
	var version discussion.MessageVersion
	var createdAt time.Time
	var editedAt *time.Time
	err := scanner.Scan(
		&version.ID, &version.ThreadID, &version.Author.PrincipalID,
		&version.Author.DisplayName, &version.Author.ParticipantName, &version.Body,
		&createdAt, &editedAt, &version.Version,
	)
	if err != nil {
		return discussion.MessageVersion{}, err
	}
	version.CreatedAt = javaInstant(createdAt)
	version.EditedAt = instantPointer(editedAt)
	version.Current = current
	return version, nil
}

func appendDiscussionChange(
	ctx context.Context,
	tx Tx,
	scope auth.ResourceScope,
	eventType string,
	resourceType string,
	resourceID string,
	payload map[string]any,
) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("change journal payloadを生成できません: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO feedback.feedback_change_journal (
    tenant_id, application_id, environment_id, workspace_id,
    event_type, resource_type, resource_id, payload
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb)`,
		scope.TenantID, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID,
		eventType, resourceType, resourceID, string(encoded),
	)
	if err != nil {
		return fmt.Errorf("change journalを登録できません: %w", err)
	}
	return nil
}

func enqueueDiscussionEvent(
	ctx context.Context,
	tx Tx,
	scope auth.ResourceScope,
	eventType string,
	sessionID string,
	threadID string,
	principal auth.Principal,
	body *string,
	requestID string,
) error {
	eventID := uuid.NewString()
	if requestID == "" {
		requestID = "unknown"
	}
	payload := struct {
		SchemaVersion        string                 `json:"schemaVersion"`
		EventID              string                 `json:"eventId"`
		RequestID            string                 `json:"requestId"`
		EventType            string                 `json:"eventType"`
		OccurredAt           string                 `json:"occurredAt"`
		TenantKey            string                 `json:"tenantKey"`
		ApplicationKey       string                 `json:"applicationKey"`
		EnvironmentKey       string                 `json:"environmentKey"`
		ExternalWorkspaceKey string                 `json:"externalWorkspaceKey"`
		SessionID            string                 `json:"sessionId"`
		ThreadID             string                 `json:"threadId"`
		Actor                discussion.Participant `json:"actor"`
		DeepLink             *string                `json:"deepLink"`
		Body                 *string                `json:"body"`
		EvidenceURL          *string                `json:"evidenceUrl"`
	}{
		SchemaVersion: "1", EventID: eventID, RequestID: requestID, EventType: eventType,
		OccurredAt: javaInstant(time.Now()), TenantKey: scope.TenantKey, ApplicationKey: scope.ApplicationKey,
		EnvironmentKey: scope.EnvironmentKey, ExternalWorkspaceKey: scope.ExternalWorkspaceKey,
		SessionID: sessionID, ThreadID: threadID,
		Actor: discussion.Participant{PrincipalID: principal.Subject, DisplayName: principal.DisplayName},
		Body:  body,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("notification payloadを生成できません: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO feedback.notification_outbox (
    id, tenant_id, workspace_id, event_type, payload
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)`, eventID, scope.TenantID,
		scope.WorkspaceID, eventType, string(encoded),
	); err != nil {
		return fmt.Errorf("notification outboxを登録できません: %w", err)
	}
	commandTag, err := tx.Exec(ctx, `INSERT INTO feedback.connector_delivery_queue (id, outbox_id, connector_id)
SELECT gen_random_uuid(), $1::uuid, connector.id
FROM feedback.notification_connectors connector
JOIN feedback.connector_installations installation ON installation.id = connector.installation_id
WHERE connector.workspace_id = $2::uuid
  AND connector.enabled
  AND connector.deleted_at IS NULL
  AND installation.enabled
  AND $3 = ANY(installation.supported_events)`, eventID, scope.WorkspaceID, eventType)
	if err != nil {
		return fmt.Errorf("connector deliveryを登録できません: %w", err)
	}
	if commandTag.RowsAffected() == 0 {
		_, err = tx.Exec(ctx, `UPDATE feedback.notification_outbox outbox
SET status = 'delivered', delivered_at = now(), last_error = NULL
WHERE outbox.id = $1::uuid
  AND NOT EXISTS (
      SELECT 1 FROM feedback.notification_settings settings
      WHERE settings.workspace_id = outbox.workspace_id
        AND settings.webhook_enabled
  )`, eventID)
		if err != nil {
			return fmt.Errorf("空のnotification outboxを完了できません: %w", err)
		}
	}
	return nil
}

func incrementDiscussionMetric(ctx context.Context, tx Tx, name string, tenantID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO feedback.operational_metric_counters (
    metric_name, tenant_id, value, updated_at
) VALUES ($1, $2::uuid, 1, now())
ON CONFLICT (metric_name, tenant_id) DO UPDATE
SET value = feedback.operational_metric_counters.value + 1,
    updated_at = now()`, name, tenantID)
	if err != nil {
		return fmt.Errorf("operational metricを更新できません: %w", err)
	}
	return nil
}

func discussionInvalid(code string, detail string) error {
	return &discussion.Error{Kind: discussion.ErrInvalidInput, Code: code, Detail: detail}
}

func discussionNotFound() error {
	return &discussion.Error{
		Kind: discussion.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません",
	}
}

func discussionConflict(code string, detail string) error {
	return &discussion.Error{Kind: discussion.ErrConflict, Code: code, Detail: detail}
}

func discussionVersionMismatch() error {
	return &discussion.Error{
		Kind: discussion.ErrVersionMismatch, Code: "resource.version_mismatch",
		Detail: "ETagが現在の版と一致しません",
	}
}
