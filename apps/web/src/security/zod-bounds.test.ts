// CVE-2023-54404: 明示した上限を要素検証より先に評価する修正版の回帰テスト。
// 上限なしのコンテナは更新だけでは保護されないため、今後追加するときも上限を宣言する。
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("Zod のコンテナ上限", () => {
  it("上限を超えた配列は要素を走査せず、1 件のサイズエラーで拒否する", () => {
    const parseElement = vi.fn((value: unknown) => value);
    const schema = z.array(z.preprocess(parseElement, z.string())).max(10);
    const result = schema.safeParse(Array(1_000).fill(0));

    expect(result.success).toBe(false);
    expect(parseElement).not.toHaveBeenCalled();
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0].code).toBe("too_big");
    }
  });

  it("上限内の配列は従来どおり要素を検証する", () => {
    const schema = z.array(z.string()).max(2);
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse(["a", 1]).success).toBe(false);
  });
});
