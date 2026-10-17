import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { api } from "@/lib/ipc";
import { asFolderPrefix } from "@/lib/keys";
import { useConnectionsStore } from "@/stores/connections";
import { useToastsStore } from "@/stores/toasts";
import type {
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
  const entries = ref<ObjectEntry[]>([]);
  const loading = ref(false);
  const awaitingFirstPage = ref(false);
  const truncated = ref(false);
  const warning = ref<string | null>(null);
  const error = ref<string | null>(null);

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
  const previewLoading = ref(false);
  const previewError = ref<string | null>(null);
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

  async function loadFolder(targetPrefix: string) {
    const connections = useConnectionsStore();
    const connection = connections.active;
    if (!connection) return;

    prefix.value = asFolderPrefix(targetPrefix);
    entries.value = [];
    staged = [];
    selected.value.clear();
    selectionAnchor.value = null;
    focusedKey.value = null;
    filter.value = "";
    loading.value = true;
    awaitingFirstPage.value = true;
    error.value = null;
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
        useToastsStore().error((failure as Error).message, "Cannot list this folder");
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
    selected.value.clear();
    selectionAnchor.value = null;
  }

  function onListingError(event: ListingErrorEvent) {
    note(listingLog, `error#${event.requestId} ${event.error?.message ?? ""}`);
    if (event.requestId !== String(listingRequest)) return;
    staged = [];
    loading.value = false;
    awaitingFirstPage.value = false;
    error.value = event.error?.message ?? "listing failed";
    useToastsStore().error(event.error?.message ?? "listing failed", "Cannot list this folder");
  }

  async function navigate(targetPrefix: string) {
    clearPreview();
    await loadFolder(targetPrefix);
  }

  function navigateUp() {
    if (!prefix.value) return Promise.resolve();
    const parts = prefix.value.replace(/\/$/, "").split("/");
    parts.pop();
    return navigate(parts.length ? `${parts.join("/")}/` : "");
  }

  function close() {
    listingRequest += 1;
    prefix.value = "";
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

  /**
   * Select every row between the anchor and `key`, inclusive.
   *
   * The anchor is the last row the user acted on, so repeated Shift+clicks widen
   * and narrow the same range instead of starting a new one each time.
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
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const next = new Set(selected.value);
    for (let index = lo; index <= hi; index += 1) next.add(list[index].key);
    selected.value = next;
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

  // ------------------------------------------------------------------ preview

  function clearPreview() {
    previewRequest += 1;
    preview.value = null;
    previewKey.value = null;
    previewLoading.value = false;
    previewError.value = null;
    previewUnavailable.value = null;
    previewView.value = "rendered";
  }

  async function previewEntry(entry: ObjectEntry, { force = false } = {}) {
    if (entry.isFolder) {
      clearPreview();
      previewKey.value = entry.key;
      previewUnavailable.value = "This is a folder, not a file.";
      return;
    }

    const sameObject = previewKey.value === entry.key;
    if (!force && sameObject && !previewLoading.value) return;

    const request = ++previewRequest;
    note(previewLog, `start#${request} ${entry.key}`);
    previewKey.value = entry.key;
    previewLoading.value = true;
    // Drop the previous object's payload before the request even starts.
    preview.value = null;
    previewError.value = null;
    previewUnavailable.value = null;
    if (!sameObject) previewView.value = "rendered";

    const connection = useConnectionsStore().active;
    if (!connection) return;

    let data: PreviewData | null = null;
    let failure: string | null = null;
    try {
      data = await api.getPreview({ connectionId: connection.id, key: entry.key });
    } catch (caught) {
      failure = (caught as Error).message;
    }

    note(
      previewLog,
      `got#${request} ${failure ? `fail:${failure.slice(0, 40)}` : `${data?.kind}:${data?.key}`}`,
    );

    // A newer click wins; this response is stale.
    if (request !== previewRequest || previewKey.value !== entry.key) {
      note(previewLog, `drop#${request}`);
      return;
    }

    previewLoading.value = false;
    if (failure) {
      previewError.value = failure;
      return;
    }
    preview.value = data;
    previewUnavailable.value = data?.unavailableReason ?? null;
  }

  /** Re-render the current preview with a different view (Markdown raw/rendered). */
  function setPreviewView(view: "rendered" | "raw") {
    previewView.value = view;
  }

  return {
    logging: { listing: listingLog, preview: previewLog },
    prefix,
    entries,
    loading,
    awaitingFirstPage,
    truncated,
    warning,
    error,
    selected,
    focusedKey,
    selectionAnchor,
    filter,
    sortKey,
    sortAscending,
    preview,
    previewKey,
    previewLoading,
    previewError,
    previewUnavailable,
    previewView,
    open,
    visibleEntries,
    selectedEntries,
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
    selectRange,
    focus,
    selectAll,
    clearSelection,
    clearPreview,
    previewEntry,
    setPreviewView,
  };
});
