<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useDialogsStore } from "@/stores/dialogs";

const dialogs = useDialogsStore();

/**
 * The shell behind the modal is made inert so no background control and no
 * screen-reader virtual cursor can reach it. The dialogue itself is teleported
 * to `<body>`, outside that subtree.
 */
const SHELL_SELECTOR = "[data-app-shell]";

function setShellInert(inert: boolean) {
  document.querySelector<HTMLElement>(SHELL_SELECTOR)?.toggleAttribute("inert", inert);
}

// Pre-flush: on close, make the shell interactive again *before* the last frame
// unmounts and restores focus to its trigger (inert nodes cannot take focus).
// On open, wait for the frame to mount and take focus before marking the
// trigger's subtree inert, otherwise the trigger is blurred before it can be
// remembered as the return target.
watch(
  () => dialogs.stack.length,
  (length) => {
    if (!length) {
      setShellInert(false);
      return;
    }
    void nextTick(() => {
      if (dialogs.stack.length) setShellInert(true);
    });
  },
  { flush: "pre" },
);

function topDialog() {
  return dialogs.stack[dialogs.stack.length - 1];
}

/** A backdrop click only closes a dialog that opted into it (DLG-2). */
function onBackdropClick() {
  const top = topDialog();
  if (top?.dismissible) dialogs.cancel(top.id);
}

function onKeydown(event: KeyboardEvent) {
  const top = topDialog();
  if (!top) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dialogs.cancel(top.id);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  setShellInert(false);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="dialogs.stack.length"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      data-testid="modal-root"
      @click.self="onBackdropClick"
    >
      <component
        :is="dialog.component"
        v-for="dialog in dialogs.stack"
        v-show="dialog.id === dialogs.stack[dialogs.stack.length - 1].id"
        :key="dialog.id"
        v-bind="dialog.props"
        :dialog-id="dialog.id"
        :size="dialog.size"
      />
    </div>
  </Teleport>
</template>
