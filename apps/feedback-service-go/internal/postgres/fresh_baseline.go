package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

// InitializeFreshBaseline は空DBだけへ独立repositoryのclean V1を適用する。
// 既存handoff DBは変更せず、部分schemaやbaseline未同梱の空DBをfail-closedで拒否する。
func (d *Database) InitializeFreshBaseline(
	ctx context.Context,
	baseline *migration.FreshBaseline,
) (bool, error) {
	productionPool, ok := d.pool.(*pgxPool)
	if !ok {
		return false, errors.New("fresh baseline initializerは実PostgreSQL poolでのみ実行できます")
	}
	acquireCtx, cancel := context.WithTimeout(ctx, d.connectionTimeout)
	connection, err := productionPool.value.Acquire(acquireCtx)
	cancel()
	if err != nil {
		return false, fmt.Errorf("fresh baseline用connectionを取得できません: %w", err)
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationAdvisoryLockID); err != nil {
		return false, fmt.Errorf("migration advisory lockを取得できません: %w", err)
	}
	defer func() {
		unlockCtx, unlockCancel := context.WithTimeout(context.WithoutCancel(ctx), d.connectionTimeout)
		defer unlockCancel()
		var unlocked bool
		_ = connection.QueryRow(unlockCtx, `SELECT pg_advisory_unlock($1)`, migrationAdvisoryLockID).Scan(&unlocked)
	}()

	state, err := readFreshBaselineState(ctx, connection)
	if err != nil {
		return false, err
	}
	if state.flywayHistory && state.goHistory {
		return false, nil
	}
	if state.relationCount != 0 || state.flywayHistory || state.goHistory {
		return false, errors.New("空DBではない部分的なfeedback schemaへfresh baselineを適用できません")
	}
	if baseline == nil {
		return false, errors.New("空DBですがfresh baselineがbinaryへ同梱されていません")
	}
	if baseline.Script != "V1__feedback_baseline.sql" || baseline.Description != "feedback baseline" ||
		baseline.SQL == "" || len(baseline.SHA256) != 64 {
		return false, errors.New("fresh baseline definitionが不正です")
	}

	tx, err := connection.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("fresh baseline transactionを開始できません: %w", err)
	}
	rollback := func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }
	if _, err := tx.Exec(ctx, baseline.SQL); err != nil {
		rollback()
		return false, fmt.Errorf("fresh baseline SQLを適用できません: %w", err)
	}
	if _, err := tx.Exec(ctx, flywayFreshHistoryTableSQL); err != nil {
		rollback()
		return false, fmt.Errorf("fresh baselineのFlyway履歴tableを作成できません: %w", err)
	}
	if _, err := tx.Exec(ctx, flywayFreshHistoryIndexSQL); err != nil {
		rollback()
		return false, fmt.Errorf("fresh baselineのFlyway履歴indexを作成できません: %w", err)
	}
	if _, err := tx.Exec(ctx, flywayFreshHistoryRowsSQL, baseline.Script, baseline.Description, baseline.FlywayChecksum); err != nil {
		rollback()
		return false, fmt.Errorf("fresh baselineのFlyway履歴行を作成できません: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("fresh baselineをcommitできません: %w", err)
	}
	return true, nil
}

type freshBaselineState struct {
	flywayHistory bool
	goHistory     bool
	relationCount int64
}

func readFreshBaselineState(
	ctx context.Context,
	query interface {
		QueryRow(context.Context, string, ...any) pgx.Row
	},
) (freshBaselineState, error) {
	var state freshBaselineState
	err := query.QueryRow(ctx, `SELECT
    to_regclass('feedback.flyway_schema_history') IS NOT NULL,
    to_regclass('feedback.go_schema_migrations') IS NOT NULL,
    (SELECT count(*) FROM pg_class class
     JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = 'feedback')`).Scan(
		&state.flywayHistory, &state.goHistory, &state.relationCount,
	)
	if err != nil {
		return freshBaselineState{}, fmt.Errorf("fresh baseline適用前のDB状態を確認できません: %w", err)
	}
	return state, nil
}

const flywayFreshHistoryTableSQL = `CREATE TABLE feedback.flyway_schema_history (
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

const flywayFreshHistoryIndexSQL = `CREATE INDEX flyway_schema_history_s_idx
    ON feedback.flyway_schema_history (success);`

const flywayFreshHistoryRowsSQL = `INSERT INTO feedback.flyway_schema_history (
    installed_rank, version, description, type, script, checksum,
    installed_by, execution_time, success
) VALUES
    (0, NULL, '<< Flyway Schema Creation >>', 'SCHEMA', '"feedback"', NULL,
     current_user, 0, true),
    (1, '1', $2, 'SQL', $1, $3,
     current_user, 0, true)`
