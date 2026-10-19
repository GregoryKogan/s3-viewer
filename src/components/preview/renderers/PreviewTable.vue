<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Copy, X } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { detectDelimiter, parseDelimited } from "@/lib/previewText";
import { copyText } from "@/lib/ipc";
import { useToastsStore } from "@/stores/toasts";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();
const toasts = useToastsStore();

const MAX_ROWS = 500;

/**
 * Two sources, one shape: Parquet arrives already parsed from the backend, CSV is
 * parsed here. The table renderer therefore has a single contract.
 */
const table = computed(() => {
  if (props.data.table) return props.data.table;

  const text = props.data.text ?? "";
  const delimiter = props.data.key.toLowerCase().endsWith(".tsv") ? "\t" : detectDelimiter(text);
  const rows = parseDelimited(text, delimiter).slice(0, MAX_ROWS);
  const [header = [], ...body] = rows;
  return {
    columns: header,
    rows: body,
    totalRows: body.length,
    truncatedRows: rows.length >= MAX_ROWS,
    truncatedColumns: false,
  };
});

const note = computed(() => {
  const parts = [
    `${table.value.columns.length} column(s)`,
    `${table.value.totalRows.toLocaleString()} row(s)`,
  ];
  if (table.value.truncatedRows) parts.push(`showing the first ${table.value.rows.length}`);
  if (table.value.truncatedColumns) parts.push(`showing the first ${table.value.columns.length} columns`);
  return parts.join(" · ");
});

/**
 * A row has to stay readable, so a cell truncates. The value itself is often the
 * point though — a clipped s3:// URI cannot be copied, and the native tooltip
 * vanishes as soon as the pointer moves towards it. A click therefore opens the
 * whole value in a card that can be read, scrolled and copied.
 */
interface OpenCell {
  value: string;
  column: string;
  /** The clicked cell: the card is placed against it and closed by clicking it again. */
  anchor: HTMLTableCellElement;
}

const open = ref<OpenCell | null>(null);
const card = ref<HTMLElement | null>(null);
const position = ref({ left: 0, top: 0 });

function closeCell() {
  open.value = null;
}

/**
 * Under the cell, above it when the window's bottom edge is closer, and never
 * outside the window. The card is teleported to the body, so no scrolling
 * ancestor can clip it.
 */
function placeCard() {
  const element = card.value;
  const anchor = open.value?.anchor;
  if (!element || !anchor) return;
  const target = anchor.getBoundingClientRect();
  const { width, height } = element.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const below = target.bottom + gap;
  const above = target.top - gap - height;
  const top = below + height > window.innerHeight - margin && above >= margin ? above : below;
  position.value = {
    left: Math.max(margin, Math.min(target.left, window.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(top, window.innerHeight - height - margin)),
  };
}

watch(open, placeCard, { flush: "post" });

function openCell(event: MouseEvent, value: string, column: string) {
  const anchor = event.currentTarget as HTMLTableCellElement;
  // The cell that owns an open card toggles it instead of reopening it.
  if (open.value?.anchor === anchor) {
    closeCell();
    return;
  }
  // A drag that selected text also ends in a click; that gesture is the user
  // reading the cell, not asking for the card. An empty value has nothing to show.
  if (!value || !window.getSelection()?.isCollapsed) return;
  const rect = anchor.getBoundingClientRect();
  position.value = { left: rect.left, top: rect.bottom + 4 };
  open.value = { value, column, anchor };
}

async function copyValue() {
  const value = open.value?.value;
  if (!value) return;
  if (await copyText(value)) toasts.ok("Copied the cell value");
  else toasts.error("The clipboard is not available.");
}

function onPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target as Element | null;
  if (card.value?.contains(target) || open.value.anchor.contains(target)) return;
  closeCell();
}

function onKeydown(event: KeyboardEvent) {
  if (!open.value || event.key !== "Escape") return;
  // A modal owns Escape while it is up, even a card that was open before it.
  if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
  event.preventDefault();
  closeCell();
}

function onScroll(event: Event) {
  if (!open.value || card.value?.contains(event.target as Node)) return;
  const rect = open.value.anchor.getBoundingClientRect();
  // The cell left the viewport: a card pinned to an invisible row would float
  // over unrelated data.
  if (rect.bottom < 0 || rect.top > window.innerHeight) closeCell();
  else placeCard();
}

function onResize() {
  if (open.value) placeCard();
}

/*
 * The card is mouse-born, like the tooltip it replaces, so it owns no focus. It
 * still has to close the way an overlay does: Escape, a click elsewhere, or the
 * table scrolling away underneath it.
 */
onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="scrollbar min-h-0 flex-1 overflow-auto p-3" tabindex="-1" data-preview-scroll data-testid="preview-table">
      <table v-if="table.rows.length" class="tabular w-full border-collapse text-meta">
        <thead>
          <tr>
            <th
              v-for="column in table.columns"
              :key="column"
              class="sticky top-0 z-10 max-w-80 truncate border border-line bg-surface-2 px-2 py-1 text-left font-semibold text-content"
              :title="column"
            >
              {{ column }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in table.rows" :key="index" class="hover:bg-hover">
            <td
              v-for="(_, columnIndex) in table.columns"
              :key="columnIndex"
              class="max-w-80 truncate border border-line px-2 py-0.5 text-content/90"
              :class="row[columnIndex] ? 'cursor-pointer' : ''"
              :title="row[columnIndex] ?? ''"
              @click="openCell($event, row[columnIndex] ?? '', table.columns[columnIndex] ?? '')"
            >
              {{ row[columnIndex] ?? "" }}
            </td>
          </tr>
        </tbody>
      </table>

      <p v-else class="text-meta text-muted">This file has no rows.</p>

      <p class="mt-2 text-meta text-subtle">{{ note }}</p>
    </div>
  </div>

  <Teleport to="body">
    <div
      v-if="open"
      ref="card"
      class="fixed z-[60] flex max-h-[calc(100vh-1rem)] w-[32rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-panel border border-line-strong bg-elevated shadow-2xl shadow-black/50"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      role="dialog"
      :aria-label="open.column ? `Cell in column ${open.column}` : 'Cell value'"
      data-testid="table-cell-detail"
    >
      <header class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <span
          class="min-w-0 flex-1 truncate px-1 text-micro font-medium text-subtle"
          :title="open.column"
        >
          {{ open.column || "Cell" }}
        </span>
        <AppButton
          size="sm"
          :icon="Copy"
          title="Copy the full value"
          aria-label="Copy the full value"
          data-testid="table-cell-detail-copy"
          @click="copyValue()"
        >
          Copy
        </AppButton>
        <button
          type="button"
          class="grid size-6 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
          aria-label="Close"
          title="Close"
          data-testid="table-cell-detail-close"
          @click="closeCell()"
        >
          <X class="size-3.5" />
        </button>
      </header>
      <pre
        class="scrollbar min-h-0 flex-1 select-text overflow-auto p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-content"
      >{{ open.value }}</pre>
    </div>
  </Teleport>
</template>
