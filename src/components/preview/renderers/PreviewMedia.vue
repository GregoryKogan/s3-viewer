<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PreviewData } from "@/types";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{ data: PreviewData }>();

const ui = useUiStore();
const media = ref<HTMLMediaElement | null>(null);

const isAudio = computed(() => props.data.kind === "audio");

// Hiding the panel only sets `hidden`; the element stays mounted, so an audio
// or video track would keep playing out of sight. Pause when it leaves view.
watch(
  () => ui.previewHidden,
  (hidden) => {
    if (hidden) media.value?.pause();
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 items-center justify-center p-3">
    <audio
      v-if="isAudio"
      ref="media"
      :src="props.data.streamUrl"
      controls
      preload="metadata"
      class="w-full"
      data-testid="preview-audio"
    />
    <video
      v-else
      ref="media"
      :src="props.data.streamUrl"
      controls
      preload="metadata"
      playsinline
      class="max-h-full w-full rounded-control bg-black"
      data-testid="preview-video"
    />
  </div>
</template>
