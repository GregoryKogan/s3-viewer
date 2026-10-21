import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// The Tauri config points `frontendDist` at `dist/`, so Vite writes there too.
// `pnpm tauri dev` runs `build:frontend` first and then loads the built assets,
// which keeps a single build path for both development and packaging.
export default defineConfig({
  // Relative asset URLs: Tauri serves the bundle from a custom protocol root.
  base: "./",
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["safari16", "chrome110", "firefox115"],
    // Content-hashed names. A fixed `app.js` is served from the webview's HTTP
    // cache across builds, so a user updating the app would keep seeing the
    // previous interface until the cache expired.
    sourcemap: false,
    minify: "esbuild",
  },
});
