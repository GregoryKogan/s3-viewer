<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AlertTriangle, FolderPlus, FolderUp, RefreshCw, SlidersHorizontal, Upload } from "@lucide/vue";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useObjectActions } from "@/composables/useObjectActions";
import ObjectRow from "./ObjectRow.vue";
import EmptyState from "@/components/ui/EmptyState.vue";
import ErrorNotice from "@/components/ui/ErrorNotice.vue";
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

/**
 * An explicit selection brings the checkbox column and the header box with it.
 * Nothing is selected, nothing is reserved: the list carries no empty gutter and
 * no box over every row.
 */
const checkboxColumn = computed(() => objects.selected.size > 0);

const gridTemplate = computed(() =>
  [
    checkboxColumn.value ? "34px" : null,
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

/**
 * The backend warning normally carries the real limit, so the fallback must not
 * invent a count: it only says that the list is cut short.
 */
const truncationMessage = computed(
  () => objects.warning ?? "Only the first objects are shown.",
);

/**
 * What the search banner says. S3 cannot report how many keys a prefix holds, so
 * there is no percentage to show; the number of keys already read is the honest
 * progress, and it moves on every page.
 */
const searchMessage = computed(() => {
  const search = objects.search;
  if (!search) return "";
  if (search.error) return `Search failed: ${search.error}`;
  const scanned = `${search.scanned.toLocaleString()} objects read`;
  const matches = `${search.matched.toLocaleString()} match${search.matched === 1 ? "" : "es"}`;
  if (search.running) return `Searching every folder below · ${scanned} · ${matches} so far`;
  if (search.stopped) return `Search stopped · ${scanned} · ${matches} found`;
  if (search.capped) return `First ${matches} shown · ${scanned}, more may exist`;
  return `Searched ${scanned} · ${matches}`;
});

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

/**
 * Whether a drawn row carries the cursor. Used by CSS to decide between "the
 * cursor row is the focus indicator" and "there is no cursor, draw a ring".
 */
const cursorVisible = computed(
  () => Boolean(objects.focusedKey) && rows.value.some((entry) => entry.key === objects.focusedKey),
);

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

/** Rows that fit on screen, for PageUp/PageDown. */
function pageRows() {
  return Math.max(1, Math.floor(viewportHeight.value / ROW_HEIGHT) - 1);
}

/** Hand the keyboard to the list; the filter field calls this when it commits. */
function focusList() {
  scroller.value?.focus({ preventScroll: true });
}

function onScroll() {
  scrollTop.value = scroller.value?.scrollTop ?? 0;
}

function toggleAll(checked: boolean) {
  if (checked) objects.selectAll(rows.value.map((entry) => entry.key));
  else objects.clearSelection();
}

/**
 * Unticking the last selected row unmounts the box that had focus (the header's
 * select-all); without this the keyboard would fall to <body> and the column
 * model would go quiet.
 */
watch(checkboxColumn, (shown) => {
  if (shown) return;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return;
  if (!active.closest("[data-testid=select-all], [data-testid^=row-check-]")) return;
  void nextTick(() => scroller.value?.focus({ preventScroll: true }));
});

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
 * A plain click is the pointer's arrow key: it moves the cursor and shows the
 * preview without touching the selection. Cmd/Ctrl toggles one row, Shift
 * replaces the selection with the range from the cursor's anchor.
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
    objects.focus(entry.key);
  }
  void objects.previewEntry(entry);
  // The list, not the row div, is the keyboard owner: a click has to hand it
  // the focus so arrows, Shift+F10 and the column keys keep working (KEY-3).
  scroller.value?.focus({ preventScroll: true });
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
  // The menu restores focus to whatever was active when it opened. A
  // right-click does not move DOM focus, so capture the list itself and let
  // the menu return focus here rather than to a stale control.
  scroller.value?.focus({ preventScroll: true });
  emit("contextmenu", entry, event);
}

async function onActivate(entry: (typeof rows.value)[number]) {
  if (entry.isFolder) await objects.navigate(entry.key);
  else await objects.previewEntry(entry, { force: true, reveal: true });
}

defineExpose({ scrollToRow, focusList, pageRows });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="browser" data-focus-zone="list">
    <!-- Truncation is a fact about the listing, not a toast: it stays until the
         next complete listing replaces it (LST-2). -->
    <div
      v-if="objects.truncated || objects.warning"
      class="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3.5 py-1.5 text-warn"
      role="status"
      data-testid="truncation-banner"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <p class="min-w-0 flex-1 text-meta leading-relaxed">{{ truncationMessage }}</p>
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

    <!-- A search walks the whole prefix instead of the rows on screen, so it
         reports what it has read rather than a percentage it cannot know. -->
    <div
      v-if="objects.search"
      class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-inset/60 px-3.5 py-1.5"
      role="status"
      data-testid="search-status"
    >
      <div class="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-hover">
        <div
          class="h-full w-1/3 rounded-full bg-accent"
          :class="objects.search.running ? 'animate-pulse' : 'w-full opacity-60'"
        />
      </div>
      <p
        class="min-w-0 flex-1 text-meta leading-relaxed"
        :class="objects.search.error ? 'text-danger' : 'text-muted'"
      >
        {{ searchMessage }}
      </p>
      <AppButton
        v-if="objects.search.running"
        variant="ghost"
        size="sm"
        data-testid="search-stop"
        @click="objects.stopSearch()"
      >
        Stop
      </AppButton>
    </div>

    <div
      class="grid shrink-0 items-center gap-1.5 border-b border-line px-3.5 text-meta tracking-wide text-subtle uppercase"
      :style="{ gridTemplateColumns: gridTemplate }"
      data-testid="table-head"
    >
      <label v-if="checkboxColumn" class="flex items-center">
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
        class="flex items-center gap-1 text-meta tracking-wide uppercase transition-colors hover:text-content"
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
        <span v-if="objects.sortKey === column.key" class="text-accent-text">
          {{ objects.sortAscending ? "↑" : "↓" }}
        </span>
      </button>
    </div>

    <!-- Focusable even while the folder is empty or loading: the filter field
         hands the keyboard here after Enter, and a tabindex that disappears
         mid-navigation would drop focus on the body the moment the new folder
         starts with zero rows. -->
    <div
      ref="scroller"
      class="scrollbar relative min-h-0 flex-1 overflow-y-auto"
      id="object-list"
      data-testid="object-list"
      :role="rows.length ? 'listbox' : 'group'"
      :aria-multiselectable="rows.length ? true : undefined"
      :aria-label="rows.length ? 'Objects' : 'Object list'"
      :aria-activedescendant="activeDescendant"
      :data-cursor="cursorVisible ? 'true' : undefined"
      :tabindex="0"
      @scroll="onScroll"
      @click="onBackgroundClick"
      @contextmenu="onBackgroundContextMenu"
    >
      <div v-if="!rows.length" class="flex h-full items-center justify-center p-6">
        <Spinner v-if="objects.loading || objects.awaitingFirstPage" label="Loading…" />
        <EmptyState
          v-else-if="objects.error"
          title="This folder could not be listed"
          data-testid="empty-folder"
        >
          <ErrorNotice
            :message="objects.error"
            :hints="objects.errorDetail?.hints"
            :code="objects.errorDetail?.code"
            :request-id="objects.errorDetail?.requestId"
            :retry="objects.reload"
            retry-test-id="retry-listing"
            class="w-full text-left"
          />
        </EmptyState>
        <EmptyState
          v-else-if="objects.search?.running"
          title="Searching every folder below…"
          description="Matches appear here as soon as the scan finds them."
          data-testid="empty-folder"
        />
        <EmptyState
          v-else-if="objects.search && !objects.search.running"
          :title="`Nothing below this folder matches “${objects.search.query}”`"
          :description="`Searched ${objects.search.scanned.toLocaleString()} objects.`"
          data-testid="empty-folder"
        />
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
          v-else
          title="This folder is empty"
          description="Upload a file or create a folder to get started."
          data-testid="empty-folder"
        >
          <div v-if="canWrite" class="flex flex-wrap items-center justify-center gap-2">
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
              :icon="FolderUp"
              data-testid="empty-upload-folder"
              @click="actions.uploadFolder()"
            >
              Upload folder
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
          :pos-in-set="row.index + 1"
          :set-size="rows.length"
          :selected="objects.selected.has(row.entry.key)"
          :focused="objects.focusedKey === row.entry.key"
          :checkbox-column="checkboxColumn"
          @click="onClick"
          @activate="onActivate"
          @toggle-check="onToggleCheck"
          @contextmenu="onContextMenu"
        />
      </div>
    </div>
  </div>
</template>
