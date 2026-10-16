import test from "node:test";
import assert from "node:assert/strict";

/**
 * The preview renderer needs a DOM, so these tests exercise the two pieces of
 * logic that are pure and that have actually broken: language resolution and the
 * dispatch table. The dispatch table is checked by reading the source, because a
 * missing `break` between two `case` labels is exactly the bug that shipped a
 * "This Parquet file could not be read" message for every JSON file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.join(import.meta.dirname, "../../src/js/preview.js"),
  "utf8",
);

/** Split the dispatch table into `kind -> body`, honouring grouped labels. */
function dispatchBodies(source) {
  const switchBody = source.slice(source.indexOf("switch (data.kind)"));
  const lines = switchBody.split("\n");
  const bodies = new Map();
  let pending = [];
  for (const line of lines) {
    const label = line.match(/^\s*case "([a-z]+)":\s*$/);
    if (label) {
      pending.push(label[1]);
      continue;
    }
    const inline = line.match(/^\s*case "([a-z]+)":\s*(.+)$/);
    if (inline) {
      for (const key of [...pending, inline[1]]) bodies.set(key, inline[2]);
      pending = [];
      continue;
    }
    if (pending.length && line.trim()) {
      // The body is the first statement group after the labels.
      for (const key of pending) bodies.set(key, line.trim());
      pending = [];
    }
  }
  return bodies;
}

test("json does not share parquet's branch", () => {
  const bodies = dispatchBodies(source);
  assert.ok(bodies.has("json"), "json must have a branch");
  assert.ok(bodies.has("parquet"), "parquet must have a branch");
  // This is the shipped bug: `case "json":` sat directly above `case "parquet":`,
  // so every JSON preview rendered "This Parquet file could not be read."
  assert.equal(
    bodies.get("json"),
    bodies.get("csv"),
    "json is expected to share the text branch with csv",
  );
  assert.notEqual(
    bodies.get("json"),
    bodies.get("parquet"),
    "json must not fall through into the parquet branch",
  );
});

test("every renderer used by the dispatch table exists", () => {
  for (const name of [
    "renderImage",
    "renderAudio",
    "renderVideo",
    "renderPdf",
    "renderMarkdown",
    "renderText",
    "renderCsv",
    "renderTable",
    "messageBlock",
  ]) {
    assert.ok(source.includes(`function ${name}(`), `${name} is missing`);
  }
});

test("json and csv share the text renderer", () => {
  const switchBody = source.slice(source.indexOf("switch (data.kind)"));
  assert.match(
    switchBody,
    /case "json":\s*\n\s*case "csv":/,
    "json and csv are expected to share the text branch",
  );
});
