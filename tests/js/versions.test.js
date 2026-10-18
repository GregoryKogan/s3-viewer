import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The updater compares `tauri.conf.json`'s version with the manifest and the CI
 * workflow compares it with the git tag. The other two files are only for
 * humans and tools — which is exactly why they drift. Keep them honest here.
 */
const root = path.resolve(import.meta.dirname, "../..");

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

test("the app version is the same in tauri.conf.json, Cargo.toml and package.json", () => {
  const tauriVersion = JSON.parse(read("src-tauri/tauri.conf.json")).version;
  const packageVersion = JSON.parse(read("package.json")).version;
  const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1];

  assert.equal(cargoVersion, tauriVersion, "src-tauri/Cargo.toml disagrees with tauri.conf.json");
  assert.equal(packageVersion, tauriVersion, "package.json disagrees with tauri.conf.json");
});

test("the version is valid semver, because the updater parses it", () => {
  const tauriVersion = JSON.parse(read("src-tauri/tauri.conf.json")).version;
  assert.match(tauriVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
