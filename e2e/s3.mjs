// A ~120-line SigV4 S3 client for the test harness.
//
// The e2e suite needs to seed the dev bucket with fixtures and then verify that
// everything it created is gone. Doing that with a hand-written SigV4 signer
// keeps the test independent of the app under test: if the app's signing were
// broken, a shared client would hide the bug.

import crypto from "node:crypto";
import fs from "node:fs";

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC3986 encoding. `encodeSlash: false` keeps `/` for object paths. */
export function uriEncode(value, encodeSlash = true) {
  let out = "";
  for (const byte of Buffer.from(String(value), "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char)) out += char;
    else if (char === "/" && !encodeSlash) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Build the SigV4 headers for one request.
 * @param {{method: string, host: string, path: string, query: Record<string,string>,
 *          payload: Buffer|string, creds: {accessKey, secretKey, sessionToken},
 *          region: string, service?: string, date?: Date}} request
 */
export function signRequest({
  method,
  host,
  path,
  query = {},
  payload = "",
  creds,
  region,
  service = "s3",
  date = new Date(),
}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "", "utf8");
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(query[key])}`)
    .join("&");

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${creds.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3 {
  constructor({ endpoint, region, accessKey, secretKey, sessionToken, bucket }) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.url = new URL(this.endpoint);
    this.region = region;
    this.creds = { accessKey, secretKey, sessionToken };
    this.bucket = bucket;
    // Virtual-host addressing: this endpoint requires it.
    this.host = `${bucket}.${this.url.host}`;
    this.scheme = this.url.protocol.replace(":", "");
  }

  async request(method, key = "", { query = {}, body = "", raw = false } = {}) {
    const path = key ? `/${uriEncode(key, false)}` : "/";
    const headers = signRequest({
      method,
      host: this.host,
      path,
      query,
      payload: body,
      creds: this.creds,
      region: this.region,
    });
    const queryString = new URLSearchParams(query).toString();
    const url = `${this.scheme}://${this.host}${path}${queryString ? `?${queryString}` : ""}`;
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
      },
      body: method === "GET" || method === "HEAD" ? undefined : body,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const text = buffer.toString("utf8").slice(0, 500);
      throw new Error(`${method} ${path} -> ${response.status} ${text}`);
    }
    return raw ? buffer : { status: response.status, headers: response.headers, body: buffer };
  }

  async listAll(prefix = "") {
    const keys = [];
    let token = null;
    for (;;) {
      const query = { "list-type": "2", "max-keys": "1000" };
      if (prefix) query.prefix = prefix;
      if (token) query["continuation-token"] = token;
      const { body } = await this.request("GET", "", { query });
      const xml = body.toString("utf8");
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(match[1]));
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
      if (!truncated || !next) break;
      token = decodeXml(next[1]);
    }
    return keys;
  }

  async put(key, body, contentType = "application/octet-stream") {
    await this.request("PUT", key, { body, query: {} });
    void contentType;
  }

  async putFile(key, filePath, contentType = "application/octet-stream") {
    const body = fs.readFileSync(filePath);
    const path = `/${uriEncode(key, false)}`;
    const headers = signRequest({
      method: "PUT",
      host: this.host,
      path,
      query: {},
      payload: body,
      creds: this.creds,
      region: this.region,
    });
    const response = await fetch(`${this.scheme}://${this.host}${path}`, {
      method: "PUT",
      headers: { ...headers, "content-type": contentType, "content-length": String(body.length) },
      body,
    });
    if (!response.ok) {
      throw new Error(`PUT ${key} -> ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
  }

  async get(key) {
    const { body } = await this.request("GET", key);
    return body;
  }

  async head(key) {
    try {
      await this.request("HEAD", key);
      return true;
    } catch {
      return false;
    }
  }

  async remove(key) {
    await this.request("DELETE", key);
  }

  /** Delete every key under a prefix. Returns how many were removed. */
  async removePrefix(prefix) {
    const keys = await this.listAll(prefix);
    for (const key of keys) await this.remove(key);
    return keys.length;
  }
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
