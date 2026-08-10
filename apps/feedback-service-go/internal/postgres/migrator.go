package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

const migrationAdvisoryLockID int64 = 7736690273395016450

type appliedGoMigration struct {
	Version     int64
	Description string
	Checksum    string
	State       string
}

// ApplyGoMigrations は専用connectionのsession advisory lock下で、各SQLを個別transactionへ適用する。
func (d *Database) ApplyGoMigrations(ctx context.Context, definitions []migration.Definition) error {
	if err := validateMigrationDefinitions(definitions); err != nil {
		return err
	}
	productionPool, ok := d.pool.(*pgxPool)
	if !ok {
		return errors.New("migration runnerは実PostgreSQL poolでのみ実行できます")
	}
	acquireCtx, cancel := context.WithTimeout(ctx, d.connectionTimeout)
	connection, err := productionPool.value.Acquire(acquireCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("migration用connectionを取得できません: %w", err)
	}
	defer connection.Release()
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationAdvisoryLockID); err != nil {
		return fmt.Errorf("migration advisory lockを取得できません: %w", err)
	}
	defer func() {
		unlockCtx, unlockCancel := context.WithTimeout(context.WithoutCancel(ctx), d.connectionTimeout)
		defer unlockCancel()
		var unlocked bool
		_ = connection.QueryRow(unlockCtx, `SELECT pg_advisory_unlock($1)`, migrationAdvisoryLockID).Scan(&unlocked)
	}()

	applied, err := readAppliedGoMigrations(ctx, connection)
	if err != nil {
		return err
	}
	pending, err := reconcileGoMigrations(definitions, applied)
	if err != nil {
		return err
	}
	for _, definition := range pending {
		if err := applyGoMigration(ctx, connection, definition); err != nil {
			return err
		}
	}
	return nil
}

func readAppliedGoMigrations(
	ctx context.Context, connection interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
	},
) ([]appliedGoMigration, error) {
	rows, err := connection.Query(ctx, `SELECT version, description, checksum_sha256, state
	FROM feedback.go_schema_migrations WHERE version >= 7 ORDER BY version`)
	if err != nil {
		return nil, fmt.Errorf("適用済みGo migration履歴を取得できません: %w", err)
	}
	defer rows.Close()
	result := make([]appliedGoMigration, 0)
	for rows.Next() {
		var item appliedGoMigration
		if err := rows.Scan(&item.Version, &item.Description, &item.Checksum, &item.State); err != nil {
			return nil, fmt.Errorf("適用済みGo migration履歴を読めません: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("適用済みGo migration履歴を列挙できません: %w", err)
	}
	return result, nil
}

func reconcileGoMigrations(
	definitions []migration.Definition, applied []appliedGoMigration,
) ([]migration.Definition, error) {
	if len(applied) > len(definitions) {
		return nil, errors.New("DBにbinaryが認識しないGo migrationがあります")
	}
	for index, item := range applied {
		definition := definitions[index]
		if item.Version != definition.Version || item.Description != definition.Description ||
			item.Checksum != definition.Checksum {
			return nil, fmt.Errorf("適用済みGo migration V%dの履歴またはchecksumが一致しません", item.Version)
		}
		if item.State != "succeeded" {
			return nil, fmt.Errorf("適用済みGo migration V%dが%s状態です", item.Version, item.State)
		}
	}
	return definitions[len(applied):], nil
}

func applyGoMigration(ctx context.Context, connection interface {
	Begin(context.Context) (pgx.Tx, error)
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, definition migration.Definition) error {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return fmt.Errorf("対象Go migration V%dのtransactionを開始できません: %w", definition.Version, err)
	}
	rollback := func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }
	if _, err := tx.Exec(ctx, `INSERT INTO feedback.go_schema_migrations
    (version, description, kind, checksum_sha256, state)
VALUES ($1, $2, 'migration', $3, 'started')`,
		definition.Version, definition.Description, definition.Checksum,
	); err != nil {
		rollback()
		return fmt.Errorf("対象Go migration V%dの開始を記録できません: %w", definition.Version, err)
	}
	if _, err := tx.Exec(ctx, definition.SQL); err != nil {
		rollback()
		if recordErr := recordFailedGoMigration(ctx, connection, definition); recordErr != nil {
			return errors.Join(fmt.Errorf("対象Go migration V%dを適用できません: %w", definition.Version, err), recordErr)
		}
		return fmt.Errorf("対象Go migration V%dを適用できません: %w", definition.Version, err)
	}
	if _, err := tx.Exec(ctx, `UPDATE feedback.go_schema_migrations
SET state = 'succeeded', completed_at = now() WHERE version = $1 AND state = 'started'`, definition.Version); err != nil {
		rollback()
		return fmt.Errorf("対象Go migration V%dの完了を記録できません: %w", definition.Version, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("対象Go migration V%dをcommitできません: %w", definition.Version, err)
	}
	return nil
}

func recordFailedGoMigration(ctx context.Context, connection interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, definition migration.Definition) error {
	_, err := connection.Exec(ctx, `INSERT INTO feedback.go_schema_migrations
    (version, description, kind, checksum_sha256, state, completed_at)
VALUES ($1, $2, 'migration', $3, 'failed', now())`,
		definition.Version, definition.Description, definition.Checksum,
	)
	if err != nil {
		return fmt.Errorf("対象Go migration V%dの失敗を記録できません: %w", definition.Version, err)
	}
	return nil
}

func validateMigrationDefinitions(definitions []migration.Definition) error {
	for index, definition := range definitions {
		expected := migration.HandoffVersion + 1 + int64(index)
		if definition.Version != expected || definition.Description == "" ||
			len(definition.Checksum) != 64 || definition.SQL == "" {
			return fmt.Errorf("対象Go migration definitionが不正です: index=%d version=%d", index, definition.Version)
		}
	}
	return nil
}
