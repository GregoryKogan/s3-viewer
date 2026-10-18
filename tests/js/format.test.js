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

// Local-time constructors: the formatter shows the user's wall clock, so the
// fixtures must move with the machine's time zone rather than UTC.
const local = (...parts) => new Date(...parts).toISOString();

test("humanDate names today and yesterday with the local time", () => {
  const now = new Date(2025, 9, 12, 15, 30);
  assert.equal(humanDate(local(2025, 9, 12, 9, 5), now), "Today 09:05");
  assert.equal(humanDate(local(2025, 9, 12, 0, 0, 0, 0), now), "Today 00:00");
  assert.equal(humanDate(local(2025, 9, 11, 23, 59, 59), now), "Yesterday 23:59");
  // Seconds are deliberately dropped: two dates must be comparable at a glance.
  assert.equal(humanDate(local(2025, 9, 12, 9, 5, 59), now), "Today 09:05");
});

test("humanDate is absolute outside today and yesterday", () => {
  const now = new Date(2025, 9, 12, 15, 30);
  // The same year drops the year; any other year keeps it.
  assert.equal(humanDate(local(2025, 9, 3, 8, 0), now), "3 Oct");
  assert.equal(humanDate(local(2025, 0, 1, 8, 0), now), "1 Jan");
  assert.equal(humanDate(local(2024, 9, 3, 8, 0), now), "3 Oct 2024");
  assert.equal(humanDate(local(2026, 0, 2, 8, 0), now), "2 Jan 2026");
  // A future date is not "today"; tomorrow reads as a plain date.
  assert.equal(humanDate(local(2025, 9, 13, 0, 5), now), "13 Oct");
});

test("humanDate compares calendar days, not elapsed hours", () => {
  const newYear = new Date(2026, 0, 1, 0, 30);
  // Two hours earlier but a different calendar day: still yesterday.
  assert.equal(humanDate(local(2025, 11, 31, 22, 30), newYear), "Yesterday 22:30");
  // 23 hours ago but two calendar days back is a plain date, with its year.
  assert.equal(humanDate(local(2025, 11, 30, 1, 30), newYear), "30 Dec 2025");
});

test("humanDate defaults now to the current time and is defensive", () => {
  // No fake clock here: only the shape is asserted, so this cannot drift.
  assert.match(humanDate(new Date().toISOString()), /^Today \d{2}:\d{2}$/);
  assert.equal(humanDate(null), "—");
  assert.equal(humanDate(undefined), "—");
  assert.equal(humanDate(""), "—");
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
