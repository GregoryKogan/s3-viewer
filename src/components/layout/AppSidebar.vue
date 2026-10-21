<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { ChevronsLeft, ChevronsRight, Plus, Settings, Upload } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import ConnectionCard from "@/components/layout/ConnectionCard.vue";
import { shortcutLabel } from "@/lib/keyboard";
import { useConnectionsStore } from "@/stores/connections";
import { useUiStore } from "@/stores/ui";
import type { Connection } from "@/types";

const emit = defineEmits<{
  create: [];
  open: [connection: Connection];
  menu: [connection: Connection, point: { x: number; y: number }];
  settings: [];
  import: [];
}>();

const connections = useConnectionsStore();
const ui = useUiStore();

const list = ref<HTMLElement | null>(null);

/** The connection card buttons, in visual order, in either sidebar state. */
function cards(): HTMLElement[] {
  return Array.from(list.value?.querySelectorAll<HTMLElement>("[data-connection-card]") ?? []);
}

/**
 * Up/Down walk the connections like a listbox; Enter and Space still activate
 * the focused card natively. Only the cards take part, so the ⋯ menu and the
 * footer stay reachable with Tab.
 */
function onCardsKeydown(event: KeyboardEvent) {
  const target =
    event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-connection-card]")
      : null;
  if (!target) return;
  const all = cards();
  const index = all.indexOf(target);
  if (index === -1) return;
  let next: number;
  if (event.key === "ArrowDown") next = Math.min(index + 1, all.length - 1);
  else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = all.length - 1;
  else return;
  event.preventDefault();
  all[next]?.focus();
  all[next]?.scrollIntoView({ block: "nearest" });
}

/** Hand the keyboard to the connection list, starting at the open connection. */
function focusActive() {
  const all = cards();
  const active = all.find((card) => card.dataset.connectionActive === "true") ?? all[0];
  if (!active) {
    document.getElementById("new-connection")?.focus();
    return;
  }
  active.focus();
  active.scrollIntoView({ block: "nearest" });
}

/**
 * Collapsing swaps the footer's markup, so the button that was pressed
 * disappears. Focus the replacement instead of dropping the user on <body>.
 */
async function toggleCollapsed() {
  ui.toggleSidebar();
  await nextTick();
  document.querySelector<HTMLElement>("[data-testid=collapse-sidebar]")?.focus();
}

defineExpose({ focusActive });

const collapsed = computed(() => ui.layout.collapsed);

/**
 * The label only gives way if the window itself forces the sidebar below the
 * width it needs. Collapsing is the deliberate way to get a narrow sidebar, so
 * there is no in-between state to get wrong.
 */
const labelFits = computed(() => !collapsed.value && ui.layout.sidebar >= 176);

</script>

<template>
  <aside
    id="sidebar"
    class="flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
    :style="{ width: collapsed ? '4rem' : 'var(--sidebar-width)' }"
    data-testid="sidebar"
    data-focus-zone="sidebar"
  >
    <!-- The window is decorated, so there is no title-bar strip to drag: the
         header starts at the top and lines up with the address row. -->
    <!-- Collapsed: a single centred target. Expanded: the label and the one
         action that belongs at this level. The collapse control lives in the
         footer, so this row never has to squeeze three things into a narrow
         column. -->
    <!-- The 8px top padding matches the address row in the header, so the
         collapsed New target sits level with the bucket name instead of being
         pinned to the window edge. -->
    <div v-if="collapsed" class="flex shrink-0 items-center justify-center px-2 pt-2 pb-1.5">
      <button
        type="button"
        class="grid size-9 place-items-center rounded-control bg-accent text-white transition-colors hover:bg-accent-hover"
        :title="`Add a connection (${shortcutLabel('N')})`"
        id="new-connection"
        data-testid="new-connection"
        @click="emit('create')"
      >
        <Plus class="size-4" />
      </button>
    </div>

    <div v-else class="flex min-h-9 shrink-0 items-center gap-1 px-2 pt-2 pb-1.5" :class="labelFits ? 'justify-between' : 'justify-center'">
      <span
        v-if="labelFits"
        class="sidebar-label min-w-0 truncate text-meta font-semibold tracking-wider text-subtle uppercase"
      >
        Connections
      </span>

      <AppButton
        variant="primary"
        size="sm"
        :icon="Plus"
        id="new-connection"
        data-testid="new-connection"
        class="shrink-0"
        @click="emit('create')"
      >
        New
      </AppButton>
    </div>

    <div
      id="connection-list"
      ref="list"
      class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2"
      :class="collapsed ? 'rail-scrollbar' : 'scrollbar'"
      data-testid="connection-list"
      @keydown="onCardsKeydown"
    >
      <div
        v-if="!connections.views.length && !collapsed"
        class="flex flex-col items-start gap-2 px-2 py-4"
      >
        <p class="text-xs leading-relaxed text-muted">
          No connections yet. Add one, or bring in the credentials file you already use.
        </p>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-control border border-line-strong px-2 py-1 text-meta text-content transition-colors hover:bg-hover"
          data-testid="import-empty"
          @click="emit('import')"
        >
          <Upload class="size-3.5" />
          Import from JSON…
        </button>
      </div>

      <ConnectionCard
        v-for="view in connections.views"
        :key="view.connection.id"
        :view="view"
        :active="view.connection.id === connections.activeId"
        :collapsed="collapsed"
        @open="emit('open', $event)"
        @menu="(connection, point) => emit('menu', connection, point)"
      />

      <button
        v-if="connections.views.length || collapsed"
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-control text-meta text-muted transition-colors hover:bg-hover hover:text-content"
        :class="collapsed ? 'mx-auto size-9 justify-center' : 'mt-1 px-2 py-1.5'"
        title="Import connections from JSON"
        data-testid="import-connections"
        @click="emit('import')"
      >
        <Upload class="size-4 shrink-0" />
        <span v-if="!collapsed">Import from JSON…</span>
      </button>
    </div>

    <!-- Footer: the collapse toggle is a full-width 36px target in both states. -->
    <!-- Footer. When expanded this is one row: Settings takes the space, and the
         panel toggle is the small icon button every editor puts at the end of a
         sidebar. When collapsed both stack, centred. -->
    <div
      class="flex shrink-0 gap-1 border-t border-line p-1.5"
      :class="collapsed ? 'flex-col items-center' : 'items-center'"
    >
      <template v-if="collapsed">
        <button
          type="button"
          class="grid size-9 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
          title="Settings"
          data-testid="open-settings"
          @click="emit('settings')"
        >
          <Settings class="size-4" />
        </button>
        <button
          type="button"
          class="grid size-9 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
          :title="`Expand the sidebar (${shortcutLabel('B')})`"
          data-testid="collapse-sidebar"
          @click="toggleCollapsed"
        >
          <ChevronsRight class="size-4" />
        </button>
      </template>

      <template v-else>
        <AppButton
          variant="ghost"
          class="min-w-0 flex-1 !justify-start"
          :icon="Settings"
          title="Settings"
          data-testid="open-settings"
          @click="emit('settings')"
        >
          Settings
        </AppButton>
        <button
          type="button"
          class="grid size-7 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
          :title="`Collapse the sidebar (${shortcutLabel('B')})`"
          data-testid="collapse-sidebar"
          @click="toggleCollapsed"
        >
          <ChevronsLeft class="size-3.5" />
        </button>
      </template>
    </div>
  </aside>
</template>
