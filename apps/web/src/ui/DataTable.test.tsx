// DataTable (共通一覧テーブル) の単体テスト。
// 列定義の描画・行クリック・選択行ハイライト・空メッセージ・件数表示・ページングを検証する。
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

type Row = { id: string; name: string };

const columns: Array<DataTableColumn<Row>> = [
  { key: "id", header: "ID", render: (row) => row.id },
  { key: "name", header: "名称", render: (row) => row.name }
];

const makeRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `R-${index + 1}`, name: `行 ${index + 1}` }));

describe("DataTable", () => {
  it("列定義どおりにヘッダとセルを描画し、件数を表示する", () => {
    render(<DataTable columns={columns} rows={makeRows(2)} rowKey={(row) => row.id} emptyMessage="なし" />);

    expect(screen.getByRole("columnheader", { name: "ID" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "名称" })).toBeInTheDocument();
    expect(screen.getByText("行 1")).toBeInTheDocument();
    expect(screen.getByText("行 2")).toBeInTheDocument();
    expect(screen.getByText("全 2 件")).toBeInTheDocument();
  });

  it("行クリックで onRowClick が行データ付きで呼ばれ、選択行に active が付く", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={makeRows(2)}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
        selectedRowKey="R-2"
        emptyMessage="なし"
      />
    );

    await user.click(screen.getByText("行 1"));
    expect(onRowClick).toHaveBeenCalledWith({ id: "R-1", name: "行 1" });

    const selectedRow = screen.getByText("行 2").closest("tr");
    expect(selectedRow).toHaveClass("active");
    expect(screen.getByText("行 1").closest("tr")).not.toHaveClass("active");
  });

  it("0 件のときは空メッセージを表示し、件数・ページャは出さない", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(row) => row.id} emptyMessage="データはありません" />);
    expect(screen.getByText("データはありません")).toBeInTheDocument();
    expect(screen.queryByText(/全 .* 件/)).not.toBeInTheDocument();
  });

  it("pageSize を超えるとページングされ、前後ボタンでページを移動できる", async () => {
    const user = userEvent.setup();
    render(
      <DataTable columns={columns} rows={makeRows(5)} rowKey={(row) => row.id} emptyMessage="なし" pageSize={2} />
    );

    // 1 ページ目: 先頭 2 行のみ
    expect(screen.getByText("行 1")).toBeInTheDocument();
    expect(screen.queryByText("行 3")).not.toBeInTheDocument();
    expect(screen.getByText("全 5 件")).toBeInTheDocument();
    const pagination = screen.getByRole("navigation", { name: "ページ切り替え" });
    expect(within(pagination).getByText("1 / 3")).toBeInTheDocument();
    expect(within(pagination).getByRole("button", { name: "前のページ" })).toBeDisabled();

    await user.click(within(pagination).getByRole("button", { name: "次のページ" }));
    expect(screen.getByText("行 3")).toBeInTheDocument();
    expect(screen.queryByText("行 1")).not.toBeInTheDocument();

    await user.click(within(pagination).getByRole("button", { name: "次のページ" }));
    expect(screen.getByText("行 5")).toBeInTheDocument();
    expect(within(pagination).getByRole("button", { name: "次のページ" })).toBeDisabled();
  });

  it("件数が pageSize 以下ならページャを出さず全件表示する", () => {
    render(
      <DataTable columns={columns} rows={makeRows(2)} rowKey={(row) => row.id} emptyMessage="なし" pageSize={50} />
    );
    expect(screen.getByText("行 2")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "ページ切り替え" })).not.toBeInTheDocument();
  });

  it("表示中のページより件数が減ったら範囲内のページへ丸める", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DataTable columns={columns} rows={makeRows(5)} rowKey={(row) => row.id} emptyMessage="なし" pageSize={2} />
    );
    const pagination = screen.getByRole("navigation", { name: "ページ切り替え" });
    await user.click(within(pagination).getByRole("button", { name: "次のページ" }));
    await user.click(within(pagination).getByRole("button", { name: "次のページ" }));
    expect(screen.getByText("行 5")).toBeInTheDocument();

    // 検索条件の変更などで 3 件へ減少 → 3 ページ目は存在しないため 2 ページ目へ
    rerender(
      <DataTable columns={columns} rows={makeRows(3)} rowKey={(row) => row.id} emptyMessage="なし" pageSize={2} />
    );
    expect(screen.getByText("行 3")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });
});
