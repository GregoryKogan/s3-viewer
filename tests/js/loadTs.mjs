import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load a TypeScript module from the app source inside a Node test.
 *
 * Node strips the types itself; all it cannot do is resolve the `@/` alias or an
 * import without an extension. One resolve hook covers both, so a test imports
 * the real source file instead of a bundled copy that could drift.
 */
const root = path.resolve(import.meta.dirname, "../..");

/** The file a bundler would pick for an extensionless path. */
function resolveFile(base) {
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return pathToFileURL(base).href;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(resolveFile(path.join(root, "src", specifier.slice(2))), context);
    }
    return nextResolve(specifier, context);
  },
});

export async function loadTs(relativePath) {
  return import(resolveFile(path.join(root, relativePath)));
}
