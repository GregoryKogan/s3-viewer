import path from "node:path";
import esbuild from "esbuild";

/**
 * Load a TypeScript module from the app source inside a Node test.
 *
 * The tests run under plain Node, which cannot resolve the `@/` alias or the
 * browser-targeted dependencies the source uses. Bundling with esbuild — already
 * a build dependency — keeps the tests pointed at the real source files instead
 * of at a copy that could drift.
 */
export async function loadTs(relativePath) {
  const root = path.resolve(import.meta.dirname, "../..");
  const result = await esbuild.build({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    alias: { "@": path.join(root, "src") },
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
