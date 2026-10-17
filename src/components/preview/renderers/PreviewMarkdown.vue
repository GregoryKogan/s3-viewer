<script setup lang="ts">
import { computed } from "vue";
import { marked } from "marked";
import { sanitize } from "@/lib/previewText";
import { humanSize } from "@/lib/format";
import AppButton from "@/components/ui/AppButton.vue";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData; view: "rendered" | "raw" }>();
const emit = defineEmits<{ "toggle-view": [view: "rendered" | "raw"]; download: [] }>();

marked.setOptions({ gfm: true, breaks: false });

/**
 * Rendered Markdown is the one place the panel produces markup, so it goes
 * through the allow-list sanitiser. `sanitize` is covered by the e2e suite
 * (`window.__s3viewerSanitizeProbe`), not by trust.
 */
const rendered = computed(() => sanitize(marked.parse(props.data.text ?? "", { async: false }) as string));

const source = computed(() => props.data.text ?? "");
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
      <div class="flex items-center rounded-control border border-line p-0.5">
        <button
          type="button"
          class="rounded-[4px] px-1.5 py-0.5 text-[0.6875rem] transition-colors"
          :class="props.view === 'rendered' ? 'bg-accent text-white' : 'text-muted hover:bg-hover'"
          data-testid="md-view-rendered"
          @click="emit('toggle-view', 'rendered')"
        >
          Rendered
        </button>
        <button
          type="button"
          class="rounded-[4px] px-1.5 py-0.5 text-[0.6875rem] transition-colors"
          :class="props.view === 'raw' ? 'bg-accent text-white' : 'text-muted hover:bg-hover'"
          data-testid="md-view-raw"
          @click="emit('toggle-view', 'raw')"
        >
          Raw
        </button>
      </div>
      <span class="tabular ml-auto text-[0.6875rem] text-subtle">{{ humanSize(props.data.size) }}</span>
      <AppButton size="sm" variant="ghost" @click="emit('download')">Download</AppButton>
    </div>

    <!-- eslint-disable-next-line vue/no-v-html -- sanitised by `sanitize` above -->
    <div
      v-if="props.view === 'rendered'"
      class="markdown scrollbar min-h-0 flex-1 overflow-auto px-4 py-3"
      data-testid="preview-markdown"
      v-html="rendered"
    />

    <pre
      v-else
      class="scrollbar min-h-0 flex-1 overflow-auto p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre text-content"
      data-testid="preview-code"
    ><code class="hljs">{{ source }}</code></pre>

    <p
      v-if="props.data.truncated"
      class="shrink-0 border-t border-line bg-warn/10 px-3 py-1.5 text-[0.6875rem] text-warn"
      data-testid="preview-truncated"
    >
      Showing only the beginning of the file.
    </p>
  </div>
</template>
