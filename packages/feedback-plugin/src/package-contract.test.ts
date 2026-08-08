import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("npmパッケージ契約", () => {
  it("ESM・型定義・CSSと指定peer dependencyを公開する", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      type: string;
      types: string;
      exports: Record<string, unknown>;
      peerDependencies: Record<string, string>;
      publishConfig: { access: string };
    };
    expect(packageJson.type).toBe("module");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.exports).toHaveProperty("./styles.css");
    expect(Object.keys(packageJson.peerDependencies).sort()).toEqual([
      "@tanstack/react-query", "maplibre-gl", "react", "react-dom"
    ]);
    expect(packageJson.publishConfig.access).toBe("restricted");
  });

  it("CSS変数を持ち、参照ホストがパッケージCSSを読み込む", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const hostEntry = readFileSync(resolve(process.cwd(), "../../apps/web/src/main.tsx"), "utf8");
    expect(css).toContain("--wfg-feedback-accent");
    expect(css).toContain("--wfg-feedback-z-panel");
    expect(hostEntry).toContain('import "@web-gis/feedback-plugin/styles.css"');
  });
});
