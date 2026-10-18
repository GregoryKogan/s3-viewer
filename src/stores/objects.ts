import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { api, ApiError } from "@/lib/ipc";
import { asFolderPrefix } from "@/lib/keys";
import { useConnectionsStore } from "@/stores/connections";
import { useToastsStore } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";
import type {
  ListErrorDetail,
  ListingDoneEvent,
  ListingErrorEvent,
  ListingPageEvent,
  ObjectEntry,
  PreviewData,
} from "@/types";

export type SortKey = "name" | "size" | "modified" | "kind";

/**
 * One browsing session: the folder on screen, its objects, the selection, and the
 * preview. Listings stream in, so `entries` is only replaced when a folder has
 * finished loading — never partially, which previously let a cancelled load show
 * an empty folder as fact.
 */
export const useObjectsStore = defineStore("objects", () => {
  const prefix = ref("");
  /**
   * The connection this listing belongs to. Every mutation checks it against
   * the active connection, so a stale session can never delete objects in
   * another bucket that happens to share the same keys.
   */
  const sessionConnectionId = ref<string | null>(null);
  const entries = ref<ObjectEntry[]>([]);
  const loading = ref(false);
  const awaitingFirstPage = ref(false);
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

  async function loadFolder(targetPrefix: string) {
    const connections = useConnectionsStore();
    const connection = connections.active;
    if (!connection) return;

    const nextPrefix = asFolderPrefix(targetPrefix);
    // A reload of the same folder keeps the selection and the filter; a new
    // folder (or a different connection on the same prefix) starts fresh.
    const continuing =
      sessionConnectionId.value === connection.id && nextPrefix === prefix.value;
    sessionConnectionId.value = connection.id;
    prefix.value = nextPrefix;
    entries.value = [];
    staged = [];
    if (!continuing) {
      selected.value = new Set();
      selectionAnchor.value = null;
      focusedKey.value = null;
      filter.value = "";
      // A different folder or connection must never leave the list hidden
      // behind a full-width preview that no longer has an object.
      useUiStore().collapsePreview();
    }
    loading.value = true;
    awaitingFirstPage.value = true;
    error.value = null;
    errorDetail.value = null;
    warning.value = null;
    truncated.value = false;

    if (loading.value) note(listingLog, `superseded#${listingRequest}`);
    const requestId = String(++listingRequest);
    note(listingLog, `start#${requestId} "${prefix.value}"`);

    const guard = setTimeout(() => {
      if (String(listingRequest) === requestId && loading.value) {
        loading.value = false;
        awaitingFirstPage.value = false;
        error.value = "The listing took too long to finish.";
        useToastsStore().warn("The listing stalled. Press refresh to try again.", "Listing stalled");
      }
    }, 120_000);

    try {
      await api.listObjectsStream({ connectionId: connection.id, prefix: prefix.value, requestId });
    } catch (failure) {
      if (String(listingRequest) === requestId) {
        loading.value = false;
        awaitingFirstPage.value = false;
        error.value = (failure as Error).message;
        if (failure instanceof ApiError) {
          // The event often arrives before the rejected invoke and already knows
          // the S3 request id; a throw without one must not erase it.
          errorDetail.value = {
            hints: failure.hints,
            code: failure.code,
            requestId: failure.requestId ?? recordedRequestId(),
          };
        }
        useToastsStore().apiError(failure, "Cannot list this folder");
      }
    } finally {
      clearTimeout(guard!);
    }
  }

  /** Reload the folder currently on screen. */
  function reload() {
    return loadFolder(prefix.value);
  }

  /** Re-open the session after a connection was edited. */
  function reloadSession() {
    const connection = useConnectionsStore().active;
    if (!connection) return Promise.resolve();
    return loadFolder(connection.prefix ?? "");
  }

  function onListingPage(event: ListingPageEvent) {
    note(listingLog, `page#${event.requestId}+${event.entries?.length ?? 0}`);
    if (event.requestId !== String(listingRequest)) return;
    if (!useConnectionsStore().active) return;
    if (event.entries?.length) {
      staged.push(...event.entries);
    }
  }

  function onListingDone(event: ListingDoneEvent) {
    note(listingLog, `done#${event.requestId} total=${event.total}`);
    if (event.requestId !== String(listingRequest)) return;
    entries.value = staged;
    staged = [];
    loading.value = false;
    awaitingFirstPage.value = false;
    truncated.value = event.truncated;
    warning.value = event.warning ?? null;
    prefix.value = event.prefix ?? prefix.value;

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
  }

  function onListingError(event: ListingErrorEvent) {
    note(listingLog, `error#${event.requestId} ${event.error?.message ?? ""}`);
    if (event.requestId !== String(listingRequest)) return;
    staged = [];
    loading.value = false;
    awaitingFirstPage.value = false;
    error.value = event.error?.message ?? "listing failed";
    errorDetail.value = {
      hints: event.error?.hints ?? [],
      code: event.error?.code ?? null,
      // The top-level requestId is the internal listing counter; the S3 id lives
      // inside the payload.
      requestId: event.error?.requestId ?? null,
    };
    // Raise the event as an ApiError so the toast keeps the same hints and code
    // the inline error state shows; a staged listing has no inline notice.
    useToastsStore().apiError(
      new ApiError(event.error ?? { message: "listing failed" }),
      "Cannot list this folder",
    );
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
    clearPreview();
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
          return String(a.lastModified ?? "").localeCompare(String(b.lastModified ?? "")) * direction;
        case "kind":
          return a.kind.localeCompare(b.kind) * direction;
        default:
          return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction;
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

  /** Select exactly one row, like a plain click in a file manager. */
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
    const focused = entries.value.find((entry) => entry.key === focusedKey.value);
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
        previewErrorDetail.value = {
          hints: failure.hints,
          code: failure.code,
          requestId: failure.requestId,
        };
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
   * `refreshPreview` (PRV-4).
   */
  async function previewEntry(entry: ObjectEntry, { force = false } = {}) {
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

  /** Re-render the current preview with a different view (Markdown raw/rendered). */
  function setPreviewView(view: "rendered" | "raw") {
    previewView.value = view;
  }

  return {
    logging: { listing: listingLog, preview: previewLog },
    prefix,
    sessionConnectionId,
    entries,
    loading,
    awaitingFirstPage,
    truncated,
    warning,
    error,
    errorDetail,
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
    setPreviewView,
  };
});
