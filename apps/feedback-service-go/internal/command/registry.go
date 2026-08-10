// Package command fixes the deployment entrypoint names before behavior is migrated.
package command

import (
	"errors"
	"fmt"
	"path/filepath"
)

// Name identifies one process role in the single Go binary.
type Name string

const (
	Service            Name = "service"
	NotificationWorker Name = "notification-worker"
	ExportWorker       Name = "export-worker"
	RetentionWorker    Name = "retention-worker"
	Bootstrap          Name = "bootstrap"
	ConnectorRegister  Name = "connector-register"
	ConnectorRuntime   Name = "connector-runtime"
	BackupPull         Name = "backup-pull"
	LegacyMigration    Name = "legacy-migration"
	Migrate            Name = "migrate"
)

var entrypoints = map[string]Name{
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

var subcommands = map[string]Name{
	string(Service):            Service,
	string(NotificationWorker): NotificationWorker,
	string(ExportWorker):       ExportWorker,
	string(RetentionWorker):    RetentionWorker,
	string(Bootstrap):          Bootstrap,
	string(ConnectorRegister):  ConnectorRegister,
	string(ConnectorRuntime):   ConnectorRuntime,
	string(BackupPull):         BackupPull,
	string(LegacyMigration):    LegacyMigration,
	string(Migrate):            Migrate,
}

// Invocation is the normalized role and its role-specific arguments.
type Invocation struct {
	Name Name
	Args []string
}

// Resolve supports both the feedback subcommand and existing symlink contracts.
func Resolve(argv0 string, args []string) (Invocation, error) {
	if name, ok := entrypoints[filepath.Base(argv0)]; ok {
		return Invocation{Name: name, Args: args}, nil
	}
	if len(args) == 0 {
		return Invocation{}, errors.New("subcommandを指定してください")
	}
	name, ok := subcommands[args[0]]
	if !ok {
		return Invocation{}, fmt.Errorf("未知のsubcommandです: %s", args[0])
	}
	return Invocation{Name: name, Args: args[1:]}, nil
}

// Entrypoints returns a copy used by packaging coverage tests.
func Entrypoints() map[string]Name {
	result := make(map[string]Name, len(entrypoints))
	for entrypoint, name := range entrypoints {
		result[entrypoint] = name
	}
	return result
}
