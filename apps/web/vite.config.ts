import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // silent サインイン / renew の iframe が戻る最小ページ (auth.ts の silent_redirect_uri)
        "silent-renew": fileURLToPath(new URL("./silent-renew.html", import.meta.url))
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/health": "http://localhost:8080"
    }
  }
});
