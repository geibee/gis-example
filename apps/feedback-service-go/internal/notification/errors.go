// Package notification は通知設定・配信管理とworker orchestrationを提供する。
package notification

import "fmt"

type ErrorKind string

const (
	ErrorBadRequest         ErrorKind = "bad_request"
	ErrorNotFound           ErrorKind = "not_found"
	ErrorConflict           ErrorKind = "conflict"
	ErrorPreconditionFailed ErrorKind = "precondition_failed"
)

type Error struct {
	Kind   ErrorKind
	Code   string
	Detail string
	Err    error
}

func (e *Error) Error() string {
	if e.Detail != "" {
		return e.Detail
	}
	return fmt.Sprintf("notification error: %s", e.Code)
}

func (e *Error) Unwrap() error { return e.Err }

func domainError(kind ErrorKind, code, detail string) error {
	return &Error{Kind: kind, Code: code, Detail: detail}
}
