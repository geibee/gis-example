import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "feedback-plugin.js"
    },
    cssCodeSplit: false,
    rollupOptions: {
      external: [
        "react",
        "react/jsx-runtime",
        "react-dom",
        "@tanstack/react-query",
        "maplibre-gl",
        "html-to-image"
      ],
      output: {
        assetFileNames: (assetInfo) => assetInfo.name === "style.css" ? "styles.css" : "[name][extname]"
      }
    }
  }
});
