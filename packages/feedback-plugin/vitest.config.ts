import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testing/setup.ts"],
    // jsdomワーカーの同時起動で小さい開発環境が枯渇しないよう上限を固定する。
    maxWorkers: 2
  }
});
