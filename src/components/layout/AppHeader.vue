<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Search, RefreshCw, PanelRight } from "@lucide/vue";
import AddressBar from "./AddressBar.vue";
import AppToolbar from "./AppToolbar.vue";
import AppButton from "@/components/ui/AppButton.vue";
import { inputClass } from "@/components/ui/controls";
import { shortcutLabel } from "@/lib/keyboard";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useUiStore } from "@/stores/ui";

const connections = useConnectionsStore();
const objects = useObjectsStore();
const ui = useUiStore();

const hasConnection = computed(() => Boolean(connections.active));

const filterValue = ref("");

const emit = defineEmits<{
  /** Enter or ↓ in the field: hand the keyboard to the matched rows. */
  find: [open: boolean];
  /** Escape in the field: drop the filter and go back to the list. */
  "find-clear": [];
}>();

/** The filter is local state, debounced into the store. */
let filterTimer: ReturnType<typeof setTimeout> | undefined;
function onFilterInput() {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterTimer = undefined;
    objects.filter = filterValue.value;
  }, 120);
}

/**
 * Apply the pending keystroke before the list acts on it.
 *
 * Enter can arrive well inside the 120 ms debounce, and handing over the row
 * that matched the *previous* text is the one wrong answer a find gesture can
 * give (KEY-4).
 */
function flushFilter() {
  if (filterTimer) {
    clearTimeout(filterTimer);
    filterTimer = undefined;
  }
  if (objects.filter !== filterValue.value) objects.filter = filterValue.value;
}

/**
 * The field is a find control, not a text area. Once the text names what the
 * user is after, ↓ and Enter have to reach the list: finding an object with the
 * keyboard and then reaching for the mouse to open it defeats the search.
 */
function onFilterKeydown(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "Enter") {
    event.preventDefault();
    flushFilter();
    emit("find", event.key === "Enter");
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (filterTimer) {
      clearTimeout(filterTimer);
      filterTimer = undefined;
    }
    filterValue.value = "";
    objects.filter = "";
    emit("find-clear");
  }
}

/**
 * The store owns the applied filter and clears it when the folder changes
 * (LST-3), so the field follows it back. Cancelling the pending debounce is part
 * of the sync: otherwise text typed just before a folder change would be
 * applied to the new folder a moment later.
 */
watch(
  () => [objects.filter, objects.prefix] as const,
  () => {
    if (filterTimer) {
      clearTimeout(filterTimer);
      filterTimer = undefined;
    }
    if (filterValue.value !== objects.filter) filterValue.value = objects.filter;
  },
);

const previewOpen = computed(() => !ui.previewHidden);

/**
 * Showing the panel is what triggers the deferred preview fetch: the store
 * remembers the key while the panel is hidden (PRV-4). The panel itself watches
 * visibility, so an automatic reveal (widening the window) fetches too.
 */
function togglePreviewPanel() {
  ui.togglePreview();
}
</script>

<template>
  <header class="flex shrink-0 flex-col border-b border-line">
    <div class="flex items-center gap-2 px-3.5 pt-2 pb-1.5">
      <AddressBar class="min-w-0 flex-1" />

      <div class="flex shrink-0 items-center gap-1">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-subtle" />
          <input
            v-model="filterValue"
            type="search"
            :class="[inputClass, 'w-48 py-1 pl-7']"
            placeholder="Filter this folder…"
            aria-label="Filter this folder"
            data-testid="filter-input"
            autocomplete="off"
            @input="onFilterInput"
            @keydown="onFilterKeydown"
          />
        </div>

        <AppButton
          variant="ghost"
          :icon="RefreshCw"
          :busy="objects.loading"
          :title="`Refresh (${shortcutLabel('R')})`"
          data-testid="refresh"
          @click="objects.reload()"
        />

        <AppButton
          variant="ghost"
          :icon="PanelRight"
          :title="previewOpen ? 'Hide the preview panel' : 'Show the preview panel'"
          :aria-pressed="previewOpen"
          :class="previewOpen ? 'bg-active text-content' : ''"
          data-testid="toggle-preview"
          @click="togglePreviewPanel()"
        />
      </div>
    </div>

    <AppToolbar v-if="hasConnection" />
  </header>
</template>
