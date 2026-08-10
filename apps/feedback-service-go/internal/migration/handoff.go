// Package migration owns the one-way handoff from Flyway to the Go migrator.
package migration

import (
	"errors"
	"fmt"
	"slices"
)

const (
	// HandoffVersion is the last schema version owned by Kotlin/Flyway.
	HandoffVersion int64 = 6
	// HandoffSchemaFingerprint is the canonical V1-V5 upgrade schema fingerprint.
	HandoffSchemaFingerprint = "01d03abc057749179777853ca970bc220f1ee79d8b6fa98d0e0801ba5788e36d"
	// FreshBaselineSchemaFingerprint is the extracted clean V1 fingerprint. It omits only
	// the retired feedback.legacy_migration_* ledgers and is accepted exclusively with a
	// single Flyway V1 history entry.
	FreshBaselineSchemaFingerprint = "de8ba8a564a39b533e92b37ebffd32bc1a6fbfb66addaad4f56dbd78cb934259"
)

// FlywayVersion is the minimum immutable history used by the handoff check.
type FlywayVersion struct {
	Version int64
	Success bool
}

// BaselineMarker represents version 6 in feedback.go_schema_migrations.
type BaselineMarker struct {
	Version                 int64
	Kind                    string
	State                   string
	ChecksumSHA256          *string
	SchemaFingerprintSHA256 *string
}

// FreshBaseline は独立repositoryの空DBだけへ適用するV1〜V6収束済みDDLである。
// FlywayChecksumはfresh Kotlin imageでも同じV1履歴を検証できるよう保持する。
type FreshBaseline struct {
	Script         string
	Description    string
	SQL            string
	FlywayChecksum int32
	SHA256         string
}

// ValidateHandoff rejects partially migrated, dirty, or structurally different schemas.
// A fresh standalone baseline has Flyway version 1 only; an upgraded installation has V1-V6.
func ValidateHandoff(
	flywayHistory []FlywayVersion,
	marker BaselineMarker,
	actualSchemaFingerprint string,
) error {
	if err := validateFlywayHistory(flywayHistory); err != nil {
		return err
	}
	expectedFingerprint := HandoffSchemaFingerprint
	if len(flywayHistory) == 1 && flywayHistory[0].Version == 1 {
		expectedFingerprint = FreshBaselineSchemaFingerprint
	}
	if marker.Version != HandoffVersion || marker.Kind != "baseline" || marker.State != "succeeded" {
		return fmt.Errorf("対象Go migration handoff markerが不正です: version=%d kind=%q state=%q", marker.Version, marker.Kind, marker.State)
	}
	if marker.ChecksumSHA256 != nil {
		return errors.New("V6 baseline markerにmigration checksumを設定できません")
	}
	if marker.SchemaFingerprintSHA256 == nil || *marker.SchemaFingerprintSHA256 != expectedFingerprint {
		return errors.New("V6 baseline markerのschema fingerprintが一致しません")
	}
	if actualSchemaFingerprint != expectedFingerprint {
		return errors.New("実DBのschema fingerprintがV6 handoff契約と一致しません")
	}
	return nil
}

func validateFlywayHistory(history []FlywayVersion) error {
	versions := make([]int64, 0, len(history))
	seen := make(map[int64]struct{}, len(history))
	for _, entry := range history {
		if !entry.Success {
			return fmt.Errorf("対象Flyway version %dが失敗状態です", entry.Version)
		}
		if entry.Version < 1 || entry.Version > HandoffVersion {
			return fmt.Errorf("handoff境界外のFlyway versionです: %d", entry.Version)
		}
		if _, duplicated := seen[entry.Version]; duplicated {
			return fmt.Errorf("対象Flyway version %dが重複しています", entry.Version)
		}
		seen[entry.Version] = struct{}{}
		versions = append(versions, entry.Version)
	}
	slices.Sort(versions)
	if slices.Equal(versions, []int64{1}) || slices.Equal(versions, []int64{1, 2, 3, 4, 5, 6}) {
		return nil
	}
	return fmt.Errorf("対象Flyway historyがfresh baselineまたはV1-V6連続履歴ではありません: %v", versions)
}
