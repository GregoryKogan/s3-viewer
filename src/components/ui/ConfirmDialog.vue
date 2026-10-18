<script setup lang="ts">
import { AlertTriangle } from "@lucide/vue";
import ModalFrame from "./ModalFrame.vue";
import AppButton from "./AppButton.vue";
import type { ModalSize } from "./types";

const props = withDefaults(
  defineProps<{
    dialogId?: number;
    size?: ModalSize;
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

/**
 * Enter confirms, except for a dangerous action: there the default must be the
 * safe choice, so Cancel takes focus and Enter falls through to it (DLG-5).
 * Cancel and the header X keep their native Enter behaviour (cancel/close);
 * only Enter elsewhere in the dialog confirms.
 */
function onEnter(event: KeyboardEvent) {
  if (props.danger) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.closest('[data-testid="confirm-cancel"], [data-testid="modal-close"]')
  ) {
    return;
  }
  event.preventDefault();
  confirm();
}
</script>

<template>
  <ModalFrame
    :title="props.title"
    :size="props.size"
    :icon="props.danger ? AlertTriangle : undefined"
    @keydown.enter="onEnter"
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
      <AppButton data-testid="confirm-cancel" :autofocus="props.danger" @click="cancel">
        {{ props.cancelLabel }}
      </AppButton>
      <AppButton
        :variant="props.danger ? 'danger' : 'primary'"
        data-testid="confirm-ok"
        :autofocus="!props.danger"
        @click="confirm"
      >
        {{ props.confirmLabel }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
