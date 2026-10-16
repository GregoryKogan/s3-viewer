<script setup lang="ts">
import { AlertTriangle } from "@lucide/vue";
import ModalFrame from "./ModalFrame.vue";
import AppButton from "./AppButton.vue";

const props = withDefaults(
  defineProps<{
    dialogId?: number;
    title: string;
    message: string;
    details?: string[];
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    resolve: (confirmed: boolean) => void;
  }>(),
  { confirmLabel: "Confirm", cancelLabel: "Cancel", danger: false, details: () => [] },
);

function cancel() {
  props.resolve(false);
}

function confirm() {
  props.resolve(true);
}
</script>

<template>
  <ModalFrame
    :title="props.title"
    size="narrow"
    :icon="props.danger ? AlertTriangle : undefined"
    @close="cancel"
  >
    <p class="text-xs leading-relaxed text-content" data-testid="confirm-message">
      {{ props.message }}
    </p>

    <ul
      v-if="props.details.length"
      class="scrollbar max-h-52 list-disc space-y-1 overflow-y-auto rounded-control border border-line bg-inset p-3 pl-7 text-[0.6875rem] leading-relaxed text-muted"
      data-testid="confirm-details"
    >
      <li v-for="(line, index) in props.details" :key="index" class="break-all">{{ line }}</li>
    </ul>

    <template #footer>
      <AppButton data-testid="confirm-cancel" @click="cancel">{{ props.cancelLabel }}</AppButton>
      <AppButton
        :variant="props.danger ? 'danger' : 'primary'"
        data-testid="confirm-ok"
        @click="confirm"
      >
        {{ props.confirmLabel }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
