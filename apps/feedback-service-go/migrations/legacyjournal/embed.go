// Package legacyjournal は旧consumerコピーCLI専用のmigrationをbinaryへ埋め込む。
package legacyjournal

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"strings"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

const migrationFile = "V1__feedback_v4_copy_journal.sql"

//go:embed V1__feedback_v4_copy_journal.sql
var source embed.FS

// Load は固定した専用journal migrationを検証して返す。
func Load() (migration.FlywayDefinition, error) { return load(source) }

func load(source fs.FS) (migration.FlywayDefinition, error) {
	contents, err := fs.ReadFile(source, migrationFile)
	if err != nil {
		return migration.FlywayDefinition{}, fmt.Errorf("legacy journal migrationを読めません: %w", err)
	}
	if strings.TrimSpace(string(contents)) == "" {
		return migration.FlywayDefinition{}, errors.New("legacy journal migrationが空です")
	}
	checksum, err := migration.FlywayChecksum(contents)
	if err != nil {
		return migration.FlywayDefinition{}, err
	}
	hash := sha256.Sum256(contents)
	return migration.FlywayDefinition{
		Version: 1, Script: migrationFile, Description: "feedback v4 copy journal",
		SQL: string(contents), Checksum: checksum, SHA256: hex.EncodeToString(hash[:]),
	}, nil
}
