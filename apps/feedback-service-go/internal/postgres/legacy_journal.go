package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/legacymigration"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

const legacyJournalAdvisoryLockID int64 = 7736690273395016451

type legacyJournalState struct {
	relationCount int64
	history       bool
	runs          bool
	entities      bool
}

type legacyJournalHistory struct {
	Version     *string
	Description string
	Type        string
	Script      string
	Checksum    *int32
	Success     bool
}

// PrepareLegacyMigrationSchema は旧consumerコピー専用journalを本体schemaから分離して冪等に準備する。
// API/worker起動時には呼ばず、feedback-legacy-migration CLIだけが実行する。
func (d *Database) PrepareLegacyMigrationSchema(
	ctx context.Context,
	definition migration.FlywayDefinition,
) (bool, error) {
	if err := validateLegacyJournalDefinition(definition); err != nil {
		return false, err
	}
	if err := d.ValidateMigrationHandoff(ctx); err != nil {
		return false, legacySchemaMismatch("legacy migration対象Feedback schemaがV6 handoff契約と一致しません: " + err.Error())
	}
	productionPool, ok := d.pool.(*pgxPool)
	if !ok {
		return false, errors.New("legacy journal migrationは実PostgreSQL poolでのみ実行できます")
	}
	acquireCtx, cancel := context.WithTimeout(ctx, d.connectionTimeout)
	connection, err := productionPool.value.Acquire(acquireCtx)
	cancel()
	if err != nil {
		return false, fmt.Errorf("legacy journal用connectionを取得できません: %w", err)
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1)`, legacyJournalAdvisoryLockID); err != nil {
		return false, fmt.Errorf("legacy journal advisory lockを取得できません: %w", err)
	}
	defer func() {
		unlockCtx, unlockCancel := context.WithTimeout(context.WithoutCancel(ctx), d.connectionTimeout)
		defer unlockCancel()
		var unlocked bool
		_ = connection.QueryRow(unlockCtx, `SELECT pg_advisory_unlock($1)`, legacyJournalAdvisoryLockID).Scan(&unlocked)
	}()

	state, err := readLegacyJournalState(ctx, connection)
	if err != nil {
		return false, err
	}
	if state.history && state.runs && state.entities && state.relationCount == 8 {
		history, historyErr := readLegacyJournalHistory(ctx, connection)
		if historyErr != nil {
			return false, historyErr
		}
		if err := validateLegacyJournalHistory(definition, history); err != nil {
			return false, err
		}
		return false, nil
	}
	if state.relationCount != 0 || state.history || state.runs || state.entities {
		return false, legacySchemaMismatch("feedback_migration schemaが部分適用状態です")
	}

	tx, err := connection.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("legacy journal transactionを開始できません: %w", err)
	}
	rollback := func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }
	for _, statement := range []string{
		`CREATE SCHEMA IF NOT EXISTS feedback_migration`,
		legacyFlywayHistoryTableSQL,
		legacyFlywayHistoryIndexSQL,
		definition.SQL,
	} {
		if _, err := tx.Exec(ctx, statement); err != nil {
			rollback()
			return false, fmt.Errorf("legacy journal migrationを適用できません: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, legacyFlywayHistoryRowsSQL,
		definition.Script, definition.Description, definition.Checksum,
	); err != nil {
		rollback()
		return false, fmt.Errorf("legacy journal Flyway履歴を作成できません: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("legacy journal migrationをcommitできません: %w", err)
	}
	return true, nil
}

func validateLegacyJournalDefinition(definition migration.FlywayDefinition) error {
	if definition.Version != 1 || definition.Script != "V1__feedback_v4_copy_journal.sql" ||
		definition.Description != "feedback v4 copy journal" || definition.SQL == "" ||
		len(definition.SHA256) != 64 {
		return errors.New("legacy journal migration definitionが不正です")
	}
	return nil
}

func readLegacyJournalState(ctx context.Context, query interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (legacyJournalState, error) {
	var state legacyJournalState
	err := query.QueryRow(ctx, `SELECT
    (SELECT count(*) FROM pg_class class
     JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = 'feedback_migration'),
    to_regclass('feedback_migration.flyway_schema_history') IS NOT NULL,
    to_regclass('feedback_migration.legacy_migration_runs') IS NOT NULL,
    to_regclass('feedback_migration.legacy_migration_entities') IS NOT NULL`).Scan(
		&state.relationCount, &state.history, &state.runs, &state.entities,
	)
	if err != nil {
		return legacyJournalState{}, fmt.Errorf("legacy journal schema状態を確認できません: %w", err)
	}
	return state, nil
}

func readLegacyJournalHistory(ctx context.Context, query interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}) ([]legacyJournalHistory, error) {
	rows, err := query.Query(ctx, `SELECT version, description, type, script, checksum, success
FROM feedback_migration.flyway_schema_history ORDER BY installed_rank`)
	if err != nil {
		return nil, fmt.Errorf("legacy journal Flyway履歴を取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]legacyJournalHistory, 0, 2)
	for rows.Next() {
		var item legacyJournalHistory
		if err := rows.Scan(&item.Version, &item.Description, &item.Type,
			&item.Script, &item.Checksum, &item.Success); err != nil {
			return nil, fmt.Errorf("legacy journal Flyway履歴を読めません: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("legacy journal Flyway履歴を列挙できません: %w", err)
	}
	return result, nil
}

func validateLegacyJournalHistory(
	definition migration.FlywayDefinition,
	history []legacyJournalHistory,
) error {
	if len(history) < 1 || len(history) > 2 {
		return legacySchemaMismatch("legacy journal Flyway履歴の件数が不正です")
	}
	versioned := history[len(history)-1]
	if versioned.Version == nil || *versioned.Version != "1" ||
		versioned.Description != definition.Description || versioned.Type != "SQL" ||
		versioned.Script != definition.Script || versioned.Checksum == nil ||
		*versioned.Checksum != definition.Checksum || !versioned.Success {
		return legacySchemaMismatch("legacy journal Flyway履歴またはchecksumが一致しません")
	}
	if len(history) == 2 {
		schema := history[0]
		if schema.Version != nil || schema.Type != "SCHEMA" ||
			schema.Script != `"feedback_migration"` || !schema.Success {
			return legacySchemaMismatch("legacy journal schema作成履歴が不正です")
		}
	}
	return nil
}

func legacySchemaMismatch(detail string) error {
	return &legacymigration.Error{
		Kind: legacymigration.ErrSchemaMismatch, Code: "legacy.schema_mismatch", Detail: detail,
	}
}

const legacyFlywayHistoryTableSQL = `CREATE TABLE feedback_migration.flyway_schema_history (
    installed_rank integer NOT NULL,
    version varchar(50),
    description varchar(200) NOT NULL,
    type varchar(20) NOT NULL,
    script varchar(1000) NOT NULL,
    checksum integer,
    installed_by varchar(100) NOT NULL,
    installed_on timestamp without time zone NOT NULL DEFAULT now(),
    execution_time integer NOT NULL,
    success boolean NOT NULL,
    CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank)
);`

const legacyFlywayHistoryIndexSQL = `CREATE INDEX flyway_schema_history_s_idx
    ON feedback_migration.flyway_schema_history (success);`

const legacyFlywayHistoryRowsSQL = `INSERT INTO feedback_migration.flyway_schema_history (
    installed_rank, version, description, type, script, checksum,
    installed_by, execution_time, success
) VALUES
    (0, NULL, '<< Flyway Schema Creation >>', 'SCHEMA', '"feedback_migration"', NULL,
     current_user, 0, true),
    (1, '1', $2, 'SQL', $1, $3,
     current_user, 0, true)`
