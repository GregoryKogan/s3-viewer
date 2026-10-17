<script setup lang="ts">
import { computed, ref } from "vue";
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
  /** Checkboxes appear on hover, and stay visible while a selection exists. */
  selectionActive: boolean;
}>();

const emit = defineEmits<{
  activate: [entry: ObjectEntry];
  click: [entry: ObjectEntry, event: MouseEvent];
  contextmenu: [entry: ObjectEntry, event: MouseEvent];
  toggleCheck: [entry: ObjectEntry, event: MouseEvent];
  toggleCheckbox: [entry: ObjectEntry];
}>();

const style = computed(() => kindStyle(props.entry.kind));
const hovered = ref(false);

const checkboxVisible = computed(() => props.selectionActive || hovered.value);
</script>

<template>
  <div
    class="object-row group absolute inset-x-0 grid h-[var(--row-height)] cursor-default items-center gap-1.5 px-3.5 select-none"
    :class="[
      props.focused ? 'bg-accent/20' : props.selected ? 'bg-accent/10' : 'hover:bg-hover',
      props.entry.isFolder ? 'text-content' : 'text-content/90',
    ]"
    :style="{
      transform: `translateY(${props.index * props.rowHeight}px)`,
      gridTemplateColumns: props.gridTemplate,
    }"
    :data-key="props.entry.key"
    :data-kind="props.entry.kind"
    :data-testid="`row-${props.entry.name}`"
    role="option"
    :aria-selected="props.selected || props.focused"
    @click="emit('click', props.entry, $event)"
    @dblclick="emit('activate', props.entry)"
    @contextmenu.prevent="emit('contextmenu', props.entry, $event)"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <label class="flex items-center" @click.stop>
      <input
        v-show="checkboxVisible"
        type="checkbox"
        class="size-3.5 cursor-pointer accent-accent"
        :checked="props.selected"
        :data-testid="`row-check-${props.entry.name}`"
        @click="emit('toggleCheck', props.entry, $event)"
        @change="emit('toggleCheckbox', props.entry)"
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
      :title="props.entry.lastModified ?? ''"
    >
      {{ humanDate(props.entry.lastModified) }}
    </div>

    <div v-if="props.showType" class="truncate text-right text-[0.6875rem] text-subtle">
      {{ kindLabel(props.entry.kind) }}
    </div>
  </div>
</template>
