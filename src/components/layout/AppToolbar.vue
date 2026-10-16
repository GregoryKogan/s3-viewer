<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowRightLeft,
  Copy,
  Download,
  FilePlus,
  FolderPlus,
  Link2,
  Trash2,
  Upload,
} from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { humanSize } from "@/lib/format";
import { useObjectActions } from "@/composables/useObjectActions";

const emit = defineEmits<{ moved: [] }>();

const objects = useObjectsStore();
const connections = useConnectionsStore();
const actions = useObjectActions({ onChanged: () => emit("moved") });

const selectionCount = computed(() => objects.selected.size);
const canWrite = computed(() => connections.canWriteActive && Boolean(connections.active));

const status = computed(() => {
  const files = objects.entries.filter((entry) => !entry.isFolder).length;
  const folders = objects.entries.length - files;
  const bytes = objects.entries.reduce((sum, entry) => sum + (entry.isFolder ? 0 : entry.size), 0);
  const parts = [`${folders} folder${folders === 1 ? "" : "s"}`, `${files} file${files === 1 ? "" : "s"}`, humanSize(bytes)];
  if (objects.loading) parts.push("loading…");
  if (objects.truncated) parts.push("truncated");
  if (selectionCount.value) parts.push(`${selectionCount.value} selected`);
  return parts.join(" · ");
});
</script>

<template>
  <div class="flex flex-wrap items-center gap-1 px-3.5 pb-2" data-testid="toolbar">
    <AppButton
      :icon="Upload"
      :disabled="!canWrite"
      title="Upload files (⌘U)"
      data-testid="upload"
      @click="actions.upload()"
    >
      Upload
    </AppButton>
    <AppButton :icon="FolderPlus" :disabled="!canWrite" data-testid="new-folder" @click="actions.createFolder()">
      Folder
    </AppButton>
    <AppButton :icon="FilePlus" :disabled="!canWrite" data-testid="new-file" @click="actions.createFile()">
      File
    </AppButton>

    <span class="mx-1 h-4 w-px bg-line" />

    <AppButton
      :icon="Download"
      :disabled="!selectionCount"
      data-testid="download"
      @click="actions.downloadSelection()"
    >
      Download
    </AppButton>
    <AppButton :icon="Link2" :disabled="!selectionCount" data-testid="copy-uri" @click="actions.copySelectionUris()">
      URI
    </AppButton>
    <AppButton :icon="Copy" :disabled="!selectionCount || !canWrite" data-testid="copy" @click="actions.transferSelection(false)">
      Copy
    </AppButton>
    <AppButton
      :icon="ArrowRightLeft"
      :disabled="!selectionCount || !canWrite"
      data-testid="move"
      @click="actions.transferSelection(true)"
    >
      Move
    </AppButton>
    <AppButton
      variant="danger"
      :icon="Trash2"
      :disabled="!selectionCount || !canWrite"
      data-testid="delete"
      @click="actions.deleteSelection()"
    >
      Delete
    </AppButton>

    <span class="flex-1" />
    <span class="tabular text-[0.6875rem] text-subtle" data-testid="folder-status">{{ status }}</span>
  </div>
</template>
