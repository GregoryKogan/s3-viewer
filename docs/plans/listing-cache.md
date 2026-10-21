# Folder listing cache

**Approved design:** the conversation of 2026-10-21. No separate spec file: the approved message is the authority.
**Branch:** `feat/listing-cache`.
**Baseline:** `a62a12e` — `pnpm type-check` clean, `pnpm test:js` 68/68.
**Scope:** an in-memory, size-bounded cache of folder listings in the frontend, the settings that control it, and the controls that clear it. The Rust listing path is untouched.

## Global constraints

- Work only on this branch. Do not touch the three version fields, `.github/`, `AGENTS.md`, or the updater.
- Keep code, comments and UI copy in English. Match the existing style: Vue 3 `<script setup lang="ts">`, Pinia setup stores, Tailwind semantic tokens, `@lucide/vue` icons, existing `AppField`/`AppButton`/`inputClass` components.
- No new dependency. No new npm package, no new crate.
- The cache is **in-memory only**. Never write listings to disk, `localStorage`, IndexedDB or the Rust config.
- Do not change the listing wire protocol or the Rust listing functions.
- Keep every existing `data-testid`; new controls get the ids named below.
- Every task ends green: `pnpm type-check`, `pnpm build:frontend`, `pnpm test:js`. Rust-touching tasks additionally: `export PATH="$HOME/.cargo/bin:$PATH"`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`.
- Do not reformat or refactor adjacent code. A diff should contain only what the task asks for.

## Decisions (binding for all tasks)

- **D1. Key.** A cache entry is keyed by `JSON.stringify([connectionId, prefix])`, where `prefix` is the normalized folder prefix (`asFolderPrefix`). The same prefix in two connections is two entries; editing a connection never shows another bucket's listing.
- **D2. Freshness.** An entry younger than `30_000` ms is served without any S3 request. Older entries are painted immediately and refreshed in the background with the same `requestId`; the `done` event replaces the list atomically through the existing `staged` mechanism.
- **D3. Force paths.** `reload()` and `reloadSession()` delete the entry for the folder they list and then list for real. They are what ⌘R, the refresh buttons, every mutation and every settings save call, so a created or deleted object always shows up and a deleted one is never resurrected.
- **D4. Silent background failure.** A failed background refresh keeps the cached list, shows no error and raises no toast; it must not mark the connection unhealthy. A failed *foreground* listing behaves exactly as today.
- **D5. Size.** The cache is bounded by `listingCacheMaxBytes` (default 64 MiB, `0` disables). Bytes are estimated with `estimateListingBytes`: 160 bytes per entry plus 2 bytes per UTF-16 unit of `key`, `name`, `lastModified`, `etag`, `storageClass`, `kind`. LRU eviction. A single listing larger than the whole budget is not stored.
- **D6. No persistence.** The cache dies with the window. Clearing it is instant and has no disk side effects.
- **D7. Settings.** The number in the dialog is in MB, clamped to `0..4096`, while `AppSettings.listingCacheMaxBytes` stays in bytes with a serde default so old config files still load.
- **D8. Order.** Tasks 1 and 2 are independent; Task 3 consumes both. Never run two implementers at once.

---

## Task 1: Persisted `listingCacheMaxBytes` setting

**Depends on:** none.

### Requirements

1. `src-tauri/src/store.rs`, in `AppSettings` right after `list_page_limit`:

```rust
    /// Byte budget for the in-memory folder-listing cache. Zero turns it off.
    #[serde(default = "default_listing_cache_max_bytes")]
    pub listing_cache_max_bytes: u64,
```

   Add this free function next to the struct:

```rust
fn default_listing_cache_max_bytes() -> u64 {
    64 * 1024 * 1024
}
```

   and set `listing_cache_max_bytes: default_listing_cache_max_bytes(),` in `impl Default for AppSettings` (next to `list_page_limit`). The serde default is mandatory: config files written by 0.3.2 have no such field and must still load.

2. `src/types/index.ts`, in `AppSettings` right after `listPageLimit`:

```ts
  /** In-memory folder-listing cache budget in bytes; 0 disables it. */
  listingCacheMaxBytes: number;
```

3. `src/stores/ui.ts`, in the `saveSettings` merged literal right after `listPageLimit`:

```ts
        listingCacheMaxBytes: settings.value?.listingCacheMaxBytes ?? 64 * 1024 * 1024,
```

4. `src/components/dialogs/SettingsDialog.vue`:

   - `DEFAULTS` gets `listingCacheMb: 64,` (the form holds MB, the type and Rust hold bytes).
   - `form` gets, after `listPageLimit`:

```ts
  listingCacheMb: Math.round(
    (ui.settings?.listingCacheMaxBytes ?? DEFAULTS.listingCacheMb * 1024 * 1024) / (1024 * 1024),
  ),
```

   - Add a helper above `save()`:

```ts
/** The form edits MB; the stored setting is bytes. Garbage falls back to the default. */
function cacheBytesFromForm(): number {
  const mb = Number(form.value.listingCacheMb);
  const clamped = Number.isFinite(mb)
    ? Math.min(4096, Math.max(0, Math.round(mb)))
    : DEFAULTS.listingCacheMb;
  return clamped * 1024 * 1024;
}
```

   - `save()` passes `listingCacheMaxBytes: cacheBytesFromForm(),` right after `listPageLimit`.
   - In the Browsing fieldset's `grid grid-cols-2 gap-3`, after the Theme `AppField` and before the system-objects checkbox:

```html
        <AppField
          class="col-span-full"
          label="Folder listing cache"
          hint="Folders you already opened stay in memory so going back is instant. 0 turns the cache off."
        >
          <div class="flex items-center gap-2">
            <input
              v-model.number="form.listingCacheMb"
              type="number"
              min="0"
              max="4096"
              step="1"
              :class="[inputClass, 'w-28']"
              data-testid="settings-listing-cache"
            />
            <span class="text-xs text-muted">MB</span>
          </div>
        </AppField>
```

5. Rust test in `src-tauri/src/store.rs` `mod tests`, next to `layout_preview_hidden_defaults_to_false`:

```rust
    #[test]
    fn listing_cache_limit_defaults_for_old_configs() {
        // Config files written before the field existed must still load.
        let settings: AppSettings = serde_json::from_str(
            r#"{"previewMaxBytes":26214400,"listPageLimit":20000,"askDownloadLocation":false,
                "showSystemObjects":false,"theme":"dark"}"#,
        )
        .unwrap();
        assert_eq!(settings.listing_cache_max_bytes, 64 * 1024 * 1024);
        assert_eq!(
            AppSettings::default().listing_cache_max_bytes,
            64 * 1024 * 1024
        );

        // The wire name stays camelCase, matching the TypeScript type.
        let json = serde_json::to_value(AppSettings::default()).unwrap();
        assert_eq!(json["listingCacheMaxBytes"], 67_108_864);
    }
```

### Verification

```bash
pnpm type-check && pnpm build:frontend
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml listing_cache_limit
```

---

## Task 2: `ListingCache` module and its unit tests

**Depends on:** none (type-only import of `ObjectEntry`).

### Requirements

Create `src/lib/listingCache.ts` — a pure, framework-free LRU cache. No `Date.now()`, no persistence, no I/O.

```ts
import type { ObjectEntry } from "@/types";

export interface CachedListing {
  entries: ObjectEntry[];
  truncated: boolean;
  warning: string | null;
  /** `Date.now()` at the moment the listing finished. */
  fetchedAt: number;
}
```

Exports:

- `export function listingCacheKey(connectionId: string, prefix: string): string` — `JSON.stringify([connectionId, prefix])`.
- `export function estimateListingBytes(entries: ObjectEntry[]): number` — `ENTRY_OVERHEAD_BYTES = 160` per entry plus `STRING_BYTES = 2` per UTF-16 unit of `key`, `name`, `lastModified`, `etag`, `storageClass`, `kind` (missing optional fields count as 0). Document that it is an estimate, used for bounding, not an exact heap measurement.
- `export class ListingCache` with:

```ts
constructor(limitBytes: () => number)
get(key: string): CachedListing | null
set(key: string, listing: CachedListing): boolean
delete(key: string): void
clear(): void
trim(): void
get bytes(): number
get size(): number
```

Exact semantics:

- The constructor stores the getter and must **not** call it. Every operation calls it, so a settings change applies immediately.
- Effective limit = `Math.max(0, Math.floor(limitBytes()))`; a non-finite value is treated as `0`.
- `get`: returns `null` when the key is absent or the effective limit is `0`. A hit bumps recency (a monotonically increasing counter, not a clock) and returns the stored `CachedListing`.
- `set`:
  1. Delete any previous entry for the key first (a new result replaces the old one even if the new one is too large to keep).
  2. Compute `estimateListingBytes(listing.entries)`.
  3. If the effective limit is `0` or `bytes > limit`, store nothing and return `false` — a listing bigger than the whole budget must not break the bound.
  4. Evict least-recently-used entries until the new entry fits, then store it and return `true`.
- `trim`: with limit `0` clears everything; otherwise evicts LRU entries until `bytes <= limit`.
- `delete`: removes one entry and subtracts its bytes; a missing key is a no-op.
- `clear`: empties everything and resets `bytes` to 0.
- `size` = number of entries, `bytes` = sum of stored estimates.
- Eviction scans for the smallest recency counter (the map is small: entries are bounded by the budget).

### Tests

Create `tests/js/listingCache.test.js` using `node:test`, `node:assert/strict`, and `loadTs("src/lib/listingCache.ts")` (same pattern as `tests/js/keys.test.js`). Helpers:

```js
function entry(key, extra = {}) {
  return { key, name: key, isFolder: false, size: 0, kind: "other", ...extra };
}
```

Cover, one `test(...)` each:

1. Round trip: `set`, `get` returns the same `entries`/`truncated`/`warning`/`fetchedAt`; `bytes` equals `estimateListingBytes(entries)` and `size` is 1.
2. A missing key is `null`; `delete` removes it and frees its bytes.
3. LRU: with room for two entries, `get` the older one, add a third, and the untouched entry is the one evicted.
4. An entry larger than the whole budget is refused (`set` returns `false`, `size` stays 0) and does not evict other entries.
5. Lowering the limit and calling `trim()` evicts down to the new budget.
6. Limit `0`: `set` returns `false`, `get` returns `null`, `trim()` clears.
7. `listingCacheKey` differs for the same prefix on two connection ids; `estimateListingBytes` grows when a key gets longer.

### Verification

```bash
node --test tests/js/listingCache.test.js
pnpm type-check
```

---

## Task 3: Store cache behavior, header spinner, settings controls

**Depends on:** Tasks 1 and 2 (the setting and the module must exist).

### Requirements

#### 3.1 `src/stores/objects.ts`

Imports: add `watch` to the `vue` import; add `import { ListingCache, listingCacheKey } from "@/lib/listingCache";`.

Inside the store setup, after the listing state (`staged`, `listingRequest`, ...) add:

```ts
  /**
   * Opened folders stay in memory for the rest of the session so going back is
   * instant. Bounded by the setting; never written to disk. The getter is read
   * on every operation so a new limit applies without recreating the cache.
   */
  const cache = new ListingCache(() => {
    const bytes = useUiStore().settings?.listingCacheMaxBytes;
    return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 64 * 1024 * 1024;
  });
  /** Bumped after every cache mutation so the computed usage below re-reads. */
  const cacheVersion = ref(0);
  function touchCache() {
    cacheVersion.value += 1;
  }
  const cacheBytes = computed(() => {
    void cacheVersion.value;
    return cache.bytes;
  });
  const cacheFolders = computed(() => {
    void cacheVersion.value;
    return cache.size;
  });
  /** True while a cached folder is being refreshed in the background. */
  const refreshing = ref(false);
  /** The request id of that background refresh, or null. */
  let revalidating: string | null = null;
  /**
   * A background refresh whose invoke already rejected. Its `listing://error`
   * can still arrive afterwards; that event must not blank the cached list.
   */
  let failedRevalidation: string | null = null;
```

Constants at module scope (above `useObjectsStore`, with a comment):

```ts
/** A cached folder is served as-is while it is younger than this. */
const LISTING_CACHE_FRESH_MS = 30_000;
```

`loadFolder` becomes `async function loadFolder(targetPrefix: string, { force = false }: { force?: boolean } = {})`.

In the body, after `nextPrefix` and `continuing`:

```ts
    const cacheKey = listingCacheKey(connection.id, nextPrefix);
    const cached = force ? null : cache.get(cacheKey);
    if (force) {
      // A forced reload must not be answered from the entry it is replacing,
      // and a failed reload must not leave the old list looking current.
      cache.delete(cacheKey);
      touchCache();
    }
```

Then keep the existing preview/selection logic, but:

- `entries.value = cached ? cached.entries : [];`
- `loading.value = !cached;`
- `awaitingFirstPage.value = !cached;`
- `warning.value = cached ? cached.warning : null;`
- `truncated.value = cached ? cached.truncated : false;`
- after `const requestId = String(++listingRequest);` and the `start#` note, always reset the background state:

```ts
    refreshing.value = false;
    revalidating = null;
    failedRevalidation = null;
```

- immediately after that, the cache-hit branch, **before** the 120 s guard is created:

```ts
    if (cached) {
      note(listingLog, `cache#${requestId} "${prefix.value}"`);
      if (Date.now() - cached.fetchedAt < LISTING_CACHE_FRESH_MS) return;
      revalidating = requestId;
      refreshing.value = true;
      // Stale-while-revalidate: the cached list stays on screen and this stream
      // replaces it on `done`. A failure here is silent by design (D4).
      void api
        .listObjectsStream({ connectionId: connection.id, prefix: prefix.value, requestId })
        .catch((failure) => {
          if (revalidating === requestId) {
            revalidating = null;
            // The error event may follow this rejection; remember the id so
            // `onListingError` can drop it instead of showing an error.
            failedRevalidation = requestId;
            refreshing.value = false;
          }
          note(listingLog, `revalidate-failed#${requestId} ${(failure as Error)?.message ?? ""}`);
        });
      return;
    }
```

The existing guard, invoke, catch and `finally` stay as they are and now run only on a miss.

`onListingDone`, at the very top (before the stale check):

```ts
    if (event.requestId === revalidating || event.requestId === failedRevalidation) {
      revalidating = null;
      failedRevalidation = null;
      refreshing.value = false;
    }
```

After `prefix.value = event.prefix ?? prefix.value;`, write the cache:

```ts
    const connectionId = sessionConnectionId.value;
    if (connectionId) {
      cache.set(listingCacheKey(connectionId, prefix.value), {
        entries: entries.value,
        truncated: event.truncated,
        warning: event.warning ?? null,
        fetchedAt: Date.now(),
      });
      touchCache();
    }
```

`onListingError`, at the very top (before the stale check):

```ts
    // A failed background refresh keeps the cached list: silence here also
    // keeps App.vue from marking the connection unhealthy for it.
    if (event.requestId === revalidating || event.requestId === failedRevalidation) {
      revalidating = null;
      failedRevalidation = null;
      refreshing.value = false;
      note(listingLog, `revalidate-failed#${event.requestId} ${event.error?.message ?? ""}`);
      return false;
    }
```

`reload()` and `reloadSession()` pass `{ force: true }`:

```ts
  function reload() {
    return loadFolder(prefix.value, { force: true });
  }

  function reloadSession() {
    const connection = useConnectionsStore().active;
    if (!connection) return Promise.resolve();
    return loadFolder(connection.prefix ?? "", { force: true });
  }
```

`close()` additionally sets `refreshing.value = false;`, `revalidating = null;` and `failedRevalidation = null;`.

Add, next to `close()`:

```ts
  /** Drop every cached folder. The next visit lists from S3 again. */
  function clearListingCache() {
    cache.clear();
    touchCache();
  }
```

Near the end of the setup, before the returned object, keep the bound honest when the setting changes:

```ts
  // A lowered limit applies at once, not on the next insertion.
  watch(
    () => useUiStore().settings?.listingCacheMaxBytes,
    () => {
      cache.trim();
      touchCache();
    },
  );
```

Return `refreshing`, `cacheBytes`, `cacheFolders`, `clearListingCache` in the store's returned object.

#### 3.2 `src/components/layout/AppHeader.vue`

The refresh button's busy state becomes `objects.loading || objects.refreshing` (the spinner also shows during a silent background refresh).

#### 3.3 `src/components/dialogs/SettingsDialog.vue`

- Import `Trash2` from `@lucide/vue` (add it to the existing import) and `useObjectsStore` from `@/stores/objects`; add `const objects = useObjectsStore();` next to the other stores.
- Add:

```ts
function clearCache() {
  objects.clearListingCache();
  toasts.ok("Listing cache cleared.");
}
```

- In the Browsing fieldset, after the `grid` closes and before `</fieldset>`:

```html
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <p class="text-meta text-muted" data-testid="settings-cache-usage">
          <template v-if="objects.cacheFolders">
            {{ objects.cacheFolders }} folder{{ objects.cacheFolders === 1 ? "" : "s" }} cached,
            {{ humanSize(objects.cacheBytes) }} in memory.
          </template>
          <template v-else>No folders are cached.</template>
        </p>
        <AppButton
          :icon="Trash2"
          :disabled="!objects.cacheFolders"
          data-testid="settings-clear-cache"
          @click="clearCache"
        >
          Clear cache
        </AppButton>
      </div>
```

#### 3.4 `tests/js/objects.test.js`

Add tests to the existing file, reusing its helpers and `seed()`. A helper that emits a complete listing synchronously:

```js
function streamListing(objects, entries, options = {}) {
  const calls = [];
  let rejectCurrent = null;
  api.listObjectsStream = (input) => {
    calls.push(input);
    if (options.manual) {
      return new Promise((_, reject) => {
        rejectCurrent = reject;
      });
    }
    objects.onListingPage({
      requestId: input.requestId,
      prefix: input.prefix,
      entries,
      total: entries.length,
      done: true,
    });
    objects.onListingDone({
      requestId: input.requestId,
      prefix: input.prefix,
      total: entries.length,
      files: entries.length,
      truncated: options.truncated ?? false,
      warning: options.warning ?? null,
    });
    return Promise.resolve();
  };
  return { calls, reject: (error) => rejectCurrent?.(error) };
}
```

Tests (names and what each must prove):

1. `"a cached folder is shown without another listing call"` — list `"big/"` with entries; `cacheFolders === 1` and `cacheBytes > 0`; then `loadFolder("")`, then `loadFolder("big/")`; the third call uses the cache: `calls.length` stays at 2, `entries` are restored synchronously (assert immediately after calling, before awaiting), `loading` is false, `refreshing` is false.
2. `"reload bypasses the cache and drops the entry"` — after caching, `objects.reload()` starts a new call (`calls.length` + 1) and `cacheFolders` drops to 0 before that call completes.
3. `"a stale cached folder is painted, then replaced by the background refresh"` — `t.mock.timers.enable({ apis: ["Date"], now: Date.now() })`, cache a folder, `t.mock.timers.tick(31_000)`, then load it with a manual listing: entries are painted synchronously, `refreshing` is true, one call started; emit `onListingPage` + `onListingDone` with a renamed entry; entries are replaced, `refreshing` is false, and a later cached visit paints the new entry without a call.
4. `"a failed background refresh keeps the cached list and stays quiet"` — stale hit; cover BOTH arrival orders in one test or two: (a) emit `onListingError` for that request, then reject the invoke; (b) reject the invoke first, `await` a microtask so the rejection settles, then emit `onListingError`. In both, entries are unchanged, `error` is null, no error toast, `refreshing` is false.
5. `"clearListingCache empties the cache"` — cache a folder, `clearListingCache()`, `cacheFolders === 0`, `cacheBytes === 0`, and the next visit starts a call.
6. `"the cache is scoped to the connection"` — cache `"big/"` on connection `a`, `connections.setActive("b")`, load the same prefix: a new call starts and the old entries are not painted.

Keep all 6 existing tests passing unchanged.

### Verification

```bash
pnpm type-check && pnpm build:frontend && pnpm test:js
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --manifest-path src-tauri/Cargo.toml
```
