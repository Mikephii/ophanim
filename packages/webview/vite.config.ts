import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { resolve } from "path";
import { serveOphanDb } from "./vite-plugin-db";

export default defineConfig({
  plugins: [serveOphanDb(), viteTsConfigPaths(), tailwindcss(), react()],
  server: {
    port: 5173,
    strictPort: true,
    // Allow VS Code webview to connect
    cors: true,
    hmr: {
      port: 5173,
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
      output: {
        entryFileNames: "webview.js",
        assetFileNames: "webview.[ext]",
      },
    },
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1000,
  },
  define: {
    "process.env": {},
  },
  esbuild: {
    jsx: "automatic",
  },
});
