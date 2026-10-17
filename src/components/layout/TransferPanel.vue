<script setup lang="ts">
import { computed } from "vue";
import { ArrowRight, Check, FolderOpen } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { api } from "@/lib/ipc";
import { useProgressStore } from "@/stores/progress";
import { useToastsStore } from "@/stores/toasts";
import type { ProgressView } from "@/types";

const progress = useProgressStore();
const toasts = useToastsStore();

/** Running transfers first, then the most recent few finished ones. */
const visible = computed<ProgressView[]>(() => {
  const running = progress.items.filter((item) => item.state === "running");
  const finished = progress.items.filter((item) => item.state !== "running").slice(-4);
  return [...running, ...finished];
});

function percent(item: ProgressView): number | null {
  if (!item.total) return null;
  return Math.min(100, Math.round((item.done / item.total) * 100));
}

function barClass(item: ProgressView): string {
  if (item.state === "done") return "bg-ok";
  if (item.state === "failed") return "bg-danger";
  return percent(item) === null ? "bg-accent" : "bg-accent";
}

function label(item: ProgressView): string {
  if (item.state === "done") return "done";
  if (item.state === "failed") return "failed";
  if (item.state === "cancelled") return "cancelled";
  const value = percent(item);
  return value === null ? "working" : `${value}%`;
}

async function dismiss() {
  await progress.clear();
  toasts.dismiss(0);
}
</script>

<template>
  <div
    v-if="visible.length"
    class="fixed right-3 bottom-3 z-30 flex max-h-[42vh] w-80 flex-col gap-2 overflow-y-auto rounded-panel border border-line-strong bg-elevated p-2.5 shadow-2xl shadow-black/40"
    data-testid="transfers"
  >
    <div class="flex items-center justify-between">
      <span class="text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Transfers
        <template v-if="progress.running.length">({{ progress.running.length }})</template>
      </span>
      <AppButton variant="ghost" size="sm" @click="dismiss">Clear</AppButton>
    </div>

    <div
      v-for="item in visible"
      :key="item.id"
      class="flex flex-col gap-1"
      :data-testid="`transfer-${item.state}`"
    >
      <div class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-content" :title="item.label">
          {{ item.label }}
        </span>
        <span class="tabular shrink-0 text-[0.625rem] text-subtle">{{ label(item) }}</span>
      </div>

      <div class="h-1 overflow-hidden rounded-full bg-hover">
        <div
          class="h-full transition-[width]"
          :class="barClass(item)"
          :style="{ width: percent(item) === null ? '100%' : `${percent(item)}%` }"
        />
      </div>

      <p v-if="item.error" class="text-[0.625rem] leading-relaxed text-danger">{{ item.error }}</p>

      <div v-if="item.state === 'done' && item.resultPath" class="flex items-center gap-1 text-[0.625rem] text-ok">
        <Check class="size-2.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate" :title="item.resultPath">{{ item.resultPath }}</span>
        <AppButton size="sm" variant="ghost" :icon="FolderOpen" title="Reveal" @click="api.revealInFileManager(item.resultPath)" />
        <AppButton size="sm" variant="ghost" :icon="ArrowRight" title="Open" @click="api.openPath(item.resultPath)" />
      </div>
    </div>
  </div>
</template>
