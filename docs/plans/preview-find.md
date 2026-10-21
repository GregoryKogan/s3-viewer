# Find in the text preview

**Approved design:** the conversation of 2026-10-21 (user approved the plan and asked for Subagent-Driven Development). No separate spec file: the approved message is the authority.
**Branch:** `feat/preview-find`.
**Baseline:** `16932d4` — `pnpm type-check` clean, `pnpm test:js` green.
**Scope:** an in-preview find bar for plain-text previews (code, JSON, `.txt`/`.log`, Markdown **Raw**), its state, its DOM marking, the `⌘F` routing and the preview-header button. No Rust changes, no dependency changes.

## Global constraints

- Work only on this branch. Do not touch the three version fields, `.github/`, `AGENTS.md`, the updater or the Rust crate.
- Code, comments and UI copy in English. Match the existing style: Vue 3 `<script setup lang="ts">`, Pinia setup stores, Tailwind semantic tokens, `@lucide/vue` icons, existing `AppButton`/`inputClass`.
- No new dependency. `@lucide/vue` already exports `CaseSensitive`, `WholeWord`, `Regex`, `ChevronUp`, `ChevronDown`, `Search`, `X` — verify before importing anything else.
- Keep every existing `data-testid`. New controls carry the ids named below.
- Every task ends green: `pnpm type-check`, `pnpm test:js`, `pnpm build:frontend`.
- Do not reformat or refactor adjacent code. A diff contains only what the task asks for.
- Target is macOS 11 / WKWebView: no regex lookbehind, no CSS Custom Highlight API, no `Array.prototype.findLast`.

## Decisions (binding for all tasks)

- **D1. Two searches, one key.** `⌘F` opens find-in-file **only** when the focused element sits inside `[data-focus-zone="preview"]` **and** the preview is a searchable text view. Everywhere else it keeps focusing the folder filter (`[data-testid=filter-input]`) exactly as today. The preview header gets a `Search` button (`data-testid="preview-find"`) that is rendered only when find is possible; it is the discoverable entry point and calls the same code path.
- **D2. Searchable views.** `text`, `code`, `json` always; `markdown` only in the Raw view; never images, media, PDF, CSV, Parquet. The predicate lives in one exported function, `isPreviewSearchable(kind, view)` in `src/lib/previewText.ts`, used by both the header button and the `⌘F` branch.
- **D3. Widget.** A bar floating over the top-right of the text area: input, counter, previous/next, `Aa` (Match Case), whole-word, `.*` (regex), close. Enter = next match, Shift+Enter = previous, Escape = close and return focus to the scroller. The bar never steals the list's keyboard while closed: it exists only while open.
- **D4. Semantics.** Case-insensitive by default. Whole word is a manual boundary check on `[\p{L}\p{N}_]` — **not** `\b`, which does not treat Cyrillic as a word character; whole word is disabled and ignored in regex mode (VS Code parity). Regex compiles with `g` (plus `i`/`u`); an invalid pattern shows `Invalid regex` and matches nothing, it never throws. Empty and zero-length matches are skipped. At most `MAX_MATCHES = 2000` hits; the counter then shows a trailing `+`.
- **D5. Scope of the search.** Only the text already in `PreviewData.text`, i.e. at most the 2 MB the backend sends. The existing "Showing only the beginning of the file." banner already tells the user the file is truncated. No new IPC.
- **D6. Sticky options, fresh query.** Match Case, Whole Word and Regex survive across files and across closing the bar. The query is cleared when the preview switches to another object, and the bar closes when the preview stops being searchable.
- **D7. Marking.** Highlights are `<mark class="preview-find-hit" data-find-index="N">` elements wrapping text nodes inside the rendered `<pre>`; the active one also gets `preview-find-active`. Highlighting from `highlight.js` is preserved: the walker splits text nodes, it does not replace `innerHTML`. Before every repaint the previous marks are unwrapped and their parents normalised, so offsets stay those of the source string.
- **D8. No replace.** Out of scope: replace, CSV/Parquet cells, rendered Markdown, the folder listing.
- **D9. Line endings.** `v-html` and HTML fragment parsing normalise `\r\n`/`\r` to `\n` in the rendered `<pre>`, while the payload keeps CRLF. `findMatches` therefore runs on the LF-normalised source (`source.replace(/\r\n?/g, "\n")`) so its code-unit offsets line up with the DOM text the marks are built from. `markup` may keep the raw source: the parser normalises it the same way.

- **D10. The bar gives way before it clips.** The bar is `absolute` in a `relative @container` column and shrinks to `max-w-[calc(100%-1rem)]`; the three toggles hide under a `22rem` container and the counter under `26rem` (each hidden only after the width it frees stops mattering), so the narrow preview floor (`PREVIEW_MIN = 260`) never pushes the input off the left edge. The toggles stay reachable by their shortcuts. Their mouse controls use `@mousedown.prevent`, so a click never blurs the input — without it a WKWebView click drops the keyboard contract to the shell.

- **D11. Escape backs out one visible step; the bar is the first one.** With the bar open in the preview column, `Escape` closes it even when the preview is expanded — the bar is an overlay on the text, the expansion is the panel's layout, and collapsing a maximal panel while the thing you tried to dismiss stays on screen is the larger change. Only the next `Escape` collapses the expansion, then leaves the column. The shell routes this at the top of the Escape handling (before the expanded-preview block), so inside the preview column the answer does not depend on where focus sits; focus outside the column leaves the bar alone.

- **D12. The bar only exists over a text body.** `canFind` requires a searchable kind (`kind` falls back to `unknown` without a payload) *and* a rendered, available preview (`!previewUnavailable`), so a text file that shows "Preview unavailable" offers neither the header button nor a `⌘F` that would swallow the key with no bar mounted. The truncation banner is likewise gated on a text payload and no unavailable state: the backend also flags media over `HEAD_LIMIT` as truncated while the renderer streams the whole object. Hiding the column closes the bar (the query and options survive) because the panel stays mounted.

- **D13. Closing the bar keeps the count.** `hide()` clears the active hit but leaves `matchCount`, and the body repaints the count whether or not the bar is open. Zeroing it made a reopened bar mount with a retained query and `0` hits, so it flashed "No results" in danger red for one frame before the repaint marked the real hits. The count only ever describes the current text and query, both of which outlive the bar.

---

## Task 1: `findMatches` — the pure matcher

**Depends on:** none.

### Requirements

1. Create `src/lib/textSearch.ts` with exactly this public surface (private helpers may be added below it):

```ts
export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface FindResult {
  matches: MatchRange[];
  /** Non-null when `regex` is on and the query does not compile. */
  error: string | null;
  /** True when `MAX_MATCHES` cut the list short. */
  capped: boolean;
}

/** Stop collecting here: a 2 MB log matches millions of times. */
export const MAX_MATCHES = 2000;

/** Escape a literal query so it cannot act as a pattern. */
export function escapeRegExp(query: string): string;

/** All non-overlapping matches of `query` in `text`, in source order. */
export function findMatches(text: string, query: string, options: FindOptions): FindResult;
```

2. Behaviour, precisely:

- `!query || !text` → `{ matches: [], error: null, capped: false }`. Whitespace-only queries are searched as written (a space is a valid query).
- Literal mode (default) escapes `query` with `escapeRegExp`, which escapes `. * + ? ^ $ { } ( ) | [ ] \`.
- Flags: `"g"` + (case-sensitive ? `""` : `"i"`) + `"u"`. The `u` flag makes `\p{L}` work and keeps astral characters from splitting a match; a literal query containing a lone surrogate throws — catch it and return `error` like any other invalid pattern, it must not crash.
- Iterate with `pattern.exec(text)`; for every match compute `start = match.index`, `end = start + match[0].length`.
  - `end === start` (zero-width: `^`, `$`, `\b`, an empty alternative) → advance `pattern.lastIndex = start + 1` and continue; never push it.
  - If `wholeWord && !regex`, keep the match only when the character before `start` and the character after `end` are both non-word (`/[\p{L}\p{N}_]/u` on a boundary character; out-of-range counts as non-word).
  - Push, and stop collecting once `matches.length === MAX_MATCHES`. `capped` is `true` **only** when at least one further valid match exists beyond the cap — a file with exactly 2000 hits is not "capped" (a user must not see "2000+" for a complete result). Keep scanning past the cap with the same filters until the next valid match proves it, or the text ends.
- `wholeWord` is **ignored** when `regex` is on.
- Invalid regex → `{ matches: [], error: "<the engine message>", capped: false }` (use `error instanceof Error ? error.message : String(error)`).
- Overlapping matches are not reported (plain `exec` semantics, e.g. `aa` in `aaa` matches once).

3. Create `tests/js/textSearch.test.js` in the style of the existing suites (`node:test` + `node:assert/strict` + `loadTs`):

```js
const { findMatches, escapeRegExp, MAX_MATCHES } = await loadTs("@/lib/textSearch");
```

   Cover at least: one literal hit and its offsets; case-insensitive by default and case-sensitive when asked; literal `.` matching only a dot while regex `.` matches any byte; whole word on `cat` in `cat concatenate cats` (one hit) and on Cyrillic `кот` in `кот котик коты` (one hit); whole word ignored in regex mode (`\bcat` style query with `wholeWord: true` still matches inside `concatenate` only if the pattern says so — assert the toggle changes nothing); invalid regex `(` returns an error and no matches; empty query and empty text return empty results; a zero-width regex like `^` returns no matches and terminates; `capped` false for a string of exactly `MAX_MATCHES` a's and true for `MAX_MATCHES + 10`; `assert.equal(MAX_MATCHES, 2000)` so a drifted constant fails; the zero-width test carries `{ timeout: 5000 }` so a regression fails instead of hanging; `escapeRegExp("a+b")` → `a\+b`.

### Verification

`pnpm type-check && pnpm test:js && pnpm build:frontend`

---

## Task 2: find state and DOM marking

**Depends on:** Task 1.

### Requirements

1. Create `src/stores/previewFind.ts`, a Pinia setup store named `previewFind` (the repo's style, see `src/stores/objects.ts`):

```ts
open: Ref<boolean>;            // the bar is visible
query: Ref<string>;
caseSensitive: Ref<boolean>;   // default false
wholeWord: Ref<boolean>;       // default false
regex: Ref<boolean>;           // default false
activeIndex: Ref<number>;      // -1 when there is no active hit
matchCount: Ref<number>;
focusNonce: Ref<number>;       // bump to re-focus the input

show(): void;                  // open = true, focusNonce++
hide(): void;                  // open = false, activeIndex = -1, matchCount = 0
resetQuery(): void;            // query = "" and activeIndex = -1, options untouched
setQuery(value: string): void; // query = value, activeIndex = -1
setActive(index: number): void;
setMatchCount(count: number): void;
step(delta: number): void;     // wrap around matchCount; no-op at 0
toggleCase(): void;
toggleWholeWord(): void;       // no-op while regex is on
toggleRegex(): void;           // turning regex on also clears wholeWord
```

   `step` must work from `activeIndex === -1`: `(-1 + 1 + n) % n === 0`.

2. Create `src/lib/searchMarks.ts` — the only module that touches the DOM for highlights:

```ts
export const HIT_CLASS = "preview-find-hit";
export const ACTIVE_CLASS = "preview-find-active";

/** Unwrap every hit mark under `root` and normalise the parents it touched. */
export function clearMarks(root: ParentNode): void;

/**
 * Wrap each match in its own <mark.data-find-index>. A match that spans
 * several text nodes (highlight.js splits a line into many spans) gets one
 * mark per node, all carrying the same index. Returns every mark created,
 * in match order.
 */
export function markMatches(root: ParentNode, matches: MatchRange[]): HTMLElement[];
```

   Implementation notes: collect text nodes with `document.createTreeWalker(root, NodeFilter.SHOW_TEXT)` and cumulative offsets; walk matches **and** their runs from last to first so earlier offsets stay valid; split with `Text.splitText` (split at the run-local end first, then at the run-local start) and wrap the middle node; replace the node with the mark using `parent.replaceChild`. Never touch a text node outside a run. `clearMarks` runs before every `markMatches` and must leave the text identical to what `highlight.js` produced (only `normalize()` merges nodes back, whitespace preserved).

3. Add to `tests/js/textSearch.test.js` — no DOM in this suite, so test only what is testable without one: assert that `src/lib/searchMarks.ts` exports both helpers and both class constants by importing it? **No** — it touches `document` at call time only, so `loadTs` is safe, but there is nothing to assert. Instead: skip unit tests for this module and note in the report that the DOM behaviour is verified in the browser during Task 5's manual check. (Task reviewer: the absence of tests here is deliberate — the module is DOM glue.)

### Verification

`pnpm type-check && pnpm test:js && pnpm build:frontend`

---

## Task 3: the find bar

**Depends on:** Task 2.

### Requirements

1. Create `src/components/preview/FindBar.vue`. Props:

```ts
{ matchCount: number; error: string | null; capped: boolean; activeIndex: number }
```

   It reads and writes `usePreviewFindStore()` for everything else and emits one event, `"close"` (the parent returns focus to the scroller). Do not put the query in the child's local state.

2. Layout — a compact single row, `absolute right-2 top-2 z-10`, `rounded-control border border-line-strong bg-elevated shadow-lg`, height ~`h-8`, `text-meta`, with these `data-testid`s: `find-bar`, `find-input`, `find-counter`, `find-prev`, `find-next`, `find-case`, `find-whole-word`, `find-regex`, `find-close`.

- Input: width ~`w-52`, transparent background, no ring of its own (`outline-none`), placeholder `Find`, bound to `find.query`; receives focus whenever `find.focusNonce` changes or the bar opens, and `select()`s on focus so `⌘F` re-selecting the old query matches VS Code.
- Counter: `{{ activeIndex + 1 }} of {{ matchCount }}{{ capped ? "+" : "" }}`; when `error` → `Invalid regex` in `text-danger`; when `query` is non-empty and `matchCount === 0` → `No results` in `text-danger`; otherwise hidden. `tabular` class.
- Prev/next: ghost icon buttons `ChevronUp`/`ChevronDown`, `:disabled="matchCount === 0"`, call `find.step(-1)` / `find.step(1)`; titles `Previous match (⇧↩)` and `Next match (↩)`.
- Toggles: `CaseSensitive`, `WholeWord`, `Regex` from `@lucide/vue`, `aria-pressed`, active state `bg-accent/15 text-accent-text`, inactive `text-muted hover:bg-hover`; titles `Match Case (⌥⌘C)`, `Match Whole Word (⌥⌘W)`, `Use Regular Expression (⌥⌘R)`; whole-word is `disabled` with `opacity-40` while `find.regex` is on.
- Close: `X`, emits `"close"`, title `Close (Esc)`.

3. Keyboard, on the bar's root (`@keydown`), stopping propagation so the shell never sees these keys:

- `Escape` → emit `"close"`.
- `Enter` → `find.step(event.shiftKey ? -1 : 1)`.
- `⌥⌘C` / `⌥⌘W` / `⌥⌘R` (also Ctrl on non-mac: `event.metaKey || event.ctrlKey`) → toggle case / whole word / regex.
- `⌘F` while the input is focused → focus and select the input again (do not close, do not open the folder filter); the shell must never receive it (`event.preventDefault()` + `stopPropagation()` in a capture-free handler is enough because the shell listens on `window` after this element handled it — verify: the shell listener is on `window`, bubbling, so `stopPropagation` on the input's keydown prevents it).

### Verification

`pnpm type-check && pnpm test:js && pnpm build:frontend`

---

## Task 4: the text body and the two renderers

**Depends on:** Tasks 1–3.

### Requirements

1. Create `src/components/preview/PreviewTextBody.vue`:

   Props `{ source: string; markup: string | null; truncated: boolean }`. Renders:

   - a `relative @container flex min-h-0 flex-1 flex-col` column (the `@container` is what lets the bar hide its counter and toggles in a narrow preview, D10);
   - `<pre ref="scroller" class="scrollbar min-h-0 flex-1 overflow-auto p-3 font-mono text-meta leading-relaxed whitespace-pre text-content" tabindex="-1" data-preview-scroll data-testid="preview-code">` containing `<code ref="code" class="hljs">` — `v-html` when `markup` is non-null, the interpolated text otherwise (never `v-html` with untrusted text);
   - `<FindBar v-if="find.open" :match-count="find.matchCount" :error="result.error" :capped="result.capped" :active-index="find.activeIndex" @close="closeFind()" />` — positioned by its own absolute classes;
   - the truncation banner, moved here from the parents (`v-if="truncated"`, identical markup and `data-testid="preview-truncated"`), so both renderers stop duplicating it.

2. Behaviour:

- `result = computed(() => findMatches(source, find.query, { caseSensitive, wholeWord, regex }))` from the store.
- On `[source, markup, query, caseSensitive, wholeWord, regex]` change (after `nextTick`, so the new `v-html` is in the DOM): `clearMarks(code)`, `find.setMatchCount(result.matches.length)`, and when the bar is open, a query exists and there is no error → `marks = markMatches(code, result.matches)`, `find.setActive(matches.length ? 0 : -1)`; otherwise `find.setActive(-1)` and no marks.
- On `activeIndex` change: toggle `ACTIVE_CLASS` on the marks whose `data-find-index` equals the active index and `scrollIntoView({ block: "center", inline: "nearest" })` the first one. Marks are removed with `classList.remove(ACTIVE_CLASS)`, never by assigning `className`.
- `activeIndex` may outlive the list it pointed into (the counter would show `8 of 2` for a frame): when `find.activeIndex >= result.matches.length`, the repaint sets it to `-1` (or `0` when there are hits), the same normalisation the query watcher already does.
- `closeFind()`: `find.hide()`, `clearMarks(code)`, `scroller.focus()`.
- Expose `focusInput()` that calls `find.show()` (the panel's `showFind` uses it) — or simply let the panel call the store and the bar focus itself; pick one and keep it consistent with Task 5.

3. `src/components/preview/renderers/PreviewCode.vue`: replace its `<pre>` + banner template with `<PreviewTextBody :source="source" :markup="markup" :truncated="props.data.truncated" />`. Keep `source` and `markup` computeds exactly as they are (pretty JSON included: the search runs over the pretty-printed text, which is what the user sees).

4. `src/components/preview/renderers/PreviewMarkdown.vue`: the raw branch uses `<PreviewTextBody :source="source" :markup="null" :truncated="props.data.truncated" />`; the rendered branch keeps its current markup and gains no search. The banner lives only in `PreviewTextBody` now.

### Verification

`pnpm type-check && pnpm test:js && pnpm build:frontend`

Manual smoke (implementer, in `pnpm tauri dev` is *not* required if the harness lacks credentials; if a dev window is available, open a `.log`/`.json` preview, press `⌘F`, type, check marks and counter): optional, note what was and was not done.

---

## Task 5: entries, routing, styling and docs

**Depends on:** Task 4.

### Requirements

1. `src/lib/previewText.ts`: add

```ts
/** Which preview views can host find-in-file. */
export function isPreviewSearchable(kind: FileKind, view: "rendered" | "raw"): boolean;
```

   → `kind === "text" || kind === "code" || kind === "json"`, and `kind === "markdown" && view === "raw"`. Import the type from `@/types`. Add tests to `tests/js/textSearch.test.js` (or a new `tests/js/previewSearch.test.js` — choose one and say which in the report): every `FileKind` maps to the expected boolean, markdown depends on `view`.

2. `src/components/preview/PreviewPanel.vue`:

   - `const canFind = computed(() => isPreviewSearchable(kind.value, objects.previewView))` (guard for the folder/no-preview case; `kind` is already a computed).
   - In the header action row, **before** the markdown view toggle: an `AppButton` `size="sm"` `variant="ghost"` `:icon="Search"` `aria-label="Find in file"` `title="Find in file (⌘F)"` `data-testid="preview-find"`, rendered `v-if="!isFolder && canFind"`, `@click="showFind()"`.
   - `function showFind() { if (!canFind.value) return false; find.show(); return true; }` — the return value is what `⌘F` uses to decide whether it owns the key. No `resetQuery()` here: the bar's own `⌘F` re-selects the query VS Code-style, and the query is already cleared by the `previewKey` watcher below.
   - `function closeFind() { if (!find.open) return false; find.hide(); focusPanel(); return true; }` — a panel-level close, not a forwarding chain. The body's `find.open` watcher already clears the marks and zeroes the count, so the panel only has to hide the store flag and take the keyboard back. The renderers no longer forward `closeFind` (Task 4 dropped those `defineExpose` blocks); do not re-add one.
   - `defineExpose({ focusPanel, showFind, closeFind })` (keep the existing `focusPanel`).
   - `Escape` while `find.open` closes the bar even when focus has left it (Tab past the close button, a click on the scroller): in `src/App.vue`'s preview-zone Escape branch, call `previewPanel.value?.closeFind()` first and only fall through to `focusMain()` when it returned `false` (the bar was already closed).
   - When `objects.previewKey` changes (extend the existing watcher or add one), call `find.resetQuery()`; when `canFind` turns false, `find.hide()`. Switching Rendered ↔ Raw markdown therefore closes the bar and it stays closed when you switch back: a bar that reappears with a query you typed in another view is a surprise, and the preview-zone `⌘F` is one keystroke away.
   - The truncation notice moves here from `PreviewTextBody`: one `<p data-testid="preview-truncated">` directly below the renderer switch inside `#preview-body`, still `v-if="objects.preview?.truncated"`, same copy and classes as the body's today. The switch is exclusive and the flag is only ever set for text payloads, so this is one banner for every renderer and the Rendered Markdown view gets its warning back (Task 4 dropped it). Delete the banner from `src/components/preview/PreviewTextBody.vue` in the same commit, and keep `truncated` out of that component's props if nothing else uses it.

3. `src/App.vue`, inside `onKeydown`, replacing the current `if (plain && lower === "f")` branch:

```ts
  if (plain && lower === "f") {
    // Two searches, one key: the preview owns ⌘F when it has the keyboard and
    // can search; anywhere else ⌘F is the folder filter, as before.
    if (zone === "preview" && previewPanel.value?.showFind()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    document.querySelector<HTMLInputElement>('[data-testid=filter-input]')?.focus();
    return;
  }
```

   `showFind()` returns `false` when the preview is not a searchable text view, so an image preview still falls through to the filter. This branch sits **above** the `editing` guard, so while the bar's input is focused the bar itself must stop `⌘F` (Task 3 does, with `stopPropagation()`); if that stop were lost, `⌘F` here would call `show()` again and re-select the query, never the folder filter.

4. `src/assets/main.css`, next to the markdown/highlight section, add the hit styles using the semantic tokens (both themes inherit them):

```css
/* Find-in-file hits: the accent tint keeps the syntax colours readable; the
   active hit is inverted and must survive on top of any hljs token colour. */
.preview-find-hit {
  background: color-mix(in srgb, var(--c-accent) 32%, transparent);
  color: inherit;
  border-radius: 2px;
}
.preview-find-hit.preview-find-active {
  background: var(--c-accent);
  color: #fff;
  outline: 1px solid var(--c-accent-hover);
}
```

   (`color-mix` is in the WKWebView baseline the app already targets; do not use `color-mix` with `oklab` if the typing of the supported engine is uncertain — `srgb` is fine.)

5. `docs/keyboard.md`: document the new behaviour — `⌘F` in the preview column opens find-in-file for searchable text views, still focuses the folder filter elsewhere; inside the bar `↩` next, `⇧↩` previous, `Esc` closes and returns focus to the text, `⌥⌘C`/`⌥⌘W`/`⌥⌘R` toggle Match Case / Whole Word / Regular Expression; whole word is unavailable in regex mode; the header `Search` button is the mouse entry point. Keep the document's existing table/format conventions.

### Verification

`pnpm type-check && pnpm test:js && pnpm build:frontend`. If a dev window with a bucket is available, smoke-test: `⌘F` with the list focused still filters the folder; `⌘F` with a `.txt` preview focused opens the bar; the header button opens it; `⌘F` on an image preview filters the folder.

---

## As built — where the shipped code differs from Tasks 4–5 above

The tasks are kept as written; this is what actually landed, so a reader does not
mistake the superseded half of Task 4 for the contract.

- **The truncation banner lives in `PreviewPanel.vue`, not in `PreviewTextBody`.** Task 4 put it in the body and gave the body a `truncated` prop; Task 5 moved it to the panel. Task 4's version is dead — the body takes no `truncated` prop, and both renderers pass only `source` and `markup`. The banner is gated on a text payload (`objects.preview?.text != null`) and on no unavailable state, so media over `HEAD_LIMIT` no longer claims truncation the renderer does not perform (D12).
- **The body exposes nothing.** Task 4 ended with `defineExpose({ closeFind })`; the panel holds no ref to the body, the renderers forward nothing, and the bar's own `@close` is the only caller, so the expose was deleted.
- **`canFind` also requires `!objects.previewUnavailable`** — a text file too large for the backend or not decodable shows "Preview unavailable" with no body to search, and a `⌘F` that opened a bar over it would swallow the key.
- **Escape order and count retention** follow D11 and D13.
- **Whole word is kept, not cleared, when regex turns on** (D4 says disabled and ignored; the matcher already ignores it, so clearing the flag only lost the setting across a regex round trip).

## Verification actually done

`pnpm type-check`, `pnpm test:js` (103 tests), `pnpm build:frontend`, `pnpm check`
(frontend build, `cargo fmt --check`, `clippy -D warnings`, 123 Rust tests) — all
green on the branch head.

The manual smoke list in Task 5 is now an **automated** part of the GUI suite
(`src-tauri/src/e2e/mod.rs`, five checks prefixed `preview find:`), because the
marking, focus and Escape/`⌘F` handoff are the parts `tests/js` cannot reach. It
runs against the real window and a real bucket: `pnpm test:e2e`, 89/89 checks pass
on the merged head. What it covers: `⌘F` with the list focused still filters the
folder and with a `.txt` preview focused opens the bar (and a second `⌘F` in the
bar never reaches the filter); hits are counted, marked and stepped with `↩` /
`⇧↩`; Match Case, Whole Word and regex change the count as their toggles say, an
invalid pattern shows `Invalid regex` without leaving marks, and regex mode
disables but keeps Whole Word; `Esc` closes the bar before it collapses an
expanded preview and returns focus to the text; the header button reopens the bar
with the retained query; an image preview offers no button and routes `⌘F` to the
filter; raw Markdown can be searched and switching to Rendered closes the bar.

---

## Out of scope

Replace, rendered-Markdown search, CSV/Parquet cell search, searching beyond the loaded 2 MB, persisting the options to the Rust config across launches (the store is in-memory, like the rest of the preview state), changes to the folder listing search.
