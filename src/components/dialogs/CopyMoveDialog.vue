<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowRightLeft, Copy } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import AppField from "@/components/ui/AppField.vue";
import { inputClass, selectClass } from "@/components/ui/controls";
import { asFolderPrefix, joinKey } from "@/lib/keys";
import type { Connection, ObjectEntry } from "@/types";

export interface CopyMoveResult {
  destinationConnectionId: string;
  destinationPrefix: string;
}

const props = defineProps<{
  dialogId?: number;
  moveObjects: boolean;
  connections: Connection[];
  sourceConnectionId: string;
  sourcePrefix: string;
  entries: ObjectEntry[];
  resolve: (result: CopyMoveResult | null) => void;
}>();

const destinationConnectionId = ref(props.sourceConnectionId);
// Empty, not the source prefix: the old default made Copy fail every time with
// "source and destination are the same object" (IO-8).
const destinationPrefix = ref("");

const totalLabel = computed(() => {
  const files = props.entries.filter((entry) => !entry.isFolder).length;
  const folders = props.entries.length - files;
  const parts: string[] = [];
  if (files) parts.push(`${files} file(s)`);
  if (folders) parts.push(`${folders} folder(s)`);
  return parts.join(" and ") || "nothing";
});

/**
 * The backend rejects every pair when the destination resolves to the source
 * folder, so catch that before the request instead of after a red toast.
 */
const sameDestination = computed(
  () =>
    destinationConnectionId.value === props.sourceConnectionId &&
    asFolderPrefix(destinationPrefix.value) === asFolderPrefix(props.sourcePrefix),
);

const destinationError = computed(() =>
  sameDestination.value
    ? "That is the current folder. Choose another prefix or a different connection."
    : null,
);

/** A single file has one predictable resulting key; show it before copying. */
const singleResultKey = computed(() => {
  if (props.entries.length !== 1) return null;
  const entry = props.entries[0];
  if (entry.isFolder) return null;
  return joinKey(destinationPrefix.value, entry.name);
});

const prefixHint = computed(() => {
  if (!singleResultKey.value) return "Files keep their names; folders keep their names too.";
  const verb = props.moveObjects ? "move" : "copy";
  return `Will ${verb} to ${singleResultKey.value}.`;
});

function cancel() {
  props.resolve(null);
}

function confirm() {
  if (sameDestination.value) return;
  props.resolve({
    destinationConnectionId: destinationConnectionId.value,
    destinationPrefix: destinationPrefix.value,
  });
}
</script>

<template>
  <ModalFrame
    :title="props.moveObjects ? 'Move objects' : 'Copy objects'"
    :icon="props.moveObjects ? ArrowRightLeft : Copy"
    @close="cancel"
  >
    <p class="text-xs leading-relaxed text-muted">
      {{ totalLabel }} from
      <span class="font-mono text-content">{{ props.sourcePrefix || "/" }}</span>.
    </p>

    <div class="grid grid-cols-2 gap-3">
      <AppField label="Destination connection" wide>
        <select v-model="destinationConnectionId" :class="selectClass">
          <option v-for="connection in props.connections" :key="connection.id" :value="connection.id">
            {{ connection.name }} — {{ connection.bucket }}/{{ connection.prefix }}
          </option>
        </select>
      </AppField>

      <AppField
        label="Destination prefix"
        :error="destinationError"
        :hint="prefixHint"
        wide
      >
        <input
          v-model="destinationPrefix"
          :class="inputClass"
          type="text"
          placeholder="target/prefix/"
          data-testid="transfer-prefix"
        />
      </AppField>
    </div>

    <template #footer>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton
        variant="primary"
        :disabled="sameDestination"
        data-testid="transfer-confirm"
        @click="confirm"
      >
        {{ props.moveObjects ? "Move" : "Copy" }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
