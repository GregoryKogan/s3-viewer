<script setup lang="ts">
/**
 * Label + control + hint. The unit every settings and connection field uses.
 *
 * The hint and the error sit outside the `<label>`: anything inside it becomes
 * part of the control's accessible name, which used to read
 * "Region Usually dictated by the provider" (VIS-8). The control stays inside
 * the label so clicking the text still focuses it.
 */
const props = defineProps<{
  label?: string;
  hint?: string;
  error?: string | null;
  wide?: boolean;
  /** Draw the required marker next to the label. */
  required?: boolean;
}>();
</script>

<template>
  <div :class="['flex min-w-0 flex-col gap-1', props.wide ? 'col-span-full' : '']">
    <label class="flex min-w-0 flex-col gap-1">
      <span v-if="props.label" class="text-[0.6875rem] font-medium text-muted">
        {{ props.label }}<span v-if="props.required" class="ml-0.5 text-danger" aria-hidden="true">*</span>
      </span>
      <slot />
    </label>
    <span v-if="props.error" class="text-[0.6875rem] leading-snug text-danger">
      {{ props.error }}
    </span>
    <span v-else-if="props.hint" class="text-[0.6875rem] leading-snug text-subtle">
      {{ props.hint }}
    </span>
  </div>
</template>
