<script setup lang="ts">
import { computed, nextTick } from "vue";
import { Copy, Download, FilePlus, FolderPlus, MoveRight, Trash2, Upload, X } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { humanSize } from "@/lib/format";
import { IS_MAC, shortcutLabel } from "@/lib/keyboard";
import { useObjectActions } from "@/composables/useObjectActions";

const objects = useObjectsStore();
const connections = useConnectionsStore();
const actions = useObjectActions();

const emit = defineEmits<{
  /** The Upload button was pressed: the shell opens its menu under the button. */
  "upload-menu": [point: { x: number; y: number }];
}>();

const selectionCount = computed(() => objects.selected.size);
const canWrite = computed(() => connections.canWriteActive && Boolean(connections.active));
/** macOS deletes with ⌘⌫; Linux deletes with the forward-delete key. */
const deleteShortcut = IS_MAC ? shortcutLabel("Backspace") : "Del";

/**
 * The Upload button offers both pickers.
 *
 * A native open panel cannot select files and folders at once (it shows either),
 * so one button cannot cover both. The menu itself belongs to the shell, which
 * already owns the row menu's keyboard: arrows and Escape must not reach the
 * list behind it. "⌘U" stays the one-key fast path for files.
 */
function openUploadMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  emit("upload-menu", {
    x: Math.round(rect?.left ?? 0),
    y: Math.round((rect?.bottom ?? 0) + 4),
  });
}

/** The Clear button unmounts with the selection; keep the keyboard on the list. */
async function clearSelection() {
  objects.clearSelection();
  await nextTick();
  document.getElementById("object-list")?.focus({ preventScroll: true });
}

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
      :title="`Upload files or a folder (${shortcutLabel('U')} picks files)`"
      data-testid="upload"
      @click="openUploadMenu"
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

    <!-- One selected row is the common case: its actions live in the row menu
         and in the preview header, so the bar only reports the selection. The
         bulk actions appear from two rows on, where neither of those can act on
         every row at once (SEL-5). -->
    <template v-if="selectionCount">
      <span class="mx-1 h-4 w-px bg-line" />
      <span class="text-xs font-medium text-content" data-testid="selection-count">
        {{ selectionCount }} selected
      </span>
      <template v-if="selectionCount > 1">
        <AppButton
          :icon="Download"
          :title="`Download ${selectionCount} selected item(s) to one folder`"
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
          Copy S3 URIs
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
      </template>
      <AppButton
        variant="ghost"
        :icon="X"
        title="Clear the selection (Esc)"
        data-testid="clear-selection"
        @click="clearSelection"
      />
    </template>

    <span class="flex-1" />
    <span class="tabular text-meta text-subtle" data-testid="folder-status">{{ status }}</span>
  </div>
</template>
