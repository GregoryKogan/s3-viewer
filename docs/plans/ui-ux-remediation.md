# UI/UX audit remediation plan

**Spec:** `docs/ui-ux-audit.md` (the finding list with IDs such as SEL-1, NAV-2, VIS-3).
**Branch:** `fix/ui-ux-audit`.
**Baseline:** `db13be9`; green baseline: `pnpm type-check`, 36 JS tests, 88 Rust tests.
**Scope:** every finding in sections 1–12 of the audit. The missing-feature list (F-1…F-18) is out of scope unless a finding's fix requires it.

## Global constraints

- Work only on this branch. Never touch `package.json`, `src-tauri/tauri.conf.json` version fields, `src-tauri/Cargo.toml` version, `.github/`, or `AGENTS.md`.
- Keep the app's UI copy in English; keep code and comments in English. Match the existing style: `<script setup lang="ts">`, Pinia setup stores, Tailwind semantic tokens, no new UI library.
- Do not add a dependency unless this plan names it. The only planned dependency is `tauri-plugin-window-state` in Task 9.
- Keep every existing `data-testid` unless a task explicitly renames it. Keep the `window.__s3viewer` harness surface working.
- Every task ends green: `pnpm type-check`, `pnpm build:frontend`, `pnpm test:js`. Rust tasks additionally: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. Run Rust commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- Accessibility: text that carries meaning meets 4.5:1; every icon-only button has an accessible name; every dialog traps and restores focus; every list operation has a keyboard path.
- Do not change the release/updater/version workflow. Do not commit secrets or local paths.
- When an implementation choice is not specified here, prefer the smaller change that satisfies the audit finding. Do not refactor adjacent code for taste.

## Decisions (binding for all tasks)

- **D1. Selection model.** A plain click selects exactly one row (clears the others) and opens its preview. Cmd/Ctrl+click toggles one row. Shift+click selects the contiguous range from the anchor (replacing the previous selection). Space toggles the focused row. Clicking the list background clears the selection. Delete targets the selection, or the focused row when the selection is empty.
- **D2. Visual hierarchy.** Selected rows get the stronger fill (`bg-accent/20`); the focused row gets a left accent bar and the lighter treatment. `aria-selected` reflects only real selection.
- **D3. macOS keys.** Cmd+Backspace and the forward-delete key delete; Cmd+Up goes up; bare Backspace does nothing on macOS. On Linux, bare Backspace still goes up and Delete deletes. ArrowLeft no longer navigates up anywhere.
- **D4. Truncation.** Show the backend `warning` in a banner with a Retry button and an "Open settings" action. Do not implement pagination in this pass (F-9 stays a feature).
- **D5. Type scale.** All 10 px text becomes 11 px; all 11 px text becomes 12 px. 11 px remains only for badges, counters and micro labels. Add `--text-meta: 0.75rem` and `--text-micro: 0.6875rem` tokens.
- **D6. "New file".** Keep the action and add a dialog with a name and content, so the created object can be filled. Do not remove the feature.
- **D7. Window geometry.** Use `tauri-plugin-window-state`; if it cannot compile or run, fall back to persisting `{x,y,w,h}` through `AppSettings` and report the fallback.
- **D8. "List buckets".** Skipped: it is an onboarding feature, not a defect, and it needs a new backend capability. The connection form keeps manual bucket entry.
- **D9. Connection order.** Keep the existing `last_used_at` ordering. Do not re-sort by name; CON-9 is parked as accepted behaviour.
- **D10. No parallel implementers.** Tasks touch shared files; run them one at a time.

---

## Task 1: Interaction core and keyboard ownership

**Audit:** SEL-1…SEL-7, KEY-1, KEY-2, KEY-4, CON-1 (invariant), VIS-6, DLG-6 (shortcut labels only).
**Depends on:** none.

### Requirements

1. `src/stores/objects.ts`:
   - Add `sessionConnectionId: Ref<string | null>`. Set it in `loadFolder` from the active connection; clear it in `close()`.
   - Add `selectOnly(key)` (new Set with one key, anchor = key).
   - Change `selectRange(key)` to replace the selection with the range (not union) and keep the anchor.
   - Add `deleteTargets` computed: `selectedEntries` when `selected.size > 0`, else the focused entry (0 or 1 entries).
   - `onListingDone` must preserve the selection and focus: intersect the old selection with the new entries, keep `focusedKey` if it still exists, and clear the anchor if it is gone. Do not clear the selection on a reload.
   - `loadFolder` still clears the selection when the prefix changes (a new folder starts fresh).
2. `ObjectList.onClick`:
   - no modifiers: `selectOnly(entry.key)` + `focus(entry.key)` + preview;
   - Cmd/Ctrl: `toggleSelected(entry.key)` + `focus(entry.key)` + preview;
   - Shift: `selectRange(entry.key)` + `focus(entry.key, { keepAnchor: true })` + preview.
   - Clicking the scroller background (not a row) clears the selection.
3. `ObjectRow`:
   - Selected: `bg-accent/20`; focused and not selected: `bg-accent/[0.07]` plus a 2 px left accent bar (`before:` pseudo-element or an inset box-shadow).
   - `aria-selected` is `props.selected` only.
   - The row keeps `role="option"`, gets `id="row-<index>"` and `aria-label` = name.
   - Checkboxes remain visible on hover, on the focused row, or while a selection exists (SEL-2); keep the existing `data-testid` pattern and update the e2e at-rest check to clear focus.
4. `AppToolbar`:
   - Create actions are always visible: `Upload`, `New folder`, `New file` (testids `upload`, `new-folder`, `new-file`).
   - When a selection exists, append a divider, `<N> selected`, then `Download`, `Copy URI`, `Copy to…`, `Move to…`, `Delete`, and the clear button. Do not hide the create actions.
   - Add `title` attributes with platform labels.
5. Context menus in `App.vue`:
   - Row menu: right-clicking a row that is outside the current selection first selects that row alone (clears the other rows), then opens the menu. Every item therefore targets one set: the clicked row when it is the only selection, otherwise the selection. Labels include the count when > 1 (`Download 3 files`, count files only, not folders). `Copy to…`, `Move to…`, `Delete` use the same set. Add shortcut labels (`⌫`/`Del`) where applicable.
   - Background menu: `Upload files…`, `New folder…`, `New file…`, `Refresh`. Write actions are omitted when `!connections.canWriteActive`. `Upload folder…` is deliberately added in Task 6, after the backend can walk directories.
   - Add `disabled?: boolean` to `MenuItem` and render disabled items as non-clickable with reduced opacity; use it instead of silently omitting where a user would look for the action.
6. `useObjectActions`:
   - Add `writeTargets` from `deleteTargets`; `deleteSelection` uses it. If the session connection id does not match the active connection, abort with an error toast and reload the active connection's root.
   - `deleteSelection` clears the preview when the deleted set contains `previewKey`.
   - All mutating actions check `connections.canWriteActive` and show a "Read-only connection" warning instead of calling the backend.
7. `src/lib/keyboard.ts` (new):
   - `IS_MAC` detected from `navigator.userAgent`/`userAgentData`.
   - `modLabel(mac = IS_MAC): "⌘" | "Ctrl+"`.
   - `shortcutLabel(key: string, mac = IS_MAC): string`.
   - `isEditableTarget(target: EventTarget | null): boolean` for input/textarea/select/contenteditable.
   - Pure helpers must be testable; add `tests/js/keyboard.test.js` covering labels and editable-target detection with a fake element? If DOM is unavailable in `node --test`, keep only pure string functions and test those.
8. `App.onKeydown`:
   - Return early when `event.defaultPrevented`.
   - Add `⌘/Ctrl+F` focusing `[data-testid=filter-input]`.
   - Add `⌘/Ctrl+↑` for up on macOS; keep `Backspace` for up only on non-Mac.
   - Delete on macOS: `metaKey && Backspace` or `key === "Delete"`; on non-Mac: `key === "Delete"`.
   - Space toggles the focused row; prevent default.
   - Remove `ArrowLeft` as a navigation key.
   - Add PageUp/PageDown/Home/End movement (move focus + preview, no selection) and type-ahead: printable characters accumulate for 700 ms, find the first visible entry whose name starts with the buffer, focus it, scroll to it, and preview it.
   - Add `⌘/Ctrl+↑` navigation and `⌘/Ctrl+[`? No history exists; only Up.
   - Keep the existing ⌘R/⌘U/⌘N/⌘B/⌘I/⌘L and ⌘A.
9. `Resizer`: in its keydown handler call `event.preventDefault()` and `event.stopPropagation()`.
10. `PreviewPdf`: move the keydown listener from `window` to the scroll host, give the host `tabindex="0"` and a focus outline; stop propagation for handled keys. The PDF must not change pages when the preview is not focused.
11. Update `src-tauri/src/e2e/mod.rs`:
    - Replace the "single click focuses without selecting" check with "single click selects exactly one row and opens its preview".
    - Update the checkbox check: at rest no checkbox is visible; after a click the selection-mode checkboxes are visible.
    - Keep the shift-click check expecting three selected rows.
    - Make the e2e `clickRow` helper clear the selection before clicking, so preview-only scenarios keep their old meaning; add explicit selection assertions where the new model matters.
    - Do not add new e2e scenarios beyond these.

### Verification

`pnpm type-check && pnpm build:frontend && pnpm test:js`; `export PATH="$HOME/.cargo/bin:$PATH" && cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml`.

### Out of scope

Address/breadcrumb changes (Task 2), filter/truncation (Task 3), preview header actions (Task 4), transfer policy (Tasks 5–6).

---

## Task 2: Navigation, address bar, connection menu

**Audit:** NAV-1, NAV-2, NAV-4, NAV-5, NAV-6, CON-1, CON-7 (both the sidebar menu and the ConnectionDialog footer), section 12 (duplicate "No connection selected", toolbar without a connection). NAV-3 moves to Task 7 with the form.
**Depends on:** Task 1.

### Requirements

1. `AddressBar`:
   - Add an Up button before the root crumb (`data-testid="navigate-up"`), disabled at the connection root, title `Up one level (⌘↑)`, calls `objects.navigateUp()`.
   - Clicking the free area of the crumb row starts editing (the whole address container is clickable except the crumbs themselves, which navigate). Keep the pencil inside the crumb group at its end. The edit input's placeholder hints the shortcut: `s3://bucket/path/to/object  (⌘L)` / `(Ctrl+L)`.
   - The root crumb shows the connection name as its label and `s3://bucket/prefix` in the title; the e2e root-crumb expectation changes to the connection name. Keep `data-testid="crumb-root"`.
   - Remove the "No connection selected" span when there is no connection; the main empty state already says it.
   - Empty-prefix navigation: when a typed key is not an object and the prefix listing is empty, try `api.objectMeta(id, folderWithSlash)`; if the marker exists, navigate. Only then show "Nothing found".
2. `ObjectList` background context menu:
   - Replace `@contextmenu.self` with a handler that ignores events whose target is inside `.object-row` (rows already stop their own menu), so right-clicking an empty folder opens the background menu.
3. Sidebar connection menu:
   - Right-clicking a connection opens a `ContextMenu` (do not call `editConnection` and do not change `activeId`).
   - Add a `⋯` button (visible on hover/focus, `aria-label="Connection menu"`, testid `connection-menu-<id>`) at the right edge of each card; it opens the same menu.
   - Menu items: `Open`, `Edit connection…`, `Duplicate`, `Copy bucket URI`, `Remove connection…` (danger).
   - `Edit connection…` opens `ConnectionDialog` for that connection without activating it. After save: refresh the list; if the edited id is the active one, reload the current session; otherwise keep the current session untouched.
   - `Remove connection…` uses `dialogs.confirm` with title `Remove “<name>”?`, message `This removes the connection and its saved credentials from this computer. Objects in the bucket are unaffected.`, confirm label `Remove`, danger. On success: toast, refresh; if it was active, clear the objects session and show the empty state.
   - `Copy bucket URI` copies `s3://bucket/prefix`.
4. Add `connections.refreshCapabilities(id)`: delete the id from `probedThisSession`, clear the cached capabilities on the view, and call `detect(id)` once; a failed probe is silent because the badge reports it. `App.editConnection(connection?)`: accept an optional connection; do not call `connections.setActive` before the dialog. After save, refresh the list, call `refreshCapabilities(saved.id)`, and reload the current session only when the saved id is active. (The backend stale-capability fix is Task 7; this call is safe either way.)
5. Collapsed sidebar: not in this task (Task 9).
6. Update the e2e root-crumb assertion to `connectionName` (the placeholder already exists) and any test that right-clicks a connection, if present.
7. `AppHeader` renders `AppToolbar` only when a connection is active; the main empty state is the only content without one.
8. Clamp up-navigation to the connection scope: `objects.navigateUp()` must stop at `connections.active.prefix` (a non-empty root prefix currently escapes to the bucket root). The Up button and the ⌘↑ shortcut must agree; no-op at the root.
9. `ConnectionDialog` footer: replace the two-step `Delete`/`Delete for good?` with `useDialogs().confirm` (title `Remove “<name>”?`, the same message as the sidebar, `confirmLabel: "Remove"`, `danger: true`); label the button `Remove connection…`. Task 7's form restructure must keep this behaviour.

### Verification

Same as Task 1 (frontend + Rust e2e compiles).

---

## Task 3: List, filter, truncation and list accessibility

**Audit:** LST-1…LST-8, section 12 (toolbar status), DLG-7 partial (loading affordance).
**Depends on:** Task 1.

### Requirements

1. `ObjectList` columns:
   - Order: checkbox, Name, Size, Modified, Type.
   - Show Modified when the list width is ≥ 480 px; show Type when ≥ 820 px. At the default 1280×820 window the list is ~596 px, so Modified must be visible.
   - Expose the sort state accessibly. `aria-sort` is invalid on a plain button, so use an accessible name such as `Sort by Name, ascending` (or introduce proper `columnheader` roles). Do not put `aria-sort` on a button; keep the arrow.
2. Truncation banner:
   - When `objects.truncated || objects.warning`, render a banner above the table header with an alert icon, `objects.warning ?? "Only the first N objects are shown."`, a `Retry` button (`objects.reload()`) and an `Open settings` button that emits a `settings` event to `App` (App opens Settings).
   - The banner is not dismissible; it disappears when the next listing is complete and not truncated.
3. Filter:
   - `AppHeader` keeps a local `filterValue` but watches `objects.filter` and syncs it (including the clear on folder change).
   - Add `aria-label="Filter this folder"`; the placeholder stays.
4. Status:
   - `AppToolbar` counts `visibleEntries`; when filtering, show `"<N> of <M> files"`; keep folder/file counts and total size of the visible files.
   - Remove "loading…" from the status text. Add a spinning indicator on the Refresh button in `AppHeader` while `objects.loading` (use the existing `Loader2`/animation; keep the button clickable).
5. Empty states:
   - Filter-empty: title + `Clear filter` button (sets `objects.filter = ""`; AppHeader syncs).
   - Listing error: keep the message text and add a `Try again` button (`objects.reload()`). Do not create `ErrorNotice` here; Task 8 upgrades this block to `ErrorNotice` with `hints`, `code` and `requestId`.
   - Empty folder: `Upload files` and `New folder` buttons when writable; reuse `useObjectActions`.
   - Keep `data-testid="empty-folder"`; add testids for the new buttons.
   - Error precedence: check `objects.error` before `objects.filter` in the empty-state chain, so a failed refresh with an active filter still shows the error and its Retry.
   - Upload completion: make `upload_files_impl` use each plan item's `id` as the progress id (do not generate a second UUID); `uploadPaths` waits for those ids, toasts failures, and reloads the folder, so the empty-state Upload leaves the empty state. Task 5 reuses this.
   - Error detail request id: add `#[serde(rename_all = "camelCase")]` to Rust `ErrorPayload`, add `requestId` to the listing-error event type, store the S3 request id rather than the internal listing counter, and never overwrite a non-null id with a null one from the catch. Accept both `requestId` and `request_id` in `toError` for safety.
   - The fallback truncation banner text must be count-free (`Only the first objects are shown.`); the backend warning normally supplies the real count.
6. Dates:
   - `humanDate` returns `Today HH:MM`, `Yesterday HH:MM`, else `D MMM YYYY`. `title` shows the full localized date/time. Update `tests/js/format.test.js`.
   - Sorting is unchanged.
7. List keyboard and ARIA:
   - `role="listbox"`, `aria-multiselectable="true"`, `tabindex="0"`, `aria-activedescendant` on the scroller; rows get `id` and `role="option"`.
   - The select-all checkbox gets `aria-label="Select all visible objects"`.
   - Ensure PageUp/PageDown/Home/End/type-ahead from Task 1 work with the virtualized list (use `scrollToRow`).
8. The background menu must not open from a row right-click (Task 2) and must open from the empty state.

### Verification

Frontend gates plus `tests/js/format.test.js`. Rust e2e compiles.

---

## Task 4: Preview panel

**Audit:** PRV-1…PRV-10, section 12 (preview close, panel toggle), SET? no.
**Depends on:** Task 1 (download targets), Task 3 (entries/refresh).

### Requirements

1. One header in `PreviewPanel` for every kind:
   - Name (leaf), full key in the `title`/subtitle, meta line: size · kind · last modified. Do not show a truncated ETag; omit it from the header.
   - Actions as icon buttons with `aria-label` + `title`: `Download`, `Copy s3://`, `Expand`/`Collapse` (`aria-pressed`), `Close` (hides the panel). For folders, show `Copy s3://` and `Open folder` instead of Download.
   - The Markdown `Rendered/Raw` switch moves into the panel header (only for Markdown).
   - The PDF gets Download from the shared header; the PDF renderer keeps only zoom/page/fit.
2. `useObjectActions`:
   - Refactor `downloadEntry` into `downloadKey(key: string, name?: string, { destDir }?)`, honoring `askDownloadLocation`; `downloadEntry` delegates.
   - `PreviewPanel` uses `downloadKey`. It must not bypass the download policy.
3. Renderers:
   - Remove their own header bars and Download buttons/slots (`PreviewImage`'s `actions` slot, `PreviewMedia`, `PreviewCode`, `PreviewTable`, `PreviewMarkdown`). Keep content, truncation notes and the Markdown view.
   - Remove the media "ranged reads" explanation paragraph.
   - `PreviewImage`: add zoom controls (`−`, percent/`Fit`, `+`) and click-to-toggle fit/100%; the image scrolls when zoomed. Keep `data-testid="preview-image"`.
4. Folder selection:
   - When `objects.previewKey` ends with `/` and there is no file preview, show a folder card: icon, folder name, full key, `Copy s3://`, `Open folder` (navigates). Do not use the "Preview unavailable" error style.
5. Refresh:
   - Add `objects.refreshPreview()` that re-fetches the current `previewKey` (by key, not via an entry) and updates loading/error.
   - Call it at the end of `onListingDone` when a `previewKey` exists; if the key is gone from `entries`, clear the preview instead. Do not refresh when the panel is hidden.
   - Add a manual refresh icon in the panel header.
6. Empty state:
   - Replace the format list with a short hint and 3 shortcut rows (`↑ ↓` preview, `Enter` open, `⌘F` filter). Keep the `preview-empty` testid.
7. Hidden panel:
   - `objects.previewEntry` must set `previewKey` and skip the fetch when `ui.previewHidden`. The caller that shows the panel (`AppHeader`'s toggle) calls `objects.refreshPreview()` after `ui.togglePreview()`. Keep the existing hidden attribute behavior; do not make the UI store import the objects store.
   - Ensure the PDF key listener is element-scoped (Task 1) and never fires while hidden.
8. Expand:
   - Add `previewExpanded` to the UI store (not persisted) and `togglePreviewExpanded`.
   - `App` hides the object list and the resizer while expanded; the preview takes the full main width. Escape collapses it before clearing selection (Task 8 handles Escape ordering; add the check now).
   - The Expand button is in the preview header and uses `aria-pressed`.
9. Markdown links:
   - Add a click handler on the rendered Markdown container: for `a[href]` with `http://` or `https://`, prevent default and call `api.openUrl(href)`; ignore other schemes and relative links.
   - Add `open_url` to `src/lib/ipc.ts` and a Rust `open_url` command in `commands.rs`; validate `http`/`https` in a pure helper with a Rust unit test; use `fsutil::open_url` (add it) with the system opener. Register the command in `lib.rs`.
   - Do not try to proxy external images; leave them to CSP.
10. Empty/loading/error states keep their testids (`preview-loading`, `preview-unavailable`, `preview-empty`).
11. Panel toggle in `AppHeader`: `aria-pressed` and an active background when the panel is open (Task 9 can style it; add the attributes now).

### Verification

Frontend gates, Rust gates (new command + test), e2e compile. No visual test harness; the reviewer checks the diff.

---

## Task 5: Transfer backend

**Audit:** IO-1, IO-2, IO-3, IO-4, IO-7 (progress ids), plus the backend support for Task 6.
**Depends on:** none (types are shared).

### Requirements

1. `UploadPlanItem.id` is the progress id (wired in Task 3); the struct gains `skipped: bool`. `UploadInput` gains `#[serde(default)] skip_existing: bool`. Do not add a second progress-id field.
2. `plan_uploads(paths, prefix) -> AppResult<Vec<PlannedUpload>>`:
   - File → key `prefix + file_name`.
   - Directory → walk recursively without following symlinks; for every file key `prefix + dir_name + "/" + relative_path`; create a zero-byte marker for an empty directory.
   - Preserve the structure; reject unreadable paths with the path in the message; refuse more than 10 000 files with a clear error.
   - Keep this function testable with `tempfile` (already a dev-dependency? check; if not, use `std::env::temp_dir` + unique names and clean up).
3. `upload_files`:
   - Build the plan once; start a progress entry synchronously for each non-skipped item and use its id as `UploadPlanItem.id`; skipped items get `skipped: true` and no progress entry.
   - If `skip_existing`, stat each key before starting; do not upload existing ones.
   - The spawn loop checks `progress` cancellation before each item; it cannot abort an in-flight PUT (document this in the command comment).
   - Return the plan immediately.
4. `upload_conflicts(input) -> Vec<String>`: plan with the same rules and return existing keys, with bounded concurrency (≤ 16). Cap the scan at 2 000 keys and return an error above that ("too many files to check").
5. `cancel_transfer(id)`: new command; only cancels a running entry; returns an error for unknown/finished ids. Use `ProgressTracker::cancel`.
6. `download_object`: add `dest_dir: Option<String>`. When set, `dest = fsutil::unique_path(dir, default_file_name(key))` and create the directory; `dest_path` still wins if both are set. Update the TS `DownloadInput`.
7. Update `src/lib/ipc.ts` and `src/types/index.ts` with `uploadConflicts`, `cancelTransfer`, the new fields and the `ProgressState` union (unchanged unless needed).
8. Register the new commands in `lib.rs`.
9. Rust tests: plan preserves a nested tree; empty dir gets a marker; cap error; URL/scheme tests are Task 4.

### Verification

`cargo fmt --check`, `clippy -D warnings`, `cargo test`; `pnpm type-check` (the TS surface must compile even before Task 6 uses it).

---

## Task 6: Transfer UI

**Audit:** IO-1…IO-9, section 12 (toolbar labels, transfer panel).
**Depends on:** Task 5, Task 2 (context menu helpers).

### Requirements

1. Upload:
   - `startUpload(paths)` shared by the picker, drop and folder picker.
   - Check read-only and capability first.
   - If `confirmOverwrite` is on, call `api.uploadConflicts`; if conflicts exist, open a new `UploadConflictDialog` with `Replace all`, `Skip existing`, `Cancel` (`data-testid` on each). Resolve `"replace" | "skip" | null`.
   - Pass `overwrite` and `skipExisting` from the choice. If `confirmOverwrite` is off, pass `overwrite: true`.
   - After the plan returns, toast the start, mention skipped files, and register retries for each plan item `id`.
   - Add `Upload folder…` to the background menu and the empty-state actions using `pickFiles({ directory: true })`. The toolbar `Upload` stays files-only.
2. Bulk download:
   - When `askDownloadLocation` is on, ask for a directory once (`pickFiles({ directory: true, multiple: false })`) and pass `destDir` for each file; no per-file save dialogs.
   - When off, use the stored download folder.
   - Collect the returned transfer ids, wait for them in the background, and show one summary toast if any failed. Do not block the UI.
3. Cancel and retry:
   - `TransferPanel`: a small cancel button on each running transfer (calls `api.cancelTransfer`, then `progress.poll()`), and a `Retry` button on failed transfers that have a registered retry.
   - Add `retries: Map<string, () => Promise<void>>` and `registerRetry(id, fn)` / `retry(id)` to the progress store. Register upload retries per file (re-upload one path to its key with the same policy), and copy/move/delete retries for their single progress id.
   - `Clear` removes only finished items from the local list; running items stay.
4. Read-only:
   - `DropZone` hides while `!connections.canWriteActive`; `onDrop` shows a warning instead of uploading.
   - Background menu write items are disabled/omitted; `createFolder`/`createFile` guard with a toast.
5. New file:
   - Add `CreateFileDialog.vue` with a file name field (validate with `validateKey`) and a content textarea; `createFile` opens it and sends the content. Select and preview the new file after reload.
6. Copy/Move:
   - Default `destinationPrefix` to `""`; placeholder `target/prefix/`.
   - Inline error and disabled confirm when the destination resolves to the source (`same connection && normalized prefix === sourcePrefix`).
   - Hint the resulting path for a single file.
   - Keep folders' names (backend behavior).
7. Upload failures:
   - When a batch finishes, use the progress entries to toast failures (`toasts.error` with the first error and a count) instead of leaving them only in the panel.
8. `TransferPanel` labels: show `cancelled`; keep `done`/`failed`; make the clear/retry/cancel buttons text labels where space allows (not only icons).
9. `CopyMoveDialog` validation and text; no folder picker (F-2 stays a feature).

### Verification

Frontend gates; Rust gates (unchanged since Task 5); e2e compile. The e2e copy test types a prefix and confirms; keep `transfer-prefix` and `transfer-confirm`.

---

## Task 7: Connections, onboarding and settings

**Audit:** CON-2…CON-9 (CON-9 parked by D9), SET-1…SET-4, NAV-3, section 12 (import, settings).
**Depends on:** Task 1 (shortcut labels), Task 2 (edit flow).

### Requirements

1. `ConnectionDialog`:
   - Initialize `endpointUrl` from `props.connection` in the form initializer (no `onMounted` flash).
   - Basic section: Name, Endpoint, Region, Access key, Secret, Bucket, Prefix (`Root folder (scope)` label, hint "Browse stays inside this prefix").
   - `Advanced` disclosure: addressing style, signature version, checksums, security checkboxes, boto3 snippet (`Show boto3 equivalent`), plus the existing warning.
   - Presets at the top: `AWS S3` (endpoint `https://s3.amazonaws.com`, region `us-east-1`) and `Other S3-compatible` (blank endpoint/region). Changing a preset only fills empty fields; never overwrite typed values.
   - `Test connection` moves to the footer, left of Cancel/Save. Keep the result chips and error block.
   - Required markers (`*`) on Name, Endpoint, Region, Bucket, Access key, Secret (create). On failed validation, focus and scroll the first invalid field and add `aria-invalid`; keep inline messages.
   - The footer's `Remove connection…` was completed in Task 2; keep that confirm flow while restructuring the form.
2. Re-probe after save:
   - Backend `store.upsert` removes the stored capabilities for the edited id (add a Rust test), so a restart cannot show stale rights.
   - Frontend `connections.refreshCapabilities(id)` clears `probedThisSession` and calls `detect(id)`; `App.editConnection` calls it after save.
3. Import:
   - Change the copy to "Paste a JSON credentials file or a boto3 client snippet." (do not promise AWS INI).
   - `ImportDialog` resolves `string[]` of created connection ids (or `[]`); `App.openImport` opens the first imported connection, not `all[0]`.
   - Keep the preview list and error handling; render multi-line failures with `whitespace-pre-line` (Task 8 also touches toasts).
4. Settings:
   - After `openSettings` resolves, reload the current folder when a connection is active (SET-1 and the truncation banner's "Open settings" become effective).
   - Theme: `ui.applyTheme` listens to `matchMedia('(prefers-color-scheme: light)')` while `theme === "system"`; clean up not needed for the app lifetime.
   - Theme flash: add `public/theme-init.js` with the localStorage resolution and a `<script src="/theme-init.js"></script>` in `<head>` before the module. `ui.saveSettings`/`ui.load` write `s3viewer.theme` (`"dark" | "light" | "system"`). The script must respect CSP (`script-src 'self'`); do not inline.
   - Persist `previewHidden`: add `preview_hidden` to the Rust `LayoutSettings` (serde default false) and TS `LayoutSettings`; `ui` uses `layout.previewHidden` as the source of truth and persists it with the layout (debounced). Keep the `previewHidden` getter API used by components.
   - Add a `Reset to defaults` button that resets the form to the default settings (not saved until Save).
   - Add a `Keyboard shortcuts` section with a static list using `shortcutLabel` (Task 1): Refresh, Upload, New connection, Edit connection, Address, Filter, Up, Toggle sidebar, Select all, Open, Delete.
   - Move the Security block to the bottom and keep it collapsed in a `<details>`? Keep it visible; just order the sections Preview, Browsing, Downloads, Shortcuts, Application, Security.
5. `AppSidebar` capability tone:
   - "not probed" uses the neutral tone, not warn.
   - The user read-only badge reads `writes blocked`; the probed read-only badge stays `read-only`. Add a title explaining the difference.
6. CON-6 (collapsed rail) is Task 9.

### Verification

Frontend gates, Rust gates (store test, settings serialization). `tests/js` if a pure theme helper is added; keep the init script plain JS.

---

## Task 8: Dialogs, feedback and accessibility

**Audit:** DLG-1…DLG-8, VIS-8, section 12 (dialog size), DLG-3 (hints).
**Depends on:** Tasks 2, 6, 7 (forms exist).

### Requirements

1. Dialog stack:
   - `dialogs.open(component, buildProps, size, options?: { dismissible?: boolean })`; default `true`. Add `dismissible` to `DialogRequest`.
   - `DialogHost` passes `size` to the component (fix the dead field) and closes on backdrop only when the top dialog is dismissible.
   - Forms (`ConnectionDialog`, `SettingsDialog`, `ImportDialog`, `CopyMoveDialog`, `CreateFileDialog`, `UploadConflictDialog`) pass `dismissible: false`. `ConfirmDialog`, `PromptDialog` and `UpdateDialog` stay dismissible (Prompt/Confirm have no unsaved bulk).
2. `ModalFrame`:
   - Generate a title id with `useId`, add `aria-labelledby`, `role="dialog"`, `aria-modal`.
   - `useFocusTrap`: focus the first `[autofocus]` element, or the first focusable element, or the frame; cycle Tab/Shift+Tab; restore the previously focused element on unmount. Trap only when the frame is visible (`offsetParent !== null`), so a stacked, hidden dialog cannot steal keys.
   - Mark the frame `tabindex="-1"`.
3. `ConfirmDialog`:
   - Autofocus Cancel for danger, confirm otherwise; Enter confirms only when not danger; Escape cancels (DialogHost already handles Escape).
4. `AppField`:
   - Move the hint/error text outside the `<label>` (keep the control inside), so the accessible name is only the label. Keep the layout.
5. Error surfacing:
   - Add `ErrorNotice.vue`: props `message`, `hints?`, `code?`, `requestId?`, optional `retry`; render the hints as a list and the code/id in a small monospace line.
   - Add `toasts.apiError(error, title?)` that appends `hints` on separate lines; `ToastStack` renders messages with `whitespace-pre-line`.
   - Store `errorDetail` in `objects` (listing) and `previewErrorDetail` (preview) from the caught `ApiError`; use `ErrorNotice` in the listing empty state and the preview error state.
   - Replace `toasts.error((error as Error).message, ...)` in `useObjectActions`, `App`, `PreviewPanel`, `ConnectionDialog`, `ImportDialog`, `SettingsDialog` with `toasts.apiError` where the error is an `ApiError`.
6. Toasts:
   - Container `aria-live="polite"`, each error toast `role="alert"`.
   - Pause the auto-dismiss timer on hover/focus, resume on leave/blur (`pause(id)`/`resume(id)` in the store). Multiple toasts stack; no layout shift.
7. `ContextMenu`:
   - Focus the first item on mount; ArrowUp/Down, Home/End, Escape; restore focus on close; `aria-label="Context menu"`; `aria-disabled` and no action for disabled items (the `disabled` field from Task 1).
8. Boot:
   - Add `bootState: "loading" | "ready" | "error"` and `bootError` to `App`; register listeners and start progress before the first await.
   - Show a centered spinner over a neutral shell while loading; on error show `Could not start`, the message, and `Try again` (re-run boot).
   - Auto-open the first connection, then set ready. This removes the "No connection selected" flash (DLG-7).
   - Preserve the Task 4 Escape ordering: an expanded preview collapses first, then Escape clears the selection.
9. Dialog size, focus, hints: verify with type-check and manual reasoning; add no test harness.

### Verification

Frontend gates; Rust gates unchanged. Update the e2e if a dialog selector changed (keep existing testids).

---

## Task 9: Visual tokens, platform and cleanup

**Audit:** VIS-1…VIS-7, PLT-1…PLT-3, CON-6, section 12 (labels, dead code, panel toggle).
**Depends on:** all previous tasks.

### Requirements

1. Theme tokens in `src/assets/main.css`:
   - Dark `--c-text-subtle: #9aa3b2`; light `--c-text-subtle: #6b7078`; light `--c-ok: #15803d`.
   - Dark `--c-accent: #2f6fed`, `--c-accent-hover: #2a63d6`; keep the light accent.
   - Recheck `--c-ok`, `--c-warn`, `--c-danger` text on their surfaces; adjust only if below 4.5:1.
   - Add `--text-meta: 0.75rem` and `--text-micro: 0.6875rem` to `@theme inline`; replace `text-[0.6875rem]` with `text-meta` and `text-[0.625rem]` with `text-micro` across `src/`, including the components added by Tasks 1–8. Verify the build and that no `text-[0.625rem]`/`text-[0.6875rem]` remains.
   - Add a `prefers-reduced-motion` block that reduces transitions/animations.
2. File-kind palette:
   - Add CSS variables `--kind-folder`, `--kind-image`, `--kind-audio`, `--kind-video`, `--kind-pdf`, `--kind-markdown`, `--kind-json`, `--kind-csv`, `--kind-parquet`, `--kind-code`, `--kind-text`, `--kind-archive`, `--kind-binary`, `--kind-unknown` in both themes with values that meet 3:1 against `--c-surface` (icons are decorative, but they carry type; target 3:1 minimum, 4.5:1 preferred).
   - `kindIcon.ts` returns semantic classes (`kind-folder` etc.); `main.css` maps them to `color: var(--kind-*)`.
   - Dark values mirror today's look; light values use the 600/700 shades.
3. Sidebar alignment:
   - Remove the 30 px `drag-region` spacer from `AppSidebar` (the window is decorated). Align the sidebar header with the address row; keep the native title bar.
4. Collapsed rail:
   - Show the first letter (or two) of the connection name in a 20 px circle with a deterministic hue per id; keep the status dot; keep the active state. Add `aria-label` with the full name.
5. Panel toggle and labels:
   - `AppHeader` preview toggle: `aria-pressed`, active background when open.
   - Toolbar labels: `New folder`, `New file`, `Copy URI`.
   - Ensure the preview close button exists (Task 4).
6. Dead code:
   - Delete `src/components/layout/AppBreadcrumb.vue` (unused).
   - Remove `rowActionClass` from `controls.ts`, `defaultLayout` and `transfersVisible` from `ui.ts`, `joinKey` from `keys.ts`, the unused `saveTextObject` wrapper from `ipc.ts`.
   - Keep `pluralize` (tests use it). Remove any imports left behind.
7. Window geometry:
   - Add `tauri-plugin-window-state = "2"` to `src-tauri/Cargo.toml` and `.plugin(tauri_plugin_window_state::Builder::default().build())` to `lib.rs`; run `cargo check`/`cargo test` and commit `Cargo.lock`.
   - If the plugin fails to build or launch, fall back to saving `{x,y,w,h}` in `AppSettings` and applying it on boot; report the fallback.
8. Window title:
   - Add `core:window:allow-set-title` to `src-tauri/capabilities/default.json`.
   - In `App`, a watcher on the active connection and `objects.prefix` calls `getCurrentWindow().setTitle(...)` lazily (catch errors). Title format: `"<connection> · <bucket>/<relative prefix>"`, or `S3 Viewer` with no connection. Also set `document.title`.
9. Platform labels:
   - Replace remaining hardcoded `⌘` in titles/help text with `shortcutLabel`/`modLabel` (grep `⌘` and check every string). Keep the glyphs in prose only where the platform is explicitly macOS.
10. Check `humanSize` 1024 vs Finder: no change (ruling).
11. Remove the `sr-only "S3 Viewer"` dead footer in `App.vue`.

### Verification

Frontend gates; Rust fmt/clippy/test; `pnpm build:frontend` must pass with the window-state plugin. Grep checks: no `text-[0.625rem]`, no `text-[0.6875rem]`, no `AppBreadcrumb` imports.

---

## Final gate

After Task 9: run `pnpm install --frozen-lockfile` (unchanged JS lock), `pnpm type-check`, `pnpm build:frontend`, `pnpm test:js`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. Then run the final whole-branch review and fix the findings once. Do not change the app version or release files.
