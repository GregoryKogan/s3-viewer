import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { ApiError, isNotFound } = await loadTs("src/lib/ipc.ts");

test("isNotFound accepts the backend's notFound kind", () => {
  assert.equal(isNotFound(new ApiError({ message: "No such key", kind: "notFound" })), true);
});

test("isNotFound accepts a bare 404 status", () => {
  assert.equal(isNotFound(new ApiError({ message: "Not Found", status: 404 })), true);
});

test("isNotFound rejects every other failure", () => {
  // AddressBar must not turn a denied or failed probe into "Nothing found".
  assert.equal(isNotFound(new ApiError({ message: "Forbidden", kind: "denied", status: 403 })), false);
  assert.equal(isNotFound(new ApiError({ message: "Network error" })), false);
  assert.equal(isNotFound(new Error("Nothing found")), false);
  assert.equal(isNotFound("notFound"), false);
  assert.equal(isNotFound(null), false);
});
