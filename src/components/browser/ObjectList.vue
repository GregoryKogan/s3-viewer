<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useObjectsStore } from "@/stores/objects";
import ObjectRow from "./ObjectRow.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import Spinner from "@/components/ui/Spinner.vue";
import type { ObjectEntry } from "@/types";

const ROW_HEIGHT = 30;
const OVERSCAN = 8;

const emit = defineEmits<{
  contextmenu: [entry: ObjectEntry, event: MouseEvent];
  background: [event: MouseEvent];
}>();

const objects = useObjectsStore();

const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const viewportWidth = ref(900);

/**
 * Columns are dropped as the list narrows rather than being squeezed: a TYPE
 * column clipped to "Cod" and "Bin" is worse than no column at all.
 */
const showModified = computed(() => viewportWidth.value >= 620);
const showType = computed(() => viewportWidth.value >= 760);

const gridTemplate = computed(() =>
  [
    "34px",
    "minmax(180px, 1fr)",
    "88px",
    showModified.value ? "150px" : null,
    showType.value ? "86px" : null,
  ]
    .filter(Boolean)
    .join(" "),
);

const rows = computed(() => objects.visibleEntries);

const totalHeight = computed(() => rows.value.length * ROW_HEIGHT);

/** Only the rows inside the viewport (plus overscan) are ever rendered. */
const windowed = computed(() => {
  const first = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2;
  const last = Math.min(rows.value.length, first + count);
  return rows.value.slice(first, last).map((entry, offset) => ({ entry, index: first + offset }));
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
 * A plain click moves the focus and shows the preview; it never ticks a box.
 * Shift extends the range, Cmd/Ctrl toggles a single row.
 */
function onClick(entry: (typeof rows.value)[number], event: MouseEvent) {
  const extending = event.shiftKey;
  // The range is computed from the anchor set by the previous click, so focus
  // has to move without stealing it.
  if (extending) objects.selectRange(entry.key);
  objects.focus(entry.key, { keepAnchor: extending });
  if (!extending && (event.metaKey || event.ctrlKey)) objects.toggleSelected(entry.key);
  void objects.previewEntry(entry);
}

/** Clicking the checkbox selects without moving focus to another row's preview. */
function onToggleCheck(entry: (typeof rows.value)[number], event: MouseEvent) {
  if (event.shiftKey) {
    objects.selectRange(entry.key);
    objects.toggleSelected(entry.key);
  }
}

function onToggleCheckbox(entry: (typeof rows.value)[number]) {
  objects.toggleSelected(entry.key);
}

function onContextMenu(entry: (typeof rows.value)[number], event: MouseEvent) {
  // Right-clicking a row that is not selected acts on that row alone.
  if (!objects.selected.has(entry.key)) {
    objects.clearSelection();
    objects.toggleSelected(entry.key);
  }
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
    <div
      class="grid shrink-0 items-center gap-1.5 border-b border-line px-3.5 text-[0.6875rem] tracking-wide text-subtle uppercase"
      :style="{ gridTemplateColumns: gridTemplate }"
      data-testid="table-head"
    >
      <label class="flex items-center">
        <input
          type="checkbox"
          class="size-3.5 cursor-pointer accent-accent"
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
      @scroll="onScroll"
      @contextmenu.self.prevent="emit('background', $event)"
    >
      <div v-if="!rows.length" class="flex h-full items-center justify-center p-6">
        <Spinner v-if="objects.loading || objects.awaitingFirstPage" label="Loading…" />
        <EmptyState
          v-else-if="objects.filter"
          title="Nothing matches the filter"
          description="Clear the filter to see the whole folder."
          data-testid="empty-folder"
        />
        <EmptyState
          v-else-if="objects.error"
          title="This folder could not be listed"
          :description="objects.error"
          data-testid="empty-folder"
        />
        <EmptyState
          v-else
          title="This folder is empty"
          description="Upload a file or create a folder to get started."
          data-testid="empty-folder"
        />
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
          @toggle-checkbox="onToggleCheckbox"
          @contextmenu="onContextMenu"
        />
      </div>
    </div>
  </div>
</template>
