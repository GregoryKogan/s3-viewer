<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowRightLeft, Copy } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import AppField from "@/components/ui/AppField.vue";
import { inputClass, selectClass } from "@/components/ui/controls";
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
const destinationPrefix = ref(props.sourcePrefix);

const totalLabel = computed(() => {
  const files = props.entries.filter((entry) => !entry.isFolder).length;
  const folders = props.entries.length - files;
  const parts: string[] = [];
  if (files) parts.push(`${files} file(s)`);
  if (folders) parts.push(`${folders} folder(s)`);
  return parts.join(" and ") || "nothing";
});

function cancel() {
  props.resolve(null);
}

function confirm() {
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
      <span class="font-mono text-content">{{ props.sourcePrefix || "/" }}</span>
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
        hint="Files keep their names; folders keep their names too."
        wide
      >
        <input v-model="destinationPrefix" :class="inputClass" type="text" placeholder="target/prefix/" data-testid="transfer-prefix" />
      </AppField>
    </div>

    <template #footer>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" data-testid="transfer-confirm" @click="confirm">
        {{ props.moveObjects ? "Move" : "Copy" }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
