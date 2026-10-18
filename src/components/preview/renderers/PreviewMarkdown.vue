<script setup lang="ts">
import { computed } from "vue";
import { marked } from "marked";
import { sanitize } from "@/lib/previewText";
import { api } from "@/lib/ipc";
import { useToastsStore } from "@/stores/toasts";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData; view: "rendered" | "raw" }>();
const toasts = useToastsStore();

marked.setOptions({ gfm: true, breaks: false });

/**
 * Rendered Markdown is the one place the panel produces markup, so it goes
 * through the allow-list sanitiser. `sanitize` is covered by the e2e suite
 * (`window.__s3viewerSanitizeProbe`), not by trust.
 */
const rendered = computed(() => sanitize(marked.parse(props.data.text ?? "", { async: false }) as string));

const source = computed(() => props.data.text ?? "");

/**
 * Links leave the app instead of navigating it (PRV-8).
 *
 * The webview has no browser chrome: letting a click through would replace the
 * whole UI with the target page and only a relaunch would bring it back. Every
 * anchor is intercepted; only absolute http(s) URLs are handed to the system
 * opener, so relative paths, `mailto:` and the like do nothing.
 */
function onContentClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return;
  void api.openUrl(href).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    toasts.error(message, "Cannot open link");
  });
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- eslint-disable-next-line vue/no-v-html -- sanitised by `sanitize` above -->
    <div
      v-if="props.view === 'rendered'"
      class="markdown scrollbar min-h-0 flex-1 overflow-auto px-4 py-3"
      data-testid="preview-markdown"
      v-html="rendered"
      @click="onContentClick"
    />

    <pre
      v-else
      class="scrollbar min-h-0 flex-1 overflow-auto p-3 font-mono text-meta leading-relaxed whitespace-pre text-content"
      data-testid="preview-code"
    ><code class="hljs">{{ source }}</code></pre>

    <p
      v-if="props.data.truncated"
      class="shrink-0 border-t border-line bg-warn/10 px-3 py-1.5 text-meta text-warn"
      data-testid="preview-truncated"
    >
      Showing only the beginning of the file.
    </p>
  </div>
</template>
