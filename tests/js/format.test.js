import test from "node:test";
import assert from "node:assert/strict";
import {
  humanSize,
  humanDate,
  kindIcon,
  kindLabel,
  prefixSegments,
  fileName,
  extensionOf,
  pluralize,
} from "../../src/js/format.js";

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

test("kindLabel and kindIcon have sensible fallbacks", () => {
  assert.equal(kindLabel("image"), "Image");
  assert.equal(kindLabel("something-new"), "something-new");
  assert.equal(kindIcon("folder", true), "📁");
  assert.equal(kindIcon("image", false), "🖼");
  assert.equal(kindIcon("something-new", false), "📄");
});

test("prefixSegments builds cumulative prefixes", () => {
  assert.deepEqual(prefixSegments(""), []);
  assert.deepEqual(prefixSegments("a/"), [{ name: "a", prefix: "a/" }]);
  assert.deepEqual(prefixSegments("a/b/"), [
    { name: "a", prefix: "a/" },
    { name: "b", prefix: "a/b/" },
  ]);
});

test("fileName and extensionOf handle folders and dotted names", () => {
  assert.equal(fileName("a/b/c.png"), "c.png");
  assert.equal(fileName("a/b/"), "b");
  assert.equal(extensionOf("a/b/c.PNG"), "png");
  assert.equal(extensionOf("Makefile"), "");
  assert.equal(extensionOf(".env"), "");
});

test("pluralize picks the right form", () => {
  assert.equal(pluralize(1, "file", "files"), "file");
  assert.equal(pluralize(0, "file", "files"), "files");
});
