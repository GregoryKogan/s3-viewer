<script setup lang="ts">
import { onMounted, ref } from "vue";
import ModalFrame from "./ModalFrame.vue";
import AppButton from "./AppButton.vue";
import AppField from "./AppField.vue";
import { inputClass } from "./controls";
import type { ModalSize } from "./types";

const props = withDefaults(
  defineProps<{
    dialogId?: number;
    size?: ModalSize;
    title: string;
    label: string;
    initial?: string;
    placeholder?: string;
    confirmLabel?: string;
    hint?: string;
    validate?: (value: string) => string | null;
    resolve: (value: string | null) => void;
  }>(),
  { initial: "", placeholder: "", confirmLabel: "Create", hint: "" },
);

const value = ref(props.initial);
const error = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

onMounted(() => {
  input.value?.focus();
  input.value?.select();
});

function cancel() {
  props.resolve(null);
}

function submit() {
  const candidate = value.value.trim();
  if (!candidate) {
    error.value = "A value is required.";
    input.value?.focus();
    return;
  }
  const problem = props.validate?.(candidate) ?? null;
  if (problem) {
    error.value = problem;
    input.value?.focus();
    return;
  }
  props.resolve(candidate);
}
</script>

<template>
  <ModalFrame :title="props.title" :size="props.size" @close="cancel">
    <AppField :label="props.label" :hint="props.hint" :error="error">
      <input
        ref="input"
        v-model="value"
        :class="inputClass"
        type="text"
        :placeholder="props.placeholder"
        autofocus
        data-testid="prompt-input"
        @keydown.enter.prevent="submit"
        @input="error = null"
      />
    </AppField>

    <template #footer>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" data-testid="prompt-ok" @click="submit">
        {{ props.confirmLabel }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
