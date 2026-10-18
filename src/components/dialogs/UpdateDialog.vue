<script setup lang="ts">
import { computed, onBeforeUnmount } from "vue";
import { Download } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import type { ModalSize } from "@/components/ui/types";
import { useUpdatesStore } from "@/stores/updates";

const props = defineProps<{
  dialogId?: number;
  size?: ModalSize;
  resolve: (value: null) => void;
}>();

const updates = useUpdatesStore();

const title = computed(() =>
  updates.phase === "error" ? "Update failed" : `S3 Viewer ${updates.nextVersion ?? ""} is available`,
);

const installing = computed(() => updates.phase === "installing" || updates.phase === "restarting");

const primaryLabel = computed(() => {
  if (updates.phase === "restarting") return "Restarting…";
  if (updates.phase === "installing") return "Installing…";
  if (updates.phase === "error") return "Try again";
  return "Install and restart";
});

function close() {
  props.resolve(null);
}

function install() {
  void updates.install();
}

// Escape, the backdrop and the close button pop the dialog without going through
// the footer, so the pending handle is released here instead of in every path.
onBeforeUnmount(() => {
  if (!updates.busy) void updates.later();
});
</script>

<template>
  <ModalFrame :title="title" :icon="Download" :size="props.size" @close="close">
    <p class="text-xs leading-relaxed text-content">
      You are running {{ updates.runningVersion || "an older build" }}. The new version downloads as one
      archive, verifies its signature and replaces the app in place.
    </p>

    <div
      v-if="updates.notes"
      class="scrollbar max-h-40 overflow-y-auto rounded-control border border-line bg-inset p-3 text-meta leading-relaxed whitespace-pre-wrap text-muted"
      data-testid="update-notes"
    >{{ updates.notes }}</div>

    <div v-if="installing" class="flex flex-col gap-2" data-testid="update-progress">
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-inset">
        <div
          v-if="updates.percent !== null"
          class="h-full rounded-full bg-accent transition-[width] duration-200"
          :style="{ width: `${updates.percent}%` }"
        />
        <div v-else class="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
      <p class="text-meta text-muted">
        {{
          updates.phase === "restarting"
            ? "The update is installed. Restarting into the new version…"
            : `Downloading ${updates.progressLabel}. On Linux, a package update asks for your administrator password.`
        }}
      </p>
    </div>

    <p
      v-if="updates.error"
      class="rounded-control border border-danger/40 bg-danger-soft p-3 text-meta leading-relaxed text-danger"
      data-testid="update-error"
    >
      {{ updates.error }} The update did not complete.
    </p>

    <template #footer>
      <AppButton :disabled="installing" data-testid="update-later" @click="close">Later</AppButton>
      <AppButton
        variant="primary"
        :loading="installing"
        :disabled="updates.phase === 'restarting'"
        data-testid="update-install"
        autofocus
        @click="install"
      >
        {{ primaryLabel }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
