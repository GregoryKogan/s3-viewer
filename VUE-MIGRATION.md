# Vue 3 migration — state of play

The frontend is being rewritten from vanilla JS/CSS to Vue 3 + Tailwind + Lucide.
This note is the handover: what exists, what is missing, and the exact commands.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Vue 3.5, `<script setup lang="ts">` |
| Build | Vite 8 (`vite.config.ts` → `dist/`, which is what `tauri.conf.json` loads) |
| Styling | Tailwind v4 via `@tailwindcss/vite`; semantic tokens in `src/assets/main.css` |
| Icons | `@lucide/vue` (the maintained package; `lucide-vue-next` is deprecated) |
| State | Pinia (setup stores) |
| Types | Hand-written mirrors of the Rust `Serialize` shapes in `src/types/index.ts` |

## Done

- `vite.config.ts`, `tsconfig.json`, `env.d.ts`, `index.html`, `src/main.ts`… **`src/main.ts` is missing, see below.**
- `src/assets/main.css` — the whole theme: dark/light tokens, base layer, scrollbars,
  drag regions, highlight.js token colours, and rendered-Markdown styling. No
  component defines a raw colour; they all use `bg-surface`, `text-muted`, etc.
- `src/types/index.ts` — every wire type.
- `src/lib/` — `ipc.ts` (typed command bridge, dialogs, events, clipboard),
  `format.ts`, `keys.ts`, `fileKind.ts` (extension → `FileKind`, mirroring
  `src-tauri/src/s3/kind.rs`).
- `src/stores/` — `ui` (settings, theme, panel geometry, persistence), `connections`
  (CRUD + capability probe + import), `objects` (folder, streamed listing,
  selection, sorting, preview), `progress` (transfer polling), `toasts`, `dialogs`.
- `src/composables/` — `useVirtualList`, `useDialogs` (promise-based
  `confirm()` / `prompt()`), `useObjectActions` (upload, create, delete,
  copy/move, download, URI copy — one implementation shared by the toolbar, the
  rows and the shortcuts).
- `src/components/ui/` — `AppButton`, `AppBadge`, `AppField`, `ModalFrame`,
  `DialogHost`, `ConfirmDialog`, `PromptDialog`, `ToastStack`, `Spinner`,
  `EmptyState`, plus `controls.ts` with the shared input/select/textarea recipes.
- `src/components/layout/` — `AppSidebar`, `AppHeader`, `AppBreadcrumb`,
  `AppToolbar`, `Resizer`.
- `src/components/browser/` — `ObjectList` (virtualised window, select-all,
  sortable header) and `ObjectRow` (tinted per-kind icon, hover URI button).
- `src/components/preview/PreviewPanel.vue` — header, empty/error/unavailable
  states, and dispatch to the renderers.
- `src/components/dialogs/CopyMoveDialog.vue`.

## Missing — finish in this order

1. **`src/main.ts`** — create the app, install Pinia, mount, and expose the e2e
   hooks the Rust harness expects:

   ```ts
   import { createApp } from "vue";
   import { createPinia } from "pinia";
   import App from "@/App.vue";
   import "@/assets/main.css";

   const app = createApp(App);
   app.use(createPinia());
   app.mount("#app");
   // The e2e scenario drives the UI through these; keep the names.
   // window.__s3viewer = { state, describe(), refresh, select, openConnection,
   //                      refreshConnections, scrollToRow, copySnippet };
   // window.__s3viewerRenderPreview = renderPreview;
   // window.__s3viewerSanitizeProbe = () => …;
   // window.__s3viewerReady = true;   // set after boot resolves
   ```

   `window.__s3viewer.describe()` must keep returning
   `{ loading, entries, filter, visible, previewKey, selected }` and
   `scrollToRow(index)` must scroll the virtualised list — the e2e scenario reads
   both.

2. **`src/App.vue`** — the shell: titlebar, `AppSidebar` + `Resizer`,
   `AppHeader` + `ObjectList` + `PreviewPanel` + `Resizer`, `DropZone`,
   `TransferPanel`, `ToastStack`, `DialogHost`. Global keyboard shortcuts
   (`⌘R` refresh, `⌘U` upload, `⌘N` new connection, `⌘B` collapse, arrows /
   Enter / Backspace / Delete) and the `listing://page|done|error` subscriptions
   belong here. See the "Wiring" section below.

3. **`src/components/preview/renderers/`** — five components referenced by
   `PreviewPanel.vue` and not yet written:
   - `PreviewImage.vue` — `<img :src="data.streamUrl">` on a checkerboard, with a
     decode-error fallback. `data-testid="preview-image"`.
   - `PreviewMedia.vue` — `<audio>` / `<video>` / `<iframe>` for
     `data-testid="preview-audio" | "preview-video" | "preview-pdf"`, all bound to
     `data.streamUrl` (`preload="metadata"`, `controls`).
   - `PreviewMarkdown.vue` — `marked` + the allow-list sanitiser, with the
     Rendered/Raw switch (`data-testid="md-view-rendered" | "md-view-raw"`,
     body `data-testid="preview-markdown"`, raw `<pre data-testid="preview-code">`).
   - `PreviewCode.vue` — highlight.js (`data-testid="preview-code"`); port the
     language resolution and the 48 KB detection cap from
     `.legacy-frontend/js/preview.js` verbatim, including the
     `json`-must-not-fall-through-to-`parquet` dispatch.
   - `PreviewTable.vue` — Parquet `data.table` and the CSV parser
     (`data-testid="preview-table"`), ported from the same file.

   Take `renderPreview`, `sanitize`, `parseDelimited`, `resolveLanguage` and the
   `EXTENSION_LANGUAGE` / `FILENAME_LANGUAGE` / `DETECT_CANDIDATES` tables straight
   from `.legacy-frontend/js/preview.js`, and `boto3Snippet` from
   `.legacy-frontend/js/connection-form.js`. Those are tested behaviour.

4. **`src/components/dialogs/ConnectionDialog.vue`** — the connection editor. Port
   from `.legacy-frontend/js/connection-form.js`. Required test ids:
   `conn-name`, `conn-endpoint`, `conn-region`, `conn-access-key`,
   `conn-secret-key`, `conn-bucket`, `conn-prefix`, `conn-addressing`,
   `conn-signature`, `conn-save`, `conn-test`, `conn-detect`, `boto3-snippet`,
   `probe-output`. The two checksum selects are new (`request_checksum_calculation`,
   `response_checksum_validation`, values `whenSupported` / `whenRequired`). The
   snippet must be highlighted and have a Copy button.

5. **`src/components/dialogs/SettingsDialog.vue`** — port from
   `.legacy-frontend/js/settings.js`. Test ids: `settings-preview-limit`,
   `settings-list-limit`, `settings-theme`, `settings-download-dir`,
   `settings-show-system`, `security-summary`, `settings-save`. It must show
   whether the master key is in the OS keychain, the config path and its mode.

6. **`src/components/dialogs/ImportDialog.vue`** — port from
   `.legacy-frontend/js/import.js`. Test ids: `import-textarea`,
   `import-preview`, `import-confirm`. Accepts the team's
   `{ bucket: { access_key, secret_key, endpoint } }` JSON and a pasted boto3
   snippet.

7. **`src/components/layout/TransferPanel.vue`** — the transfer drawer, driven by
   `useProgressStore`: `data-testid="transfers"`, per-item
   `data-testid="transfer-{state}"`, Open / Reveal / Clear actions.

8. **`src/components/layout/DropZone.vue`** — the OS drag-and-drop target; wire
   `tauri://drag-enter|drag-leave|drag-drop` to `useObjectActions().uploadPaths`.

9. **Delete `.legacy-frontend/`** once `pnpm type-check && pnpm test:e2e` is green,
   and drop it from `.gitignore`.

## Wiring notes (gotchas already hit)

- **Commands are async on the Rust side.** `list_objects_stream` emits
  `listing://page`, `listing://done`, `listing://error`; subscribe with `listen()`
  from `src/lib/ipc.ts` and feed `objects.onListingPage/Done/Error`. A listing is
  swapped in only when it finishes — never appended into the visible list.
- **The preview is cleared by folder navigation, not by a folder reload.** Clearing
  it on every reload was a real bug (the panel blanked while a preview was open).
- **`applyLayout` must not repaint the list.** In the vanilla build a layout call
  inside the preview render re-entered the render and aborted it before the panel
  was cleared. In Vue this is structural — keep geometry in the `ui` store and let
  Vue re-render — but do not reintroduce a paint call from a render path.
- **Unicons in the sidebar are gone:** every emoji is now a Lucide icon. Keep it
  that way; the `kindIcon.ts` map is the single place a file-kind icon is chosen.
- **Test ids are a contract.** `src-tauri/src/e2e/mod.rs` selects on them; the list
  in step 3–8 is what the suite uses.

## Commands

```bash
pnpm build:frontend     # vite build → dist/
pnpm type-check         # vue-tsc --noEmit   (add the script)
pnpm tauri dev          # build then run
node e2e/run.mjs        # 37 checks against the real bucket
```

`package.json` still points `build:frontend` at the old esbuild script — switch it
to `vite build` and add `"type-check": "vue-tsc --noEmit"`.
