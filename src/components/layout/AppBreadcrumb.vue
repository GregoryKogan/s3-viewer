<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, Database } from "@lucide/vue";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { prefixSegments } from "@/lib/format";

const connections = useConnectionsStore();
const objects = useObjectsStore();

const connection = computed(() => connections.active);

/** Breadcrumbs are relative to the connection prefix, which is the scope root. */
const crumbs = computed(() => {
  const root = connection.value?.prefix ?? "";
  const relative = objects.prefix.startsWith(root)
    ? objects.prefix.slice(root.length)
    : objects.prefix;
  return prefixSegments(relative).map((crumb) => ({
    ...crumb,
    full: `${root}${crumb.prefix}`,
  }));
});

const atScopeRoot = computed(() => objects.prefix === (connection.value?.prefix ?? ""));
</script>

<template>
  <nav
    class="scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap"
    data-testid="breadcrumb"
    aria-label="Folder path"
  >
    <template v-if="connection">
      <button
        type="button"
        class="flex max-w-64 items-center gap-1 rounded-control px-1.5 py-0.5 transition-colors hover:bg-hover"
        :class="atScopeRoot ? 'font-semibold text-content' : 'text-muted'"
        :title="`s3://${connection.bucket}/${connection.prefix}`"
        data-testid="crumb-root"
        @click="objects.navigate(connection.prefix ?? '')"
      >
        <Database class="size-3.5 shrink-0" />
        <span class="truncate">{{ connection.bucket }}</span>
      </button>

      <template v-for="crumb in crumbs" :key="crumb.full">
        <ChevronRight class="size-3 shrink-0 text-subtle" />
        <button
          type="button"
          class="max-w-56 truncate rounded-control px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-content"
          :title="`s3://${connection.bucket}/${crumb.full}`"
          @click="objects.navigate(crumb.full)"
        >
          {{ crumb.name }}
        </button>
      </template>
    </template>
    <span v-else class="px-1.5 text-muted">No connection selected</span>
  </nav>
</template>
