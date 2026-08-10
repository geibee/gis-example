package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

func (d *Database) ResolveApplicationScope(
	ctx context.Context,
	userID string,
	applicationKey string,
) (auth.ResourceScope, error) {
	rows, err := d.Query(ctx, `SELECT t.id::text, t.tenant_key, a.id::text, a.application_key
FROM feedback.application_memberships membership
JOIN feedback.applications a ON a.id = membership.application_id
JOIN feedback.tenants t ON t.id = a.tenant_id
WHERE membership.user_id = $1::uuid AND a.application_key = $2`, userID, applicationKey)
	if err != nil {
		return auth.ResourceScope{}, fmt.Errorf("application scopeを取得できません: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return auth.ResourceScope{}, fmt.Errorf("application scopeを取得できません: %w", err)
		}
		return auth.ResourceScope{}, &usecase.DomainError{Kind: usecase.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません"}
	}
	var scope auth.ResourceScope
	if err := rows.Scan(&scope.TenantID, &scope.TenantKey, &scope.ApplicationID, &scope.ApplicationKey); err != nil {
		return auth.ResourceScope{}, fmt.Errorf("application scopeを読み取れません: %w", err)
	}
	if rows.Next() {
		return auth.ResourceScope{}, &usecase.DomainError{
			Kind: usecase.ErrConflict, Code: "application.ambiguous", Detail: "applicationKeyが複数tenantで曖昧です",
		}
	}
	return scope, nil
}

func (d *Database) ResolveWorkspaceScope(
	ctx context.Context,
	userID string,
	applicationKey string,
	externalWorkspaceKey string,
	environmentKey string,
) (auth.ResourceScope, error) {
	rows, err := d.Query(ctx, `SELECT t.id::text, t.tenant_key, a.id::text, environment.id::text, workspace.id::text,
       a.application_key, environment.environment_key, workspace.external_workspace_key
FROM feedback.workspace_memberships membership
JOIN feedback.workspaces workspace ON workspace.id = membership.workspace_id
JOIN feedback.applications a ON a.id = workspace.application_id
JOIN feedback.tenants t ON t.id = a.tenant_id
JOIN feedback.application_environments environment
  ON environment.application_id = a.id AND environment.environment_key = $1
WHERE membership.user_id = $2::uuid
  AND a.application_key = $3
  AND workspace.external_workspace_key = $4`, environmentKey, userID, applicationKey, externalWorkspaceKey)
	if err != nil {
		return auth.ResourceScope{}, fmt.Errorf("workspace scopeを取得できません: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return auth.ResourceScope{}, fmt.Errorf("workspace scopeを取得できません: %w", err)
		}
		return auth.ResourceScope{}, &usecase.DomainError{Kind: usecase.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません"}
	}
	var scope auth.ResourceScope
	if err := rows.Scan(
		&scope.TenantID, &scope.TenantKey, &scope.ApplicationID, &scope.EnvironmentID, &scope.WorkspaceID,
		&scope.ApplicationKey, &scope.EnvironmentKey, &scope.ExternalWorkspaceKey,
	); err != nil {
		return auth.ResourceScope{}, fmt.Errorf("workspace scopeを読み取れません: %w", err)
	}
	if rows.Next() {
		return auth.ResourceScope{}, &usecase.DomainError{
			Kind: usecase.ErrConflict, Code: "workspace.ambiguous", Detail: "workspace keyが複数tenantで曖昧です",
		}
	}
	return scope, nil
}

func (d *Database) GetManifest(ctx context.Context, applicationID string) (usecase.ManifestRecord, error) {
	var manifest []byte
	var version int
	err := d.QueryRow(ctx, `SELECT manifest, version
FROM feedback.application_manifests
WHERE application_id = $1::uuid
ORDER BY created_at DESC
LIMIT 1`, applicationID).Scan(&manifest, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return usecase.ManifestRecord{}, &usecase.DomainError{
			Kind: usecase.ErrNotFound, Code: "resource.not_found", Detail: "application manifestが登録されていません",
		}
	}
	if err != nil {
		return usecase.ManifestRecord{}, fmt.Errorf("application manifestを取得できません: %w", err)
	}
	return usecase.ManifestRecord{Manifest: cloneJSON(manifest), Version: version}, nil
}

func (d *Database) PutManifest(ctx context.Context, input usecase.ManifestPut) (usecase.ManifestRecord, error) {
	var saved usecase.ManifestRecord
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var currentVersionName string
		var currentManifest []byte
		var currentVersion int
		err := tx.QueryRow(txCtx, `SELECT manifest_version, manifest, version
FROM feedback.application_manifests
WHERE application_id = $1::uuid
ORDER BY created_at DESC
LIMIT 1
FOR UPDATE`, input.Scope.ApplicationID).Scan(&currentVersionName, &currentManifest, &currentVersion)
		currentExists := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("現在のmanifestを取得できません: %w", err)
		}
		if input.ExpectedVersion != nil && (!currentExists || currentVersion != *input.ExpectedVersion) {
			return &usecase.DomainError{
				Kind: usecase.ErrVersionMismatch, Code: "resource.version_mismatch", Detail: "ETagが現在の版と一致しません",
			}
		}
		if currentExists && currentVersionName == input.ManifestVersion {
			equal, err := equalJSON(currentManifest, input.Manifest)
			if err != nil {
				return fmt.Errorf("manifest JSONを比較できません: %w", err)
			}
			if !equal {
				return &usecase.DomainError{
					Kind: usecase.ErrConflict, Code: "manifest.version_immutable",
					Detail: "同じmanifestVersionの内容は変更できません。新しいversionを指定してください",
				}
			}
			saved = usecase.ManifestRecord{Manifest: cloneJSON(currentManifest), Version: currentVersion}
			return nil
		}

		version := currentVersion + 1
		if !currentExists {
			version = 1
		}
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.application_manifests (
    id, application_id, manifest_version, manifest, version, created_by
) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6)`,
			uuid.NewString(), input.Scope.ApplicationID, input.ManifestVersion, string(input.Manifest), version, input.Principal.Subject,
		)
		if err != nil {
			return fmt.Errorf("application manifestを登録できません: %w", err)
		}
		saved = usecase.ManifestRecord{Manifest: cloneJSON(input.Manifest), Version: version}
		return nil
	})
	if err != nil {
		return usecase.ManifestRecord{}, err
	}
	return saved, nil
}

func (d *Database) ReviewContext(
	ctx context.Context,
	scope auth.ResourceScope,
	pageKey string,
	routeTemplate string,
	permissions []auth.Permission,
	evidenceMaxBytes int64,
) (usecase.ReviewContext, error) {
	session, err := d.activeSession(ctx, scope)
	if err != nil {
		return usecase.ReviewContext{}, err
	}
	var manifestVersion any
	if session != nil {
		manifestVersion = session.ManifestVersion
	}
	var manifestRegistered bool
	err = d.QueryRow(ctx, `WITH selected_manifest AS (
    SELECT manifest
    FROM feedback.application_manifests
    WHERE application_id = $1::uuid
      AND ($2::text IS NULL OR manifest_version = $2::text)
    ORDER BY created_at DESC
    LIMIT 1
)
SELECT EXISTS (
    SELECT 1
    FROM selected_manifest manifest,
         jsonb_array_elements(manifest.manifest->'routes') route
    WHERE route->>'pageKey' = $3
      AND (route->>'template' = $4 OR (route->'aliases') ? $4)
)`, scope.ApplicationID, manifestVersion, pageKey, routeTemplate).Scan(&manifestRegistered)
	if err != nil {
		return usecase.ReviewContext{}, fmt.Errorf("manifest routeを確認できません: %w", err)
	}

	scopeValue := "unregistered"
	posting := "deny"
	if manifestRegistered && session != nil {
		scopeValue = "excluded"
		for _, reviewScope := range session.Scopes {
			if reviewScope.PageKey != pageKey || (reviewScope.RouteTemplate != nil && *reviewScope.RouteTemplate != routeTemplate) {
				continue
			}
			if reviewScope.Reviewable {
				scopeValue = "reviewable"
				posting = "allow"
			}
			break
		}
		if scopeValue == "excluded" {
			posting = session.OutOfScopePosting
		}
	} else if manifestRegistered {
		scopeValue = "excluded"
	}

	return usecase.ReviewContext{
		Session: session, Scope: scopeValue, Posting: posting,
		Permissions:       append([]auth.Permission(nil), permissions...),
		ParticipantPolicy: usecase.ParticipantPolicy{Mode: "authenticated-identity"},
		EvidencePolicy: usecase.EvidencePolicy{
			Enabled: true, MaxBytes: evidenceMaxBytes, AcceptedContentTypes: []string{"image/png", "image/webp"},
		},
	}, nil
}

func (d *Database) activeSession(ctx context.Context, scope auth.ResourceScope) (*usecase.Session, error) {
	var session usecase.Session
	var description *string
	var startAt, endAt *time.Time
	var createdAt, updatedAt time.Time
	err := d.QueryRow(ctx, `SELECT session.id::text, application.application_key, environment.environment_key,
       workspace.external_workspace_key, session.manifest_version, session.title, session.description,
       session.status, session.out_of_scope_posting, session.start_at, session.end_at,
       session.created_at, session.updated_at, session.version
FROM feedback.review_sessions session
JOIN feedback.applications application ON application.id = session.application_id
JOIN feedback.application_environments environment ON environment.id = session.environment_id
JOIN feedback.workspaces workspace ON workspace.id = session.workspace_id
WHERE session.application_id = $1::uuid AND session.environment_id = $2::uuid AND session.workspace_id = $3::uuid
  AND session.status = 'open'
  AND (session.start_at IS NULL OR session.start_at <= now())
  AND (session.end_at IS NULL OR session.end_at >= now())
LIMIT 1`, scope.ApplicationID, scope.EnvironmentID, scope.WorkspaceID).Scan(
		&session.ID, &session.ApplicationKey, &session.EnvironmentKey, &session.ExternalWorkspaceKey,
		&session.ManifestVersion, &session.Title, &description, &session.Status, &session.OutOfScopePosting,
		&startAt, &endAt, &createdAt, &updatedAt, &session.Version,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("active sessionを取得できません: %w", err)
	}
	session.Description = description
	session.StartAt = instantPointer(startAt)
	session.EndAt = instantPointer(endAt)
	session.CreatedAt = javaInstant(createdAt)
	session.UpdatedAt = javaInstant(updatedAt)

	scopeRows, err := d.Query(ctx, `SELECT page_key, route_template, reviewable
FROM feedback.review_scopes
WHERE session_id = $1::uuid
ORDER BY page_key, route_template NULLS FIRST`, session.ID)
	if err != nil {
		return nil, fmt.Errorf("session scopeを取得できません: %w", err)
	}
	defer scopeRows.Close()
	session.Scopes = make([]usecase.SessionScope, 0)
	for scopeRows.Next() {
		var value usecase.SessionScope
		if err := scopeRows.Scan(&value.PageKey, &value.RouteTemplate, &value.Reviewable); err != nil {
			return nil, fmt.Errorf("session scopeを読み取れません: %w", err)
		}
		session.Scopes = append(session.Scopes, value)
	}
	if err := scopeRows.Err(); err != nil {
		return nil, fmt.Errorf("session scopeの走査に失敗しました: %w", err)
	}

	perspectiveRows, err := d.Query(ctx, `SELECT code, label, status, guidance
FROM feedback.review_session_perspectives
WHERE session_id = $1::uuid
ORDER BY code`, session.ID)
	if err != nil {
		return nil, fmt.Errorf("session perspectiveを取得できません: %w", err)
	}
	defer perspectiveRows.Close()
	session.Perspectives = make([]usecase.SessionPerspective, 0)
	for perspectiveRows.Next() {
		var value usecase.SessionPerspective
		if err := perspectiveRows.Scan(&value.Code, &value.Label, &value.Status, &value.Guidance); err != nil {
			return nil, fmt.Errorf("session perspectiveを読み取れません: %w", err)
		}
		session.Perspectives = append(session.Perspectives, value)
	}
	if err := perspectiveRows.Err(); err != nil {
		return nil, fmt.Errorf("session perspectiveの走査に失敗しました: %w", err)
	}
	return &session, nil
}

func equalJSON(left, right []byte) (bool, error) {
	var leftValue, rightValue any
	if err := json.Unmarshal(left, &leftValue); err != nil {
		return false, err
	}
	if err := json.Unmarshal(right, &rightValue); err != nil {
		return false, err
	}
	return reflect.DeepEqual(leftValue, rightValue), nil
}

func cloneJSON(value []byte) json.RawMessage {
	return append(json.RawMessage(nil), value...)
}

func instantPointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := javaInstant(*value)
	return &formatted
}

// javaInstant matches java.time.Instant.toString: fractions are emitted in groups of 3 digits.
func javaInstant(value time.Time) string {
	value = value.UTC()
	base := value.Format("2006-01-02T15:04:05")
	nanoseconds := value.Nanosecond()
	if nanoseconds == 0 {
		return base + "Z"
	}
	digits := 9
	if nanoseconds%1_000_000 == 0 {
		digits = 3
	} else if nanoseconds%1_000 == 0 {
		digits = 6
	}
	fraction := fmt.Sprintf("%09d", nanoseconds)[:digits]
	return base + "." + fraction + "Z"
}
