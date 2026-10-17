<script setup lang="ts">
import { computed } from "vue";
import { Download } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { humanSize } from "@/lib/format";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();
const emit = defineEmits<{ download: [] }>();

const isAudio = computed(() => props.data.kind === "audio");
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1.5">
      <span class="tabular text-[0.6875rem] text-subtle">{{ humanSize(props.data.size) }}</span>
      <AppButton size="sm" variant="ghost" :icon="Download" @click="emit('download')">
        Download
      </AppButton>
    </div>

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

    <p class="shrink-0 border-t border-line px-3 py-1.5 text-[0.6875rem] leading-relaxed text-subtle">
      Streamed from S3 with ranged reads — playback starts immediately and seeking works
      without downloading the whole object.
    </p>
  </div>
</template>
