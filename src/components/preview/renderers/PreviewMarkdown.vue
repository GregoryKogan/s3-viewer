<script setup lang="ts">
import { computed, ref } from "vue";
import { marked } from "marked";
import { sanitize } from "@/lib/previewText";
import { api } from "@/lib/ipc";
import PreviewTextBody from "@/components/preview/PreviewTextBody.vue";
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

const body = ref<InstanceType<typeof PreviewTextBody> | null>(null);

/** Only the raw view has a body to close; rendered Markdown has no find bar. */
defineExpose({ closeFind: () => body.value?.closeFind() });
</script>

<template>
  <!-- Find-in-file covers raw Markdown only: the rendered view shows markup, not
       the file's text, so it has no body for the bar to search. -->
  <PreviewTextBody
    v-if="props.view === 'raw'"
    ref="body"
    :source="source"
    :markup="null"
    :truncated="props.data.truncated"
  />

  <div v-else class="flex min-h-0 flex-1 flex-col">
    <!-- eslint-disable-next-line vue/no-v-html -- sanitised by `sanitize` above -->
    <div
      class="markdown scrollbar min-h-0 flex-1 overflow-auto px-4 py-3"
      tabindex="-1"
      data-preview-scroll
      data-testid="preview-markdown"
      v-html="rendered"
      @click="onContentClick"
    />
  </div>
</template>
