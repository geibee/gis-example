package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrNestedTransaction は既存transactionのcontextから新しいtransactionを
// 暗黙に開始しようとした場合に返す。
var ErrNestedTransaction = errors.New("nested transactionは明示的にサポートされていません")

type transactionContextKey struct{}

// InTransaction はcallback成功時だけcommitする。errorとpanicではrollbackし、
// commit失敗は成功として扱わない。
func (d *Database) InTransaction(ctx context.Context, fn TxFunc) error {
	if fn == nil {
		return errors.New("transaction callbackが未設定です")
	}
	if ctx.Value(transactionContextKey{}) != nil {
		return ErrNestedTransaction
	}

	beginCtx, cancel := context.WithTimeout(ctx, d.connectionTimeout)
	tx, err := d.pool.Begin(beginCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("transactionを開始できません: %w", err)
	}

	txCtx := context.WithValue(ctx, transactionContextKey{}, struct{}{})
	defer func() {
		if recovered := recover(); recovered != nil {
			// panicを置き換えない。rollbackエラーはprocessの元の障害より優先しない。
			_ = d.rollback(ctx, tx)
			panic(recovered)
		}
	}()

	if err := fn(txCtx, tx); err != nil {
		rollbackErr := d.rollback(ctx, tx)
		if rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			return errors.Join(err, fmt.Errorf("transactionのrollbackに失敗しました: %w", rollbackErr))
		}
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("transactionのcommitに失敗しました: %w", err)
	}
	return nil
}

func (d *Database) rollback(ctx context.Context, tx managedTx) error {
	rollbackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.connectionTimeout)
	defer cancel()
	return tx.Rollback(rollbackCtx)
}
