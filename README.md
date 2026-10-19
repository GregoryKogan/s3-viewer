# S3 Viewer

A focused desktop client for S3-compatible object storage: one connection list, one
object browser, and a preview panel that shows you what is actually inside a file
before you download it.

Built for people whose buckets already work from boto3 and who are tired of
clients that either cannot express their endpoint settings or drown them in
features for storage backends they will never use.

- **S3 only.** No FTP, no WebDAV, no SMB, no cloud-drive zoo.
- **boto3-shaped settings.** Every connection field maps one-to-one onto a
  `boto3.client("s3", ...)` call, and the form shows the equivalent snippet as you
  type, so a working Python client can be transcribed by hand and will work.
- **Preview first.** Images, audio, video and PDFs render in a side panel without
  being downloaded; text, Markdown, JSON, CSV and code open rendered or
  highlighted. When a preview is refused you get the reason, not a blank pane.
- **Credentials stay local and encrypted.** See [Security](#security).
- macOS (`.dmg`) and Linux (`.deb`, AppImage).

## What it does

**Connections.** Each saved connection pins one endpoint, one bucket and one
prefix. Several connections can point at the same bucket with different prefixes,
which is how most teams actually work. Connections can be edited at any time, and
the ones you used most recently float to the top.

On the first successful contact the app probes what your credentials may actually
do — list, read, write, delete — and shows the result as a badge. The probe writes
one uniquely named object and deletes it immediately; nothing of yours is touched.
The write/delete part can be switched off per connection if your policy forbids
even that.

**Browsing.** A Finder-style list with breadcrumbs, sorting, filtering,
multi-select, shift-click ranges and keyboard navigation (`↑`/`↓`, `Enter` to
open, `Backspace` to go up, `⌘R` refresh, `⌘U` upload, `⌘N` new connection). The
breadcrumb root is the root *of the connection*, so you cannot wander out of the
prefix a connection was set up for.

**Operations.** Upload (button or drag & drop), download with progress, create
folder, create file, delete (folders recursively), copy and move — including
between two saved connections. Downloads go to your Downloads folder under a
non-colliding name; the transfer panel offers Open and Reveal.

**Safety switches, per connection.** Read-only mode, "ask before deleting", "ask
before overwriting", and the permission probe itself. On a scratch bucket you can
turn the confirmations off; on anything that matters you can leave them on.

**Import.** Paste the JSON credentials file you already have, or a boto3 snippet
straight out of your code, and the app creates the connections for you.

## Connection settings

The editor is deliberately a thin skin over boto3:

| App field | boto3 |
| --- | --- |
| Endpoint URL | `endpoint_url=` |
| Region | `region_name=` |
| Access key ID | `aws_access_key_id=` |
| Secret access key | `aws_secret_access_key=` |
| Session token | `aws_session_token=` |
| Bucket | `Bucket=` (ListObjectsV2, PutObject, …) |
| Prefix | `Prefix=` |
| Addressing style | `Config(s3={"addressing_style": …})` |
| Signature version | `Config(signature_version=…)` |

Two notes that come up in practice:

- **Addressing style.** Many S3-compatible deployments require virtual-host
  addressing and answer path-style requests with `VirtualHostDomainRequired`. The
  default is `virtual`; switch to `path` for providers that demand the bucket in
  the URL path. The error itself carries a hint when this is the problem.
- **Signature version.** `s3v4` (the boto3 default) and `v4` use the AWS SDK for
  Rust. `s3v2`, the legacy HmacSHA1 scheme that some appliances still require, is
  implemented in this repository because the AWS SDK no longer speaks it — see
  `src-tauri/src/sigv2.rs`.

## Preview support

Previews never download a whole file just to decide whether they can show it: the
app fetches at most 512 KB to classify the content, and media streams through a
custom `s3stream://` protocol that supports HTTP ranges, so a 4 GB video starts
playing immediately and seeking works.

| Content | Behaviour |
| --- | --- |
| PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, SVG | rendered inline |
| MP3, WAV, OGG, Opus, M4A, AAC, FLAC | player inline, seeking works |
| MP4, WebM, MOV, MKV | player inline, seeking works |
| PDF | embedded viewer |
| Markdown | rendered, with a **Rendered / Raw** switch |
| JSON, JSONL | pretty-printed and highlighted |
| CSV, TSV | parsed into a table (quotes and embedded newlines handled) |
| code (Python, JS/TS, Rust, Go, Java, C/C++, YAML, TOML, SQL, shell, XML, CSS, …) | syntax highlighted |
| plain text | shown as-is, UTF-8 |
| everything else | refused with an explicit reason and a Download button |

Anything above the size limit is refused with a message naming the file size and
the current limit. The limit lives in Settings (default 25 MB, applied to
non-media previews; media streams in ranges regardless).

Markdown is rendered through `marked` and then sanitised by a small allow-list
walker in `src/lib/previewText.ts`: unknown tags are unwrapped, `script`/`iframe`/
`object`/`embed`/`form` never survive, `on*` attributes are dropped and
`javascript:` URLs are stripped. There is an end-to-end check for exactly this.

## Security

- Secret access keys and session tokens are **never written to disk in
  cleartext**. Each is sealed with XChaCha20-Poly1305 under a random 32-byte
  master key.
- The master key lives in the OS keychain (macOS Keychain, Linux Secret Service).
  If no keychain is reachable it falls back to a `0600` file inside the config
  directory, and Settings says so explicitly rather than pretending otherwise.
- The config file is written `0600` inside a `0700` directory, atomically (write
  to a temporary file, then rename), and a corrupt file is backed up instead of
  being silently discarded.
- The app never logs secrets. `crypto::redact` exists so diagnostics can be shared
  safely.
- No telemetry, and no network calls other than the S3 endpoint you configure.

Config location:

- macOS: `~/Library/Application Support/dev.s3viewer.app/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/dev.s3viewer.app/config.json`

Override it with `S3VIEWER_CONFIG_DIR` (handy for tests).

## The interface

**Browsing.** A single click focuses a row and previews it; a double click opens a
folder. Checkboxes stay out of the way until you actually select something — they
appear on hover and stay visible while a selection exists. Shift+click selects the
range from the last row you touched, Cmd+click toggles one row, Cmd+A selects the
folder.

**Address bar.** The pencil at the end of the breadcrumb (or ⌘L) turns the path
into an input that accepts `s3://bucket/key`, `bucket/key` or a bare key. An
address that does not exist says so instead of failing silently; a bucket that is
not this connection's is refused, because a connection is a scope.

**Context menu.** Right-clicking a row offers Preview/Open, Download, Copy S3 URI,
Copy name, Copy to…, Move to… and Delete. Right-clicking empty space offers
Upload, New folder, New file and Refresh. Those actions are not repeated as
toolbar buttons — the toolbar only shows the create actions, and switches to the
bulk actions while a selection exists.

**PDF.** Rendered with pdf.js, so zoom, fit-to-width and page navigation work.
Pages are fetched with ranged reads rather than by downloading the whole file.


Vue 3 with `<script setup>` and TypeScript, built by Vite, styled with Tailwind
against semantic design tokens, and drawn with Lucide icons — no emoji anywhere.
State lives in Pinia setup stores and every backend call goes through one typed
bridge, so a change in Rust surfaces as a type error in the UI rather than a
runtime surprise.

```
src/
  types/         wire types, mirroring the Rust Serialize shapes
  lib/           ipc bridge, formatting, key arithmetic, file-kind detection,
                 highlight.js setup, Markdown sanitiser, boto3 snippet
  stores/        ui (settings, theme, panel geometry), connections, objects
                 (folder, streamed listing, selection, preview), progress,
                 toasts, dialogs
  composables/   useDialogs (promise confirm/prompt), useObjectActions
  components/
    ui/          button, badge, field, modal frame, dialog host, toasts, …
    layout/      sidebar, header, breadcrumb, toolbar, resizers, transfers
    browser/     virtualised object list and row
    preview/     panel + one renderer per media type
    dialogs/     connection editor, settings, import, copy/move
```

Two rules worth knowing before editing:

- **A listing is swapped in only when it finishes.** Pages arrive as events and
  accumulate off-screen; the visible list changes once, so a cancelled load can
  never be mistaken for an empty folder.
- **Geometry is applied to the document, not through template branches.** The
  panel widths and the sidebar's collapsed state are CSS custom properties and
  attributes on the root element. That is what the shell is laid out from, so the
  DOM cannot drift from the store.

## Downloading

Prebuilt releases are on the [landing page](https://gregorykogan.github.io/s3-viewer/)
or directly under [Releases](https://github.com/GregoryKogan/s3-viewer/releases/latest):

| Asset | Platform |
| --- | --- |
| `S3-Viewer.dmg` | macOS 11+, universal (Apple Silicon and Intel) |
| `S3-Viewer.AppImage` | Linux, portable |
| `S3-Viewer-amd64.deb` | Linux, Debian/Ubuntu |

The macOS build is not notarised by Apple yet, so the first launch needs one
allowance — System Settings → Privacy & Security → *Open Anyway*, or
`xattr -dr com.apple.quarantine "/Applications/S3 Viewer.app"`. That prompt
returns for each new version until the build is signed with a Developer ID.
Release assets are named without a version on purpose, so
`releases/latest/download/S3-Viewer.dmg` always points at the newest build.

The landing page lives in [`site/`](site/) and is published by
`.github/workflows/site.yml`; see [`site/README.md`](site/README.md) for the
one-time Pages setting.

### Auto-updates

Every launch asks GitHub Releases whether a newer version exists and, if it does,
offers to download and install it. On macOS the `.app` is replaced in place; on
Linux an AppImage updates itself, while a `.deb` install asks for the
administrator password and installs through `pkexec`. Both then restart into the
new version.

Bundles are signed with a minisign key baked into the app, so a tampered or
corrupted download is rejected instead of installed. The private key never lives
in the repo: CI reads it from the `TAURI_SIGNING_PRIVATE_KEY` secret, and a release
made without it fails on purpose. [`AGENTS.md`](AGENTS.md) spells out the whole
contract, including the version bump every release needs.

## Building

Requirements: Rust (stable), Node.js with pnpm, and the platform toolchain.

```bash
pnpm install
pnpm build:frontend     # vite build → dist/
pnpm tauri dev          # run in development
CI=true pnpm tauri build   # package for the current platform
```

Outputs land in `src-tauri/target/release/bundle/`:

- macOS: `dmg/S3 Viewer_<version>_<arch>.dmg` and `macos/S3 Viewer.app`
- Linux: `deb/` and `appimage/`

End-to-end testing against a real bucket is documented separately:
[`docs/e2e-gui-testing.md`](docs/e2e-gui-testing.md).

`CI=true` matters for the `.dmg`: without it the bundler asks Finder to lay out the
disk-image window, which fails when the terminal lacks Automation permission
(`AppleEvent timed out`). The `.app` is produced either way.

The builds are unsigned. On macOS Gatekeeper warns on first launch (right-click →
Open, or `xattr -dr com.apple.quarantine`). To sign properly, add a Developer ID
and notarisation to `src-tauri/tauri.conf.json`.

Linux packages are built by `.github/workflows/release.yml` on `ubuntu-22.04`,
which is the practical baseline for a `.deb` users can install.

Local builds are unaffected by the updater: `createUpdaterArtifacts` is passed by
CI rather than set in `tauri.conf.json`, precisely so that a build without a
signing key still works.

## Releasing

A release is a tag push:

```bash
# 1. the same version in all three files
#    src-tauri/tauri.conf.json, src-tauri/Cargo.toml, package.json
git commit -am "chore(release): 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

CI checks that the tag matches `tauri.conf.json`, builds both platforms, signs
the `.app`, the AppImage and the `.deb`, writes `latest.json` and publishes the
GitHub Release. Nothing else is needed — the app picks the release up on its next
launch.

The signing key is a repository secret: *Settings → Secrets and variables →
Actions → `TAURI_SIGNING_PRIVATE_KEY`*, holding the single-line content of
`~/.tauri/s3-viewer.key`. It is never committed, and losing it means no installed
copy can be updated again.

`latest.json` lists every platform with the signature of its bundle; the app
fetches it through `releases/latest/download/latest.json`. Drafts and
prereleases are invisible to the updater.

## Testing

Three layers, all runnable locally:

```bash
cargo test --manifest-path src-tauri/Cargo.toml     # 80 tests: crypto, store, S3, SigV2, previews
pnpm test:js                                        # 36 tests: formatting, CSV, boto3, versions, latest.json
node e2e/run.mjs                                    # 33 checks against a real bucket
```

### The end-to-end suite

`tauri-driver` cannot drive the app on macOS: WKWebView ships no WebDriver
implementation, so it refuses to start. Rather than fake the window, the app hosts
the test itself — with `S3VIEWER_E2E=1` the real window boots, a scripted scenario
runs inside the real webview against the real Rust backend and a real bucket, and
the report is written to `$S3VIEWER_E2E_OUT`. Partial reports are published after
every check, so a hang names the check that hung.

`node e2e/run.mjs` seeds a disposable prefix, builds, launches, prints the report
and **always** deletes everything it created — including after a failure. A lock
file stops two concurrent runs from deleting each other's fixtures.

Credentials come from `~/.secrets/s3/s3-creds.json` or from `S3VIEWER_TEST_*`
environment variables. The suite is hard-wired to a single bucket (`e2e/creds.mjs`)
and refuses to run against anything else.

## Architecture

```
src/                     webview UI (no framework)
  app.js                 entry point
  js/app.js              state, rendering, every interaction
  js/preview.js          preview renderers, Markdown sanitiser, CSV parser
  js/connection-form.js  the boto3-shaped editor and its generated snippet
  js/import.js           credential / snippet import
src-tauri/src/
  s3/aws.rs              ObjectStore over the AWS SDK (SigV4)
  s3/v2.rs               ObjectStore for the legacy SigV2 scheme
  sigv2.rs               the V2 canonical string and HmacSHA1 signature
  preview.rs             the preview policy: what is shown, and why not
  commands.rs            the Tauri command surface
  store.rs, crypto.rs    connections and sealed secrets
  e2e/                   the self-hosted end-to-end harness
```

The `ObjectStore` trait has two implementations, selected by the connection's
signature version. Because `async fn` in traits is not dyn-compatible, dispatch
goes through a small `AnyStore` enum rather than trait objects.
