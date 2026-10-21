<script setup lang="ts">
import { Ellipsis, HardDrive } from "@lucide/vue";
import AppBadge from "@/components/ui/AppBadge.vue";
import { useConnectionsStore, describeCapabilities } from "@/stores/connections";
import type { Capabilities, Connection, ConnectionView } from "@/types";

/**
 * One connection, in either sidebar state.
 *
 * Collapsed draws a centred avatar; expanded draws the name, the scope and the
 * badges. Both are the same button with the same data attributes, so the
 * keyboard, the e2e harness and the context menu see one card either way.
 */
const props = defineProps<{
  view: ConnectionView;
  active: boolean;
  collapsed: boolean;
}>();

const emit = defineEmits<{
  open: [connection: Connection];
  menu: [connection: Connection, point: { x: number; y: number }];
}>();

const connections = useConnectionsStore();

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

function capabilityTone(connection: Connection): "ok" | "warn" | "danger" | "neutral" {
  const summary = describeCapabilities(connections.capabilitiesOf(connection.id));
  if (summary.badgeClass === "ok") return "ok";
  if (summary.badgeClass === "danger") return "danger";
  if (summary.badgeClass === "neutral") return "neutral";
  return "warn";
}

/** The dot reports reachability, never permissions: `ok` is green. */
function healthTone(connection: Connection): "ok" | "danger" | "neutral" {
  const state = connections.healthOf(connection.id);
  if (state === "ok") return "ok";
  if (state === "error") return "danger";
  return "neutral";
}

function healthTitle(connection: Connection): string {
  const state = connections.healthOf(connection.id);
  if (state === "ok") {
    return "Reachable: the bucket answered the last request.";
  }
  if (state === "error") {
    return `Not reachable: ${connections.healthErrorOf(connection.id) || "the last request failed"}.`;
  }
  return "Health not checked yet. Open the connection to verify that the bucket answers.";
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
  <div class="group relative w-full shrink-0">
    <button
      type="button"
      class="relative rounded-control border transition-colors"
      :class="[
        collapsed
          ? 'mx-auto grid size-11 shrink-0 place-items-center'
          : 'flex w-full flex-col items-stretch gap-1 px-2 py-1.5 text-left',
        props.active
          ? collapsed
            ? 'border-line-strong bg-active text-content'
            : 'border-line-strong bg-active'
          : collapsed
            ? 'border-transparent text-muted hover:bg-hover hover:text-content'
            : 'border-transparent hover:bg-hover',
      ]"
      :title="
        collapsed
          ? `${props.view.connection.name} — ${props.view.connection.bucket}/${props.view.connection.prefix}`
          : `${props.view.connection.bucket}/${props.view.connection.prefix}`
      "
      :aria-label="collapsed ? props.view.connection.name : undefined"
      :aria-current="collapsed && props.active ? 'true' : undefined"
      :aria-selected="collapsed ? undefined : props.active"
      :data-testid="`connection-${props.view.connection.id}`"
      :data-connection-active="props.active ? 'true' : undefined"
      :data-connection-id="props.view.connection.id"
      data-connection-card
      @click="emit('open', props.view.connection)"
      @contextmenu.prevent="menuAtPointer(props.view.connection, $event)"
    >
      <template v-if="collapsed">
        <span
          class="grid size-5 place-items-center rounded-full text-micro font-semibold text-white"
          :style="{ backgroundColor: `hsl(${hueFor(props.view.connection.id)} 42% 32%)` }"
          aria-hidden="true"
        >
          {{ initials(props.view.connection.name) }}
        </span>
        <span
          class="absolute right-1 bottom-1 size-1.5 rounded-full"
          :class="{
            'bg-ok': healthTone(props.view.connection) === 'ok',
            'bg-danger': healthTone(props.view.connection) === 'danger',
            'bg-subtle': healthTone(props.view.connection) === 'neutral',
          }"
          :data-testid="`connection-health-${props.view.connection.id}`"
          :title="healthTitle(props.view.connection)"
        />
      </template>

      <template v-else>
        <div class="flex min-w-0 items-center gap-1.5 pr-6">
          <HardDrive class="size-3.5 shrink-0 text-subtle" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium text-content">
            {{ props.view.connection.name }}
          </span>
          <span
            class="size-1.5 shrink-0 rounded-full"
            :class="{
              'bg-ok': healthTone(props.view.connection) === 'ok',
              'bg-danger': healthTone(props.view.connection) === 'danger',
              'bg-subtle': healthTone(props.view.connection) === 'neutral',
            }"
            :data-testid="`connection-health-${props.view.connection.id}`"
            :title="healthTitle(props.view.connection)"
          />
        </div>

        <div class="min-w-0 truncate text-meta leading-snug text-subtle" dir="ltr">
          {{ props.view.connection.bucket
          }}<span class="text-muted">/{{ props.view.connection.prefix }}</span>
        </div>
        <div class="flex flex-wrap gap-1">
          <AppBadge
            :tone="capabilityTone(props.view.connection)"
            :title="capabilityTitle(props.view.capabilities)"
          >
            {{ describeCapabilities(props.view.capabilities).badge }}
          </AppBadge>
          <AppBadge v-if="props.view.connection.signatureVersion !== 's3v4'" tone="accent">
            {{ props.view.connection.signatureVersion }}
          </AppBadge>
          <AppBadge
            v-if="props.view.connection.security.readOnlyMode"
            tone="danger"
            title="Read-only mode is switched on for this connection: the app blocks every write, upload, rename and delete. This is a local setting, not what the probe found."
          >
            writes blocked
          </AppBadge>
        </div>
      </template>
    </button>

    <!-- A sibling, not a child: a button inside the card button would be
         invalid markup and would swallow the card's click. -->
    <button
      v-if="!collapsed"
      type="button"
      class="absolute top-1 right-1 grid size-6 place-items-center rounded-control text-subtle opacity-0 transition-opacity hover:bg-hover hover:text-content focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      aria-label="Connection menu"
      aria-haspopup="menu"
      title="Connection menu"
      :data-testid="`connection-menu-${props.view.connection.id}`"
      @click.stop="menuAtButton(props.view.connection, $event)"
      @contextmenu.prevent="menuAtPointer(props.view.connection, $event)"
    >
      <Ellipsis class="size-3.5" />
    </button>
  </div>
</template>
