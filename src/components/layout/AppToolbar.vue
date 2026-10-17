<script setup lang="ts">
import { computed } from "vue";
import { Copy, Download, FilePlus, FolderPlus, MoveRight, Trash2, Upload, X } from "@lucide/vue";
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

/** Nothing selected: only the actions that create or open something are shown. */
const idle = computed(() => selectionCount.value === 0);

const status = computed(() => {
  const files = objects.entries.filter((entry) => !entry.isFolder).length;
  const folders = objects.entries.length - files;
  const bytes = objects.entries.reduce((sum, entry) => sum + (entry.isFolder ? 0 : entry.size), 0);
  const parts = [
    `${folders} folder${folders === 1 ? "" : "s"}`,
    `${files} file${files === 1 ? "" : "s"}`,
    humanSize(bytes),
  ];
  if (objects.loading) parts.push("loading…");
  if (objects.truncated) parts.push("truncated");
  return parts.join(" · ");
});
</script>

<template>
  <div id="toolbar" class="flex min-h-9 flex-wrap items-center gap-1 px-3.5 pb-2" data-testid="toolbar">
    <template v-if="idle">
      <AppButton
        :icon="Upload"
        :disabled="!canWrite"
        title="Upload files (⌘U)"
        data-testid="upload"
        @click="actions.upload()"
      >
        Upload
      </AppButton>
      <AppButton
        :icon="FolderPlus"
        :disabled="!canWrite"
        title="New folder"
        data-testid="new-folder"
        @click="actions.createFolder()"
      >
        Folder
      </AppButton>
      <AppButton
        :icon="FilePlus"
        :disabled="!canWrite"
        title="New file"
        data-testid="new-file"
        @click="actions.createFile()"
      >
        File
      </AppButton>
    </template>

    <!-- A selection replaces the create actions instead of piling on top of
         them: at rest the toolbar stays short, and the bulk actions appear
         exactly when they apply. -->
    <template v-else>
      <span class="text-xs font-medium text-content" data-testid="selection-count">
        {{ selectionCount }} selected
      </span>
      <span class="mx-1 h-4 w-px bg-line" />
      <AppButton :icon="Download" data-testid="download" @click="actions.downloadSelection()">
        Download
      </AppButton>
      <AppButton :icon="Copy" data-testid="copy-uri" @click="actions.copySelectionUris()">URI</AppButton>
      <AppButton
        :icon="MoveRight"
        :disabled="!canWrite"
        data-testid="copy"
        @click="actions.transferSelection(false)"
      >
        Copy to…
      </AppButton>
      <AppButton
        :icon="MoveRight"
        :disabled="!canWrite"
        data-testid="move"
        @click="actions.transferSelection(true)"
      >
        Move to…
      </AppButton>
      <AppButton
        variant="danger"
        :icon="Trash2"
        :disabled="!canWrite"
        data-testid="delete"
        @click="actions.deleteSelection()"
      >
        Delete
      </AppButton>
      <AppButton
        variant="ghost"
        :icon="X"
        title="Clear the selection (Esc)"
        data-testid="clear-selection"
        @click="objects.clearSelection()"
      />
    </template>

    <span class="flex-1" />
    <span class="tabular text-[0.6875rem] text-subtle" data-testid="folder-status">{{ status }}</span>
  </div>
</template>
