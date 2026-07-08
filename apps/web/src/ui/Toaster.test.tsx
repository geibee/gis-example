// トースト (notifications.ts + ui/Toaster.tsx) のテスト。
// 種別ごとの role・複数同時表示・手動クローズ・自動消滅を検証する。
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, notify, notifyError, notifyInfo, notifySuccess } from "../notifications";
import { Toaster } from "./Toaster";

describe("Toaster", () => {
  it("成功・情報は role=status、エラーは role=alert で表示する", () => {
    render(<Toaster />);
    act(() => {
      notifySuccess("保存しました");
      notifyError("保存に失敗しました");
      notifyInfo("検索結果はありません");
    });

    const statuses = screen.getAllByRole("status");
    expect(statuses.map((node) => node.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("保存しました"), expect.stringContaining("検索結果はありません")])
    );
    expect(screen.getByRole("alert")).toHaveTextContent("保存に失敗しました");
  });

  it("複数のトーストを同時に表示し、閉じるボタンで個別に消せる", async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      notifySuccess("1 件目");
      notifySuccess("2 件目");
    });
    expect(screen.getByText("1 件目")).toBeInTheDocument();
    expect(screen.getByText("2 件目")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "通知を閉じる" })[0]);
    expect(screen.queryByText("1 件目")).not.toBeInTheDocument();
    expect(screen.getByText("2 件目")).toBeInTheDocument();
  });

  describe("自動消滅", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      clearToasts();
      vi.useRealTimers();
    });

    it("成功トーストは一定時間後に自動で消える", () => {
      render(<Toaster />);
      act(() => notifySuccess("自動で消える通知"));
      expect(screen.getByText("自動で消える通知")).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(4000));
      expect(screen.queryByText("自動で消える通知")).not.toBeInTheDocument();
    });

    it("エラートーストは成功より長く表示される", () => {
      render(<Toaster />);
      act(() => notifyError("エラー通知"));
      act(() => vi.advanceTimersByTime(4000));
      expect(screen.getByText("エラー通知")).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(4000));
      expect(screen.queryByText("エラー通知")).not.toBeInTheDocument();
    });
  });

  it("表示上限を超えたら古いトーストから閉じる", () => {
    render(<Toaster />);
    act(() => {
      for (let i = 1; i <= 6; i++) notify(`通知 ${i}`);
    });
    expect(screen.queryByText("通知 1")).not.toBeInTheDocument();
    expect(screen.getByText("通知 2")).toBeInTheDocument();
    expect(screen.getByText("通知 6")).toBeInTheDocument();
  });
});
