// Package baseline はfresh install用の収束済みV1を埋め込む。
package baseline

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

const freshBaselineFile = "V1__feedback_baseline.sql"

//go:embed *
var source embed.FS

// Load はclean V1を検証して返す。
func Load() (*migration.FreshBaseline, error) { return load(source) }

func load(source fs.FS) (*migration.FreshBaseline, error) {
	entries, err := fs.ReadDir(source, ".")
	if err != nil {
		return nil, fmt.Errorf("fresh baseline一覧を読めません: %w", err)
	}
	var sqlFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			sqlFiles = append(sqlFiles, entry.Name())
		}
	}
	if len(sqlFiles) == 0 {
		return nil, nil
	}
	if len(sqlFiles) != 1 || sqlFiles[0] != freshBaselineFile {
		return nil, fmt.Errorf("fresh baselineは%sだけを許可します: %v", freshBaselineFile, sqlFiles)
	}
	contents, err := fs.ReadFile(source, freshBaselineFile)
	if err != nil {
		return nil, fmt.Errorf("fresh baselineを読めません: %w", err)
	}
	if strings.TrimSpace(string(contents)) == "" {
		return nil, errors.New("fresh baselineが空です")
	}
	if strings.Count(string(contents), migration.FreshBaselineSchemaFingerprint) != 1 {
		return nil, errors.New("fresh baseline markerのschema fingerprintが不正です")
	}
	checksum, err := migration.FlywayChecksum(contents)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(contents)
	return &migration.FreshBaseline{
		Script: freshBaselineFile, Description: "feedback baseline", SQL: string(contents),
		FlywayChecksum: checksum, SHA256: hex.EncodeToString(hash[:]),
	}, nil
}
