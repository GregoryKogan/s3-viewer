<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  ClipboardCopy,
  Copy,
  KeyRound,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import AppField from "@/components/ui/AppField.vue";
import { inputClass, selectClass, codeClass, checkboxClass } from "@/components/ui/controls";
import { boto3Snippet } from "@/lib/boto3";
import { highlight } from "@/lib/highlight";
import { copyText } from "@/lib/ipc";
import { useConnectionsStore } from "@/stores/connections";
import { useToastsStore } from "@/stores/toasts";
import type {
  AddressingStyle,
  Capabilities,
  ChecksumCalculation,
  ChecksumValidation,
  Connection,
  ConnectionDraft,
  SignatureVersion,
} from "@/types";

const props = defineProps<{
  dialogId?: number;
  connection?: Connection | null;
  resolve: (saved: Connection | null) => void;
}>();

const connections = useConnectionsStore();
const toasts = useToastsStore();

const isEdit = computed(() => Boolean(props.connection?.id));

const form = ref({
  name: props.connection?.name ?? "",
  endpointUrl: "",
  region: props.connection?.region ?? "us-east-1",
  accessKeyId: props.connection?.accessKeyId ?? "",
  secretAccessKey: "",
  sessionToken: "",
  clearSessionToken: false,
  bucket: props.connection?.bucket ?? "",
  prefix: props.connection?.prefix ?? "",
  addressingStyle: (props.connection?.addressingStyle ?? "virtual") as AddressingStyle,
  signatureVersion: (props.connection?.signatureVersion ?? "s3v4") as SignatureVersion,
  requestChecksumCalculation: (props.connection?.requestChecksumCalculation ??
    "whenSupported") as ChecksumCalculation,
  responseChecksumValidation: (props.connection?.responseChecksumValidation ??
    "whenSupported") as ChecksumValidation,
  readOnlyMode: props.connection?.security.readOnlyMode ?? false,
  confirmDelete: props.connection?.security.confirmDelete ?? true,
  confirmOverwrite: props.connection?.security.confirmOverwrite ?? true,
  detectPermissions: props.connection?.security.detectPermissions ?? true,
});

// Placeholders are deliberately deployment-agnostic: this client must never hint
// at anyone's real endpoint, bucket or key.
const PLACEHOLDER = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  accessKey: "AKIA…",
  bucket: "my-bucket",
  prefix: "some/folder/",
};

const showingSecret = ref(false);
const probing = ref(false);
const saving = ref(false);
const capabilities = ref<Capabilities | null>(null);
const probeError = ref<string | null>(null);
const errors = ref<Record<string, string>>({});

const snippet = computed(() =>
  boto3Snippet({
    endpointUrl: form.value.endpointUrl || PLACEHOLDER.endpoint,
    region: form.value.region,
    accessKeyId: form.value.accessKeyId,
    secretAccessKey: form.value.secretAccessKey,
    sessionToken: form.value.sessionToken || null,
    bucket: form.value.bucket,
    prefix: form.value.prefix,
    signatureVersion: form.value.signatureVersion,
    addressingStyle: form.value.addressingStyle,
    payloadSigning: false,
    requestChecksumCalculation: form.value.requestChecksumCalculation,
    responseChecksumValidation: form.value.responseChecksumValidation,
  }),
);

const snippetMarkup = computed(() => highlight(snippet.value, "python"));

/**
 * The endpoint is only known after the connection is loaded; edits keep the
 * existing one, so it is shown but not required in the form state above.
 */
onMounted(() => {
  if (props.connection) form.value.endpointUrl = props.connection.endpointUrl;
});

watch(
  () => props.connection,
  (connection) => {
    if (connection) form.value.endpointUrl = connection.endpointUrl;
  },
);

function cancel() {
  props.resolve(null);
}

function draft(): ConnectionDraft {
  return {
    id: props.connection?.id ?? null,
    name: form.value.name,
    endpointUrl: form.value.endpointUrl,
    region: form.value.region,
    accessKeyId: form.value.accessKeyId,
    secretAccessKey: form.value.secretAccessKey || null,
    sessionToken: form.value.clearSessionToken ? null : form.value.sessionToken || null,
    clearSessionToken: form.value.clearSessionToken,
    bucket: form.value.bucket,
    prefix: form.value.prefix,
    addressingStyle: form.value.addressingStyle,
    signatureVersion: form.value.signatureVersion,
    payloadSigningEnabled: false,
    requestChecksumCalculation: form.value.requestChecksumCalculation,
    responseChecksumValidation: form.value.responseChecksumValidation,
    security: {
      readOnlyMode: form.value.readOnlyMode,
      confirmDelete: form.value.confirmDelete,
      confirmOverwrite: form.value.confirmOverwrite,
      confirmBulk: false,
      detectPermissions: form.value.detectPermissions,
      autoProbeOnConnect: true,
    },
  };
}

function validate(): boolean {
  const next: Record<string, string> = {};
  if (!form.value.name.trim()) next.name = "Give the connection a name.";
  if (!/^https?:\/\//.test(form.value.endpointUrl.trim()))
    next.endpoint = "The endpoint URL must start with http:// or https://.";
  if (!form.value.region.trim()) next.region = "The region is required.";
  if (!form.value.bucket.trim()) next.bucket = "The bucket name is required.";
  if (form.value.bucket.includes("/")) next.bucket = "The bucket must not contain “/”.";
  if (!form.value.accessKeyId.trim()) next.accessKey = "The access key ID is required.";
  if (!isEdit.value && !form.value.secretAccessKey) next.secret = "The secret access key is required.";
  errors.value = next;
  return Object.keys(next).length === 0;
}

async function testConnection() {
  if (!form.value.endpointUrl || !form.value.accessKeyId || !form.value.bucket) {
    errors.value = { endpoint: "Endpoint, access key and bucket are needed to test." };
    return;
  }
  probing.value = true;
  probeError.value = null;
  try {
    const outcome = await connections.probeDraft(
      {
        endpointUrl: form.value.endpointUrl,
        region: form.value.region,
        accessKeyId: form.value.accessKeyId,
        secretAccessKey: form.value.secretAccessKey || null,
        sessionToken: form.value.sessionToken || null,
        bucket: form.value.bucket,
        prefix: form.value.prefix,
        addressingStyle: form.value.addressingStyle,
        signatureVersion: form.value.signatureVersion,
      },
      true,
      props.connection?.id ?? null,
    );
    capabilities.value = outcome.capabilities;
  } catch (error) {
    capabilities.value = null;
    probeError.value = (error as Error).message;
  } finally {
    probing.value = false;
  }
}

async function save() {
  if (!validate()) return;
  saving.value = true;
  try {
    const saved = await connections.save(draft());
    toasts.ok(`Connection “${saved.name}” saved.`, "Saved");
    props.resolve(saved);
  } catch (error) {
    toasts.error((error as Error).message, "Cannot save");
  } finally {
    saving.value = false;
  }
}

const confirmingDelete = ref(false);

async function duplicate() {
  if (!props.connection) return;
  try {
    await connections.duplicate(props.connection.id);
    toasts.ok("Connection duplicated.");
    props.resolve(null);
  } catch (error) {
    toasts.error((error as Error).message, "Cannot duplicate");
  }
}

async function removeConnection() {
  if (!props.connection) return;
  if (!confirmingDelete.value) {
    confirmingDelete.value = true;
    return;
  }
  try {
    await connections.remove(props.connection.id);
    toasts.ok("Connection deleted.");
    props.resolve(null);
  } catch (error) {
    toasts.error((error as Error).message, "Cannot delete");
  }
}

async function copySnippet() {
  if (await copyText(snippet.value)) toasts.ok("The boto3 client was copied.");
  else toasts.error("The clipboard is not available.");
}
</script>

<template>
  <ModalFrame
    :title="isEdit ? `Edit “${props.connection?.name}”` : 'New connection'"
    :icon="isEdit ? Server : Sparkles"
    size="wide"
    @close="cancel"
  >
    <p class="text-[0.6875rem] leading-relaxed text-muted">
      These fields map one-to-one onto a
      <code class="rounded bg-hover px-1 py-px font-mono">boto3.client("s3", …)</code> call. Copy a
      working Python client's settings in and it will work here.
    </p>

    <div class="grid grid-cols-2 gap-3">
      <AppField label="Connection name" :error="errors.name" hint="Shown in the sidebar.">
        <input v-model="form.name" :class="inputClass" data-testid="conn-name" placeholder="Dev bucket" />
      </AppField>

      <AppField label="Bucket" :error="errors.bucket" hint="boto3: Bucket=…">
        <input v-model="form.bucket" :class="inputClass" data-testid="conn-bucket" :placeholder="PLACEHOLDER.bucket" />
      </AppField>

      <AppField label="Endpoint URL" :error="errors.endpoint" hint="boto3: endpoint_url=…" wide>
        <input
          v-model="form.endpointUrl"
          :class="inputClass"
          data-testid="conn-endpoint"
          :placeholder="PLACEHOLDER.endpoint"
          spellcheck="false"
        />
      </AppField>

      <AppField label="Region" :error="errors.region" hint="boto3: region_name=…">
        <input v-model="form.region" :class="inputClass" data-testid="conn-region" :placeholder="PLACEHOLDER.region" />
      </AppField>

      <AppField
        label="Prefix inside the bucket"
        hint="boto3: Prefix=… Matched literally."
      >
        <input v-model="form.prefix" :class="inputClass" data-testid="conn-prefix" :placeholder="PLACEHOLDER.prefix" />
      </AppField>
    </div>

    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Credentials
      </legend>
      <div class="grid grid-cols-2 gap-3">
        <AppField label="Access key ID" :error="errors.accessKey" hint="boto3: aws_access_key_id">
          <input
            v-model="form.accessKeyId"
            :class="inputClass"
            data-testid="conn-access-key"
            :placeholder="PLACEHOLDER.accessKey"
            spellcheck="false"
            autocomplete="off"
          />
        </AppField>

        <AppField
          label="Secret access key"
          :error="errors.secret"
          :hint="isEdit && props.connection ? 'Leave empty to keep the stored secret.' : 'Encrypted before it touches the disk.'"
        >
          <div class="flex gap-1">
            <input
              v-model="form.secretAccessKey"
              :type="showingSecret ? 'text' : 'password'"
              :class="inputClass"
              data-testid="conn-secret-key"
              :placeholder="isEdit ? '•••••••• (stored)' : ''"
              autocomplete="off"
            />
            <button
              type="button"
              class="grid size-7 shrink-0 place-items-center rounded-control border border-line text-muted transition-colors hover:bg-hover"
              :title="showingSecret ? 'Hide' : 'Show'"
              @click="showingSecret = !showingSecret"
            >
              <KeyRound class="size-3.5" />
            </button>
          </div>
        </AppField>

        <AppField label="Session token" hint="boto3: aws_session_token (temporary credentials)" wide>
          <input
            v-model="form.sessionToken"
            type="password"
            :class="inputClass"
            data-testid="conn-session-token"
            placeholder="optional (STS)"
            autocomplete="off"
          />
        </AppField>

        <label v-if="props.connection?.sessionTokenPresent" class="col-span-full flex items-center gap-2 text-[0.6875rem] text-muted">
          <input v-model="form.clearSessionToken" type="checkbox" :class="checkboxClass" />
          Clear the stored session token
        </label>
      </div>
    </fieldset>

    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        S3 behaviour
      </legend>
      <div class="grid grid-cols-2 gap-3">
        <AppField label="Addressing style" hint="boto3: Config(s3={&quot;addressing_style&quot;: …})">
          <select v-model="form.addressingStyle" :class="selectClass" data-testid="conn-addressing">
            <option value="virtual">virtual — host style (most common)</option>
            <option value="path">path — bucket in the URL path</option>
            <option value="auto">auto — path unless the bucket is DNS-compatible</option>
          </select>
        </AppField>

        <AppField label="Signature version" hint="boto3: Config(signature_version=…)">
          <select v-model="form.signatureVersion" :class="selectClass" data-testid="conn-signature">
            <option value="s3v4">s3v4 — SigV4 (boto3 default)</option>
            <option value="v4">v4 — plain SigV4</option>
            <option value="s3v2">s3v2 — legacy HmacSHA1</option>
          </select>
        </AppField>

        <AppField
          label="Request checksum calculation"
          hint="boto3: Config(request_checksum_calculation=…)"
        >
          <select v-model="form.requestChecksumCalculation" :class="selectClass">
            <option value="whenSupported">whenSupported — AWS default</option>
            <option value="whenRequired">whenRequired — only when required</option>
          </select>
        </AppField>

        <AppField
          label="Response checksum validation"
          hint="boto3: Config(response_checksum_validation=…)"
        >
          <select v-model="form.responseChecksumValidation" :class="selectClass">
            <option value="whenSupported">whenSupported — AWS default</option>
            <option value="whenRequired">whenRequired — only when required</option>
          </select>
        </AppField>
      </div>
      <p class="mt-2 flex items-start gap-1.5 text-[0.6875rem] leading-relaxed text-subtle">
        <AlertTriangle class="mt-0.5 size-3 shrink-0" />
        Some S3-compatible deployments reject the checksum headers the SDK adds by default.
        Switching both to <span class="font-mono">whenRequired</span> is the documented workaround.
      </p>
    </fieldset>

    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Security
      </legend>
      <div class="flex flex-col gap-2">
        <label class="flex items-start gap-2 text-xs">
          <input v-model="form.readOnlyMode" type="checkbox" :class="checkboxClass" class="mt-0.5" />
          <span>
            Read-only mode
            <span class="block text-[0.6875rem] text-muted">
              Block every write, upload, rename and delete on this connection.
            </span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-xs">
          <input v-model="form.confirmDelete" type="checkbox" :class="checkboxClass" class="mt-0.5" />
          <span>
            Ask before deleting
            <span class="block text-[0.6875rem] text-muted">Show a confirmation dialog for deletes.</span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-xs">
          <input v-model="form.confirmOverwrite" type="checkbox" :class="checkboxClass" class="mt-0.5" />
          <span>
            Ask before overwriting
            <span class="block text-[0.6875rem] text-muted">Warn when an upload would replace an object.</span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-xs">
          <input v-model="form.detectPermissions" type="checkbox" :class="checkboxClass" class="mt-0.5" />
          <span>
            Detect permissions on connect
            <span class="block text-[0.6875rem] text-muted">
              Probe read / write / delete rights with a temporary object that is removed immediately.
            </span>
          </span>
        </label>
      </div>
    </fieldset>

    <section class="flex flex-col gap-1.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
          Equivalent boto3 client
        </span>
        <AppButton size="sm" variant="ghost" :icon="ClipboardCopy" @click="copySnippet">Copy</AppButton>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -- highlight.js over escaped text -->
      <pre :class="codeClass" data-testid="boto3-snippet"><code class="hljs" v-html="snippetMarkup" /></pre>
    </section>

    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <AppButton :icon="ShieldCheck" :loading="probing" data-testid="conn-test" @click="testConnection">
          Test connection
        </AppButton>
        <AppButton :icon="ChevronsUpDown" :loading="probing" data-testid="conn-detect" @click="testConnection">
          Detect permissions
        </AppButton>
      </div>

      <div v-if="probeError" class="rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-danger">
        {{ probeError }}
      </div>

      <div v-if="capabilities" class="flex flex-col gap-1.5" data-testid="probe-output">
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="item in [
              { label: 'list', ok: capabilities.canList },
              { label: 'read', ok: capabilities.canRead },
              { label: 'write', ok: capabilities.canWrite },
              { label: 'delete', ok: capabilities.canDelete },
            ]"
            :key="item.label"
            class="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.625rem]"
            :class="item.ok ? 'border-ok/40 text-ok' : 'border-danger/40 text-danger'"
          >
            <component :is="item.ok ? Check : AlertTriangle" class="size-2.5" />
            {{ item.label }}
          </span>
        </div>
        <ul v-if="capabilities.details?.length" class="list-disc pl-4 text-[0.6875rem] leading-relaxed text-muted">
          <li v-for="(detail, index) in capabilities.details" :key="index">{{ detail }}</li>
        </ul>
      </div>
    </section>

    <template #footer>
      <div v-if="isEdit" class="mr-auto flex items-center gap-1">
        <AppButton variant="ghost" size="sm" :icon="Copy" @click="duplicate">Duplicate</AppButton>
        <AppButton variant="ghost" size="sm" :icon="ShieldCheck" :loading="probing" @click="testConnection">
          Detect
        </AppButton>
        <AppButton
          variant="ghost"
          size="sm"
          :icon="Trash2"
          class="text-danger"
          @click="removeConnection"
        >
          {{ confirmingDelete ? "Delete for good?" : "Delete" }}
        </AppButton>
      </div>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" :loading="saving" data-testid="conn-save" @click="save">
        {{ isEdit ? "Save changes" : "Create connection" }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
