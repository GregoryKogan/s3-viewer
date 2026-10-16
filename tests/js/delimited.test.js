import test from "node:test";
import assert from "node:assert/strict";
import { parseDelimited } from "../../src/js/preview.js";

test("parses a simple CSV", () => {
  assert.deepEqual(parseDelimited("a,b\n1,2\n", ","), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("handles quoted fields, escaped quotes and embedded newlines", () => {
  const csv = 'name,note\n"Smith, John","line1\nline2"\n"say ""hi""",ok\n';
  assert.deepEqual(parseDelimited(csv, ","), [
    ["name", "note"],
    ["Smith, John", "line1\nline2"],
    ['say "hi"', "ok"],
  ]);
});

test("parses TSV with tabs", () => {
  assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("keeps a trailing empty field", () => {
  assert.deepEqual(parseDelimited("a,b,\n", ","), [["a", "b", ""]]);
});

test("handles CRLF", () => {
  assert.deepEqual(parseDelimited("a,b\r\n1,2\r\n", ","), [
    ["a", "b"],
    ["1", "2"],
  ]);
});
