<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useObjectsStore } from "@/stores/objects";
import ObjectRow from "./ObjectRow.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import { useObjectActions } from "@/composables/useObjectActions";
import Spinner from "@/components/ui/Spinner.vue";

const ROW_HEIGHT = 30;
const OVERSCAN = 8;

const objects = useObjectsStore();
const actions = useObjectActions();

const scroller = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);

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
  observer = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight || 600;
  });
  observer.observe(element);
});

onBeforeUnmount(() => observer?.disconnect());

function onSelect(entry: (typeof rows.value)[number], event: MouseEvent) {
  objects.selectOnly(entry.key, event.shiftKey);
  void objects.previewEntry(entry);
}

async function onActivate(entry: (typeof rows.value)[number]) {
  if (entry.isFolder) await objects.navigate(entry.key);
  else await objects.previewEntry(entry, { force: true });
}

function onToggleCheck(entry: (typeof rows.value)[number]) {
  objects.toggleSelected(entry.key);
}

function onCopyUri(entry: (typeof rows.value)[number]) {
  void actions.copyUri(entry);
}

defineExpose({ scrollToRow });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="browser">
    <div
      class="grid shrink-0 grid-cols-[34px_minmax(180px,1fr)_92px_168px_92px] items-center gap-1.5 border-b border-line px-3.5 text-[0.6875rem] tracking-wide text-subtle uppercase"
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
          { key: 'name', label: 'Name' },
          { key: 'size', label: 'Size' },
          { key: 'modified', label: 'Modified' },
          { key: 'kind', label: 'Type' },
        ]"
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
          :selected="objects.selected.has(row.entry.key)"
          @select="onSelect"
          @activate="onActivate"
          @toggle-check="onToggleCheck"
          @copy-uri="onCopyUri"
        />
      </div>
    </div>
  </div>
</template>
