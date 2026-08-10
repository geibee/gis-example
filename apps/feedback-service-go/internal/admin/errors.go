// Package admin はworkspace administrationの業務境界を提供する。
package admin

import "errors"

var (
	ErrInvalidInput    = errors.New("administration入力が不正です")
	ErrNotFound        = errors.New("administration resourceが見つかりません")
	ErrConflict        = errors.New("administration resourceが競合しています")
	ErrVersionMismatch = errors.New("administration resource versionが一致しません")
)

type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string { return err.Detail }
func (err *Error) Unwrap() error { return err.Kind }

func invalid(detail string) error {
	return &Error{Kind: ErrInvalidInput, Code: "request.invalid", Detail: detail}
}
