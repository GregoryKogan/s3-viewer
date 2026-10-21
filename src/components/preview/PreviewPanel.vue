<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import {
  Copy,
  Download,
  Folder,
  FolderOpen,
  ImageOff,
  Info,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  X,
} from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import Spinner from "@/components/ui/Spinner.vue";
import ErrorNotice from "@/components/ui/ErrorNotice.vue";
import { useObjectsStore } from "@/stores/objects";
import { useConnectionsStore } from "@/stores/connections";
import { usePreviewFindStore } from "@/stores/previewFind";
import { useUiStore } from "@/stores/ui";
import { useToastsStore } from "@/stores/toasts";
import { useObjectActions } from "@/composables/useObjectActions";
import { humanDate, humanSize, leafName, s3Uri } from "@/lib/format";
import { kindLabel } from "@/lib/fileKind";
import { isPreviewSearchable } from "@/lib/previewText";
import { copyText } from "@/lib/ipc";
import { keyLabel, shortcutLabel } from "@/lib/keyboard";
import PreviewImage from "./renderers/PreviewImage.vue";
import PreviewMedia from "./renderers/PreviewMedia.vue";
/** Loaded on demand: the PDF engine is large and most previews never need it. */
const PreviewPdf = defineAsyncComponent(() => import("./renderers/PreviewPdf.vue"));
import PreviewMarkdown from "./renderers/PreviewMarkdown.vue";
import PreviewCode from "./renderers/PreviewCode.vue";
import PreviewTable from "./renderers/PreviewTable.vue";

const objects = useObjectsStore();
const connections = useConnectionsStore();
const find = usePreviewFindStore();
const ui = useUiStore();
const toasts = useToastsStore();
const actions = useObjectActions();

/**
 * Expanded, the panel takes the main area and must not carry its own width.
 * Gated on a preview key: a stale flag with nothing to show would otherwise hide
 * the object list behind an empty panel.
 */
const expanded = computed(
  () => ui.previewExpanded && Boolean(objects.previewKey) && !ui.previewHidden,
);
const panelWidth = computed(() => (expanded.value ? null : "var(--preview-width)"));

const body = ref<HTMLElement | null>(null);

/**
 * A hidden panel defers the fetch and keeps the key. Any route back to
 * visibility must fetch it: the header button, but also the automatic reveal
 * when a narrow window widens again, which nobody clicked (PRV-4).
 *
 * The find bar is transient UI over the text, so hiding the column closes it;
 * the query and the options survive, so ⌘F restores the search in one step.
 */
watch(
  () => ui.previewHidden,
  (hidden) => {
    if (hidden) {
      find.hide();
      return;
    }
    void objects.refreshPreview();
  },
);

const data = computed(() => objects.preview);
const isFolder = computed(() => Boolean(objects.previewKey?.endsWith("/")));
const isMarkdown = computed(() => data.value?.kind === "markdown");
const folderEntry = computed(() => objects.folderMeta);

const kind = computed(() => data.value?.kind ?? (isFolder.value ? "folder" : "unknown"));
// An unavailable preview has no body at all, so there is nothing to search and
// `⌘F` must fall through to the folder filter instead of opening a bar nowhere.
const canFind = computed(
  () => !objects.previewUnavailable && isPreviewSearchable(kind.value, objects.previewView),
);

/** One line for every kind: size · kind · last modified. No truncated ETag (PRV-10). */
const meta = computed(() => {
  if (isFolder.value) {
    // A folder has no payload, but its listing entry may carry a marker date.
    return [
      humanSize(folderEntry.value?.size ?? 0),
      kindLabel("folder"),
      humanDate(folderEntry.value?.lastModified),
    ].join(" · ");
  }
  if (!data.value) return "";
  const bits = [humanSize(data.value.size), kindLabel(data.value.kind)];
  if (data.value.lastModified) bits.push(humanDate(data.value.lastModified));
  return bits.join(" · ");
});

/** The leaf name; the full key is the name's tooltip and the folder card's path. */
const shownName = computed(() => {
  const key = objects.previewKey;
  if (!key) return "No selection";
  return leafName(key);
});

const shortcuts = [
  { keys: `${keyLabel("ArrowUp")} ${keyLabel("ArrowDown")}`, label: "Preview" },
  { keys: keyLabel("Enter"), label: "Open" },
  { keys: `${keyLabel("ArrowLeft")} ${keyLabel("ArrowRight")}`, label: "Columns" },
  { keys: shortcutLabel("F"), label: "Filter" },
];

/**
 * Downloads go through the shared action so "ask where to save" applies here
 * too (PRV-1); the panel does not call the IPC command directly. A folder is
 * downloaded as a tree below the chosen parent, not as one object.
 */
function download() {
  const key = objects.previewKey;
  if (!key) return;
  if (isFolder.value) void actions.downloadFolderKey(key);
  else void actions.downloadKey(key, leafName(key));
}

async function copyUri() {
  const connection = connections.active;
  const key = objects.previewKey;
  if (!connection || !key) return;
  const uri = s3Uri(connection.bucket, key);
  if (await copyText(uri)) toasts.ok(`Copied ${uri}`);
  else toasts.error("The clipboard is not available.");
}

function openFolder() {
  const key = objects.previewKey;
  if (key?.endsWith("/")) void objects.navigate(key);
}

function onToggleView(view: "rendered" | "raw") {
  objects.previewView = view;
}

/** Closing the column puts the keyboard back on the list it was hiding. */
async function closePanel() {
  ui.togglePreview();
  await nextTick();
  document.getElementById("object-list")?.focus({ preventScroll: true });
}

/**
 * Hand the keyboard to the preview column: the shell's Left/Right zone
 * navigation calls this. The renderer's own scroller is what actually scrolls
 * (code, markdown, tables, a zoomed image, PDF pages); the body is the fallback.
 */
function focusPanel() {
  const target = body.value?.querySelector<HTMLElement>("[data-preview-scroll]") ?? body.value;
  target?.focus({ preventScroll: true });
}

/**
 * The two entry points into find-in-file: the header button and the preview's
 * `⌘F`. The return value is what tells `⌘F` whether it owns the key.
 */
function showFind() {
  if (!canFind.value) return false;
  find.show();
  return true;
}

/**
 * Escape in the preview column lands here: hiding is the panel's decision, while
 * the text body's `find.open` watcher repaints away the marks. The header button
 * and `⌘F` go to `showFind()` instead, and the bar's own close button stays
 * inside the body, which hides and focuses the scroller without asking the panel.
 */
function closeFind() {
  if (!find.open) return false;
  find.hide();
  focusPanel();
  return true;
}

/**
 * A query belongs to the object it was typed on, and a bar left over from a
 * closed preview or another view must not survive the switch. Switching
 * Rendered ↔ Raw closes it and does not reopen it: `⌘F` is one keystroke away.
 */
watch(
  () => objects.previewKey,
  () => {
    find.resetQuery();
    find.hide();
  },
);
watch(canFind, (searchable) => {
  if (!searchable) find.hide();
});

defineExpose({ focusPanel, showFind, closeFind });
</script>

<template>
  <aside
    class="flex h-full min-h-0 flex-col overflow-hidden border-l border-line bg-surface"
    :class="expanded ? 'min-w-0 flex-1' : 'shrink-0'"
    :style="panelWidth ? { width: panelWidth } : undefined"
    id="preview"
    data-testid="preview"
    data-focus-zone="preview"
  >
    <header class="flex shrink-0 items-start gap-2 border-b border-line px-3 py-2">
      <div class="flex min-w-0 flex-1 flex-col">
        <span
          class="truncate text-xs font-medium text-content"
          :title="objects.previewKey ?? ''"
          data-testid="preview-name"
        >
          {{ shownName }}
        </span>
        <span
          v-if="meta"
          class="tabular truncate text-meta text-subtle"
          :title="objects.previewKey ?? ''"
          data-testid="preview-meta"
        >
          {{ meta }}
        </span>
      </div>

      <div v-if="objects.previewKey" class="flex shrink-0 items-center gap-0.5">
        <AppButton
          v-if="!isFolder && canFind"
          size="sm"
          variant="ghost"
          :icon="Search"
          aria-label="Find in file"
          title="Find in file (⌘F)"
          data-testid="preview-find"
          @click="showFind()"
        />
        <div
          v-if="isMarkdown"
          class="mr-1 flex items-center rounded-control border border-line p-0.5"
        >
          <button
            type="button"
            class="rounded-[4px] px-1.5 py-0.5 text-meta transition-colors"
            :class="objects.previewView === 'rendered' ? 'bg-accent text-white' : 'text-muted hover:bg-hover'"
            :aria-pressed="objects.previewView === 'rendered'"
            data-testid="md-view-rendered"
            @click="onToggleView('rendered')"
          >
            Rendered
          </button>
          <button
            type="button"
            class="rounded-[4px] px-1.5 py-0.5 text-meta transition-colors"
            :class="objects.previewView === 'raw' ? 'bg-accent text-white' : 'text-muted hover:bg-hover'"
            :aria-pressed="objects.previewView === 'raw'"
            data-testid="md-view-raw"
            @click="onToggleView('raw')"
          >
            Raw
          </button>
        </div>

        <AppButton
          v-if="!isFolder"
          size="sm"
          variant="ghost"
          :icon="RefreshCw"
          :busy="objects.previewLoading"
          aria-label="Refresh preview"
          title="Refresh preview"
          data-testid="preview-refresh"
          @click="objects.refreshPreview()"
        />
        <AppButton
          size="sm"
          variant="ghost"
          :icon="Download"
          aria-label="Download"
          title="Download"
          data-testid="preview-download"
          @click="download()"
        />
        <AppButton
          v-if="isFolder"
          size="sm"
          variant="ghost"
          :icon="FolderOpen"
          aria-label="Open folder"
          title="Open folder"
          data-testid="preview-open-folder"
          @click="openFolder()"
        />
        <AppButton
          v-if="!isFolder"
          size="sm"
          variant="ghost"
          :icon="expanded ? Minimize2 : Maximize2"
          :aria-label="expanded ? 'Collapse preview' : 'Expand preview'"
          :title="expanded ? 'Collapse preview' : 'Expand preview'"
          :aria-pressed="expanded"
          data-testid="preview-expand"
          @click="ui.togglePreviewExpanded()"
        />
      </div>

      <AppButton
        size="sm"
        variant="ghost"
        :icon="X"
        aria-label="Close preview"
        title="Close preview"
        data-testid="preview-close"
        @click="closePanel"
      />
    </header>

    <div
      id="preview-body"
      ref="body"
      tabindex="-1"
      data-keyscope
      class="scrollbar flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid="preview-body"
    >
      <!-- A refresh of the same key keeps its content on screen; only a new
           object (or the first load) shows the full loading state. -->
      <Spinner
        v-if="objects.previewLoading && !data"
        label="Loading preview…"
        data-testid="preview-loading"
      />

      <div v-else-if="objects.previewError" class="p-4" data-testid="preview-unavailable">
        <div class="flex items-start gap-2">
          <ImageOff class="mt-0.5 size-4 shrink-0 text-danger" />
          <ErrorNotice
            class="min-w-0 flex-1"
            title="Preview unavailable"
            :message="objects.previewError"
            :hints="objects.previewErrorDetail?.hints"
            :code="objects.previewErrorDetail?.code"
            :request-id="objects.previewErrorDetail?.requestId"
            :retry="objects.refreshPreview"
          />
        </div>
      </div>

      <div v-else-if="!objects.previewKey" class="flex flex-1 items-center justify-center p-6" data-testid="preview-empty">
        <div class="flex max-w-xs flex-col items-center gap-3 text-center">
          <div class="grid size-9 place-items-center rounded-full border border-line bg-surface-2 text-subtle">
            <Info class="size-4" />
          </div>
          <p class="text-xs font-medium text-content">Select a file to preview it here.</p>
          <ul class="flex w-full flex-col gap-1.5" aria-label="Preview shortcuts">
            <li
              v-for="shortcut in shortcuts"
              :key="shortcut.label"
              class="flex items-center justify-between gap-4 text-meta text-muted"
            >
              <kbd class="rounded-[4px] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-meta text-content">
                {{ shortcut.keys }}
              </kbd>
              <span>{{ shortcut.label }}</span>
            </li>
          </ul>
        </div>
      </div>

      <div
        v-else-if="isFolder"
        class="flex flex-1 flex-col items-center justify-center gap-3 p-6"
        data-testid="preview-folder"
      >
        <div class="grid size-10 place-items-center rounded-control border border-line bg-surface-2 text-subtle">
          <Folder class="size-5" />
        </div>
        <div class="flex min-w-0 max-w-full flex-col items-center gap-1 text-center">
          <p class="max-w-full truncate text-xs font-medium text-content">{{ shownName }}</p>
          <p
            class="scrollbar max-w-full overflow-x-auto font-mono text-meta whitespace-nowrap text-subtle"
            :title="objects.previewKey ?? ''"
          >
            {{ objects.previewKey }}
          </p>
          <p v-if="folderEntry" class="tabular text-meta text-subtle">
            {{ humanDate(folderEntry.lastModified) }}
          </p>
        </div>
        <div class="flex items-center gap-1.5">
          <AppButton
            size="sm"
            :icon="Copy"
            aria-label="Copy s3:// URI"
            title="Copy s3:// URI"
            data-testid="preview-folder-copy-uri"
            @click="copyUri()"
          >
            Copy s3://
          </AppButton>
          <AppButton
            size="sm"
            variant="primary"
            :icon="FolderOpen"
            aria-label="Open folder"
            title="Open folder"
            data-testid="preview-folder-open"
            @click="openFolder()"
          >
            Open folder
          </AppButton>
        </div>
      </div>

      <div v-else-if="objects.previewUnavailable" class="p-4" data-testid="preview-unavailable">
        <div class="flex items-start gap-2">
          <ImageOff class="mt-0.5 size-4 shrink-0 text-warn" />
          <div class="flex flex-col gap-1">
            <p class="text-xs font-medium text-content">Preview unavailable</p>
            <p class="text-meta leading-relaxed text-muted">{{ objects.previewUnavailable }}</p>
          </div>
        </div>
      </div>

      <template v-else-if="data">
        <PreviewImage
          :key="objects.previewKey ?? 'none'"
          v-if="kind === 'image'" :data="data" />
        <PreviewMedia
          :key="objects.previewKey ?? 'none'"
          v-else-if="kind === 'audio' || kind === 'video'" :data="data" />
        <PreviewPdf
          :key="objects.previewKey ?? 'none'"
          v-else-if="kind === 'pdf'"
          :data="data"
        />
        <PreviewMarkdown
          v-else-if="kind === 'markdown'"
          :data="data"
          :view="objects.previewView"
        />
        <PreviewTable
          :key="objects.previewKey ?? 'none'"
          v-else-if="kind === 'parquet' || kind === 'csv'" :data="data" />
        <PreviewCode
          :key="objects.previewKey ?? 'none'"
          v-else :data="data" />
      </template>

      <!-- One banner for every renderer: the switch above is exclusive, so the
           text payload is shown by exactly one of them. The payload check
           matters: the backend also flags media over HEAD_LIMIT as truncated
           while the renderer streams the whole object. An unavailable preview
           shows its own reason instead. Rendered Markdown, which has no body of
           its own, gets the warning here too. -->
      <p
        v-if="objects.preview?.truncated && objects.preview?.text != null && !objects.previewUnavailable"
        class="shrink-0 border-t border-line bg-warn/10 px-3 py-1.5 text-meta text-warn"
        data-testid="preview-truncated"
      >
        Showing only the beginning of the file.
      </p>
    </div>
  </aside>
</template>
