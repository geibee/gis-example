// Package session はreview session v1のapplication logicと永続化portを提供する。
package session

import (
	"errors"
)

const (
	StatusDraft  = "draft"
	StatusOpen   = "open"
	StatusClosed = "closed"

	OutOfScopeAllow = "allow"
	OutOfScopeWarn  = "warn"
	OutOfScopeDeny  = "deny"

	PerspectiveActive     = "active"
	PerspectiveFuture     = "future"
	PerspectiveOutOfScope = "out-of-scope"

	ResourceKindSession = "session"
	ResourceKindThread  = "thread"
	ResourceKindMessage = "message"
	ResourceKindExport  = "export"
	ResourceKindBackup  = "backup"
)

var ErrInvalid = errors.New("session requestが不正です")

type ValidationError struct {
	Code   string
	Detail string
}

func (err *ValidationError) Error() string { return err.Detail }
func (err *ValidationError) Unwrap() error { return ErrInvalid }

type Scope struct {
	PageKey          string   `json:"pageKey"`
	RouteTemplate    *string  `json:"routeTemplate"`
	Reviewable       bool     `json:"reviewable"`
	PerspectiveCodes []string `json:"perspectiveCodes"`
}

type Perspective struct {
	Code     string  `json:"code"`
	Label    string  `json:"label"`
	Status   string  `json:"status"`
	Guidance *string `json:"guidance"`
}

type Session struct {
	ID                   string        `json:"id"`
	ApplicationKey       string        `json:"applicationKey"`
	EnvironmentKey       string        `json:"environmentKey"`
	ExternalWorkspaceKey string        `json:"externalWorkspaceKey"`
	ManifestVersion      string        `json:"manifestVersion"`
	Title                string        `json:"title"`
	Description          *string       `json:"description"`
	Status               string        `json:"status"`
	OutOfScopePosting    string        `json:"outOfScopePosting"`
	StartAt              *string       `json:"startAt"`
	EndAt                *string       `json:"endAt"`
	Scopes               []Scope       `json:"scopes"`
	Perspectives         []Perspective `json:"perspectives"`
	CreatedAt            string        `json:"createdAt"`
	UpdatedAt            string        `json:"updatedAt"`
	Version              int           `json:"version"`
}

type Page struct {
	Items      []Session `json:"items"`
	NextCursor *string   `json:"nextCursor"`
	TotalCount int64     `json:"totalCount"`
}

type CreateRequest struct {
	ApplicationKey       string        `json:"applicationKey"`
	EnvironmentKey       string        `json:"environmentKey"`
	ExternalWorkspaceKey string        `json:"externalWorkspaceKey"`
	ManifestVersion      string        `json:"manifestVersion"`
	Title                string        `json:"title"`
	Description          *string       `json:"description"`
	Status               string        `json:"status"`
	OutOfScopePosting    string        `json:"outOfScopePosting"`
	StartAt              *string       `json:"startAt"`
	EndAt                *string       `json:"endAt"`
	Scopes               []Scope       `json:"scopes"`
	Perspectives         []Perspective `json:"perspectives"`
}

type CreateCommand struct {
	Request        CreateRequest
	IdempotencyKey string
	RequestHash    string
}

// OptionalString はmerge-patchの未指定と明示nullを区別する。
type OptionalString struct {
	Present bool
	Value   *string
}

type Patch struct {
	ExpectedVersion   int
	Title             *string
	Description       OptionalString
	Status            *string
	OutOfScopePosting *string
	StartAt           OptionalString
	EndAt             OptionalString
	Scopes            *[]Scope
	Perspectives      *[]Perspective
}

func (patch Patch) Empty() bool {
	return patch.Title == nil && !patch.Description.Present && patch.Status == nil &&
		patch.OutOfScopePosting == nil && !patch.StartAt.Present && !patch.EndAt.Present &&
		patch.Scopes == nil && patch.Perspectives == nil
}
