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
  /** Sidebar/preview geometry, persisted per user. */
  layout: { sidebar: 264, preview: 420, collapsed: false },
  /** Monotonic id so stale listing events can be ignored. */
  listingRequest: 0,
  /** Monotonic id so a stale preview response cannot overwrite a newer one. */
  previewRequest: 0,
  listing: null,
  visible: [],
  rowHeight: 30,
  rowPool: [],
};

/** s3:// URI for an object key, used by the copy actions. */
export function s3Uri(bucket, key) {
  return `s3://${bucket}/${key}`;
}

// ------------------------------------------------------------------ bootstrap

async function boot() {
  wireGlobalHandlers();
  try {
    state.settings = await api.getSettings();
    if (state.settings.layout) {
      state.layout = { ...state.layout, ...state.settings.layout };
    }
    applyTheme(state.settings.theme);
    applyLayoutAndRepaint();
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
        state.settings = { ...settings, layout: state.layout };
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
    applyLayoutAndRepaint();
  });
  $("#preview-close").addEventListener("click", () => {
    $("#preview").hidden = true;
    applyLayoutAndRepaint();
  });

  const filterInput = $("#filter");
  filterInput.addEventListener(
    "input",
    debounce(() => {
      state.filter = filterInput.value.trim().toLowerCase();
      state.rebuildList = true;
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
      state.rebuildList = true;
      renderObjects();
    });
  }

  $("#select-all").addEventListener("change", (event) => {
    const visible = visibleEntries();
    state.selected.clear();
    if (event.target.checked) for (const entry of visible) state.selected.add(entry.key);
    updateVisibleSelection();
    updateToolbar();
  });

  $("#preview-copy-uri").addEventListener("click", () => copyUriFor(state.preview?.key));

  $("#collapse-sidebar").addEventListener("click", () => toggleSidebar());
  wireResizer({
    handle: "#resizer-sidebar",
    cssVar: "--sidebar-width",
    min: 190,
    max: 520,
    get: () => state.layout.sidebar,
    set: (value) => {
      state.layout.sidebar = value;
      persistLayout();
    },
    direction: 1,
  });
  wireResizer({
    handle: "#resizer-preview",
    cssVar: "--preview-width",
    min: 260,
    max: () => Math.max(280, Math.round(window.innerWidth * 0.7)),
    get: () => state.layout.preview,
    set: (value) => {
      state.layout.preview = value;
      persistLayout();
    },
    direction: -1,
  });
  window.addEventListener("resize", () => {
    clampLayout();
    applyLayoutAndRepaint();
  });

  // Streamed listing events. Each page repaints only what is on screen.
  listen("listing://page", (event) => appendListingPage(event.payload)).catch(() => {});
  listen("listing://done", (event) => finishListing(event.payload)).catch(() => {});
  listen("listing://error", (event) => failListing(event.payload)).catch(() => {});

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
  if (meta && event.key.toLowerCase() === "b") {
    event.preventDefault();
    toggleSidebar();
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

// -------------------------------------------------------------------- layout

/** Apply the stored geometry. */
function applyLayout() {
  const root = document.documentElement;
  root.style.setProperty("--sidebar-width", `${state.layout.sidebar}px`);
  root.style.setProperty("--preview-width", `${state.layout.preview}px`);
  $("#sidebar").classList.toggle("sidebar--collapsed", state.layout.collapsed);
  $("#collapse-sidebar").textContent = state.layout.collapsed ? "›" : "‹";
  $("#collapse-sidebar").title = state.layout.collapsed ? "Expand the sidebar (⌘B)" : "Collapse the sidebar (⌘B)";
  const sidebarHandle = $("#resizer-sidebar");
  if (sidebarHandle) sidebarHandle.hidden = state.layout.collapsed;
  const previewHandle = $("#resizer-preview");
  if (previewHandle) previewHandle.hidden = $("#preview").hidden;
}

/** Apply the layout *and* repaint the list, for geometry changes. */
function applyLayoutAndRepaint() {
  applyLayout();
  paintRows(true);
}

/** Keep both panels usable however the window is sized. */
function clampLayout() {
  state.layout.sidebar = Math.min(Math.max(190, state.layout.sidebar), Math.min(520, Math.round(window.innerWidth * 0.5)));
  state.layout.preview = Math.min(
    Math.max(260, state.layout.preview),
    Math.max(280, Math.round(window.innerWidth * 0.7)),
  );
}

function toggleSidebar() {
  state.layout.collapsed = !state.layout.collapsed;
  persistLayout();
  applyLayoutAndRepaint();
}

let layoutSaveTimer = null;
function persistLayout() {
  // Debounced: dragging a handle must not write settings on every pixel.
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    const settings = { ...(state.settings ?? {}), layout: state.layout };
    state.settings = settings;
    api.updateSettings(settings).catch(() => {});
  }, 400);
}

/**
 * Make a panel resizable by dragging its handle.
 * @param {{handle: string, cssVar: string, min: number, max: number|Function,
 *          get: Function, set: Function, direction: 1|-1}} options
 */
function wireResizer({ handle, cssVar, min, max, get, set, direction }) {
  const node = $(handle);
  if (!node) return;
  let startX = 0;
  let startValue = 0;

  const onMove = (event) => {
    const limit = typeof max === "function" ? max() : max;
    const delta = (event.clientX - startX) * direction;
    const next = Math.min(Math.max(min, startValue + delta), limit);
    document.documentElement.style.setProperty(cssVar, `${next}px`);
    set(next);
    paintRows(true);
  };

  const onUp = () => {
    node.classList.remove("resizer--active");
    document.body.style.cursor = "";
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    persistLayout();
  };

  node.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    startX = event.clientX;
    startValue = get();
    node.classList.add("resizer--active");
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });

  // Keyboard access: the separator is focusable and responds to arrows.
  node.tabIndex = 0;
  node.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const limit = typeof max === "function" ? max() : max;
    const delta = (event.key === "ArrowRight" ? 1 : -1) * step * direction;
    const next = Math.min(Math.max(min, get() + delta), limit);
    document.documentElement.style.setProperty(cssVar, `${next}px`);
    set(next);
    paintRows(true);
  });

  node.addEventListener("dblclick", () => {
    const defaults = { "--sidebar-width": 264, "--preview-width": 420 };
    const value = defaults[cssVar] ?? get();
    document.documentElement.style.setProperty(cssVar, `${value}px`);
    set(value);
    paintRows(true);
  });
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
  // The preview is deliberately kept: a second click on the same connection must
  // not blank the panel for the object the user is looking at.
  state.rowSignature = null;
  state.rowPool = [];
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

/**
 * Load a folder.
 *
 * The listing streams: S3 pages arrive as events and are appended to the visible
 * list as they come, so a prefix with tens of thousands of keys shows its first
 * screen immediately instead of freezing the window until the last page lands.
 */
async function reloadFolder({ silent = false } = {}) {
  if (!state.session) return;
  const connectionId = state.session.connection.id;
  const prefix = state.session.prefix;
  const requestId = String(++state.listingRequest);
  state.listing = { requestId, connectionId, prefix, total: 0, done: false };
  // The new listing is staged and swapped in when it is complete. Appending
  // straight into the visible list meant a cancelled stream could leave the UI
  // showing a half-loaded folder forever.
  state.replaces = [];

  state.session.loading = true;
  state.session.awaitingFirstPage = true;
  state.session.error = null;
  state.selected.clear();
  renderObjects();
  updateToolbar();

  // A stream that never reports back must not pin the UI in "loading".
  const guard = setTimeout(() => {
    if (state.listing?.requestId === requestId && state.session?.loading) {
      state.session.loading = false;
      state.session.awaitingFirstPage = false;
      renderObjects();
      updateToolbar();
      toastWarn("The listing took too long to finish. Press ⟳ to try again.", "Listing stalled");
    }
  }, 120_000);

  try {
    await api.listObjectsStream({ connectionId, prefix, requestId });
  } catch (error) {
    if (state.listing?.requestId === requestId) {
      state.session.loading = false;
      state.session.awaitingFirstPage = false;
      renderObjects();
      toastError(error.message, "Cannot list this folder");
    }
  } finally {
    clearTimeout(guard);
  }
}

/** Accept one streamed page if it belongs to the folder on screen. */
function appendListingPage(payload) {
  const listing = state.listing;
  if (!listing || payload.requestId !== listing.requestId) return;
  if (
    !state.session ||
    state.session.connection.id !== listing.connectionId ||
    state.session.prefix !== listing.prefix
  ) {
    return;
  }
  if (Array.isArray(payload.entries) && payload.entries.length) {
    state.replaces.push(...payload.entries);
    listing.total = state.replaces.length;
  }
  // Show progress without pretending the folder only contains what has arrived.
  updateListingStatus();
}

function finishListing(payload) {
  const listing = state.listing;
  if (!listing || payload.requestId !== listing.requestId) return;
  const session = state.session;
  if (!session || session.connection.id !== listing.connectionId) return;

  listing.done = true;
  session.entries = state.replaces ?? [];
  state.replaces = [];
  session.loading = false;
  session.awaitingFirstPage = false;
  session.truncated = Boolean(payload.truncated);
  session.warning = payload.warning ?? null;
  session.prefix = payload.prefix ?? session.prefix;

  // A completed listing replaces the visible set, so the node pool is rebuilt.
  state.rebuildList = true;
  renderBreadcrumb();
  renderObjects();
  updateToolbar();
}

function failListing(payload) {
  const listing = state.listing;
  if (!listing || payload.requestId !== listing.requestId) return;
  state.replaces = [];
  if (state.session) {
    state.session.loading = false;
    state.session.awaitingFirstPage = false;
    state.session.error = payload.error ?? null;
  }
  renderObjects();
  updateToolbar();
  toastError(payload.error?.message ?? "listing failed", "Cannot list this folder");
}

async function navigateTo(prefix) {
  if (!state.session) return;
  state.session.prefix = prefix;
  state.selected.clear();
  // Changing folder does clear the preview: the object belongs to the old folder.
  state.preview = null;
  state.previewRequest += 1;
  state.rowSignature = null;
  state.rowPool = [];
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
  const container = $("#object-rows");
  const scroller = $("#object-list");

  if (!state.session) {
    state.visible = [];
    state.rowPool = [];
    state.rowSignature = null;
    resetScroller(scroller);
    scroller.append(noConnectionState());
    return;
  }

  state.visible = visibleEntries();

  // Streaming appends pages continuously; discarding the node pool on every page
  // would defeat the point of streaming. It is rebuilt only when the *set* of
  // rows changes: navigation, sort, filter, or a completed listing.
  const signature = [
    state.session.connection.id,
    state.session.prefix,
    state.filter,
    state.sort.key,
    state.sort.direction,
  ].join("|");
  if (signature !== state.rowSignature || state.rebuildList) {
    state.rowSignature = signature;
    state.rebuildList = false;
    state.rowPool = [];
    resetScroller(scroller);
  }

  if (!state.visible.length) {
    const rowsLayer = $("#object-rows");
    if (rowsLayer) rowsLayer.style.height = "0px";
    const pending = Boolean(state.session.loading || state.session.awaitingFirstPage);
    const existing = scroller.querySelector(".empty-state");
    const wanted = pending ? "loading-state" : "empty-folder";
    if (!existing || existing.dataset.testid !== wanted) {
      resetScroller(scroller);
      scroller.append(
        el("div", {
          class: "empty-state",
          "data-testid": wanted,
          text: pending
            ? "Loading…"
            : state.filter
              ? "Nothing matches the filter."
              : "This folder is empty.",
        }),
      );
    }
    updateListingStatus();
    return;
  }

  const stale = scroller.querySelector(".empty-state");
  if (stale) stale.remove();
  state.rowContainer = $("#object-rows");
  state.rowContainer.style.height = `${state.visible.length * state.rowHeight}px`;
  paintRows(true);
  syncSelectAll(state.visible);
  updateListingStatus();
}

/**
 * Empty the scroll container, keeping (and recreating) the rows layer inside it.
 * Dropping the rows layer here would break every subsequent render.
 */
function resetScroller(scroller) {
  const rows = $("#object-rows");
  if (rows) rows.remove();
  const empty = scroller.querySelector(".empty-state");
  if (empty) empty.remove();
  const fresh = el("div", { class: "object-rows", id: "object-rows" });
  scroller.append(fresh);
  return fresh;
}

/** The list container, with its scroll handler attached exactly once. */
function objectScroller() {
  const scroller = $("#object-list");
  if (!scroller.dataset.bound) {
    scroller.dataset.bound = "1";
    let frame = null;
    scroller.addEventListener("scroll", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        paintRows(false);
      });
    });
    window.addEventListener("resize", () => paintRows(true));
  }
  return scroller;
}

/**
 * Draw only the rows inside the viewport (plus a small overscan) and recycle the
 * DOM nodes. This is what keeps a folder with tens of thousands of objects from
 * blocking the UI thread.
 */
function paintRows(force) {
  if (!state.session || !state.visible.length) return;
  const scroller = objectScroller();
  const container = $("#object-rows") ?? resetScroller(scroller);

  const rowHeight = state.rowHeight;
  const scrollTop = scroller.scrollTop;
  const viewport = scroller.clientHeight || 600;
  const overscan = 8;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(
    state.visible.length,
    Math.ceil((scrollTop + viewport) / rowHeight) + overscan,
  );
  const needed = Math.max(0, last - first);

  while (state.rowPool.length < needed) {
    const row = el("div", { class: "object-row", role: "option" });
    row.append(
      el("label", { class: "cell cell--check" }, [el("input", { type: "checkbox" })]),
      el("div", { class: "cell cell--name" }, [
        el("div", { class: "row-name" }, [
          el("span", { class: "row-icon" }),
          el("span", { class: "row-label" }),
        ]),
      ]),
      el("div", { class: "cell cell--size" }),
      el("div", { class: "cell cell--modified" }),
      el("div", { class: "cell cell--kind" }),
    );
    state.rowPool.push(row);
    container.append(row);
  }

  for (let i = 0; i < state.rowPool.length; i += 1) {
    const node = state.rowPool[i];
    if (i >= needed) {
      node.hidden = true;
      continue;
    }
    node.hidden = false;
    updateRow(node, state.visible[first + i], first + i);
  }
  void force;
}

/** Fill one recycled row from an entry. */
function updateRow(node, entry, index) {
  const rowHeight = state.rowHeight;
  const selected = state.selected.has(entry.key);
  node.style.transform = `translateY(${index * rowHeight}px)`;
  node.dataset.key = entry.key;
  node.dataset.testid = `row-${entry.name}`;
  node.classList.toggle("object-row--folder", entry.isFolder);
  node.setAttribute("aria-selected", selected ? "true" : "false");

  const checkbox = node.querySelector('input[type="checkbox"]');
  checkbox.checked = selected;
  checkbox.dataset.testid = `row-check-${entry.name}`;

  const icon = node.querySelector(".row-icon");
  icon.textContent = kindIcon(entry.kind, entry.isFolder);
  const label = node.querySelector(".row-label");
  label.textContent = entry.name;
  label.title = entry.key;

  node.querySelector(".cell--size").textContent = entry.isFolder ? "—" : humanSize(entry.size);
  const modified = node.querySelector(".cell--modified");
  modified.textContent = humanDate(entry.lastModified);
  modified.title = entry.lastModified ?? "";
  node.querySelector(".cell--kind").textContent = kindLabel(entry.kind);

  // Handlers are attached once per node; they read the key from the dataset so a
  // recycled node always acts on the entry it currently shows.
  if (!node.dataset.bound) {
    node.dataset.bound = "1";
    node.addEventListener("click", (event) => {
      const key = node.dataset.key;
      selectOnly(key, event.shiftKey);
      updateVisibleSelection();
      updateToolbar();
      const current = state.visible.find((item) => item.key === key);
      if (current) previewEntry(current);
    });
    node.addEventListener("dblclick", () => {
      const current = state.visible.find((item) => item.key === node.dataset.key);
      if (current) activateEntry(current);
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const current = state.visible.find((item) => item.key === node.dataset.key);
      if (current) openRowMenu(current, event);
    });
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = node.dataset.key;
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
      updateVisibleSelection();
      updateToolbar();
    });
  }
}

/** Repaint just the selection state of the drawn rows. */
function updateVisibleSelection() {
  for (const node of state.rowPool) {
    if (node.hidden) continue;
    const key = node.dataset.key;
    const selected = state.selected.has(key);
    node.setAttribute("aria-selected", selected ? "true" : "false");
    const checkbox = node.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = selected;
  }
  syncSelectAll(state.visible);
}

function selectOnly(key, extend) {
  if (extend && state.visible.length) {
    const anchor = state.selected.size ? [...state.selected][state.selected.size - 1] : null;
    const from = anchor ? state.visible.findIndex((item) => item.key === anchor) : -1;
    const to = state.visible.findIndex((item) => item.key === key);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = [from, to].sort((a, b) => a - b);
      for (let i = lo; i <= hi; i += 1) state.selected.add(state.visible[i].key);
      return;
    }
  }
  state.selected.clear();
  state.selected.add(key);
}

function noConnectionState() {
  return el("div", { class: "empty-state", "data-testid": "no-connection-state" }, [
    el("p", { text: "Pick a connection on the left, or create a new one." }),
    el("p", {
      class: "muted",
      text: "Each connection pins one bucket and one prefix; add several to move between projects quickly.",
    }),
  ]);
}

/** Right-click menu for an object row. */
function openRowMenu(entry, event) {
  const uri = s3Uri(state.session.connection.bucket, entry.key);
  copyText(uri).then((ok) => {
    if (ok) toastOk(`Copied ${uri}`);
    else toastError("The clipboard is not available.");
  });
  void event;
}

function updateListingStatus() {
  const status = $("#folder-status");
  if (!status || !state.session) return;
  const files = state.session.entries.filter((entry) => !entry.isFolder).length;
  const folders = state.session.entries.length - files;
  const bytes = state.session.entries.reduce(
    (sum, entry) => sum + (entry.isFolder ? 0 : entry.size),
    0,
  );
  const selected = state.selected.size ? ` · ${state.selected.size} selected` : "";
  status.textContent =
    `${folders} folder(s), ${files} file(s), ${humanSize(bytes)}` +
    `${state.session.loading ? " · loading…" : ""}` +
    `${state.session.truncated ? " (truncated)" : ""}${selected}`;
}

function syncSelectAll(entries) {
  const box = $("#select-all");
  const all = entries.length > 0 && entries.every((entry) => state.selected.has(entry.key));
  box.checked = all;
  box.indeterminate = !all && entries.some((entry) => state.selected.has(entry.key));
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
  updateVisibleSelection();
  updateToolbar();
  previewEntry(entry);
  scrollRowIntoView(next);
}

/** Keep the painted window in sync when the keyboard moves past it. */
function scrollRowIntoView(index) {
  const scroller = objectScroller();
  const top = index * state.rowHeight;
  const bottom = top + state.rowHeight;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = bottom - scroller.clientHeight;
  }
  paintRows(false);
}

function activateEntry(entry) {
  if (entry.isFolder) navigateTo(entry.key);
  else previewEntry(entry, { force: true });
}

function updateToolbar() {
  const hasSession = Boolean(state.session);
  const count = state.selected.size;
  const connection = state.session?.connection;
  const info = describeCapabilities(
    state.connections.find((v) => v.connection.id === connection?.id)?.capabilities,
  );
  const canWrite = hasSession && info.level !== "ro" && !connection?.security?.readOnlyMode;

  for (const action of ["upload", "new-folder", "new-file"]) {
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !hasSession || !canWrite;
  }
  for (const action of ["delete", "copy", "move"]) {
    const button = document.querySelector(`[data-action="${action}"]`);
    if (button) button.disabled = !hasSession || count === 0 || !canWrite;
  }
  const download = document.querySelector('[data-action="download"]');
  if (download) download.disabled = !hasSession || count === 0;
  const copyUri = document.querySelector('[data-action="copy-uri"]');
  if (copyUri) copyUri.disabled = !hasSession || count === 0;

  updateListingStatus();

  const previewDownload = $("#preview-download");
  if (previewDownload) previewDownload.disabled = !state.preview?.key;
  const previewUri = $("#preview-copy-uri");
  if (previewUri) previewUri.disabled = !state.preview?.key;
}

// -------------------------------------------------------------------- preview

/**
 * Load and show the preview for one object.
 *
 * Two guards matter here. Clicking two rows in quick succession used to leave the
 * panel stuck on "Loading…" while the newer preview sat unrendered in state; and
 * the folder branch bailed out before repainting. Both are covered by the request
 * id below: only the newest load may write to `state.preview`, and the render
 * always happens after the write.
 */
async function previewEntry(candidate, { force = false } = {}) {
  // Rows are recycled, so a click can arrive with an object captured from an
  // earlier listing. Re-read the live entry by key and drop the stale one.
  const entry =
    state.session?.entries.find((item) => item.key === candidate?.key) ?? candidate;
  if (!entry) return;

  if (entry.isFolder) {
    // Folders can still be "selected"; the preview explains why it is empty.
    state.preview = {
      key: entry.key,
      entry,
      loading: false,
      data: null,
      error: null,
      unavailable: "This is a folder.",
    };
    renderPreviewPanel();
    return;
  }

  // Re-opening the same object keeps the view the user last chose for it.
  const sameObject = state.preview?.key === entry.key;
  if (!force && sameObject && !state.preview?.loading) return;
  const view = sameObject ? state.preview.view : undefined;

  const request = ++state.previewRequest;
  state.preview = { key: entry.key, entry, loading: true, data: null, error: null, view };
  renderPreviewPanel();

  let next;
  try {
    const data = await api.getPreview({
      connectionId: state.session.connection.id,
      key: entry.key,
    });
    next = { key: entry.key, entry, loading: false, data, error: null, view };
  } catch (error) {
    next = { key: entry.key, entry, loading: false, data: null, error, view };
  }

  // A newer click (or a different object) wins; this response is stale.
  if (request !== state.previewRequest || state.preview?.key !== entry.key) return;
  state.preview = next;
  renderPreviewPanel();
}

function renderPreviewPanel({ reveal = true } = {}) {
  // Selecting an object reveals the panel again unless the user hid it; a pure
  // re-render (the Markdown raw/rendered toggle) must not.
  if (reveal && !state.previewHidden) {
    $("#preview").hidden = false;
    applyLayout();
  }
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
    case "copy-uri":
      copySelectionUris();
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

/** Copy the s3:// URI of one key (or of the object currently previewed). */
async function copyUriFor(key) {
  if (!state.session || !key) return;
  const uri = s3Uri(state.session.connection.bucket, key);
  const ok = await copyText(uri);
  if (ok) toastOk(`Copied ${uri}`);
  else toastError("The clipboard is not available.");
}

/** Copy one URI per selected item, newline separated. */
async function copySelectionUris() {
  const entries = selectedEntries();
  if (!state.session || !entries.length) return;
  const bucket = state.session.connection.bucket;
  const text = entries.map((entry) => s3Uri(bucket, entry.key)).join("\n");
  const ok = await copyText(text);
  if (!ok) {
    toastError("The clipboard is not available.");
    return;
  }
  toastOk(
    entries.length === 1 ? `Copied ${text}` : `Copied ${entries.length} S3 URIs`,
  );
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
  /** Bring one virtualised row into the painted window (used by the e2e suite). */
  scrollToRow: (index) => scrollRowIntoView(index),
  copySnippet: () => copyText($("#boto3-snippet")?.textContent ?? ""),
};
