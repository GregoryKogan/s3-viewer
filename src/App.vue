<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import { deleteShortcut, IS_MAC, isEditableTarget, modLabel, shortcutLabel } from "@/lib/keyboard";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { useDialogsStore } from "@/stores/dialogs";
import { useToastsStore } from "@/stores/toasts";
import { useUpdatesStore } from "@/stores/updates";
import { useObjectActions } from "@/composables/useObjectActions";
import { useConnectionActions } from "@/composables/useConnectionActions";
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
const connectionActions = useConnectionActions();

const objectList = ref<InstanceType<typeof ObjectList> | null>(null);
const sidebar = ref<InstanceType<typeof AppSidebar> | null>(null);
const previewPanel = ref<InstanceType<typeof PreviewPanel> | null>(null);

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

async function copyNames(names: string[]) {
  if (!names.length) return;
  const copied = await copyText(names.join("\n"));
  if (!copied) {
    toasts.error("The clipboard is not available.");
    return;
  }
  toasts.ok(names.length === 1 ? `Copied “${names[0]}”` : `Copied ${names.length} names`);
}

function rowMenu(entry: (typeof objects.entries)[number], point: { clientX: number; clientY: number }) {
  const connection = connections.active;
  if (!connection) return;
  const writable = connections.canWriteActive;
  // ObjectList selects a right-clicked row that was outside the selection, so
  // one set backs every item (SEL-4). Every item is handed that set: a reload
  // that lands before the item runs empties the store, and an item that looked
  // the rows up again would silently do nothing.
  const targets = objects.deleteTargets.length ? objects.deleteTargets : [entry];
  const count = targets.length;
  const names = targets.map((item) => item.name);
  const transferLabel = (base: string) =>
    count > 1 ? `${base} ${count} items to…` : `${base} to…`;

  menu.value = {
    x: point.clientX,
    y: point.clientY,
    items: [
      entry.isFolder
        ? { label: "Open", icon: FolderOpen, run: () => void objects.navigate(entry.key) }
        : {
            label: "Preview",
            icon: Eye,
            run: () => {
              objects.focus(entry.key);
              void objects.previewEntry(entry, { force: true, reveal: true });
            },
          },
      {
        label: count > 1 ? `Download ${count} items` : "Download",
        icon: Download,
        shortcut: shortcutLabel("D"),
        run: () => void actions.downloadSelection(targets),
      },
      {
        label: count > 1 ? `Copy ${count} S3 URIs` : "Copy S3 URI",
        icon: Link2,
        shortcut: `${modLabel()}⇧C`,
        run: () => void actions.copySelectionUris(targets),
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
        run: () => void actions.transferSelection(false, targets),
      },
      {
        label: transferLabel("Move"),
        icon: MoveRight,
        disabled: !writable,
        run: () => void actions.transferSelection(true, targets),
      },
      {
        label: count > 1 ? `Delete ${count} items` : "Delete",
        icon: Trash2,
        danger: true,
        shortcut: deleteShortcut,
        separatorBefore: true,
        disabled: !writable,
        run: () => void actions.deleteSelection(targets),
      },
    ] as MenuItem[],
  };
}

/**
 * The two pickers the Upload button and the empty-area menu both offer.
 *
 * A native open panel cannot select files and folders at once, so the choice has
 * to come first. "⌘U" stays the one-key fast path for files.
 */
function uploadItems(): MenuItem[] {
  return [
    {
      label: "Upload files…",
      icon: Upload,
      shortcut: shortcutLabel("U"),
      run: () => void actions.upload(),
    },
    {
      label: "Upload folder…",
      icon: FolderUp,
      shortcut: `${modLabel()}⇧U`,
      run: () => void actions.uploadFolder(),
    },
  ] as MenuItem[];
}

/** The toolbar's Upload button opens the same menu, anchored under it. */
function openUploadMenu(point: { x: number; y: number }) {
  if (!connections.canWriteActive) return;
  menu.value = { x: point.x, y: point.y, items: uploadItems() };
}

function backgroundMenu(point: { clientX: number; clientY: number }) {
  const writable = connections.canWriteActive;
  menu.value = {
    x: point.clientX,
    y: point.clientY,
    items: [
      ...(writable
        ? [
            ...uploadItems(),
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

// --------------------------------------------------------------- window title

/**
 * PLT-2: the title bar, the Dock and the app switcher show where the user is.
 * The prefix is relative to the connection's scope root, which is the part the
 * user chose when saving the connection.
 */
const windowTitle = computed(() => {
  const connection = connections.active;
  if (!connection) return "S3 Viewer";
  const root = connection.prefix ?? "";
  const relative = objects.prefix.startsWith(root)
    ? objects.prefix.slice(root.length)
    : objects.prefix;
  return `${connection.name} · ${connection.bucket}/${relative}`;
});

/** The native title is best-effort; `document.title` is the guaranteed part. */
let titleRequest = 0;
async function applyWindowTitle(title: string) {
  document.title = title;
  if (!("__TAURI__" in globalThis)) return;
  const request = ++titleRequest;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // A slower import must not overwrite a title for a folder the user left.
    if (request !== titleRequest) return;
    await getCurrentWindow().setTitle(title);
  } catch {
    /* A missing capability or a plain browser still has document.title. */
  }
}

watch(windowTitle, (title) => void applyWindowTitle(title), { immediate: true });

// ---------------------------------------------------------------- connections

async function openConnection(connection: Connection) {
  // Drop the previous session's preview before the active connection moves:
  // `loadFolder` streams, and a panel still showing A's object against B would
  // offer Download/Copy URI for a key B never listed (final review C1).
  objects.clearPreview();
  connections.setActive(connection.id);
  await objects.loadFolder(connection.prefix ?? "");
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
  // `connections.save` has already replaced the active connection's bucket and
  // endpoint. A preview fetched from the old target cannot answer for the new
  // one, so it goes before the probe and the reload (final review C1).
  const editedActive = saved.id === connections.activeId;
  if (editedActive) objects.clearPreview();
  // `connections.save` already reloaded the list and dropped the stored
  // capabilities. Probe again only when this connection asks for probing at all:
  // "Detect permissions" off must mean no hidden write probe after Save.
  if (saved.security.detectPermissions) await connections.refreshCapabilities(saved.id);
  // Only the active session holds a snapshot of the edited connection. Editing
  // another connection must leave the open folder, its filter and its selection
  // exactly as they were (CON-1).
  if (editedActive) await objects.reloadSession();
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
  // The store clears the open objects session when the removed connection is
  // the active one, so the main area falls back to its empty state.
  if (!(await connectionActions.remove(connection))) return;
  await nextTick();
  // The card is gone. Land the keyboard on the remaining open card, or on the
  // New button when that was the last connection.
  if (!document.activeElement?.closest("[data-connection-card]")) {
    const target = connections.activeId
      ? document.querySelector<HTMLElement>(`[data-testid=connection-${connections.activeId}]`)
      : null;
    (target ?? document.getElementById("new-connection"))?.focus();
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

const PAGE_ROWS = 10; // fallback when the list has not reported its viewport
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
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, summary, [role="menu"], [role="menuitem"], [role="separator"]',
    ),
  );
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
  objectList.value?.focusList();
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
  // A fresh letter starts below the cursor and wraps, so repeating it walks
  // through the matches instead of staying on the first one forever.
  const start = typeAhead.length === 1 ? Math.max(0, focusedRowIndex() + 1) : 0;
  const ordered = [...rows.slice(start), ...rows.slice(0, start)];
  const found = ordered.findIndex((entry) => entry.name.toLowerCase().startsWith(typeAhead));
  if (found === -1) return;
  const entry = ordered[found];
  const index = rows.indexOf(entry);
  objects.focus(entry.key);
  objectList.value?.scrollToRow(index);
  objectList.value?.focusList();
  void objects.previewEntry(entry);
}

// A new folder or filter makes the buffered prefix meaningless.
watch(() => [objects.prefix, objects.filter], () => clearTypeAhead());

/**
 * Enter or ↓ in the filter field lands on the first match.
 *
 * The search is a find gesture: the cursor, the preview and the keyboard must
 * end up on the object that was searched for. Enter also opens it, exactly as
 * Enter does on a focused row, so filtering a folder by name and opening the
 * result never requires the mouse (KEY-4).
 */
async function onFind(open: boolean) {
  const rows = objects.visibleEntries;
  if (!rows.length) return;
  // A cursor already on a match keeps its place; anything else (no cursor, or a
  // cursor the filter just hid) starts from the first row on screen.
  const current = rows.findIndex((entry) => entry.key === objects.focusedKey);
  const index = current === -1 ? 0 : current;
  const entry = rows[index];
  objects.focus(entry.key);
  objectList.value?.scrollToRow(index);
  objectList.value?.focusList();
  if (open && entry.isFolder) await objects.navigate(entry.key);
  else await objects.previewEntry(entry, { force: open, reveal: open });
  // Opening a folder collapses an expanded preview and brings the list back;
  // the first focus call happened while that list could still be hidden.
  objectList.value?.focusList();
}

/** Escape in the field clears the filter and leaves the list owning the keys. */
function onFindClear() {
  objectList.value?.focusList();
}

/**
 * Put the keyboard in the main column. Without a connection there is no list,
 * so the placeholder's own button takes the focus instead of nothing.
 */
function focusMain() {
  if (hasConnection.value) {
    objectList.value?.focusList();
    return;
  }
  document
    .querySelector<HTMLElement>('[data-testid=no-connection-state] button')
    ?.focus();
}

/**
 * Open the object menu without a pointer.
 *
 * Shift+F10 and the dedicated ContextMenu key are the standard equivalents of a
 * right-click. With a cursor they open that row's menu; without one they open
 * the folder menu the empty area would show. The menu itself already owns its
 * arrows, Enter and Escape.
 */
async function openContextMenuFromKeyboard() {
  // A wheel-scrolled cursor row may be virtualized out; paint it before
  // measuring, then anchor the menu to the real row.
  const index = objects.visibleEntries.findIndex((entry) => entry.key === objects.focusedKey);
  if (index !== -1) objectList.value?.scrollToRow(index);
  await nextTick();
  const row = document.querySelector<HTMLElement>(".object-row[data-focused]");
  const list = document.getElementById("object-list");
  const rect = row?.getBoundingClientRect() ?? list?.getBoundingClientRect();
  const point = {
    clientX: Math.round((rect?.left ?? 0) + 32),
    clientY: Math.round((rect?.top ?? 0) + 32),
  };
  const key = objects.focusedKey;
  // Only a cursor the filter still shows may open a menu: a hidden row must
  // never be the target of a Delete the user cannot see.
  const entry = key ? objects.visibleEntries.find((item) => item.key === key) : null;
  if (!entry) {
    backgroundMenu(point);
    return;
  }
  // The same "one set backs every item" rule a right-click follows (SEL-4).
  if (!objects.selected.has(entry.key)) objects.selectOnly(entry.key);
  objects.focus(entry.key, { keepAnchor: true });
  rowMenu(entry, point);
}

async function onKeydown(event: KeyboardEvent) {
  // A nested control already handled this key (menu, resizer, PDF page).
  if (event.defaultPrevented) return;
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key;
  const lower = key.toLowerCase();
  const editing = isEditableTarget(event.target) || isEditableTarget(document.activeElement);

  // A modal owns every key: a global shortcut must not act on the inert shell
  // behind it (⌘N stacking a form on Settings, ⌘R reloading a hidden list, ⌘L
  // focusing the address bar behind the dialog). Escape never reaches here: it
  // is the top `<dialog>`'s native `cancel` event.
  if (dialogs.isOpen()) return;

  /*
   * Which column owns the keyboard.
   *
   * A zone is a column root marked with `data-focus-zone`. `null` means the
   * shell (the body, a toolbar button): it keeps the permissive behaviour the
   * app had before the columns existed, so a closing dialog that restores focus
   * to the toolbar does not turn the list keys off.
   */
  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const zoneElement = event.target instanceof HTMLElement ? event.target : activeElement;
  const zone = zoneElement?.closest("[data-focus-zone]")?.getAttribute("data-focus-zone") ?? null;
  const main = zone === "list" || zone === null;
  // Copy/download are harmless and follow the cursor, so they also work while
  // the preview has the keyboard; Delete, ⌘A and navigation stay list-only.
  const objectActions = main || zone === "preview";

  // A shell shortcut dismisses a transient menu: no command should run with a
  // popup left on screen underneath it.
  if (menu.value && meta) menu.value = null;

  // Shift is part of the binding, not a variant of it: only the explicit
  // ⌘⇧[C/N/U] shortcuts are shell bindings. Without this guard a shifted letter
  // ran the unshifted command (⌘⇧U uploaded a file, ⌘⇧N opened a connection).
  const plain = meta && !event.shiftKey;

  if (plain && lower === "r") {
    event.preventDefault();
    await objects.reload();
    return;
  }
  if (plain && lower === "u" && hasConnection.value) {
    event.preventDefault();
    await actions.upload();
    return;
  }
  if (plain && lower === "n") {
    event.preventDefault();
    await createConnection();
    return;
  }
  if (plain && lower === "b") {
    event.preventDefault();
    ui.toggleSidebar();
    return;
  }
  if (plain && lower === "i" && connections.active) {
    event.preventDefault();
    // The card under the keyboard wins: editing "the open connection" while
    // another card is focused edits the wrong one.
    const cardId = activeElement?.closest<HTMLElement>("[data-connection-card]")?.dataset
      .connectionId;
    const target = connections.all.find((item) => item.id === cardId);
    await editConnection(target ?? connections.active ?? undefined);
    return;
  }
  if (plain && lower === "l") {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>('[data-testid=address-edit]')?.click();
    return;
  }
  if (plain && lower === "f") {
    // Two searches, one key: the preview owns ⌘F when it has the keyboard and
    // can search; anywhere else ⌘F is the folder filter, as before.
    if (zone === "preview" && previewPanel.value?.showFind()) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    document.querySelector<HTMLInputElement>('[data-testid=filter-input]')?.focus();
    return;
  }
  if (plain && lower === "a" && !editing && main && hasConnection.value) {
    event.preventDefault();
    const keys = objects.visibleEntries.map((entry) => entry.key);
    objects.selectAll(keys);
    // The cursor must not vanish inside the set: Enter, Space and the next ↓ all
    // start from it, and a flat selected field otherwise has no current row.
    if (!objects.focusedKey || !keys.includes(objects.focusedKey)) {
      objects.focus(keys[0] ?? null);
    }
    objectList.value?.focusList();
    return;
  }
  // The two row actions that previously lived only in the context menu and the
  // preview header. Both act on the selection, or on the cursor row when
  // nothing is selected, exactly like the menu items.
  if (plain && lower === "d" && !editing && objectActions && hasConnection.value) {
    event.preventDefault();
    await actions.downloadSelection();
    return;
  }
  if (meta && event.shiftKey && lower === "c" && !editing && objectActions && hasConnection.value) {
    event.preventDefault();
    await actions.copySelectionUris();
    return;
  }
  // Finder's own bindings, kept for muscle memory.
  if (meta && event.shiftKey && lower === "n" && hasConnection.value) {
    event.preventDefault();
    await actions.createFolder();
    return;
  }
  if (meta && event.shiftKey && lower === "u" && hasConnection.value) {
    event.preventDefault();
    await actions.uploadFolder();
    return;
  }

  // The shell shortcuts above still work while a text field has focus (⌘R
  // refreshes a filtered list), but the list keys below would steal typed
  // characters, Space, Enter and Escape from the field.
  if (editing) return;

  // An open context menu owns the keyboard until it closes (it handles Escape
  // itself in a capture listener). Its item buttons are interactive targets, so
  // the global Delete/⌘↑ bindings must not fire behind it.
  if (menu.value) return;

  // Escape backs out one visible step, and an open find bar is the overlay on
  // the text: it goes before the panel's own layout, or collapsing an expanded
  // preview would leave the bar up and make Escape's answer depend on focus.
  if (key === "Escape" && zone === "preview" && previewPanel.value?.closeFind()) {
    event.preventDefault();
    return;
  }

  // Collapsing an expanded preview is global: the user just clicked its Expand
  // button, and Escape must not depend on where focus landed. It is also the
  // smaller, more reversible step, so only the next Escape clears the selection.
  if (key === "Escape" && previewExpanded.value) {
    event.preventDefault();
    ui.togglePreviewExpanded();
    return;
  }

  // Escape, ⌘↑ and Delete are global gestures, not list-navigation keys. They
  // must keep working when focus sits on a toolbar or dialog button, which is
  // where a closing dialog restores it; the interactive-target guard below is
  // only for keys that would otherwise scroll or activate that control.
  if (key === "Escape") {
    // Escape backs out one step. In a side column that means leaving it; only
    // the main column clears the selection, so Escape in the sidebar or the
    // preview cannot wipe a selection the user is not looking at.
    if (zone === "sidebar" || zone === "preview") {
      event.preventDefault();
      focusMain();
      return;
    }
    objects.clearSelection();
    return;
  }

  // Up-navigation owns modified ArrowUp, so it must win over list movement.
  // macOS goes up with ⌘↑; bare Backspace must not navigate there at all.
  if (main && meta && key === "ArrowUp" && objects.prefix) {
    event.preventDefault();
    await objects.navigateUp();
    return;
  }

  // ⌘⌫ (the Mac Delete key) and the forward-delete key both delete on macOS.
  const deletePressed = IS_MAC
    ? (meta && key === "Backspace") || key === "Delete"
    : key === "Delete";
  if (main && deletePressed && objects.deleteTargets.length) {
    event.preventDefault();
    await actions.deleteSelection();
    return;
  }

  // Columns: Left/Right hand the keyboard to the neighbouring pane. This runs
  // before the key-scope guard on purpose: the preview body is a scope of its
  // own (it scrolls), yet Left must still leave it. A menu, a dialog, a
  // resizer, the PDF and native media are handled elsewhere and never get here.
  if (
    (key === "ArrowLeft" || key === "ArrowRight") &&
    !meta &&
    !event.altKey &&
    !event.shiftKey
  ) {
    // A media element seeks with these arrows; the preview pane does not.
    const media = zoneElement?.closest("audio, video");
    if (!media) {
      if (zone === "list" && key === "ArrowLeft") {
        event.preventDefault();
        sidebar.value?.focusActive();
        return;
      }
      if (zone === "sidebar" && key === "ArrowRight") {
        event.preventDefault();
        // An expanded preview has hidden the list; Right must not focus a
        // display:none scroll container.
        if (previewExpanded.value) {
          ui.togglePreviewExpanded();
          await nextTick();
        }
        focusMain();
        return;
      }
      if (zone === "list" && key === "ArrowRight" && !ui.previewHidden) {
        event.preventDefault();
        previewPanel.value?.focusPanel();
        return;
      }
      if (zone === "preview" && key === "ArrowLeft") {
        // A horizontally scrollable preview keeps its own Left until it reaches
        // the left edge; otherwise a wide code line could never be read back.
        const scroller = zoneElement?.closest<HTMLElement>("[data-preview-scroll]");
        if (scroller && scroller.scrollLeft > 0) return;
        event.preventDefault();
        if (previewExpanded.value) {
          ui.togglePreviewExpanded();
          await nextTick();
        }
        objectList.value?.focusList();
        return;
      }
    }
  }

  // A key scope (PDF pages, the media player, the preview's scroll body) owns
  // every key it does not hand back; moving the list underneath it would be a
  // second, invisible response to one key (KEY-1).
  if (inKeyScope(event.target)) return;

  // The row menu and the connection menu must not be pointer-only: Shift+F10
  // and the ContextMenu key are the keyboard's right-click (KEY-5).
  if ((key === "ContextMenu" || (event.shiftKey && key === "F10")) && !meta && !event.altKey) {
    if (zone === "list") {
      event.preventDefault();
      openContextMenuFromKeyboard();
      return;
    }
    if (zone === "sidebar") {
      const card = activeElement?.closest<HTMLElement>("[data-connection-card]");
      const id = card?.dataset.connectionId;
      const connection = connections.all.find((item) => item.id === id);
      if (connection && card) {
        event.preventDefault();
        const rect = card.getBoundingClientRect();
        connectionMenu(connection, { x: Math.round(rect.right - 8), y: Math.round(rect.bottom - 8) });
        return;
      }
    }
  }

  // A key on a button, link or menu belongs to that control. Space and Enter
  // must keep their native activation there; only the list's own keys are
  // handled above and below this guard.
  if (isInteractiveTarget(event.target)) return;

  // Everything below navigates the object list, so it belongs to the main
  // column (or to the shell, where the permissive old behaviour still applies).
  if (!main) return;

  if (!IS_MAC && key === "Backspace" && !meta && objects.prefix) {
    event.preventDefault();
    await objects.navigateUp();
    return;
  }

  const rows = objects.visibleEntries;
  const current = focusedRowIndex();

  // macOS goes to the end with ⌘↓, the counterpart of Up with ⌘↑.
  if (IS_MAC && meta && key === "ArrowDown") {
    event.preventDefault();
    moveFocus(rows.length - 1);
    return;
  }

  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    const delta = key === "ArrowDown" ? 1 : -1;
    moveFocus(current === -1 ? 0 : current + delta, event.shiftKey);
    return;
  }

  if (key === "PageDown" || key === "PageUp") {
    event.preventDefault();
    const page = objectList.value?.pageRows() ?? PAGE_ROWS;
    const delta = key === "PageDown" ? page : -page;
    moveFocus(current === -1 ? 0 : current + delta, event.shiftKey);
    return;
  }

  if (key === "Home" || key === "End") {
    event.preventDefault();
    // Shift extends the range to the edge (Shift+Home / Shift+End).
    moveFocus(key === "Home" ? 0 : rows.length - 1, event.shiftKey);
    return;
  }

  if (key === "Enter" && objects.focusedKey) {
    event.preventDefault();
    const focused = objects.focusedKey;
    const entry = rows.find((item) => item.key === focused);
    if (!entry) return;
    if (entry.isFolder) await objects.navigate(entry.key);
    else await objects.previewEntry(entry, { force: true, reveal: true });
    return;
  }

  if (key === " " && objects.focusedKey) {
    // A hidden cursor is not a row the user can see, so Space must not add it
    // to a selection that then acts on screen.
    if (!objects.visibleEntries.some((entry) => entry.key === objects.focusedKey)) return;
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
    listen<ListingDoneEvent>("listing://done", (payload) => {
      // The listing is the strongest health signal: the bucket answered. A
      // superseded request says nothing about the connection now on screen.
      if (objects.onListingDone(payload) && connections.activeId) {
        connections.markHealthy(connections.activeId);
      }
    }),
  ),
  ipcSubscription(() =>
    listen<ListingErrorEvent>("listing://error", (payload) => {
      if (objects.onListingError(payload) && connections.activeId) {
        connections.markUnhealthy(connections.activeId, payload.error?.message);
      }
    }),
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
    // The native picker cannot be driven; the suite hands the chosen paths
    // straight to the same queue the picker feeds (docs/e2e-gui-testing.md §11).
    queueUploads: (paths: string[]) => actions.queueUploads(paths),
    objects,
    connections,
    toasts,
    // The suite fakes "an update is available" here instead of reaching GitHub.
    updates,
    logs: objects.logging,
    copySnippet: async () => {
      // Used by the suite to prove the clipboard path works end to end.
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
          class="max-w-full text-meta leading-relaxed break-words text-muted"
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
          ref="sidebar"
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
        <AppHeader @find="onFind" @find-clear="onFindClear" @upload-menu="openUploadMenu" />

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
              description="Pick a connection on the left, or create a new one. Each connection opens one folder in one bucket; browsing stays inside that folder."
              data-testid="no-connection-state"
            >
              <AppButton variant="primary" @click="createConnection">New connection</AppButton>
            </EmptyState>
          </div>

          <div
            v-if="hasConnection"
            class="relative flex min-h-0"
            :class="previewExpanded ? 'min-w-0 flex-1' : 'shrink-0'"
          >
            <PreviewPanel ref="previewPanel" />
            <Resizer
              v-if="!previewExpanded"
              v-model="previewWidth"
              side="left"
              grow="left"
              :min="260"
              :max="900"
              label="Resize the preview panel"
              data-testid="resizer-preview"
              @commit="ui.clampLayoutToWindow()"
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
  </div>
</template>
