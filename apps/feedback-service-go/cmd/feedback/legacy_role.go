package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/httpapi"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/legacymigration"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
	"github.com/geibee/gis-example/apps/feedback-service-go/migrations/legacyjournal"
)

type legacyInvocation struct {
	command         string
	input           string
	runID           string
	confirmCopy     bool
	confirmRollback bool
}

func runLegacyMigration(arguments []string) error {
	invocation, err := parseLegacyInvocation(arguments)
	if err != nil {
		return err
	}
	input, err := os.Open(invocation.input)
	if err != nil {
		return fmt.Errorf("--input のsnapshot fileを開けません: %w", err)
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("--input のsnapshot fileがありません")
	}
	snapshot, err := legacymigration.DecodeSnapshot(input)
	if err != nil {
		return err
	}
	settings, err := config.ParseLegacyMigration(os.LookupEnv)
	if err != nil {
		return fmt.Errorf("legacy migration設定を読み込めません: %w", err)
	}
	ctx, stop := httpapi.SignalContext(context.Background())
	defer stop()
	database, err := openRoleDatabase(ctx, settings.Database)
	if err != nil {
		return err
	}
	defer database.Close()
	journal, err := legacyjournal.Load()
	if err != nil {
		return err
	}
	initialized, err := database.PrepareLegacyMigrationSchema(ctx, journal)
	if err != nil {
		return fmt.Errorf("legacy migration journalを準備できません: %w", err)
	}
	processLogger().Info("legacy migration journalを検証しました", "initialized", initialized)
	storage, err := objectstore.NewStore(ctx, settings.Evidence)
	if err != nil {
		return fmt.Errorf("legacy evidence storageを初期化できません: %w", err)
	}
	defer storage.Close()
	service, err := legacymigration.NewService(database, storage, legacymigration.Settings{
		EvidencePrefix: settings.Evidence.KeyPrefix + "migration/",
		StorageTimeout: 10 * time.Second,
		DeleteAttempts: 3,
	})
	if err != nil {
		return err
	}
	var report legacymigration.Report
	switch invocation.command {
	case "dry-run":
		report, err = service.DryRun(ctx, snapshot)
	case "apply":
		if invocation.runID == "" {
			var dryRun legacymigration.Report
			dryRun, err = service.DryRun(ctx, snapshot)
			if err == nil {
				invocation.runID = dryRun.RunID
			}
		}
		if err == nil {
			report, err = service.Apply(ctx, snapshot, invocation.runID)
		}
	case "reconcile":
		report, err = service.Reconcile(ctx, snapshot, invocation.runID)
	case "rollback":
		report, err = service.Rollback(ctx, snapshot, invocation.runID)
	}
	if err != nil {
		return err
	}
	if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
		return fmt.Errorf("legacy migration reportを書き込めません: %w", err)
	}
	return nil
}

func parseLegacyInvocation(arguments []string) (legacyInvocation, error) {
	if len(arguments) == 0 {
		return legacyInvocation{}, legacyUsage()
	}
	result := legacyInvocation{command: arguments[0]}
	if result.command != "dry-run" && result.command != "apply" &&
		result.command != "reconcile" && result.command != "rollback" {
		return legacyInvocation{}, legacyUsage()
	}
	for index := 1; index < len(arguments); {
		switch arguments[index] {
		case "--confirm-copy":
			result.confirmCopy = true
			index++
		case "--confirm-rollback":
			result.confirmRollback = true
			index++
		case "--input", "--run-id":
			if index+1 >= len(arguments) {
				return legacyInvocation{}, fmt.Errorf("%s の値がありません", arguments[index])
			}
			if arguments[index] == "--input" {
				result.input = arguments[index+1]
			} else {
				result.runID = arguments[index+1]
			}
			index += 2
		default:
			return legacyInvocation{}, fmt.Errorf("未知のoptionです: %s", arguments[index])
		}
	}
	if result.input == "" {
		return legacyInvocation{}, legacyUsage()
	}
	if result.command == "apply" && !result.confirmCopy {
		return legacyInvocation{}, errors.New("applyには対象・backup・rollbackの人手承認後に--confirm-copyが必要です")
	}
	if (result.command == "reconcile" || result.command == "rollback") && result.runID == "" {
		return legacyInvocation{}, legacyUsage()
	}
	if result.command == "rollback" && !result.confirmRollback {
		return legacyInvocation{}, errors.New("rollbackには差分確認後に--confirm-rollbackが必要です")
	}
	return result, nil
}

func legacyUsage() error {
	return errors.New(
		"usage: feedback-legacy-migration <dry-run|apply|reconcile|rollback> " +
			"--input <snapshot.json> [--run-id <uuid>] [--confirm-copy|--confirm-rollback]",
	)
}
