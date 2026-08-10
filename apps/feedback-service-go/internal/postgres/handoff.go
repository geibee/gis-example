package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

// ValidateMigrationHandoff は起動時にFlyway所有境界、V6 marker、業務schemaを照合する。
// DDLは実行せず、handoff未完了またはdriftしたDBをfail-closedで拒否する。
func (d *Database) ValidateMigrationHandoff(ctx context.Context) error {
	rows, err := d.Query(ctx, `SELECT version, success
FROM feedback.flyway_schema_history
WHERE type = 'SQL' AND version IS NOT NULL
	ORDER BY installed_rank`)
	if err != nil {
		return fmt.Errorf("migration handoffのFlyway historyを取得できません: %w", err)
	}
	defer rows.Close()
	history := make([]migration.FlywayVersion, 0, migration.HandoffVersion)
	for rows.Next() {
		var rawVersion string
		var success bool
		if err := rows.Scan(&rawVersion, &success); err != nil {
			return fmt.Errorf("migration handoffのFlyway historyを読み取れません: %w", err)
		}
		version, err := strconv.ParseInt(rawVersion, 10, 64)
		if err != nil {
			return fmt.Errorf("migration handoffのFlyway versionが整数ではありません: %q", rawVersion)
		}
		history = append(history, migration.FlywayVersion{Version: version, Success: success})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("migration handoffのFlyway history走査に失敗しました: %w", err)
	}

	var marker migration.BaselineMarker
	err = d.QueryRow(ctx, `SELECT version, kind, state, checksum_sha256, schema_fingerprint_sha256
FROM feedback.go_schema_migrations
WHERE version = $1`, migration.HandoffVersion).Scan(
		&marker.Version, &marker.Kind, &marker.State, &marker.ChecksumSHA256, &marker.SchemaFingerprintSHA256,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return errors.New("V6 Go migration handoff markerがありません")
	}
	if err != nil {
		return fmt.Errorf("V6 Go migration handoff markerを取得できません: %w", err)
	}
	// V6 fingerprintはGo migrationを一度も適用していないhandoff境界だけで照合する。
	// V7以降は意図どおりschemaを変えるため、以後の完全性はversion/checksum/state台帳で検証する。
	var hasGoMigrations bool
	if err := d.QueryRow(ctx, `SELECT EXISTS (
    SELECT 1 FROM feedback.go_schema_migrations WHERE version >= 7
)`).Scan(&hasGoMigrations); err != nil {
		return fmt.Errorf("Go migration履歴を確認できません: %w", err)
	}
	fingerprint := ""
	if hasGoMigrations {
		if marker.SchemaFingerprintSHA256 != nil {
			fingerprint = *marker.SchemaFingerprintSHA256
		}
	} else {
		fingerprint, err = d.businessSchemaFingerprint(ctx)
		if err != nil {
			return err
		}
	}
	return migration.ValidateHandoff(history, marker, fingerprint)
}

func (d *Database) businessSchemaFingerprint(ctx context.Context) (string, error) {
	var signature strings.Builder
	err := d.InTransaction(ctx, func(txCtx context.Context, tx Tx) error {
		// pg_get_constraintdef、pg_indexes、regclass defaultの表記はsearch_path依存である。
		// 専用transactionへ固定し、接続userのrole設定にかかわらず同じsignatureを得る。
		if _, err := tx.Exec(txCtx, `SET LOCAL search_path = feedback, pg_catalog`); err != nil {
			return fmt.Errorf("schema fingerprint用search_pathを固定できません: %w", err)
		}
		rows, err := tx.Query(txCtx, businessSchemaSignatureSQL)
		if err != nil {
			return fmt.Errorf("業務schema signatureを取得できません: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				return fmt.Errorf("業務schema signatureを読み取れません: %w", err)
			}
			signature.WriteString(line)
			signature.WriteByte('\n')
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("業務schema signatureの走査に失敗しました: %w", err)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(signature.String()))
	return hex.EncodeToString(hash[:]), nil
}

const businessSchemaSignatureSQL = `SELECT signature
FROM (
    SELECT 'column|' || table_name || '|' || ordinal_position || '|' || column_name || '|' ||
           data_type || '|' || is_nullable || '|' || coalesce(column_default, '') AS signature
    FROM information_schema.columns
    WHERE table_schema = 'feedback'
      AND table_name NOT IN ('flyway_schema_history', 'go_schema_migrations')

    UNION ALL
    SELECT 'constraint|' || class.relname || '|' || constraint_name || '|' ||
           regexp_replace(
             regexp_replace(
               replace(replace(replace(
                 pg_get_constraintdef(constraint_row.oid),
                 '::character varying', ''),
                 '::text[]', ''),
                 '::text', ''),
               '\((''[^'']*'')\)', '\1', 'g'),
             'ANY \(\(ARRAY\[([^]]*)\]\)\)', 'ANY (ARRAY[\1])', 'g') AS signature
    FROM information_schema.table_constraints table_constraint
    JOIN pg_constraint constraint_row ON constraint_row.conname = table_constraint.constraint_name
    JOIN pg_class class ON class.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = class.relnamespace AND namespace.nspname = 'feedback'
    WHERE table_constraint.constraint_schema = 'feedback'
      AND class.relname NOT IN ('flyway_schema_history', 'go_schema_migrations')

    UNION ALL
    SELECT 'index|' || tablename || '|' || indexname || '|' ||
           regexp_replace(
             regexp_replace(
               replace(replace(replace(
                 indexdef,
                 '::character varying', ''),
                 '::text[]', ''),
                 '::text', ''),
               '\((''[^'']*'')\)', '\1', 'g'),
             'ANY \(\(ARRAY\[([^]]*)\]\)\)', 'ANY (ARRAY[\1])', 'g') AS signature
    FROM pg_indexes
    WHERE schemaname = 'feedback'
      AND tablename NOT IN ('flyway_schema_history', 'go_schema_migrations')
) signatures
ORDER BY signature COLLATE "C"`
