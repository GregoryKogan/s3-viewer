import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { loadTs } from "./loadTs.mjs";

const { api, ApiError } = await loadTs("src/lib/ipc.ts");
const { useConnectionsStore } = await loadTs("src/stores/connections.ts");
const { useObjectsStore } = await loadTs("src/stores/objects.ts");
const { useToastsStore } = await loadTs("src/stores/toasts.ts");
const { useUiStore } = await loadTs("src/stores/ui.ts");

/** Listing ids the store asked the backend to stop, in order. */
const cancelledListings = [];
api.cancelListing = (requestId) => {
  cancelledListings.push(requestId);
  return Promise.resolve();
};

/** Scans never reach the backend by default; a search test overrides this. */
api.searchObjectsStream = () => Promise.resolve();

/**
 * The minimal shape `loadFolder` touches. The store reads the id and the scope
 * prefix; nothing here reaches the backend because the test replaces `api`.
 */
function connection(id) {
  return {
    id,
    name: id,
    bucket: "bucket",
    prefix: "",
    endpointUrl: "https://s3.example.com",
    region: "us-east-1",
    accessKeyId: "key",
    addressingStyle: "virtual",
    signatureVersion: "s3v4",
    security: {
      readOnlyMode: false,
      confirmDelete: true,
      confirmOverwrite: true,
      confirmBulk: false,
      detectPermissions: false,
      autoProbeOnConnect: false,
    },
  };
}

/** A listing call the test releases by hand, so the pre-response window is observable. */
function pendingListing() {
  let release;
  const started = [];
  api.listObjectsStream = (input) => {
    started.push(input);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  return { started, release: () => release?.() };
}

/** A listing call the test rejects by hand; the store turns it into an error state. */
function failingListing() {
  let reject;
  const started = [];
  api.listObjectsStream = (input) => {
    started.push(input);
    return new Promise((_, rejectListing) => {
      reject = rejectListing;
    });
  };
  return { started, reject: (error) => reject?.(error) };
}

/**
 * A listing call that emits a complete listing synchronously, so a test can
 * observe what the store paints before anything settles. `manual` holds the
 * promise open (and lets the test reject it) for the background-refresh paths.
 */
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

/** The minimal listing entry the store stores and the cache sizes. */
function objectEntry(key) {
  return { key, name: key.split("/").pop(), isFolder: false, size: 5, kind: "text" };
}

/** The real S3 shape: kind "s3", a service code, no HTTP status. */
const missingKey = (message = "The specified key does not exist.") =>
  new ApiError({ kind: "s3", code: "NoSuchKey", status: null, message });

const errorToasts = () => useToastsStore().toasts.filter((toast) => toast.level === "error");

function seed(sessionConnectionId) {
  setActivePinia(createPinia());
  const connections = useConnectionsStore();
  const objects = useObjectsStore();
  connections.views = [
    { connection: connection("a") },
    { connection: connection("b") },
  ];
  connections.setActive("a");
  // A live preview from connection A, without touching IPC.
  objects.sessionConnectionId = sessionConnectionId;
  objects.previewKey = "a.txt";
  objects.preview = { kind: "text", key: "a.txt", text: "hello" };
  return { connections, objects };
}

/**
 * Replace one saved connection the way an edit does: the id survives, the
 * fields the dialog writes change. `views` is what `active` is computed from,
 * so this is the same state `connections.load()` would install after a save.
 */
function retarget(connections, id, changes) {
  connections.views = connections.views.map((view) =>
    view.connection.id === id
      ? { ...view, connection: { ...view.connection, ...changes } }
      : view,
  );
}

test("switching connections clears the old preview before the session id moves", async () => {
  const { connections, objects } = seed("a");
  const listing = pendingListing();

  connections.setActive("b");
  const loading = objects.loadFolder("");

  // The guard is synchronous: the panel must be empty while B's listing streams,
  // not after it finishes (final review C1).
  assert.equal(objects.sessionConnectionId, "b");
  assert.equal(objects.previewKey, null);
  assert.equal(objects.preview, null);
  assert.equal(listing.started.length, 1);
  assert.equal(listing.started[0].connectionId, "b");

  listing.release();
  await loading;
});

test("a reload of the same session keeps the preview", async () => {
  const { objects } = seed("a");
  const listing = pendingListing();

  const loading = objects.loadFolder("");

  assert.equal(objects.sessionConnectionId, "a");
  assert.equal(objects.previewKey, "a.txt");
  assert.notEqual(objects.preview, null);

  listing.release();
  await loading;
});

test("changing folders inside one connection still clears the preview", async () => {
  const { objects } = seed("a");
  const listing = pendingListing();

  const navigating = objects.navigate("docs/");
  assert.equal(objects.previewKey, null);

  listing.release();
  await navigating;
});

test("a listing failure toasts once when the event arrives before the rejection", async () => {
  const { objects } = seed("a");
  const toasts = useToastsStore();
  toasts.clear();
  const listing = failingListing();

  const loading = objects.loadFolder("");
  const requestId = listing.started[0].requestId;

  // The event path announces the failure first.
  objects.onListingError({
    requestId,
    error: { kind: "s3", code: "NoSuchKey", message: "The specified key does not exist." },
  });
  // The rejected invoke then lands for the same request.
  listing.reject(missingKey());
  await loading;

  assert.equal(errorToasts().length, 1);
  toasts.clear();
});

test("a listing failure toasts once when the rejection arrives before the event", async () => {
  const { objects } = seed("a");
  const toasts = useToastsStore();
  toasts.clear();
  const listing = failingListing();

  const loading = objects.loadFolder("");
  const requestId = listing.started[0].requestId;

  // A failure raised before the stream starts never emits an event; the catch
  // must still announce it exactly once.
  listing.reject(missingKey());
  await loading;
  assert.equal(errorToasts().length, 1);

  // A late event for the same request must not announce it again.
  objects.onListingError({
    requestId,
    error: { kind: "s3", code: "NoSuchKey", message: "The specified key does not exist." },
  });
  assert.equal(errorToasts().length, 1);
  toasts.clear();
});

test("revealing a hidden preview opens the panel", async () => {
  const { objects } = seed("a");
  const ui = useUiStore();
  ui.layout.previewHidden = true;
  const entry = {
    key: "docs/notes.txt",
    name: "notes.txt",
    isFolder: false,
    size: 5,
    kind: "text",
  };

  await objects.previewEntry(entry, { force: true, reveal: true });

  assert.equal(ui.previewHidden, false);
  assert.equal(objects.previewKey, entry.key);
});

test("a cached folder is shown without another listing call", async () => {
  const { objects } = seed("a");
  const entries = [objectEntry("big/one.txt"), objectEntry("big/two.txt")];
  const listing = streamListing(objects, entries);

  await objects.loadFolder("big/");
  assert.equal(listing.calls.length, 1);
  assert.equal(objects.cacheFolders, 1);
  assert.equal(objects.cacheBytes > 0, true);

  // Leaving the folder keeps the entry; coming back must not list again.
  await objects.loadFolder("");
  assert.equal(listing.calls.length, 2);

  const loading = objects.loadFolder("big/");
  // The hit paints synchronously, before anything is awaited.
  assert.deepEqual(
    objects.entries.map((entry) => entry.key),
    ["big/one.txt", "big/two.txt"],
  );
  assert.equal(objects.loading, false);
  assert.equal(objects.refreshing, false);
  assert.equal(listing.calls.length, 2);
  await loading;
});

test("reload bypasses the cache and drops the entry", async () => {
  const { objects } = seed("a");
  const entries = [objectEntry("big/one.txt")];
  streamListing(objects, entries);
  await objects.loadFolder("big/");
  assert.equal(objects.cacheFolders, 1);

  const listing = pendingListing();
  const loading = objects.reload();

  // The forced path removes the entry before the new listing completes.
  assert.equal(objects.cacheFolders, 0);
  assert.equal(objects.cacheBytes, 0);
  assert.equal(listing.started.length, 1);
  assert.equal(listing.started[0].prefix, "big/");

  listing.release();
  await loading;
});

test("a stale cached folder is painted, then replaced by the background refresh", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { objects } = seed("a");
  const first = streamListing(objects, [objectEntry("big/old.txt")]);
  await objects.loadFolder("big/");
  assert.equal(first.calls.length, 1);

  t.mock.timers.tick(31_000);

  const refresh = streamListing(objects, [objectEntry("big/new.txt")], { manual: true });
  const loading = objects.loadFolder("big/");

  // The stale entry is painted at once while the refresh runs in the background.
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/old.txt"]);
  assert.equal(objects.loading, false);
  assert.equal(objects.refreshing, true);
  assert.equal(refresh.calls.length, 1);
  await loading;

  const requestId = refresh.calls[0].requestId;
  objects.onListingPage({
    requestId,
    prefix: "big/",
    entries: [objectEntry("big/new.txt")],
    total: 1,
    done: true,
  });
  objects.onListingDone({
    requestId,
    prefix: "big/",
    total: 1,
    files: 1,
    truncated: false,
    warning: null,
  });
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/new.txt"]);
  assert.equal(objects.refreshing, false);

  // The refreshed list is cached: a visit inside the 30 s window makes no call.
  const callsBefore = refresh.calls.length;
  await objects.loadFolder("big/");
  assert.equal(refresh.calls.length, callsBefore);
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/new.txt"]);
});

test("a failed background refresh keeps the cached list and stays quiet", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const entries = [objectEntry("big/kept.txt")];

  // (a) the listing error event arrives before the rejected invoke.
  {
    const { objects } = seed("a");
    const toasts = useToastsStore();
    toasts.clear();
    const first = streamListing(objects, entries);
    await objects.loadFolder("big/");
    assert.equal(first.calls.length, 1);
    t.mock.timers.tick(31_000);

    const refresh = streamListing(objects, [], { manual: true });
    const revalidating = objects.loadFolder("big/");
    assert.equal(objects.refreshing, true);
    const requestId = refresh.calls[0].requestId;
    await revalidating;

    objects.onListingError({
      requestId,
      error: { kind: "s3", code: "NoSuchKey", message: "The specified key does not exist." },
    });
    refresh.reject(missingKey());
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/kept.txt"]);
    assert.equal(objects.error, null);
    assert.equal(objects.refreshing, false);
    assert.equal(errorToasts().length, 0);
  }

  // (b) the invoke rejects first, then its listing error event arrives.
  {
    const { objects } = seed("a");
    const toasts = useToastsStore();
    toasts.clear();
    const first = streamListing(objects, entries);
    await objects.loadFolder("big/");
    assert.equal(first.calls.length, 1);
    t.mock.timers.tick(31_000);

    const refresh = streamListing(objects, [], { manual: true });
    const revalidating = objects.loadFolder("big/");
    assert.equal(objects.refreshing, true);
    const requestId = refresh.calls[0].requestId;
    await revalidating;
    refresh.reject(missingKey());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(objects.refreshing, false);

    objects.onListingError({
      requestId,
      error: { kind: "s3", code: "NoSuchKey", message: "The specified key does not exist." },
    });

    assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/kept.txt"]);
    assert.equal(objects.error, null);
    assert.equal(objects.refreshing, false);
    assert.equal(errorToasts().length, 0);
  }
});

test("clearListingCache empties the cache", async () => {
  const { objects } = seed("a");
  const listing = streamListing(objects, [objectEntry("big/one.txt")]);
  await objects.loadFolder("big/");
  assert.equal(objects.cacheFolders, 1);
  assert.equal(objects.cacheBytes > 0, true);

  objects.clearListingCache();
  assert.equal(objects.cacheFolders, 0);
  assert.equal(objects.cacheBytes, 0);

  // The next visit has to ask S3 again.
  await objects.loadFolder("big/");
  assert.equal(listing.calls.length, 2);
});

test("the cache is scoped to the connection", async () => {
  const { connections, objects } = seed("a");
  streamListing(objects, [objectEntry("big/one.txt")]);
  await objects.loadFolder("big/");
  assert.equal(objects.cacheFolders, 1);

  connections.setActive("b");
  const listing = pendingListing();
  const loading = objects.loadFolder("big/");

  // The same prefix in another connection is a miss, and A's list is not painted.
  assert.equal(listing.started.length, 1);
  assert.equal(listing.started[0].connectionId, "b");
  assert.equal(objects.entries.length, 0);
  assert.equal(objects.loading, true);
  assert.equal(objects.cacheFolders, 1);

  listing.release();
  await loading;
});

test("a zero cache limit turns the cache off", async () => {
  const { objects } = seed("a");
  const ui = useUiStore();
  ui.settings = { ...ui.settings, listingCacheMaxBytes: 0 };
  const listing = streamListing(objects, [objectEntry("big/one.txt")]);

  await objects.loadFolder("big/");
  assert.equal(listing.calls.length, 1);
  assert.equal(objects.cacheFolders, 0);
  assert.equal(objects.cacheBytes, 0);

  await objects.loadFolder("");
  assert.equal(listing.calls.length, 2);
  assert.equal(objects.cacheFolders, 0);

  // Coming back is a miss again: 0 means "do not cache", not "cache nothing yet".
  await objects.loadFolder("big/");
  assert.equal(listing.calls.length, 3);
  assert.equal(objects.cacheFolders, 0);
  assert.equal(objects.cacheBytes, 0);
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/one.txt"]);
});

test("clearing the cache drops an in-flight refresh's write", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { objects } = seed("a");
  const first = streamListing(objects, [objectEntry("big/kept.txt")]);
  await objects.loadFolder("big/");
  assert.equal(first.calls.length, 1);
  assert.equal(objects.cacheFolders, 1);

  t.mock.timers.tick(31_000);
  const refresh = streamListing(objects, [], { manual: true });
  const loading = objects.loadFolder("big/");
  assert.equal(objects.refreshing, true);
  const requestId = refresh.calls[0].requestId;
  await loading;

  objects.clearListingCache();
  assert.equal(objects.cacheFolders, 0);
  assert.equal(objects.cacheBytes, 0);

  // The refresh still lands and updates the visible list, but it must not put
  // the cleared folder back: the button promises the cache stays empty.
  objects.onListingPage({
    requestId,
    prefix: "big/",
    entries: [objectEntry("big/fresh.txt")],
    total: 1,
    done: true,
  });
  objects.onListingDone({
    requestId,
    prefix: "big/",
    total: 1,
    files: 1,
    truncated: false,
    warning: null,
  });

  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/fresh.txt"]);
  assert.equal(objects.refreshing, false);
  assert.equal(objects.cacheFolders, 0);
  assert.equal(objects.cacheBytes, 0);
});

test("an edit that retargets a connection does not serve the old target's listing", async () => {
  const { connections, objects } = seed("a");
  const first = streamListing(objects, [objectEntry("big/old.txt")]);
  await objects.loadFolder("big/");
  assert.equal(first.calls.length, 1);
  assert.equal(objects.cacheFolders, 1);

  // An edit keeps the id but moves the connection to another bucket.
  retarget(connections, "a", { bucket: "other-bucket" });

  const listing = pendingListing();
  const loading = objects.loadFolder("big/");

  // The old target's entry is not this target's entry: list for real, and do
  // not paint bucket A's rows against bucket B.
  assert.equal(listing.started.length, 1);
  assert.equal(listing.started[0].connectionId, "a");
  assert.deepEqual(objects.entries, []);
  assert.equal(objects.loading, true);

  listing.release();
  await loading;
});

test("the same target is still served from the cache", async () => {
  const { objects } = seed("a");
  const listing = streamListing(objects, [objectEntry("big/one.txt")]);
  await objects.loadFolder("big/");
  await objects.loadFolder("");
  assert.equal(listing.calls.length, 2);

  // No edit happened, so the same prefix is the same target: no IPC.
  await objects.loadFolder("big/");
  assert.equal(listing.calls.length, 2);
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/one.txt"]);
});

test("renaming a connection keeps its cached folders", async () => {
  const { connections, objects } = seed("a");
  const listing = streamListing(objects, [objectEntry("big/one.txt")]);
  await objects.loadFolder("big/");
  await objects.loadFolder("");
  assert.equal(listing.calls.length, 2);

  // A name is not part of the target: the bucket, endpoint and id are unchanged,
  // so the listing stays valid.
  retarget(connections, "a", { name: "renamed" });
  assert.equal(connections.active?.name, "renamed");

  await objects.loadFolder("big/");
  assert.equal(listing.calls.length, 2);
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["big/one.txt"]);
});

test("the first page paints while the rest of a large folder is still streaming", async () => {
  const { objects } = seed("a");
  const listing = pendingListing();

  const loading = objects.loadFolder("huge/");
  const requestId = listing.started[0].requestId;
  assert.deepEqual(objects.entries, []);
  assert.equal(objects.awaitingFirstPage, true);

  objects.onListingPage({
    requestId,
    prefix: "huge/",
    entries: [objectEntry("huge/a.txt")],
    total: 1,
    done: false,
  });

  // A prefix that needs minutes to enumerate shows its first page instead of an
  // empty window that reads as "this folder does not load".
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["huge/a.txt"]);
  assert.equal(objects.awaitingFirstPage, false);
  assert.equal(objects.loading, true, "the rest of the folder is still loading");

  // `done` settles the folder; the painted page is already the same list.
  objects.onListingDone({
    requestId,
    prefix: "huge/",
    total: 1,
    files: 1,
    truncated: false,
    warning: null,
  });
  assert.deepEqual(objects.entries.map((entry) => entry.key), ["huge/a.txt"]);
  assert.equal(objects.loading, false);

  listing.release();
  await loading;
});

test("the stall watchdog measures silence, not elapsed time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const toasts = useToastsStore();
  toasts.clear();
  const listing = pendingListing();

  const loading = objects.loadFolder("huge/");
  const requestId = listing.started[0].requestId;

  // A slow folder keeps delivering pages; each one buys another window, so a
  // listing that is still making progress is never declared stalled.
  t.mock.timers.tick(100_000);
  objects.onListingPage({
    requestId,
    prefix: "huge/",
    entries: [objectEntry("huge/a.txt")],
    total: 1,
    done: false,
  });
  t.mock.timers.tick(100_000);
  assert.equal(objects.error, null);
  assert.equal(objects.loading, true);

  // Nothing for a whole window is a stall.
  t.mock.timers.tick(120_000);
  assert.equal(objects.loading, false);
  assert.equal(objects.error, "The listing took too long to finish.");
  assert.equal(toasts.toasts.filter((toast) => toast.level === "warn").length, 1);

  listing.release();
  await loading;
});

test("a listing in flight repaints as the list grows and counts what it found", async () => {
  const { objects } = seed("a");
  const listing = pendingListing();

  const loading = objects.loadFolder("huge/");
  const requestId = listing.started[0].requestId;
  let next = 0;
  const page = (count) => {
    const entries = Array.from({ length: count }, () => objectEntry(`huge/${next++}.txt`));
    objects.onListingPage({
      requestId,
      prefix: "huge/",
      entries,
      total: count,
      done: false,
    });
  };

  page(2);
  assert.equal(objects.entries.length, 2);
  assert.equal(objects.listed, 2);

  // Pages inside the doubling window are counted but not painted: every repaint
  // re-sorts the whole list on screen, and a page costs six seconds.
  page(1);
  assert.equal(objects.listed, 3);
  assert.equal(objects.entries.length, 2);

  // Once the staged list has doubled, the next page paints all of it.
  page(1);
  assert.equal(objects.listed, 4);
  assert.equal(objects.entries.length, 4);

  listing.release();
  await loading;
});

test("the list sorts folders first and names in natural order", async () => {
  const { objects } = seed("a");
  streamListing(objects, [
    objectEntry("big/10.jpg"),
    objectEntry("big/9.jpg"),
    objectEntry("big/2.jpg"),
    { ...objectEntry("big/zeta"), isFolder: true, kind: "folder" },
  ]);
  await objects.loadFolder("big/");

  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.name),
    ["zeta", "2.jpg", "9.jpg", "10.jpg"],
  );
});

test("walking away from a folder stops the scan still running behind it", async () => {
  const { objects } = seed("a");
  const listing = pendingListing();
  cancelledListings.length = 0;

  // The user gives up on a huge folder and opens another one. S3 is still
  // walking `huge/`, a page every few seconds, and nobody will read the rest.
  void objects.loadFolder("huge/");
  const firstRequest = listing.started[0].requestId;
  const second = objects.loadFolder("small/");

  assert.deepEqual(cancelledListings, [firstRequest]);

  listing.release();
  await second;
});


/** Type into the filter and let the debounced scan start. */
async function typeQuery(objects, t, text) {
  objects.filter = text;
  // The store watches the filter, and a watcher flushes on the microtask queue.
  await nextTick();
  t.mock.timers.tick(500);
}

/** A scan the test drives page by page, so the streaming window is observable. */
function pendingSearch() {
  const started = [];
  api.searchObjectsStream = (input) => {
    started.push(input);
    return new Promise(() => {});
  };
  return { started };
}

/** One folder row, the shape the backend builds from a key path. */
function folderEntry(key) {
  const name = key.replace(/\/$/, "").split("/").pop();
  return { key, name, isFolder: true, size: 0, kind: "folder" };
}

test("a query searches every folder below, not just the rows on screen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  streamListing(objects, [objectEntry("huge/local.txt")]);
  await objects.loadFolder("huge/");

  // The row budget never delivered the folder the user is after; the filter
  // alone would answer "no matches" after 500 ms of typing.
  await typeQuery(objects, t, "fram");

  assert.equal(search.started.length, 1);
  assert.equal(search.started[0].prefix, "huge/");
  assert.equal(search.started[0].query, "fram");
  const requestId = search.started[0].requestId;

  // The first page arrives while the scan has read 12 000 keys: the row paints
  // and the counters move, without waiting for the end of the walk.
  objects.onSearchPage({
    requestId,
    prefix: "huge/",
    entries: [folderEntry("huge/aa12bb/cc34dd/frames/")],
    scanned: 12_000,
    matched: 1,
    capped: false,
  });
  assert.equal(objects.search.scanned, 12_000);
  assert.equal(objects.search.matched, 1);
  assert.equal(objects.search.running, true);
  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.key),
    ["huge/aa12bb/cc34dd/frames/"],
  );

  objects.onSearchDone({
    requestId,
    prefix: "huge/",
    query: "fram",
    scanned: 380_000,
    matched: 1,
    capped: false,
  });
  assert.equal(objects.search.running, false);
  assert.equal(objects.search.scanned, 380_000);
  // The painted row survives the end of the scan.
  assert.equal(objects.visibleEntries.length, 1);
});

test("a search row already on screen is not painted twice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  // The filter already matched this folder in the rows that were delivered; the
  // scan finds it again and a second copy in the list would double every action.
  streamListing(objects, [folderEntry("huge/frames/")]);
  await objects.loadFolder("huge/");

  await typeQuery(objects, t, "frames");
  objects.onSearchPage({
    requestId: search.started[0].requestId,
    prefix: "huge/",
    entries: [folderEntry("huge/frames/"), folderEntry("huge/x/frames/")],
    scanned: 1_000,
    matched: 2,
    capped: false,
  });

  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.key),
    ["huge/frames/", "huge/x/frames/"],
  );
});

test("changing the query stops the scan the old text started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  streamListing(objects, [objectEntry("huge/local.txt")]);
  await objects.loadFolder("huge/");
  cancelledListings.length = 0;

  await typeQuery(objects, t, "fram");
  const first = search.started[0].requestId;

  await typeQuery(objects, t, "vript");

  assert.deepEqual(cancelledListings, [first]);
  assert.equal(search.started.length, 2);
  assert.equal(search.started[1].query, "vript");
  // The old text's rows answer a question nobody is asking any more.
  assert.deepEqual(objects.visibleEntries.map((entry) => entry.key), []);
  assert.equal(objects.search.matched, 0);
});

test("clearing the filter drops the rows the scan found", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  streamListing(objects, [objectEntry("huge/local.txt")]);
  await objects.loadFolder("huge/");

  await typeQuery(objects, t, "frames");
  const requestId = search.started[0].requestId;
  objects.onSearchPage({
    requestId,
    prefix: "huge/",
    entries: [folderEntry("huge/aa12bb/frames/")],
    scanned: 500,
    matched: 1,
    capped: false,
  });
  assert.equal(objects.visibleEntries.length, 1);

  objects.filter = "";
  await nextTick();
  assert.equal(objects.search, null);
  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.key),
    ["huge/local.txt"],
  );

  // A page that arrives after the user walked away must not paint anything.
  objects.onSearchPage({
    requestId,
    prefix: "huge/",
    entries: [folderEntry("huge/aa12bb/frames/")],
    scanned: 900,
    matched: 2,
    capped: false,
  });
  assert.equal(objects.visibleEntries.length, 1);
});

test("a one-letter query filters the rows on screen without scanning the bucket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  streamListing(objects, [objectEntry("huge/alpha.txt"), objectEntry("huge/beta.txt")]);
  await objects.loadFolder("huge/");

  await typeQuery(objects, t, "a");
  t.mock.timers.tick(4_500);

  assert.equal(search.started.length, 0);
  assert.equal(objects.search, null);
  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.key),
    ["huge/alpha.txt", "huge/beta.txt"],
  );
});

test("a folder listing that finishes after a search keeps the matches on screen", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const listing = pendingListing();
  const search = pendingSearch();
  const loading = objects.loadFolder("huge/");

  await typeQuery(objects, t, "frames");
  const requestId = search.started[0].requestId;
  objects.onSearchPage({
    requestId,
    prefix: "huge/",
    entries: [folderEntry("huge/a/frames/")],
    scanned: 10,
    matched: 1,
    capped: false,
  });

  // The folder keeps streaming behind the scan: its pages and its final `done`
  // must not wipe the rows the user is reading.
  objects.onListingPage({
    requestId: listing.started[0].requestId,
    prefix: "huge/",
    entries: [objectEntry("huge/a.txt")],
    total: 1,
    done: false,
  });
  objects.onListingDone({
    requestId: listing.started[0].requestId,
    prefix: "huge/",
    total: 1,
    files: 1,
    truncated: false,
    warning: null,
  });

  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.key),
    ["huge/a/frames/"],
  );

  listing.release();
  await loading;
});

test("stopping a scan keeps the matches it already found", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  streamListing(objects, [objectEntry("huge/local.txt")]);
  await objects.loadFolder("huge/");
  cancelledListings.length = 0;

  await typeQuery(objects, t, "frames");
  const requestId = search.started[0].requestId;
  objects.onSearchPage({
    requestId,
    prefix: "huge/",
    entries: [folderEntry("huge/a/frames/")],
    scanned: 900,
    matched: 1,
    capped: false,
  });

  objects.stopSearch();
  assert.deepEqual(cancelledListings, [requestId]);
  assert.equal(objects.search.running, false);
  assert.equal(objects.search.stopped, true);

  // Stopping unwinds as a cancelled S3 walk, which arrives as an error event.
  // It is the user's own doing: no red banner, no unhealthy connection.
  assert.equal(
    objects.onSearchError({ requestId, error: { message: "the search was cancelled" } }),
    false,
  );
  assert.equal(objects.search.error, null);
  assert.deepEqual(
    objects.visibleEntries.map((entry) => entry.key),
    ["huge/a/frames/"],
  );
});

test("a search that fails says so instead of pretending to be running", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { objects } = seed("a");
  const search = pendingSearch();
  streamListing(objects, [objectEntry("huge/local.txt")]);
  await objects.loadFolder("huge/");

  await typeQuery(objects, t, "frames");
  const requestId = search.started[0].requestId;

  assert.equal(
    objects.onSearchError({ requestId, error: { message: "Access denied." } }),
    true,
  );
  assert.equal(objects.search.running, false);
  assert.equal(objects.search.error, "Access denied.");
  // A failure of a superseded scan is not this one's problem.
  assert.equal(
    objects.onSearchError({ requestId: "0", error: { message: "gone" } }),
    false,
  );
});
