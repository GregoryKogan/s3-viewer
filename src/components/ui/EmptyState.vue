<script setup lang="ts">
import type { Component } from "vue";

withDefaults(defineProps<{ title: string; description?: string; icon?: Component }>(), {});
</script>

<template>
  <div class="flex max-w-sm flex-col items-center gap-2 text-center">
    <div
      v-if="icon"
      class="grid size-9 place-items-center rounded-full border border-line bg-surface-2 text-subtle"
    >
      <component :is="icon" class="size-4" />
    </div>
    <p class="text-xs font-medium text-content">{{ title }}</p>
    <p v-if="description" class="text-meta leading-relaxed text-muted">{{ description }}</p>
    <slot />
  </div>
</template>
