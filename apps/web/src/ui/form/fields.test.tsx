// フォーム共通フィールド (ui/form/fields.tsx) のテスト。
// ラベル関連付け・必須マーク・エラー表示と aria 属性 (invalid / describedby) を検証する。
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectField, TextAreaField, TextField } from "./fields";

describe("TextField", () => {
  it("ラベルで入力欄を特定でき、required で必須マークと aria-required が付く", () => {
    render(<TextField label="名称" required defaultValue="山田太郎" />);
    const input = screen.getByLabelText(/名称/);
    expect(input).toHaveValue("山田太郎");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("error を渡すとエラー文言が role=alert で表示され、入力欄と aria で紐づく", () => {
    render(<TextField label="名称" error="名称を入力してください" />);
    const input = screen.getByLabelText(/名称/);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("名称を入力してください");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
  });

  it("error がなければ aria-invalid を付けない", () => {
    render(<TextField label="名称" />);
    expect(screen.getByLabelText(/名称/)).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("TextAreaField", () => {
  it("複数行入力としてレンダリングされ、エラー表示も共通の形になる", () => {
    render(<TextAreaField label="メモ" error="メモが長すぎます" />);
    const textarea = screen.getByLabelText(/メモ/);
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("メモが長すぎます");
  });
});

describe("SelectField", () => {
  it("options と空選択肢を描画する", () => {
    render(<SelectField label="種別" options={["法人", "個人"]} emptyLabel="選択" />);
    const select = screen.getByLabelText(/種別/);
    expect(select.tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "選択" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "法人" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "個人" })).toBeInTheDocument();
  });

  it("options にない現在値 (currentValue) を選択肢として補う", () => {
    render(<SelectField label="種別" options={["法人", "個人"]} currentValue="行政" defaultValue="行政" />);
    expect(screen.getByRole("option", { name: "行政" })).toBeInTheDocument();
    expect(screen.getByLabelText(/種別/)).toHaveValue("行政");
  });
});
