<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Minus, Plus } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();

const failed = ref(false);
/** `true` means a fixed percentage of the natural size; `false` means fit. */
const zoomed = ref(false);
const zoom = ref(1);
const natural = ref<{ width: number; height: number } | null>(null);

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;

// A new object means a new image source; clear the per-object state with it.
watch(
  () => props.data.streamUrl,
  () => {
    failed.value = false;
    zoomed.value = false;
    zoom.value = 1;
    natural.value = null;
  },
);

const zoomLabel = computed(() =>
  zoomed.value ? `${Math.round(zoom.value * 100)}%` : "Fit",
);

/** Fit leaves sizing to CSS; a zoom sets explicit pixels so the host scrolls. */
const imageStyle = computed(() => {
  if (!zoomed.value || !natural.value) return undefined;
  return {
    width: `${Math.round(natural.value.width * zoom.value)}px`,
    height: `${Math.round(natural.value.height * zoom.value)}px`,
  };
});

function onLoad(event: Event) {
  const image = event.target as HTMLImageElement;
  natural.value = { width: image.naturalWidth, height: image.naturalHeight };
}

function setZoom(next: number) {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  zoomed.value = true;
}

/** Clicking the image (or the percentage) swaps between fit and 100%. */
function toggleFit() {
  if (zoomed.value) {
    zoomed.value = false;
    return;
  }
  zoom.value = 1;
  zoomed.value = true;
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      v-if="!failed"
      class="absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-control border border-line bg-surface/90 p-0.5 shadow-sm"
    >
      <AppButton
        size="sm"
        variant="ghost"
        :icon="Minus"
        aria-label="Zoom out"
        title="Zoom out"
        data-testid="preview-image-zoom-out"
        @click="setZoom((zoomed ? zoom : 1) - 0.25)"
      />
      <button
        type="button"
        class="tabular min-w-11 rounded-control px-1 py-0.5 text-[0.6875rem] text-muted transition-colors hover:bg-hover hover:text-content"
        :title="zoomed ? 'Fit to the panel' : 'Show at 100%'"
        data-testid="preview-image-zoom"
        @click="toggleFit()"
      >
        {{ zoomLabel }}
      </button>
      <AppButton
        size="sm"
        variant="ghost"
        :icon="Plus"
        aria-label="Zoom in"
        title="Zoom in"
        data-testid="preview-image-zoom-in"
        @click="setZoom((zoomed ? zoom : 1) + 0.25)"
      />
    </div>

    <div v-if="failed" class="p-4 text-[0.6875rem] leading-relaxed text-muted">
      This image cannot be rendered by the webview — the format may be unsupported.
      Download the file and open it locally.
    </div>

    <div v-else class="scrollbar flex min-h-0 flex-1 overflow-auto p-3">
      <img
        :src="props.data.streamUrl"
        :alt="props.data.key"
        class="m-auto block rounded-control object-contain"
        :class="zoomed ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in'"
        :style="imageStyle"
        draggable="false"
        data-testid="preview-image"
        @load="onLoad"
        @click="toggleFit()"
        @error="failed = true"
      />
    </div>
  </div>
</template>
