package backup

import (
	"testing"
	"time"
)

func TestDecideSchedulePrioritizesFullAndResetsCursors(t *testing.T) {
	t.Parallel()
	lastFull := time.Date(2026, 8, 8, 3, 0, 0, 0, time.UTC)
	lastAny := time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC)
	decision, err := DecideSchedule(ScheduleState{
		Policy: Policy{
			Enabled: true, Timezone: "Asia/Tokyo", FullBackupAt: "02:00",
			IncrementalIntervalMinutes: 60, IncludeEvidence: true,
		},
		LastFull: &lastFull, LastAny: &lastAny, FromChangeSequence: 10, FromAuditSequence: 20,
		QueuedKind: KindIncremental,
	}, time.Date(2026, 8, 9, 3, 0, 0, 0, time.UTC))
	if err != nil || decision == nil || decision.Kind != KindFull ||
		decision.FromChangeSequence != 0 || decision.FromAuditSequence != 0 {
		t.Fatalf("decision=%+v err=%v", decision, err)
	}
}

func TestDecideScheduleFloorsIncrementalAndCarriesCursors(t *testing.T) {
	t.Parallel()
	lastFull := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	lastAny := time.Date(2026, 8, 9, 0, 0, 0, 0, time.UTC)
	now := time.Date(2026, 8, 9, 1, 37, 41, 0, time.UTC)
	decision, err := DecideSchedule(ScheduleState{
		Policy: Policy{
			Enabled: true, Timezone: "Asia/Tokyo", FullBackupAt: "02:00",
			IncrementalIntervalMinutes: 60, IncludeEvidence: true,
		},
		LastFull: &lastFull, LastAny: &lastAny, FromChangeSequence: 10, FromAuditSequence: 20,
	}, now)
	if err != nil || decision == nil || decision.Kind != KindIncremental ||
		decision.ScheduledFor != time.Date(2026, 8, 9, 1, 0, 0, 0, time.UTC) ||
		decision.FromChangeSequence != 10 || decision.FromAuditSequence != 20 {
		t.Fatalf("decision=%+v err=%v", decision, err)
	}
}

func TestPolicyValidationNegativeTable(t *testing.T) {
	t.Parallel()
	valid := DefaultPolicy()
	tests := map[string]func(*Policy){
		"timezone":  func(value *Policy) { value.Timezone = "Mars/Olympus" },
		"full time": func(value *Policy) { value.FullBackupAt = "29:00" },
		"interval":  func(value *Policy) { value.IncrementalIntervalMinutes = 14 },
		"retention": func(value *Policy) { value.RetentionDays = backupInt(0) },
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			value := valid
			mutate(&value)
			if err := ValidatePolicy(value); err == nil {
				t.Fatal("不正policyが受理されました")
			}
		})
	}
}

func TestPolicyViewUsesKotlinInstantDayAcrossDST(t *testing.T) {
	t.Parallel()
	last := time.Date(2026, 3, 7, 12, 0, 0, 0, time.UTC)
	now := time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC)
	view, err := PolicyViewAt(Policy{
		Enabled: true, Timezone: "America/New_York", FullBackupAt: "02:00",
		IncrementalIntervalMinutes: 1440,
	}, &last, 1, 2, now)
	if err != nil {
		t.Fatal(err)
	}
	// 2026-03-08 02:00はDST gapで03:00へ正規化され、正本はそのInstantへ24時間を加える。
	if view.NextFullAt == nil || *view.NextFullAt != "2026-03-09T07:00:00Z" {
		t.Fatalf("nextFullAt=%v", stringPointerValue(view.NextFullAt))
	}
}

func TestJavaZonedDateTimeChoosesEarlierOverlapOffset(t *testing.T) {
	t.Parallel()
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	actual := javaZonedDateTime(2026, time.November, 1, 1, 30, 0, 0, zone).UTC()
	expected := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC)
	if actual != expected {
		t.Fatalf("overlap=%v want=%v", actual, expected)
	}
}

func stringPointerValue(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func backupInt(value int) *int { return &value }
