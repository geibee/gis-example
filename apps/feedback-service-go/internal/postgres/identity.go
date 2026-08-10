package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

// ResolvePrincipal は検証済みissuer/subjectを既存userへ冪等に対応付ける。
func (d *Database) ResolvePrincipal(ctx context.Context, identity auth.Identity) (auth.Principal, error) {
	var userID string
	err := d.QueryRow(ctx, `INSERT INTO feedback.users (id, issuer, subject, email, display_name)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (issuer, subject) DO UPDATE SET
    email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    updated_at = now()
RETURNING id::text`,
		uuid.NewString(), identity.Issuer, identity.Subject, identity.Email, identity.DisplayName,
	).Scan(&userID)
	if err != nil {
		return auth.Principal{}, fmt.Errorf("principalを解決できません: %w", err)
	}
	return auth.Principal{
		UserID: userID, Issuer: identity.Issuer, Subject: identity.Subject,
		Email: identity.Email, DisplayName: identity.DisplayName, TokenScope: identity.TokenScope,
	}, nil
}

func (d *Database) ListMemberships(ctx context.Context, userID string) ([]auth.Membership, error) {
	rows, err := d.Query(ctx, `SELECT a.application_key, w.external_workspace_key, wm.permissions
FROM feedback.workspace_memberships wm
JOIN feedback.workspaces w ON w.id = wm.workspace_id
JOIN feedback.applications a ON a.id = w.application_id
WHERE wm.user_id = $1::uuid
ORDER BY a.application_key, w.external_workspace_key`, userID)
	if err != nil {
		return nil, fmt.Errorf("membershipを取得できません: %w", err)
	}
	defer rows.Close()

	result := make([]auth.Membership, 0)
	for rows.Next() {
		var applicationKey, workspaceKey string
		var values []string
		if err := rows.Scan(&applicationKey, &workspaceKey, &values); err != nil {
			return nil, fmt.Errorf("membershipを読み取れません: %w", err)
		}
		permissions, err := permissionsFromDatabase(values)
		if err != nil {
			return nil, err
		}
		result = append(result, auth.Membership{
			ApplicationKey: applicationKey, ExternalWorkspaceKey: workspaceKey, Permissions: permissions,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("membershipの走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) ApplicationPermissions(
	ctx context.Context,
	userID string,
	applicationID string,
) ([]auth.Permission, error) {
	return d.permissionQuery(
		ctx,
		`SELECT permissions FROM feedback.application_memberships WHERE user_id = $1::uuid AND application_id = $2::uuid`,
		userID,
		applicationID,
	)
}

func (d *Database) WorkspacePermissions(
	ctx context.Context,
	userID string,
	workspaceID string,
) ([]auth.Permission, error) {
	return d.permissionQuery(
		ctx,
		`SELECT permissions FROM feedback.workspace_memberships WHERE user_id = $1::uuid AND workspace_id = $2::uuid`,
		userID,
		workspaceID,
	)
}

func (d *Database) permissionQuery(ctx context.Context, sql, userID, resourceID string) ([]auth.Permission, error) {
	var values []string
	if err := d.QueryRow(ctx, sql, userID, resourceID).Scan(&values); err != nil {
		if err == pgx.ErrNoRows {
			return []auth.Permission{}, nil
		}
		return nil, fmt.Errorf("permissionを取得できません: %w", err)
	}
	return permissionsFromDatabase(values)
}

func permissionsFromDatabase(values []string) ([]auth.Permission, error) {
	result := make([]auth.Permission, 0, len(values))
	for _, value := range values {
		permission := auth.Permission(value)
		if !auth.IsValidPermission(permission) {
			return nil, fmt.Errorf("DBに不明なfeedback permissionがあります: %q", value)
		}
		result = append(result, permission)
	}
	return result, nil
}

func (d *Database) IsIssuerAllowed(
	ctx context.Context,
	scope auth.ResourceScope,
	issuer string,
	applicationOnly bool,
) (bool, error) {
	issuer = strings.TrimRight(issuer, "/")
	var allowed bool
	var err error
	if !applicationOnly && scope.EnvironmentID != "" {
		err = d.QueryRow(
			ctx,
			`SELECT $1 = ANY(allowed_issuers) FROM feedback.application_environments WHERE id = $2::uuid`,
			issuer,
			scope.EnvironmentID,
		).Scan(&allowed)
	} else {
		err = d.QueryRow(
			ctx,
			`SELECT coalesce(bool_or($1 = ANY(allowed_issuers)), false)
FROM feedback.application_environments WHERE application_id = $2::uuid`,
			issuer,
			scope.ApplicationID,
		).Scan(&allowed)
	}
	if err != nil {
		return false, fmt.Errorf("issuer allowlistを取得できません: %w", err)
	}
	return allowed, nil
}

// RecordDenial は401/403の応答前に拒否監査を永続化する。
func (d *Database) RecordDenial(ctx context.Context, event auth.DenialEvent) error {
	action := event.Action
	if event.Kind == auth.DenialAuthentication {
		action = "authenticate"
	}
	return d.RecordAudit(ctx, usecase.AuditEvent{
		Scope: event.Scope, PrincipalID: event.PrincipalID, Action: action,
		ResourceType: event.ResourceType, ResourceID: event.ResourceID,
		Outcome: "denied", RequestID: event.RequestID,
	})
}

func (d *Database) RecordAudit(ctx context.Context, event usecase.AuditEvent) error {
	var tenantID, applicationID, workspaceID any
	if event.Scope != nil {
		tenantID = nullableUUID(event.Scope.TenantID)
		applicationID = nullableUUID(event.Scope.ApplicationID)
		workspaceID = nullableUUID(event.Scope.WorkspaceID)
	}
	var changes any
	if len(event.Changes) != 0 {
		if !json.Valid(event.Changes) {
			return fmt.Errorf("audit changes JSONが不正です")
		}
		changes = string(event.Changes)
	}
	_, err := d.Exec(ctx, `INSERT INTO feedback.audit_logs (
    id, tenant_id, application_id, workspace_id, principal_id, action,
    resource_type, resource_id, outcome, request_id, changes
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
		uuid.NewString(), tenantID, applicationID, workspaceID,
		nullableText(event.PrincipalID), event.Action, nullableText(event.ResourceType), nullableText(event.ResourceID),
		event.Outcome, event.RequestID, changes,
	)
	if err != nil {
		return fmt.Errorf("audit logを記録できません: %w", err)
	}
	return nil
}

func nullableUUID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}
