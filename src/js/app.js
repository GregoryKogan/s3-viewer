// Application controller: state, rendering and every user interaction.

import { el, clear, mount, $, copyText } from "./dom.js";
import { api, pickFiles, listen } from "./api.js";
import { toast, toastError, toastOk, toastWarn } from "./toast.js";
import { confirmDialog, promptDialog, messageDialog, openModal } from "./modal.js";
import { openConnectionForm, describeCapabilities } from "./connection-form.js";
import { openImportDialog } from "./import.js";
import { openSettingsDialog } from "./settings.js";
import { renderPreview } from "./preview.js";
import {
  humanSize,
  humanDate,
  kindIcon,
  kindLabel,
  debounce,
  fileName,
  prefixSegments,
} from "./format.js";

const state = {
  connections: [],
  settings: null,
  session: null, // { connection, prefix, entries, truncated }
  selected: new Set(),
  filter: "",
  sort: { key: "name", direction: "asc" },
  preview: null, // { key, loading, data, error, view }
  transferTimer: null,
  previewHidden: false,
  lastClickedIndex: null,
  capabilitiesDetected: new Set(),
};

// ------------------------------------------------------------------ bootstrap

async function boot() {
  wireGlobalHandlers();
  try {
    state.settings = await api.getSettings();
    applyTheme(state.settings.theme);
  } catch (error) {
    toastError(error.message, "Cannot read settings");
  }
  await refreshConnections();
  startTransferPolling();
  try {
    await api.ping();
  } catch {
    /* not fatal */
  }
}

function applyTheme(theme) {
  const resolved =
    theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved === "light" ? "light" : "dark");
}

async function refreshConnections() {
  try {
    state.connections = await api.listConnections();
  } catch (error) {
    toastError(error.message, "Cannot list connections");
    state.connections = [];
  }
  renderConnections();
}

// -------------------------------------------------------------- global wiring

function wireGlobalHandlers() {
  $("#new-connection").addEventListener("click", () => {
    openConnectionForm({ onSaved: async (connection) => {
      await refreshConnections();
      await openConnection(connection.id);
    } });
  });

  $("#open-settings").addEventListener("click", () =>
    openSettingsDialog({
      onSaved: async (settings) => {
        state.settings = settings;
        applyTheme(settings.theme);
        if (state.session) await reloadFolder();
      },
    }),
  );

  $("#refresh").addEventListener("click", () => reloadFolder());
  $("#toggle-preview").addEventListener("click", () => {
    const panel = $("#preview");
    // Flip whatever is on screen right now, then remember the choice.
    state.previewHidden = !panel.hidden;
    panel.hidden = state.previewHidden;
  });
  $("#preview-close").addEventListener("click", () => {
    $("#preview").hidden = true;
  });

  const filterInput = $("#filter");
  filterInput.addEventListener(
    "input",
    debounce(() => {
      state.filter = filterInput.value.trim().toLowerCase();
      renderObjects();
    }, 120),
  );

  for (const button of document.querySelectorAll("#toolbar [data-action]")) {
    button.addEventListener("click", () => handleToolbar(button.dataset.action));
  }

  for (const header of document.querySelectorAll(".table-head .sortable")) {
    header.addEventListener("click", () => {
      const key = header.dataset.sort;
      if (state.sort.key === key) {
        state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
      } else {
        state.sort = { key, direction: key === "name" ? "asc" : "desc" };
      }
      renderObjects();
    });
  }

  $("#select-all").addEventListener("change", (event) => {
    const visible = visibleEntries();
    state.selected.clear();
    if (event.target.checked) for (const entry of visible) state.selected.add(entry.key);
    renderObjects();
    updateToolbar();
  });

  document.addEventListener("keydown", onKeyDown);
  wireDragAndDrop();
}

function onKeyDown(event) {
  const tag = event.target?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  const meta = event.metaKey || event.ctrlKey;

  if (meta && event.key.toLowerCase() === "r") {
    event.preventDefault();
    reloadFolder();
    return;
  }
  if (meta && event.key.toLowerCase() === "u" && state.session) {
    event.preventDefault();
    uploadFiles();
    return;
  }
  if (meta && event.key.toLowerCase() === "n") {
    event.preventDefault();
    $("#new-connection").click();
    return;
  }
  if (typing) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!state.session) return;
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
    return;
  }
  if (event.key === "Enter" && state.selected.size === 1) {
    event.preventDefault();
    const key = [...state.selected][0];
    const entry = state.session?.entries.find((item) => item.key === key);
    if (entry) activateEntry(entry);
    return;
  }
  if ((event.key === "Backspace" || event.key === "ArrowLeft") && state.session) {
    if (state.session.prefix) {
      event.preventDefault();
      navigateUp();
    }
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.selected.size) {
    event.preventDefault();
    deleteSelection();
  }
  if (event.key === "Escape") {
    state.selected.clear();
    renderObjects();
    updateToolbar();
  }
}

function wireDragAndDrop() {
  const dropzone = $("#dropzone");
  const main = $(".main");
  const show = () => dropzone.classList.add("dropzone--active");
  const hide = () => dropzone.classList.remove("dropzone--active");

  main.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (state.session) show();
  });
  main.addEventListener("dragleave", (event) => {
    if (event.target === main) hide();
  });
  main.addEventListener("drop", (event) => {
    event.preventDefault();
    hide();
  });

  listen("tauri://drag-enter", () => state.session && show()).catch(() => {});
  listen("tauri://drag-leave", hide).catch(() => {});
  listen("tauri://drag-drop", async (event) => {
    hide();
    const paths = event?.payload?.paths ?? [];
    if (paths.length && state.session) await uploadPaths(paths);
  }).catch(() => {});
}

// ---------------------------------------------------------------- connections

function renderConnections() {
  const list = $("#connection-list");
  clear(list);

  if (!state.connections.length) {
    list.append(
      el("div", { class: "empty-hint", "data-testid": "connections-empty" }, [
        el("p", { text: "No connections yet." }),
        el("p", {
          text: "Add one with “+ New”, or import existing credentials with “Import”.",
        }),
        el("button", {
          class: "btn btn--block",
          text: "Import from JSON",
          "data-testid": "import-connections",
          onClick: () => openImportDialog({ onImported: afterImport }),
        }),
      ]),
    );
    return;
  }

  for (const view of state.connections) {
    const connection = view.connection;
    const info = describeCapabilities(view.capabilities);
    const active = state.session?.connection?.id === connection.id;
    const card = el(
      "button",
      {
        class: "connection-card",
        type: "button",
        "aria-selected": active ? "true" : "false",
        "data-testid": `connection-${connection.id}`,
        onClick: () => openConnection(connection.id),
        onContextmenu: (event) => {
          event.preventDefault();
          openConnectionMenu(connection, event);
        },
      },
      [
        el("div", { class: "connection-card__top" }, [
          el("span", { class: "connection-card__name", text: connection.name }),
          el("span", { class: "badge", text: connection.bucket.slice(0, 10) + (connection.bucket.length > 10 ? "…" : "") }),
        ]),
        el("div", {
          class: "connection-card__path",
          text: connection.prefix || "/",
          title: `s3://${connection.bucket}/${connection.prefix}`,
        }),
        el("div", { class: "connection-card__badges" }, [
          el("span", { class: `badge ${info.badgeClass}`, text: info.badge }),
          connection.signatureVersion !== "s3v4"
            ? el("span", { class: "badge badge--v2", text: connection.signatureVersion })
            : null,
          connection.security?.readOnlyMode
            ? el("span", { class: "badge badge--ro-mode", text: "read-only mode" })
            : null,
        ]),
      ],
    );
    list.append(card);
  }

  list.append(
    el("button", {
      class: "btn btn--ghost btn--block",
      text: "Import from JSON…",
      "data-testid": "import-connections",
      style: { marginTop: "6px" },
      onClick: () => openImportDialog({ onImported: afterImport }),
    }),
  );
}

async function afterImport() {
  await refreshConnections();
  const first = state.connections[0];
  if (first) await openConnection(first.connection.id);
}

function openConnectionMenu(connection, event) {
  const modal = messageDialog({
    title: connection.name,
    body: [
      el("div", { class: "field__hint" }, [
        el("div", { text: `Endpoint: ${connection.endpointUrl}` }),
        el("div", { text: `Region: ${connection.region}` }),
        el("div", { text: `Bucket: ${connection.bucket}` }),
        el("div", { text: `Prefix: ${connection.prefix || "/"}` }),
        el("div", { text: `Signature: ${connection.signatureVersion}` }),
        el("div", { text: `Access key: ${connection.accessKeyId}` }),
      ]),
    ],
    footer: [
      el("button", {
        class: "btn",
        text: "Detect permissions",
        onClick: async () => {
          modal.close();
          await detectCapabilities(connection.id, { announce: true });
        },
      }),
      el("button", {
        class: "btn",
        text: "Duplicate",
        onClick: async () => {
          modal.close();
          await api.duplicateConnection(connection.id);
          await refreshConnections();
          toastOk("Connection duplicated.", "Duplicated");
        },
      }),
      el("button", {
        class: "btn",
        text: "Edit",
        onClick: () => {
          modal.close();
          openConnectionForm({
            connection,
            onSaved: async (saved) => {
              await refreshConnections();
              // The open session holds a snapshot; refresh it in place so the
              // new prefix and security switches take effect immediately.
              if (state.session?.connection.id === saved.id) {
                state.session.connection = saved;
                state.session.prefix = saved.prefix ?? "";
                renderBreadcrumb();
                await reloadFolder({ silent: true });
                updateToolbar();
              }
            },
          });
        },
      }),
      el("button", {
        class: "btn btn--danger",
        text: "Delete",
        onClick: async () => {
          modal.close();
          const ok = await confirmDialog({
            title: "Delete connection",
            message: `Delete the saved connection “${connection.name}”?`,
            details: ["The stored secret for this connection is erased as well.", "Objects in the bucket are not touched."],
            confirmLabel: "Delete connection",
            danger: true,
          });
          if (!ok) return;
          await api.deleteConnection(connection.id);
          if (state.session?.connection?.id === connection.id) {
            state.session = null;
            renderBreadcrumb();
            renderObjects();
            updateToolbar();
          }
          await refreshConnections();
          toastOk("Connection deleted.");
        },
      }),
    ],
  });
}

async function detectCapabilities(connectionId, { announce = false } = {}) {
  try {
    const capabilities = await api.detectCapabilities(connectionId);
    state.capabilitiesDetected.add(connectionId);
    await refreshConnections();
    if (announce) {
      const info = describeCapabilities(capabilities);
      toast({
        level: capabilities.canList ? "ok" : "warn",
        title: "Permission probe",
        message: `${info.summary}.${capabilities.details?.length ? ` ${capabilities.details.join(" ")}` : ""}`,
      });
    }
    return capabilities;
  } catch (error) {
    if (announce) toastError(error.message, "Permission probe failed");
    return null;
  }
}

// -------------------------------------------------------------- object browser

async function openConnection(id) {
  const view = state.connections.find((item) => item.connection.id === id);
  if (!view) return;
  state.session = {
    connection: view.connection,
    prefix: view.connection.prefix ?? "",
    entries: [],
    truncated: false,
    loading: true,
  };
  state.selected.clear();
  state.filter = "";
  $("#filter").value = "";
  state.preview = null;
  renderConnections();
  renderBreadcrumb();
  renderObjects();
  updateToolbar();
  renderPreviewPanel();

  if (
    view.connection.security?.detectPermissions &&
    !view.capabilities?.probed &&
    !state.capabilitiesDetected.has(id)
  ) {
    detectCapabilities(id).then(() => reloadFolder({ silent: true }));
  }

  await reloadFolder();
  await maybeProbeOnConnect(view);
}

/** Runs the permission probe once per connection per session. */
async function maybeProbeOnConnect(view) {
  const connection = view.connection;
  if (!connection.security?.detectPermissions) return;
  if (connection.security?.autoProbeOnConnect === false) return;
  if (view.capabilities?.probed) return;
  if (state.capabilitiesDetected.has(connection.id)) return;
  state.capabilitiesDetected.add(connection.id);
  await detectCapabilities(connection.id);
}

async function reloadFolder({ silent = false } = {}) {
  if (!state.session) return;
  const connectionId = state.session.connection.id;
  const prefix = state.session.prefix;
  if (!silent) {
    state.session.loading = true;
    renderObjects();
  }
  try {
    const result = await api.listObjects({ connectionId, prefix });
    if (typeof result?.entries === "string" || !Array.isArray(result?.entries)) {
      // Defensive: never let a malformed payload become a character array.
      throw new Error(
        `list_objects returned ${typeof result?.entries} instead of an array (keys: ${
          result && typeof result === "object" ? Object.keys(result).join(",") : typeof result
        })`,
      );
    }
    // A slow request may resolve after the user navigated elsewhere.
    if (state.session?.connection.id !== connectionId || state.session.prefix !== prefix) return;
    state.session.entries = result.entries;
    state.session.truncated = result.truncated;
    state.session.warning = result.warning;
    state.session.loading = false;
    state.selected.clear();
    renderBreadcrumb();
    renderObjects();
    updateToolbar();
  } catch (error) {
    state.session.loading = false;
    renderObjects();
    toastError(error.message, "Cannot list this folder");
  }
}

async function navigateTo(prefix) {
  if (!state.session) return;
  state.session.prefix = prefix;
  state.selected.clear();
  state.preview = null;
  renderBreadcrumb();
  renderPreviewPanel();
  await reloadFolder();
}

function navigateUp() {
  if (!state.session?.prefix) return;
  const segments = state.session.prefix.replace(/\/$/, "").split("/");
  segments.pop();
  const parent = segments.length ? `${segments.join("/")}/` : "";
  navigateTo(parent);
}

function visibleEntries() {
  if (!state.session) return [];
  const filter = state.filter;
  const entries = filter
    ? state.session.entries.filter((entry) => entry.name.toLowerCase().includes(filter))
    : state.session.entries.slice();
  const { key, direction } = state.sort;
  const factor = direction === "asc" ? 1 : -1;
  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    switch (key) {
      case "size":
        return (a.size - b.size) * factor;
      case "modified":
        return (String(a.lastModified ?? "").localeCompare(String(b.lastModified ?? ""))) * factor;
      case "kind":
        return a.kind.localeCompare(b.kind) * factor;
      default:
        return a.name.localeCompare(b.name, undefined, { numeric: true }) * factor;
    }
  });
  return entries;
}

function renderBreadcrumb() {
  const nav = $("#breadcrumb");
  clear(nav);
  if (!state.session) {
    nav.append(el("span", { class: "crumb crumb--current", text: "No connection selected" }));
    return;
  }
  const { connection, prefix } = state.session;
  // "Root" means the root *of this connection*, not of the bucket: a connection
  // is scoped to its prefix, and leaving that scope would list objects the
  // connection was not set up for.
  const root = connection.prefix ?? "";
  nav.append(
    el("button", {
      class: `crumb ${prefix === root ? "crumb--current" : ""}`,
      text: connection.bucket,
      title: `s3://${connection.bucket}/${root}`,
      "data-testid": "crumb-root",
      onClick: () => navigateTo(root),
    }),
  );
  if (root && !prefix.startsWith(root)) {
    nav.append(el("span", { class: "crumb__sep", text: "/" }));
    nav.append(
      el("button", {
        class: "crumb",
        text: `…${prefix}`,
        title: prefix,
        onClick: () => navigateTo(prefix),
      }),
    );
  }
  const relative = prefix.startsWith(root) ? prefix.slice(root.length) : prefix;
  const segments = prefixSegments(relative);
  for (const [index, segment] of segments.entries()) {
    nav.append(el("span", { class: "crumb__sep", text: "/" }));
    const isLast = index === segments.length - 1;
    nav.append(
      el("button", {
        class: `crumb ${isLast ? "crumb--current" : ""}`,
        text: segment.name,
        title: `${root}${segment.prefix}`,
        onClick: () => navigateTo(`${root}${segment.prefix}`),
      }),
    );
  }
}

function renderObjects() {
  const list = $("#object-list");
  clear(list);

  if (!state.session) {
    list.append(
      el("div", { class: "empty-state", "data-testid": "no-connection-state" }, [
        el("p", { text: "Pick a connection on the left, or create a new one." }),
        el("p", {
          class: "muted",
          text: "Each connection pins one bucket and one prefix; add several to move between projects quickly.",
        }),
      ]),
    );
    return;
  }
  if (state.session.loading && !state.session.entries.length) {
    list.append(el("div", { class: "empty-state", text: "Loading…", "data-testid": "loading-state" }));
    return;
  }

  const entries = visibleEntries();
  if (!entries.length) {
    list.append(
      el("div", {
        class: "empty-state",
        "data-testid": "empty-folder",
        text: state.filter ? "Nothing matches the filter." : "This folder is empty.",
      }),
    );
    return;
  }

  for (const entry of entries) {
    list.append(renderRow(entry, entries));
  }
  syncSelectAll(entries);
}

function renderRow(entry, entries) {
  const checkbox = el("input", {
    type: "checkbox",
    checked: state.selected.has(entry.key),
    "data-testid": `row-check-${entry.name}`,
    onClick: (event) => {
      event.stopPropagation();
      toggleSelection(entry.key, event.shiftKey, entries);
      renderObjects();
      updateToolbar();
    },
  });

  const row = el(
    "div",
    {
      class: `object-row ${entry.isFolder ? "object-row--folder" : ""}`,
      role: "option",
      "aria-selected": state.selected.has(entry.key) ? "true" : "false",
      "data-testid": `row-${entry.name}`,
      "data-key": entry.key,
      "data-kind": entry.kind,
      onClick: (event) => {
        toggleSelection(entry.key, event.shiftKey, entries, { single: true });
        renderObjects();
        updateToolbar();
        previewEntry(entry);
      },
      onDblclick: () => activateEntry(entry),
    },
    [
      el("label", { class: "cell cell--check" }, [checkbox]),
      el("div", { class: "cell cell--name" }, [
        el("div", { class: "row-name" }, [
          el("span", { class: "row-icon", text: kindIcon(entry.kind, entry.isFolder) }),
          el("span", { class: "row-label", text: entry.name, title: entry.key }),
        ]),
      ]),
      el("div", { class: "cell cell--size", text: entry.isFolder ? "—" : humanSize(entry.size) }),
      el("div", { class: "cell cell--modified", text: humanDate(entry.lastModified), title: entry.lastModified ?? "" }),
      el("div", { class: "cell cell--kind", text: kindLabel(entry.kind) }),
    ],
  );
  return row;
}

function syncSelectAll(entries) {
  const box = $("#select-all");
  const all = entries.length > 0 && entries.every((entry) => state.selected.has(entry.key));
  box.checked = all;
  box.indeterminate = !all && entries.some((entry) => state.selected.has(entry.key));
}

function toggleSelection(key, shiftKey, entries, { single = false } = {}) {
  if (shiftKey && state.lastClickedIndex !== null) {
    const currentIndex = entries.findIndex((entry) => entry.key === key);
    if (currentIndex !== -1) {
      const [from, to] = [state.lastClickedIndex, currentIndex].sort((a, b) => a - b);
      for (let index = from; index <= to; index += 1) state.selected.add(entries[index].key);
      state.lastClickedIndex = currentIndex;
      return;
    }
  }
  if (single) {
    state.selected.clear();
    state.selected.add(key);
  } else if (state.selected.has(key)) {
    state.selected.delete(key);
  } else {
    state.selected.add(key);
  }
  state.lastClickedIndex = entries.findIndex((entry) => entry.key === key);
}

function moveSelection(delta, extend) {
  const entries = visibleEntries();
  if (!entries.length) return;
  const keys = [...state.selected];
  const currentKey = keys.length ? keys[keys.length - 1] : null;
  const index = currentKey ? entries.findIndex((entry) => entry.key === currentKey) : -1;
  const next = Math.min(entries.length - 1, Math.max(0, index + delta));
  const entry = entries[next === -1 ? 0 : next];
  if (!extend) state.selected.clear();
  state.selected.add(entry.key);
  state.lastClickedIndex = next;
  renderObjects();
  updateToolbar();
  previewEntry(entry);
  document.querySelector(`[data-key="${CSS.escape(entry.key)}"]`)?.scrollIntoView({ block: "nearest" });
}

function activateEntry(entry) {
  if (entry.isFolder) navigateTo(entry.key);
  else previewEntry(entry, { force: true });
}

function updateToolbar() {
  const hasSession = Boolean(state.session);
  const count = state.selected.size;
  const connection = state.session?.connection;
  const info = describeCapabilities(state.connections.find((v) => v.connection.id === connection?.id)?.capabilities);
  const canWrite = hasSession && info.level !== "ro" && !connection?.security?.readOnlyMode;

  for (const action of ["upload", "new-folder", "new-file"]) {
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !hasSession || !canWrite;
  }
  for (const action of ["delete", "copy", "move"]) {
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !hasSession || count === 0 || (action !== "download" && !canWrite);
  }
  const download = document.querySelector('[data-action="download"]');
  if (download) download.disabled = !hasSession || count === 0;

  const status = $("#folder-status");
  if (!state.session) {
    status.textContent = "";
  } else {
    const files = state.session.entries.filter((entry) => !entry.isFolder).length;
    const folders = state.session.entries.length - files;
    const bytes = state.session.entries.reduce((sum, entry) => sum + (entry.isFolder ? 0 : entry.size), 0);
    status.textContent = `${folders} folder(s), ${files} file(s), ${humanSize(bytes)}${
      state.session.truncated ? " (truncated)" : ""
    }${count ? ` · ${count} selected` : ""}`;
  }

  const previewDownload = $("#preview-download");
  if (previewDownload) previewDownload.disabled = !state.preview?.key;
}

// -------------------------------------------------------------------- preview

async function previewEntry(entry, { force = false } = {}) {
  if (entry.isFolder) {
    // Folders can still be "selected"; the preview explains why it is empty.
    state.preview = { key: entry.key, entry, loading: false, data: null, error: null, unavailable: "This is a folder." };
    renderPreviewPanel();
    return;
  }
  if (!force && state.preview?.key === entry.key) return;
  // Re-opening the same object keeps the view the user last chose for it.
  const view = state.preview?.key === entry.key ? state.preview.view : undefined;
  state.preview = { key: entry.key, entry, loading: true, data: null, error: null, view };
  renderPreviewPanel();
  try {
    const data = await api.getPreview({ connectionId: state.session.connection.id, key: entry.key });
    if (state.preview?.key !== entry.key) return;
    state.preview = { key: entry.key, entry, loading: false, data, error: null, view };
  } catch (error) {
    if (state.preview?.key !== entry.key) return;
    state.preview = { key: entry.key, entry, loading: false, data: null, error, view };
  }
  renderPreviewPanel();
}

function renderPreviewPanel({ reveal = true } = {}) {
  // Selecting an object reveals the panel again unless the user hid it; a pure
  // re-render (the Markdown raw/rendered toggle) must not.
  if (reveal && !state.previewHidden) $("#preview").hidden = false;
  const nameNode = $("#preview-name");
  const metaNode = $("#preview-meta");
  const body = $("#preview-body");
  clear(body);

  const preview = state.preview;
  if (!preview) {
    nameNode.textContent = "No selection";
    metaNode.textContent = "";
    $("#preview-download").disabled = true;
    body.append(
      el("div", { class: "preview-message" }, [
        el("p", { text: "Select a file to preview it here." }),
        el("p", {
          class: "muted",
          text: "Images, audio, video and PDFs render inline. Text, Markdown and code open with syntax highlighting.",
        }),
      ]),
    );
    return;
  }

  const entry = preview.entry;
  nameNode.textContent = entry?.name ?? fileName(preview.key);
  nameNode.title = preview.key;
  $("#preview-download").disabled = Boolean(entry?.isFolder);
  metaNode.textContent = entry
    ? `${humanSize(entry.size)} · ${humanDate(entry.lastModified)} · ${kindLabel(entry.kind)}`
    : "";

  if (preview.loading) {
    body.append(el("div", { class: "preview-message", text: "Loading preview…", "data-testid": "preview-loading" }));
    return;
  }
  if (preview.error) {
    body.append(
      el("div", { class: "preview-message", "data-testid": "preview-error" }, [
        el("h3", { text: "Preview unavailable" }),
        el("p", { text: preview.error.message }),
        preview.error.code ? el("p", { class: "muted", text: `S3 error: ${preview.error.code}` }) : null,
        preview.error.hints?.length
          ? el("ul", {}, preview.error.hints.map((hint) => el("li", { text: hint })))
          : null,
      ]),
    );
    return;
  }
  if (preview.unavailable) {
    body.append(
      el("div", { class: "preview-message", "data-testid": "preview-unavailable" }, [
        el("h3", { text: "Nothing to preview" }),
        el("p", { text: preview.unavailable }),
      ]),
    );
    return;
  }
  if (!preview.data) {
    body.append(el("div", { class: "preview-message", text: "No preview data." }));
    return;
  }

  const node = renderPreview(preview.data, {
    onDownload: () => downloadSelection(),
    onSaveText: async (text) => {
      try {
        await api.saveTextObject({
          connectionId: state.session.connection.id,
          key: preview.key,
          content: text,
        });
        toastOk("Object saved.", "Saved");
        await reloadFolder({ silent: true });
      } catch (error) {
        toastError(error.message, "Cannot save");
      }
    },
    onToggleView: (view) => {
      state.preview.view = view;
      renderPreviewPanel({ reveal: false });
    },
    view: preview.view,
  });
  body.append(node);
}

// ------------------------------------------------------------------- toolbar

function handleToolbar(action) {
  switch (action) {
    case "upload":
      uploadFiles();
      break;
    case "new-folder":
      createFolder();
      break;
    case "new-file":
      createFile();
      break;
    case "download":
      downloadSelection();
      break;
    case "delete":
      deleteSelection();
      break;
    case "copy":
      transferSelection(false);
      break;
    case "move":
      transferSelection(true);
      break;
    default:
      break;
  }
}

async function uploadFiles() {
  if (!state.session) return;
  try {
    const paths = await pickFiles({ multiple: true });
    if (!paths.length) return;
    await uploadPaths(paths);
  } catch (error) {
    toastError(error.message, "Cannot upload");
  }
}

async function uploadPaths(paths) {
  if (!state.session) return;
  const connection = state.session.connection;
  if (connection.security?.readOnlyMode) {
    toastWarn("This connection is in read-only mode.", "Upload blocked");
    return;
  }
  try {
    const plan = await api.uploadFiles({
      connectionId: connection.id,
      prefix: state.session.prefix,
      localPaths: paths,
      overwrite: false,
    });
    toast({
      level: "info",
      title: "Upload started",
      message: `${plan.length} file(s) → ${state.session.prefix || "/"}`,
    });
  } catch (error) {
    toastError(error.message, "Cannot upload");
  }
}

async function createFolder() {
  if (!state.session) return;
  const name = await promptDialog({
    title: "New folder",
    label: "Folder name",
    confirmLabel: "Create folder",
    hint: "S3 has no real folders — this creates a zero-byte marker key ending in “/”.",
    validate: (value) => (value.includes("/") ? "The name must not contain “/”." : null),
  });
  if (!name) return;
  try {
    await api.createFolder({
      connectionId: state.session.connection.id,
      prefix: state.session.prefix,
      name,
    });
    toastOk(`Folder “${name}” created.`);
    await reloadFolder({ silent: true });
  } catch (error) {
    toastError(error.message, "Cannot create folder");
  }
}

async function createFile() {
  if (!state.session) return;
  const name = await promptDialog({
    title: "New file",
    label: "File name",
    confirmLabel: "Create file",
    hint: "An empty object is created. The extension decides how it is previewed.",
  });
  if (!name) return;
  try {
    await api.createFile({
      connectionId: state.session.connection.id,
      prefix: state.session.prefix,
      name,
      content: "",
    });
    toastOk(`File “${name}” created.`);
    await reloadFolder({ silent: true });
  } catch (error) {
    toastError(error.message, "Cannot create file");
  }
}

function selectedEntries() {
  if (!state.session) return [];
  return state.session.entries.filter((entry) => state.selected.has(entry.key));
}

async function deleteSelection() {
  if (!state.session || !state.selected.size) return;
  const entries = selectedEntries();
  const connection = state.session.connection;
  const folders = entries.filter((entry) => entry.isFolder);
  const files = entries.filter((entry) => !entry.isFolder);

  const details = [];
  if (folders.length) {
    details.push(
      `${folders.length} folder(s) will be deleted recursively, including everything inside them:`,
      ...folders.slice(0, 5).map((entry) => `  ${entry.key}`),
    );
  }
  if (files.length) {
    details.push(
      `${files.length} file(s), ${humanSize(files.reduce((sum, entry) => sum + entry.size, 0))}:`,
      ...files.slice(0, 5).map((entry) => `  ${entry.key}`),
    );
  }
  details.push("This cannot be undone.");

  if (connection.security?.confirmDelete ?? true) {
    const ok = await confirmDialog({
      title: "Delete objects",
      message: `Permanently delete ${entries.length} selected item(s) from “${connection.name}”?`,
      details,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
  }

  try {
    const result = await api.deleteObjects({
      connectionId: connection.id,
      keys: entries.map((entry) => entry.key),
    });
    toast({
      level: "info",
      title: "Deleting",
      message: `${result.deleted} object(s) queued for removal.`,
    });
    state.selected.clear();
    pollTransfers();
    const outcome = await waitForTransfer(result.id);
    pollTransfers();
    if (outcome.state === "failed") {
      toastError(outcome.error ?? "the delete failed", "Delete failed");
    } else {
      toastOk(`${result.deleted} object(s) deleted.`);
    }
    await reloadFolder({ silent: true });
  } catch (error) {
    toastError(error.message, "Cannot delete");
  }
}

async function transferSelection(isMove) {
  if (!state.session || !state.selected.size) return;
  const entries = selectedEntries();
  const connections = state.connections.map((view) => view.connection);

  const destinationSelect = el(
    "select",
    { "data-testid": "transfer-destination" },
    connections.map((connection) =>
      el("option", {
        value: connection.id,
        text: `${connection.name} — ${connection.bucket}/${connection.prefix}`,
        selected: connection.id === state.session.connection.id,
      }),
    ),
  );
  const prefixInput = el("input", {
    type: "text",
    value: state.session.prefix,
    placeholder: "target/prefix/",
    "data-testid": "transfer-prefix",
  });

  const modal = openModal({
    title: isMove ? "Move objects" : "Copy objects",
    body: [
      el("p", {
        text: `${entries.length} item(s) from ${state.session.connection.bucket}/${state.session.prefix || "/"}`,
      }),
      el("div", { class: "field" }, [el("label", { text: "Destination connection" }), destinationSelect]),
      el("div", { class: "field" }, [
        el("label", { text: "Destination prefix" }),
        prefixInput,
        el("div", { class: "field__hint", text: "Files keep their names; folders keep their names too." }),
      ]),
    ],
    footer: [
      el("button", { class: "btn", text: "Cancel", onClick: () => modal.close() }),
      el("button", {
        class: "btn btn--primary",
        text: isMove ? "Move" : "Copy",
        "data-testid": "transfer-confirm",
        onClick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            const result = await api.copyObjects({
              sourceConnectionId: state.session.connection.id,
              destConnectionId: destinationSelect.value,
              keys: entries.map((entry) => entry.key),
              destPrefix: prefixInput.value,
              moveObjects: isMove,
            });
            modal.close();
            toast({
              level: "info",
              title: isMove ? "Moving" : "Copying",
              message: `${result.copied} object(s).`,
            });
            pollTransfers();
            const outcome = await waitForTransfer(result.id ?? "");
            pollTransfers();
            if (outcome.state === "failed") {
              toastError(outcome.error ?? "the operation failed", isMove ? "Move failed" : "Copy failed");
            }
            await reloadFolder({ silent: true });
          } catch (error) {
            toastError(error.message, isMove ? "Cannot move" : "Cannot copy");
            event.currentTarget.disabled = false;
          }
        },
      }),
    ],
  });
}

function downloadSelection() {
  if (!state.session) return;
  const entries = selectedEntries();
  const targets = entries.length
    ? entries.filter((entry) => !entry.isFolder)
    : state.preview?.key
      ? [{ key: state.preview.key }]
      : [];
  if (!targets.length) {
    toastWarn("Folders cannot be downloaded directly. Open the folder and select its files.", "Nothing to download");
    return;
  }
  for (const entry of targets) {
    api
      .downloadObject({ connectionId: state.session.connection.id, key: entry.key })
      .then(() => pollTransfers())
      .catch((error) => toastError(error.message, "Download failed"));
  }
}

/**
 * Wait for a specific queued transfer to settle.
 * Downloads, deletes and copies are all run in the background; the UI must know
 * when they are actually finished before it reloads the listing.
 */
async function waitForTransfer(id, { timeout = 120_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const items = await api.transferProgress().catch(() => []);
    const item = items.find((entry) => entry.id === id);
    if (item && item.state !== "running") return item;
    if (Date.now() > deadline) {
      return { id, state: "failed", error: "timed out waiting for the transfer" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ------------------------------------------------------------------ transfers

function startTransferPolling() {
  pollTransfers();
  state.transferTimer = setInterval(pollTransfers, 700);
}

async function pollTransfers() {
  let items = [];
  try {
    items = await api.transferProgress();
  } catch {
    return;
  }
  const container = $("#transfers");
  const running = items.filter((item) => item.state === "running");
  const recent = items.filter((item) => item.state !== "running");
  const visible = [...running, ...recent.slice(-4)];

  if (!visible.length) {
    container.hidden = true;
    clear(container);
    return;
  }
  container.hidden = false;
  clear(container);
  container.append(
    el("div", { class: "transfers__title" }, [
      el("span", { text: running.length ? `Transfers (${running.length})` : "Transfers" }),
      el("button", {
        class: "btn btn--ghost btn--sm",
        text: "Clear",
        onClick: async () => {
          container.hidden = true;
          clear(container);
          await api.clearTransfers().catch(() => {});
        },
      }),
    ]),
  );

  for (const item of visible) {
    const percent = item.total ? Math.min(100, Math.round((item.done / item.total) * 100)) : null;
    container.append(
      el("div", { class: "transfer", "data-testid": `transfer-${item.state}` }, [
        el("div", { class: "transfer__label" }, [
          el("span", { text: item.label, title: item.label }),
          el("span", {
            class: "muted",
            text:
              item.state === "done"
                ? "done"
                : item.state === "failed"
                  ? "failed"
                  : percent !== null
                    ? `${percent}%`
                    : "working",
          }),
        ]),
        el("div", { class: "bar" }, [
          el("div", {
            class: `bar__fill ${
              item.state === "done"
                ? "bar__fill--done"
                : item.state === "failed"
                  ? "bar__fill--failed"
                  : percent === null
                    ? "bar__fill--indeterminate"
                    : ""
            }`,
            style: { width: percent === null ? "100%" : `${percent}%` },
          }),
        ]),
        item.error ? el("div", { class: "transfer__error", text: item.error }) : null,
        item.state === "done" && item.resultPath
          ? el("div", { class: "transfer__done" }, [
              el("span", { text: `→ ${item.resultPath}` }),
              el("button", {
                class: "btn btn--ghost btn--sm",
                text: "Open",
                onClick: () => api.openPath(item.resultPath).catch(() => {}),
              }),
              el("button", {
                class: "btn btn--ghost btn--sm",
                text: "Reveal",
                onClick: () => api.revealInFileManager(item.resultPath).catch(() => {}),
              }),
            ])
          : null,
      ]),
    );
  }

  if (!running.length && items.some((item) => item.state === "done")) {
    // Refresh the listing once transfers settle so new objects appear.
    if (state.session && !state.refreshedAfterTransfer) {
      state.refreshedAfterTransfer = true;
      setTimeout(() => {
        state.refreshedAfterTransfer = false;
        reloadFolder({ silent: true });
      }, 400);
    }
  }
}

boot().finally(() => {
  // Signals to the end-to-end harness (and to console users) that the shell is
  // interactive: the harness must not inject its scenario any earlier.
  window.__s3viewerReady = true;
});

// Expose a tiny surface for the e2e suite and manual debugging in the console.
window.__s3viewerRenderPreview = renderPreview;

/**
 * Renders a hostile Markdown document and reports what survived sanitisation.
 * Used by the e2e scenario; harmless in normal operation.
 */
window.__s3viewerSanitizeProbe = () => {
  const executed = { script: false, handler: false };
  window.__markdownProbeExecuted = () => {
    executed.script = true;
  };
  const data = {
    kind: "markdown",
    key: "probe.md",
    size: 128,
    contentType: "text/markdown",
    streamUrl: "s3stream://localhost/probe/probe.md",
    truncated: false,
    text: [
      "# heading kept",
      "<script>window.__markdownProbeExecuted()</script>",
      '<img src="x" onerror="window.__markdownProbeExecuted()">',
      "[link](javascript:window.__markdownProbeExecuted())",
      "**bold kept**",
    ].join("\n\n"),
  };
  const node = renderPreview(data, {
    onDownload() {},
    onSaveText() {},
    onToggleView() {},
    view: "rendered",
  });
  const host = document.createElement("div");
  host.append(node);
  document.body.append(host);
  // Give the image a chance to fire onerror before reading the result.
  const html = node.innerHTML;
  node.remove();
  return { html, executed };
};

window.__s3viewer = {
  state,
  /** Diagnostics used by the e2e suite; harmless otherwise. */
  describe: () => ({
    loading: Boolean(state.session?.loading),
    entries: state.session?.entries.length ?? -1,
    filter: JSON.stringify(state.filter),
    visible: visibleEntries().length,
    previewKey: state.preview?.key ?? null,
    selected: state.selected.size,
  }),
  refresh: () => reloadFolder(),
  select: (key) => {
    state.selected.clear();
    state.selected.add(key);
    const entry = state.session?.entries.find((item) => item.key === key);
    if (entry) previewEntry(entry, { force: true });
    renderObjects();
    updateToolbar();
  },
  openConnection,
  refreshConnections,
  copySnippet: () => copyText($("#boto3-snippet")?.textContent ?? ""),
};
