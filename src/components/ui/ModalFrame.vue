<script setup lang="ts">
import { computed } from "vue";
import { X } from "@lucide/vue";
import { MODAL_WIDTH, type ModalProps } from "./types";

const props = withDefaults(defineProps<ModalProps>(), { size: "normal" });
const emit = defineEmits<{ close: [] }>();

const width = computed(() => MODAL_WIDTH[props.size]);
</script>

<template>
  <div
    class="pointer-events-auto flex max-h-[88vh] w-full flex-col overflow-hidden rounded-panel border border-line-strong bg-elevated shadow-2xl shadow-black/40"
    :class="width"
    role="dialog"
    aria-modal="true"
    data-testid="modal"
    @click.stop
  >
    <header class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
      <component :is="props.icon" v-if="props.icon" class="size-4 shrink-0 text-muted" />
      <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-content" data-testid="modal-title">
        {{ props.title }}
      </h2>
      <button
        type="button"
        class="grid size-6 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
        aria-label="Close"
        @click="emit('close')"
      >
        <X class="size-3.5" />
      </button>
    </header>

    <div class="scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <slot />
    </div>

    <footer
      v-if="$slots.footer"
      class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3"
    >
      <slot name="footer" />
    </footer>
  </div>
</template>
