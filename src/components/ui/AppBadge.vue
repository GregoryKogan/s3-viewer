<script setup lang="ts">
type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

const props = withDefaults(
  defineProps<{
    tone?: Tone;
    title?: string;
  }>(),
  { tone: "neutral" },
);

const TONES: Record<Tone, string> = {
  neutral: "border-line-strong text-muted",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  danger: "border-danger/40 text-danger",
  accent: "border-accent/40 text-accent-text",
};
</script>

<template>
  <span
    :title="props.title"
    :class="[
      'inline-flex items-center gap-1 rounded-full border bg-surface px-1.5 py-px text-micro leading-[1.5] whitespace-nowrap',
      TONES[props.tone],
    ]"
  >
    <slot />
  </span>
</template>
