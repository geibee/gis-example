package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	sessiondomain "github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

const sessionEndpoint = "POST /sessions"

type sessionQueryer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (d *Database) ResolveResourceScope(
	ctx context.Context,
	userID string,
	kind string,
	resourceID string,
) (auth.ResourceScope, error) {
	table, idColumn, joins, ok := resourceScopeSource(kind)
	if !ok {
		return auth.ResourceScope{}, fmt.Errorf("resource IDから解決できないscope kindです: %s", kind)
	}
	query := fmt.Sprintf(`SELECT r.tenant_id::text, t.tenant_key, r.application_id::text,
       r.environment_id::text, r.workspace_id::text, a.application_key,
       environment.environment_key, workspace.external_workspace_key
FROM %s
%s
JOIN feedback.workspace_memberships membership
  ON membership.workspace_id = r.workspace_id AND membership.user_id = $1::uuid
JOIN feedback.tenants t ON t.id = r.tenant_id
JOIN feedback.applications a ON a.id = r.application_id
JOIN feedback.application_environments environment ON environment.id = r.environment_id
JOIN feedback.workspaces workspace ON workspace.id = r.workspace_id
WHERE %s = $2::uuid`, table, joins, idColumn)
	var scope auth.ResourceScope
	err := d.QueryRow(ctx, query, userID, resourceID).Scan(
		&scope.TenantID, &scope.TenantKey, &scope.ApplicationID, &scope.EnvironmentID, &scope.WorkspaceID,
		&scope.ApplicationKey, &scope.EnvironmentKey, &scope.ExternalWorkspaceKey,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.ResourceScope{}, notFoundError()
	}
	if err != nil {
		return auth.ResourceScope{}, fmt.Errorf("resource scopeを取得できません: %w", err)
	}
	return scope, nil
}

func resourceScopeSource(kind string) (table, idColumn, joins string, ok bool) {
	switch kind {
	case sessiondomain.ResourceKindSession:
		return "feedback.review_sessions r", "r.id", "", true
	case sessiondomain.ResourceKindThread:
		return "feedback.feedback_threads r", "r.id", "", true
	case sessiondomain.ResourceKindMessage:
		return "feedback.feedback_messages m", "m.id", "JOIN feedback.feedback_threads r ON r.id = m.thread_id", true
	case sessiondomain.ResourceKindExport:
		return "feedback.export_jobs r", "r.id", "", true
	case sessiondomain.ResourceKindBackup:
		return "feedback.backup_runs r", "r.id", "", true
	default:
		return "", "", "", false
	}
}

func (d *Database) ListSessions(
	ctx context.Context,
	scope auth.ResourceScope,
	status *string,
	limit int,
	offset int,
) (sessiondomain.Page, error) {
	filter := ""
	arguments := []any{scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID}
	if status != nil {
		filter = " AND session.status = $4"
		arguments = append(arguments, *status)
	}
	var total int64
	if err := d.QueryRow(ctx, `SELECT count(*) FROM feedback.review_sessions session
WHERE session.application_id = $1::uuid AND session.environment_id = $2::uuid
  AND session.workspace_id = $3::uuid`+filter, arguments...).Scan(&total); err != nil {
		return sessiondomain.Page{}, fmt.Errorf("session件数を取得できません: %w", err)
	}
	limitPosition := len(arguments) + 1
	offsetPosition := limitPosition + 1
	query := fmt.Sprintf(`SELECT session.id::text, application.application_key, environment.environment_key,
       workspace.external_workspace_key, session.manifest_version, session.title, session.description,
       session.status, session.out_of_scope_posting, session.start_at, session.end_at,
       session.created_at, session.updated_at, session.version
FROM feedback.review_sessions session
JOIN feedback.applications application ON application.id = session.application_id
JOIN feedback.application_environments environment ON environment.id = session.environment_id
JOIN feedback.workspaces workspace ON workspace.id = session.workspace_id
WHERE session.application_id = $1::uuid AND session.environment_id = $2::uuid
  AND session.workspace_id = $3::uuid%s
ORDER BY session.created_at DESC, session.id DESC
LIMIT $%d OFFSET $%d`, filter, limitPosition, offsetPosition)
	arguments = append(arguments, limit, offset)
	rows, err := d.Query(ctx, query, arguments...)
	if err != nil {
		return sessiondomain.Page{}, fmt.Errorf("session一覧を取得できません: %w", err)
	}
	items := make([]sessiondomain.Session, 0)
	for rows.Next() {
		item, err := scanSession(rows)
		if err != nil {
			rows.Close()
			return sessiondomain.Page{}, fmt.Errorf("session一覧を読み取れません: %w", err)
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return sessiondomain.Page{}, fmt.Errorf("session一覧の走査に失敗しました: %w", err)
	}
	for index := range items {
		if err := loadSessionChildren(ctx, d, &items[index]); err != nil {
			return sessiondomain.Page{}, err
		}
	}
	page := sessiondomain.Page{Items: items, TotalCount: total}
	if int64(offset+len(items)) < total {
		next := sessiondomain.EncodeCursor(offset + len(items))
		page.NextCursor = &next
	}
	return page, nil
}

func (d *Database) GetSession(ctx context.Context, sessionID string) (sessiondomain.Session, error) {
	return readSessionByID(ctx, d, sessionID)
}

func (d *Database) CreateSession(
	ctx context.Context,
	scope auth.ResourceScope,
	principal auth.Principal,
	command sessiondomain.CreateCommand,
) (sessiondomain.Session, error) {
	var saved sessiondomain.Session
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		lockValue := idempotencyLockValue(principal.Subject, sessionEndpoint, command.IdempotencyKey)
		if _, err := tx.Exec(txCtx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockValue); err != nil {
			return fmt.Errorf("idempotency lockを取得できません: %w", err)
		}
		var existingHash string
		var existingBody []byte
		err := tx.QueryRow(txCtx, `SELECT request_hash, response_body
FROM feedback.idempotency_records
WHERE tenant_id = $1::uuid AND principal_id = $2 AND endpoint = $3 AND idempotency_key = $4
  AND expires_at > now()`, scope.TenantID, principal.Subject, sessionEndpoint, command.IdempotencyKey).Scan(
			&existingHash, &existingBody,
		)
		if err == nil {
			if existingHash != command.RequestHash {
				return &usecase.DomainError{
					Kind: usecase.ErrConflict, Code: "idempotency.mismatch",
					Detail: "同じ Idempotency-Key が異なる request に使われました",
				}
			}
			if err := json.Unmarshal(existingBody, &saved); err != nil {
				return fmt.Errorf("idempotency responseを復元できません: %w", err)
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("idempotency recordを取得できません: %w", err)
		}

		if err := sessiondomain.ValidateCreate(command.Request); err != nil {
			return err
		}
		request := sessiondomain.NormalizeCreate(command.Request)
		var manifestExists bool
		if err := tx.QueryRow(txCtx, `SELECT EXISTS (
    SELECT 1 FROM feedback.application_manifests
    WHERE application_id = $1::uuid AND manifest_version = $2
)`, scope.ApplicationID, request.ManifestVersion).Scan(&manifestExists); err != nil {
			return fmt.Errorf("manifestVersionを確認できません: %w", err)
		}
		if !manifestExists {
			return &sessiondomain.ValidationError{Code: "request.invalid", Detail: "manifestVersion が登録されていません"}
		}

		sessionID := uuid.NewString()
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.review_sessions (
    id, tenant_id, application_id, environment_id, workspace_id, manifest_version,
    title, description, out_of_scope_posting, start_at, end_at, created_by
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12)`,
			sessionID, scope.TenantID, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID,
			request.ManifestVersion, request.Title, optionalString(request.Description), request.OutOfScopePosting,
			optionalString(request.StartAt), optionalString(request.EndAt), principal.Subject,
		)
		if err != nil {
			return fmt.Errorf("sessionを登録できません: %w", err)
		}
		for _, reviewScope := range request.Scopes {
			if _, err := tx.Exec(txCtx, `INSERT INTO feedback.review_scopes (
    id, session_id, page_key, route_template, reviewable
) VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
				uuid.NewString(), sessionID, reviewScope.PageKey, optionalString(reviewScope.RouteTemplate), reviewScope.Reviewable,
			); err != nil {
				return fmt.Errorf("session scopeを登録できません: %w", err)
			}
		}
		for _, perspective := range request.Perspectives {
			if _, err := tx.Exec(txCtx, `INSERT INTO feedback.review_session_perspectives (
    session_id, code, label, status, guidance
) VALUES ($1::uuid, $2, $3, $4, $5)`,
				sessionID, perspective.Code, perspective.Label, perspective.Status, optionalString(perspective.Guidance),
			); err != nil {
				return fmt.Errorf("session perspectiveを登録できません: %w", err)
			}
		}
		saved, err = readSessionByID(txCtx, tx, sessionID)
		if err != nil {
			return err
		}
		body, err := json.Marshal(saved)
		if err != nil {
			return fmt.Errorf("idempotency responseを生成できません: %w", err)
		}
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.idempotency_records (
    tenant_id, principal_id, endpoint, idempotency_key, request_hash,
    response_status, response_body, expires_at
) VALUES ($1::uuid, $2, $3, $4, $5, 201, $6::jsonb, now() + interval '24 hours')`,
			scope.TenantID, principal.Subject, sessionEndpoint, command.IdempotencyKey, command.RequestHash, string(body),
		)
		if err != nil {
			return fmt.Errorf("idempotency responseを登録できません: %w", err)
		}
		return nil
	})
	if err != nil {
		if uniqueViolation(err) {
			return sessiondomain.Session{}, openSessionConflict()
		}
		return sessiondomain.Session{}, err
	}
	return saved, nil
}

func (d *Database) PatchSession(
	ctx context.Context,
	sessionID string,
	patch sessiondomain.Patch,
) (sessiondomain.Session, error) {
	var saved sessiondomain.Session
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		current, err := readSessionByID(txCtx, tx, sessionID)
		if err != nil {
			return err
		}
		if current.Version != patch.ExpectedVersion {
			return versionMismatchError()
		}
		if err := sessiondomain.ValidatePatch(patch, current); err != nil {
			return err
		}
		tag, err := tx.Exec(txCtx, `UPDATE feedback.review_sessions SET
    title = CASE WHEN $1 THEN $2 ELSE title END,
    description = CASE WHEN $3 THEN $4 ELSE description END,
    status = CASE WHEN $5 THEN $6 ELSE status END,
    out_of_scope_posting = CASE WHEN $7 THEN $8 ELSE out_of_scope_posting END,
    start_at = CASE WHEN $9 THEN $10::timestamptz ELSE start_at END,
    end_at = CASE WHEN $11 THEN $12::timestamptz ELSE end_at END,
    version = version + 1,
    updated_at = now()
WHERE id = $13::uuid AND version = $14`,
			patch.Title != nil, optionalString(patch.Title),
			patch.Description.Present, optionalString(patch.Description.Value),
			patch.Status != nil, optionalString(patch.Status),
			patch.OutOfScopePosting != nil, optionalString(patch.OutOfScopePosting),
			patch.StartAt.Present, optionalString(patch.StartAt.Value),
			patch.EndAt.Present, optionalString(patch.EndAt.Value),
			sessionID, patch.ExpectedVersion,
		)
		if err != nil {
			return fmt.Errorf("sessionを更新できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return versionMismatchError()
		}
		saved, err = readSessionByID(txCtx, tx, sessionID)
		return err
	})
	if err != nil {
		if uniqueViolation(err) {
			return sessiondomain.Session{}, openSessionConflict()
		}
		return sessiondomain.Session{}, err
	}
	return saved, nil
}

func readSessionByID(ctx context.Context, queryer sessionQueryer, sessionID string) (sessiondomain.Session, error) {
	row := queryer.QueryRow(ctx, `SELECT session.id::text, application.application_key, environment.environment_key,
       workspace.external_workspace_key, session.manifest_version, session.title, session.description,
       session.status, session.out_of_scope_posting, session.start_at, session.end_at,
       session.created_at, session.updated_at, session.version
FROM feedback.review_sessions session
JOIN feedback.applications application ON application.id = session.application_id
JOIN feedback.application_environments environment ON environment.id = session.environment_id
JOIN feedback.workspaces workspace ON workspace.id = session.workspace_id
WHERE session.id = $1::uuid`, sessionID)
	result, err := scanSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return sessiondomain.Session{}, notFoundError()
	}
	if err != nil {
		return sessiondomain.Session{}, fmt.Errorf("sessionを取得できません: %w", err)
	}
	if err := loadSessionChildren(ctx, queryer, &result); err != nil {
		return sessiondomain.Session{}, err
	}
	return result, nil
}

type sessionScanner interface {
	Scan(...any) error
}

func scanSession(row sessionScanner) (sessiondomain.Session, error) {
	var result sessiondomain.Session
	var startAt, endAt *time.Time
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&result.ID, &result.ApplicationKey, &result.EnvironmentKey, &result.ExternalWorkspaceKey,
		&result.ManifestVersion, &result.Title, &result.Description, &result.Status, &result.OutOfScopePosting,
		&startAt, &endAt, &createdAt, &updatedAt, &result.Version,
	)
	if err != nil {
		return sessiondomain.Session{}, err
	}
	result.StartAt = instantPointer(startAt)
	result.EndAt = instantPointer(endAt)
	result.CreatedAt = javaInstant(createdAt)
	result.UpdatedAt = javaInstant(updatedAt)
	result.Scopes = make([]sessiondomain.Scope, 0)
	result.Perspectives = make([]sessiondomain.Perspective, 0)
	return result, nil
}

func loadSessionChildren(ctx context.Context, queryer sessionQueryer, result *sessiondomain.Session) error {
	scopeRows, err := queryer.Query(ctx, `SELECT page_key, route_template, reviewable
FROM feedback.review_scopes WHERE session_id = $1::uuid
ORDER BY page_key, route_template NULLS FIRST`, result.ID)
	if err != nil {
		return fmt.Errorf("session scopeを取得できません: %w", err)
	}
	for scopeRows.Next() {
		var value sessiondomain.Scope
		if err := scopeRows.Scan(&value.PageKey, &value.RouteTemplate, &value.Reviewable); err != nil {
			scopeRows.Close()
			return fmt.Errorf("session scopeを読み取れません: %w", err)
		}
		result.Scopes = append(result.Scopes, value)
	}
	err = scopeRows.Err()
	scopeRows.Close()
	if err != nil {
		return fmt.Errorf("session scopeの走査に失敗しました: %w", err)
	}

	perspectiveRows, err := queryer.Query(ctx, `SELECT code, label, status, guidance
FROM feedback.review_session_perspectives WHERE session_id = $1::uuid ORDER BY code`, result.ID)
	if err != nil {
		return fmt.Errorf("session perspectiveを取得できません: %w", err)
	}
	for perspectiveRows.Next() {
		var value sessiondomain.Perspective
		if err := perspectiveRows.Scan(&value.Code, &value.Label, &value.Status, &value.Guidance); err != nil {
			perspectiveRows.Close()
			return fmt.Errorf("session perspectiveを読み取れません: %w", err)
		}
		result.Perspectives = append(result.Perspectives, value)
	}
	err = perspectiveRows.Err()
	perspectiveRows.Close()
	if err != nil {
		return fmt.Errorf("session perspectiveの走査に失敗しました: %w", err)
	}
	return nil
}

func optionalString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func idempotencyLockValue(principalID, endpoint, key string) string {
	return principalID + "\x1f" + endpoint + "\x1f" + key
}

func uniqueViolation(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "23505"
}

func notFoundError() error {
	return &usecase.DomainError{
		Kind: usecase.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません",
	}
}

func versionMismatchError() error {
	return &usecase.DomainError{
		Kind: usecase.ErrVersionMismatch, Code: "resource.version_mismatch", Detail: "ETagが現在の版と一致しません",
	}
}

func openSessionConflict() error {
	return &usecase.DomainError{
		Kind: usecase.ErrConflict, Code: "session.open_conflict",
		Detail: "同じ application/environment/workspace に open session が存在します",
	}
}
