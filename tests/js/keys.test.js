import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { asFolderPrefix, joinKey, uploadScopeFor, validateKey } = await loadTs("src/lib/keys.ts");

test("asFolderPrefix keeps a literal leading slash and adds the trailing one", () => {
  assert.equal(asFolderPrefix(""), "");
  assert.equal(asFolderPrefix("  "), "");
  assert.equal(asFolderPrefix("a/b"), "a/b/");
  assert.equal(asFolderPrefix("a/b/"), "a/b/");
  assert.equal(asFolderPrefix("/root"), "/root/");
});

test("joinKey never doubles or drops the separator", () => {
  assert.equal(joinKey("", "a.txt"), "a.txt");
  assert.equal(joinKey("a/b", "a.txt"), "a/b/a.txt");
  assert.equal(joinKey("a/b/", "a.txt"), "a/b/a.txt");
  assert.equal(joinKey("a/", "/a.txt"), "a/a.txt");
});

test("validateKey rejects keys that escape the connection scope", () => {
  assert.equal(validateKey("a/b.txt"), null);
  assert.match(validateKey(""), /empty/);
  assert.match(validateKey("/abs"), /start with/);
  assert.match(validateKey("a/../b"), /\.\./);
  assert.match(validateKey("a\u0000b"), /NUL/);
});

test("uploadScopeFor strips exactly the planned suffix from the key", () => {
  // A top-level file retries into the same folder.
  assert.equal(uploadScopeFor("a.txt", "a.txt"), "");
  // A file dropped as part of a folder keeps its nested key.
  assert.equal(uploadScopeFor("root/sub/a.txt", "a.txt"), "root/sub/");
  // A directory marker retries from the directory's parent.
  assert.equal(uploadScopeFor("dir/", "dir"), "");
  assert.equal(uploadScopeFor("root/sub/dir/", "dir"), "root/sub/");
  // A trailing slash on the local name is noise.
  assert.equal(uploadScopeFor("root/sub/dir/", "dir/"), "root/sub/");
});

test("uploadScopeFor keeps unicode names and a leading-slash prefix", () => {
  assert.equal(uploadScopeFor("root/sub/файл.txt", "файл.txt"), "root/sub/");
  assert.equal(uploadScopeFor("root/sub/папка/", "папка"), "root/sub/");
  // Some buckets keep keys that start with a literal slash; a retry must not
  // double it.
  assert.equal(uploadScopeFor("/a.txt", "a.txt"), "/");
  assert.equal(uploadScopeFor("/root/файл.txt", "файл.txt"), "/root/");
});

test("uploadScopeFor falls back to the key's parent prefix", () => {
  assert.equal(uploadScopeFor("data", "a.txt"), "");
  assert.equal(uploadScopeFor("root/other.txt", "a.txt"), "root/");
  // A name that is only a suffix of the leaf must not truncate mid-segment.
  assert.equal(uploadScopeFor("root/data", "a"), "root/");
});
