<script setup lang="ts">
import { Loader2 } from "@lucide/vue";

defineProps<{ label?: string }>();
</script>

<template>
  <div class="flex items-center justify-center gap-2 py-3 text-muted" data-testid="loading-state">
    <Loader2 class="size-4 animate-spin" />
    <span v-if="label" class="text-xs">{{ label }}</span>
  </div>
</template>
