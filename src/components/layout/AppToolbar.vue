<script setup lang="ts">
import { computed } from "vue";
import { Copy, Download, FilePlus, FolderPlus, MoveRight, Trash2, Upload, X } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { humanSize } from "@/lib/format";
import { IS_MAC, shortcutLabel } from "@/lib/keyboard";
import { useObjectActions } from "@/composables/useObjectActions";

const emit = defineEmits<{ moved: [] }>();

const objects = useObjectsStore();
const connections = useConnectionsStore();
const actions = useObjectActions({ onChanged: () => emit("moved") });

const selectionCount = computed(() => objects.selected.size);
const canWrite = computed(() => connections.canWriteActive && Boolean(connections.active));
/** macOS deletes with ⌘⌫; Linux deletes with the forward-delete key. */
const deleteShortcut = IS_MAC ? shortcutLabel("Backspace") : "Del";

const status = computed(() => {
  // Only what is on screen: a folder with a filter applied must not report the
  // whole listing (LST-4).
  const visible = objects.visibleEntries;
  const files = visible.filter((entry) => !entry.isFolder).length;
  const folders = visible.length - files;
  const totalFiles = objects.entries.filter((entry) => !entry.isFolder).length;
  const bytes = visible.reduce((sum, entry) => sum + (entry.isFolder ? 0 : entry.size), 0);
  const fileLabel = objects.filter.trim()
    ? `${files} of ${totalFiles} file${totalFiles === 1 ? "" : "s"}`
    : `${files} file${files === 1 ? "" : "s"}`;
  const parts = [`${folders} folder${folders === 1 ? "" : "s"}`, fileLabel, humanSize(bytes)];
  if (objects.truncated) parts.push("truncated");
  return parts.join(" · ");
});
</script>

<template>
  <div id="toolbar" class="flex min-h-9 flex-wrap items-center gap-1 px-3.5 pb-2" data-testid="toolbar">
    <AppButton
      :icon="Upload"
      :disabled="!canWrite"
      :title="`Upload files (${shortcutLabel('U')})`"
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
      New folder
    </AppButton>
    <AppButton
      :icon="FilePlus"
      :disabled="!canWrite"
      title="New file"
      data-testid="new-file"
      @click="actions.createFile()"
    >
      New file
    </AppButton>

    <!-- The create actions stay put; the bulk actions append to them exactly
         while a selection exists. -->
    <template v-if="selectionCount">
      <span class="mx-1 h-4 w-px bg-line" />
      <span class="text-xs font-medium text-content" data-testid="selection-count">
        {{ selectionCount }} selected
      </span>
      <AppButton
        :icon="Download"
        title="Download the selected files"
        data-testid="download"
        @click="actions.downloadSelection()"
      >
        Download
      </AppButton>
      <AppButton
        :icon="Copy"
        title="Copy the S3 URIs of the selected objects"
        data-testid="copy-uri"
        @click="actions.copySelectionUris()"
      >
        URI
      </AppButton>
      <AppButton
        :icon="MoveRight"
        :disabled="!canWrite"
        title="Copy the selected objects to another folder"
        data-testid="copy"
        @click="actions.transferSelection(false)"
      >
        Copy to…
      </AppButton>
      <AppButton
        :icon="MoveRight"
        :disabled="!canWrite"
        title="Move the selected objects to another folder"
        data-testid="move"
        @click="actions.transferSelection(true)"
      >
        Move to…
      </AppButton>
      <AppButton
        variant="danger"
        :icon="Trash2"
        :disabled="!canWrite"
        :title="`Delete the selected objects (${deleteShortcut})`"
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
