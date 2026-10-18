import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest, TARGETS } from "../../.github/scripts/latest-json.mjs";

const base = "https://github.com/GregoryKogan/s3-viewer/releases/latest/download";
const signatures = {
  "S3-Viewer.app.tar.gz": "signature-for-the-universal-app\n",
  "S3-Viewer.AppImage": "appimage-sig",
  "S3-Viewer-amd64.deb": "deb-sig\n",
};

test("publishes the universal macOS archive under both architectures", () => {
  const manifest = buildManifest({ version: "0.2.0", baseUrl: base, signatures });
  const arm = manifest.platforms["darwin-aarch64"];
  const intel = manifest.platforms["darwin-x86_64"];
  assert.ok(arm && intel);
  assert.equal(arm.url, `${base}/S3-Viewer.app.tar.gz`);
  assert.equal(intel.url, arm.url);
  assert.equal(intel.signature, arm.signature);
});

test("keys Linux by bundle type so a .deb install never receives an AppImage", () => {
  const manifest = buildManifest({ version: "0.2.0", baseUrl: base, signatures });
  assert.ok(manifest.platforms["linux-x86_64-appimage"].url.endsWith("S3-Viewer.AppImage"));
  assert.ok(manifest.platforms["linux-x86_64-deb"].url.endsWith("S3-Viewer-amd64.deb"));
  assert.equal(manifest.platforms["linux-x86_64"], undefined);
});

test("trims signatures, because the .sig files end with a newline", () => {
  const manifest = buildManifest({ version: "0.2.0", baseUrl: base, signatures });
  assert.equal(manifest.platforms["linux-x86_64-deb"].signature, "deb-sig");
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "signature-for-the-universal-app");
});

test("tolerates a trailing slash on the base URL", () => {
  const manifest = buildManifest({ version: "0.2.0", baseUrl: `${base}/`, signatures });
  assert.equal(manifest.platforms["darwin-aarch64"].url, `${base}/S3-Viewer.app.tar.gz`);
});

test("omits the notes key unless there is something to say", () => {
  assert.equal("notes" in buildManifest({ version: "0.2.0", baseUrl: base, signatures }), false);
  const withNotes = buildManifest({ version: "0.2.0", baseUrl: base, signatures, notes: "  " });
  assert.equal("notes" in withNotes, false);
  const real = buildManifest({ version: "0.2.0", baseUrl: base, signatures, notes: "Faster listings." });
  assert.equal(real.notes, "Faster listings.");
});

test("refuses to publish a manifest nobody can install", () => {
  assert.throws(() => buildManifest({ version: "0.2.0", baseUrl: base, signatures: {} }), /not be updatable/);
  assert.throws(() => buildManifest({ version: "0.2.0", baseUrl: base }), /not be updatable/);
});

test("rejects a version the updater cannot compare", () => {
  assert.throws(() => buildManifest({ version: "v0.2.0", baseUrl: base, signatures }), /semver/);
  assert.throws(() => buildManifest({ version: "", baseUrl: base, signatures }), /semver/);
});

test("stamps an RFC 3339 date the updater accepts", () => {
  const manifest = buildManifest({ version: "0.2.0", baseUrl: base, signatures });
  assert.match(manifest.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("keeps one target per platform and never duplicates an asset key", () => {
  const targets = TARGETS.map((entry) => entry.target);
  assert.equal(new Set(targets).size, targets.length, "duplicate updater target");
});
