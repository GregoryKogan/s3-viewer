<script setup lang="ts">
import { computed } from "vue";
import { Link2 } from "@lucide/vue";
import { kindStyle } from "./kindIcon";
import { humanDate, humanSize } from "@/lib/format";
import { kindLabel } from "@/lib/fileKind";
import type { ObjectEntry } from "@/types";

const props = defineProps<{
  entry: ObjectEntry;
  index: number;
  rowHeight: number;
  selected: boolean;
}>();

const emit = defineEmits<{
  activate: [entry: ObjectEntry];
  select: [entry: ObjectEntry, event: MouseEvent];
  toggleCheck: [entry: ObjectEntry];
  copyUri: [entry: ObjectEntry];
}>();

const style = computed(() => kindStyle(props.entry.kind));
const testId = computed(() => `row-${props.entry.name}`);

function onClick(event: MouseEvent) {
  emit("select", props.entry, event);
}
</script>

<template>
  <div
    class="group absolute inset-x-0 grid h-[var(--row-height)] cursor-default grid-cols-[34px_minmax(180px,1fr)_92px_168px_92px] items-center gap-1.5 px-3.5 select-none"
    :class="[
      props.selected ? 'bg-accent/20' : 'hover:bg-hover',
      props.entry.isFolder ? 'text-content' : 'text-content/90',
    ]"
    :style="{ transform: `translateY(${props.index * props.rowHeight}px)` }"
    :data-key="props.entry.key"
    :data-kind="props.entry.kind"
    :data-testid="testId"
    role="option"
    :aria-selected="props.selected"
    @click="onClick"
    @dblclick="emit('activate', props.entry)"
  >
    <label class="flex items-center" @click.stop>
      <input
        type="checkbox"
        class="size-3.5 cursor-pointer accent-accent"
        :checked="props.selected"
        :data-testid="`row-check-${props.entry.name}`"
        @change="emit('toggleCheck', props.entry)"
      />
    </label>

    <div class="flex min-w-0 items-center gap-1.5">
      <component :is="style.icon" class="size-3.5 shrink-0" :class="style.className" />
      <span class="truncate" :title="props.entry.key">{{ props.entry.name }}</span>
      <button
        type="button"
        class="ml-auto grid size-5 shrink-0 place-items-center rounded-[4px] text-subtle opacity-0 transition-opacity hover:bg-active hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
        :title="`Copy s3:// URI`"
        :aria-label="`Copy the S3 URI of ${props.entry.name}`"
        @click.stop="emit('copyUri', props.entry)"
      >
        <Link2 class="size-3" />
      </button>
    </div>

    <div class="tabular truncate text-right text-muted">
      {{ props.entry.isFolder ? "—" : humanSize(props.entry.size) }}
    </div>

    <div class="tabular truncate text-right text-muted" :title="props.entry.lastModified ?? ''">
      {{ humanDate(props.entry.lastModified) }}
    </div>

    <div class="truncate text-right text-[0.6875rem] text-subtle">
      {{ kindLabel(props.entry.kind) }}
    </div>
  </div>
</template>
