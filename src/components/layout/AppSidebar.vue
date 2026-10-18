<script setup lang="ts">
import { computed } from "vue";
import { ChevronsLeft, ChevronsRight, Ellipsis, HardDrive, Plus, Settings, Upload } from "@lucide/vue";
import AppBadge from "@/components/ui/AppBadge.vue";
import AppButton from "@/components/ui/AppButton.vue";
import { shortcutLabel } from "@/lib/keyboard";
import { useConnectionsStore, describeCapabilities } from "@/stores/connections";
import { useUiStore } from "@/stores/ui";
import type { Capabilities, Connection } from "@/types";

const emit = defineEmits<{
  create: [];
  open: [connection: Connection];
  menu: [connection: Connection, point: { x: number; y: number }];
  settings: [];
  import: [];
}>();

const connections = useConnectionsStore();
const ui = useUiStore();

const collapsed = computed(() => ui.layout.collapsed);

/**
 * The label only gives way if the window itself forces the sidebar below the
 * width it needs. Collapsing is the deliberate way to get a narrow sidebar, so
 * there is no in-between state to get wrong.
 */
const labelFits = computed(() => !collapsed.value && ui.layout.sidebar >= 176);

/** Up to two letters: the first letter of the first two words, else the first two. */
function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length >= 2
      ? [Array.from(words[0])[0], Array.from(words[1])[0]]
      : Array.from(name.trim()).slice(0, 2);
  return letters.filter(Boolean).join("").toUpperCase();
}

/**
 * A stable hue per connection id. The id never changes, so the rail keeps its
 * colours when connections are edited or reordered.
 */
function hueFor(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

function toneFor(connection: Connection): "ok" | "warn" | "danger" | "neutral" {
  const summary = describeCapabilities(connections.capabilitiesOf(connection.id));
  if (summary.badgeClass === "ok") return "ok";
  if (summary.badgeClass === "danger") return "danger";
  if (summary.badgeClass === "neutral") return "neutral";
  return "warn";
}

/**
 * `read-only` is what the bucket's permission probe found; `writes blocked` is
 * the connection's own read-only switch. Without a title the two badges next to
 * each other read as the same fact (CON-5).
 */
function capabilityTitle(capabilities?: Capabilities | null): string {
  const summary = describeCapabilities(capabilities);
  if (!capabilities?.probed) {
    return "Permissions have not been probed yet. This is not an error; use Test connection while editing the connection.";
  }
  if (summary.level === "ro") {
    return "Probed from the bucket: these credentials can read but not write or delete. The local read-only switch is the separate “writes blocked” badge.";
  }
  return summary.summary;
}

/** A right-click anchors the menu at the pointer. */
function menuAtPointer(connection: Connection, event: MouseEvent) {
  emit("menu", connection, { x: event.clientX, y: event.clientY });
}

/**
 * The `⋯` button can be activated from the keyboard, where a click carries no
 * coordinates; anchor the menu to the button itself in that case.
 */
function menuAtButton(connection: Connection, event: MouseEvent) {
  if (event.clientX || event.clientY) {
    emit("menu", connection, { x: event.clientX, y: event.clientY });
    return;
  }
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  emit("menu", connection, rect ? { x: rect.right, y: rect.bottom } : { x: 0, y: 0 });
}
</script>

<template>
  <aside
    id="sidebar"
    class="flex h-full min-w-0 shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
    :style="{ width: collapsed ? '4rem' : 'var(--sidebar-width)' }"
    data-testid="sidebar"
  >
    <!-- The window is decorated, so there is no title-bar strip to drag: the
         header starts at the top and lines up with the address row. -->
    <!-- Collapsed: a single centred target. Expanded: the label and the one
         action that belongs at this level. The collapse control lives in the
         footer, so this row never has to squeeze three things into a narrow
         column. -->
    <div v-if="collapsed" class="flex shrink-0 items-center justify-center px-2 pt-1 pb-1.5">
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
      class="scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2"
      data-testid="connection-list"
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

      <!-- Collapsed: a rail of large, centred targets instead of squeezed cards. -->
      <template v-if="collapsed">
        <button
          v-for="view in connections.views"
          :key="view.connection.id"
          type="button"
          class="relative grid size-11 shrink-0 place-items-center rounded-control border transition-colors"
          :class="
            view.connection.id === connections.activeId
              ? 'border-line-strong bg-active text-content'
              : 'border-transparent text-muted hover:bg-hover hover:text-content'
          "
          :title="`${view.connection.name} — ${view.connection.bucket}/${view.connection.prefix}`"
          :aria-label="view.connection.name"
          :aria-current="view.connection.id === connections.activeId ? 'true' : undefined"
          :data-testid="`connection-${view.connection.id}`"
          @click="emit('open', view.connection)"
          @contextmenu.prevent="menuAtPointer(view.connection, $event)"
        >
          <span
            class="grid size-5 place-items-center rounded-full text-micro font-semibold text-white"
            :style="{ backgroundColor: `hsl(${hueFor(view.connection.id)} 42% 32%)` }"
            aria-hidden="true"
          >
            {{ initials(view.connection.name) }}
          </span>
          <span
            class="absolute right-1 bottom-1 size-1.5 rounded-full"
            :class="{
              'bg-ok': toneFor(view.connection) === 'ok',
              'bg-warn': toneFor(view.connection) === 'warn',
              'bg-danger': toneFor(view.connection) === 'danger',
              'bg-subtle': toneFor(view.connection) === 'neutral',
            }"
          />
        </button>
      </template>

      <template v-else>
        <div
          v-for="view in connections.views"
          :key="view.connection.id"
          class="group relative w-full shrink-0"
        >
          <button
            type="button"
            class="flex w-full flex-col items-stretch gap-1 rounded-control border px-2 py-1.5 text-left transition-colors"
            :class="
              view.connection.id === connections.activeId
                ? 'border-line-strong bg-active'
                : 'border-transparent hover:bg-hover'
            "
            :aria-selected="view.connection.id === connections.activeId"
            :data-testid="`connection-${view.connection.id}`"
            :title="`${view.connection.bucket}/${view.connection.prefix}`"
            @click="emit('open', view.connection)"
            @contextmenu.prevent="menuAtPointer(view.connection, $event)"
          >
            <div class="flex min-w-0 items-center gap-1.5 pr-6">
              <HardDrive class="size-3.5 shrink-0 text-subtle" />
              <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">
                {{ view.connection.name }}
              </span>
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="{
                  'bg-ok': toneFor(view.connection) === 'ok',
                  'bg-warn': toneFor(view.connection) === 'warn',
                  'bg-danger': toneFor(view.connection) === 'danger',
                  'bg-subtle': toneFor(view.connection) === 'neutral',
                }"
                :title="capabilityTitle(view.capabilities)"
              />
            </div>

            <div class="min-w-0 truncate text-meta leading-snug text-subtle" dir="ltr">
              {{ view.connection.bucket }}<span class="text-muted">/{{ view.connection.prefix }}</span>
            </div>
            <div class="flex flex-wrap gap-1">
              <AppBadge :tone="toneFor(view.connection)" :title="capabilityTitle(view.capabilities)">
                {{ describeCapabilities(view.capabilities).badge }}
              </AppBadge>
              <AppBadge v-if="view.connection.signatureVersion !== 's3v4'" tone="accent">
                {{ view.connection.signatureVersion }}
              </AppBadge>
              <AppBadge
                v-if="view.connection.security.readOnlyMode"
                tone="danger"
                title="Read-only mode is switched on for this connection: the app blocks every write, upload, rename and delete. This is a local setting, not what the probe found."
              >
                writes blocked
              </AppBadge>
            </div>
          </button>

          <!-- A sibling, not a child: a button inside the card button would be
               invalid markup and would swallow the card's click. -->
          <button
            type="button"
            class="absolute top-1 right-1 grid size-6 place-items-center rounded-control text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-content focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            aria-label="Connection menu"
            title="Connection menu"
            :data-testid="`connection-menu-${view.connection.id}`"
            @click.stop="menuAtButton(view.connection, $event)"
            @contextmenu.prevent="menuAtPointer(view.connection, $event)"
          >
            <Ellipsis class="size-3.5" />
          </button>
        </div>
      </template>

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
          @click="ui.toggleSidebar()"
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
          @click="ui.toggleSidebar()"
        >
          <ChevronsLeft class="size-3.5" />
        </button>
      </template>
    </div>
  </aside>
</template>
