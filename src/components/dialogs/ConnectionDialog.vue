<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  AlertTriangle,
  Check,
  ChevronRight,
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
import ErrorNotice from "@/components/ui/ErrorNotice.vue";
import { inputClass, selectClass, codeClass, checkboxClass } from "@/components/ui/controls";
import type { ModalSize } from "@/components/ui/types";
import { boto3Snippet } from "@/lib/boto3";
import { highlight } from "@/lib/highlight";
import { ApiError, copyText } from "@/lib/ipc";
import { useConnectionsStore } from "@/stores/connections";
import { useToastsStore } from "@/stores/toasts";
import { useDialogs } from "@/composables/useDialogs";
import type {
  AddressingStyle,
  Capabilities,
  ChecksumCalculation,
  ChecksumValidation,
  Connection,
  ConnectionDraft,
  ListErrorDetail,
  SignatureVersion,
} from "@/types";

const props = defineProps<{
  dialogId?: number;
  size?: ModalSize;
  connection?: Connection | null;
  resolve: (saved: Connection | null) => void;
}>();

const connections = useConnectionsStore();
const toasts = useToastsStore();
const confirmations = useDialogs();

const isEdit = computed(() => Boolean(props.connection?.id));

const form = ref({
  name: props.connection?.name ?? "",
  // Initialised here rather than in `onMounted`, which used to render an empty
  // Endpoint for one frame in the edit dialog (CON-3).
  endpointUrl: props.connection?.endpointUrl ?? "",
  // Blank on purpose: the presets below fill it, and other providers do not
  // necessarily use `us-east-1`.
  region: props.connection?.region ?? "",
  accessKeyId: props.connection?.accessKeyId ?? "",
  secretAccessKey: "",
  sessionToken: "",
  clearSessionToken: false,
  bucket: props.connection?.bucket ?? "",
  prefix: props.connection?.prefix ?? "",
  addressingStyle: (props.connection?.addressingStyle ?? "virtual") as AddressingStyle,
  signatureVersion: (props.connection?.signatureVersion ?? "s3v4") as SignatureVersion,
  requestChecksumCalculation: (props.connection?.requestChecksumCalculation ??
    "whenRequired") as ChecksumCalculation,
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

/**
 * Presets fill an empty form; they never touch a value the user typed. The
 * second preset is deliberately blank, so it hands the form back for any other
 * S3-compatible service.
 */
const PRESETS = {
  aws: { endpointUrl: "https://s3.amazonaws.com", region: "us-east-1" },
  other: { endpointUrl: "", region: "" },
};
/** What the last preset put in the field, so "Other" can undo its own fill. */
const presetFilled = { endpointUrl: "", region: "" };

function applyPreset(name: keyof typeof PRESETS) {
  const values = PRESETS[name];
  for (const key of ["endpointUrl", "region"] as const) {
    const current = form.value[key];
    if (!current.trim() || current === presetFilled[key]) {
      form.value[key] = values[key];
    }
    presetFilled[key] = values[key];
  }
}

const nameInput = ref<HTMLInputElement | null>(null);
const endpointInput = ref<HTMLInputElement | null>(null);
const regionInput = ref<HTMLInputElement | null>(null);
const bucketInput = ref<HTMLInputElement | null>(null);
const accessKeyInput = ref<HTMLInputElement | null>(null);
const secretInput = ref<HTMLInputElement | null>(null);

/** The order the fields are drawn in, so the first error is the first one seen. */
const FIELD_ORDER = ["name", "bucket", "endpoint", "region", "accessKey", "secret"] as const;

function inputFor(key: (typeof FIELD_ORDER)[number]): HTMLInputElement | null {
  return {
    name: nameInput.value,
    endpoint: endpointInput.value,
    region: regionInput.value,
    bucket: bucketInput.value,
    accessKey: accessKeyInput.value,
    secret: secretInput.value,
  }[key];
}

const showingSecret = ref(false);
const probing = ref(false);
const saving = ref(false);
const capabilities = ref<Capabilities | null>(null);
const probeError = ref<string | null>(null);
/** Hints/code/request id for a failed probe: the fix-it text matters most here. */
const probeDetail = ref<ListErrorDetail | null>(null);
/**
 * The Test button lives in the footer but its answer renders mid-form. These
 * refs bring the answer into view, so a result below the fold cannot be missed
 * (final review minor 11).
 */
const probeErrorBlock = ref<HTMLElement | null>(null);
const probeOutputBlock = ref<HTMLElement | null>(null);
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

/**
 * Validate, and on failure take the user to the first problem: the form is
 * long, so an inline message below the fold used to be invisible (CON-3).
 */
async function validate(): Promise<boolean> {
  const next: Record<string, string> = {};
  if (!form.value.name.trim()) next.name = "Give the connection a name.";
  if (!form.value.endpointUrl.trim()) {
    next.endpoint = "The endpoint URL is required.";
  } else if (!/^https?:\/\//.test(form.value.endpointUrl.trim())) {
    next.endpoint = "The endpoint URL must start with http:// or https://.";
  }
  if (!form.value.region.trim()) next.region = "The region is required.";
  if (!form.value.bucket.trim()) next.bucket = "The bucket name is required.";
  else if (form.value.bucket.includes("/")) next.bucket = "The bucket must not contain “/”.";
  if (!form.value.accessKeyId.trim()) next.accessKey = "The access key ID is required.";
  if (!isEdit.value && !form.value.secretAccessKey) {
    next.secret = "The secret access key is required.";
  }
  errors.value = next;

  const first = FIELD_ORDER.find((key) => next[key]);
  if (!first) return true;
  await nextTick();
  const input = inputFor(first);
  input?.scrollIntoView({ block: "center", behavior: "smooth" });
  input?.focus({ preventScroll: true });
  return false;
}

async function testConnection() {
  // Name the field that is actually missing: one message under Endpoint made
  // users hunt for the bucket they had not filled in.
  const missing: Record<string, string> = {};
  if (!form.value.bucket.trim()) {
    missing.bucket = "The bucket name is required to test the connection.";
  }
  if (!form.value.endpointUrl.trim()) {
    missing.endpoint = "The endpoint URL is required to test the connection.";
  }
  if (!form.value.accessKeyId.trim()) {
    missing.accessKey = "The access key ID is required to test the connection.";
  }
  if (Object.keys(missing).length) {
    errors.value = missing;
    await nextTick();
    const first = FIELD_ORDER.find((key) => missing[key]);
    if (first) inputFor(first)?.focus({ preventScroll: true });
    return;
  }
  probing.value = true;
  probeError.value = null;
  probeDetail.value = null;
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
    probeError.value = error instanceof Error ? error.message : String(error);
    probeDetail.value =
      error instanceof ApiError
        ? { hints: error.hints, code: error.code, requestId: error.requestId }
        : null;
  } finally {
    probing.value = false;
  }
  // `block: "nearest"` scrolls only when the answer is actually off-screen, so
  // a short dialog does not jump for no reason.
  await nextTick();
  const answer = probeError.value ? probeErrorBlock.value : probeOutputBlock.value;
  answer?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function save() {
  if (!(await validate())) return;
  saving.value = true;
  try {
    const saved = await connections.save(draft());
    toasts.ok(`Connection “${saved.name}” saved.`, "Saved");
    props.resolve(saved);
  } catch (error) {
    toasts.apiError(error, "Cannot save");
  } finally {
    saving.value = false;
  }
}

async function duplicate() {
  if (!props.connection) return;
  try {
    await connections.duplicate(props.connection.id);
    toasts.ok("Connection duplicated.");
    props.resolve(null);
  } catch (error) {
    toasts.apiError(error, "Cannot duplicate");
  }
}

async function removeConnection() {
  const connection = props.connection;
  if (!connection) return;
  // Removing a connection is a destructive, irreversible action and deserves
  // the same explicit confirmation as deleting objects (CON-7).
  const confirmed = await confirmations.confirm({
    title: `Remove “${connection.name}”?`,
    message:
      "This removes the connection and its saved credentials from this computer. Objects in the bucket are unaffected.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await connections.remove(connection.id);
    toasts.ok(`Connection “${connection.name}” removed.`);
    props.resolve(null);
  } catch (error) {
    toasts.apiError(error, "Cannot remove connection");
  }
}

/**
 * Copy feedback belongs on the button: a toast opened from inside a modal would
 * be hidden behind it, which read as "nothing happened".
 */
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copySnippet() {
  const ok = await copyText(snippet.value);
  if (!ok) {
    toasts.error("The clipboard is not available.");
    return;
  }
  copied.value = true;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 2000);
}
</script>

<template>
  <ModalFrame
    :title="isEdit ? `Edit “${props.connection?.name}”` : 'New connection'"
    :icon="isEdit ? Server : Sparkles"
    :size="props.size"
    @close="cancel"
  >
    <p class="text-meta leading-relaxed text-muted">
      Copy the settings from a working Python client and they will behave the same here. The basic
      fields are what most connections need; open Advanced for signing, checksums, security and the
      boto3 equivalent.
    </p>

    <div class="flex flex-wrap items-center gap-1.5" data-testid="conn-presets">
      <span class="text-meta text-subtle">Start from a preset:</span>
      <AppButton size="sm" data-testid="conn-preset-aws" @click="applyPreset('aws')">
        AWS S3
      </AppButton>
      <AppButton size="sm" data-testid="conn-preset-other" @click="applyPreset('other')">
        Other S3-compatible
      </AppButton>
    </div>

    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-meta font-semibold tracking-wider text-subtle uppercase">
        Connection
      </legend>
      <div class="grid grid-cols-2 gap-3">
        <AppField
          label="Name"
          required
          :error="errors.name"
          hint="What this connection is called in the sidebar."
        >
          <input
            ref="nameInput"
            v-model="form.name"
            :class="inputClass"
            data-testid="conn-name"
            placeholder="Dev bucket"
            autofocus
            :aria-invalid="errors.name ? 'true' : undefined"
          />
        </AppField>

        <AppField
          label="Bucket"
          required
          :error="errors.bucket"
          hint="The bucket this connection is scoped to."
        >
          <input
            ref="bucketInput"
            v-model="form.bucket"
            :class="inputClass"
            data-testid="conn-bucket"
            :placeholder="PLACEHOLDER.bucket"
            :aria-invalid="errors.bucket ? 'true' : undefined"
          />
        </AppField>

        <AppField
          label="Endpoint"
          required
          wide
          :error="errors.endpoint"
          hint="The S3 endpoint, starting with https://"
        >
          <input
            ref="endpointInput"
            v-model="form.endpointUrl"
            :class="inputClass"
            data-testid="conn-endpoint"
            :placeholder="PLACEHOLDER.endpoint"
            spellcheck="false"
            :aria-invalid="errors.endpoint ? 'true' : undefined"
          />
        </AppField>

        <AppField
          label="Region"
          required
          :error="errors.region"
          hint="Usually dictated by the provider."
        >
          <input
            ref="regionInput"
            v-model="form.region"
            :class="inputClass"
            data-testid="conn-region"
            :placeholder="PLACEHOLDER.region"
            :aria-invalid="errors.region ? 'true' : undefined"
          />
        </AppField>

        <AppField label="Root folder (scope)" hint="Browse stays inside this prefix">
          <input
            v-model="form.prefix"
            :class="inputClass"
            data-testid="conn-prefix"
            :placeholder="PLACEHOLDER.prefix"
          />
        </AppField>

        <AppField label="Access key" required :error="errors.accessKey" hint="The key ID, not the secret.">
          <input
            ref="accessKeyInput"
            v-model="form.accessKeyId"
            :class="inputClass"
            data-testid="conn-access-key"
            :placeholder="PLACEHOLDER.accessKey"
            spellcheck="false"
            autocomplete="off"
            :aria-invalid="errors.accessKey ? 'true' : undefined"
          />
        </AppField>

        <AppField
          label="Secret access key"
          :required="!isEdit"
          :error="errors.secret"
          :hint="
            isEdit && props.connection
              ? 'Leave empty to keep the stored one.'
              : 'Stored encrypted on this machine.'
          "
        >
          <div class="flex gap-1">
            <input
              ref="secretInput"
              v-model="form.secretAccessKey"
              :type="showingSecret ? 'text' : 'password'"
              :class="inputClass"
              data-testid="conn-secret-key"
              :placeholder="isEdit ? '•••••••• (stored)' : ''"
              autocomplete="off"
              :aria-invalid="errors.secret ? 'true' : undefined"
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

        <AppField label="Session token" hint="Only for temporary credentials." wide>
          <input
            v-model="form.sessionToken"
            type="password"
            :class="inputClass"
            data-testid="conn-session-token"
            placeholder="optional (STS)"
            autocomplete="off"
          />
        </AppField>

        <label v-if="props.connection?.sessionTokenPresent" class="col-span-full flex items-center gap-2 text-meta text-muted">
          <input v-model="form.clearSessionToken" type="checkbox" :class="checkboxClass" />
          Clear the stored session token
        </label>
      </div>
    </fieldset>

    <div
      v-if="probeError"
      ref="probeErrorBlock"
      class="rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5"
      data-testid="probe-error"
    >
      <ErrorNotice
        :message="probeError"
        :hints="probeDetail?.hints"
        :code="probeDetail?.code"
        :request-id="probeDetail?.requestId"
      />
    </div>

    <div
      v-if="capabilities"
      ref="probeOutputBlock"
      class="flex flex-col gap-1.5"
      data-testid="probe-output"
    >
      <div class="flex flex-wrap gap-1.5">
        <span
          v-for="item in [
            { label: 'list', ok: capabilities.canList },
            { label: 'read', ok: capabilities.canRead },
            { label: 'write', ok: capabilities.canWrite },
            { label: 'delete', ok: capabilities.canDelete },
          ]"
          :key="item.label"
          class="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-micro"
          :class="item.ok ? 'border-ok/40 text-ok' : 'border-danger/40 text-danger'"
        >
          <component :is="item.ok ? Check : AlertTriangle" class="size-2.5" />
          {{ item.label }}
        </span>
      </div>
      <ul v-if="capabilities.details?.length" class="list-disc pl-4 text-meta leading-relaxed text-muted">
        <li v-for="(detail, index) in capabilities.details" :key="index">{{ detail }}</li>
      </ul>
    </div>

    <details class="group/advanced rounded-control border border-line" data-testid="conn-advanced">
      <summary class="flex cursor-pointer list-none items-baseline gap-2 px-3 py-2">
        <ChevronRight class="size-3 shrink-0 self-center text-subtle transition-transform group-open/advanced:rotate-90" />
        <span class="text-meta font-semibold tracking-wider text-subtle uppercase">
          Advanced
        </span>
        <span class="text-meta text-subtle">
          Addressing, signing, checksums, security and the boto3 equivalent
        </span>
      </summary>

      <div class="flex flex-col gap-3 border-t border-line p-3">
        <fieldset class="rounded-control border border-line p-3">
          <legend class="px-1 text-meta font-semibold tracking-wider text-subtle uppercase">
            S3 behaviour
          </legend>
          <div class="grid grid-cols-2 gap-3">
            <AppField label="Bucket in the address" hint="Most services put the bucket in the host name.">
              <select v-model="form.addressingStyle" :class="selectClass" data-testid="conn-addressing">
                <option value="virtual">In the host name (usual)</option>
                <option value="path">In the URL path</option>
                <option value="auto">Decide automatically</option>
              </select>
            </AppField>

            <AppField label="Request signing" hint="How requests are signed. The newest is the default.">
              <select v-model="form.signatureVersion" :class="selectClass" data-testid="conn-signature">
                <option value="s3v4">Version 4 (usual)</option>
                <option value="v4">Version 4, generic</option>
                <option value="s3v2">Version 2 (legacy services)</option>
              </select>
            </AppField>

            <AppField
              label="Checksums on upload"
              hint="Only change this if the service requires checksum headers."
            >
              <select v-model="form.requestChecksumCalculation" :class="selectClass">
                <option value="whenRequired">Only when required</option>
                <option value="whenSupported">When the service supports it</option>
              </select>
            </AppField>

            <AppField
              label="Checksums on download"
              hint="Whether responses are checked against their checksum."
            >
              <select v-model="form.responseChecksumValidation" :class="selectClass">
                <option value="whenSupported">When the service supports it</option>
                <option value="whenRequired">Only when required</option>
              </select>
            </AppField>
          </div>
          <p class="mt-2 flex items-start gap-1.5 text-meta leading-relaxed text-subtle">
            <AlertTriangle class="mt-0.5 size-3 shrink-0" />
            Some S3-compatible services reject the checksum headers the client adds. Uploads
            already default to “only when required”; if downloads fail, switch that setting too.
          </p>
        </fieldset>

        <fieldset class="rounded-control border border-line p-3">
          <legend class="px-1 text-meta font-semibold tracking-wider text-subtle uppercase">
            Security
          </legend>
          <div class="flex flex-col gap-2">
            <label class="flex items-start gap-2 text-xs">
              <input v-model="form.readOnlyMode" type="checkbox" :class="checkboxClass" class="mt-0.5" />
              <span>
                Read-only mode
                <span class="block text-meta text-muted">
                  Block every write, upload, rename and delete on this connection.
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-xs">
              <input v-model="form.confirmDelete" type="checkbox" :class="checkboxClass" class="mt-0.5" />
              <span>
                Ask before deleting
                <span class="block text-meta text-muted">Show a confirmation dialog for deletes.</span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-xs">
              <input v-model="form.confirmOverwrite" type="checkbox" :class="checkboxClass" class="mt-0.5" />
              <span>
                Ask before overwriting
                <span class="block text-meta text-muted">Warn when an upload would replace an object.</span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-xs">
              <input v-model="form.detectPermissions" type="checkbox" :class="checkboxClass" class="mt-0.5" />
              <span>
                Detect permissions on connect
                <span class="block text-meta text-muted">
                  Probe read / write / delete rights with a temporary object that is removed immediately.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <details class="group/boto3 rounded-control border border-line">
          <summary class="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-meta font-medium text-muted">
            <ChevronRight class="size-3 shrink-0 text-subtle transition-transform group-open/boto3:rotate-90" />
            Show boto3 equivalent
          </summary>
          <div class="flex flex-col gap-1.5 border-t border-line p-3">
            <div class="flex items-center justify-end">
              <AppButton
                size="sm"
                :variant="copied ? 'primary' : 'ghost'"
                :icon="copied ? Check : ClipboardCopy"
                :class="copied ? '!bg-ok !border-ok text-white' : ''"
                data-testid="copy-snippet"
                @click="copySnippet"
              >
                {{ copied ? "Copied" : "Copy" }}
              </AppButton>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- highlight.js over escaped text -->
            <pre :class="codeClass" data-testid="boto3-snippet"><code class="hljs" v-html="snippetMarkup" /></pre>
          </div>
        </details>
      </div>
    </details>

    <template #footer>
      <div class="mr-auto flex items-center gap-1">
        <AppButton :icon="ShieldCheck" :loading="probing" data-testid="conn-test" @click="testConnection">
          {{ probing ? "Testing…" : "Test connection" }}
        </AppButton>
        <template v-if="isEdit">
          <AppButton variant="ghost" size="sm" :icon="Copy" @click="duplicate">Duplicate</AppButton>
          <AppButton
            variant="ghost"
            size="sm"
            :icon="Trash2"
            class="text-danger"
            @click="removeConnection"
          >
            Remove connection…
          </AppButton>
        </template>
      </div>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" :loading="saving" data-testid="conn-save" @click="save">
        {{ isEdit ? "Save changes" : "Create connection" }}
      </AppButton>
    </template>
  </ModalFrame>
</template>
