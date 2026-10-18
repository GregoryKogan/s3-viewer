<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Copy,
  Download,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Link2,
  MoveRight,
  PanelLeft,
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
import ContextMenu, { type MenuItem } from "@/components/ui/ContextMenu.vue";
import ConnectionDialog from "@/components/dialogs/ConnectionDialog.vue";
import SettingsDialog from "@/components/dialogs/SettingsDialog.vue";
import UpdateDialog from "@/components/dialogs/UpdateDialog.vue";
import ImportDialog from "@/components/dialogs/ImportDialog.vue";
import { copyText, listen } from "@/lib/ipc";
import { clamp } from "@/lib/format";
import { IS_MAC, isEditableTarget, shortcutLabel } from "@/lib/keyboard";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { useDialogsStore } from "@/stores/dialogs";
import { useToastsStore } from "@/stores/toasts";
import { useUpdatesStore } from "@/stores/updates";
import { useObjectActions } from "@/composables/useObjectActions";
import type {
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

const objectList = ref<InstanceType<typeof ObjectList> | null>(null);

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
  );
  if (!saved) return;
  await connections.load();
  await openConnection(saved);
}

async function editConnection() {
  const current = connections.active;
  if (!current) return;
  const saved = await dialogs.open<Connection | null>(
    ConnectionDialog,
    (settle) => ({ connection: current, resolve: settle }),
    "wide",
  );
  await connections.load();
  if (!saved) return;
  // The open session holds a snapshot; re-open it so new settings take effect.
  connections.setActive(saved.id);
  await objects.reloadSession();
}

async function openSettings() {
  await dialogs.open(SettingsDialog, (settle) => ({ resolve: settle }), "normal");
  // Nothing about the folder changed, so there is nothing to re-list.
}

async function openImport() {
  const imported = await dialogs.open<number>(ImportDialog, (settle) => ({ resolve: settle }), "normal");
  if (!imported) return;
  await connections.load();
  const first = connections.all[0];
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
  if (dialogs.isOpen() || editing || isInteractiveTarget(event.target)) return;

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

// -------------------------------------------------------------------- listing

onMounted(async () => {
  await ui.load();
  await connections.load();
  progress.start();

  unsubscribers.push(
    await listen<ListingPageEvent>("listing://page", (payload) => objects.onListingPage(payload)),
    await listen<ListingDoneEvent>("listing://done", (payload) => objects.onListingDone(payload)),
    await listen<ListingErrorEvent>("listing://error", (payload) => objects.onListingError(payload)),
  );

  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", () => ui.clampLayoutToWindow());

  // The first connection opens automatically, which is what a returning user
  // expects: one click less before they can see their files.
  const first = connections.all[0];
  if (first) await openConnection(first);

  // The e2e scenario drives the UI through this surface.
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

  // Deliberately after the ready flag: the e2e harness should never race a
  // network request, and in practice no release is newer than a local build.
  window.setTimeout(() => void checkForUpdates(), 2500);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  clearTypeAhead();
  for (const unsubscribe of unsubscribers) unsubscribe();
  progress.stop();
});

function onDrop(paths: string[]) {
  void actions.uploadPaths(paths);
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-bg" data-testid="app">
    <div class="flex min-h-0 flex-1">
      <div class="relative flex min-h-0 shrink-0" :style="{ width: ui.layout.collapsed ? undefined : `${sidebarWidth}px` }">
        <AppSidebar
          @create="createConnection"
          @open="openConnection"
          @contextmenu="(connection) => { connections.setActive(connection.id); editConnection(); }"
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
          <div v-if="hasConnection" class="flex min-h-0 min-w-0 flex-1 flex-col">
            <ObjectList ref="objectList" @contextmenu="rowMenu" @background="backgroundMenu" />
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

          <div v-if="hasConnection" class="relative flex min-h-0 shrink-0" :class="ui.previewHidden ? 'hidden' : ''">
            <PreviewPanel />
            <Resizer
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

        <DropZone @drop="onDrop" />
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
