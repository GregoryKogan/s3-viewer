<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch, type Component } from "vue";
import { X } from "@lucide/vue";
import { MODAL_WIDTH, type ModalSize } from "./types";

const props = withDefaults(
  defineProps<{
    title: string;
    size?: ModalSize;
    icon?: Component;
    /** False while a dialog higher up the stack covers this one. */
    active?: boolean;
  }>(),
  { size: "normal", active: true },
);
const emit = defineEmits<{ close: [] }>();

const width = computed(() => MODAL_WIDTH[props.size]);
// Several dialogs can be open at once, so the title id has to be unique.
const titleId = useId();
const dialog = ref<HTMLDialogElement | null>(null);
/** The control inside this dialog that had focus last, for the trip back. */
let returnFocus: HTMLElement | null = null;

/** Tracks focus as it moves, so a dialog opened above cannot erase it. */
function rememberFocus(event: FocusEvent) {
  if (event.target instanceof HTMLElement) returnFocus = event.target;
}

// `showModal` puts the panel in the top layer, makes the rest of the document
// inert and hands the platform the focus trap, Escape and the backdrop.
// Until it opens, the closed `<dialog>` is `display: none`, so the panel's
// `autofocus` cannot grab focus before the opener is remembered.
onMounted(() => dialog.value?.showModal());

// Only the top dialog of the stack is open: a dialog under another one closes,
// and a closed `<dialog>` keeps its DOM, form state and opener for the trip
// back. Escape and the backdrop can only reach the one that is open.
watch(
  () => props.active,
  (active) => {
    const element = dialog.value;
    if (!element) return;
    if (active) {
      // `showModal` focuses the panel's autofocus field again, so the remembered
      // control is read first.
      const remembered = returnFocus;
      if (!element.open) element.showModal();
      // Put the reader back where they were, not on the first field again.
      if (remembered?.isConnected && element.contains(remembered)) {
        remembered.focus({ preventScroll: true });
      }
    } else {
      element.close();
    }
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  dialog.value?.close();
  // The opener can vanish with the dialog (a row action, a menu item). Native
  // restore then leaves focus on `<body>`; keep the keyboard on the list.
  if (document.activeElement === document.body) {
    document.getElementById("object-list")?.focus({ preventScroll: true });
  }
});
</script>

<template>
  <dialog
    ref="dialog"
    class="fixed inset-0 m-0 hidden h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-transparent p-6 open:flex backdrop:bg-black/55"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
    @focusin="rememberFocus"
  >
    <div
      class="pointer-events-auto flex max-h-[88vh] w-full flex-col overflow-hidden rounded-panel border border-line-strong bg-elevated shadow-2xl shadow-black/40"
      :class="width"
      data-testid="modal"
    >
      <header class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <component :is="props.icon" v-if="props.icon" class="size-4 shrink-0 text-muted" />
        <h2
          :id="titleId"
          class="min-w-0 flex-1 truncate text-sm font-semibold text-content"
          data-testid="modal-title"
        >
          {{ props.title }}
        </h2>
        <button
          type="button"
          class="grid size-6 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
          aria-label="Close"
          data-testid="modal-close"
          @click="emit('close')"
        >
          <X class="size-3.5" />
        </button>
      </header>

      <div data-modal-body class="scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <slot />
      </div>

      <footer
        v-if="$slots.footer"
        class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3"
      >
        <slot name="footer" />
      </footer>
    </div>
  </dialog>
</template>
