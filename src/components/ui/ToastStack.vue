<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { useDialogsStore } from "@/stores/dialogs";
import { useToastsStore, type Toast } from "@/stores/toasts";

const toasts = useToastsStore();
const dialogs = useDialogsStore();

/**
 * Where the toasts paint.
 *
 * A dialog's `::backdrop` belongs to the top layer, which no `z-index` in the
 * document can climb over, so a toast left in `body` is dimmed to unreadable.
 * The top dialog itself is above its own backdrop: moving the toasts inside it
 * keeps them legible, clickable and announced by a screen reader (a top-layer
 * popover outside the dialog is still inert while the dialog is modal).
 */
const target = ref<HTMLElement | "body">("body");

/** The dialogs open and close in the update this watcher runs after. */
async function followTopDialog() {
  await nextTick();
  const open = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  target.value = open[open.length - 1] ?? "body";
}

watch(() => dialogs.stack.length, followTopDialog, { flush: "post" });

const TONES: Record<Toast["level"], string> = {
  info: "border-l-accent",
  ok: "border-l-ok",
  warn: "border-l-warn",
  error: "border-l-danger",
};

/** Moving focus between two controls inside one toast is not a leave. */
function onFocusOut(event: FocusEvent, id: number) {
  const next = event.relatedTarget;
  const current = event.currentTarget as HTMLElement | null;
  if (next instanceof Node && current?.contains(next)) return;
  toasts.resume(id, "focus");
}
</script>

<template>
  <Teleport :to="target">
    <div
      class="pointer-events-none fixed bottom-4 left-1/2 z-[80] flex w-max max-w-[min(40rem,80vw)] -translate-x-1/2 flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
      data-testid="toasts"
    >
      <div
        v-for="toast in toasts.toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-start gap-2.5 rounded-panel border border-line-strong border-l-2 bg-elevated px-3 py-2 shadow-xl shadow-black/35"
        :class="TONES[toast.level]"
        :role="toast.level === 'error' ? 'alert' : 'status'"
        :data-testid="`toast-${toast.level}`"
        @mouseenter="toasts.pause(toast.id, 'hover')"
        @mouseleave="toasts.resume(toast.id, 'hover')"
        @focusin="toasts.pause(toast.id, 'focus')"
        @focusout="onFocusOut($event, toast.id)"
      >
        <div class="flex min-w-0 flex-col gap-0.5">
          <p v-if="toast.title" class="text-xs font-semibold text-content">{{ toast.title }}</p>
          <p class="text-xs leading-relaxed break-words whitespace-pre-line text-muted">{{ toast.message }}</p>
          <div v-if="toast.actions.length" class="mt-1 flex gap-1.5">
            <button
              v-for="action in toast.actions"
              :key="action.label"
              type="button"
              class="rounded-[4px] border border-line-strong px-1.5 py-0.5 text-meta transition-colors hover:bg-hover"
              :tabindex="dialogs.isOpen() ? -1 : undefined"
              @click="
                action.run();
                toasts.dismiss(toast.id);
              "
            >
              {{ action.label }}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="grid size-4 shrink-0 place-items-center rounded-[3px] text-subtle transition-colors hover:bg-hover hover:text-content"
          aria-label="Dismiss"
          :tabindex="dialogs.isOpen() ? -1 : undefined"
          @click="toasts.dismiss(toast.id)"
        >
          <X class="size-3" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
