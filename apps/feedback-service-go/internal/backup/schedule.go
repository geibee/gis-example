package backup

import (
	"fmt"
	"time"
)

type ScheduleState struct {
	Policy             Policy
	LastFull           *time.Time
	LastAny            *time.Time
	FromChangeSequence int64
	FromAuditSequence  int64
	QueuedKind         string
}

type ScheduleDecision struct {
	Kind               string
	ScheduledFor       time.Time
	FromChangeSequence int64
	FromAuditSequence  int64
}

func DecideSchedule(state ScheduleState, now time.Time) (*ScheduleDecision, error) {
	if err := ValidatePolicy(state.Policy); err != nil {
		return nil, err
	}
	zone, _ := time.LoadLocation(state.Policy.Timezone)
	localNow := now.In(zone)
	fullClock, _ := time.Parse("15:04", state.Policy.FullBackupAt)
	lastFullDateEarlier := false
	if state.LastFull != nil {
		last := state.LastFull.In(zone)
		lastFullDateEarlier = dateBefore(last, localNow)
	}
	fullDue := state.LastFull == nil || lastFullDateEarlier &&
		(localNow.Hour() > fullClock.Hour() || localNow.Hour() == fullClock.Hour() && localNow.Minute() >= fullClock.Minute())
	intervalDue := state.LastAny == nil || !state.LastAny.Add(
		time.Duration(state.Policy.IncrementalIntervalMinutes)*time.Minute,
	).After(now)
	decision := &ScheduleDecision{}
	switch {
	case fullDue && state.QueuedKind != KindFull:
		decision.Kind = KindFull
		if state.LastFull == nil {
			decision.ScheduledFor = now
		} else {
			decision.ScheduledFor = javaZonedDateTime(
				localNow.Year(), localNow.Month(), localNow.Day(), fullClock.Hour(), fullClock.Minute(), 0, 0, zone,
			).UTC()
		}
	case intervalDue && state.QueuedKind == "":
		decision.Kind = KindIncremental
		seconds := int64(state.Policy.IncrementalIntervalMinutes * 60)
		decision.ScheduledFor = time.Unix(now.Unix()/seconds*seconds, 0).UTC()
		decision.FromChangeSequence = state.FromChangeSequence
		decision.FromAuditSequence = state.FromAuditSequence
	default:
		return nil, nil
	}
	return decision, nil
}

func dateBefore(left, right time.Time) bool {
	leftDate := left.Year()*10000 + int(left.Month())*100 + left.Day()
	rightDate := right.Year()*10000 + int(right.Month())*100 + right.Day()
	return leftDate < rightDate
}

func PolicyViewAt(policy Policy, lastSuccessful *time.Time, changeCursor, auditCursor int64, now time.Time) (PolicyView, error) {
	view := PolicyView{Policy: policy, ChangeCursor: changeCursor, AuditCursor: auditCursor}
	if lastSuccessful != nil {
		value := javaInstant(*lastSuccessful)
		view.LastSuccessfulAt = &value
	}
	if !policy.Enabled {
		return view, nil
	}
	if err := ValidatePolicy(policy); err != nil {
		return PolicyView{}, err
	}
	zone, _ := time.LoadLocation(policy.Timezone)
	localNow := now.In(zone)
	clock, _ := time.Parse("15:04", policy.FullBackupAt)
	nextFull := javaZonedDateTime(localNow.Year(), localNow.Month(), localNow.Day(), clock.Hour(), clock.Minute(), 0, 0, zone)
	if !nextFull.After(now) {
		// Kotlin正本はlocal dateの再計算ではなくInstantへ24時間を加える。
		nextFull = nextFull.Add(24 * time.Hour)
	}
	nextIncremental := now
	if lastSuccessful != nil {
		nextIncremental = lastSuccessful.Add(time.Duration(policy.IncrementalIntervalMinutes) * time.Minute)
	}
	next := nextFull
	if nextIncremental.Before(next) {
		next = nextIncremental
	}
	fullText, incrementalText, nextText := javaInstant(nextFull), javaInstant(nextIncremental), javaInstant(next)
	view.NextFullAt, view.NextIncrementalAt, view.NextExecutionAt = &fullText, &incrementalText, &nextText
	return view, nil
}

// javaZonedDateTime はZonedDateTime.ofと同じくDST gapを後方へずらし、overlapでは早いoffsetを選ぶ。
func javaZonedDateTime(
	year int, month time.Month, day, hour, minute, second, nanosecond int, zone *time.Location,
) time.Time {
	wall := time.Date(year, month, day, hour, minute, second, nanosecond, time.UTC)
	offsets := make(map[int]struct{})
	probe := time.Date(year, month, day, hour, minute, second, nanosecond, zone)
	for delta := -48 * time.Hour; delta <= 48*time.Hour; delta += 30 * time.Minute {
		_, offset := probe.Add(delta).In(zone).Zone()
		offsets[offset] = struct{}{}
	}
	var selected time.Time
	found := false
	minimumOffset := 1<<31 - 1
	for offset := range offsets {
		if offset < minimumOffset {
			minimumOffset = offset
		}
		candidate := wall.Add(-time.Duration(offset) * time.Second)
		local := candidate.In(zone)
		if local.Year() == year && local.Month() == month && local.Day() == day &&
			local.Hour() == hour && local.Minute() == minute && local.Second() == second &&
			local.Nanosecond() == nanosecond && (!found || candidate.Before(selected)) {
			selected, found = candidate, true
		}
	}
	if found {
		return selected
	}
	// gapでは遷移前のoffsetを適用すると、gap幅だけ後ろへ補正したJavaの時刻になる。
	return wall.Add(-time.Duration(minimumOffset) * time.Second)
}

func javaInstant(value time.Time) string {
	value = value.UTC()
	base := value.Format("2006-01-02T15:04:05")
	nanoseconds := value.Nanosecond()
	if nanoseconds == 0 {
		return base + "Z"
	}
	digits := 9
	if nanoseconds%1_000_000 == 0 {
		digits = 3
	} else if nanoseconds%1_000 == 0 {
		digits = 6
	}
	return fmt.Sprintf("%s.%09dZ", base, nanoseconds)[:len(base)+1+digits] + "Z"
}
