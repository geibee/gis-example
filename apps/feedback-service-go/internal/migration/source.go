package migration

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var migrationFilePattern = regexp.MustCompile(`^V([1-9][0-9]*)__([a-z0-9][a-z0-9_]*)\.sql$`)

type Definition struct {
	Version     int64
	Description string
	Checksum    string
	SQL         string
}

// LoadDefinitions は埋込みfilesystemからV7以降のmigrationだけを厳密に読み込む。
func LoadDefinitions(source fs.FS) ([]Definition, error) {
	if source == nil {
		return nil, errors.New("migration sourceが未設定です")
	}
	entries, err := fs.ReadDir(source, ".")
	if err != nil {
		return nil, fmt.Errorf("migration一覧を読めません: %w", err)
	}
	definitions := make([]Definition, 0)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}
		matches := migrationFilePattern.FindStringSubmatch(entry.Name())
		if matches == nil {
			return nil, fmt.Errorf("migration filenameが不正です: %s", entry.Name())
		}
		version, parseErr := strconv.ParseInt(matches[1], 10, 64)
		if parseErr != nil || version <= HandoffVersion {
			return nil, fmt.Errorf("migration versionはV7以降で指定してください: %s", entry.Name())
		}
		contents, readErr := fs.ReadFile(source, entry.Name())
		if readErr != nil {
			return nil, fmt.Errorf("migrationを読めません: %s: %w", entry.Name(), readErr)
		}
		if strings.TrimSpace(string(contents)) == "" {
			return nil, fmt.Errorf("migration SQLが空です: %s", entry.Name())
		}
		hash := sha256.Sum256(contents)
		definitions = append(definitions, Definition{
			Version: version, Description: strings.ReplaceAll(matches[2], "_", " "),
			Checksum: hex.EncodeToString(hash[:]), SQL: string(contents),
		})
	}
	slices.SortFunc(definitions, func(left, right Definition) int {
		return int(left.Version - right.Version)
	})
	for index, definition := range definitions {
		expected := HandoffVersion + 1 + int64(index)
		if definition.Version != expected {
			return nil, fmt.Errorf("migration versionが連続していません: got=V%d want=V%d", definition.Version, expected)
		}
	}
	return definitions, nil
}
