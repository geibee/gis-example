import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// vite.config.ts (プラグイン等) を土台に test 設定だけを重ねる。
// 実行は `npm run test --workspace apps/web` (vitest run)。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["src/testing/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
      env: {
        // api.ts の API_BASE。jsdom + Node fetch は相対 URL を解決できないため
        // 絶対 URL を与える (MSW ハンドラ側はホスト非依存の "*/api/..." で受ける)
        VITE_API_BASE: "http://api.test"
      },
      coverage: {
        // 計測のみ導入する (閾値ゲートはテスト資産が育ってから)。
        provider: "v8",
        reporter: ["text-summary", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/contracts/**", "src/testing/**", "src/**/*.test.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"]
      }
    }
  })
);
