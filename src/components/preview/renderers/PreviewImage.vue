<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { humanSize } from "@/lib/format";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();

const failed = ref(false);

// A new object means a new image source; clear the failure state with it.
watch(
  () => props.data.streamUrl,
  () => {
    failed.value = false;
  },
);

const caption = computed(() => humanSize(props.data.size));
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-1.5">
      <span class="tabular text-[0.6875rem] text-subtle">{{ caption }}</span>
      <slot name="actions" />
    </div>

    <div v-if="failed" class="p-4 text-[0.6875rem] leading-relaxed text-muted">
      This image cannot be rendered by the webview — the format may be unsupported.
      Download the file and open it locally.
    </div>

    <div v-else class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
      <img
        :src="props.data.streamUrl"
        :alt="props.data.key"
        class="max-h-full max-w-full rounded-control object-contain"
        data-testid="preview-image"
        @error="failed = true"
      />
    </div>
  </div>
</template>
