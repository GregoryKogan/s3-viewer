<script setup lang="ts">
import { ref } from "vue";
import { Upload } from "@lucide/vue";
import { listen } from "@/lib/ipc";

const props = withDefaults(defineProps<{ enabled?: boolean }>(), { enabled: true });

const emit = defineEmits<{ drop: [paths: string[]] }>();

const active = ref(false);

/**
 * OS drag & drop. Tauri reports the dragged paths, so the dropzone only has to
 * track the visual state and forward the paths.
 *
 * A read-only connection still receives the event (the shell cannot refuse a
 * drop) but never shows the overlay; `App.onDrop` answers with a warning.
 */
void listen<unknown>("tauri://drag-enter", () => {
  active.value = props.enabled;
}).catch(() => {});

void listen<unknown>("tauri://drag-leave", () => {
  active.value = false;
}).catch(() => {});

void listen<{ paths?: string[] }>("tauri://drag-drop", (payload) => {
  active.value = false;
  const paths = payload?.paths ?? [];
  if (paths.length) emit("drop", paths);
}).catch(() => {});

defineExpose({ isActive: () => active.value });
</script>

<template>
  <div
    class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-accent bg-bg/85 backdrop-blur-sm"
    :class="active ? 'flex' : 'hidden'"
    data-testid="dropzone"
  >
    <div class="flex flex-col items-center gap-2 text-accent">
      <Upload class="size-6" />
      <p class="text-sm font-medium">Drop files to upload</p>
    </div>
  </div>
</template>
