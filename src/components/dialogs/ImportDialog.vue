<script setup lang="ts">
import { computed, ref } from "vue";
import { FileUp, Upload } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import { textareaClass } from "@/components/ui/controls";
import { parseImport } from "@/lib/importParse";
import { api, pickFiles } from "@/lib/ipc";
import { useConnectionsStore } from "@/stores/connections";
import { useToastsStore } from "@/stores/toasts";
import type { ConnectionDraft } from "@/types";

const props = defineProps<{
  dialogId?: number;
  resolve: (imported: string[]) => void;
}>();

const connections = useConnectionsStore();
const toasts = useToastsStore();

const text = ref("");
const fileName = ref<string | null>(null);
const drafts = ref<ConnectionDraft[]>([]);
const problem = ref<string | null>(null);
const importing = ref(false);

const hint = computed(() => {
  if (problem.value) return problem.value;
  if (!text.value.trim()) return "";
  return drafts.value.length
    ? `${drafts.value.length} connection(s) ready to import:`
    : "Nothing recognisable found.";
});

function parse() {
  problem.value = null;
  try {
    drafts.value = parseImport(text.value) as ConnectionDraft[];
  } catch (error) {
    drafts.value = [];
    problem.value = (error as Error).message;
  }
}

async function readFile() {
  try {
    const [path] = await pickFiles({ multiple: false });
    if (!path) return;
    // The webview cannot open file:// URLs, so the backend reads it. The path
    // came from the native dialog, and the command caps the size and insists on
    // UTF-8.
    const contents = await api.readTextFile(path);
    text.value = contents;
    fileName.value = path.split("/").pop() ?? path;
    parse();
    if (!drafts.value.length && !problem.value) {
      toasts.warn("That file parsed, but no connection was found in it.", "Nothing to import");
    }
  } catch (error) {
    toasts.error((error as Error).message, "Cannot read the file");
  }
}

function cancel() {
  props.resolve([]);
}

async function run() {
  if (!drafts.value.length) {
    toasts.error("Nothing to import.", "Import");
    return;
  }
  importing.value = true;
  const created: string[] = [];
  const failures: string[] = [];
  for (const draft of drafts.value) {
    if (!draft.bucket) {
      failures.push(`${draft.name}: no bucket name`);
      continue;
    }
    try {
      const saved = await connections.save({ ...draft, prefix: draft.prefix ?? "" });
      created.push(saved.id);
    } catch (error) {
      failures.push(`${draft.name}: ${(error as Error).message}`);
    }
  }
  importing.value = false;
  if (created.length) toasts.ok(`Imported ${created.length} connection(s).`, "Import finished");
  if (failures.length) toasts.error(failures.join("\n"), "Some connections failed");
  if (created.length) props.resolve(created);
}
</script>

<template>
  <ModalFrame title="Import connections" :icon="FileUp" @close="cancel">
    <p class="text-[0.6875rem] leading-relaxed text-muted">
      Paste a JSON credentials file or a boto3 client snippet. Secrets are encrypted locally and
      never leave this machine.
    </p>

    <p v-if="fileName" class="flex items-center gap-1.5 text-[0.6875rem] text-muted">
      <FileUp class="size-3.5 shrink-0" />
      <span class="font-mono break-all">{{ fileName }}</span>
    </p>

    <textarea
      v-model="text"
      :class="[textareaClass, 'h-56']"
      spellcheck="false"
      placeholder='{
  "my-bucket": {
    "access_key": "…",
    "secret_key": "…",
    "endpoint": "https://s3.example.com"
  }
}'
      data-testid="import-textarea"
      @input="parse"
    />

    <div class="flex flex-col gap-1.5" data-testid="import-preview">
      <p class="text-[0.6875rem]" :class="problem ? 'text-danger' : 'text-subtle'">{{ hint }}</p>
      <ul v-if="drafts.length" class="list-disc pl-4 text-[0.6875rem] leading-relaxed text-muted">
        <li v-for="(draft, index) in drafts" :key="index">
          {{ draft.name }} → {{ draft.endpointUrl }} / {{ draft.bucket }}
        </li>
      </ul>
    </div>

    <template #footer>
      <AppButton :icon="Upload" @click="readFile">Choose a file…</AppButton>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton
        variant="primary"
        :loading="importing"
        :disabled="!drafts.length"
        data-testid="import-confirm"
        @click="run"
      >
        Import
      </AppButton>
    </template>
  </ModalFrame>
</template>
