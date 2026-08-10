package migrations

import "testing"

func TestLoadIncludesReviewScopePerspectiveMigration(t *testing.T) {
	t.Parallel()
	definitions, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions) != 1 || definitions[0].Version != 7 ||
		definitions[0].Description != "review scope perspectives" {
		t.Fatalf("definitions = %+v", definitions)
	}
}
