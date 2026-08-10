package discussion

import "errors"

var (
	ErrInvalidInput       = errors.New("discussion入力が不正です")
	ErrNotFound           = errors.New("discussion resourceが見つかりません")
	ErrConflict           = errors.New("discussion resourceが競合しています")
	ErrVersionMismatch    = errors.New("discussion resource versionが一致しません")
	ErrForbidden          = errors.New("discussion操作が許可されていません")
	ErrRateLimited        = errors.New("discussion write rate limitを超えました")
	ErrPayloadTooLarge    = errors.New("discussion payloadが大きすぎます")
	ErrStorageUnavailable = errors.New("evidence storageを利用できません")
	ErrCommitUnknown      = errors.New("database commit結果を確認できません")
)

type Error struct {
	Kind              error
	Code              string
	Detail            string
	RetryAfterSeconds int
}

func (err *Error) Error() string {
	if err.Detail != "" {
		return err.Detail
	}
	if err.Code != "" {
		return err.Code
	}
	if err.Kind != nil {
		return err.Kind.Error()
	}
	return "discussion error"
}
func (err *Error) Unwrap() error { return err.Kind }

func invalid(code string, detail string) error {
	return &Error{Kind: ErrInvalidInput, Code: code, Detail: detail}
}
