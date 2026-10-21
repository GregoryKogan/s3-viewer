import test from "node:test";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { loadTs } from "./loadTs.mjs";

const { api, ApiError } = await loadTs("src/lib/ipc.ts");
const { useConnectionsStore } = await loadTs("src/stores/connections.ts");
const { useObjectsStore } = await loadTs("src/stores/objects.ts");
const { useToastsStore } = await loadTs("src/stores/toasts.ts");
const { useUiStore } = await loadTs("src/stores/ui.ts");

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
