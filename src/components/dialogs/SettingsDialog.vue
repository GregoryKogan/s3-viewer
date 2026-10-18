<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FolderOpen, ShieldCheck, SlidersHorizontal } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import AppField from "@/components/ui/AppField.vue";
import AppBadge from "@/components/ui/AppBadge.vue";
import { inputClass, selectClass, checkboxClass } from "@/components/ui/controls";
import { pickFiles } from "@/lib/ipc";
import { humanSize } from "@/lib/format";
import { useUiStore } from "@/stores/ui";
import { useToastsStore } from "@/stores/toasts";
import type { AppSettings, Theme } from "@/types";

const props = defineProps<{
  dialogId?: number;
  resolve: (saved: AppSettings | null) => void;
}>();

const ui = useUiStore();
const toasts = useToastsStore();

const PRESETS = [
  { value: 2 * 1024 * 1024, label: "2 MB — safest" },
  { value: 10 * 1024 * 1024, label: "10 MB" },
  { value: 25 * 1024 * 1024, label: "25 MB — default" },
  { value: 100 * 1024 * 1024, label: "100 MB" },
  { value: 1024 * 1024 * 1024, label: "1 GB — can be slow" },
];

const form = ref({
  previewMaxBytes: ui.settings?.previewMaxBytes ?? 25 * 1024 * 1024,
  listPageLimit: ui.settings?.listPageLimit ?? 20_000,
  theme: (ui.settings?.theme ?? "dark") as Theme,
  downloadDir: ui.settings?.downloadDir ?? "",
  askDownloadLocation: ui.settings?.askDownloadLocation ?? false,
  showSystemObjects: ui.settings?.showSystemObjects ?? false,
});

const saving = ref(false);

const previewOptions = computed(() => {
  const known = PRESETS.some((preset) => preset.value === form.value.previewMaxBytes);
  return known
    ? PRESETS
    : [...PRESETS, { value: form.value.previewMaxBytes, label: `${humanSize(form.value.previewMaxBytes)} — custom` }];
});

onMounted(() => {
  void ui.loadSecurity();
});

async function chooseDownloadDir() {
  try {
    const [path] = await pickFiles({ multiple: false, directory: true });
    if (path) form.value.downloadDir = path;
  } catch {
    /* the field stays editable by hand */
  }
}

function cancel() {
  props.resolve(null);
}

async function save() {
  saving.value = true;
  try {
    const saved = await ui.saveSettings({
      previewMaxBytes: Number(form.value.previewMaxBytes),
      listPageLimit: Number(form.value.listPageLimit) || 20_000,
      theme: form.value.theme,
      downloadDir: form.value.downloadDir.trim() || null,
      askDownloadLocation: form.value.askDownloadLocation,
      showSystemObjects: form.value.showSystemObjects,
    });
    toasts.ok("Settings saved.");
    props.resolve(saved);
  } catch (error) {
    toasts.error((error as Error).message, "Cannot save settings");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ModalFrame title="Settings" :icon="SlidersHorizontal" @close="cancel">
    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Preview
      </legend>
      <AppField
        label="Maximum file size to preview"
        hint="Larger files are listed and downloadable, but the preview panel explains the limit instead of loading them."
        wide
      >
        <select v-model.number="form.previewMaxBytes" :class="selectClass" data-testid="settings-preview-limit">
          <option v-for="preset in previewOptions" :key="preset.value" :value="preset.value">
            {{ preset.label }}
          </option>
        </select>
      </AppField>
    </fieldset>

    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Browsing
      </legend>
      <div class="grid grid-cols-2 gap-3">
        <AppField label="Objects loaded per folder" hint="A safety cap for very large prefixes.">
          <input
            v-model.number="form.listPageLimit"
            type="number"
            min="200"
            max="100000"
            :class="inputClass"
            data-testid="settings-list-limit"
          />
        </AppField>

        <AppField label="Theme">
          <select v-model="form.theme" :class="selectClass" data-testid="settings-theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Follow the system</option>
          </select>
        </AppField>

        <label class="col-span-full flex items-start gap-2 text-xs">
          <input v-model="form.showSystemObjects" type="checkbox" :class="checkboxClass" class="mt-0.5" data-testid="settings-show-system" />
          <span>
            Show system objects
            <span class="block text-[0.6875rem] text-muted">
              _SUCCESS, _temporary, .DS_Store and *.crc are hidden by default.
            </span>
          </span>
        </label>
      </div>
    </fieldset>

    <fieldset class="rounded-control border border-line p-3">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Downloads
      </legend>
      <AppField label="Download folder" hint="Leave empty to use the operating system's Downloads folder." wide>
        <div class="flex gap-1.5">
          <input
            v-model="form.downloadDir"
            :class="inputClass"
            placeholder="(default: your Downloads folder)"
            data-testid="settings-download-dir"
          />
          <AppButton
            :icon="FolderOpen"
            title="Choose a folder"
            aria-label="Choose a folder"
            data-testid="settings-choose-dir"
            @click="chooseDownloadDir"
          />
        </div>
      </AppField>

      <label class="mt-3 flex items-start gap-2 text-xs">
        <input
          v-model="form.askDownloadLocation"
          type="checkbox"
          :class="checkboxClass"
          class="mt-0.5"
          data-testid="settings-ask-location"
        />
        <span>
          Ask where to save each download
          <span class="block text-[0.6875rem] text-muted">
            When this is off, files go straight to the folder above.
          </span>
        </span>
      </label>
    </fieldset>

    <fieldset v-if="ui.security" class="rounded-control border border-line p-3" data-testid="security-summary">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Security
      </legend>
      <div class="flex flex-col gap-2 text-[0.6875rem] leading-relaxed text-muted">
        <div class="flex items-center gap-2">
          <ShieldCheck class="size-3.5 shrink-0 text-ok" />
          <span class="font-medium text-content">Master key storage</span>
          <AppBadge :tone="ui.security.masterKeyInKeychain ? 'ok' : 'warn'">
            {{ ui.security.masterKeyInKeychain ? "OS keychain" : "local key file (0600)" }}
          </AppBadge>
        </div>
        <p>
          {{
            ui.security.masterKeyInKeychain
              ? "Secret access keys are sealed with XChaCha20-Poly1305; the master key lives in the operating system keychain, not on disk."
              : "The operating system keychain was unavailable, so the master key is stored in a file readable only by your user (mode 0600). Secrets are still encrypted at rest."
          }}
        </p>
        <p class="font-mono break-all text-subtle">
          {{ ui.security.configPath }} (mode 0600, version {{ ui.security.configVersion }})
        </p>
        <p>{{ ui.security.connectionCount }} connection(s) stored.</p>
      </div>
    </fieldset>

    <template #footer>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" :loading="saving" data-testid="settings-save" @click="save">
        Save
      </AppButton>
    </template>
  </ModalFrame>
</template>
