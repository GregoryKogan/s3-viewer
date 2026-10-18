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

/**
 * Running transfers first, then every failed/cancelled row, then the most recent
 * few completed ones.
 *
 * A failure is not just a status: it is the Retry affordance. The four-row cap
 * and the seven-second linger would otherwise hide early failures of a batch
 * before its summary even arrives, so only `done` rows are limited.
 */
const visible = computed<ProgressView[]>(() => {
  const running = progress.items.filter((item) => item.state === "running");
  const retryable = progress.items.filter(
    (item) => item.state === "failed" || item.state === "cancelled",
  );
  const done = progress.items.filter((item) => item.state === "done").slice(-4);
  return [...running, ...retryable, ...done];
});

function percent(item: ProgressView): number | null {
  if (!item.total) return null;
  return Math.min(100, Math.round((item.done / item.total) * 100));
}

function barClass(item: ProgressView): string {
  if (item.state === "done") return "bg-ok";
  if (item.state === "failed") return "bg-danger";
  if (item.state === "cancelled") return "bg-subtle";
  return percent(item) === null ? "bg-accent" : "bg-accent";
}

function label(item: ProgressView): string {
  if (item.state === "done") return "done";
  if (item.state === "failed") return "failed";
  if (item.state === "cancelled") return "cancelled";
  const value = percent(item);
  return value === null ? "working" : `${value}%`;
}

async function cancel(item: ProgressView) {
  try {
    await api.cancelTransfer(item.id);
  } catch (error) {
    // The transfer may have finished between the click and the command; say so
    // instead of leaving a button that appears to do nothing.
    toasts.apiError(error, "Cannot cancel");
  }
  await progress.poll();
}

async function retry(item: ProgressView) {
  try {
    await progress.retry(item.id);
  } catch (error) {
    // The retry command could not start a replacement: keep the row and its
    // Retry button so the user can try again.
    toasts.apiError(error, "Cannot retry");
  }
  await progress.poll();
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
      <span class="text-meta font-semibold tracking-wider text-subtle uppercase">
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
        <span class="min-w-0 flex-1 truncate text-meta text-content" :title="item.label">
          {{ item.label }}
        </span>
        <span class="tabular shrink-0 text-micro text-subtle">{{ label(item) }}</span>
      </div>

      <div class="h-1 overflow-hidden rounded-full bg-hover">
        <div
          class="h-full transition-[width]"
          :class="barClass(item)"
          :style="{ width: percent(item) === null ? '100%' : `${percent(item)}%` }"
        />
      </div>

      <p v-if="item.error" class="text-micro leading-relaxed text-danger">{{ item.error }}</p>

      <div
        v-if="item.state === 'running' || ((item.state === 'failed' || item.state === 'cancelled') && progress.hasRetry(item.id))"
        class="flex items-center gap-1"
      >
        <AppButton
          v-if="item.state === 'running'"
          size="sm"
          variant="ghost"
          data-testid="transfer-cancel"
          @click="cancel(item)"
        >
          Cancel
        </AppButton>
        <AppButton
          v-if="(item.state === 'failed' || item.state === 'cancelled') && progress.hasRetry(item.id)"
          size="sm"
          variant="ghost"
          :busy="progress.isRetrying(item.id)"
          :disabled="progress.isRetrying(item.id)"
          data-testid="transfer-retry"
          @click="retry(item)"
        >
          Retry
        </AppButton>
      </div>

      <div v-if="item.state === 'done' && item.resultPath" class="flex items-center gap-1 text-micro text-ok">
        <Check class="size-2.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate" :title="item.resultPath">{{ item.resultPath }}</span>
        <AppButton size="sm" variant="ghost" :icon="FolderOpen" title="Reveal" @click="api.revealInFileManager(item.resultPath)" />
        <AppButton size="sm" variant="ghost" :icon="ArrowRight" title="Open" @click="api.openPath(item.resultPath)" />
      </div>
    </div>
  </div>
</template>
