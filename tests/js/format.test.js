import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { humanSize, humanDate, prefixSegments, extensionOf, leafName, pluralize, s3Uri } =
  await loadTs("src/lib/format.ts");
const { kindLabel, detectKind, kindFromPath } = await loadTs("src/lib/fileKind.ts");

test("humanSize covers the unit ladder", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(999), "999 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  assert.equal(humanSize(1024 * 1024), "1.0 MB");
  assert.equal(humanSize(1024 ** 3 * 2.5), "2.5 GB");
  assert.equal(humanSize(1024 ** 4), "1.0 TB");
});

test("humanSize is defensive about missing sizes", () => {
  assert.equal(humanSize(null), "—");
  assert.equal(humanSize(undefined), "—");
  assert.equal(humanSize(-5), "—");
});

test("humanDate is relative for recent values and absolute for old ones", () => {
  const now = Date.now();
  assert.equal(humanDate(new Date(now - 5_000).toISOString()), "just now");
  assert.equal(humanDate(new Date(now - 5 * 60_000).toISOString()), "5m ago");
  assert.equal(humanDate(new Date(now - 3 * 3_600_000).toISOString()), "3h ago");
  assert.equal(humanDate(new Date(now - 2 * 86_400_000).toISOString()), "2d ago");
  assert.equal(humanDate(null), "—");
  assert.equal(humanDate("not a date"), "not a date");
});

test("kindLabel has a fallback for anything unrecognised", () => {
  assert.equal(kindLabel("image"), "Image");
  assert.equal(kindLabel("parquet"), "Parquet");
  assert.equal(kindLabel("something-new"), "File");
});

test("detectKind mirrors the Rust classification", () => {
  assert.equal(detectKind("a/b/"), "folder");
  assert.equal(detectKind("x", { isFolder: true }), "folder");
  assert.equal(detectKind("a/photo.JPG"), "image");
  assert.equal(detectKind("a/table.parquet"), "parquet");
  assert.equal(detectKind("a/data.csv"), "csv");
  assert.equal(detectKind("a/doc.md"), "markdown");
  assert.equal(detectKind("a/app.py"), "code");
  assert.equal(detectKind("a/conf.yaml"), "code");
  assert.equal(detectKind("a/notes.txt"), "text");
  // An unknown extension is "unknown", not "binary": the backend sniffs the
  // bytes, and the list must not claim more than it knows.
  assert.equal(detectKind("a/unknown.zzz"), "unknown");
  assert.equal(detectKind("keys/id_rsa"), "unknown");
  assert.equal(detectKind("a/blob", { contentType: "application/octet-stream" }), "unknown");
  assert.equal(detectKind("Dockerfile"), "code");
  // No extension and no known type: the content type is the only hint left.
  assert.equal(detectKind("a/blob", { contentType: "application/pdf" }), "pdf");
  assert.equal(kindFromPath("/tmp/holiday.png"), "image");
});

test("prefixSegments builds cumulative prefixes", () => {
  assert.deepEqual(prefixSegments(""), []);
  assert.deepEqual(prefixSegments("a/"), [{ name: "a", prefix: "a/" }]);
  assert.deepEqual(prefixSegments("a/b/"), [
    { name: "a", prefix: "a/" },
    { name: "b", prefix: "a/b/" },
  ]);
});

test("leafName and extensionOf handle folders and dotted names", () => {
  assert.equal(leafName("a/b/c.png"), "c.png");
  assert.equal(leafName("a/b/"), "b");
  assert.equal(extensionOf("a/b/c.PNG"), "png");
  assert.equal(extensionOf("Makefile"), "");
  assert.equal(extensionOf(".env"), "");
});

test("s3Uri and pluralize", () => {
  assert.equal(s3Uri("bucket", "path/to/key"), "s3://bucket/path/to/key");
  assert.equal(pluralize(1, "file", "files"), "file");
  assert.equal(pluralize(0, "file", "files"), "files");
});
