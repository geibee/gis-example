// Package auth はJWT検証とFeedback permission判定を提供する。
package auth

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrInvalidToken      = errors.New("JWTが不正です")
	ErrJWKSUnavailable   = errors.New("JWKSを利用できません")
	ErrPermissionDenied  = errors.New("feedback permissionが不足しています")
	ErrAuditUnavailable  = errors.New("拒否監査を記録できません")
	ErrInvalidPermission = errors.New("feedback permissionが不正です")
)

type Permission string

const (
	PermissionRead    Permission = "feedback.read"
	PermissionComment Permission = "feedback.comment"
	PermissionManage  Permission = "feedback.manage"
	PermissionAdmin   Permission = "feedback.admin"
)

var allPermissions = [...]Permission{
	PermissionRead,
	PermissionComment,
	PermissionManage,
	PermissionAdmin,
}

type TokenScope struct {
	TenantKey            string
	ApplicationKey       string
	EnvironmentKey       string
	ExternalWorkspaceKey string
	Permissions          []Permission
}

type Identity struct {
	Issuer      string
	Subject     string
	Email       *string
	DisplayName *string
	TokenScope  *TokenScope
}

type Principal struct {
	UserID      string
	Issuer      string
	Subject     string
	Email       *string
	DisplayName *string
	TokenScope  *TokenScope
}

// PrincipalResolver は検証済みidentityを永続principalへ解決する最小portである。
// 実装はpostgres packageが担い、auth packageはDBを直接参照しない。
type PrincipalResolver interface {
	ResolvePrincipal(context.Context, Identity) (Principal, error)
}

type ResourceScope struct {
	TenantID             string
	TenantKey            string
	ApplicationID        string
	EnvironmentID        string
	WorkspaceID          string
	ApplicationKey       string
	EnvironmentKey       string
	ExternalWorkspaceKey string
}

type Membership struct {
	ApplicationKey       string
	ExternalWorkspaceKey string
	Permissions          []Permission
}

// AuthorizationStore はpermissionとissuer allowlistだけを問い合わせる最小portである。
type AuthorizationStore interface {
	ApplicationPermissions(context.Context, string, string) ([]Permission, error)
	WorkspacePermissions(context.Context, string, string) ([]Permission, error)
	IsIssuerAllowed(context.Context, ResourceScope, string, bool) (bool, error)
}

type DenialKind string

const (
	DenialAuthentication DenialKind = "authentication"
	DenialAuthorization  DenialKind = "authorization"
)

type DenialEvent struct {
	Kind         DenialKind
	RequestID    string
	PrincipalID  string
	Action       string
	ResourceType string
	ResourceID   string
	Scope        *ResourceScope
	ReasonCode   string
}

// DenialAuditor は401/403相当の応答より先に監査を永続化するportである。
type DenialAuditor interface {
	RecordDenial(context.Context, DenialEvent) error
}

type AuthorizationRequest struct {
	Principal       Principal
	Scope           ResourceScope
	Required        Permission
	ApplicationOnly bool
	HideExistence   bool
	RequestID       string
}

type AuthorizedContext struct {
	Principal   Principal
	Scope       ResourceScope
	Permissions []Permission
}

type AuthorizationError struct {
	HideExistence bool
}

func (err *AuthorizationError) Error() string {
	if err.HideExistence {
		return "対象resourceが見つかりません"
	}
	return ErrPermissionDenied.Error()
}

func (err *AuthorizationError) Unwrap() error {
	return ErrPermissionDenied
}

type JWKSUnavailableError struct {
	URL string
	Err error
}

func (err *JWKSUnavailableError) Error() string {
	if err.URL == "" {
		return ErrJWKSUnavailable.Error()
	}
	return fmt.Sprintf("%s: %s", ErrJWKSUnavailable, err.URL)
}

func (err *JWKSUnavailableError) Unwrap() error {
	if err.Err == nil {
		return ErrJWKSUnavailable
	}
	return errors.Join(ErrJWKSUnavailable, err.Err)
}

type AuditUnavailableError struct {
	Err error
}

func (err *AuditUnavailableError) Error() string {
	return ErrAuditUnavailable.Error()
}

func (err *AuditUnavailableError) Unwrap() error {
	if err.Err == nil {
		return ErrAuditUnavailable
	}
	return errors.Join(ErrAuditUnavailable, err.Err)
}
