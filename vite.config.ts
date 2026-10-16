import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// The Tauri config points `frontendDist` at `dist/`, so Vite writes there too.
// `pnpm tauri dev` runs `build:frontend` first and then loads the built assets,
// which keeps a single build path for both development and packaging.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["safari16", "chrome110", "firefox115"],
    // One chunk keeps the webview startup simple: no module waterfall to wait on.
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
    sourcemap: false,
    minify: "esbuild",
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
