<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronRight, Database, Pencil } from "@lucide/vue";
import { api, isNotFound } from "@/lib/ipc";
import { prefixSegments, s3Uri } from "@/lib/format";
import { shortcutLabel } from "@/lib/keyboard";
import { asFolderPrefix } from "@/lib/keys";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useToastsStore } from "@/stores/toasts";

const connections = useConnectionsStore();
const objects = useObjectsStore();
const toasts = useToastsStore();

const editing = ref(false);
const draft = ref("");
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);
const invalid = ref<string | null>(null);
/**
 * True while `submit()` owns the navigation. The prefix watcher uses it to tell
 * "the folder moved under the editor" from "the editor opened this folder".
 */
let committing = false;

const connection = computed(() => connections.active);

/** Breadcrumbs are relative to the connection prefix, which is the scope root. */
const crumbs = computed(() => {
  const root = connection.value?.prefix ?? "";
  const relative = objects.prefix.startsWith(root) ? objects.prefix.slice(root.length) : objects.prefix;
  return prefixSegments(relative).map((crumb) => ({ ...crumb, full: `${root}${crumb.prefix}` }));
});

const atScopeRoot = computed(() => objects.prefix === (connection.value?.prefix ?? ""));

const absolute = computed(() =>
  connection.value ? s3Uri(connection.value.bucket, objects.prefix) : "",
);

const addressPlaceholder = computed(
  () => `s3://bucket/path/to/object  (${shortcutLabel("L")})`,
);

/**
 * The free space of the crumb row is the address editor's target (NAV-2).
 *
 * The crumbs and the pencil are buttons and keep their own click behaviour, so
 * only a click that did not land on one of them starts editing.
 */
function onCrumbRowClick(event: MouseEvent) {
  if (!connection.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button")) return;
  startEditing();
}

function startEditing() {
  if (!connection.value) return;
  draft.value = editableAddress();
  invalid.value = null;
  editing.value = true;
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
}

/** A folder address keeps its trailing slash; an object address does not. */
function editableAddress(): string {
  return absolute.value.endsWith("/") || !objects.prefix ? absolute.value : `${absolute.value}/`;
}

function cancel() {
  editing.value = false;
  invalid.value = null;
}

/**
 * Close the editor and put the keyboard where the result will be: the list for
 * an opened address, the pencil for a cancelled one. Closing used to drop focus
 * on <body>, which also switched the column model off.
 */
function finishEditing(target: "list" | "address") {
  editing.value = false;
  invalid.value = null;
  void nextTick(() => {
    if (target === "address") {
      document.querySelector<HTMLElement>("[data-testid=address-edit]")?.focus();
      return;
    }
    document.getElementById("object-list")?.focus({ preventScroll: true });
  });
}

/**
 * Parse whatever the user pasted into a key inside this connection.
 *
 * Accepts a full `s3://bucket/key`, a `bucket/key` path, or a bare key. The
 * bucket has to match the connection, because a connection is a scope, not a
 * navigation target — accepting a foreign bucket would silently browse the wrong
 * place.
 */
function parseAddress(raw: string): { key: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "Enter an S3 address." };

  let bucket = "";
  let key = text;
  if (text.startsWith("s3://")) {
    const rest = text.slice("s3://".length);
    const slash = rest.indexOf("/");
    bucket = slash === -1 ? rest : rest.slice(0, slash);
    key = slash === -1 ? "" : rest.slice(slash + 1);
  } else if (text.includes("/") && !text.startsWith("/")) {
    const slash = text.indexOf("/");
    const maybeBucket = text.slice(0, slash);
    if (maybeBucket === connection.value?.bucket) {
      bucket = maybeBucket;
      key = text.slice(slash + 1);
    }
  }

  if (bucket && bucket !== connection.value?.bucket) {
    return {
      error: `This connection can only open ${connection.value?.bucket ?? "its own bucket"}, not “${bucket}”.`,
    };
  }

  const root = connection.value?.prefix ?? "";
  // Drop the connection's own prefix if it was pasted too, so a copied address
  // round-trips instead of doubling the scope.
  const relative = root && key.startsWith(root) ? key.slice(root.length) : key;
  return { key: relative };
}

async function submit() {
  if (!connection.value) return;
  const parsed = parseAddress(draft.value);
  if ("error" in parsed) {
    invalid.value = parsed.error;
    return;
  }

  const key = parsed.key;
  busy.value = true;
  invalid.value = null;
  // This navigation belongs to the text in the field: the prefix watch must not
  // overwrite what the user is opening (the not-in-the-listing message stays
  // correctable).
  committing = true;
  try {
    const root = connection.value.prefix ?? "";
    if (!key || key.endsWith("/")) {
      finishEditing("list");
      await objects.navigate(`${root}${key}`);
      return;
    }

    // A key without a trailing slash may be a file or a folder prefix. Ask the
    // backend, which is the only place that knows: a 404 becomes a sentence.
    const fullKey = `${root}${key}`;
    try {
      await api.objectMeta(connection.value.id, fullKey);
      const parent = fullKey.slice(0, fullKey.lastIndexOf("/") + 1);
      // Navigate first so the listing settles before the entry is looked up.
      // Closing the editor before that would swallow the error below: the form
      // (and its `address-error`) unmounts while `invalid` is still null.
      if (parent !== objects.prefix) await objects.navigate(parent);
      const entry = objects.entries.find((item) => item.key === fullKey);
      if (!entry) {
        // Stay in edit mode so the message is actually rendered and focusable.
        invalid.value = `Opened ${parent || "/"}, but ${fullKey} is not in the listing.`;
        return;
      }
      finishEditing("list");
      objects.focus(entry.key);
      objects.selectAll([entry.key]);
      await objects.previewEntry(entry, { force: true });
      return;
    } catch (metaError) {
      // Only a real 404 means "not an object, maybe a folder". A denied or
      // failed probe is the answer, not a reason to show "Nothing found".
      if (!isNotFound(metaError)) throw metaError;
      // Not an object: it may still be a folder prefix.
      const folder = `${root}${asFolderPrefix(key)}`;
      try {
        const probe = await api.listObjects({ connectionId: connection.value.id, prefix: folder });
        if (probe.entries.length) {
          finishEditing("list");
          await objects.navigate(folder);
          return;
        }
        // An empty folder has no children to list but S3 still keeps it as a
        // zero-byte marker object. Without this probe a real, empty folder
        // would report "Nothing found" (NAV-5).
        await api.objectMeta(connection.value.id, folder);
        finishEditing("list");
        await objects.navigate(folder);
      } catch (folderError) {
        // The marker probe 403s as readily as it 404s; only the latter is
        // genuinely "no such address".
        if (!isNotFound(folderError)) throw folderError;
        invalid.value = `Nothing found at ${s3Uri(connection.value.bucket, fullKey)}.`;
        toasts.warn(invalid.value, "Not found");
      }
    }
  } catch (error) {
    invalid.value = (error as Error).message;
    toasts.apiError(error, "Cannot open this address");
  } finally {
    busy.value = false;
    committing = false;
  }
}

/**
 * The editor follows the folder instead of freezing the address it was opened
 * at: a navigation started elsewhere (a row, the sidebar, a preview action)
 * moves the text with it and drops a stale error (NAV-7). An address the user
 * is submitting is the exception — see `committing`.
 */
watch(
  () => objects.prefix,
  () => {
    if (!editing.value) {
      draft.value = absolute.value;
      return;
    }
    if (committing) return;
    draft.value = editableAddress();
    invalid.value = null;
  },
);

/** A different connection is a different address space; the draft belongs to the old one. */
watch(
  () => connections.activeId,
  () => {
    if (editing.value) cancel();
  },
);
</script>

<template>
  <div class="min-w-0 flex-1" data-testid="breadcrumb">
    <div
      v-if="!editing"
      class="scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap"
      @click="onCrumbRowClick"
    >
      <template v-if="connection">
        <!-- No dedicated up arrow: the crumbs already walk up the path, and ⌘↑
             (Backspace on Linux) still does. A disabled arrow at the scope root
             read as a broken control. -->
        <button
          type="button"
          class="flex max-w-64 items-center gap-1 rounded-control px-1.5 py-0.5 transition-colors hover:bg-hover"
          :class="atScopeRoot ? 'font-semibold text-content' : 'text-muted'"
          :title="s3Uri(connection.bucket, connection.prefix)"
          data-testid="crumb-root"
          @click="objects.navigate(connection.prefix ?? '')"
        >
          <Database class="size-3.5 shrink-0" />
          <span class="truncate">{{ connection.name }}</span>
        </button>

        <template v-for="crumb in crumbs" :key="crumb.full">
          <ChevronRight class="size-3 shrink-0 text-subtle" />
          <button
            type="button"
            class="max-w-56 truncate rounded-control px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-content"
            :title="s3Uri(connection.bucket, crumb.full)"
            @click="objects.navigate(crumb.full)"
          >
            {{ crumb.name }}
          </button>
        </template>

        <button
          type="button"
          class="ml-1 grid size-6 shrink-0 place-items-center rounded-control text-subtle transition-colors hover:bg-hover hover:text-content"
          :title="`Type or paste an S3 address (${shortcutLabel('L')})`"
          data-testid="address-edit"
          @click="startEditing"
        >
          <Pencil class="size-3" />
        </button>
        <!-- Free space after the crumbs is the click-to-edit target. -->
        <span class="min-w-2 flex-1" />
      </template>
    </div>

    <form v-else class="flex min-w-0 flex-col gap-0.5" @submit.prevent="submit">
      <div class="flex min-w-0 items-center gap-1.5">
        <Database class="size-3.5 shrink-0 text-subtle" />
        <input
          ref="input"
          v-model="draft"
          class="min-w-0 flex-1 rounded-control border bg-inset px-2 py-1 font-mono text-xs text-content focus:outline-none"
          :class="invalid ? 'border-danger' : 'border-accent'"
          spellcheck="false"
          autocomplete="off"
          :placeholder="addressPlaceholder"
          data-testid="address-input"
          @input="invalid = null"
          @keydown.enter.prevent="submit"
          @keydown.esc.prevent="finishEditing('address')"
          @blur="!busy && !invalid && cancel()"
        />
        <span v-if="busy" class="text-meta text-subtle">opening…</span>
      </div>
      <p
        v-if="invalid"
        class="ml-5 text-meta leading-snug text-danger"
        data-testid="address-error"
      >
        {{ invalid }}
      </p>
    </form>
  </div>
</template>
