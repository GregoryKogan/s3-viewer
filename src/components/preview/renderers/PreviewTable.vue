<script setup lang="ts">
import { computed } from "vue";
import { Download } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { detectDelimiter, parseDelimited } from "@/lib/previewText";
import { humanSize } from "@/lib/format";
import type { PreviewData } from "@/types";

const props = defineProps<{ data: PreviewData }>();
const emit = defineEmits<{ download: [] }>();

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
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
      <span class="tabular text-[0.6875rem] text-subtle">{{ humanSize(props.data.size) }}</span>
      <AppButton size="sm" variant="ghost" :icon="Download" class="ml-auto" @click="emit('download')">
        Download
      </AppButton>
    </div>

    <div class="scrollbar min-h-0 flex-1 overflow-auto p-3" data-testid="preview-table">
      <table v-if="table.rows.length" class="tabular w-full border-collapse text-[0.6875rem]">
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
              :title="row[columnIndex] ?? ''"
            >
              {{ row[columnIndex] ?? "" }}
            </td>
          </tr>
        </tbody>
      </table>

      <p v-else class="text-[0.6875rem] text-muted">This file has no rows.</p>

      <p class="mt-2 text-[0.6875rem] text-subtle">{{ note }}</p>
    </div>
  </div>
</template>
