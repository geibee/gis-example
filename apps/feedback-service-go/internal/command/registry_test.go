package command

import (
	"reflect"
	"testing"
)

func TestDeploymentEntrypoints(t *testing.T) {
	t.Parallel()
	expected := map[string]Name{
		"feedback-service":             Service,
		"feedback-notification-worker": NotificationWorker,
		"feedback-export-worker":       ExportWorker,
		"feedback-retention-worker":    RetentionWorker,
		"feedback-bootstrap":           Bootstrap,
		"feedback-connector-register":  ConnectorRegister,
		"feedback-connector-runtime":   ConnectorRuntime,
		"feedback-backup-pull":         BackupPull,
		"feedback-legacy-migration":    LegacyMigration,
		"feedback-migrate":             Migrate,
	}
	if actual := Entrypoints(); !reflect.DeepEqual(actual, expected) {
		t.Fatalf("entrypoint contractが一致しません: got=%v want=%v", actual, expected)
	}
	for entrypoint, expectedName := range expected {
		invocation, err := Resolve("/app/bin/"+entrypoint, []string{"fixture"})
		if err != nil {
			t.Errorf("entrypointを解決できません: %s: %v", entrypoint, err)
			continue
		}
		if invocation.Name != expectedName || !reflect.DeepEqual(invocation.Args, []string{"fixture"}) {
			t.Errorf("entrypoint解決結果が不正です: %s: %+v", entrypoint, invocation)
		}
	}
}

func TestSubcommandInvocation(t *testing.T) {
	t.Parallel()
	invocation, err := Resolve("feedback", []string{"migrate", "--dry-run"})
	if err != nil {
		t.Fatal(err)
	}
	if invocation.Name != Migrate || !reflect.DeepEqual(invocation.Args, []string{"--dry-run"}) {
		t.Fatalf("subcommand解決結果が不正です: %+v", invocation)
	}
}
