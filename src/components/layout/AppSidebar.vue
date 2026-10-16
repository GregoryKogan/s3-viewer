<script setup lang="ts">
import { computed } from "vue";
import {
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Plus,
  Settings,
  Upload,
} from "@lucide/vue";
import AppBadge from "@/components/ui/AppBadge.vue";
import AppButton from "@/components/ui/AppButton.vue";
import { useConnectionsStore, describeCapabilities } from "@/stores/connections";
import { useUiStore } from "@/stores/ui";
import type { Connection } from "@/types";

const emit = defineEmits<{
  create: [];
  open: [connection: Connection];
  contextmenu: [connection: Connection, event: MouseEvent];
  settings: [];
  import: [];
}>();

const connections = useConnectionsStore();
const ui = useUiStore();

const collapsed = computed(() => ui.layout.collapsed);

function toneFor(connection: Connection): "ok" | "warn" | "danger" {
  const summary = describeCapabilities(connections.capabilitiesOf(connection.id));
  if (summary.badgeClass === "ok") return "ok";
  if (summary.badgeClass === "danger") return "danger";
  return "warn";
}
</script>

<template>
  <aside
    class="flex h-full shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
    :style="{ width: `${ui.layout.sidebar}px` }"
    data-testid="sidebar"
  >
    <div class="drag-region flex h-[var(--titlebar-height)] shrink-0 items-center justify-center">
      <span class="text-[0.6875rem] font-medium tracking-wide text-subtle">S3 Viewer</span>
    </div>

    <div class="flex items-center justify-between gap-1.5 px-3 pt-1 pb-1.5">
      <span
        v-if="!collapsed"
        class="text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase"
      >
        Connections
      </span>
      <div class="no-drag ml-auto flex items-center gap-0.5">
        <AppButton
          v-if="!collapsed"
          variant="primary"
          size="sm"
          :icon="Plus"
          title="Add a connection (⌘N)"
          data-testid="new-connection"
          @click="emit('create')"
        >
          New
        </AppButton>
        <button
          v-else
          type="button"
          class="grid size-6 place-items-center rounded-control bg-accent text-white transition-colors hover:bg-accent-hover"
          title="Add a connection (⌘N)"
          data-testid="new-connection"
          @click="emit('create')"
        >
          <Plus class="size-3.5" />
        </button>
        <button
          type="button"
          class="grid size-6 place-items-center rounded-control text-muted transition-colors hover:bg-hover hover:text-content"
          :title="collapsed ? 'Expand the sidebar (⌘B)' : 'Collapse the sidebar (⌘B)'"
          data-testid="collapse-sidebar"
          @click="ui.toggleSidebar()"
        >
          <component :is="collapsed ? ChevronRight : ChevronLeft" class="size-3.5" />
        </button>
      </div>
    </div>

    <div class="scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2">
      <p v-if="!connections.views.length && !collapsed" class="px-2 py-4 text-xs leading-relaxed text-muted">
        No connections yet.<br />
        Add one, or import the credentials file you already use.
      </p>

      <button
        v-for="view in connections.views"
        :key="view.connection.id"
        type="button"
        class="flex w-full min-w-0 flex-col gap-1 rounded-control border px-2 py-1.5 text-left transition-colors"
        :class="
          view.connection.id === connections.activeId
            ? 'border-line-strong bg-active'
            : 'border-transparent hover:bg-hover'
        "
        :aria-selected="view.connection.id === connections.activeId"
        :data-testid="`connection-${view.connection.id}`"
        :title="`${view.connection.bucket}/${view.connection.prefix}`"
        @click="emit('open', view.connection)"
        @contextmenu.prevent="emit('contextmenu', view.connection, $event)"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <HardDrive class="size-3.5 shrink-0 text-subtle" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">
            {{ view.connection.name }}
          </span>
          <span
            v-if="!collapsed"
            class="size-1.5 shrink-0 rounded-full"
            :class="{
              'bg-ok': toneFor(view.connection) === 'ok',
              'bg-warn': toneFor(view.connection) === 'warn',
              'bg-danger': toneFor(view.connection) === 'danger',
            }"
            :title="describeCapabilities(view.capabilities).summary"
          />
        </div>

        <template v-if="!collapsed">
          <div class="truncate text-[0.6875rem] text-subtle" dir="ltr">
            {{ view.connection.bucket }}<span class="text-muted">/{{ view.connection.prefix }}</span>
          </div>
          <div class="flex flex-wrap gap-1">
            <AppBadge :tone="toneFor(view.connection)">
              {{ describeCapabilities(view.capabilities).badge }}
            </AppBadge>
            <AppBadge v-if="view.connection.signatureVersion !== 's3v4'" tone="accent">
              {{ view.connection.signatureVersion }}
            </AppBadge>
            <AppBadge v-if="view.connection.security.readOnlyMode" tone="danger">
              read-only
            </AppBadge>
          </div>
        </template>
      </button>

      <button
        v-if="connections.views.length"
        type="button"
        class="mt-1 flex items-center gap-1.5 rounded-control px-2 py-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-hover hover:text-content"
        data-testid="import-connections"
        @click="emit('import')"
      >
        <Upload class="size-3.5 shrink-0" />
        <span v-if="!collapsed">Import from JSON…</span>
      </button>
    </div>

    <div class="shrink-0 border-t border-line p-1.5">
      <AppButton
        variant="ghost"
        block
        :icon="Settings"
        title="Settings"
        data-testid="open-settings"
        @click="emit('settings')"
      >
        <span v-if="!collapsed">Settings</span>
      </AppButton>
    </div>
  </aside>
</template>
