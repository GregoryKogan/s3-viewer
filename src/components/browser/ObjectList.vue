<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, FolderPlus, RefreshCw, SlidersHorizontal, Upload } from "@lucide/vue";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useObjectActions } from "@/composables/useObjectActions";
import ObjectRow from "./ObjectRow.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import AppButton from "@/components/ui/AppButton.vue";
import Spinner from "@/components/ui/Spinner.vue";
import type { ObjectEntry } from "@/types";

const ROW_HEIGHT = 30;
const OVERSCAN = 8;

const emit = defineEmits<{
  contextmenu: [entry: ObjectEntry, event: MouseEvent];
  background: [event: MouseEvent];
  settings: [];
}>();

const objects = useObjectsStore();
const connections = useConnectionsStore();
const actions = useObjectActions();

const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const viewportWidth = ref(900);

/**
 * Columns are dropped as the list narrows rather than being squeezed: a TYPE
 * column clipped to "Cod" and "Bin" is worse than no column at all. The
 * thresholds are low enough for the default 1280×820 window, where the list is
 * left with roughly 596 px and the dates must still be readable (LST-1).
 */
const showModified = computed(() => viewportWidth.value >= 480);
const showType = computed(() => viewportWidth.value >= 820);

const canWrite = computed(() => connections.canWriteActive);

const gridTemplate = computed(() =>
  [
    "34px",
    "minmax(150px, 1fr)",
    "88px",
    showModified.value ? "132px" : null,
    showType.value ? "86px" : null,
  ]
    .filter(Boolean)
    .join(" "),
);

const rows = computed(() => objects.visibleEntries);

/** Sort state is conveyed in the button's name: `aria-sort` is invalid on a button. */
function sortLabel(column: { key: string; label: string }): string {
  if (objects.sortKey !== column.key) return `Sort by ${column.label}`;
  return `Sort by ${column.label}, ${objects.sortAscending ? "ascending" : "descending"}`;
}

/** The backend explains the limit; the fallback covers a truncation with no text. */
const truncationMessage = computed(
  () => objects.warning ?? `Only the first ${objects.entries.length} objects are shown.`,
);

const totalHeight = computed(() => rows.value.length * ROW_HEIGHT);

/** Only the rows inside the viewport (plus overscan) are ever rendered. */
const windowed = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(rows.value.length, first + count);
  return rows.value.slice(first, last).map((entry, offset) => ({ entry, index: first + offset }));
});

/**
 * The focused row is the listbox's active option. Only a row that is actually
 * drawn can be referenced, so a focus scrolled out of the virtual window (or
 * filtered out) simply omits the attribute instead of dangling.
 */
const activeDescendant = computed(() => {
  const focused = objects.focusedKey;
  if (!focused) return undefined;
  const drawn = windowed.value.find((row) => row.entry.key === focused);
  return drawn ? `row-${drawn.index}` : undefined;
});

const selectedVisible = computed(() => {
  const all = rows.value.length > 0 && rows.value.every((entry) => objects.selected.has(entry.key));
  const some = !all && rows.value.some((entry) => objects.selected.has(entry.key));
  return { all, some };
});

/** Checkboxes are hidden until a selection exists, so the list stays quiet. */
const selectionActive = computed(() => objects.selected.size > 0);

/** Bring one row into view; keyboard navigation and the e2e suite both need it. */
function scrollToRow(index: number) {
  const element = scroller.value;
  if (!element || index < 0) return;
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (bottom > element.scrollTop + element.clientHeight) {
    element.scrollTop = bottom - element.clientHeight;
  }
  scrollTop.value = element.scrollTop;
}

function onScroll() {
  scrollTop.value = scroller.value?.scrollTop ?? 0;
}

function toggleAll(checked: boolean) {
  if (checked) objects.selectAll(rows.value.map((entry) => entry.key));
  else objects.clearSelection();
}

// A new folder or filter starts at the top.
watch(
  () => [objects.prefix, objects.filter],
  () => {
    if (scroller.value) scroller.value.scrollTop = 0;
    scrollTop.value = 0;
  },
);

let observer: ResizeObserver | undefined;

onMounted(() => {
  const element = scroller.value;
  if (!element) return;
  viewportHeight.value = element.clientHeight || 600;
  viewportWidth.value = element.clientWidth || 900;
  observer = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight || 600;
    viewportWidth.value = element.clientWidth || 900;
  });
  observer.observe(element);
});

onBeforeUnmount(() => observer?.disconnect());

/**
 * A plain click selects exactly one row and shows its preview; Cmd/Ctrl toggles
 * one row, Shift replaces the selection with the range from the anchor.
 */
function onClick(entry: (typeof rows.value)[number], event: MouseEvent) {
  const modifier = event.metaKey || event.ctrlKey;
  // The range is computed from the anchor set by the previous click, so focus
  // has to move without stealing it.
  if (event.shiftKey) {
    objects.selectRange(entry.key);
    objects.focus(entry.key, { keepAnchor: true });
  } else if (modifier) {
    objects.toggleSelected(entry.key);
    objects.focus(entry.key);
  } else {
    objects.selectOnly(entry.key);
    objects.focus(entry.key);
  }
  void objects.previewEntry(entry);
}

/** Clicking the empty scroller behind the rows is the fastest way to deselect. */
function onBackgroundClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target?.closest || target.closest(".object-row")) return;
  objects.clearSelection();
  objects.focus(null);
}

/**
 * Right-click on the empty area opens the folder menu.
 *
 * Rows already emit their own menu and stop the event, but the empty-state card
 * fills the scroller, so the old `.self` binding never fired there (NAV-6).
 */
function onBackgroundContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest(".object-row")) return;
  event.preventDefault();
  emit("background", event);
}

/** The checkbox is a secondary, explicit path; it must not toggle twice. */
function onToggleCheck(entry: (typeof rows.value)[number], event: MouseEvent) {
  if (event.shiftKey) objects.selectRange(entry.key);
  else objects.toggleSelected(entry.key);
}

function onContextMenu(entry: (typeof rows.value)[number], event: MouseEvent) {
  // A context menu acts on one set. Right-clicking a row that is not selected
  // selects it alone first, so no item can apply to a different set than the
  // row the user pointed at (SEL-4).
  if (!objects.selected.has(entry.key)) objects.selectOnly(entry.key);
  objects.focus(entry.key, { keepAnchor: true });
  emit("contextmenu", entry, event);
}

async function onActivate(entry: (typeof rows.value)[number]) {
  if (entry.isFolder) await objects.navigate(entry.key);
  else await objects.previewEntry(entry, { force: true });
}

defineExpose({ scrollToRow });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="browser">
    <!-- Truncation is a fact about the listing, not a toast: it stays until the
         next complete listing replaces it (LST-2). -->
    <div
      v-if="objects.truncated || objects.warning"
      class="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3.5 py-1.5 text-warn"
      role="status"
      data-testid="truncation-banner"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <p class="min-w-0 flex-1 text-[0.6875rem] leading-relaxed">{{ truncationMessage }}</p>
      <AppButton
        variant="ghost"
        size="sm"
        :icon="RefreshCw"
        data-testid="truncation-retry"
        @click="objects.reload()"
      >
        Retry
      </AppButton>
      <AppButton
        variant="ghost"
        size="sm"
        :icon="SlidersHorizontal"
        data-testid="truncation-settings"
        @click="emit('settings')"
      >
        Open settings
      </AppButton>
    </div>

    <div
      class="grid shrink-0 items-center gap-1.5 border-b border-line px-3.5 text-[0.6875rem] tracking-wide text-subtle uppercase"
      :style="{ gridTemplateColumns: gridTemplate }"
      data-testid="table-head"
    >
      <label class="flex items-center">
        <input
          type="checkbox"
          class="size-3.5 cursor-pointer accent-accent"
          aria-label="Select all visible objects"
          data-testid="select-all"
          :checked="selectedVisible.all"
          :indeterminate="selectedVisible.some"
          @change="toggleAll(($event.target as HTMLInputElement).checked)"
        />
      </label>
      <button
        v-for="column in [
          { key: 'name', label: 'Name', shown: true },
          { key: 'size', label: 'Size', shown: true },
          { key: 'modified', label: 'Modified', shown: showModified },
          { key: 'kind', label: 'Type', shown: showType },
        ].filter((column) => column.shown)"
        :key="column.key"
        type="button"
        class="flex items-center gap-1 text-[0.6875rem] tracking-wide uppercase transition-colors hover:text-content"
        :class="[
          objects.sortKey === column.key ? 'text-content' : '',
          column.key === 'size' || column.key === 'modified' || column.key === 'kind'
            ? 'justify-end'
            : 'justify-start',
        ]"
        :aria-label="sortLabel(column)"
        @click="objects.setSort(column.key as never)"
      >
        {{ column.label }}
        <span v-if="objects.sortKey === column.key" class="text-accent">
          {{ objects.sortAscending ? "↑" : "↓" }}
        </span>
      </button>
    </div>

    <div
      ref="scroller"
      class="scrollbar relative min-h-0 flex-1 overflow-y-auto"
      id="object-list"
      data-testid="object-list"
      role="listbox"
      aria-multiselectable="true"
      aria-label="Objects"
      :aria-activedescendant="activeDescendant"
      tabindex="0"
      @scroll="onScroll"
      @click="onBackgroundClick"
      @contextmenu="onBackgroundContextMenu"
    >
      <div v-if="!rows.length" class="flex h-full items-center justify-center p-6">
        <Spinner v-if="objects.loading || objects.awaitingFirstPage" label="Loading…" />
        <EmptyState
          v-else-if="objects.filter"
          title="Nothing matches the filter"
          description="Clear the filter to see the whole folder."
          data-testid="empty-folder"
        >
          <AppButton size="sm" data-testid="clear-filter" @click="objects.filter = ''">
            Clear filter
          </AppButton>
        </EmptyState>
        <EmptyState
          v-else-if="objects.error"
          title="This folder could not be listed"
          :description="objects.error"
          data-testid="empty-folder"
        >
          <AppButton
            size="sm"
            :icon="RefreshCw"
            data-testid="retry-listing"
            @click="objects.reload()"
          >
            Try again
          </AppButton>
        </EmptyState>
        <EmptyState
          v-else
          title="This folder is empty"
          description="Upload a file or create a folder to get started."
          data-testid="empty-folder"
        >
          <div v-if="canWrite" class="flex items-center gap-2">
            <AppButton
              size="sm"
              :icon="Upload"
              data-testid="empty-upload"
              @click="actions.upload()"
            >
              Upload files
            </AppButton>
            <AppButton
              size="sm"
              :icon="FolderPlus"
              data-testid="empty-new-folder"
              @click="actions.createFolder()"
            >
              New folder
            </AppButton>
          </div>
        </EmptyState>
      </div>

      <div v-else id="object-rows" :style="{ height: `${totalHeight}px` }" class="relative">
        <ObjectRow
          v-for="row in windowed"
          :key="row.entry.key"
          :entry="row.entry"
          :index="row.index"
          :row-height="ROW_HEIGHT"
          :grid-template="gridTemplate"
          :show-modified="showModified"
          :show-type="showType"
          :selected="objects.selected.has(row.entry.key)"
          :focused="objects.focusedKey === row.entry.key"
          :selection-active="selectionActive"
          @click="onClick"
          @activate="onActivate"
          @toggle-check="onToggleCheck"
          @contextmenu="onContextMenu"
        />
      </div>
    </div>
  </div>
</template>
