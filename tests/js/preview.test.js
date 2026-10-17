import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadTs } from "./loadTs.mjs";

/**
 * Which renderer each file kind gets.
 *
 * The dispatch used to be a `switch` in one function, and a missing `break`
 * between `case "json":` and `case "parquet":` made every JSON file render
 * "This Parquet file could not be read." It is now a `v-if` chain in the panel, so
 * the same class of mistake is checked by reading the rendered branches: each
 * kind must reach the renderer that understands it, and json must never reach the
 * table renderer that only Parquet and CSV belong to.
 */
const panel = readFileSync(
  path.join(import.meta.dirname, "../../src/components/preview/PreviewPanel.vue"),
  "utf8",
);

/**
 * Split the panel's renderer chain into component blocks.
 *
 * Attributes are not in a fixed order (`:key` may precede `v-if`), so the tag is
 * matched first and its attributes are read from the whole block.
 */
function blocks() {
  const chain = panel.slice(panel.indexOf('<template v-else-if="data">'));
  const tags = [];
  const pattern = /<([A-Z][A-Za-z]*)([^>]*?)\/?>/g;
  for (const match of chain.matchAll(pattern)) {
    tags.push({ component: match[1], attributes: match[2] });
  }
  return tags;
}

/** `kind -> component` for every explicit branch in the chain. */
function dispatch() {
  const map = new Map();
  for (const { component, attributes } of blocks()) {
    if (!/v-(?:else-)?if=/.test(attributes)) continue;
    for (const kind of attributes.matchAll(/'([a-z]+)'/g)) {
      map.set(kind[1], component);
    }
  }
  return map;
}

test("each kind reaches the renderer that understands it", () => {
  const map = dispatch();
  assert.equal(map.get("image"), "PreviewImage");
  assert.equal(map.get("audio"), "PreviewMedia");
  assert.equal(map.get("video"), "PreviewMedia");
  // PDF has its own renderer: it needs zoom and page navigation, which an
  // embedded frame cannot provide.
  assert.equal(map.get("pdf"), "PreviewPdf");
  assert.equal(map.get("markdown"), "PreviewMarkdown");
  assert.equal(map.get("parquet"), "PreviewTable");
  assert.equal(map.get("csv"), "PreviewTable");
});

test("json never falls through into the table renderer", () => {
  const map = dispatch();
  // json has no branch of its own: it must reach the generic code renderer.
  assert.equal(map.get("json"), undefined, "json must not have its own branch");
  assert.notEqual(map.get("json"), "PreviewTable");
  // And the renderer it does reach is the one that highlights text.
  const fallback = blocks().filter((tag) => /v-else(?!-)/.test(tag.attributes));
  assert.deepEqual(
    fallback.map((tag) => tag.component),
    ["PreviewCode"],
    "the fallback renderer must be the code one",
  );
});

test("every renderer referenced by the panel exists", () => {
  const dir = path.join(import.meta.dirname, "../../src/components/preview/renderers");
  const available = new Set(readdirSync(dir).map((file) => file.replace(/\.vue$/, "")));
  for (const component of new Set(dispatch().values())) {
    assert.ok(available.has(component), `${component} is referenced but missing`);
  }
  assert.ok(available.has("PreviewCode"), "the fallback renderer must exist");
});

test("language resolution prefers the file name, then the extension", async () => {
  const { resolveLanguage } = await loadTs("src/lib/previewText.ts");
  assert.equal(resolveLanguage("a/b/table.py", "x = 1"), "python");
  assert.equal(resolveLanguage("a/Dockerfile", "FROM scratch"), "dockerfile");
  assert.equal(resolveLanguage("a/data.json", '{"a": 1}'), "json");
  assert.equal(resolveLanguage("a/config.yaml", "a: 1"), "yaml");
  // An unknown extension with plain content gets no language rather than a guess.
  assert.equal(resolveLanguage("a/blob.zzz", ""), null);
});

test("invalid JSON is not pretty-printed", async () => {
  const { tryPrettyJson } = await loadTs("src/lib/previewText.ts");
  assert.equal(tryPrettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(tryPrettyJson("{not json"), null);
  assert.equal(tryPrettyJson("plain text"), null);
});
