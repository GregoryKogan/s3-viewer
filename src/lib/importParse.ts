/**
 * Parsing for the import dialog.
 *
 * Two shapes are accepted, which covers every realistic source:
 *  1. the credentials file teams already keep on disk:
 *     { "bucket": { "access_key": …, "secret_key": …, "endpoint": … } }
 *  2. a pasted boto3 client snippet.
 *
 * Ported verbatim from the vanilla implementation; the shapes it accepts are the
 * shapes people actually have.
 */

import type { ConnectionDraft } from "@/types";

const DEFAULT_REGION = "us-east-1";

/** Anything JSON-shaped that a credentials file or a snippet may contain. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** What a parsed draft may carry beyond the strict draft type. */
type ParsedDraft = ConnectionDraft & { prefix?: string };

/** Strip quotes and trailing punctuation from a Python literal. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^['"]|['"]$/g, "").trim();
}

/** Parse `key=value` pairs out of a boto3 snippet. */
export function parseBoto3Snippet(text: string): ParsedDraft[] {
  const pick = (pattern: RegExp): string => {
    const match = text.match(pattern);
    return match ? literal(match[1]) : "";
  };
  const endpoint = pick(/endpoint_url\s*=\s*([^\s,)]+)/);
  const region = pick(/region_name\s*=\s*([^\s,)]+)/);
  const accessKey = pick(/aws_access_key_id\s*=\s*([^\s,)]+)/);
  const secretKey = pick(/aws_secret_access_key\s*=\s*([^\s,)]+)/);
  const sessionToken = pick(/aws_session_token\s*=\s*([^\s,)]+)/);
  const signature = pick(/signature_version\s*=\s*([^\s,)]+)/) || "s3v4";
  const addressing = pick(/addressing_style\s*["']?\s*:\s*([^\s,}]+)/) || "virtual";
  const bucket = pick(/Bucket\s*=\s*([^\s,)]+)/) || pick(/bucket\s*=\s*["']([^"']+)["']/);
  const prefix = pick(/Prefix\s*=\s*([^\s,)]+)/);

  if (!endpoint || !accessKey) return [];
  return [
    {
      name: bucket || "Imported connection",
      endpointUrl: endpoint,
      region: region || DEFAULT_REGION,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken: sessionToken || null,
      bucket: bucket || "",
      prefix,
      signatureVersion: signature.includes("v2") ? "s3v2" : "s3v4",
      addressingStyle: (["virtual", "path", "auto"].includes(addressing)
        ? addressing
        : "virtual") as "virtual" | "path" | "auto",
    },
  ];
}

/**
 * Turn pasted text into a list of connection drafts.
 * @returns {Array<object>} drafts (possibly empty)
 */
export function parseImport(text: string): ParsedDraft[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Not valid JSON: ${(error as Error).message}`);
    }
    return draftsFromJson(payload);
  }
  if (/boto3|endpoint_url|aws_access_key_id/.test(trimmed)) {
    const drafts = parseBoto3Snippet(trimmed);
    if (!drafts.length) throw new Error("Could not find endpoint_url and aws_access_key_id in that snippet.");
    return drafts;
  }
  throw new Error("Unrecognised format. Paste JSON credentials or a boto3 client snippet.");
}

/** Coerce a JSON value to a string; anything else becomes "". */
function text(value: Json | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstText(...values: (Json | undefined)[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function draftsFromJson(payload: Json): ParsedDraft[] {
  const drafts: ParsedDraft[] = [];

  const fromEntry = (bucket: string | undefined, value: JsonObject): ParsedDraft | null => {
    const endpoint = firstText(value.endpoint, value.endpoint_url, value.endpointUrl);
    const accessKey = firstText(
      value.access_key,
      value.access_key_id,
      value.aws_access_key_id,
      value.accessKeyId,
    );
    const secretKey = firstText(
      value.secret_key,
      value.secret_access_key,
      value.aws_secret_access_key,
      value.secretAccessKey,
    );
    if (!endpoint || !accessKey || !secretKey) return null;

    const signature = firstText(value.signature_version) || "s3v4";
    const addressing = firstText(value.addressing_style) || "virtual";
    const token = firstText(value.session_token, value.aws_session_token);

    return {
      name: firstText(value.name) || bucket || "Imported connection",
      endpointUrl: endpoint,
      region: firstText(value.region, value.region_name) || DEFAULT_REGION,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken: token || null,
      bucket: firstText(value.bucket) || bucket || "",
      prefix: firstText(value.prefix, value.Prefix),
      signatureVersion: signature.includes("v2") ? "s3v2" : "s3v4",
      addressingStyle: (["virtual", "path", "auto"].includes(addressing)
        ? addressing
        : "virtual") as "virtual" | "path" | "auto",
    };
  };

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const object = entry as JsonObject;
      const draft = fromEntry(firstText(object.bucket, object.name), object);
      if (draft && draft.bucket) drafts.push(draft);
    }
    return drafts;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const object = payload as JsonObject;
    // Single flat connection object.
    if (object.endpoint || object.endpoint_url || object.endpointUrl) {
      const draft = fromEntry(firstText(object.bucket, object.name), object);
      if (draft) drafts.push(draft);
      return drafts;
    }
    // Map of bucket -> credentials, which is the layout teams already keep.
    for (const [bucket, value] of Object.entries(object)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const draft = fromEntry(bucket, value as JsonObject);
      if (draft) drafts.push({ ...draft, bucket: draft.bucket || bucket });
    }
  }
  return drafts;
}

