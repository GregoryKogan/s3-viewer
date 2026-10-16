<script setup lang="ts">
/** Label + control + hint. The unit every settings and connection field uses. */
const props = defineProps<{
  label?: string;
  hint?: string;
  error?: string | null;
  wide?: boolean;
}>();
</script>

<template>
  <label :class="['flex min-w-0 flex-col gap-1', props.wide ? 'col-span-full' : '']">
    <span v-if="props.label" class="text-[0.6875rem] font-medium text-muted">
      {{ props.label }}
    </span>
    <slot />
    <span v-if="props.error" class="text-[0.6875rem] leading-snug text-danger">
      {{ props.error }}
    </span>
    <span v-else-if="props.hint" class="text-[0.6875rem] leading-snug text-subtle">
      {{ props.hint }}
    </span>
  </label>
</template>
