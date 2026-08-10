package postgres

import (
	"strings"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

func TestValidateLegacyJournalDefinition(t *testing.T) {
	t.Parallel()
	valid := testLegacyJournalDefinition()
	if err := validateLegacyJournalDefinition(valid); err != nil {
		t.Fatal(err)
	}
	invalid := valid
	invalid.Version = 2
	if err := validateLegacyJournalDefinition(invalid); err == nil {
		t.Fatal("不正versionを受理しました")
	}
}

func TestValidateLegacyJournalHistory(t *testing.T) {
	t.Parallel()
	definition := testLegacyJournalDefinition()
	version := "1"
	checksum := definition.Checksum
	validMigration := legacyJournalHistory{
		Version: &version, Description: definition.Description, Type: "SQL",
		Script: definition.Script, Checksum: &checksum, Success: true,
	}
	validSchema := legacyJournalHistory{
		Description: "<< Flyway Schema Creation >>", Type: "SCHEMA",
		Script: `"feedback_migration"`, Success: true,
	}
	for name, history := range map[string][]legacyJournalHistory{
		"migration only":       {validMigration},
		"schema and migration": {validSchema, validMigration},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := validateLegacyJournalHistory(definition, history); err != nil {
				t.Fatal(err)
			}
		})
	}

	wrongChecksum := checksum + 1
	wrong := validMigration
	wrong.Checksum = &wrongChecksum
	for name, history := range map[string][]legacyJournalHistory{
		"empty":          {},
		"checksum":       {wrong},
		"unknown row":    {validSchema, validSchema, validMigration},
		"reordered rows": {validMigration, validSchema},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if err := validateLegacyJournalHistory(definition, history); err == nil {
				t.Fatal("不正なFlyway履歴を受理しました")
			}
		})
	}
}

func testLegacyJournalDefinition() migration.FlywayDefinition {
	return migration.FlywayDefinition{
		Version: 1, Script: "V1__feedback_v4_copy_journal.sql",
		Description: "feedback v4 copy journal", SQL: "SELECT 1",
		Checksum: 123, SHA256: strings.Repeat("a", 64),
	}
}
