package migration

import (
	"testing"
	"testing/fstest"
)

func TestLoadDefinitions(t *testing.T) {
	t.Parallel()
	definitions, err := LoadDefinitions(fstest.MapFS{
		"README.md":               {Data: []byte("ignored")},
		"V7__add_example.sql":     {Data: []byte("SELECT 1;\n")},
		"V8__expand_contract.sql": {Data: []byte("SELECT 2;\n")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions) != 2 || definitions[0].Version != 7 || definitions[0].Description != "add example" ||
		len(definitions[0].Checksum) != 64 || definitions[1].Version != 8 {
		t.Fatalf("definitions = %+v", definitions)
	}
}

func TestLoadDefinitionsRejectsUnsafeSequences(t *testing.T) {
	t.Parallel()
	for name, source := range map[string]fstest.MapFS{
		"V6":       {"V6__old.sql": {Data: []byte("SELECT 1")}},
		"gap":      {"V8__gap.sql": {Data: []byte("SELECT 1")}},
		"bad name": {"V7__Bad.sql": {Data: []byte("SELECT 1")}},
		"empty":    {"V7__empty.sql": {Data: nil}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := LoadDefinitions(source); err == nil {
				t.Fatal("不正migration sourceを受理しました")
			}
		})
	}
}
