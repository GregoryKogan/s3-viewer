<script setup lang="ts">
import { onMounted, ref } from "vue";
import ModalFrame from "./ModalFrame.vue";
import AppButton from "./AppButton.vue";
import AppField from "./AppField.vue";
import { inputClass } from "./controls";
import type { ModalSize } from "./types";
import { submitOnEnter } from "@/lib/keyboard";

const props = withDefaults(
  defineProps<{
    size?: ModalSize;
    title: string;
    label: string;
    confirmLabel?: string;
    hint?: string;
    validate?: (value: string) => string | null;
    resolve: (value: string | null) => void;
  }>(),
  { confirmLabel: "Create", hint: "" },
);

const value = ref("");
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
/** Enter commits; an IME composition commit is not a submit. */
function onEnter(event: KeyboardEvent) {
  submitOnEnter(event, submit);
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
        autofocus
        data-testid="prompt-input"
        @keydown.enter="onEnter"
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
