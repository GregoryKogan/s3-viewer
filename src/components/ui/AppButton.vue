<script setup lang="ts">
import type { Component } from "vue";
import { Loader2 } from "@lucide/vue";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    icon?: Component;
    trailingIcon?: Component;
    disabled?: boolean;
    loading?: boolean;
    /** Spinner without disabling the button: for refresh-style actions. */
    busy?: boolean;
    block?: boolean;
    type?: "button" | "submit";
    title?: string;
  }>(),
  { variant: "secondary", size: "md", type: "button" },
);

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-white border border-accent hover:bg-accent-hover disabled:hover:bg-accent",
  secondary:
    "bg-elevated text-content border border-line-strong hover:bg-hover disabled:hover:bg-elevated",
  ghost:
    "bg-transparent text-content border border-transparent hover:bg-hover disabled:hover:bg-transparent",
  danger:
    "bg-transparent text-danger border border-danger/40 hover:bg-danger-soft disabled:hover:bg-transparent",
};

const SIZES: Record<Size, string> = {
  sm: "h-6 px-2 text-[0.6875rem] gap-1 rounded-[4px]",
  md: "h-7 px-2.5 text-xs gap-1.5 rounded-control",
};
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled || props.loading"
    :title="props.title"
    :class="[
      'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors',
      'disabled:cursor-default disabled:opacity-45',
      VARIANTS[props.variant],
      SIZES[props.size],
      props.block ? 'w-full' : '',
    ]"
  >
    <Loader2 v-if="props.loading || props.busy" class="size-3.5 animate-spin" />
    <component :is="props.icon" v-else-if="props.icon" class="size-3.5 shrink-0" />
    <span class="truncate"><slot /></span>
    <component :is="props.trailingIcon" v-if="props.trailingIcon" class="size-3.5 shrink-0" />
  </button>
</template>
