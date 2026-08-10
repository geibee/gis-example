package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type freezeManifest struct {
	BaselineCommit        string            `json:"baselineCommit"`
	OpenAPIOperationCount int               `json:"openapiOperationCount"`
	Contracts             map[string]string `json:"contracts"`
	FlywayMigrations      map[string]string `json:"flywayMigrations"`
}

func TestFrozenContractChecksums(t *testing.T) {
	t.Parallel()

	contractRoot := filepath.Join("..", "..", "..", "..", "contracts", "feedback")
	manifestBytes, err := os.ReadFile(filepath.Join(contractRoot, "freeze-v1.json"))
	if err != nil {
		t.Fatalf("freeze manifestを読めません: %v", err)
	}
	var manifest freezeManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("freeze manifestが不正です: %v", err)
	}
	if manifest.BaselineCommit != "1f30e9a" {
		t.Fatalf("基準commitが変化しました: %s", manifest.BaselineCommit)
	}
	if manifest.OpenAPIOperationCount != frozenOperationCount {
		t.Fatalf("freeze manifestのoperation数が不正です: %d", manifest.OpenAPIOperationCount)
	}
	for relativePath, expected := range manifest.Contracts {
		contents, err := os.ReadFile(filepath.Join(contractRoot, filepath.FromSlash(relativePath)))
		if err != nil {
			t.Errorf("契約を読めません: %s: %v", relativePath, err)
			continue
		}
		actualHash := sha256.Sum256(contents)
		actual := hex.EncodeToString(actualHash[:])
		expected = strings.TrimPrefix(expected, "sha256:")
		if actual != expected {
			t.Errorf("freeze後に契約が変化しました: %s got=%s want=%s", relativePath, actual, expected)
		}
	}
	if len(manifest.FlywayMigrations) != 5 {
		t.Fatalf("freeze対象のFlyway migration数が不正です: %d", len(manifest.FlywayMigrations))
	}
	migrationRoot := filepath.Join("..", "..", "..", "..", "apps", "feedback-service-go", "migrations", "flyway-v1-v6")
	if _, err := os.Stat(migrationRoot); err == nil {
		for filename, expected := range manifest.FlywayMigrations {
			contents, err := os.ReadFile(filepath.Join(migrationRoot, filepath.FromSlash(filename)))
			if err != nil {
				t.Errorf("freeze対象migrationを読めません: %s: %v", filename, err)
				continue
			}
			actualHash := sha256.Sum256(contents)
			actual := hex.EncodeToString(actualHash[:])
			expected = strings.TrimPrefix(expected, "sha256:")
			if actual != expected {
				t.Errorf("freeze後にmigrationが変化しました: %s got=%s want=%s", filename, actual, expected)
			}
		}
	} else if !os.IsNotExist(err) {
		t.Fatalf("Flyway migration directoryを検査できません: %v", err)
	}
}
