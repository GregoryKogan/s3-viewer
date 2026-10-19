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

test("isNotFound recognises the real S3 payload with no HTTP status", () => {
  // `src-tauri/src/error.rs` serialises an S3 failure as kind "s3" + code, and
  // the client leaves `status` null; the backend's own is_missing matches the code.
  assert.equal(
    isNotFound(new ApiError({ kind: "s3", code: "NoSuchKey", status: null, message: "missing" })),
    true,
  );
});

test("isNotFound matches the missing-key codes case-insensitively", () => {
  for (const code of ["NoSuchKey", "NotFound", "NoSuchObject", "NoSuchKeyMarker", "404"]) {
    assert.equal(
      isNotFound(new ApiError({ kind: "s3", code, status: null, message: "missing" })),
      true,
      code,
    );
  }
  assert.equal(
    isNotFound(new ApiError({ kind: "s3", code: "nosuchkey", status: null, message: "missing" })),
    true,
  );
});

test("isNotFound rejects every other failure", () => {
  // AddressBar must not turn a denied or failed probe into "Nothing found".
  assert.equal(isNotFound(new ApiError({ message: "Forbidden", kind: "denied", status: 403 })), false);
  assert.equal(
    isNotFound(new ApiError({ kind: "s3", code: "AccessDenied", status: 403, message: "no" })),
    false,
  );
  assert.equal(isNotFound(new ApiError({ message: "Network error" })), false);
  assert.equal(isNotFound(new Error("Nothing found")), false);
  assert.equal(isNotFound("notFound"), false);
  assert.equal(isNotFound(null), false);
});
