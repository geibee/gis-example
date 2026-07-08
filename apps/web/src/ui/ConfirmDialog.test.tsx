// ConfirmDialog (window.confirm 置き換え) のテスト。
// Promise の解決値・Esc キャンセル・フォーカス移動 (トラップ) を検証する。
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";

describe("confirmDialog", () => {
  it("実行ボタンで true、キャンセルボタンで false に解決する", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const confirmed = confirmDialog({ title: "削除の確認", message: "本当に削除しますか", confirmLabel: "削除", danger: true });
    const dialog = await screen.findByRole("alertdialog", { name: "削除の確認" });
    expect(dialog).toHaveTextContent("本当に削除しますか");

    await user.click(screen.getByRole("button", { name: "削除" }));
    await expect(confirmed).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    const cancelled = confirmDialog({ message: "もう一度確認します" });
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "キャンセル" }));
    await expect(cancelled).resolves.toBe(false);
  });

  it("Esc キーでキャンセル (false) になる", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const confirmed = confirmDialog({ message: "Esc で閉じる" });
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await expect(confirmed).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("開いたときキャンセルボタンへフォーカスし、Tab がダイアログ内で循環する", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">外のボタン</button>
        <ConfirmDialogHost />
      </>
    );

    void confirmDialog({ message: "フォーカス確認", confirmLabel: "実行" });
    await screen.findByRole("alertdialog");
    const cancel = screen.getByRole("button", { name: "キャンセル" });
    const run = screen.getByRole("button", { name: "実行" });
    expect(cancel).toHaveFocus();

    await user.tab();
    expect(run).toHaveFocus();
    // 最後の要素から先頭へ循環する (ダイアログの外へ出ない)
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(run).toHaveFocus();

    await user.keyboard("{Escape}");
  });

  it("ホスト未マウントなら false に解決してブロックしない", async () => {
    await expect(confirmDialog({ message: "ホストなし" })).resolves.toBe(false);
  });
});
