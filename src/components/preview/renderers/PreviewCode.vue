<script setup lang="ts">
import { computed, ref } from "vue";
import { highlight, highlightDetected } from "@/lib/highlight";
import { DETECT_CANDIDATES, DETECT_MAX_BYTES, resolveLanguage, tryPrettyJson } from "@/lib/previewText";
import PreviewTextBody from "@/components/preview/PreviewTextBody.vue";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();

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

const body = ref<InstanceType<typeof PreviewTextBody> | null>(null);

/** The panel closes the bar through the renderer, so pass the body's close up. */
defineExpose({ closeFind: () => body.value?.closeFind() });
</script>

<template>
  <PreviewTextBody ref="body" :source="source" :markup="markup" :truncated="props.data.truncated" />
</template>
