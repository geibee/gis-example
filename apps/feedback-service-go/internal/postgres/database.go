// Package postgres は PostgreSQL 接続と transaction 境界を提供する。
package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config は PostgreSQL pool の設定である。環境変数の解釈は上位層が担う。
type Config struct {
	URL               string
	User              string
	Password          string
	PoolSize          int
	ConnectionTimeout time.Duration
	StatementTimeout  time.Duration
}

// Tx は業務 query が transaction 内で利用できる最小インターフェースである。
// Begin を公開しないため、pgx の擬似nested transactionを暗黙には開始できない。
type Tx interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// TxFunc は同じ transaction に含める処理を表す。
type TxFunc func(ctx context.Context, tx Tx) error

// Transactor は application logic が依存する transaction 境界である。
type Transactor interface {
	InTransaction(ctx context.Context, fn TxFunc) error
}

type managedTx interface {
	Tx
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type pool interface {
	Begin(ctx context.Context) (managedTx, error)
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Ping(ctx context.Context) error
	Close()
}

type pgxPool struct {
	value *pgxpool.Pool
}

func (p *pgxPool) Begin(ctx context.Context) (managedTx, error) {
	return p.value.Begin(ctx)
}

func (p *pgxPool) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	return p.value.Exec(ctx, sql, arguments...)
}

func (p *pgxPool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return p.value.Query(ctx, sql, args...)
}

func (p *pgxPool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return p.value.QueryRow(ctx, sql, args...)
}

func (p *pgxPool) Ping(ctx context.Context) error {
	return p.value.Ping(ctx)
}

func (p *pgxPool) Close() {
	p.value.Close()
}

// Database は共有 pgx pool を所有する。
type Database struct {
	pool              pool
	connectionTimeout time.Duration
	closeOnce         sync.Once
}

// Open は設定を検証して pool を生成する。接続確認は Ping で明示的に行う。
func Open(ctx context.Context, settings Config) (*Database, error) {
	poolConfig, err := NewPoolConfig(settings)
	if err != nil {
		return nil, err
	}

	value, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("PostgreSQL poolを作成できません: %w", err)
	}

	return &Database{
		pool:              &pgxPool{value: value},
		connectionTimeout: settings.ConnectionTimeout,
	}, nil
}

// NewPoolConfig は pgxpool 設定を組み立てる。statement_timeout は各接続の
// startup parameterとして設定し、接続の再作成後も同じ値を保証する。
func NewPoolConfig(settings Config) (*pgxpool.Config, error) {
	if strings.TrimSpace(settings.URL) == "" {
		return nil, errors.New("database URLが未設定です")
	}
	if strings.TrimSpace(settings.User) == "" {
		return nil, errors.New("database userが未設定です")
	}
	if settings.Password == "" {
		return nil, errors.New("database passwordが未設定です")
	}
	if settings.PoolSize < 1 || settings.PoolSize > 1000 {
		return nil, errors.New("database pool sizeは1以上1000以下で指定してください")
	}
	if settings.ConnectionTimeout <= 0 {
		return nil, errors.New("database connection timeoutは正の値で指定してください")
	}
	if settings.StatementTimeout <= 0 || settings.StatementTimeout%time.Millisecond != 0 {
		return nil, errors.New("database statement timeoutは1ms単位の正の値で指定してください")
	}

	connectionURL := strings.TrimPrefix(settings.URL, "jdbc:")
	config, err := pgxpool.ParseConfig(connectionURL)
	if err != nil {
		// URL内に誤って資格情報が含まれていても、parse errorへ値を露出させない。
		return nil, errors.New("database URLが不正です")
	}
	config.ConnConfig.User = settings.User
	config.ConnConfig.Password = settings.Password
	config.ConnConfig.ConnectTimeout = settings.ConnectionTimeout
	config.ConnConfig.RuntimeParams["statement_timeout"] =
		fmt.Sprintf("%d", settings.StatementTimeout.Milliseconds())
	config.MaxConns = int32(settings.PoolSize)
	return config, nil
}

// Ping は connection timeout を上限としてDB接続を確認する。
func (d *Database) Ping(ctx context.Context) error {
	pingCtx, cancel := context.WithTimeout(ctx, d.connectionTimeout)
	defer cancel()
	if err := d.pool.Ping(pingCtx); err != nil {
		return fmt.Errorf("PostgreSQLへの接続確認に失敗しました: %w", err)
	}
	return nil
}

// Exec はtransaction外の単一statementを実行する。
func (d *Database) Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	return d.pool.Exec(ctx, sql, arguments...)
}

// Query はtransaction外のread queryを実行する。呼出側はRowsを必ず閉じる。
func (d *Database) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return d.pool.Query(ctx, sql, args...)
}

// QueryRow はtransaction外の単一行queryを実行する。
func (d *Database) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return d.pool.QueryRow(ctx, sql, args...)
}

// Close は pool を一度だけ閉じる。
func (d *Database) Close() {
	d.closeOnce.Do(d.pool.Close)
}
