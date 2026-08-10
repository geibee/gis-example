package postgres

import (
	"strings"
	"testing"
	"time"
)

func TestClaimQueryBuild(t *testing.T) {
	t.Parallel()

	policy, err := NewIdentifierPolicy(
		"feedback", "notification_outbox", "id", "status", "available_at", "claimed_at", "created_at",
	)
	if err != nil {
		t.Fatalf("NewIdentifierPolicy() error = %v", err)
	}
	sql, args, err := (ClaimQuery{
		Schema:            "feedback",
		Table:             "notification_outbox",
		IDColumn:          "id",
		StatusColumn:      "status",
		AvailableAtColumn: "available_at",
		ClaimedAtColumn:   "claimed_at",
		OrderColumns:      []string{"created_at", "id"},
		ReadyStatus:       "pending",
		ClaimedStatus:     "processing",
		LeaseTimeout:      2 * time.Minute,
	}).Build(policy)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	for _, fragment := range []string{
		`FROM "feedback"."notification_outbox" AS candidate`,
		`candidate."status" = $1`,
		`candidate."status" = $2`,
		`FOR UPDATE OF candidate SKIP LOCKED`,
		`ORDER BY candidate."created_at", candidate."id"`,
		`LIMIT 1`,
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("SQLに%qがありません:\n%s", fragment, sql)
		}
	}
	if len(args) != 3 || args[0] != "pending" || args[1] != "processing" || args[2] != int64(120000) {
		t.Fatalf("args = %#v", args)
	}
}

func TestIdentifierPolicyRejectsInjectionAndNonAllowlistedValues(t *testing.T) {
	t.Parallel()

	if _, err := NewIdentifierPolicy("feedback; DROP SCHEMA feedback"); err == nil {
		t.Fatal("SQL injection文字列がallowlistへ登録されました")
	}
	policy, err := NewIdentifierPolicy("feedback", "jobs", "id", "status", "available_at", "claimed_at")
	if err != nil {
		t.Fatalf("NewIdentifierPolicy() error = %v", err)
	}
	_, _, err = (ClaimQuery{
		Schema:            "feedback",
		Table:             "jobs; DELETE FROM feedback.users",
		IDColumn:          "id",
		StatusColumn:      "status",
		AvailableAtColumn: "available_at",
		ClaimedAtColumn:   "claimed_at",
		OrderColumns:      []string{"id"},
		ReadyStatus:       "queued",
		ClaimedStatus:     "running",
		LeaseTimeout:      time.Minute,
	}).Build(policy)
	if err == nil {
		t.Fatal("allowlist外のtableが受理されました")
	}
}

func TestClaimQueryRejectsIncompleteLease(t *testing.T) {
	t.Parallel()

	policy, err := NewIdentifierPolicy("feedback", "jobs", "id", "status", "available_at", "claimed_at")
	if err != nil {
		t.Fatalf("NewIdentifierPolicy() error = %v", err)
	}
	tests := []ClaimQuery{
		{ReadyStatus: "", ClaimedStatus: "running", LeaseTimeout: time.Minute, OrderColumns: []string{"id"}},
		{ReadyStatus: "queued", ClaimedStatus: "running", LeaseTimeout: 0, OrderColumns: []string{"id"}},
		{ReadyStatus: "queued", ClaimedStatus: "running", LeaseTimeout: time.Minute},
	}
	for index, query := range tests {
		query.Schema = "feedback"
		query.Table = "jobs"
		query.IDColumn = "id"
		query.StatusColumn = "status"
		query.AvailableAtColumn = "available_at"
		query.ClaimedAtColumn = "claimed_at"
		if _, _, err := query.Build(policy); err == nil {
			t.Fatalf("case %d: 不完全なclaim設定が受理されました", index)
		}
	}
}
