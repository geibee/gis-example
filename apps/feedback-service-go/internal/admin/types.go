package admin

import (
	"context"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/usecase"
)

type Member struct {
	UserID      string            `json:"userId"`
	Issuer      string            `json:"issuer"`
	Subject     string            `json:"subject"`
	Email       *string           `json:"email"`
	DisplayName *string           `json:"displayName"`
	Permissions []auth.Permission `json:"permissions"`
	Version     int               `json:"version"`
}

type WorkspaceInput struct {
	ApplicationKey       string
	ExternalWorkspaceKey string
	RequestID            string
}

type MembershipCreate struct {
	Issuer      string
	Subject     string
	Permissions []auth.Permission
}

type CreateCommand struct {
	Workspace      WorkspaceInput
	Request        MembershipCreate
	IdempotencyKey string
	RequestHash    string
}

type MembershipPatch struct {
	Permissions []auth.Permission
}

type StoreMutation struct {
	Before   *Member
	After    Member
	Replayed bool
}

type MutationResult struct {
	Before   *Member
	After    *Member
	Scope    auth.ResourceScope
	Replayed bool
}

type Store interface {
	ResolveAdminWorkspaceScope(context.Context, string, string, string) (auth.ResourceScope, error)
	ListWorkspaceMembers(context.Context, auth.ResourceScope) ([]Member, error)
	CreateWorkspaceMember(context.Context, auth.ResourceScope, auth.Principal, CreateCommand) (StoreMutation, error)
	PatchWorkspaceMember(context.Context, auth.ResourceScope, string, int, MembershipPatch) (StoreMutation, error)
	DeleteWorkspaceMember(context.Context, auth.ResourceScope, string, int) (Member, error)
	RecordAudit(context.Context, usecase.AuditEvent) error
}

type Authorizer interface {
	Authorize(context.Context, auth.AuthorizationRequest) (auth.AuthorizedContext, error)
}
