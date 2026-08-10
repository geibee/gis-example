package postgres

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

var identifierPattern = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// IdentifierPolicy は動的SQLで利用可能な識別子を明示的に制限する。
// 識別子はallowlist検査後も必ずPostgreSQL形式でquoteする。
type IdentifierPolicy struct {
	allowed map[string]struct{}
}

// NewIdentifierPolicy はコード側で定義した識別子allowlistを生成する。
func NewIdentifierPolicy(identifiers ...string) (IdentifierPolicy, error) {
	if len(identifiers) == 0 {
		return IdentifierPolicy{}, errors.New("identifier allowlistは1件以上必要です")
	}
	allowed := make(map[string]struct{}, len(identifiers))
	for _, identifier := range identifiers {
		if !identifierPattern.MatchString(identifier) {
			return IdentifierPolicy{}, fmt.Errorf("identifier allowlistに不正な値があります: %q", identifier)
		}
		allowed[identifier] = struct{}{}
	}
	return IdentifierPolicy{allowed: allowed}, nil
}

func (p IdentifierPolicy) quote(identifier string) (string, error) {
	if _, ok := p.allowed[identifier]; !ok {
		return "", fmt.Errorf("SQL identifierはallowlistにありません: %q", identifier)
	}
	return pgx.Identifier{identifier}.Sanitize(), nil
}

// ClaimQuery はlease期限切れを再取得できる1件claim SELECTを表す。
// 取得後の状態更新は、呼出側が同じtransaction内で実行する。
type ClaimQuery struct {
	Schema            string
	Table             string
	IDColumn          string
	StatusColumn      string
	AvailableAtColumn string
	ClaimedAtColumn   string
	OrderColumns      []string
	ReadyStatus       string
	ClaimedStatus     string
	LeaseTimeout      time.Duration
}

// Build は FOR UPDATE SKIP LOCKED を用いたclaim SQLとbind値を返す。
// table/column名はbindできないため、allowlistとquoteの両方を必須とする。
func (q ClaimQuery) Build(policy IdentifierPolicy) (string, []any, error) {
	if q.ReadyStatus == "" || q.ClaimedStatus == "" {
		return "", nil, errors.New("claim statusが未設定です")
	}
	if q.ReadyStatus == q.ClaimedStatus {
		return "", nil, errors.New("claim前後のstatusは異なる値で指定してください")
	}
	if q.LeaseTimeout <= 0 || q.LeaseTimeout%time.Millisecond != 0 {
		return "", nil, errors.New("lease timeoutは1ms単位の正の値で指定してください")
	}
	if len(q.OrderColumns) == 0 {
		return "", nil, errors.New("claimのorder columnは1件以上必要です")
	}

	schema, err := policy.quote(q.Schema)
	if err != nil {
		return "", nil, err
	}
	table, err := policy.quote(q.Table)
	if err != nil {
		return "", nil, err
	}
	id, err := policy.quote(q.IDColumn)
	if err != nil {
		return "", nil, err
	}
	status, err := policy.quote(q.StatusColumn)
	if err != nil {
		return "", nil, err
	}
	availableAt, err := policy.quote(q.AvailableAtColumn)
	if err != nil {
		return "", nil, err
	}
	claimedAt, err := policy.quote(q.ClaimedAtColumn)
	if err != nil {
		return "", nil, err
	}

	order := make([]string, 0, len(q.OrderColumns))
	idIncluded := false
	for _, column := range q.OrderColumns {
		quoted, quoteErr := policy.quote(column)
		if quoteErr != nil {
			return "", nil, quoteErr
		}
		if column == q.IDColumn {
			idIncluded = true
		}
		order = append(order, "candidate."+quoted)
	}
	if !idIncluded {
		// 同じ時刻のjobでも取得順が安定するよう、主キーを必ずtie-breakerにする。
		order = append(order, "candidate."+id)
	}

	sql := fmt.Sprintf(`SELECT candidate.*
FROM %s.%s AS candidate
WHERE ((candidate.%s = $1 AND candidate.%s <= now())
    OR (candidate.%s = $2
        AND candidate.%s < now() - ($3::bigint * interval '1 millisecond')))
ORDER BY %s
FOR UPDATE OF candidate SKIP LOCKED
LIMIT 1`, schema, table, status, availableAt, status, claimedAt, strings.Join(order, ", "))

	return sql, []any{q.ReadyStatus, q.ClaimedStatus, q.LeaseTimeout.Milliseconds()}, nil
}
