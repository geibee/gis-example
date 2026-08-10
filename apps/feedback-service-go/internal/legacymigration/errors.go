// Package legacymigration はlegacy Feedback snapshotのcopy/reconcile/rollback境界を提供する。
package legacymigration

import "errors"

var (
	ErrInvalidInput       = errors.New("legacy migration入力が不正です")
	ErrConflict           = errors.New("legacy migration対象が競合しています")
	ErrSchemaMismatch     = errors.New("legacy migration schemaが一致しません")
	ErrCommitUnknown      = errors.New("legacy migration commit結果を確認できません")
	ErrStorageUnavailable = errors.New("legacy migration storageを利用できません")
)

type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string { return err.Detail }
func (err *Error) Unwrap() error { return err.Kind }

func migrationError(kind error, code string, detail string) error {
	return &Error{Kind: kind, Code: code, Detail: detail}
}
