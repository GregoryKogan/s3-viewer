<script setup lang="ts">
import type { Component } from "vue";

type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

const props = withDefaults(
  defineProps<{
    tone?: Tone;
    icon?: Component;
    dot?: boolean;
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

const DOTS: Record<Tone, string> = {
  neutral: "bg-subtle",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
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
    <span v-if="props.dot" :class="['size-1.5 rounded-full', DOTS[props.tone]]" />
    <component :is="props.icon" v-else-if="props.icon" class="size-2.5" />
    <slot />
  </span>
</template>
