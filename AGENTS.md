# Agent notes

Read this before touching the version, the build, or the release workflow. The
app updates itself: a careless change here ships a release that either cannot
reach installed users or offers the same update on every launch.

## What the app is

A Tauri 2 desktop S3 browser: Rust backend in `src-tauri/`, Vue 3 + Pinia
frontend in `src/`. macOS and Linux only.

## Build and test

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # cargo is not on the default non-login PATH here

pnpm install
pnpm build:frontend                    # vite build → dist/
pnpm tauri dev                         # run in development
pnpm type-check                        # vue-tsc
pnpm test:js                           # node --test tests/js/*.test.js
cargo test --manifest-path src-tauri/Cargo.toml
CI=true pnpm tauri build               # package for the current platform
```

`pnpm check` is the strict local gate: frontend build, `cargo fmt --check`,
`clippy -D warnings`, Rust tests. It does not run `pnpm test:js`, so run both
before tagging. CI runs the frontend build, the Rust tests and the JS tests, then
bundles.

`pnpm test:e2e` drives the real window against a real bucket. It needs S3
credentials and it creates and deletes objects, so read
[`docs/e2e-gui-testing.md`](docs/e2e-gui-testing.md) first — it covers the
credentials, the guardrails, how to read a failure, and what the suite cannot
test.

**Local builds must keep working without a signing key.** That is why
`bundle.createUpdaterArtifacts` is *not* in `tauri.conf.json`: the bundler refuses
to build when it is on and no key is present. Only CI passes it:

```bash
pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'
```

Never move that flag into the config file, and never add
`TAURI_SIGNING_PRIVATE_KEY` to the repo or to a shell profile that local builds
inherit. An unsigned local build is a normal, working build; its updater simply
never finds anything it can verify.

### Things CI will punish you for

- **Do not lower `rust-version` in `src-tauri/Cargo.toml`.** It is 1.90 because
  `tauri-plugin-updater` requires it; with a lower declared MSRV the resolver
  silently picks an old `2.0.0-rc` plugin.
- **Commit both lockfiles.** CI installs with `pnpm install --frozen-lockfile`, so
  a dependency change without a committed `pnpm-lock.yaml` fails the build.
  `src-tauri/Cargo.lock` records the package version too — refresh it with
  `cargo check` after bumping.
- **CI runs Node 22**, this machine may run something newer. The test command is
  `node --test tests/js/*.test.js` on purpose: `node --test tests/js` resolves the
  directory as a module on Node 22 and fails the step before anything is built.

## Releasing

A release is a tag push; `.github/workflows/release.yml` builds both platforms,
signs the bundles, writes `latest.json` and publishes the GitHub Release. Follow
the checklist below rather than improvising.

### Bump the version in all three files — they must agree

| File | Field |
| --- | --- |
| `src-tauri/tauri.conf.json` | `version` — the one the app reports *and* the updater compares |
| `src-tauri/Cargo.toml` | `[package] version` |
| `package.json` | `version` |

The tag must be exactly `v` + that version. CI fails the build otherwise, because
a tag that disagrees with `tauri.conf.json` makes every installed copy install
the "new" version and then offer it again on the next launch, forever.
`pnpm test:js` also asserts the three files agree, so a local run catches the
drift before the tag exists.

Use semver. A prerelease such as `0.3.0-rc.1` is a valid version, but the updater
only offers it to builds with a lower version, so do not use one for anything
users are expected to pick up. `v0.2.0` inside the config is not valid semver and
will break the comparison.

### Signing key

- Public key: `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. It ships
  inside every installed app; changing it orphans every user.
- Private key: GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (the whole file content)
  and, if the key has a password, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The
  keypair was generated with an empty password, so only the first secret exists.
- The maintainer's copy lives outside the repo at `~/.tauri/s3-viewer.key`.
- A tag build without the secret fails on purpose ("the release would not be
  installable as an update"). A `workflow_dispatch` run only warns and builds an
  unsigned app.
- Never run `pnpm tauri signer generate` again "to fix something". A new keypair
  silently invalidates every update: signatures no longer verify and every
  installed copy reports a failed update. If the key is lost, the only way
  forward is a manual reinstall of a build signed with a new key.

### Release checklist

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git switch main && git pull --ff-only

# 1. Bump the version in the three files above (patch for fixes, minor for features).

# 2. Prove the tree is releasable before the tag exists.
pnpm install --frozen-lockfile
cargo check --manifest-path src-tauri/Cargo.toml    # refreshes Cargo.lock's package version
pnpm check                                          # fmt, clippy, Rust tests, frontend build
pnpm test:js                                        # includes the three-file version check

# 3. Commit, tag, push. The tag alone is not enough if main has moved.
git add -A
git commit -m "chore(release): 0.2.1"
git tag -a v0.2.1 -m "S3 Viewer 0.2.1"
git push origin main v0.2.1

# 4. Watch it (about ten minutes).
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

### Verify the release

A green run is not enough: check that what was published is actually installable.

```bash
TAG=v0.2.1
gh release view "$TAG" --json assets --jq '.assets[].name'
```

Expect `latest.json`, `SHA256SUMS.txt`, `S3-Viewer.dmg`, and
`S3-Viewer.app.tar.gz`, `S3-Viewer.AppImage`, `S3-Viewer-amd64.deb` each with a
matching `.sig`.

```bash
python3 - <<'PY'
import json, urllib.request
base = "https://github.com/GregoryKogan/s3-viewer/releases/latest/download"
m = json.load(urllib.request.urlopen(f"{base}/latest.json"))
assert len(m["platforms"]) == 4, list(m["platforms"])
assert m["platforms"]["darwin-aarch64"] == m["platforms"]["darwin-x86_64"]
for name, entry in m["platforms"].items():
    assert entry["signature"].strip(), name
    assert urllib.request.urlopen(entry["url"]).status == 200, name
print("manifest ok for", m["version"])
PY
```

The checks that matter: `version` equals the tag without `v`, there are four
platform keys, both macOS keys are identical, and every URL answers 200. If
`releases/latest/download/latest.json` does not exist, the release is a draft or a
prerelease — `latest` skips both, and so does every installed app.

The only proof that a signature is *valid* is an install: the app verifies the
bundle against its embedded key and refuses to install on a mismatch. Do one real
update cycle (install version N-1, let it update to N) after anything that touches
signing, keys or `.github/scripts/latest-json.mjs`.

### If the run fails

The `publish` job runs only after both builds pass and creates the release in one
step, so a failed run publishes nothing. Read the failure, fix it on `main`, then
move the tag:

```bash
gh run view --workflow=release.yml --log-failed
git tag -d v0.2.1
git push origin :refs/tags/v0.2.1
git tag -a v0.2.1 -m "S3 Viewer 0.2.1"
git push origin main v0.2.1
```

**Never move a tag once the release is published.** Machines that already updated
report that version, and the updater never treats an equal or lower version as an
update: reusing the number means those users never receive the corrected bytes.
Deleting the release does not reach them either. Ship the fix as the next patch
version.

## How the updater works

1. On launch, ~2.5 s in, the webview calls `check()` (`src/App.vue` →
   `src/stores/updates.ts`).
2. Rust fetches `https://github.com/GregoryKogan/s3-viewer/releases/latest/download/latest.json`,
   compares its `version` with the running one, and picks the entry matching the
   current target and bundle type.
3. If newer, the dialog offers "Install and restart". On accept the bundle is
   downloaded, its minisign signature is verified against `pubkey`, and the app
   is replaced on disk; `relaunch()` starts the new binary.
4. `latest.json` is generated by `.github/scripts/latest-json.mjs` from the
   `.sig` files in the release assets. It is covered by tests in
   `tests/js/latest-json.test.js`.

A failed or empty check is silent on purpose: launching the app must not depend
on GitHub being reachable. The manual "Check now" in Settings is the only place
that reports "you are up to date" or an error.

The updater shipped in **0.2.0**. Older builds never check for updates and must
be replaced by hand once, so a report of "no update prompt" from a 0.1.0 install
is expected.

`workflow_dispatch` builds both platforms and keeps the installers as workflow
artifacts, but skips `publish` (there is no tag to publish under). Use it to
exercise the pipeline, never to ship.

### Invariants

- **Asset names are frozen.** `.github/scripts/latest-json.mjs` (`TARGETS`) and
  the "Collect installers under stable names" step in `release.yml` must agree:
  `S3-Viewer.app.tar.gz` (+`.sig`), `S3-Viewer.AppImage` (+`.sig`),
  `S3-Viewer-amd64.deb` (+`.sig`). `releases/latest/download/<name>` and the
  landing page in `site/` depend on them too.
- **macOS is a universal build**, so `latest.json` carries both
  `darwin-aarch64` and `darwin-x86_64` pointing at the same archive and signature.
  Keep it that way; the updater's arch constant is per-slice.
- **Linux targets include the bundle type** (`linux-x86_64-appimage`,
  `linux-x86_64-deb`). Mixing them up delivers an AppImage to a `.deb` install
  or the other way around.
- **The `.deb` needs a signature the bundler does not produce.** CI runs
  `pnpm tauri signer sign` on it (see "Collect installers"); if you ever build a
  `.deb` outside the workflow, sign it the same way or the updater rejects it.
  Installing a `.deb` update prompts for the administrator password through
  `pkexec`.
- **Capabilities must keep** `updater:default` and `process:default` in
  `src-tauri/capabilities/default.json`; without them the buttons fail with a
  permission error at runtime, not at build time.
- **Never ship a lower version to "roll back".** The updater only installs a
  strictly newer version, so a downgrade reaches nobody. Fix forward with a patch
  release.
- **Do not publish a release without a manifest.** If signatures are missing the
  publish job fails on purpose — a release nobody can update from looks exactly
  like "there is no update".

### Testing the update path

The manifest generator is unit-tested and can be exercised offline:

```bash
mkdir -p /tmp/assets && cp path/to/S3-Viewer.AppImage* /tmp/assets/
node .github/scripts/latest-json.mjs --assets /tmp/assets --version 0.2.0 \
  --base-url https://github.com/GregoryKogan/s3-viewer/releases/latest/download \
  --out /tmp/assets/latest.json && cat /tmp/assets/latest.json
```

The full loop needs two published releases: install the previous version, launch
it, and accept the update. `releases/latest` deliberately skips drafts and
prereleases, so a draft release is not visible to the updater.

## Where things live

| Path | Role |
| --- | --- |
| `src/lib/updater.ts` | Thin wrapper over the plugin APIs, lazily imported |
| `src/stores/updates.ts` | Phase, version, progress, install and "later" |
| `src/components/dialogs/UpdateDialog.vue` | The prompt, progress and error states |
| `src/App.vue` | Launch check (2.5 s after the window is ready) |
| `src/components/dialogs/SettingsDialog.vue` | Version line and "Check now" |
| `src-tauri/src/lib.rs` | `tauri_plugin_updater` + `tauri_plugin_process` registration |
| `.github/scripts/latest-json.mjs` | Builds `latest.json` from signed assets |
| `.github/workflows/release.yml` | Tag → signed bundles → `latest.json` → release |
| `README.md` | User-facing build, download and release notes |
