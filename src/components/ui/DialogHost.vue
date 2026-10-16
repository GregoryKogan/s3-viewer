<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { useDialogsStore } from "@/stores/dialogs";

const dialogs = useDialogsStore();

function onKeydown(event: KeyboardEvent) {
  const top = dialogs.stack[dialogs.stack.length - 1];
  if (!top) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dialogs.cancel(top.id);
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown, true));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="dialogs.stack.length"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      data-testid="modal-root"
      @click.self="dialogs.cancel(dialogs.stack[dialogs.stack.length - 1].id)"
    >
      <component
        :is="dialog.component"
        v-for="dialog in dialogs.stack"
        v-show="dialog.id === dialogs.stack[dialogs.stack.length - 1].id"
        :key="dialog.id"
        v-bind="dialog.props"
        :dialog-id="dialog.id"
      />
    </div>
  </Teleport>
</template>
