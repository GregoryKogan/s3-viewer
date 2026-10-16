<script setup lang="ts">
import { computed } from "vue";
import { X } from "@lucide/vue";
import { useToastsStore, type Toast } from "@/stores/toasts";

const toasts = useToastsStore();

const TONES: Record<Toast["level"], string> = {
  info: "border-l-accent",
  ok: "border-l-ok",
  warn: "border-l-warn",
  error: "border-l-danger",
};
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed bottom-4 left-1/2 z-40 flex w-max max-w-[min(40rem,80vw)] -translate-x-1/2 flex-col gap-2"
      data-testid="toasts"
    >
      <div
        v-for="toast in toasts.toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-start gap-2.5 rounded-panel border border-line-strong border-l-2 bg-elevated px-3 py-2 shadow-xl shadow-black/35"
        :class="TONES[toast.level]"
        :data-testid="`toast-${toast.level}`"
      >
        <div class="flex min-w-0 flex-col gap-0.5">
          <p v-if="toast.title" class="text-xs font-semibold text-content">{{ toast.title }}</p>
          <p class="text-xs leading-relaxed break-words text-muted">{{ toast.message }}</p>
          <div v-if="toast.actions.length" class="mt-1 flex gap-1.5">
            <button
              v-for="action in toast.actions"
              :key="action.label"
              type="button"
              class="rounded-[4px] border border-line-strong px-1.5 py-0.5 text-[0.6875rem] transition-colors hover:bg-hover"
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
          @click="toasts.dismiss(toast.id)"
        >
          <X class="size-3" />
        </button>
      </div>
    </div>
  </Teleport>
</template>
