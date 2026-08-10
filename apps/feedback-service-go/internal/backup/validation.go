package backup

import (
	"fmt"
	"regexp"
	"time"
)

var fullBackupPattern = regexp.MustCompile(`^[0-2][0-9]:[0-5][0-9]$`)

func ValidatePolicy(value Policy) error {
	if _, err := time.LoadLocation(value.Timezone); err != nil {
		return invalid("request.invalid", "timezone はIANA timezone IDで指定してください")
	}
	if !fullBackupPattern.MatchString(value.FullBackupAt) {
		return invalid("request.invalid", "fullBackupAt は HH:mm で指定してください")
	}
	if _, err := time.Parse("15:04", value.FullBackupAt); err != nil {
		return invalid("request.invalid", "fullBackupAt は HH:mm で指定してください")
	}
	if value.IncrementalIntervalMinutes < 15 || value.IncrementalIntervalMinutes > 1440 {
		return invalid("request.invalid", "incrementalIntervalMinutes は15..1440です")
	}
	if value.RetentionDays != nil && (*value.RetentionDays < 1 || *value.RetentionDays > 3650) {
		return invalid("request.invalid", "retentionDays は1..3650です")
	}
	return nil
}

func invalid(code, detail string) error { return &Error{Kind: ErrInvalid, Code: code, Detail: detail} }

func validateMaximumAttempts(value int) error {
	if value < 1 || value > 100 {
		return fmt.Errorf("backup max attemptsは1以上100以下で指定してください")
	}
	return nil
}
