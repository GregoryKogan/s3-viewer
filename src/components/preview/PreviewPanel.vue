<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from "vue";
import { ImageOff, Info } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import Spinner from "@/components/ui/Spinner.vue";
import { useObjectsStore } from "@/stores/objects";
import { useConnectionsStore } from "@/stores/connections";
import { useUiStore } from "@/stores/ui";
import { humanSize, s3Uri } from "@/lib/format";
import { kindLabel } from "@/lib/fileKind";
import { api, copyText } from "@/lib/ipc";
import { useToastsStore } from "@/stores/toasts";
import PreviewImage from "./renderers/PreviewImage.vue";
import PreviewMedia from "./renderers/PreviewMedia.vue";
import PreviewMarkdown from "./renderers/PreviewMarkdown.vue";
import PreviewCode from "./renderers/PreviewCode.vue";
import PreviewTable from "./renderers/PreviewTable.vue";

const objects = useObjectsStore();
const connections = useConnectionsStore();
const ui = useUiStore();
const toasts = useToastsStore();

const panelWidth = computed(() => "var(--preview-width)");

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
const kind = computed(() => data.value?.kind ?? "unknown");

const meta = computed(() => {
  if (!data.value) return "";
  const bits = [humanSize(data.value.size), kindLabel(kind.value)];
  if (data.value.etag) bits.push(`etag ${String(data.value.etag).slice(0, 10)}`);
  return bits.join(" · ");
});

const shownName = computed(() => {
  const key = objects.previewKey;
  if (!key) return "No selection";
  return key.endsWith("/") ? key.replace(/\/$/, "").split("/").pop() || key : key.split("/").pop() || key;
});

async function copyUri() {
  const connection = connections.active;
  if (!connection || !objects.previewKey) return;
  const uri = s3Uri(connection.bucket, objects.previewKey);
  if (await copyText(uri)) toasts.ok(`Copied ${uri}`);
  else toasts.error("The clipboard is not available.");
}

async function download() {
  const connection = connections.active;
  if (!connection || !objects.previewKey) return;
  try {
    await api.downloadObject({ connectionId: connection.id, key: objects.previewKey });
    toasts.info("Download started.", "Download");
  } catch (error) {
    toasts.error((error as Error).message, "Download failed");
  }
}

function onToggleView(view: "rendered" | "raw") {
  objects.setPreviewView(view);
}

</script>

<template>
  <aside
    class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-line bg-surface"
    :style="{ width: panelWidth }"
    id="preview"
    data-testid="preview"
  >
    <header class="flex shrink-0 items-start gap-2 border-b border-line px-3 py-2">
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-xs font-medium text-content" :title="objects.previewKey ?? ''" data-testid="preview-name">
          {{ shownName }}
        </span>
        <span v-if="meta" class="tabular text-[0.6875rem] text-subtle" data-testid="preview-meta">
          {{ meta }}
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <AppButton
          variant="ghost"
          size="sm"
          :disabled="!objects.previewKey"
          title="Copy the s3:// URI"
          id="preview-copy-uri"
          data-testid="preview-copy-uri"
          @click="copyUri"
        >
          URI
        </AppButton>
        <AppButton
          size="sm"
          :disabled="!objects.previewKey"
          data-testid="preview-download"
          @click="download"
        >
          Download
        </AppButton>
      </div>
    </header>

    <div id="preview-body" class="scrollbar flex min-h-0 flex-1 flex-col overflow-auto" data-testid="preview-body">
      <Spinner v-if="objects.previewLoading" label="Loading preview…" data-testid="preview-loading" />

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
        <div class="flex max-w-xs flex-col items-center gap-2 text-center">
          <div class="grid size-9 place-items-center rounded-full border border-line bg-surface-2 text-subtle">
            <Info class="size-4" />
          </div>
          <p class="text-xs font-medium text-content">Nothing selected</p>
          <p class="text-[0.6875rem] leading-relaxed text-muted">
            Images, audio, video and PDFs render inline. Text, Markdown, code, JSON, CSV and Parquet
            open with highlighting or as a table.
          </p>
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
          v-else-if="kind === 'audio' || kind === 'video'" :data="data" @download="download" />
        <PreviewMedia
          :key="objects.previewKey ?? 'none'"
          v-else-if="kind === 'pdf'" :data="data" />
        <PreviewMarkdown
          v-else-if="kind === 'markdown'"
          :data="data"
          :view="objects.previewView"
          @toggle-view="onToggleView"
          @download="download"
        />
        <PreviewTable
          :key="objects.previewKey ?? 'none'"
          v-else-if="kind === 'parquet' || kind === 'csv'" :data="data" @download="download" />
        <PreviewCode
          :key="objects.previewKey ?? 'none'"
          v-else :data="data" @download="download" />
      </template>
    </div>
  </aside>
</template>
