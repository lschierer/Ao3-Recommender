import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // Treat src/ as root so panel/index.html outputs to dist/panel/index.html
  root: resolve(__dirname, "src"),
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    // No code-splitting — extension scripts must be self-contained
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        panel: resolve(__dirname, "src/panel/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
});
