import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { parseDelimited, detectDelimiter } = await loadTs("src/lib/previewText.ts");

test("parses a simple CSV", () => {
  assert.deepEqual(parseDelimited("a,b\n1,2\n", ","), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("handles quoted fields, escaped quotes and embedded newlines", () => {
  assert.deepEqual(parseDelimited('a,"b,still b"\n"x""y",z\n', ","), [
    ["a", "b,still b"],
    ['x"y', "z"],
  ]);
  assert.deepEqual(parseDelimited('id,note\n1,"line1\nline2"\n', ","), [
    ["id", "note"],
    ["1", "line1\nline2"],
  ]);
});

test("keeps empty trailing fields and drops empty rows", () => {
  assert.deepEqual(parseDelimited("a,b\n1,\n", ","), [
    ["a", "b"],
    ["1", ""],
  ]);
  assert.deepEqual(parseDelimited("a,b", ","), [["a", "b"]]);
});

test("handles CRLF line endings", () => {
  assert.deepEqual(parseDelimited("a,b\r\n1,2\r\n", ","), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("detects the delimiter from the first line", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(detectDelimiter("single\ncolumn"), ",");
});
