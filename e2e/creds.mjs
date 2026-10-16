// Resolves dev-bucket credentials for the test harness.
//
// Guardrails, because this repository is shared and the machine holds many
// production credentials:
//  * only the exact bucket the project is allowed to touch is ever used;
//  * if the credentials file lists anything but that bucket, the extra entries
//    are ignored entirely (never read into the process, never logged);
//  * no value is ever printed — only redacted prefixes and lengths.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The bucket this suite is allowed to touch.
 *
 * Deliberately *not* hard-coded: no bucket name from anyone's infrastructure
 * belongs in this repository. Resolution order:
 *   1. `S3VIEWER_TEST_BUCKET`
 *   2. `e2e/.env.local` (gitignored), a tiny KEY=VALUE file
 * There is no fallback: without one of those the suite refuses to start, which is
 * the right failure mode for a test that creates and deletes objects.
 */
export function resolveBucket() {
  if (process.env.S3VIEWER_TEST_BUCKET) return process.env.S3VIEWER_TEST_BUCKET;
  const localFile = path.join(import.meta.dirname, ".env.local");
  if (fs.existsSync(localFile)) {
    for (const line of fs.readFileSync(localFile, "utf8").split("\n")) {
      const match = line.match(/^\s*S3VIEWER_TEST_BUCKET\s*=\s*(.+?)\s*$/);
      if (match) return match[1].replace(/^["']|["']$/g, "");
    }
  }
  throw new Error(
    "No test bucket configured. Set S3VIEWER_TEST_BUCKET or create e2e/.env.local with\n" +
      "  S3VIEWER_TEST_BUCKET=<your scratch bucket>",
  );
}

/** Resolved once per process. */
export const ALLOWED_BUCKET = resolveBucket();
export const E2E_PREFIX = "_s3viewer-e2e/";
const CREDS_PATH = path.join(os.homedir(), ".secrets", "s3", "s3-creds.json");

function redact(value) {
  if (!value) return "(missing)";
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

/**
 * @returns {{bucket: string, endpoint: string, region: string, accessKey: string,
 *            secretKey: string, source: string}}
 */
export function devCreds() {
  const endpoint = process.env.S3VIEWER_TEST_ENDPOINT;
  const accessKey = process.env.S3VIEWER_TEST_ACCESS_KEY;
  const secretKey = process.env.S3VIEWER_TEST_SECRET_KEY;
  if (endpoint && accessKey && secretKey) {
    return {
      bucket: ALLOWED_BUCKET,
      endpoint,
      region: process.env.S3VIEWER_TEST_REGION ?? "us-east-1",
      accessKey,
      secretKey,
      source: "environment",
    };
  }

  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error(
      `No credentials: set S3VIEWER_TEST_ACCESS_KEY/S3VIEWER_TEST_SECRET_KEY/S3VIEWER_TEST_ENDPOINT or provide ${CREDS_PATH}`,
    );
  }

  const parsed = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
  const entry = parsed[ALLOWED_BUCKET];
  if (!entry) {
    throw new Error(`Credentials file has no entry for ${ALLOWED_BUCKET}`);
  }
  const resolved = {
    bucket: ALLOWED_BUCKET,
    endpoint: entry.endpoint,
    region: process.env.S3VIEWER_TEST_REGION ?? guessRegion(entry.endpoint) ?? "us-east-1",
    accessKey: entry.access_key,
    secretKey: entry.secret_key,
    source: `${CREDS_PATH} [${ALLOWED_BUCKET}]`,
  };
  if (!resolved.endpoint || !resolved.accessKey || !resolved.secretKey) {
    throw new Error(`Credentials entry for ${ALLOWED_BUCKET} is incomplete`);
  }
  return resolved;
}

/**
 * Best-effort region extraction from an S3 endpoint host, e.g.
 * `s3.eu-central-1.example.com` -> `eu-central-1`. Providers differ, so this is
 * only a fallback: S3VIEWER_TEST_REGION always wins.
 */
function guessRegion(endpoint) {
  const host = String(endpoint ?? "").replace(/^https?:\/\//, "").split("/")[0];
  const match = host.match(/(?:^|[.\-_])([a-z]{2}(?:-[a-z]+)+(?:-\d+)?)/i);
  return match ? match[1] : null;
}

export function describeCreds(creds) {
  return [
    `bucket=${creds.bucket}`,
    `endpoint=${creds.endpoint}`,
    `region=${creds.region}`,
    `accessKey=${redact(creds.accessKey)}`,
    `secret=${redact(creds.secretKey)}`,
    `source=${creds.source}`,
  ].join(" ");
}

/** Object key for a fixture inside the disposable e2e prefix. */
export function keyFor(name) {
  return `${E2E_PREFIX}${name}`;
}
