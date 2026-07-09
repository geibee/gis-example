import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// 一覧画面共通の型付きテーブル。列定義 (render) を宣言的に渡す薄い共通化で、
// 行クリック選択・選択行ハイライト・件数表示・クライアントページングを備える。
// ソートやサーバページングが必要になった時点で TanStack Table への置き換えを検討する
// (props の形はその移行を想定して列定義ベースにしている)。
export type DataTableColumn<TRow> = {
  /** 列の安定キー (React key) */
  key: string;
  header: ReactNode;
  render: (row: TRow) => ReactNode;
};

export type DataTableProps<TRow> = {
  columns: Array<DataTableColumn<TRow>>;
  rows: TRow[];
  rowKey: (row: TRow) => string;
  /** 指定すると行クリックで呼ばれる (一覧 → 詳細遷移) */
  onRowClick?: (row: TRow) => void;
  /** rowKey が一致する行に .active を付ける (選択行ハイライト) */
  selectedRowKey?: string | null;
  /** 行ごとの追加クラス (例: 無効ユーザーのグレーアウト) */
  rowClassName?: (row: TRow) => string | undefined;
  /** 0 件時に表の下へ出す文言 */
  emptyMessage: string;
  /** 1 ページの行数。指定すると件数がこれを超えたときページャを出す */
  pageSize?: number;
  /** 既定は業務一覧の "business-table"。管理画面は "admin-table" 等を渡す */
  tableClassName?: string;
  /** 横スクロールコンテナ (business-table-scroll) で包むか。既定 true */
  scroll?: boolean;
};

export function DataTable<TRow>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedRowKey,
  rowClassName,
  emptyMessage,
  pageSize,
  tableClassName = "business-table",
  scroll = true
}: DataTableProps<TRow>) {
  const [rawPage, setPage] = useState(0);
  const paged = Boolean(pageSize && rows.length > pageSize);
  const pageCount = paged ? Math.ceil(rows.length / pageSize!) : 1;
  // 検索条件の変更などで件数が減ったときは範囲内へ丸める
  const page = Math.min(rawPage, pageCount - 1);
  const pageRows = paged ? rows.slice(page * pageSize!, (page + 1) * pageSize!) : rows;

  const table = (
    <table className={tableClassName}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key}>{column.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {pageRows.map((row) => {
          const key = rowKey(row);
          const classes = [selectedRowKey === key ? "active" : "", rowClassName?.(row) ?? ""]
            .filter(Boolean)
            .join(" ");
          return (
            <tr
              key={key}
              className={classes || undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <>
      {scroll ? <div className="business-table-scroll">{table}</div> : table}
      {rows.length ? (
        <div className="table-footer">
          <span className="table-count">全 {rows.length.toLocaleString()} 件</span>
          {paged ? (
            <nav className="table-pagination" aria-label="ページ切り替え">
              <button
                className="subtle-button"
                type="button"
                aria-label="前のページ"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span aria-live="polite">
                {page + 1} / {pageCount}
              </span>
              <button
                className="subtle-button"
                type="button"
                aria-label="次のページ"
                disabled={page >= pageCount - 1}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={14} />
              </button>
            </nav>
          ) : null}
        </div>
      ) : (
        <p className="empty-state">{emptyMessage}</p>
      )}
    </>
  );
}
