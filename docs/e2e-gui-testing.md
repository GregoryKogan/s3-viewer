# End-to-end testing in the real GUI

How to run the acceptance suite that drives the actual application window, how to
read its output, how to add a check, and how to avoid the mistakes that have
already cost time on this project.

Read this before running `e2e`, before adding a check, and before claiming "the
suite passes" in a report.

---

## 1. What this suite is, and why it is built this way

The suite launches the **real debug binary**, which opens the **real window**, and
runs a scripted scenario **inside the real webview** against the **real Rust
backend** and the **real bucket**. It then deletes everything it created.

It is not WebDriver-based, and cannot be:

- `tauri-driver` refuses to start on macOS because **WKWebView ships no WebDriver
  implementation**;
- simulating clicks on a real screen would prove nothing about the app.

So the app drives itself. The runner sets `S3VIEWER_E2E=1`; the Rust side runs
`e2e::TestPlan::from_env()`, injects `SCENARIO` (a big JS string in
`src-tauri/src/e2e/mod.rs`) into the page, and the page reports back over IPC
(`e2e_report`). The runner seeds S3 before the run and cleans up after it.

Consequence worth internalising: **you are not testing a mock.** A failure can be
the app, the network, or the endpoint. That is why the runner prints heartbeats
and why this document has a troubleshooting table.

---

## 2. One-time prerequisites

```bash
export PATH="$HOME/.cargo/bin:$PATH"   # cargo is not on the non-login PATH here
pnpm install
```

Credentials, in order of preference:

| Variable | Needed |
| --- | --- |
| `S3VIEWER_TEST_ENDPOINT` | yes, unless a creds file is present |
| `S3VIEWER_TEST_ACCESS_KEY` | yes |
| `S3VIEWER_TEST_SECRET_KEY` | yes |
| `S3VIEWER_TEST_BUCKET` | yes — or `e2e/.env.local` |
| `S3VIEWER_TEST_REGION` | no, defaults to `us-east-1` |

The three `S3VIEWER_TEST_*` credential variables must be set together; otherwise
`e2e/creds.mjs` falls back to a local credentials file at
`~/.secrets/s3/s3-creds.json` (the shape `{ "<bucket>": { access_key, secret_key,
endpoint } }`) and takes **only** the entry for the bucket this suite is allowed to
touch. The bucket itself comes from `S3VIEWER_TEST_BUCKET`, else from
`e2e/.env.local` (gitignored), and **there is no fallback**: without one of those
the suite refuses to start. That is deliberate — the suite creates and deletes
objects.

Two hard guardrails live in `e2e/creds.mjs` and must stay:

- only the one resolved bucket is ever touched;
- every other entry in a credentials file is **ignored**, never read into the
  process, never logged.

---

## 3. Run it

```bash
node e2e/run.mjs            # or: pnpm test:e2e
node e2e/run.mjs --keep     # keep the work dir (config, downloads, report)
```

Expect **a few minutes** (typically 2–4, longer on a cold `cargo` cache): the
runner builds the frontend, `cargo build`s the debug binary, generates the Parquet
fixture (a `cargo test` invocation, because Arrow is a test-only dependency), seeds
S3, runs every check, then cleans up. The tally line tells you how many there are;
do not hard-code the number in a report.

What it does, in order:

1. acquires `s3viewer-e2e.lock` in the system temp directory — on macOS that is
   `$TMPDIR`, not `/tmp`; print it with `node -p "require('os').tmpdir()"`. A
   second concurrent run would delete the first one's fixtures, so it refuses to
   start;
2. cleans `_s3viewer-e2e/` on the bucket;
3. builds `dist/` and the debug binary;
4. writes fixtures to a temp dir and uploads them under `_s3viewer-e2e/`;
5. launches the app with an **isolated config dir** and a **fixed master key**
   (`S3VIEWER_TEST_MASTER_KEY`), so the login keychain is never touched and the
   run cannot see the developer's own connections;
6. waits for the report (runner timeout 720 s, in-app budget 600 s);
7. prints the report, deletes every object it created, releases the lock.

Exit code: `0` only when every check passed **and** the app exited cleanly.

---

## 4. Reading the output

```
...
========================================================================
[PASS] boot: the app shell rendered — 1 connection card
[PASS] boot: the IPC bridge answers — pong
[FAIL] preview: PDF is rendered from the stream — timeout waiting for the rendered PDF page
        at ...
========================================================================
e2e: 54/55 checks passed (app exit code 2)
```

- One line per check. `detail` is whatever the check returned — make it useful
  (a count, a path, a size), because it is the only thing a future reader sees.
- A failing check also prints the top of its stack.
- The final line is the tally. **`54/55` is a failure.** The exit code agrees.

The runner also prints the last eight heartbeats:

```
▶ last heartbeats (11 total):
    12s preview: image decodes through the s3stream protocol
    ...
```

Heartbeats are `elapsed-seconds` + the check that was running. If a run hangs, the
last line names the check it hung in. They are appended to
`<workDir>/heartbeat.log` and survive a killed app — that file is the only
evidence when the process is shot.

The credentials header printed at startup contains the bucket and endpoint (keys
are redacted). **Do not paste that output into a ticket or a chat.**

---

## 5. What a run leaves behind

With `--keep` the runner prints the work dir and keeps it:

```
/var/folders/…/s3viewer-e2e-UJPvhS/
  config/config.json     isolated app config (connections created by the run)
  downloads/             whatever the download checks fetched
  report.json            the structured report, same content as the console
  s3-creds.json          the import-dialog fixture
  heartbeat.log          check progress, timestamped
```

Without `--keep` the directory is deleted. The bucket is cleaned either way.

Reproduce a single check by hand against a kept config:

```bash
S3VIEWER_CONFIG_DIR=<workDir>/config \
S3VIEWER_TEST_MASTER_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff \
  "src-tauri/target/debug/s3viewer"
```

---

## 6. How a check is written

Everything lives in `SCENARIO` in `src-tauri/src/e2e/mod.rs`. A check is:

```js
await check('area: what it proves', async () => {
  // drive the UI, assert, then return a short detail line
  return 'something concrete';
});
```

Rules that the harness enforces or that have bitten before:

- **A check must fail loudly.** Throw an `Error` with a message that names what was
  expected *and* what was found. Never `return false`.
- **Never read the DOM in the same task as the interaction.** Vue applies updates
  on a microtask, so a predicate matching yesterday's markup resolves instantly and
  the check asserts on stale content. Use `await wait(...)`; it yields a timer
  before the first poll.
- **Yield with `frame()` (a timer), never `requestAnimationFrame`.** macOS stops
  delivering frames when the window is occluded by another window, so a rAF-based
  wait hangs for the whole 90 s budget while the app is perfectly healthy.
- **Every check has a 90 s watchdog** (`withLimit`). A check that can legitimately
  take longer needs its own bounded waits and a comment, not a longer budget.
- **Nothing may depend on window focus, screen position, or native dialogs.** The
  native file and save dialogs cannot be driven; go through the backend command
  instead (see `read_text_file`, and the `e2e_*` commands for transfers).
- **Nothing may depend on the window size either.** Under `S3VIEWER_E2E=1` the
  window-state plugin runs with empty flags, so the window opens at the size in
  `tauri.conf.json` and a check that reads the layout sees the same geometry on
  every host. The plugin neither restores nor saves geometry during an e2e run.
  Do not reintroduce a dependence on a restored size; set the widths you need
  through `window.__s3viewer.state.ui` instead.

Available helpers inside the scenario (defined at the top of `SCENARIO`):

| Helper | Use |
| --- | --- |
| `$ (sel)`, `$$ (sel)` | `querySelector` / `querySelectorAll` as an array |
| `wait(what, fn, ms?)` | poll until `fn` returns truthy; default 15 s; yields first |
| `frame()` | yield one turn so Vue can flush |
| `sleep(ms)` | plain delay |
| `setInput(sel, value)` | set a value and dispatch `input` (works with `v-model`) |
| `clickRow(label)` | scroll the virtualised row into view, then click it |
| `rowMenu(label)` | right-click a row and return the context menu |
| `menuClick(menu, label)` | click an item of that menu by its label |
| `openAddress()` / `closeAddress()` | put the address bar into editing mode / leave it |
| `closeModal()` | close an open dialog |
| `rowNames()` | the labels currently painted in the list |

---

## 7. Adding a check

1. Find the right block in `SCENARIO` — checks are grouped by area in the order
   they run, and later checks may depend on earlier state (a navigated folder, an
   open dialog). Put yours where its preconditions hold.
2. Prefer the **user's path**: click, right-click, type, press keys. Reach into
   `window.__s3viewer` only for state a user cannot produce, and say why in a
   comment.
3. If the UI has no stable handle for what you need, add a
   `data-testid="…"` in the component. **Test ids are a contract** between the UI
   and the harness; renaming one silently breaks a check, so rename both in the
   same commit.
4. Return a detail line that a reader can verify against the screenshot.
5. Run the whole suite. A new check that only passes in isolation is not done.

If the check needs a file on disk, the runner writes it into the work dir and
passes the path through `TestPlan` (see `S3VIEWER_E2E_IMPORT_FILE` →
`__IMPORT_FILE__`). Do not try to reach the filesystem from the page.

---

## 8. Guardrails — do not break these

- **Bucket discipline.** Only the resolved bucket, only the `_s3viewer-e2e/`
  prefix, everything deleted at the end. Before reporting a run, verify zero
  objects remain.
- **Never print secret values.** `crypto::redact` and the `creds.mjs` prefixes
  exist for diagnostics.
- **Never point the suite at a production bucket.** The suite creates and deletes
  objects, including a recursive delete of a folder.
- **The app must keep working when e2e is off.** `S3VIEWER_E2E` gates all of it;
  the release build has no harness.
- **One run at a time.** The lock file enforces it; do not delete a stale lock
  without checking that its pid is really gone.

---

## 9. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `another e2e run (pid …) is using the bucket prefix` | a previous run is still alive or died without cleaning up | `ps -p <pid>`; if that pid is gone, delete `s3viewer-e2e.lock` from `node -p "require('os').tmpdir()"` |
| Hang at a specific check, 90 s watchdog | the check's promise never settled | read `heartbeat.log`; look for a wait on a native dialog, a `rAF`, or a missing `await` |
| `timeout waiting for the list` / empty list after a navigation | a listing stalled | check the app's own retry (20 s); confirm the endpoint is reachable |
| The UI looks like an older version than the code | the webview served a cached asset | asset names are content-hashed now; if you see this, verify `dist/assets/*.js` has a hash and rebuild the `.app` — `tauri build` embeds `dist` at compile time |
| `Cannot read file … file://` | reading files through `fetch` — the webview refuses it | go through the `read_text_file` command |
| Check passes alone but fails in the suite | shared state (selection, folder, open dialog) | make the check set up its own precondition; do not rely on a previous check leaving the UI in a state |
| Everything fails at `boot: the app shell rendered` | frontend did not build, or `window.__s3viewer` was never published | run `pnpm build:frontend` and read the app's stderr |

---

## 10. Looking at the GUI by hand

The suite proves behaviour, not beauty. To actually look at the window without
touching your own connections or the keychain:

Run this from the repository root:

```bash
mkdir -p /tmp/s3v-look
S3VIEWER_CONFIG_DIR=/tmp/s3v-look \
S3VIEWER_TEST_MASTER_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff \
  "src-tauri/target/release/bundle/macos/S3 Viewer.app/Contents/MacOS/s3viewer" &
```

The master key above is the deterministic **test** key the suite uses; it only
unseals the throwaway config in `/tmp/s3v-look`.

That binary is the packaged app; `tauri build --bundles app` is required after any
frontend change, because the assets are embedded at compile time. For an empty
state, start with a fresh `S3VIEWER_CONFIG_DIR`; for a populated one, run
`node e2e/run.mjs --keep` and point `S3VIEWER_CONFIG_DIR` at its `config/`.

To capture the screen on macOS, `screencapture -x -o /tmp/shot.png` — no
permissions prompt for the whole screen, but the window must be frontmost.

---

## 11. What this suite does not cover

- **Native dialogs** (open/save). The file pickers cannot be driven; the checks
  exercise the backend command behind them instead. File uploads do go through
  the real queue: the scenario hands a real local path to
  `window.__s3viewer.queueUploads`, the same entry point the picker feeds.
- **OS drag & drop.** Cannot be synthesised in a webview.
- **The updater.** Needs two published releases and a real install; see
  `AGENTS.md`.
- **Linux bundles.** Built and smoke-tested in CI, not locally.
- **Visual regressions.** Nothing here compares pixels; look at the window (section
  10) when a change is visual.

---

## 12. Before you claim it passes

1. `node e2e/run.mjs` — full tally, exit code 0.
2. Run it **twice** if you touched the network layer, the listing, or the harness
   itself. This suite has had genuine intermittent failures; one green run is not
   evidence of stability.
3. `pnpm type-check`, `pnpm test:js`, `cargo test --manifest-path src-tauri/Cargo.toml`,
   `cargo clippy … -D warnings`, `cargo fmt --check`.
4. Confirm the bucket is clean: zero objects under `_s3viewer-e2e/`.
5. In the report you give, state the tally and how many times you ran it. Not
   "e2e passes".
