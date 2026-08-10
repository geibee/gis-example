package baseline

import (
	"testing"
	"testing/fstest"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

func TestLoadFreshBaseline(t *testing.T) {
	t.Parallel()
	sql := []byte("CREATE SCHEMA feedback;\n-- " + migration.FreshBaselineSchemaFingerprint + "\n")
	value, err := load(fstest.MapFS{freshBaselineFile: {Data: sql}})
	if err != nil {
		t.Fatal(err)
	}
	if value == nil || value.Script != freshBaselineFile || value.Description != "feedback baseline" ||
		value.SQL != string(sql) || len(value.SHA256) != 64 {
		t.Fatalf("baseline = %+v", value)
	}
	// Flywayの行単位CRC32規則を固定する。末尾LFはchecksumへ含めない。
	withoutFinalLF, err := migration.FlywayChecksum(sql[:len(sql)-1])
	if err != nil || withoutFinalLF != value.FlywayChecksum {
		t.Fatalf("checksum=%d without-final-lf=%d err=%v", value.FlywayChecksum, withoutFinalLF, err)
	}
}

func TestLoadFreshBaselineAllowsReadmeOnlyAndRejectsInvalidShape(t *testing.T) {
	t.Parallel()
	value, err := load(fstest.MapFS{"README.md": {Data: []byte("placeholder")}})
	if err != nil || value != nil {
		t.Fatalf("README-only baseline=%+v err=%v", value, err)
	}
	valid := []byte("-- " + migration.FreshBaselineSchemaFingerprint)
	for name, source := range map[string]fstest.MapFS{
		"wrong filename": {"V2__wrong.sql": {Data: valid}},
		"multiple":       {freshBaselineFile: {Data: valid}, "V2__wrong.sql": {Data: valid}},
		"empty":          {freshBaselineFile: {Data: nil}},
		"fingerprint":    {freshBaselineFile: {Data: []byte("SELECT 1")}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if value, err := load(source); err == nil || value != nil {
				t.Fatalf("baseline=%+v err=%v", value, err)
			}
		})
	}
}
