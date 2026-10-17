<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from "vue";

export interface MenuItem {
  label: string;
  icon?: Component;
  shortcut?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

const props = defineProps<{ x: number; y: number; items: MenuItem[] }>();
const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
const position = ref({ left: props.x, top: props.y });

/**
 * Keep the menu inside the window: a right-click near the bottom or right edge
 * would otherwise open a menu the user cannot reach.
 */
onMounted(() => {
  const element = root.value;
  if (!element) return;
  const { width, height } = element.getBoundingClientRect();
  const margin = 8;
  position.value = {
    left: Math.max(margin, Math.min(props.x, globalThis.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(props.y, globalThis.innerHeight - height - margin)),
  };
  element.focus();
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeydown, true);
});

function onPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px` }));

function run(item: MenuItem) {
  emit("close");
  // Let the menu disappear before the action can open a dialog or navigate.
  requestAnimationFrame(() => item.run());
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="fixed z-[60] min-w-52 overflow-hidden rounded-panel border border-line-strong bg-elevated py-1 shadow-2xl shadow-black/50"
      :style="style"
      role="menu"
      tabindex="-1"
      data-testid="context-menu"
    >
      <template v-for="(item, index) in props.items" :key="item.label">
        <div v-if="item.separatorBefore && index > 0" class="my-1 h-px bg-line" />
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors"
          :class="item.danger ? 'text-danger hover:bg-danger-soft' : 'text-content hover:bg-hover'"
          @click="run(item)"
        >
          <component :is="item.icon" v-if="item.icon" class="size-3.5 shrink-0 opacity-70" />
          <span class="flex-1 truncate">{{ item.label }}</span>
          <span v-if="item.shortcut" class="text-[0.625rem] text-subtle">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
