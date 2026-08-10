package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/admin"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

const membershipCreateEndpoint = "POST /memberships"

func (d *Database) ResolveAdminWorkspaceScope(
	ctx context.Context,
	userID string,
	applicationKey string,
	externalWorkspaceKey string,
) (auth.ResourceScope, error) {
	rows, err := d.Query(ctx, `SELECT tenant.id::text, tenant.tenant_key, application.id::text,
       workspace.id::text, application.application_key, workspace.external_workspace_key
FROM feedback.workspace_memberships membership
JOIN feedback.workspaces workspace ON workspace.id = membership.workspace_id
JOIN feedback.applications application ON application.id = workspace.application_id
JOIN feedback.tenants tenant ON tenant.id = application.tenant_id
WHERE membership.user_id = $1::uuid
  AND application.application_key = $2
  AND workspace.external_workspace_key = $3`, userID, applicationKey, externalWorkspaceKey)
	if err != nil {
		return auth.ResourceScope{}, fmt.Errorf("admin workspace scopeを取得できません: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return auth.ResourceScope{}, fmt.Errorf("admin workspace scopeを取得できません: %w", err)
		}
		return auth.ResourceScope{}, &admin.Error{
			Kind: admin.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません",
		}
	}
	var scope auth.ResourceScope
	if err := rows.Scan(
		&scope.TenantID, &scope.TenantKey, &scope.ApplicationID, &scope.WorkspaceID,
		&scope.ApplicationKey, &scope.ExternalWorkspaceKey,
	); err != nil {
		return auth.ResourceScope{}, fmt.Errorf("admin workspace scopeを読み取れません: %w", err)
	}
	if rows.Next() {
		return auth.ResourceScope{}, &admin.Error{
			Kind: admin.ErrConflict, Code: "workspace.ambiguous", Detail: "workspace keyが複数tenantで曖昧です",
		}
	}
	if err := rows.Err(); err != nil {
		return auth.ResourceScope{}, fmt.Errorf("admin workspace scopeを取得できません: %w", err)
	}
	return scope, nil
}

func (d *Database) ListWorkspaceMembers(ctx context.Context, scope auth.ResourceScope) ([]admin.Member, error) {
	rows, err := d.Query(ctx, `SELECT users.id::text, users.issuer, users.subject, users.email,
       users.display_name, membership.permissions, membership.version
FROM feedback.workspace_memberships membership
JOIN feedback.users users ON users.id = membership.user_id
WHERE membership.workspace_id = $1::uuid
ORDER BY coalesce(users.display_name, users.subject), users.id`, scope.WorkspaceID)
	if err != nil {
		return nil, fmt.Errorf("workspace membership一覧を取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]admin.Member, 0)
	for rows.Next() {
		member, err := scanWorkspaceMember(rows)
		if err != nil {
			return nil, fmt.Errorf("workspace membershipを読み取れません: %w", err)
		}
		result = append(result, member)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("workspace membership一覧の走査に失敗しました: %w", err)
	}
	return result, nil
}

func (d *Database) CreateWorkspaceMember(
	ctx context.Context,
	scope auth.ResourceScope,
	principal auth.Principal,
	command admin.CreateCommand,
) (admin.StoreMutation, error) {
	var mutation admin.StoreMutation
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		lockValue := idempotencyLockValue(principal.Subject, membershipCreateEndpoint, command.IdempotencyKey)
		if _, err := tx.Exec(txCtx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockValue); err != nil {
			return fmt.Errorf("membership idempotency lockを取得できません: %w", err)
		}
		var existingHash string
		var existingBody []byte
		err := tx.QueryRow(txCtx, `SELECT request_hash, response_body
FROM feedback.idempotency_records
WHERE tenant_id = $1::uuid AND principal_id = $2 AND endpoint = $3 AND idempotency_key = $4
  AND expires_at > now()`, scope.TenantID, principal.Subject, membershipCreateEndpoint, command.IdempotencyKey).Scan(
			&existingHash, &existingBody,
		)
		if err == nil {
			if existingHash != command.RequestHash {
				return &admin.Error{
					Kind: admin.ErrConflict, Code: "idempotency.mismatch",
					Detail: "同じIdempotency-Keyが異なるrequestに使われました",
				}
			}
			if err := json.Unmarshal(existingBody, &mutation.After); err != nil {
				return fmt.Errorf("membership idempotency responseを復元できません: %w", err)
			}
			mutation.Replayed = true
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("membership idempotency recordを取得できません: %w", err)
		}

		var userID string
		if err := tx.QueryRow(txCtx, `SELECT id::text FROM feedback.users WHERE issuer = $1 AND subject = $2`,
			command.Request.Issuer, command.Request.Subject,
		).Scan(&userID); errors.Is(err, pgx.ErrNoRows) {
			return &admin.Error{
				Kind: admin.ErrNotFound, Code: "resource.not_found",
				Detail: "指定したOIDC主体はまだFeedback Serviceへ登録されていません",
			}
		} else if err != nil {
			return fmt.Errorf("membership対象userを取得できません: %w", err)
		}
		permissions := permissionStrings(command.Request.Permissions)
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.workspace_memberships (workspace_id, user_id, permissions)
VALUES ($1::uuid, $2::uuid, $3::text[])`, scope.WorkspaceID, userID, permissions)
		if uniqueViolation(err) {
			return &admin.Error{Kind: admin.ErrConflict, Code: "membership.exists", Detail: "membershipは既に存在します"}
		}
		if err != nil {
			return fmt.Errorf("workspace membershipを登録できません: %w", err)
		}
		mutation.After, err = readWorkspaceMember(txCtx, tx, scope.WorkspaceID, userID, false)
		if err != nil {
			return err
		}
		body, err := json.Marshal(mutation.After)
		if err != nil {
			return fmt.Errorf("membership idempotency responseを生成できません: %w", err)
		}
		_, err = tx.Exec(txCtx, `INSERT INTO feedback.idempotency_records (
    tenant_id, principal_id, endpoint, idempotency_key, request_hash,
    response_status, response_body, expires_at
) VALUES ($1::uuid, $2, $3, $4, $5, 201, $6::jsonb, now() + interval '24 hours')`,
			scope.TenantID, principal.Subject, membershipCreateEndpoint, command.IdempotencyKey,
			command.RequestHash, string(body),
		)
		if err != nil {
			return fmt.Errorf("membership idempotency responseを登録できません: %w", err)
		}
		return nil
	})
	if err != nil {
		return admin.StoreMutation{}, err
	}
	return mutation, nil
}

func (d *Database) PatchWorkspaceMember(
	ctx context.Context,
	scope auth.ResourceScope,
	userID string,
	expectedVersion int,
	patch admin.MembershipPatch,
) (admin.StoreMutation, error) {
	var mutation admin.StoreMutation
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		before, err := readWorkspaceMember(txCtx, tx, scope.WorkspaceID, userID, true)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && before.Version != expectedVersion) {
			return &admin.Error{
				Kind: admin.ErrVersionMismatch, Code: "resource.version_mismatch", Detail: "ETagが現在の版と一致しません",
			}
		}
		if err != nil {
			return err
		}
		mutation.Before = &before
		_, err = tx.Exec(txCtx, `UPDATE feedback.workspace_memberships
SET permissions = $1::text[], version = version + 1, updated_at = now()
WHERE workspace_id = $2::uuid AND user_id = $3::uuid AND version = $4`,
			permissionStrings(patch.Permissions), scope.WorkspaceID, userID, expectedVersion,
		)
		if err != nil {
			return fmt.Errorf("workspace membershipを更新できません: %w", err)
		}
		mutation.After, err = readWorkspaceMember(txCtx, tx, scope.WorkspaceID, userID, false)
		return err
	})
	if err != nil {
		return admin.StoreMutation{}, err
	}
	return mutation, nil
}

func (d *Database) DeleteWorkspaceMember(
	ctx context.Context,
	scope auth.ResourceScope,
	userID string,
	expectedVersion int,
) (admin.Member, error) {
	var before admin.Member
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		var err error
		before, err = readWorkspaceMember(txCtx, tx, scope.WorkspaceID, userID, true)
		if errors.Is(err, pgx.ErrNoRows) {
			return &admin.Error{Kind: admin.ErrNotFound, Code: "resource.not_found", Detail: "リソースが見つかりません"}
		}
		if err != nil {
			return err
		}
		if slices.Contains(before.Permissions, auth.PermissionAdmin) {
			var otherAdmins int64
			if err := tx.QueryRow(txCtx, `SELECT count(*) FROM feedback.workspace_memberships
WHERE workspace_id = $1::uuid AND user_id <> $2::uuid
  AND permissions @> ARRAY['feedback.admin']::text[]`, scope.WorkspaceID, userID).Scan(&otherAdmins); err != nil {
				return fmt.Errorf("workspace admin件数を取得できません: %w", err)
			}
			if otherAdmins == 0 {
				return &admin.Error{
					Kind: admin.ErrConflict, Code: "membership.last_admin",
					Detail: "workspace最後のadminは削除できません",
				}
			}
		}
		tag, err := tx.Exec(txCtx, `DELETE FROM feedback.workspace_memberships
WHERE workspace_id = $1::uuid AND user_id = $2::uuid AND version = $3`,
			scope.WorkspaceID, userID, expectedVersion,
		)
		if err != nil {
			return fmt.Errorf("workspace membershipを削除できません: %w", err)
		}
		if tag.RowsAffected() != 1 {
			return &admin.Error{
				Kind: admin.ErrVersionMismatch, Code: "resource.version_mismatch", Detail: "ETagが現在の版と一致しません",
			}
		}
		return nil
	})
	if err != nil {
		return admin.Member{}, err
	}
	return before, nil
}

type membershipScanner interface {
	Scan(...any) error
}

func scanWorkspaceMember(scanner membershipScanner) (admin.Member, error) {
	var member admin.Member
	var permissions []string
	if err := scanner.Scan(
		&member.UserID, &member.Issuer, &member.Subject, &member.Email,
		&member.DisplayName, &permissions, &member.Version,
	); err != nil {
		return admin.Member{}, err
	}
	member.Permissions = make([]auth.Permission, len(permissions))
	for index, permission := range permissions {
		parsed := auth.Permission(permission)
		if !auth.IsValidPermission(parsed) {
			return admin.Member{}, fmt.Errorf("DBに不明なfeedback permissionがあります: %q", permission)
		}
		member.Permissions[index] = parsed
	}
	slices.Sort(member.Permissions)
	return member, nil
}

func readWorkspaceMember(
	ctx context.Context,
	querier membershipQueryer,
	workspaceID string,
	userID string,
	forUpdate bool,
) (admin.Member, error) {
	locking := ""
	if forUpdate {
		locking = " FOR UPDATE OF membership"
	}
	member, err := scanWorkspaceMember(querier.QueryRow(ctx, `SELECT users.id::text, users.issuer, users.subject,
       users.email, users.display_name, membership.permissions, membership.version
FROM feedback.workspace_memberships membership
JOIN feedback.users users ON users.id = membership.user_id
WHERE membership.workspace_id = $1::uuid AND membership.user_id = $2::uuid`+locking, workspaceID, userID))
	if err != nil {
		return admin.Member{}, err
	}
	return member, nil
}

type membershipQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func permissionStrings(values []auth.Permission) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = string(value)
	}
	return result
}

var _ admin.Store = (*Database)(nil)
