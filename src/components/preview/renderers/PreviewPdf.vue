<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from "@lucide/vue";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import AppButton from "@/components/ui/AppButton.vue";
import Spinner from "@/components/ui/Spinner.vue";
import { shortcutLabel } from "@/lib/keyboard";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const canvas = ref<HTMLCanvasElement | null>(null);
const scrollHost = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const pageNumber = ref(1);
const pageCount = ref(0);
const zoom = ref(1);
const fitWidth = ref(true);

/** Typed loosely: the pdf.js types live in a subpath that the bundler resolves. */
type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;

let documentHandle: PdfDocument | null = null;
let renderTask: { cancel: () => void } | null = null;

const canZoomOut = computed(() => zoom.value > 0.25);
const canZoomIn = computed(() => zoom.value < 6);

async function render() {
  const doc = documentHandle;
  const element = canvas.value;
  if (!doc || !element) return;

  renderTask?.cancel();
  const page: PdfPage = await doc.getPage(pageNumber.value);

  // Fit-to-width is measured from the scroll host, so the page fills the panel
  // rather than an arbitrary default size.
  const base = page.getViewport({ scale: 1 });
  const host = scrollHost.value;
  const available = host ? host.clientWidth - 24 : base.width;
  const scale = fitWidth.value ? Math.max(0.25, available / base.width) : zoom.value;
  if (fitWidth.value) zoom.value = scale;

  const viewport = page.getViewport({ scale });
  const ratio = globalThis.devicePixelRatio || 1;
  element.width = Math.floor(viewport.width * ratio);
  element.height = Math.floor(viewport.height * ratio);
  element.style.width = `${Math.floor(viewport.width)}px`;
  element.style.height = `${Math.floor(viewport.height)}px`;

  const context = element.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const task = page.render({ canvasContext: context, viewport, canvas: element });
  renderTask = task;
  try {
    await task.promise;
  } catch (caught) {
    // Cancelling a render is normal when zooming quickly.
    if ((caught as Error)?.name !== "RenderingCancelledException") {
      error.value = (caught as Error)?.message ?? String(caught);
    }
  }
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    documentHandle = await pdfjs.getDocument({
      url: props.data.streamUrl,
      // Ranged reads: only the pages being looked at are fetched.
      disableRange: false,
      disableStream: false,
    }).promise;
    pageCount.value = documentHandle.numPages;
    pageNumber.value = 1;
    await render();
  } catch (caught) {
    error.value = (caught as Error)?.message ?? String(caught);
  } finally {
    loading.value = false;
  }
}

function setZoom(next: number) {
  fitWidth.value = false;
  zoom.value = Math.min(6, Math.max(0.25, next));
  void render();
}

function zoomBy(step: number) {
  setZoom(zoom.value + step);
}

function fit() {
  fitWidth.value = true;
  void render();
}

async function goTo(page: number) {
  if (page < 1 || page > pageCount.value || page === pageNumber.value) return;
  pageNumber.value = page;
  await render();
}

function onKeydown(event: KeyboardEvent) {
  // A hidden panel keeps its DOM. Without this guard the PDF would still page
  // through ArrowLeft/ArrowRight while the list is out of sight (PRV-4).
  const host = event.currentTarget;
  if (host instanceof HTMLElement && host.offsetParent === null) return;

  if (event.metaKey || event.ctrlKey) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      event.stopPropagation();
      zoomBy(0.25);
    } else if (event.key === "-") {
      event.preventDefault();
      event.stopPropagation();
      zoomBy(-0.25);
    }
    return;
  }
  if (event.key === "ArrowRight" || event.key === "PageDown") {
    event.preventDefault();
    event.stopPropagation();
    void goTo(pageNumber.value + 1);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "PageUp") {
    event.preventDefault();
    event.stopPropagation();
    void goTo(pageNumber.value - 1);
  }
}

let observer: ResizeObserver | undefined;

onMounted(() => {
  void load();
  if (scrollHost.value) {
    observer = new ResizeObserver(() => {
      if (fitWidth.value) void render();
    });
    observer.observe(scrollHost.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  renderTask?.cancel();
  // v6 keeps `destroy` but its type surface varies by build; call it defensively.
  void (documentHandle as unknown as { destroy?: () => Promise<void> })?.destroy?.();
});

watch(() => props.data.streamUrl, () => void load());
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
      <AppButton size="sm" variant="ghost" :icon="Minus" :disabled="!canZoomOut" :title="`Zoom out (${shortcutLabel('-')})`" data-testid="pdf-zoom-out" @click="zoomBy(-0.25)" />
      <button
        type="button"
        class="tabular min-w-11 rounded-control px-1 py-0.5 text-meta text-muted transition-colors hover:bg-hover hover:text-content"
        title="Reset to 100%"
        data-testid="pdf-zoom"
        @click="setZoom(1)"
      >
        {{ Math.round(zoom * 100) }}%
      </button>
      <AppButton size="sm" variant="ghost" :icon="Plus" :disabled="!canZoomIn" :title="`Zoom in (${shortcutLabel('+')})`" data-testid="pdf-zoom-in" @click="zoomBy(0.25)" />
      <AppButton size="sm" variant="ghost" :icon="Maximize2" title="Fit the panel width" @click="fit" />

      <span class="mx-1 h-4 w-px bg-line" />

      <AppButton size="sm" variant="ghost" :icon="ChevronLeft" :disabled="pageNumber <= 1" @click="goTo(pageNumber - 1)" />
      <span class="tabular text-meta text-muted" data-testid="pdf-page">
        {{ pageNumber }} / {{ pageCount || "…" }}
      </span>
      <AppButton
        size="sm"
        variant="ghost"
        :icon="ChevronRight"
        :disabled="pageNumber >= pageCount"
        @click="goTo(pageNumber + 1)"
      />
    </div>

    <div
      ref="scrollHost"
      class="scrollbar min-h-0 flex-1 overflow-auto bg-inset p-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      tabindex="0"
      aria-label="PDF pages"
      data-keyscope
      @keydown="onKeydown"
    >
      <Spinner v-if="loading" label="Loading the document…" />
      <p v-else-if="error" class="p-3 text-meta leading-relaxed text-danger">
        This PDF could not be rendered: {{ error }}
      </p>
      <canvas
        v-show="!loading && !error"
        ref="canvas"
        class="mx-auto block rounded-[2px] bg-white shadow-lg shadow-black/30"
        data-testid="preview-pdf"
      />
    </div>
  </div>
</template>
