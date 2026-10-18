<script setup lang="ts">
import { computed } from "vue";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();

const isAudio = computed(() => props.data.kind === "audio");
</script>

<template>
  <div class="flex min-h-0 flex-1 items-center justify-center p-3">
    <audio
      v-if="isAudio"
      :src="props.data.streamUrl"
      controls
      preload="metadata"
      class="w-full"
      data-testid="preview-audio"
    />
    <video
      v-else
      :src="props.data.streamUrl"
      controls
      preload="metadata"
      playsinline
      class="max-h-full w-full rounded-control bg-black"
      data-testid="preview-video"
    />
  </div>
</template>
