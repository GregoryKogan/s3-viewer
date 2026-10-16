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
 * The bucket the local e2e run touches. It is a real dev bucket, not a client
 * setting: the client itself never hard-codes any bucket. Override it with
 * S3VIEWER_TEST_BUCKET to point the suite at your own scratch bucket.
 */
export const ALLOWED_BUCKET = process.env.S3VIEWER_TEST_BUCKET ?? "my-bucket";
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
  const envBucket = process.env.S3VIEWER_TEST_BUCKET;
  if (envBucket && envBucket !== ALLOWED_BUCKET) {
    throw new Error(
      `S3VIEWER_TEST_BUCKET is ${envBucket}, but this suite is only permitted to touch ${ALLOWED_BUCKET}.`,
    );
  }

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
