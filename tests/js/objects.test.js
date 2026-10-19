import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { api, createPinia, setActivePinia, useConnectionsStore, useObjectsStore } = await loadTs(
  "tests/js/objectsHarness.ts",
);

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
