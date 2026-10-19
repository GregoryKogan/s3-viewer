<script setup lang="ts">
import { computed } from "vue";
import { kindStyle } from "./kindIcon";
import { humanDate, humanSize } from "@/lib/format";
import { kindLabel } from "@/lib/fileKind";
import type { ObjectEntry } from "@/types";

const props = defineProps<{
  entry: ObjectEntry;
  index: number;
  rowHeight: number;
  gridTemplate: string;
  showModified: boolean;
  showType: boolean;
  selected: boolean;
  focused: boolean;
  /** The checkbox column exists as soon as any row is selected. */
  checkboxColumn: boolean;
}>();

const emit = defineEmits<{
  activate: [entry: ObjectEntry];
  click: [entry: ObjectEntry, event: MouseEvent];
  contextmenu: [entry: ObjectEntry, event: MouseEvent];
  toggleCheck: [entry: ObjectEntry, event: MouseEvent];
}>();

const style = computed(() => kindStyle(props.entry.kind));

/** The cell is short on purpose; the tooltip carries the whole timestamp. */
const modifiedTitle = computed(() => {
  const value = props.entry.lastModified;
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
});
</script>

<template>
  <div
    class="object-row group absolute inset-x-0 grid h-[var(--row-height)] cursor-default items-center gap-1.5 px-3.5 select-none"
    :class="[
      props.selected && props.focused
        ? 'bg-accent/30'
        : props.selected
          ? 'bg-accent/20'
          : props.focused
            ? 'bg-accent/[0.07]'
            : 'hover:bg-hover',
      props.entry.isFolder ? 'text-content' : 'text-content/90',
    ]"
    :data-focused="props.focused ? 'true' : undefined"
    :style="{
      transform: `translateY(${props.index * props.rowHeight}px)`,
      gridTemplateColumns: props.gridTemplate,
    }"
    :id="`row-${props.index}`"
    :data-key="props.entry.key"
    :data-kind="props.entry.kind"
    :data-testid="`row-${props.entry.name}`"
    role="option"
    :aria-label="props.entry.name"
    :aria-selected="props.selected"
    @click="emit('click', props.entry, $event)"
    @dblclick="emit('activate', props.entry)"
    @contextmenu.prevent="emit('contextmenu', props.entry, $event)"
  >
    <label v-if="props.checkboxColumn" class="flex items-center" @click.stop>
      <input
        type="checkbox"
        class="size-3.5 cursor-pointer accent-accent"
        :checked="props.selected"
        :aria-label="`Select ${props.entry.name}`"
        :data-testid="`row-check-${props.entry.name}`"
        @click="emit('toggleCheck', props.entry, $event)"
      />
    </label>

    <div class="flex min-w-0 items-center gap-1.5">
      <component :is="style.icon" class="size-3.5 shrink-0" :class="style.className" />
      <span class="row-label truncate" :title="props.entry.key">{{ props.entry.name }}</span>
    </div>

    <div class="tabular truncate text-right text-muted">
      {{ props.entry.isFolder ? "—" : humanSize(props.entry.size) }}
    </div>

    <div
      v-if="props.showModified"
      class="tabular truncate text-right text-muted"
      :title="modifiedTitle"
    >
      {{ humanDate(props.entry.lastModified) }}
    </div>

    <div v-if="props.showType" class="truncate text-right text-meta text-subtle">
      {{ kindLabel(props.entry.kind) }}
    </div>
  </div>
</template>
