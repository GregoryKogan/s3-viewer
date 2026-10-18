<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FilePlus } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import AppField from "@/components/ui/AppField.vue";
import { inputClass, textareaClass } from "@/components/ui/controls";
import type { ModalSize } from "@/components/ui/types";
import { joinKey, validateKey } from "@/lib/keys";

export interface CreateFileResult {
  name: string;
  content: string;
}

const props = defineProps<{
  dialogId?: number;
  size?: ModalSize;
  prefix: string;
  resolve: (result: CreateFileResult | null) => void;
}>();

const name = ref("");
const content = ref("");
const error = ref<string | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);

/** The key the backend will create; empty while the name is invalid. */
const targetKey = computed(() => {
  const value = name.value.trim();
  return value && !validateKey(value) ? joinKey(props.prefix, value) : "";
});

onMounted(() => {
  nameInput.value?.focus();
});

function cancel() {
  props.resolve(null);
}

function submit() {
  const value = name.value.trim();
  if (!value) {
    error.value = "A file name is required.";
    return;
  }
  if (value.endsWith("/")) {
    error.value = "The name must not end with “/”.";
    return;
  }
  const problem = validateKey(value);
  if (problem) {
    error.value = problem;
    return;
  }
  props.resolve({ name: value, content: content.value });
}
</script>

<template>
  <ModalFrame title="New file" :icon="FilePlus" :size="props.size" @close="cancel">
    <AppField
      label="File name"
      :error="error"
      :hint="targetKey ? `Creates ${targetKey}` : 'The extension decides how it is previewed.'"
    >
      <input
        ref="nameInput"
        v-model="name"
        :class="inputClass"
        type="text"
        placeholder="config.yaml"
        autocomplete="off"
        autofocus
        data-testid="new-file-name"
        @input="error = null"
        @keydown.enter.prevent="submit"
      />
    </AppField>

    <AppField label="Content" hint="The file is uploaded as text; it can be empty.">
      <textarea
        v-model="content"
        :class="textareaClass"
        rows="8"
        placeholder="Paste or type the file contents…"
        data-testid="new-file-content"
      />
    </AppField>

    <template #footer>
      <AppButton data-testid="new-file-cancel" @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" data-testid="new-file-create" @click="submit">
        Create file
      </AppButton>
    </template>
  </ModalFrame>
</template>
