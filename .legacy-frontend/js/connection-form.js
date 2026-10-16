// Connection editor — the heart of the app.
//
// The form is laid out to mirror a boto3 client construction one-to-one, so
// settings can be copied from working Python without translation. The generated
// snippet at the bottom is the proof: it is built from the current form values.

import { el } from "./dom.js";
import { openModal, confirmDialog, messageDialog } from "./modal.js";
import { toast, toastError, toastOk } from "./toast.js";
import { api } from "./api.js";

const ADDRESSING = [
  ["virtual", "virtual — host-style (recommended for this endpoint)"],
  ["path", "path — bucket in the URL path"],
  ["auto", "auto — path style unless the bucket name is DNS-compatible"],
];

const SIGNATURES = [
  ["s3v4", "s3v4 — SigV4, boto3 default"],
  ["v4", "v4 — plain SigV4"],
  ["s3v2", "s3v2 — legacy HmacSHA1 (SigV2)"],
];

function field(label, control, hint, extraClass = "") {
  return el("div", { class: `field ${extraClass}` }, [
    el("label", { text: label }),
    control,
    hint ? el("div", { class: "field__hint", text: hint }) : null,
  ]);
}

function checkbox(label, hint, checked) {
  const input = el("input", { type: "checkbox", checked });
  return {
    input,
    node: el("label", { class: "check" }, [
      input,
      el("span", {}, [label, hint ? el("small", { text: hint }) : null]),
    ]),
  };
}

/** Build the boto3 snippet that reproduces the current form. */
export function boto3Snippet(values) {
  const lines = ["import boto3", "from botocore.config import Config", "", "client = boto3.client("];
  lines.push(`    "s3",`);
  lines.push(`    endpoint_url="${values.endpointUrl}",`);
  if (values.region) lines.push(`    region_name="${values.region}",`);
  lines.push(`    aws_access_key_id="${values.accessKeyId}",`);
  const secret = values.secretAccessKey ? values.secretAccessKey : "<stored on this machine>";
  lines.push(`    aws_secret_access_key="${secret}",`);
  if (values.sessionToken) lines.push(`    aws_session_token="${values.sessionToken}",`);
  lines.push(`    config=Config(`);
  lines.push(`        signature_version="${values.signatureVersion}",`);
  lines.push(`        s3={`);
  lines.push(`            "addressing_style": "${values.addressingStyle}",`);
  lines.push(`            "payload_signing_enabled": ${values.payloadSigning ? "True" : "False"},`);
  lines.push(`        },`);
  lines.push(`    ),`);
  lines.push(")");
  lines.push("");
  lines.push(`# bucket: ${values.bucket}`);
  lines.push(`# prefix: ${values.prefix}`);
  return lines.join("\n");
}

/**
 * Open the connection editor.
 * @param {{connection?: object, onSaved: (connection: object) => void}} options
 */
export function openConnectionForm({ connection = null, onSaved }) {
  const isEdit = Boolean(connection?.id);

  const nameInput = el("input", {
    type: "text",
    value: connection?.name ?? "",
    placeholder: "Dev vision bucket",
    "data-testid": "conn-name",
  });
  const endpointInput = el("input", {
    type: "text",
    value: connection?.endpointUrl ?? "",
    placeholder: "https://s3.example.com",
    "data-testid": "conn-endpoint",
  });
  const regionInput = el("input", {
    type: "text",
    value: connection?.region ?? "us-east-1",
    placeholder: "us-east-1",
    "data-testid": "conn-region",
  });
  const accessInput = el("input", {
    type: "text",
    value: connection?.accessKeyId ?? "",
    placeholder: "AKIA…",
    autocomplete: "off",
    "data-testid": "conn-access-key",
  });
  const secretInput = el("input", {
    type: "password",
    value: "",
    placeholder: isEdit && connection?.hasSecret ? "•••••••• (stored — leave empty to keep)" : "",
    autocomplete: "off",
    "data-testid": "conn-secret-key",
  });
  const revealSecret = el("input", { type: "checkbox" });
  revealSecret.addEventListener("change", () => {
    secretInput.type = revealSecret.checked ? "text" : "password";
  });
  const tokenInput = el("input", {
    type: "password",
    value: "",
    placeholder: connection?.sessionTokenPresent ? "session token set" : "optional (STS)",
    autocomplete: "off",
    "data-testid": "conn-session-token",
  });
  const clearToken = el("input", { type: "checkbox" });
  const bucketInput = el("input", {
    type: "text",
    value: connection?.bucket ?? "",
    placeholder: "my-bucket",
    "data-testid": "conn-bucket",
  });
  const prefixInput = el("input", {
    type: "text",
    value: connection?.prefix ?? "",
    placeholder: "some/folder/",
    "data-testid": "conn-prefix",
  });

  const addressingSelect = el(
    "select",
    { "data-testid": "conn-addressing" },
    ADDRESSING.map(([value, label]) =>
      el("option", { value, text: label, selected: (connection?.addressingStyle ?? "virtual") === value }),
    ),
  );
  const signatureSelect = el(
    "select",
    { "data-testid": "conn-signature" },
    SIGNATURES.map(([value, label]) =>
      el("option", { value, text: label, selected: (connection?.signatureVersion ?? "s3v4") === value }),
    ),
  );

  const security = connection?.security ?? {};
  const readOnly = checkbox(
    "Read-only mode",
    "Block every write, upload, rename and delete on this connection.",
    security.readOnlyMode ?? false,
  );
  const confirmDelete = checkbox(
    "Ask before deleting",
    "Show a confirmation dialog for delete operations.",
    security.confirmDelete ?? true,
  );
  const confirmOverwrite = checkbox(
    "Ask before overwriting",
    "Warn when an upload would replace an existing object.",
    security.confirmOverwrite ?? true,
  );
  const detectPermissions = checkbox(
    "Detect permissions on connect",
    "Probe read/write/delete rights with a temporary object that is removed immediately.",
    security.detectPermissions ?? true,
  );

  const probeOutput = el("div", { class: "field__hint", "data-testid": "probe-output" });
  const snippet = el("pre", { class: "code-block", "data-testid": "boto3-snippet" });

  const collect = () => ({
    id: connection?.id ?? null,
    name: nameInput.value.trim(),
    endpointUrl: endpointInput.value.trim(),
    region: regionInput.value.trim(),
    accessKeyId: accessInput.value.trim(),
    secretAccessKey: secretInput.value,
    sessionToken: clearToken.checked ? null : tokenInput.value || null,
    clearSessionToken: clearToken.checked,
    bucket: bucketInput.value.trim(),
    prefix: prefixInput.value,
    addressingStyle: addressingSelect.value,
    signatureVersion: signatureSelect.value,
    payloadSigningEnabled: false,
    security: {
      readOnlyMode: readOnly.input.checked,
      confirmDelete: confirmDelete.input.checked,
      confirmOverwrite: confirmOverwrite.input.checked,
      confirmBulk: false,
      detectPermissions: detectPermissions.input.checked,
      autoProbeOnConnect: true,
    },
  });

  const refreshSnippet = () => {
    snippet.textContent = boto3Snippet(collect());
  };
  for (const node of [
    nameInput,
    endpointInput,
    regionInput,
    accessInput,
    secretInput,
    tokenInput,
    bucketInput,
    prefixInput,
  ]) {
    node.addEventListener("input", refreshSnippet);
  }
  addressingSelect.addEventListener("change", refreshSnippet);
  signatureSelect.addEventListener("change", refreshSnippet);

  const draftForProbe = () => {
    const values = collect();
    return {
      id: values.id,
      connection: {
        endpointUrl: values.endpointUrl,
        region: values.region,
        accessKeyId: values.accessKeyId,
        secretAccessKey: values.secretAccessKey || null,
        sessionToken: values.sessionToken,
        bucket: values.bucket,
        prefix: values.prefix,
        addressingStyle: values.addressingStyle,
        signatureVersion: values.signatureVersion,
      },
      detectWrite: !readOnly.input.checked,
    };
  };

  const runTest = async (button, detectWrite) => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Testing…";
    probeOutput.textContent = "Contacting endpoint…";
    try {
      const payload = draftForProbe();
      payload.detectWrite = detectWrite;
      const result = await api.testConnection(payload);
      probeOutput.textContent = "";
      probeOutput.append(renderProbeResult(result));
      if (result.capabilities?.canList) {
        toastOk(
          `Connection works. ${describeCapabilities(result.capabilities).summary}`,
          "Test passed",
        );
      }
    } catch (error) {
      probeOutput.textContent = "";
      probeOutput.append(
        el("div", { style: { color: "var(--danger)" }, text: `✗ ${error.message}` }),
        error.hints?.length
          ? el("ul", { class: "detail-list" }, error.hints.map((hint) => el("li", { text: hint })))
          : null,
      );
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };

  const testButton = el("button", {
    class: "btn",
    text: "Test connection",
    "data-testid": "conn-test",
    onClick: (event) => runTest(event.currentTarget, false),
  });
  const detectButton = el("button", {
    class: "btn",
    text: "Detect permissions",
    "data-testid": "conn-detect",
    onClick: (event) => runTest(event.currentTarget, true),
  });

  const saveButton = el("button", {
    class: "btn btn--primary",
    text: isEdit ? "Save changes" : "Create connection",
    "data-testid": "conn-save",
  });

  const body = [
    el("fieldset", { class: "fieldset" }, [
      el("legend", { text: "Identity" }),
      field("Connection name", nameInput, "Shown in the sidebar. Any label you like."),
      field("Bucket", bucketInput, "boto3: Bucket=…"),
      field("Endpoint URL", endpointInput, "boto3: endpoint_url=…", "field--wide"),
      field("Region", regionInput, "boto3: region_name=… (required by most S3-compatible endpoints)"),
      field("Prefix inside the bucket", prefixInput, "boto3: Prefix=… Matched literally; a trailing “/” is added for you.", "field--wide"),
    ]),
    el("fieldset", { class: "fieldset" }, [
      el("legend", { text: "Credentials" }),
      field("Access key ID", accessInput, "boto3: aws_access_key_id", "field--wide"),
      field(
        "Secret access key",
        el("div", { class: "field__row" }, [
          secretInput,
          el("label", { class: "field__hint", style: { whiteSpace: "nowrap" } }, [
            revealSecret,
            el("span", { text: " show" }),
          ]),
        ]),
        "Encrypted before it touches the disk. Leave empty when editing to keep the stored value.",
        "field--wide",
      ),
      field("Session token", tokenInput, "boto3: aws_session_token (only for temporary STS credentials)", "field--wide"),
      el("label", { class: "check" }, [
        clearToken,
        el("span", {}, ["Clear the stored session token"]),
      ]),
    ]),
    el("fieldset", { class: "fieldset" }, [
      el("legend", { text: "S3 behaviour" }),
      field("Addressing style", addressingSelect, "boto3: Config(s3={\"addressing_style\": …})"),
      field("Signature version", signatureSelect, "boto3: Config(signature_version=…)"),
    ]),
    el("fieldset", { class: "fieldset" }, [
      el("legend", { text: "Security" }),
      readOnly.node,
      confirmDelete.node,
      confirmOverwrite.node,
      detectPermissions.node,
    ]),
    el("section", {}, [
      el("div", { class: "sidebar__heading", style: { padding: "0 0 6px" } }, [
        el("span", { text: "Equivalent boto3 client" }),
      ]),
      el("div", { class: "field__hint", style: { marginBottom: "6px" }, text: "Copy these settings straight from working Python — they map one to one." }),
      snippet,
    ]),
    el("section", { "data-testid": "probe-section" }, [
      el("div", { class: "field__row", style: { marginBottom: "6px" } }, [testButton, detectButton]),
      probeOutput,
    ]),
  ];

  const modal = openModal({
    title: isEdit ? `Edit “${connection.name}”` : "New connection",
    body,
    footer: [
      el("button", { class: "btn", text: "Cancel", onClick: () => modal.close() }),
      saveButton,
    ],
  });

  refreshSnippet();

  saveButton.addEventListener("click", async () => {
    const values = collect();
    const problem = validate(values, isEdit);
    if (problem) {
      toastError(problem, "Cannot save");
      return;
    }
    saveButton.disabled = true;
    try {
      const saved = await api.saveConnection(values);
      toastOk(`Connection “${saved.name}” saved.`, "Saved");
      modal.close();
      onSaved?.(saved);
    } catch (error) {
      toastError(error.message, "Cannot save");
    } finally {
      saveButton.disabled = false;
    }
  });

  return modal;
}

function validate(values, isEdit) {
  if (!values.name) return "Give the connection a name.";
  if (!values.endpointUrl) return "The endpoint URL is required.";
  if (!/^https?:\/\//.test(values.endpointUrl)) return "The endpoint URL must start with http:// or https://";
  if (!values.bucket) return "The bucket name is required.";
  if (values.bucket.includes("/")) return "The bucket name must not contain “/”. Put the path into the prefix field.";
  if (!values.accessKeyId) return "The access key ID is required.";
  if (!isEdit && !values.secretAccessKey) return "The secret access key is required.";
  if (!values.region) return "The region is required (use the value from your boto3 client).";
  return null;
}

export function describeCapabilities(capabilities) {
  if (!capabilities || !capabilities.probed) {
    return { level: "none", summary: "not probed", badge: "not probed", badgeClass: "badge--none" };
  }
  if (!capabilities.canList) {
    return { level: "none", summary: "cannot list", badge: "no access", badgeClass: "badge--none" };
  }
  if (capabilities.canWrite && capabilities.canDelete) {
    return { level: "rw", summary: "read & write", badge: "read-write", badgeClass: "badge--rw" };
  }
  if (capabilities.canWrite) {
    return { level: "rw", summary: "write, delete denied", badge: "write only", badgeClass: "badge--ro" };
  }
  return { level: "ro", summary: "read-only", badge: "read-only", badgeClass: "badge--ro" };
}

export function renderProbeResult(result) {
  const caps = result.capabilities ?? {};
  const info = describeCapabilities(caps);
  const rows = [
    el("div", { class: "badge-list" }, [
      el("span", { class: `badge ${caps.canList ? "badge--rw" : "badge--none"}`, text: caps.canList ? "✓ list" : "✗ list" }),
      el("span", { class: `badge ${caps.canRead ? "badge--rw" : "badge--none"}`, text: caps.canRead ? "✓ read" : "✗ read" }),
      el("span", { class: `badge ${caps.canWrite ? "badge--rw" : "badge--ro"}`, text: caps.canWrite ? "✓ write" : "✗ write" }),
      el("span", { class: `badge ${caps.canDelete ? "badge--rw" : "badge--ro"}`, text: caps.canDelete ? "✓ delete" : "✗ delete" }),
    ]),
    el("div", { class: "field__hint", text: `Result: ${info.summary}.` }),
  ];
  if (result.sampleKeys?.length) {
    rows.push(
      el("div", { class: "field__hint" }, [
        el("div", { text: `Sample of ${result.prefix || "the root"}:` }),
        el(
          "ul",
          { class: "detail-list" },
          result.sampleKeys.slice(0, 6).map((key) => el("li", { text: key })),
        ),
      ]),
    );
  }
  if (caps.details?.length) {
    rows.push(
      el(
        "ul",
        { class: "detail-list" },
        caps.details.map((detail) => el("li", { text: detail })),
      ),
    );
  }
  return el("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, rows);
}

/** Small confirmation helper reused by the delete/copy flows. */
export async function confirmDestructive({ title, message, details, confirmLabel }) {
  return confirmDialog({
    title,
    message,
    details,
    confirmLabel,
    danger: true,
  });
}

export { messageDialog };
