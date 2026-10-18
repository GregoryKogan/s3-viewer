/**
 * Builds the Tauri updater manifest (`latest.json`) from published release assets.
 *
 * Every platform in `TARGETS` maps to the stable asset name the release workflow
 * copies the bundle to. A target is included when its `.sig` file is present next
 * to the asset; that is what `createUpdaterArtifacts` (macOS, AppImage) and
 * `tauri signer sign` (the .deb, which the bundler never signs) produce.
 *
 * Run from the release workflow:
 *
 *   node .github/scripts/latest-json.mjs \
 *     --assets release-assets --version 0.2.0 \
 *     --base-url https://github.com/OWNER/REPO/releases/latest/download \
 *     --out release-assets/latest.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Updater target → asset name.
 *
 * The updater looks for `{os}-{arch}-{bundle}` first and then `{os}-{arch}`, so
 * the Linux entries are keyed by bundle type: an AppImage install must receive an
 * AppImage and a .deb install a .deb, never one another.
 *
 * The macOS build is universal, so both architecture keys point at the same
 * archive with the same signature.
 */
export const TARGETS = [
  { target: "darwin-aarch64", asset: "S3-Viewer.app.tar.gz" },
  { target: "darwin-x86_64", asset: "S3-Viewer.app.tar.gz" },
  { target: "linux-x86_64-appimage", asset: "S3-Viewer.AppImage" },
  { target: "linux-x86_64-deb", asset: "S3-Viewer-amd64.deb" },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {object} input
 * @param {string} input.version        Version being published, without the tag's `v`.
 * @param {string} input.baseUrl        Directory URL the assets are served from.
 * @param {Record<string, string>} input.signatures  Asset name → signature text.
 * @param {string} [input.notes]        Optional release notes shown in the dialog.
 * @param {string} [input.publishedAt]  RFC 3339 timestamp; defaults to now.
 */
export function buildManifest({ version, baseUrl, signatures, notes, publishedAt }) {
  if (!SEMVER.test(version ?? "")) {
    throw new Error(`not a semver version: ${JSON.stringify(version)}`);
  }
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("baseUrl is required");

  const platforms = {};
  for (const { target, asset } of TARGETS) {
    const signature = signatures?.[asset]?.trim();
    if (!signature) continue;
    platforms[target] = {
      url: `${base}/${encodeURIComponent(asset)}`,
      signature,
    };
  }

  // An empty manifest would publish a release nobody can install, which looks
  // exactly like "no update" from the app's point of view. Refuse instead.
  if (Object.keys(platforms).length === 0) {
    throw new Error("no signatures found: the release would not be updatable");
  }

  const manifest = {
    version,
    pub_date: publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms,
  };
  if (notes?.trim()) manifest.notes = notes.trim();
  return manifest;
}

/** Reads `<asset>.sig` for every target; throws when an asset exists unsigned. */
export async function readSignatures(dir) {
  const signatures = {};
  for (const asset of new Set(TARGETS.map((entry) => entry.asset))) {
    const assetPath = path.join(dir, asset);
    const sigPath = `${assetPath}.sig`;
    if (existsSync(sigPath)) {
      signatures[asset] = (await readFile(sigPath, "utf8")).trim();
    } else if (existsSync(assetPath)) {
      throw new Error(`${asset} is published without ${path.basename(sigPath)}`);
    }
  }
  return signatures;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["assets", "version", "base-url", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const signatures = await readSignatures(args.assets);
  const manifest = buildManifest({
    version: args.version,
    baseUrl: args["base-url"],
    signatures,
    notes: args.notes,
  });
  await writeFile(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
