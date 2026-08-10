// Package objectstore はevidence/export/backupが共有するobject storage portを提供する。
package objectstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Local は既存filesystem object keyをそのまま利用するadapterである。
type Local struct {
	root string
}

func NewLocal(root string) (*Local, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("local object storage directoryが未設定です")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("local object storage pathを解決できません: %w", err)
	}
	if err := os.MkdirAll(absolute, 0o750); err != nil {
		return nil, fmt.Errorf("local object storage directoryを作成できません: %w", err)
	}
	return &Local{root: absolute}, nil
}

// CheckReadiness はKotlin版list(prefix)相当のread-only probeである。
func (storage *Local) CheckReadiness(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	directory, err := os.Open(storage.root)
	if err != nil {
		return fmt.Errorf("local object storageを開けません: %w", err)
	}
	defer directory.Close()
	if _, err := directory.ReadDir(1); err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("local object storageを一覧できません: %w", err)
	}
	return ctx.Err()
}

func (storage *Local) Close() error { return nil }
