<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Minus, Plus } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();

const failed = ref(false);
/** `true` renders fit-to-panel; `false` uses the absolute `zoom` scale. */
const fitted = ref(true);
/** Absolute scale of the natural image size. */
const zoom = ref(1);
const natural = ref<{ width: number; height: number } | null>(null);
const host = ref<HTMLElement | null>(null);

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 4;
/** Matches the host's `p-3` on both sides. */
const FIT_PADDING = 24;

// A new object means a new image source; clear the per-object state with it.
watch(
  () => props.data.streamUrl,
  () => {
    failed.value = false;
    fitted.value = true;
    zoom.value = 1;
    natural.value = null;
  },
);

/**
 * The scale CSS fit actually applies: never larger than 1 (fit does not
 * upscale) and never larger than the host on either axis. Read lazily so a
 * resize or a late image load always uses current dimensions.
 */
function fitScale(): number {
  const image = natural.value;
  if (!image || image.width <= 0 || image.height <= 0) return 1;
  const availableWidth = Math.max(1, (host.value?.clientWidth ?? image.width) - FIT_PADDING);
  const availableHeight = Math.max(1, (host.value?.clientHeight ?? image.height) - FIT_PADDING);
  return Math.max(
    ZOOM_MIN,
    Math.min(1, availableWidth / image.width, availableHeight / image.height),
  );
}

const zoomLabel = computed(() =>
  fitted.value ? "Fit" : `${Math.round(zoom.value * 100)}%`,
);

/** Fit leaves sizing to CSS; a zoom writes pixels so the host can scroll. */
const imageStyle = computed(() => {
  const image = natural.value;
  if (fitted.value || !image || image.width <= 0 || image.height <= 0) return undefined;
  return {
    width: `${Math.max(1, Math.round(image.width * zoom.value))}px`,
    height: `${Math.max(1, Math.round(image.height * zoom.value))}px`,
  };
});

function onLoad(event: Event) {
  const image = event.target as HTMLImageElement;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  // A zero-sized decode would make every percentage pin the image at 0×0.
  if (!width || !height) {
    natural.value = null;
    return;
  }
  natural.value = { width, height };
  // Keep the absolute scale in step with what fit is currently showing.
  if (fitted.value) zoom.value = fitScale();
}

/** Leave fit at the scale currently on screen, then step from there. */
function stepZoom(delta: number) {
  const base = fitted.value ? fitScale() : zoom.value;
  fitted.value = false;
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, base + delta));
}

/** Clicking the image (or the percentage) swaps between fit and 100%. */
function toggleFit() {
  if (fitted.value) {
    fitted.value = false;
    zoom.value = 1;
  } else {
    fitted.value = true;
    zoom.value = fitScale();
  }
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
        @click="stepZoom(-0.25)"
      />
      <button
        type="button"
        class="tabular min-w-11 rounded-control px-1 py-0.5 text-[0.6875rem] text-muted transition-colors hover:bg-hover hover:text-content"
        :title="fitted ? 'Show at 100%' : 'Fit to the panel'"
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
        @click="stepZoom(0.25)"
      />
    </div>

    <div v-if="failed" class="p-4 text-[0.6875rem] leading-relaxed text-muted">
      This image cannot be rendered by the webview — the format may be unsupported.
      Download the file and open it locally.
    </div>

    <div v-else ref="host" class="scrollbar flex min-h-0 flex-1 overflow-auto p-3">
      <img
        :src="props.data.streamUrl"
        :alt="props.data.key"
        class="m-auto block shrink-0 rounded-control object-contain"
        :class="fitted ? 'max-h-full max-w-full cursor-zoom-in' : 'max-w-none cursor-zoom-out'"
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
