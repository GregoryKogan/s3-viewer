// Import connections from the format the team already has on disk.
//
// Two shapes are accepted, which covers every realistic source:
//  1. the credentials file used on this machine:
//     { "bucket-name": { "access_key": ..., "secret_key": ..., "endpoint": ... }, ... }
//  2. a pasted boto3 snippet (endpoint_url / region_name / aws_access_key_id / …)
//
// Parsing is pure and unit-tested in the e2e suite via `window.__s3viewerImport`.

import { el, clear } from "./dom.js";
import { openModal } from "./modal.js";
import { toast, toastError, toastOk } from "./toast.js";
import { api } from "./api.js";

const DEFAULT_REGION = "us-east-1";

/** Strip quotes and trailing punctuation from a Python literal. */
function literal(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^['"]|['"]$/g, "").trim();
}

/** Parse `key=value` pairs out of a boto3 snippet. */
export function parseBoto3Snippet(text) {
  const pick = (pattern) => {
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
      addressingStyle: addressing,
    },
  ];
}

/**
 * Turn pasted text into a list of connection drafts.
 * @returns {Array<object>} drafts (possibly empty)
 */
export function parseImport(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Not valid JSON: ${error.message}`);
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

function draftsFromJson(payload) {
  const drafts = [];

  const fromEntry = (bucket, value) => {
    const endpoint = value.endpoint ?? value.endpoint_url ?? value.endpointUrl ?? "";
    const accessKey = value.access_key ?? value.access_key_id ?? value.aws_access_key_id ?? value.accessKeyId ?? "";
    const secretKey =
      value.secret_key ?? value.secret_access_key ?? value.aws_secret_access_key ?? value.secretAccessKey ?? "";
    if (!endpoint || !accessKey || !secretKey) return null;
    return {
      name: value.name ?? bucket ?? "Imported connection",
      endpointUrl: endpoint,
      region: value.region ?? value.region_name ?? DEFAULT_REGION,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken: value.session_token ?? value.aws_session_token ?? null,
      bucket: value.bucket ?? bucket ?? "",
      prefix: value.prefix ?? value.Prefix ?? "",
      signatureVersion: (value.signature_version ?? "s3v4").includes("v2") ? "s3v2" : "s3v4",
      addressingStyle: value.addressing_style ?? "virtual",
    };
  };

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const draft = fromEntry(entry?.bucket ?? entry?.name, entry ?? {});
      if (draft && draft.bucket) drafts.push(draft);
    }
    return drafts;
  }

  if (payload && typeof payload === "object") {
    // Single flat connection object.
    if (payload.endpoint || payload.endpoint_url || payload.endpointUrl) {
      const draft = fromEntry(payload.bucket ?? payload.name, payload);
      if (draft) drafts.push(draft);
      return drafts;
    }
    // Map of bucket -> credentials (the team's s3-creds.json layout).
    for (const [bucket, value] of Object.entries(payload)) {
      if (!value || typeof value !== "object") continue;
      const draft = fromEntry(bucket, value);
      if (draft) drafts.push({ ...draft, bucket: draft.bucket || bucket });
    }
  }
  return drafts;
}

/** Open the import dialog. */
export function openImportDialog({ onImported }) {
  const textarea = el("textarea", {
    rows: 10,
    placeholder: `{\n  "my-bucket": {\n    "access_key": "…",\n    "secret_key": "…",\n    "endpoint": "https://s3.example.com"\n  }\n}`,
    style: { fontFamily: "var(--mono)", fontSize: "12px" },
    "data-testid": "import-textarea",
  });
  const preview = el("div", { "data-testid": "import-preview" });
  const status = el("div", { class: "field__hint" });

  let drafts = [];

  const refresh = () => {
    clear(preview);
    clear(status);
    preview.append(status);
    try {
      drafts = parseImport(textarea.value);
    } catch (error) {
      drafts = [];
      status.textContent = error.message;
      status.style.color = "var(--danger)";
      return;
    }
    status.style.color = "";
    if (!drafts.length) {
      status.textContent = textarea.value.trim() ? "Nothing recognisable found." : "";
      return;
    }
    status.textContent = `${drafts.length} connection(s) ready to import:`;
    preview.append(
      el(
        "ul",
        { class: "detail-list" },
        drafts.map((draft) => el("li", { text: `${draft.name} → ${draft.endpointUrl} / ${draft.bucket}` })),
      ),
    );
  };

  textarea.addEventListener("input", refresh);
  refresh();

  const importButton = el("button", {
    class: "btn btn--primary",
    text: "Import",
    "data-testid": "import-confirm",
  });

  const modal = openModal({
    title: "Import connections",
    body: [
      el("p", {
        class: "muted",
        text: "Paste the JSON credentials file you already use, or a boto3 client snippet. Secrets are encrypted locally and never leave this machine.",
      }),
      el("div", { class: "field" }, [textarea]),
      preview,
    ],
    footer: [el("button", { class: "btn", text: "Cancel", onClick: () => modal.close() }), importButton],
  });

  importButton.addEventListener("click", async () => {
    if (!drafts.length) {
      toastError("Nothing to import.", "Import");
      return;
    }
    importButton.disabled = true;
    let created = 0;
    const failures = [];
    for (const draft of drafts) {
      if (!draft.bucket) {
        failures.push(`${draft.name}: no bucket name`);
        continue;
      }
      try {
        await api.saveConnection({ ...draft, prefix: draft.prefix ?? "" });
        created += 1;
      } catch (error) {
        failures.push(`${draft.name}: ${error.message}`);
      }
    }
    importButton.disabled = false;
    if (created) {
      toastOk(`Imported ${created} connection(s).`, "Import finished");
      modal.close();
      onImported?.();
    }
    if (failures.length) {
      toast({ level: "error", title: "Some connections failed", message: failures.join("\n") });
    }
  });

  return modal;
}
