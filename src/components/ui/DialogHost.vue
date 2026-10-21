<script setup lang="ts">
import { ref } from "vue";
import { useDialogsStore } from "@/stores/dialogs";

const dialogs = useDialogsStore();
const root = ref<HTMLElement | null>(null);

/**
 * A backdrop click only closes a dialog that opted into it (DLG-2). The click
 * lands on the top `<dialog>` itself: it covers the viewport, the ones under it
 * sit behind its backdrop, and clicks inside a panel never reach the dialog.
 */
function onBackdropClick(event: MouseEvent) {
  if (event.target !== root.value?.lastElementChild) return;
  const top = dialogs.stack[dialogs.stack.length - 1];
  if (top?.dismissible) dialogs.cancel(top.id);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="dialogs.stack.length" ref="root" data-testid="modal-root" @click="onBackdropClick">
      <component
        :is="dialog.component"
        v-for="dialog in dialogs.stack"
        :key="dialog.id"
        v-bind="dialog.props"
        :size="dialog.size"
      />
    </div>
  </Teleport>
</template>
