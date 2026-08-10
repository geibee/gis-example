// Package evidence はprivate evidenceの検証、保存、取得、回復境界を提供する。
package evidence

import "errors"

var (
	ErrInvalidInput        = errors.New("evidence入力が不正です")
	ErrTooLarge            = errors.New("evidenceが大きすぎます")
	ErrQuotaExceeded       = errors.New("evidence quotaを超えました")
	ErrNotFound            = errors.New("evidenceが見つかりません")
	ErrRangeNotSatisfiable = errors.New("evidence rangeが不正です")
	ErrStorageUnavailable  = errors.New("evidence storageを利用できません")
	ErrIntegrity           = errors.New("evidenceの整合性を確認できません")
)

// Error はHTTP層がerrors.Asで安定したcode/detailを取得できるdomain errorである。
type Error struct {
	Kind   error
	Code   string
	Detail string
}

func (err *Error) Error() string {
	if err.Detail != "" {
		return err.Detail
	}
	return err.Code
}

func (err *Error) Unwrap() error { return err.Kind }

func domainError(kind error, code string, detail string) error {
	return &Error{Kind: kind, Code: code, Detail: detail}
}

func invalid(detail string) error {
	return domainError(ErrInvalidInput, "request.invalid", detail)
}

func tooLarge(_ int64) error {
	return domainError(
		ErrTooLarge,
		"evidence.too_large",
		"evidence が上限を超えています",
	)
}
