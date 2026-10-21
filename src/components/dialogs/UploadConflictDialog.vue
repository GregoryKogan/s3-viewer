<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import type { ModalSize } from "@/components/ui/types";

export type UploadConflictChoice = "replace" | "skip";

const props = defineProps<{
  size?: ModalSize;
  conflicts: string[];
  prefix: string;
  resolve: (choice: UploadConflictChoice | null) => void;
}>();

const count = computed(() => props.conflicts.length);
const shown = computed(() => props.conflicts.slice(0, 6));
const more = computed(() => Math.max(0, count.value - shown.value.length));

function cancel() {
  props.resolve(null);
}

function replaceAll() {
  props.resolve("replace");
}

function skipExisting() {
  props.resolve("skip");
}
</script>

<template>
  <ModalFrame
    title="Some files already exist"
    :size="props.size"
    :icon="AlertTriangle"
    @close="cancel"
  >
    <p class="text-xs leading-relaxed text-content">
      {{ count }} file{{ count === 1 ? "" : "s" }} already exist{{ count === 1 ? "s" : "" }} in
      <span class="font-mono text-content">{{ props.prefix || "/" }}</span>.
    </p>

    <ul
      v-if="shown.length"
      class="scrollbar max-h-44 list-disc space-y-1 overflow-y-auto rounded-control border border-line bg-inset p-3 pl-7 font-mono text-meta leading-relaxed text-muted"
      tabindex="0"
      role="group"
      aria-label="Conflicting files"
    >
      <li v-for="key in shown" :key="key" class="break-all">{{ key }}</li>
      <li v-if="more" class="list-none text-subtle">…and {{ more }} more</li>
    </ul>

    <p class="text-meta leading-relaxed text-subtle">
      <strong class="font-medium text-content">Replace all</strong> overwrites the existing objects
      with the files you are uploading. <strong class="font-medium text-content">Skip existing</strong>
      leaves those objects untouched and uploads only the new keys.
    </p>

    <template #footer>
      <AppButton data-testid="upload-conflict-cancel" @click="cancel">Cancel</AppButton>
      <AppButton data-testid="upload-conflict-skip" autofocus @click="skipExisting">Skip existing</AppButton>
      <AppButton variant="danger" data-testid="upload-conflict-replace" @click="replaceAll">
        Replace all
      </AppButton>
    </template>
  </ModalFrame>
</template>
