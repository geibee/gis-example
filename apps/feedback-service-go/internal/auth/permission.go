package auth

import (
	"context"
	"fmt"
	"slices"
)

func IsValidPermission(permission Permission) bool {
	return slices.Contains(allPermissions[:], permission)
}

// Permissions は固定permission語彙のcopyを返す。
func Permissions() []Permission {
	return slices.Clone(allPermissions[:])
}

// Allows はKotlin版と同じ固定語彙の包含関係だけを評価する純粋関数である。
func Allows(granted []Permission, required Permission) bool {
	expanded := ExpandPermissions(granted)
	return slices.Contains(expanded, required)
}

// ExpandPermissions はpermissionを read < comment < manage < admin の順に展開する。
func ExpandPermissions(permissions []Permission) []Permission {
	level := 0
	for _, permission := range permissions {
		switch permission {
		case PermissionRead:
			level = max(level, 1)
		case PermissionComment:
			level = max(level, 2)
		case PermissionManage:
			level = max(level, 3)
		case PermissionAdmin:
			level = max(level, 4)
		}
	}
	return slices.Clone(allPermissions[:level])
}

// ParsePermissions はexchange claimの固定語彙を検証し、重複を除いた順序へ正規化する。
func ParsePermissions(values []string) ([]Permission, error) {
	seen := make(map[Permission]struct{}, len(values))
	for _, value := range values {
		permission := Permission(value)
		if !IsValidPermission(permission) {
			return nil, fmt.Errorf("%w: %q", ErrInvalidPermission, value)
		}
		seen[permission] = struct{}{}
	}
	if len(seen) == 0 {
		return nil, ErrInvalidPermission
	}
	result := make([]Permission, 0, len(seen))
	for _, permission := range allPermissions {
		if _, ok := seen[permission]; ok {
			result = append(result, permission)
		}
	}
	return result, nil
}

// IntersectPermissions はDB permissionをtoken permissionで必ず狭める。
func IntersectPermissions(databasePermissions, tokenPermissions []Permission) []Permission {
	database := ExpandPermissions(databasePermissions)
	token := ExpandPermissions(tokenPermissions)
	result := make([]Permission, 0, len(allPermissions))
	for _, permission := range allPermissions {
		if slices.Contains(database, permission) && slices.Contains(token, permission) {
			result = append(result, permission)
		}
	}
	return result
}

func (token TokenScope) Matches(scope ResourceScope, applicationOnly bool) bool {
	if token.TenantKey != scope.TenantKey || token.ApplicationKey != scope.ApplicationKey {
		return false
	}
	if applicationOnly {
		return true
	}
	return token.ExternalWorkspaceKey == scope.ExternalWorkspaceKey &&
		(scope.EnvironmentKey == "" || token.EnvironmentKey == scope.EnvironmentKey)
}

// RestrictMemberships は/meのmembershipをexchange token scopeとpermissionで狭める。
func RestrictMemberships(principal Principal, memberships []Membership) []Membership {
	if principal.TokenScope == nil {
		return cloneMemberships(memberships)
	}
	token := principal.TokenScope
	result := make([]Membership, 0, len(memberships))
	for _, membership := range memberships {
		if membership.ApplicationKey != token.ApplicationKey || membership.ExternalWorkspaceKey != token.ExternalWorkspaceKey {
			continue
		}
		permissions := IntersectPermissions(membership.Permissions, token.Permissions)
		slices.Sort(permissions)
		result = append(result, Membership{
			ApplicationKey:       membership.ApplicationKey,
			ExternalWorkspaceKey: membership.ExternalWorkspaceKey,
			Permissions:          permissions,
		})
	}
	return result
}

type Authorizer struct {
	store   AuthorizationStore
	auditor DenialAuditor
}

func NewAuthorizer(store AuthorizationStore, auditor DenialAuditor) (*Authorizer, error) {
	if store == nil {
		return nil, fmt.Errorf("authorization storeが未設定です")
	}
	if auditor == nil {
		return nil, fmt.Errorf("denial auditorが未設定です")
	}
	return &Authorizer{store: store, auditor: auditor}, nil
}

// Authorize はDB、issuer、token scopeをすべて満たす場合だけ許可する。
// 拒否監査に失敗した場合は拒否応答を返さず、上位層へ監査障害を返す。
func (authorizer *Authorizer) Authorize(ctx context.Context, request AuthorizationRequest) (AuthorizedContext, error) {
	var (
		databasePermissions []Permission
		err                 error
	)
	if request.ApplicationOnly {
		databasePermissions, err = authorizer.store.ApplicationPermissions(
			ctx,
			request.Principal.UserID,
			request.Scope.ApplicationID,
		)
	} else {
		if request.Scope.WorkspaceID == "" {
			return AuthorizedContext{}, fmt.Errorf("workspace scopeにworkspace IDがありません")
		}
		databasePermissions, err = authorizer.store.WorkspacePermissions(
			ctx,
			request.Principal.UserID,
			request.Scope.WorkspaceID,
		)
	}
	if err != nil {
		return AuthorizedContext{}, fmt.Errorf("permissionの取得に失敗しました: %w", err)
	}
	issuerAllowed, err := authorizer.store.IsIssuerAllowed(
		ctx,
		request.Scope,
		request.Principal.Issuer,
		request.ApplicationOnly,
	)
	if err != nil {
		return AuthorizedContext{}, fmt.Errorf("issuer allowlistの取得に失敗しました: %w", err)
	}

	effectivePermissions := ExpandPermissions(databasePermissions)
	tokenScopeMatches := true
	if request.Principal.TokenScope != nil {
		tokenScopeMatches = request.Principal.TokenScope.Matches(request.Scope, request.ApplicationOnly)
		effectivePermissions = IntersectPermissions(databasePermissions, request.Principal.TokenScope.Permissions)
	}
	allowed := issuerAllowed && tokenScopeMatches && slices.Contains(effectivePermissions, request.Required)
	if !allowed {
		resourceType := "workspace"
		resourceID := request.Scope.WorkspaceID
		if request.ApplicationOnly {
			resourceType = "application"
			resourceID = request.Scope.ApplicationID
		}
		auditScope := request.Scope
		if err := authorizer.auditor.RecordDenial(ctx, DenialEvent{
			Kind:         DenialAuthorization,
			RequestID:    request.RequestID,
			PrincipalID:  request.Principal.Subject,
			Action:       string(request.Required),
			ResourceType: resourceType,
			ResourceID:   resourceID,
			Scope:        &auditScope,
			ReasonCode:   "permission.denied",
		}); err != nil {
			return AuthorizedContext{}, &AuditUnavailableError{Err: err}
		}
		return AuthorizedContext{}, &AuthorizationError{HideExistence: request.HideExistence}
	}

	return AuthorizedContext{
		Principal:   request.Principal,
		Scope:       request.Scope,
		Permissions: effectivePermissions,
	}, nil
}

func cloneMemberships(memberships []Membership) []Membership {
	result := make([]Membership, len(memberships))
	for index, membership := range memberships {
		result[index] = membership
		result[index].Permissions = slices.Clone(membership.Permissions)
	}
	return result
}
