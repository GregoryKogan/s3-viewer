<script setup lang="ts">
import { Loader2 } from "@lucide/vue";

withDefaults(defineProps<{ label?: string; size?: "sm" | "md" }>(), { size: "md" });
</script>

<template>
  <div class="flex items-center justify-center gap-2 py-3 text-muted" data-testid="loading-state">
    <Loader2 :class="size === 'sm' ? 'size-3.5' : 'size-4'" class="animate-spin" />
    <span v-if="label" class="text-xs">{{ label }}</span>
  </div>
</template>
