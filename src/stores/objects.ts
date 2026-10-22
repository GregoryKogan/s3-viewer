import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { api, ApiError, detailFrom } from "@/lib/ipc";
import { asFolderPrefix } from "@/lib/keys";
import { ListingCache, listingCacheKey } from "@/lib/listingCache";
import { useConnectionsStore } from "@/stores/connections";
import { useToastsStore } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import type {
  Connection,
  ListErrorDetail,
  ListingDoneEvent,
  ListingErrorEvent,
  ListingPageEvent,
  ObjectEntry,
  PreviewData,
} from "@/types";

export type SortKey = "name" | "size" | "modified" | "kind";

/** A cached folder is served as-is while it is younger than this. */
const LISTING_CACHE_FRESH_MS = 30_000;

/**
 * Sort collators, built once.
 *
 * `localeCompare` with an options bag builds a collator per call, and a folder
 * with hundreds of thousands of entries sorts again on every keystroke of the
 * filter: 8.2 s per sort at 380k rows against 0.7 s for a reused collator, with
 * the same order.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });
const TEXT_COLLATOR = new Intl.Collator();

/**
 * The owner half of a cache key identifies the connection *target*, not just the
 * saved connection. An edit keeps the id but can move the bucket or the
 * endpoint, and entries cached from the old target must never paint under the
 * new one; "\u0000" cannot occur in any of the three fields.
 */
function connectionCacheOwner(connection: Connection): string {
  return [connection.id, connection.bucket, connection.endpointUrl].join("\u0000");
}

/**
 * One browsing session: the folder on screen, its objects, the selection, and the
 * preview. Listings stream in, so the first page is painted while the rest is
 * still being read and `done` replaces the list with all of it; a cancelled load
 * therefore never leaves a partial list on screen, which previously showed an
 * empty folder as fact.
 */
export const useObjectsStore = defineStore("objects", () => {
  const prefix = ref("");
  /**
   * The connection this listing belongs to. Every mutation checks it against
   * the active connection, so a stale session can never delete objects in
   * another bucket that happens to share the same keys.
   */
  const sessionConnectionId = ref<string | null>(null);
  /**
   * The cache key's owner for the listing on screen: the target (id, bucket,
   * endpoint) of the connection this session belongs to. Kept next to the
   * session so the write path never has to re-resolve a connection that an
   * edit may have moved.
   */
  let sessionCacheOwner: string | null = null;
  const entries = ref<ObjectEntry[]>([]);
  const loading = ref(false);
  const awaitingFirstPage = ref(false);
  /**
   * How many entries the listing in flight has produced. `entries` paints in
   * steps (see `paintStaged`), so this is what tells the toolbar that a folder
   * taking minutes is still making progress.
   */
  const listed = ref(0);
  const truncated = ref(false);
  const warning = ref<string | null>(null);
  const error = ref<string | null>(null);
  /** Hints, code and request id for the error state; the message stays `error`. */
  const errorDetail = ref<ListErrorDetail | null>(null);

  /** Bulk selection: what the toolbar acts on. */
  const selected = ref(new Set<string>());
  /** The row whose preview is open; independent of the selection. */
  const focusedKey = ref<string | null>(null);
  /** Where a Shift+click range starts. */
  const selectionAnchor = ref<string | null>(null);
  const filter = ref("");
  const sortKey = ref<SortKey>("name");
  const sortAscending = ref(true);

  const preview = shallowRef<PreviewData | null>(null);
  const previewKey = ref<string | null>(null);
  /**
   * The listing entry behind a folder preview. Folders have no payload, but the
   * entry still carries the marker's size and date, which the panel shows.
   */
  const folderMeta = ref<ObjectEntry | null>(null);
  const previewLoading = ref(false);
  const previewError = ref<string | null>(null);
  /** Hints, code and request id for a preview failure; the message stays `previewError`. */
  const previewErrorDetail = ref<ListErrorDetail | null>(null);
  const previewUnavailable = ref<string | null>(null);
  const previewView = ref<"rendered" | "raw">("rendered");

  const open = computed(() => prefix.value !== "" || entries.value.length > 0 || loading.value);

  /** Monotonic ids so stale async work cannot write to the screen. */
  let listingRequest = 0;
  let previewRequest = 0;
  let staged: ObjectEntry[] = [];
  /** Show what the stream has produced so far, without waiting for `done`. */
  function paintStaged() {
    entries.value = staged.slice();
    awaitingFirstPage.value = false;
  }
  /**
   * The stall watchdog for the listing in flight. What it measures is silence,
   * not elapsed time: every page re-arms it. A prefix with hundreds of thousands
   * of sub-folders takes minutes to enumerate legitimately, and it used to be
   * declared stalled while it was still delivering pages.
   */
  const LISTING_STALL_MS = 120_000;
  let stallGuard: ReturnType<typeof setTimeout> | undefined;
  /** The request that owns `stallGuard`; a superseded one must not clear it. */
  let stallGuardOwner: string | undefined;

  function armStallGuard(requestId: string) {
    clearTimeout(stallGuard);
    stallGuardOwner = requestId;
    stallGuard = setTimeout(() => {
      if (String(listingRequest) === requestId && loading.value) {
        loading.value = false;
        awaitingFirstPage.value = false;
        error.value = "The listing took too long to finish.";
        useToastsStore().warn("The listing stalled. Press refresh to try again.", "Listing stalled");
      }
    }, LISTING_STALL_MS);
  }
  /**
   * The listing failure already announced by a toast. The `listing://error`
   * event normally sets it; the rejected invoke covers failures raised before
   * the stream starts (connection lookup, client construction), which never
   * emit an event. The flag is what makes the two paths a single toast in
   * either arrival order.
   */
  let announcedListingFailure: string | null = null;

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
   * A background refresh whose result must be dropped: its invoke already
   * rejected, or the cache was cleared while it was in flight. Its late
   * `listing://error` must not blank the cached list, and its `done` must not
   * repopulate a cache the user just cleared.
   */
  let failedRevalidation: string | null = null;

  /**
   * Short transition logs. A hung listing or a stale preview is otherwise
   * invisible from the outside: the state just says "loading" forever. These
   * rings are exposed on the harness surface and printed by failing checks.
   */
  const listingLog: string[] = [];
  const previewLog: string[] = [];
  function note(target: string[], entry: string) {
    target.push(entry);
    if (target.length > 24) target.shift();
  }

  // ------------------------------------------------------------------ listing

  /**
   * The S3 request id the listing already recorded. Read through a function so
   * the `null` assigned at the start of `loadFolder` does not narrow the ref
   * away from what a later event handler wrote.
   */
  function recordedRequestId(): string | null {
    return errorDetail.value?.requestId ?? null;
  }

  async function loadFolder(
    targetPrefix: string,
    { force = false }: { force?: boolean } = {},
  ) {
    const connections = useConnectionsStore();
    const connection = connections.active;
    if (!connection) return;

    const nextPrefix = asFolderPrefix(targetPrefix);
    // A reload of the same folder keeps the selection and the filter; a new
    // folder (or a different connection on the same prefix) starts fresh.
    const continuing =
      sessionConnectionId.value === connection.id && nextPrefix === prefix.value;
    const owner = connectionCacheOwner(connection);
    const cacheKey = listingCacheKey(owner, nextPrefix);
    const cached = force ? null : cache.get(cacheKey);
    if (force) {
      // A forced reload must not be answered from the entry it is replacing,
      // and a failed reload must not leave the old list looking current.
      cache.delete(cacheKey);
      touchCache();
    }
    // A preview belongs to the session that fetched it. Drop it before the
    // session id moves to another connection: the listing streams, so the panel
    // would otherwise show the old connection's object under the new one's
    // Download/Copy URI for the whole load.
    if (sessionConnectionId.value !== connection.id) clearPreview();
    sessionCacheOwner = owner;
    sessionConnectionId.value = connection.id;
    prefix.value = nextPrefix;
    entries.value = cached ? cached.entries : [];
    staged = [];
    listed.value = entries.value.length;
    if (!continuing) {
      selected.value = new Set();
      selectionAnchor.value = null;
      focusedKey.value = null;
      filter.value = "";
      // A different folder or connection must never leave the list hidden
      // behind a full-width preview that no longer has an object.
      useUiStore().collapsePreview();
    }
    loading.value = !cached;
    awaitingFirstPage.value = !cached;
    error.value = null;
    errorDetail.value = null;
    announcedListingFailure = null;
    warning.value = cached ? cached.warning : null;
    truncated.value = cached ? cached.truncated : false;

    if (loading.value) note(listingLog, `superseded#${listingRequest}`);
    const requestId = String(++listingRequest);
    note(listingLog, `start#${requestId} "${prefix.value}"`);

    refreshing.value = false;
    revalidating = null;
    failedRevalidation = null;

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

    armStallGuard(requestId);

    try {
      await api.listObjectsStream({ connectionId: connection.id, prefix: prefix.value, requestId });
    } catch (failure) {
      if (String(listingRequest) === requestId) {
        // The event may already have set the state and toasted. Capture that
        // before the assignments below overwrite the message with the invoke's.
        const reportedByEvent = error.value !== null || errorDetail.value !== null;
        loading.value = false;
        awaitingFirstPage.value = false;
        error.value = (failure as Error).message;
        if (failure instanceof ApiError) {
          // The event often arrives before the rejected invoke and already knows
          // the S3 request id; a throw without one must not erase it.
          errorDetail.value = detailFrom(failure, recordedRequestId());
        }
        // One failure, one toast: the event is authoritative, and a failure
        // that never emits an event (raised before the stream starts) is
        // announced here instead. The shared id covers either arrival order.
        if (!reportedByEvent && announcedListingFailure !== requestId) {
          announcedListingFailure = requestId;
          useToastsStore().apiError(failure, "Cannot list this folder");
        }
      }
    } finally {
      if (stallGuardOwner === requestId) {
        clearTimeout(stallGuard);
        stallGuardOwner = undefined;
      }
    }
  }

  /** Reload the folder currently on screen. */
  function reload() {
    return loadFolder(prefix.value, { force: true });
  }

  /** Re-open the session after a connection was edited. */
  function reloadSession() {
    const connection = useConnectionsStore().active;
    if (!connection) return Promise.resolve();
    return loadFolder(connection.prefix ?? "", { force: true });
  }

  function onListingPage(event: ListingPageEvent) {
    note(listingLog, `page#${event.requestId}+${event.entries?.length ?? 0}`);
    if (event.requestId !== String(listingRequest)) return;
    if (!useConnectionsStore().active) return;
    // Only the foreground load owns the guard: a background revalidation is
    // silent by design and has no `finally` to release it.
    if (loading.value) armStallGuard(event.requestId);
    if (event.entries?.length) {
      staged.push(...event.entries);
      // A revalidation keeps the cached rows on screen (`loading` is false) and
      // replaces them on `done`; only the foreground load paints as it goes.
      if (loading.value) {
        listed.value = staged.length;
        // Paint as the folder fills rather than once at the end: a prefix with
        // hundreds of thousands of sub-folders legitimately takes minutes, and
        // both a blank window and a frozen first page read as "this folder does
        // not load". Every repaint re-sorts the whole list on screen, so the
        // list doubles between paints instead of following every page: a page
        // costs six seconds, which would mean 380 re-sorts of a 380k list.
        if (entries.value.length === 0 || staged.length >= entries.value.length * 2) {
          paintStaged();
        }
      }
    }
  }

  /** Returns false when the event belongs to a superseded request. */
  function onListingDone(event: ListingDoneEvent): boolean {
    note(listingLog, `done#${event.requestId} total=${event.total}`);
    // A cleared cache drops the in-flight refresh's write, not its list.
    const droppedRevalidation = event.requestId === failedRevalidation;
    if (event.requestId === revalidating || droppedRevalidation) {
      revalidating = null;
      failedRevalidation = null;
      refreshing.value = false;
    }
    if (event.requestId !== String(listingRequest)) return false;
    entries.value = staged;
    staged = [];
    listed.value = entries.value.length;
    loading.value = false;
    awaitingFirstPage.value = false;
    truncated.value = event.truncated;
    warning.value = event.warning ?? null;
    prefix.value = event.prefix ?? prefix.value;

    const owner = sessionCacheOwner;
    if (owner && !droppedRevalidation) {
      cache.set(listingCacheKey(owner, prefix.value), {
        entries: entries.value,
        truncated: event.truncated,
        warning: event.warning ?? null,
        fetchedAt: Date.now(),
      });
      touchCache();
    }

    // A reload must not lose the user's place: keep only what still exists in
    // the new listing, and drop a focus or anchor that vanished with it.
    const keys = new Set(entries.value.map((entry) => entry.key));
    selected.value = new Set([...selected.value].filter((key) => keys.has(key)));
    if (focusedKey.value && !keys.has(focusedKey.value)) focusedKey.value = null;
    if (selectionAnchor.value && !keys.has(selectionAnchor.value)) selectionAnchor.value = null;

    // The preview is a snapshot too (PRV-3). A deleted object must not linger,
    // and a surviving one is re-fetched so ⌘R cannot leave an old version on
    // screen. A hidden panel is left alone; it refreshes when it is shown.
    if (previewKey.value) {
      if (!keys.has(previewKey.value)) {
        clearPreview();
      } else if (previewKey.value.endsWith("/")) {
        // A folder preview has no payload to re-fetch, but its marker metadata
        // may have changed; keep the card honest.
        const updated = entries.value.find((entry) => entry.key === previewKey.value);
        if (updated) folderMeta.value = updated;
      } else {
        void refreshPreview();
      }
    }
    return true;
  }

  /** Returns false when the event belongs to a superseded request. */
  function onListingError(event: ListingErrorEvent): boolean {
    note(listingLog, `error#${event.requestId} ${event.error?.message ?? ""}`);
    // A failed background refresh keeps the cached list: silence here also
    // keeps App.vue from marking the connection unhealthy for it.
    if (event.requestId === revalidating || event.requestId === failedRevalidation) {
      revalidating = null;
      failedRevalidation = null;
      refreshing.value = false;
      note(listingLog, `revalidate-failed#${event.requestId} ${event.error?.message ?? ""}`);
      return false;
    }
    if (event.requestId !== String(listingRequest)) return false;
    staged = [];
    loading.value = false;
    awaitingFirstPage.value = false;
    error.value = event.error?.message ?? "listing failed";
    // The top-level requestId is the internal listing counter; the S3 id lives
    // inside the payload.
    errorDetail.value = detailFrom(event.error ?? {});
    // Raise the event as an ApiError so the toast keeps the same hints and code
    // the inline error state shows; a staged listing has no inline notice. The
    // rejected invoke may already have announced this request when the event
    // arrives late, so the shared id guards the other order too.
    if (announcedListingFailure !== event.requestId) {
      announcedListingFailure = event.requestId;
      useToastsStore().apiError(
        new ApiError(event.error ?? { message: "listing failed" }),
        "Cannot list this folder",
      );
    }
    return true;
  }

  async function navigate(targetPrefix: string) {
    clearPreview();
    await loadFolder(targetPrefix);
  }

  function navigateUp() {
    if (!prefix.value) return Promise.resolve();
    const root = useConnectionsStore().active?.prefix ?? "";
    const parts = prefix.value.replace(/\/$/, "").split("/");
    parts.pop();
    const parent = parts.length ? `${parts.join("/")}/` : "";
    // The connection prefix is the scope root. Climbing above it, whether from
    // the Up button or the keyboard shortcut, would contradict the promise that
    // a connection pins one folder (NAV-1 / scope clamp).
    const target = parent.startsWith(root) ? parent : root;
    if (target === prefix.value) return Promise.resolve();
    return navigate(target);
  }

  function close() {
    listingRequest += 1;
    prefix.value = "";
    sessionConnectionId.value = null;
    sessionCacheOwner = null;
    entries.value = [];
    staged = [];
    selected.value.clear();
    selectionAnchor.value = null;
    focusedKey.value = null;
    loading.value = false;
    awaitingFirstPage.value = false;
    truncated.value = false;
    warning.value = null;
    error.value = null;
    errorDetail.value = null;
    refreshing.value = false;
    revalidating = null;
    failedRevalidation = null;
    clearPreview();
  }

  /** Drop every cached folder; the next visit lists it again. */
  function clearListingCache() {
    cache.clear();
    if (revalidating) {
      // A refresh that is already in flight must not repopulate what was just
      // cleared. Its `done` still updates the visible list, but is not cached.
      failedRevalidation = revalidating;
      revalidating = null;
      refreshing.value = false;
    }
    touchCache();
  }

  // ---------------------------------------------------------------- selection

  const visibleEntries = computed(() => {
    const needle = filter.value.trim().toLowerCase();
    const matched = needle
      ? entries.value.filter((entry) => entry.name.toLowerCase().includes(needle))
      : entries.value.slice();

    const direction = sortAscending.value ? 1 : -1;
    const key = sortKey.value;
    matched.sort((a, b) => {
      // Folders always come first: a folder list that mixes files in is unusable.
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      switch (key) {
        case "size":
          return (a.size - b.size) * direction;
        case "modified":
          return TEXT_COLLATOR.compare(String(a.lastModified ?? ""), String(b.lastModified ?? "")) * direction;
        case "kind":
          return TEXT_COLLATOR.compare(a.kind, b.kind) * direction;
        default:
          return NAME_COLLATOR.compare(a.name, b.name) * direction;
      }
    });
    return matched;
  });

  function setSort(key: SortKey) {
    if (sortKey.value === key) {
      sortAscending.value = !sortAscending.value;
    } else {
      sortKey.value = key;
      sortAscending.value = key === "name";
    }
  }

  function toggleSelected(key: string) {
    const next = new Set(selected.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected.value = next;
    selectionAnchor.value = key;
  }

  /** Select exactly one row, replacing any previous set. */
  function selectOnly(key: string) {
    selected.value = new Set([key]);
    selectionAnchor.value = key;
  }

  /**
   * Replace the selection with every row between the anchor and `key`, inclusive.
   *
   * The anchor is the row the range started at, so repeated Shift+clicks widen
   * and narrow the same range instead of growing a union on every click.
   */
  function selectRange(key: string) {
    const list = visibleEntries.value;
    const to = list.findIndex((entry) => entry.key === key);
    if (to === -1) return;
    const anchorKey = selectionAnchor.value ?? key;
    const from = list.findIndex((entry) => entry.key === anchorKey);
    if (from === -1) {
      selected.value = new Set([key]);
      selectionAnchor.value = key;
      return;
    }
    selectionAnchor.value = anchorKey;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    selected.value = new Set(list.slice(lo, hi + 1).map((entry) => entry.key));
  }

  /**
   * Move the focus (and the preview) without touching the selection.
   *
   * It also becomes the range anchor: clicking a row and then Shift+clicking
   * another is the normal way to select everything in between.
   */
  function focus(key: string | null, { keepAnchor = false } = {}) {
    focusedKey.value = key;
    if (key && !keepAnchor) selectionAnchor.value = key;
  }

  function clearSelection() {
    selected.value = new Set();
    selectionAnchor.value = null;
  }

  function selectAll(keys: string[]) {
    selected.value = new Set(keys);
    selectionAnchor.value = keys[0] ?? null;
  }

  const selectedEntries = computed(() =>
    entries.value.filter((entry) => selected.value.has(entry.key)),
  );

  /**
   * What Delete acts on: the selection, or the focused row when nothing is
   * selected. Never more than one row in the fallback case.
   */
  const deleteTargets = computed<ObjectEntry[]>(() => {
    if (selected.value.size) return selectedEntries.value;
    if (!focusedKey.value) return [];
    // The fallback is the cursor row, and only a row the filter still shows:
    // a hidden cursor used to let Delete remove an object off screen.
    const focused = visibleEntries.value.find((entry) => entry.key === focusedKey.value);
    return focused ? [focused] : [];
  });

  // ------------------------------------------------------------------ preview

  function clearPreview() {
    previewRequest += 1;
    preview.value = null;
    previewKey.value = null;
    folderMeta.value = null;
    previewLoading.value = false;
    previewError.value = null;
    previewErrorDetail.value = null;
    previewUnavailable.value = null;
    previewView.value = "rendered";
    // An expanded preview hides the object list, so clearing the preview must
    // also give the list back (the panel's Collapse button is keyed off it).
    useUiStore().collapsePreview();
  }

  /**
   * Fetch one key and settle the preview state.
   *
   * `previewEntry` and `refreshPreview` share this so the two paths cannot drift
   * on loading, errors or the stale-response guard. A refresh of the same key
   * keeps the old payload on screen while it runs; a different key and any
   * failure drop it.
   */
  async function fetchPreview(key: string, { keepPayload = false } = {}) {
    const connection = useConnectionsStore().active;
    if (!connection) return;

    const request = ++previewRequest;
    note(previewLog, `start#${request} ${key}`);
    previewLoading.value = true;
    // Drop the previous object's payload before the request even starts, unless
    // this is a refresh of the same key: then the old body stays readable.
    if (!keepPayload) {
      preview.value = null;
      previewUnavailable.value = null;
    }
    previewError.value = null;
    previewErrorDetail.value = null;

    let data: PreviewData | null = null;
    let failure: unknown = null;
    try {
      data = await api.getPreview({ connectionId: connection.id, key });
    } catch (caught) {
      failure = caught;
    }

    const message = failure instanceof Error ? failure.message : String(failure);
    note(previewLog, `got#${request} ${failure ? `fail:${message.slice(0, 40)}` : `${data?.kind}:${data?.key}`}`);

    // A newer click wins; this response is stale.
    if (request !== previewRequest || previewKey.value !== key) {
      note(previewLog, `drop#${request}`);
      return;
    }

    previewLoading.value = false;
    if (failure) {
      // An error must not leave the previous body on screen as if it were new.
      preview.value = null;
      previewUnavailable.value = null;
      previewError.value = message;
      if (failure instanceof ApiError) {
        previewErrorDetail.value = detailFrom(failure);
      }
      return;
    }
    preview.value = data;
    previewUnavailable.value = data?.unavailableReason ?? null;
    previewErrorDetail.value = null;
  }

  /**
   * Show a selected object.
   *
   * A folder has no payload: its key is remembered so the panel can render a
   * folder card (PRV-2), and no request is made. While the panel is hidden the
   * key is remembered without fetching; showing the panel calls
   * `refreshPreview` (PRV-4). `reveal` is the explicit open gesture: it asks a
   * hidden panel to come back instead of only remembering the key.
   */
  async function previewEntry(
    entry: ObjectEntry,
    { force = false, reveal = false } = {},
  ) {
    if (entry.isFolder) {
      clearPreview();
      previewKey.value = entry.key;
      folderMeta.value = entry;
      note(previewLog, `folder ${entry.key}`);
      return;
    }

    const sameObject = previewKey.value === entry.key;
    if (!force && sameObject && !previewLoading.value) return;

    previewKey.value = entry.key;
    folderMeta.value = null;
    if (!sameObject) previewView.value = "rendered";

    if (useUiStore().previewHidden) {
      // Nothing to show, so nothing to download. The key survives so the panel
      // opens on what the user last pointed at.
      preview.value = null;
      previewLoading.value = false;
      previewError.value = null;
      previewErrorDetail.value = null;
      previewUnavailable.value = null;
      note(previewLog, `deferred ${entry.key}`);
      // An explicit open (double-click, Enter) brings the panel back. Its
      // visibility watcher does the fetch, so the key is requested exactly once.
      if (reveal) useUiStore().togglePreview();
      return;
    }

    await fetchPreview(entry.key);
  }

  /**
   * Re-fetch the object the panel is showing, by key.
   *
   * Used after a listing finishes (the object may have changed or been deleted
   * since the click) and by the header's refresh button. Folders, an empty
   * preview and a hidden panel are no-ops.
   */
  async function refreshPreview() {
    const key = previewKey.value;
    if (!key || key.endsWith("/")) return;
    if (useUiStore().previewHidden) return;
    // Same key: keep the current content visible while the new copy loads.
    await fetchPreview(key, { keepPayload: true });
  }

  // A new limit applies in place: drop the least recently used folders until
  // the cache fits again, so lowering it is visible immediately.
  watch(
    () => useUiStore().settings?.listingCacheMaxBytes,
    () => {
      cache.trim();
      touchCache();
    },
  );

  return {
    logging: { listing: listingLog, preview: previewLog },
    prefix,
    sessionConnectionId,
    entries,
    loading,
    awaitingFirstPage,
    listed,
    truncated,
    warning,
    error,
    errorDetail,
    refreshing,
    cacheBytes,
    cacheFolders,
    selected,
    focusedKey,
    selectionAnchor,
    filter,
    sortKey,
    sortAscending,
    preview,
    previewKey,
    folderMeta,
    previewLoading,
    previewError,
    previewErrorDetail,
    previewUnavailable,
    previewView,
    open,
    visibleEntries,
    selectedEntries,
    deleteTargets,
    loadFolder,
    reload,
    reloadSession,
    onListingPage,
    onListingDone,
    onListingError,
    navigate,
    navigateUp,
    close,
    clearListingCache,
    setSort,
    toggleSelected,
    selectOnly,
    selectRange,
    focus,
    selectAll,
    clearSelection,
    clearPreview,
    previewEntry,
    refreshPreview,
  };
});
