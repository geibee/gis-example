package postgres

import (
	"strings"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

func TestReconcileGoMigrations(t *testing.T) {
	t.Parallel()
	definitions := []migration.Definition{
		{Version: 7, Description: "expand", Checksum: strings.Repeat("a", 64), SQL: "SELECT 1"},
		{Version: 8, Description: "contract", Checksum: strings.Repeat("b", 64), SQL: "SELECT 2"},
	}
	pending, err := reconcileGoMigrations(definitions, []appliedGoMigration{
		{Version: 7, Description: "expand", Checksum: strings.Repeat("a", 64), State: "succeeded"},
	})
	if err != nil || len(pending) != 1 || pending[0].Version != 8 {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
	for name, history := range map[string][]appliedGoMigration{
		"checksum": {{Version: 7, Description: "expand", Checksum: strings.Repeat("c", 64), State: "succeeded"}},
		"failed":   {{Version: 7, Description: "expand", Checksum: strings.Repeat("a", 64), State: "failed"}},
		"unknown": {
			{Version: 7, Description: "expand", Checksum: strings.Repeat("a", 64), State: "succeeded"},
			{Version: 8, Description: "contract", Checksum: strings.Repeat("b", 64), State: "succeeded"},
			{Version: 9, Description: "unknown", Checksum: strings.Repeat("c", 64), State: "succeeded"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := reconcileGoMigrations(definitions, history); err == nil {
				t.Fatal("不正なmigration historyを受理しました")
			}
		})
	}
}
