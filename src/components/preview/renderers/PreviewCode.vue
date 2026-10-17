<script setup lang="ts">
import { computed } from "vue";
import { Download } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { highlight, highlightDetected } from "@/lib/highlight";
import { DETECT_CANDIDATES, DETECT_MAX_BYTES, resolveLanguage, tryPrettyJson } from "@/lib/previewText";
import { humanSize } from "@/lib/format";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();
const emit = defineEmits<{ download: [] }>();

const language = computed(() => resolveLanguage(props.data.key, props.data.text ?? ""));

const pretty = computed(() => (language.value === "json" ? tryPrettyJson(props.data.text ?? "") : null));

const source = computed(() => pretty.value ?? props.data.text ?? "");

/**
 * `pretty` switches the text, so highlighting has to follow the rendered source,
 * not the raw payload.
 */
const markup = computed(() => {
  const text = source.value;
  if (language.value === "json" && pretty.value) return highlight(text, "json");
  if (language.value) return highlight(text, language.value);
  if (text.length <= DETECT_MAX_BYTES) return highlightDetected(text, DETECT_CANDIDATES);
  return highlight(text, null);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
      <span class="tabular text-[0.6875rem] text-subtle">
        {{ humanSize(props.data.size) }}
        <template v-if="language"> · {{ language }}</template>
      </span>
      <AppButton size="sm" variant="ghost" :icon="Download" class="ml-auto" @click="emit('download')">
        Download
      </AppButton>
    </div>

    <!-- eslint-disable-next-line vue/no-v-html -- produced by highlight.js from escaped text -->
    <pre
      class="scrollbar min-h-0 flex-1 overflow-auto p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre text-content"
      data-testid="preview-code"
    ><code class="hljs" v-html="markup" /></pre>

    <p
      v-if="props.data.truncated"
      class="shrink-0 border-t border-line bg-warn/10 px-3 py-1.5 text-[0.6875rem] text-warn"
      data-testid="preview-truncated"
    >
      Showing only the beginning of the file.
    </p>
  </div>
</template>
