import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

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

test("find-in-file is offered only where the file's text is on screen", async () => {
  const { isPreviewSearchable } = await loadTs("src/lib/previewText.ts");
  // Kept in sync by hand: there is no runtime list of kinds, so this table is
  // the record of the decision for each of them.
  const expected = {
    text: true,
    code: true,
    json: true,
    // Rendered Markdown shows markup, not the source; only Raw has text to find.
    markdown: { rendered: false, raw: true },
    image: false,
    audio: false,
    video: false,
    pdf: false,
    csv: false,
    parquet: false,
    archive: false,
    binary: false,
    folder: false,
    unknown: false,
  };
  for (const [kind, value] of Object.entries(expected)) {
    for (const view of ["rendered", "raw"]) {
      const want = typeof value === "boolean" ? value : value[view];
      assert.equal(isPreviewSearchable(kind, view), want, `${kind} in the ${view} view`);
    }
  }
});
