<script setup lang="ts">
import { computed, ref } from "vue";
import { Search, RefreshCw, PanelRight } from "@lucide/vue";
import AddressBar from "./AddressBar.vue";
import AppToolbar from "./AppToolbar.vue";
import AppButton from "@/components/ui/AppButton.vue";
import { inputClass } from "@/components/ui/controls";
import { useObjectsStore } from "@/stores/objects";
import { useUiStore } from "@/stores/ui";

const objects = useObjectsStore();
const ui = useUiStore();

const filterValue = ref("");

/** The filter is local state, debounced into the store. */
let filterTimer: ReturnType<typeof setTimeout> | undefined;
function onFilterInput() {
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    objects.filter = filterValue.value;
  }, 120);
}

const previewOpen = computed(() => !ui.previewHidden);
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
            data-testid="filter-input"
            autocomplete="off"
            @input="onFilterInput"
          />
        </div>

        <AppButton
          variant="ghost"
          :icon="RefreshCw"
          title="Refresh (⌘R)"
          data-testid="refresh"
          @click="objects.reload()"
        />

        <AppButton
          variant="ghost"
          :icon="PanelRight"
          :title="previewOpen ? 'Hide the preview panel' : 'Show the preview panel'"
          data-testid="toggle-preview"
          @click="ui.togglePreview()"
        />
      </div>
    </div>

    <AppToolbar />
  </header>
</template>
