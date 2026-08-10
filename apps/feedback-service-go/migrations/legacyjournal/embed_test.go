package legacyjournal

import (
	"strings"
	"testing"
	"testing/fstest"
)

const expectedSHA256 = "f6787f3795bac28e04432270ec812655f205f2bff30f056b2118600b18504fb0"

func TestLoadLegacyJournal(t *testing.T) {
	t.Parallel()
	definition, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if definition.Version != 1 || definition.Script != migrationFile ||
		definition.Description != "feedback v4 copy journal" || definition.SQL == "" ||
		definition.SHA256 != expectedSHA256 {
		t.Fatalf("definition = %+v", definition)
	}
}

func TestLoadLegacyJournalRejectsMissingAndEmptySource(t *testing.T) {
	t.Parallel()
	for name, source := range map[string]fstest.MapFS{
		"missing": {},
		"empty":   {migrationFile: {Data: []byte(strings.Repeat(" ", 3))}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := load(source); err == nil {
				t.Fatal("不正なmigration sourceを受理しました")
			}
		})
	}
}
