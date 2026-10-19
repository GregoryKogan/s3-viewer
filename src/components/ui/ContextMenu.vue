<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from "vue";

export interface MenuItem {
  label: string;
  icon?: Component;
  shortcut?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  /** Rendered but not runnable; used when the action exists but is unavailable. */
  disabled?: boolean;
  run: () => void;
}

const props = defineProps<{ x: number; y: number; items: MenuItem[] }>();
const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
const position = ref({ left: props.x, top: props.y });
/** Where focus goes when the menu closes. */
let previousFocus: HTMLElement | null = null;
/** Type-ahead: the first letter of a label jumps to that item. */
let typed = "";
let typedTimer: ReturnType<typeof setTimeout> | undefined;

function typeAhead(character: string) {
  if (typedTimer) clearTimeout(typedTimer);
  typed += character.toLowerCase();
  typedTimer = setTimeout(() => {
    typed = "";
    typedTimer = undefined;
  }, 600);
  const items = enabledItems();
  const match = items.find((item) =>
    (item.textContent ?? "").trim().toLowerCase().startsWith(typed),
  );
  match?.focus();
}

/** Menu items that can actually run; disabled entries are skipped by the arrows. */
function enabledItems(): HTMLElement[] {
  if (!root.value) return [];
  return Array.from(root.value.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (item) => item.getAttribute("aria-disabled") !== "true",
  );
}

function focusItem(index: number) {
  const items = enabledItems();
  if (!items.length) {
    root.value?.focus();
    return;
  }
  const bounded = ((index % items.length) + items.length) % items.length;
  items[bounded].focus();
}

/**
 * Keep the menu inside the window: a right-click near the bottom or right edge
 * would otherwise open a menu the user cannot reach.
 */
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const element = root.value;
  if (!element) return;
  const { width, height } = element.getBoundingClientRect();
  const margin = 8;
  position.value = {
    left: Math.max(margin, Math.min(props.x, globalThis.innerWidth - width - margin)),
    top: Math.max(margin, Math.min(props.y, globalThis.innerHeight - height - margin)),
  };
  // The first runnable item, not the menu itself: arrow keys start from there.
  focusItem(0);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeydown, true);
});

onBeforeUnmount(() => {
  if (typedTimer) clearTimeout(typedTimer);
  typedTimer = undefined;
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("keydown", onKeydown, true);
  // An action may have removed the row that opened the menu; never focus a
  // detached node.
  if (previousFocus?.isConnected) previousFocus.focus();
});

function onPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) emit("close");
}

function onKeydown(event: KeyboardEvent) {
  const items = enabledItems();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const move = (index: number) => {
    event.preventDefault();
    focusItem(index);
  };

  switch (event.key) {
    case "Escape":
      event.preventDefault();
      emit("close");
      return;
    case "ArrowDown":
      move(current === -1 ? 0 : current + 1);
      return;
    case "ArrowUp":
      move(current === -1 ? items.length - 1 : current - 1);
      return;
    case "Home":
      move(0);
      return;
    case "End":
      move(items.length - 1);
      return;
    case "Tab":
      // Tab leaves a menu by closing it; otherwise the menu stays on screen
      // with focus somewhere else, and its capture handler keeps pulling the
      // arrows back into it.
      emit("close");
      return;
    default:
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        typeAhead(event.key);
      }
      return;
  }
}

const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px` }));

function run(item: MenuItem) {
  if (item.disabled) return;
  emit("close");
  // Let the menu disappear before the action can open a dialog or navigate.
  // A timeout, not an animation frame: background windows do not get frames.
  setTimeout(() => item.run(), 0);
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="fixed z-[60] min-w-52 overflow-hidden rounded-panel border border-line-strong bg-elevated py-1 shadow-2xl shadow-black/50"
      :style="style"
      role="menu"
      aria-label="Context menu"
      tabindex="-1"
      data-testid="context-menu"
    >
      <template v-for="(item, index) in props.items" :key="item.label">
        <div
          v-if="item.separatorBefore && index > 0"
          class="my-1 h-px bg-line"
          role="separator"
        />
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors"
          :class="[
            item.disabled
              ? 'cursor-default opacity-40'
              : item.danger
                ? 'text-danger hover:bg-danger-soft'
                : 'text-content hover:bg-hover',
          ]"
          :disabled="item.disabled"
          :aria-disabled="item.disabled ? 'true' : undefined"
          @click="run(item)"
        >
          <component :is="item.icon" v-if="item.icon" class="size-3.5 shrink-0 opacity-70" />
          <span class="flex-1 truncate">{{ item.label }}</span>
          <span v-if="item.shortcut" class="text-micro text-subtle">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
