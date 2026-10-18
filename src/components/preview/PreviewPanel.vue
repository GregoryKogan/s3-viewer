<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watchEffect } from "vue";
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
  X,
} from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import Spinner from "@/components/ui/Spinner.vue";
import { useObjectsStore } from "@/stores/objects";
import { useConnectionsStore } from "@/stores/connections";
import { useUiStore } from "@/stores/ui";
import { useToastsStore } from "@/stores/toasts";
import { useObjectActions } from "@/composables/useObjectActions";
import { humanDate, humanSize, leafName, s3Uri } from "@/lib/format";
import { kindLabel } from "@/lib/fileKind";
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

/**
 * The aside owns its own visibility attribute.
 *
 * `v-if` alone left the element on screen during a re-render; writing the
 * attribute here means the DOM cannot outlive the store value.
 */
const aside = ref<HTMLElement | null>(null);
watchEffect(() => {
  if (aside.value) aside.value.hidden = ui.previewHidden;
});
onMounted(() => {
  if (aside.value) aside.value.hidden = ui.previewHidden;
});

const data = computed(() => objects.preview);
const isFolder = computed(() => Boolean(objects.previewKey?.endsWith("/")));
const isMarkdown = computed(() => data.value?.kind === "markdown");
const folderEntry = computed(() => objects.folderMeta);

const kind = computed(() => data.value?.kind ?? (isFolder.value ? "folder" : "unknown"));

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
  { keys: shortcutLabel("F"), label: "Filter" },
];

/**
 * Downloads go through the shared action so "ask where to save" applies here
 * too (PRV-1); the panel does not call the IPC command directly.
 */
function download() {
  const key = objects.previewKey;
  if (!key || isFolder.value) return;
  void actions.downloadKey(key, leafName(key));
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
  objects.setPreviewView(view);
}
</script>

<template>
  <aside
    class="flex h-full min-h-0 flex-col overflow-hidden border-l border-line bg-surface"
    :class="expanded ? 'min-w-0 flex-1' : 'shrink-0'"
    :style="panelWidth ? { width: panelWidth } : undefined"
    id="preview"
    data-testid="preview"
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
          class="tabular truncate text-[0.6875rem] text-subtle"
          :title="objects.previewKey ?? ''"
          data-testid="preview-meta"
        >
          {{ meta }}
        </span>
      </div>

      <div v-if="objects.previewKey" class="flex shrink-0 items-center gap-0.5">
        <div
          v-if="isMarkdown"
          class="mr-1 flex items-center rounded-control border border-line p-0.5"
        >
          <button
            type="button"
            class="rounded-[4px] px-1.5 py-0.5 text-[0.6875rem] transition-colors"
            :class="objects.previewView === 'rendered' ? 'bg-accent text-white' : 'text-muted hover:bg-hover'"
            data-testid="md-view-rendered"
            @click="onToggleView('rendered')"
          >
            Rendered
          </button>
          <button
            type="button"
            class="rounded-[4px] px-1.5 py-0.5 text-[0.6875rem] transition-colors"
            :class="objects.previewView === 'raw' ? 'bg-accent text-white' : 'text-muted hover:bg-hover'"
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
          v-if="!isFolder"
          size="sm"
          variant="ghost"
          :icon="Download"
          aria-label="Download"
          title="Download"
          data-testid="preview-download"
          @click="download()"
        />
        <AppButton
          size="sm"
          variant="ghost"
          :icon="Copy"
          aria-label="Copy s3:// URI"
          title="Copy s3:// URI"
          data-testid="preview-copy-uri"
          @click="copyUri()"
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
        @click="ui.togglePreview()"
      />
    </header>

    <div id="preview-body" class="scrollbar flex min-h-0 flex-1 flex-col overflow-auto" data-testid="preview-body">
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
          <div class="flex flex-col gap-1">
            <p class="text-xs font-medium text-content">Preview unavailable</p>
            <p class="text-[0.6875rem] leading-relaxed text-muted">{{ objects.previewError }}</p>
          </div>
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
              class="flex items-center justify-between gap-4 text-[0.6875rem] text-muted"
            >
              <kbd class="rounded-[4px] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[0.6875rem] text-content">
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
            class="scrollbar max-w-full overflow-x-auto font-mono text-[0.6875rem] whitespace-nowrap text-subtle"
            :title="objects.previewKey ?? ''"
          >
            {{ objects.previewKey }}
          </p>
          <p v-if="folderEntry" class="tabular text-[0.6875rem] text-subtle">
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
            <p class="text-[0.6875rem] leading-relaxed text-muted">{{ objects.previewUnavailable }}</p>
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
    </div>
  </aside>
</template>
