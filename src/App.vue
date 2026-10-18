<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  AlertTriangle,
  Copy,
  Download,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link2,
  MoveRight,
  PanelLeft,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "@lucide/vue";
import AppSidebar from "@/components/layout/AppSidebar.vue";
import AppHeader from "@/components/layout/AppHeader.vue";
import Resizer from "@/components/layout/Resizer.vue";
import TransferPanel from "@/components/layout/TransferPanel.vue";
import DropZone from "@/components/layout/DropZone.vue";
import ObjectList from "@/components/browser/ObjectList.vue";
import PreviewPanel from "@/components/preview/PreviewPanel.vue";
import ToastStack from "@/components/ui/ToastStack.vue";
import DialogHost from "@/components/ui/DialogHost.vue";
import AppButton from "@/components/ui/AppButton.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import Spinner from "@/components/ui/Spinner.vue";
import ContextMenu, { type MenuItem } from "@/components/ui/ContextMenu.vue";
import ConnectionDialog from "@/components/dialogs/ConnectionDialog.vue";
import SettingsDialog from "@/components/dialogs/SettingsDialog.vue";
import UpdateDialog from "@/components/dialogs/UpdateDialog.vue";
import ImportDialog from "@/components/dialogs/ImportDialog.vue";
import { copyText, listen } from "@/lib/ipc";
import { clamp, s3Uri } from "@/lib/format";
import { IS_MAC, isEditableTarget, shortcutLabel } from "@/lib/keyboard";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { useDialogsStore } from "@/stores/dialogs";
import { useToastsStore } from "@/stores/toasts";
import { useUpdatesStore } from "@/stores/updates";
import { useObjectActions } from "@/composables/useObjectActions";
import { useDialogs } from "@/composables/useDialogs";
import type {
  AppSettings,
  Connection,
  ListingDoneEvent,
  ListingErrorEvent,
  ListingPageEvent,
} from "@/types";

const ui = useUiStore();
const connections = useConnectionsStore();
const objects = useObjectsStore();
const progress = useProgressStore();
const dialogs = useDialogsStore();
const toasts = useToastsStore();
const updates = useUpdatesStore();
const actions = useObjectActions();
const confirmations = useDialogs();

const objectList = ref<InstanceType<typeof ObjectList> | null>(null);

/**
 * Launch state. `loading` paints a neutral shell with a spinner instead of the
 * empty "No connection selected" card, which used to flash before the first
 * connection opened (DLG-7). `error` is a real failure of the start-up reads
 * with a way to try again instead of a dead, unexplained window (DLG-8).
 */
type BootState = "loading" | "ready" | "error";
const bootState = ref<BootState>("loading");
const bootError = ref<string | null>(null);

/** Right-click menu: either on one row, or on the empty background. */
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null);

/** macOS deletes with ⌘⌫; Linux deletes with the forward-delete key. */
const deleteShortcut = IS_MAC ? shortcutLabel("Backspace") : "Del";

async function copyNames(names: string[]) {
  if (!names.length) return;
  const copied = await copyText(names.join("\n"));
  if (!copied) {
    toasts.error("The clipboard is not available.");
    return;
  }
  toasts.ok(names.length === 1 ? `Copied “${names[0]}”` : `Copied ${names.length} names`);
}

function rowMenu(entry: (typeof objects.entries)[number], event: MouseEvent) {
  const connection = connections.active;
  if (!connection) return;
  const writable = connections.canWriteActive;
  // ObjectList selects a right-clicked row that was outside the selection, so
  // one set backs every item (SEL-4).
  const targets = objects.deleteTargets.length ? objects.deleteTargets : [entry];
  const count = targets.length;
  const fileCount = targets.filter((item) => !item.isFolder).length;
  const names = targets.map((item) => item.name);
  const transferLabel = (base: string) =>
    count > 1 ? `${base} ${count} items to…` : `${base} to…`;

  menu.value = {
    x: event.clientX,
    y: event.clientY,
    items: [
      entry.isFolder
        ? { label: "Open", icon: FolderOpen, run: () => void objects.navigate(entry.key) }
        : {
            label: "Preview",
            icon: Eye,
            run: () => {
              objects.focus(entry.key);
              void objects.previewEntry(entry, { force: true });
            },
          },
      {
        label: fileCount > 1 ? `Download ${fileCount} files` : "Download",
        icon: Download,
        disabled: fileCount === 0,
        run: () => void actions.downloadSelection(),
      },
      {
        label: count > 1 ? `Copy ${count} S3 URIs` : "Copy S3 URI",
        icon: Link2,
        run: () => void actions.copySelectionUris(),
      },
      {
        label: count > 1 ? `Copy ${count} names` : "Copy name",
        icon: Copy,
        run: () => void copyNames(names),
      },
      {
        label: transferLabel("Copy"),
        icon: MoveRight,
        separatorBefore: true,
        disabled: !writable,
        run: () => void actions.transferSelection(false),
      },
      {
        label: transferLabel("Move"),
        icon: MoveRight,
        disabled: !writable,
        run: () => void actions.transferSelection(true),
      },
      {
        label: count > 1 ? `Delete ${count} items` : "Delete",
        icon: Trash2,
        danger: true,
        shortcut: deleteShortcut,
        separatorBefore: true,
        disabled: !writable,
        run: () => void actions.deleteSelection(),
      },
    ] as MenuItem[],
  };
}

function backgroundMenu(event: MouseEvent) {
  const writable = connections.canWriteActive;
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    items: [
      ...(writable
        ? [
            { label: "Upload files…", icon: Upload, run: () => void actions.upload() },
            { label: "Upload folder…", icon: FolderUp, run: () => void actions.uploadFolder() },
            { label: "New folder…", icon: FolderPlus, run: () => void actions.createFolder() },
            { label: "New file…", icon: FilePlus, run: () => void actions.createFile() },
          ]
        : []),
      {
        label: "Refresh",
        icon: RefreshCw,
        separatorBefore: writable,
        run: () => void objects.reload(),
      },
    ] as MenuItem[],
  };
}
const unsubscribers: Array<() => void> = [];

const hasConnection = computed(() => Boolean(connections.active));
const sidebarWidth = computed({
  get: () => ui.layout.sidebar,
  set: (value: number) => ui.setSidebarWidth(value),
});
const previewWidth = computed({
  get: () => ui.layout.preview,
  set: (value: number) => ui.setPreviewWidth(value),
});
/**
 * The expanded layout only means something while there is a preview to show.
 * The objects store resets the flag when the preview clears or the folder
 * changes; this gate also covers the render before that reset runs, so a stale
 * flag can never hide the object list behind an empty panel.
 */
const previewExpanded = computed(
  () => ui.previewExpanded && Boolean(objects.previewKey) && !ui.previewHidden,
);

// ---------------------------------------------------------------- connections

async function openConnection(connection: Connection) {
  connections.setActive(connection.id);
  await objects.loadFolder(connection.prefix ?? "");
  objects.clearPreview();
  void connections.probeOnConnect(connection.id);
}

async function createConnection() {
  const saved = await dialogs.open<Connection | null>(
    ConnectionDialog,
    (settle) => ({ connection: null, resolve: settle }),
    "wide",
    { dismissible: false },
  );
  if (!saved) return;
  await connections.load();
  await openConnection(saved);
}

async function editConnection(connection: Connection | undefined = connections.active ?? undefined) {
  if (!connection) return;
  const saved = await dialogs.open<Connection | null>(
    ConnectionDialog,
    (settle) => ({ connection, resolve: settle }),
    "wide",
    { dismissible: false },
  );
  if (!saved) return;
  // `connections.save` already reloaded the list; probe again because the saved
  // credentials may differ from the ones the badge was probed with.
  await connections.refreshCapabilities(saved.id);
  // Only the active session holds a snapshot of the edited connection. Editing
  // another connection must leave the open folder, its filter and its selection
  // exactly as they were (CON-1).
  if (saved.id === connections.activeId) await objects.reloadSession();
}

/** Right-click or the `⋯` button on a connection card: actions, not activation. */
function connectionMenu(connection: Connection, point: { x: number; y: number }) {
  menu.value = {
    x: point.x,
    y: point.y,
    items: [
      {
        label: "Open",
        icon: FolderOpen,
        run: () => void openConnection(connection),
      },
      {
        label: "Edit connection…",
        icon: Pencil,
        run: () => void editConnection(connection),
      },
      {
        label: "Duplicate",
        icon: Copy,
        run: () => void duplicateConnection(connection),
      },
      {
        label: "Copy bucket URI",
        icon: Link2,
        run: () => void copyBucketUri(connection),
      },
      {
        label: "Remove connection…",
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        run: () => void removeConnection(connection),
      },
    ],
  };
}

async function duplicateConnection(connection: Connection) {
  try {
    const copy = await connections.duplicate(connection.id);
    toasts.ok(`Connection “${copy.name}” created.`);
  } catch (error) {
    toasts.apiError(error, "Cannot duplicate");
  }
}

async function copyBucketUri(connection: Connection) {
  const uri = s3Uri(connection.bucket, connection.prefix);
  if (!(await copyText(uri))) {
    toasts.error("The clipboard is not available.");
    return;
  }
  toasts.ok(`Copied ${uri}`);
}

async function removeConnection(connection: Connection) {
  const confirmed = await confirmations.confirm({
    title: `Remove “${connection.name}”?`,
    message:
      "This removes the connection and its saved credentials from this computer. Objects in the bucket are unaffected.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!confirmed) return;
  try {
    // The store clears the open objects session when the removed connection is
    // the active one, so the main area falls back to its empty state.
    await connections.remove(connection.id);
    toasts.ok(`Connection “${connection.name}” removed.`);
  } catch (error) {
    toasts.apiError(error, "Cannot remove connection");
  }
}

async function openSettings() {
  const saved = await dialogs.open<AppSettings | null>(
    SettingsDialog,
    (settle) => ({ resolve: settle }),
    "normal",
    { dismissible: false },
  );
  if (!saved) return;
  // Settings such as "show system objects" and the page size only take effect
  // on the next listing, so re-list the open folder instead of making the user
  // find Refresh (SET-1).
  if (connections.active) await objects.reload();
}

async function openImport() {
  const imported = await dialogs.open<string[]>(
    ImportDialog,
    (settle) => ({ resolve: settle }),
    "normal",
    { dismissible: false },
  );
  if (!imported?.length) return;
  await connections.load();
  // Open the connection that was just imported, not whichever connection
  // happened to sort first (CON-8).
  const first = connections.all.find((connection) => connection.id === imported[0]);
  if (first) await openConnection(first);
}

// -------------------------------------------------------------------- updates

async function openUpdateDialog() {
  await dialogs.open<null>(UpdateDialog, (settle) => ({ resolve: settle }), "normal");
}

/**
 * Runs once per launch, a few seconds in so it does not compete with the first
 * paint and the first listing. Silence is the right outcome for every case that
 * is not "a newer version exists": no update, no network, GitHub unreachable.
 */
async function checkForUpdates() {
  try {
    if (!(await updates.check())) return;
  } catch {
    return;
  }

  if (dialogs.isOpen()) {
    // Never stack the prompt on top of something the user is already doing.
    toasts.push({
      level: "info",
      title: "Update available",
      message: `S3 Viewer ${updates.nextVersion ?? "a new version"} is ready to install.`,
      actions: [{ label: "Install…", run: () => void openUpdateDialog() }],
    });
    return;
  }

  await openUpdateDialog();
}

// ------------------------------------------------------------------- keyboard

const PAGE_ROWS = 10;
const TYPE_AHEAD_MS = 700;
/** Type-ahead buffer: printable keys typed in a row search the visible names. */
let typeAhead = "";
let typeAheadTimer: ReturnType<typeof setTimeout> | undefined;

function clearTypeAhead() {
  if (typeAheadTimer) clearTimeout(typeAheadTimer);
  typeAheadTimer = undefined;
  typeAhead = "";
}

/** Keys on a button, link or menu belong to that control, not to the list. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, [role="menu"], [role="menuitem"], [role="separator"]'));
}

/** A nested view (the PDF) owns the list-only keys while it has focus. */
function inKeyScope(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-keyscope]"));
}

function focusedRowIndex(): number {
  return objects.visibleEntries.findIndex((entry) => entry.key === objects.focusedKey);
}

/** Move the focus and the preview; only Shift+Arrow also changes the selection. */
function moveFocus(index: number, extend = false) {
  const rows = objects.visibleEntries;
  if (!rows.length) return;
  const next = clamp(index, 0, rows.length - 1);
  const entry = rows[next];
  if (extend) {
    objects.focus(entry.key, { keepAnchor: true });
    objects.selectRange(entry.key);
  } else {
    objects.focus(entry.key);
  }
  objectList.value?.scrollToRow(next);
  void objects.previewEntry(entry);
}

function runTypeAhead(character: string) {
  if (typeAheadTimer) clearTimeout(typeAheadTimer);
  typeAhead = (typeAhead + character).toLowerCase();
  typeAheadTimer = setTimeout(() => {
    typeAhead = "";
    typeAheadTimer = undefined;
  }, TYPE_AHEAD_MS);

  const rows = objects.visibleEntries;
  const index = rows.findIndex((entry) => entry.name.toLowerCase().startsWith(typeAhead));
  if (index === -1) return;
  const entry = rows[index];
  objects.focus(entry.key);
  objectList.value?.scrollToRow(index);
  void objects.previewEntry(entry);
}

async function onKeydown(event: KeyboardEvent) {
  // A nested control already handled this key (menu, resizer, PDF page).
  if (event.defaultPrevented) return;
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;
  const lower = key.toLowerCase();
  const editing = isEditableTarget(event.target) || isEditableTarget(document.activeElement);

  if (meta && lower === "r") {
    event.preventDefault();
    await objects.reload();
    return;
  }
  if (meta && lower === "u" && hasConnection.value) {
    event.preventDefault();
    await actions.upload();
    return;
  }
  if (meta && lower === "n") {
    event.preventDefault();
    await createConnection();
    return;
  }
  if (meta && lower === "b") {
    event.preventDefault();
    ui.toggleSidebar();
    return;
  }
  if (meta && lower === "i" && connections.active) {
    event.preventDefault();
    await editConnection();
    return;
  }
  if (meta && lower === "l") {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>('[data-testid=address-edit]')?.click();
    return;
  }
  if (meta && lower === "f" && !dialogs.isOpen()) {
    event.preventDefault();
    document.querySelector<HTMLInputElement>('[data-testid=filter-input]')?.focus();
    return;
  }
  if (meta && lower === "a" && !editing && hasConnection.value) {
    event.preventDefault();
    objects.selectAll(objects.visibleEntries.map((entry) => entry.key));
    return;
  }
  if (dialogs.isOpen() || editing) return;

  // Collapsing an expanded preview is global: the user just clicked its Expand
  // button, and Escape must not depend on where focus landed. It is also the
  // smaller, more reversible step, so only the next Escape clears the selection.
  if (key === "Escape" && previewExpanded.value) {
    event.preventDefault();
    ui.togglePreviewExpanded();
    return;
  }

  if (isInteractiveTarget(event.target)) return;

  // Escape stays global, so it can clear the selection from a focused preview.
  if (key === "Escape") {
    objects.clearSelection();
    return;
  }

  // Up-navigation owns modified ArrowUp, so it must win over list movement.
  // macOS goes up with ⌘↑; bare Backspace must not navigate there at all.
  if (meta && key === "ArrowUp" && objects.prefix) {
    event.preventDefault();
    await objects.navigateUp();
    return;
  }

  // The PDF viewer handles its own keys; moving the list underneath it would
  // be a second, invisible response to one key (KEY-1). Escape and the
  // Cmd/Ctrl shortcuts above stay global; bare Backspace is list-only.
  if (inKeyScope(event.target)) return;

  if (!IS_MAC && key === "Backspace" && !meta && objects.prefix) {
    event.preventDefault();
    await objects.navigateUp();
    return;
  }

  const rows = objects.visibleEntries;
  const current = focusedRowIndex();

  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    const delta = key === "ArrowDown" ? 1 : -1;
    moveFocus(current === -1 ? 0 : current + delta, event.shiftKey);
    return;
  }

  if (key === "PageDown" || key === "PageUp") {
    event.preventDefault();
    const delta = key === "PageDown" ? PAGE_ROWS : -PAGE_ROWS;
    moveFocus(current === -1 ? 0 : current + delta);
    return;
  }

  if (key === "Home" || key === "End") {
    event.preventDefault();
    moveFocus(key === "Home" ? 0 : rows.length - 1);
    return;
  }

  if (key === "Enter" && objects.focusedKey) {
    event.preventDefault();
    const focused = objects.focusedKey;
    const entry = rows.find((item) => item.key === focused);
    if (!entry) return;
    if (entry.isFolder) await objects.navigate(entry.key);
    else await objects.previewEntry(entry, { force: true });
    return;
  }

  // ⌘⌫ (the Mac Delete key) and the forward-delete key both delete on macOS.
  const deletePressed = IS_MAC
    ? (meta && key === "Backspace") || key === "Delete"
    : key === "Delete";
  if (deletePressed && objects.deleteTargets.length) {
    event.preventDefault();
    await actions.deleteSelection();
    return;
  }

  if (key === " " && objects.focusedKey) {
    event.preventDefault();
    objects.toggleSelected(objects.focusedKey);
    return;
  }

  // Type-ahead: printable characters, no modifiers, and never a bare space.
  if (!meta && !event.altKey && key.length === 1 && key !== " ") {
    runTypeAhead(key);
  }
}

// ------------------------------------------------------------------ start-up

/**
 * One-time wiring. `Try again` re-runs `boot`, but the keyboard/poller wiring
 * must exist exactly once and successful event subscriptions must not double.
 */
let globalsAttached = false;
let updateCheckScheduled = false;

interface IpcSubscription {
  register: () => Promise<() => void>;
  pending: Promise<void> | null;
  live: boolean;
}

function ipcSubscription(register: () => Promise<() => void>): IpcSubscription {
  return { register, pending: null, live: false };
}

const ipcSubscriptions: IpcSubscription[] = [
  ipcSubscription(() =>
    listen<ListingPageEvent>("listing://page", (payload) => objects.onListingPage(payload)),
  ),
  ipcSubscription(() =>
    listen<ListingDoneEvent>("listing://done", (payload) => objects.onListingDone(payload)),
  ),
  ipcSubscription(() =>
    listen<ListingErrorEvent>("listing://error", (payload) => objects.onListingError(payload)),
  ),
];

function onWindowResize() {
  ui.clampLayoutToWindow();
}

function attachGlobals() {
  if (globalsAttached) return;
  globalsAttached = true;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  progress.start();
}

/**
 * Start the backend subscriptions without awaiting them.
 *
 * They are created before the first `await` in `boot`, so a slow or failing
 * settings read cannot leave the app running without its listing events
 * (DLG-8). A failed registration is not cached as a permanent no-op: `live`
 * stays false, so the next `boot()` retries just that event. Successful events
 * stay subscribed, so a retry cannot double-register them.
 */
function ensureIpcListeners(): Promise<void> {
  const attempts = ipcSubscriptions
    .filter((subscription) => !subscription.live)
    .map((subscription) => {
      subscription.pending ??= subscription
        .register()
        .then(
          (unsubscribe) => {
            subscription.live = true;
            unsubscribers.push(unsubscribe);
          },
          () => {
            // Leave `live` false: the next boot retries this event.
          },
        )
        .finally(() => {
          subscription.pending = null;
        });
      return subscription.pending;
    });
  return Promise.all(attempts).then(() => undefined);
}

/** The e2e scenario drives the UI through this surface. */
function publishHarness() {
  const api = {
    // `state` mirrors what the harness reads: the visible rows, the selection and
    // the preview key. Getters keep it live without duplicating store state.
    state: {
      connections,
      objects,
      ui,
      get session() {
        if (!connections.active) return null;
        return {
          connection: connections.active,
          prefix: objects.prefix,
          loading: objects.loading,
          get entries() {
            return objects.entries;
          },
        };
      },
      get visible() {
        return objects.visibleEntries;
      },
      get entries() {
        return objects.entries;
      },
      get selected() {
        return objects.selected;
      },
    },
    describe: () => ({
      loading: objects.loading,
      entries: objects.entries.length,
      filter: objects.filter,
      visible: objects.visibleEntries.length,
      previewKey: objects.previewKey,
      selected: objects.selected.size,
    }),
    refresh: () => objects.reload(),
    refreshConnections: () => connections.load(),
    scrollToRow: (index: number) => objectList.value?.scrollToRow(index),
    openConnection: (connection: Connection) => openConnection(connection),
    previewFor: (key: string) => {
      const entry = objects.entries.find((item) => item.key === key);
      if (entry) void objects.previewEntry(entry, { force: true });
    },
    createConnection,
    editConnection,
    select: (key: string) => {
      objects.focus(key);
      objects.selectAll([key]);
      const entry = objects.entries.find((item) => item.key === key);
      if (entry) void objects.previewEntry(entry, { force: true });
    },
    objects,
    connections,
    toasts,
    logs: objects.logging,
    copySnippet: async () => {
      // Used by the suite to prove the clipboard path works end to end.
      const { copyText } = await import("@/lib/ipc");
      const snippet = document.querySelector('[data-testid=boto3-snippet]');
      return snippet ? copyText(snippet.textContent ?? "") : false;
    },
  };
  // `rowPool` is part of the harness contract: it reports how many DOM rows exist.
  Object.defineProperty(api.state, "rowPool", {
    get: () => ({ length: document.querySelectorAll(".object-row").length }),
  });
  (window as unknown as { __s3viewer: unknown }).__s3viewer = api;
  (window as unknown as { __s3viewerReady: boolean }).__s3viewerReady = true;

  if (!updateCheckScheduled) {
    updateCheckScheduled = true;
    // Deliberately after the ready flag: the e2e harness should never race a
    // network request, and in practice no release is newer than a local build.
    window.setTimeout(() => void checkForUpdates(), 2500);
  }
}

async function boot() {
  bootState.value = "loading";
  bootError.value = null;

  // Everything that does not depend on IPC is live before the first await: a
  // failed settings read must not cost the user the keyboard or the poller.
  attachGlobals();
  const listeners = ensureIpcListeners();

  try {
    await ui.load();
    await connections.load();
    await listeners;

    // The first connection opens automatically, which is what a returning user
    // expects: one click less before they can see their files.
    const first = connections.all[0];
    if (first) await openConnection(first);

    bootState.value = "ready";
    publishHarness();
  } catch (error) {
    bootError.value = error instanceof Error ? error.message : String(error);
    bootState.value = "error";
    // The config path is the one piece of context DLG-8 asks for and it lives
    // in a different command than the settings read that just failed.
    if (!ui.security) void ui.loadSecurity();
  }
}

onMounted(() => {
  void boot();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  clearTypeAhead();
  for (const unsubscribe of unsubscribers) unsubscribe();
  progress.stop();
});

function onDrop(paths: string[]) {
  // A read-only connection still receives the OS drop; answer it explicitly
  // instead of starting an upload that the backend would refuse (IO-5).
  if (!connections.active) {
    toasts.warn("Open a connection before uploading.", "Nothing to upload to");
    return;
  }
  if (!connections.canWriteActive) {
    toasts.warn(
      "This connection does not allow writes. Nothing was uploaded.",
      "Read-only connection",
    );
    return;
  }
  void actions.queueUploads(paths);
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg" data-testid="app">
    <div
      v-if="bootState === 'loading'"
      class="flex flex-1 items-center justify-center bg-bg"
      data-testid="boot-loading"
    >
      <Spinner label="Starting S3 Viewer…" />
    </div>

    <div
      v-else-if="bootState === 'error'"
      class="flex flex-1 items-center justify-center p-8"
      data-testid="boot-error"
    >
      <EmptyState
        :icon="AlertTriangle"
        title="Could not start"
        :description="bootError ?? 'The app could not finish starting.'"
      >
        <p
          v-if="ui.security?.configPath"
          class="max-w-full text-[0.6875rem] leading-relaxed break-words text-muted"
          data-testid="boot-config-path"
        >
          Config file: <span class="font-mono break-all">{{ ui.security.configPath }}</span>
        </p>
        <AppButton variant="primary" data-testid="boot-retry" @click="boot">Try again</AppButton>
      </EmptyState>
    </div>

    <div v-else class="flex min-h-0 flex-1" data-app-shell>
      <div class="relative flex min-h-0 shrink-0" :style="{ width: ui.layout.collapsed ? undefined : `${sidebarWidth}px` }">
        <AppSidebar
          @create="createConnection"
          @open="openConnection"
          @menu="connectionMenu"
          @settings="openSettings"
          @import="openImport"
        />
        <Resizer
          v-if="!ui.layout.collapsed"
          v-model="sidebarWidth"
          side="right"
          grow="right"
          :min="190"
          :max="520"
          label="Resize the sidebar"
          data-testid="resizer-sidebar"
          @commit="ui.clampLayoutToWindow()"
          @reset="ui.resetSidebarWidth()"
        />
      </div>

      <main class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <AppHeader />

        <div class="flex min-h-0 flex-1">
          <div
            v-if="hasConnection"
            class="flex min-h-0 min-w-0 flex-1 flex-col"
            :class="previewExpanded ? 'hidden' : ''"
          >
            <ObjectList
              ref="objectList"
              @contextmenu="rowMenu"
              @background="backgroundMenu"
              @settings="openSettings"
            />
          </div>

          <div v-else class="flex flex-1 items-center justify-center p-8">
            <EmptyState
              :icon="PanelLeft"
              title="No connection selected"
              description="Pick a connection on the left, or create a new one. Each connection pins one bucket and one prefix."
              data-testid="no-connection-state"
            >
              <AppButton variant="primary" @click="createConnection">New connection</AppButton>
            </EmptyState>
          </div>

          <div
            v-if="hasConnection"
            class="relative flex min-h-0"
            :class="[
              ui.previewHidden ? 'hidden' : '',
              previewExpanded ? 'min-w-0 flex-1' : 'shrink-0',
            ]"
          >
            <PreviewPanel />
            <Resizer
              v-if="!previewExpanded"
              v-model="previewWidth"
              side="left"
              grow="left"
              :min="260"
              :max="900"
              label="Resize the preview panel"
              data-testid="resizer-preview"
              @reset="ui.resetPreviewWidth()"
            />
          </div>
        </div>

        <DropZone :enabled="connections.canWriteActive" @drop="onDrop" />
      </main>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menu.items"
      @close="menu = null"
    />

    <TransferPanel />
    <ToastStack />
    <DialogHost />

    <div class="pointer-events-none fixed bottom-0 left-0 z-10 p-1">
      <span class="sr-only">S3 Viewer</span>
    </div>
  </div>
</template>
