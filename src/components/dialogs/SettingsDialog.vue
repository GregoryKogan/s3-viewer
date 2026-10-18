<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FolderOpen, RefreshCw, RotateCcw, ShieldCheck, SlidersHorizontal } from "@lucide/vue";
import ModalFrame from "@/components/ui/ModalFrame.vue";
import AppButton from "@/components/ui/AppButton.vue";
import AppField from "@/components/ui/AppField.vue";
import AppBadge from "@/components/ui/AppBadge.vue";
import { inputClass, selectClass, checkboxClass } from "@/components/ui/controls";
import { pickFiles } from "@/lib/ipc";
import { humanSize } from "@/lib/format";
import { IS_MAC, keyLabel, shortcutLabel } from "@/lib/keyboard";
import { useUiStore } from "@/stores/ui";
import { useDialogsStore } from "@/stores/dialogs";
import { useToastsStore } from "@/stores/toasts";
import { useUpdatesStore } from "@/stores/updates";
import UpdateDialog from "@/components/dialogs/UpdateDialog.vue";
import type { AppSettings, Theme } from "@/types";

const props = defineProps<{
  dialogId?: number;
  resolve: (saved: AppSettings | null) => void;
}>();

const ui = useUiStore();
const dialogs = useDialogsStore();
const toasts = useToastsStore();
const updates = useUpdatesStore();

const PRESETS = [
  { value: 2 * 1024 * 1024, label: "2 MB — safest" },
  { value: 10 * 1024 * 1024, label: "10 MB" },
  { value: 25 * 1024 * 1024, label: "25 MB — default" },
  { value: 100 * 1024 * 1024, label: "100 MB" },
  { value: 1024 * 1024 * 1024, label: "1 GB — can be slow" },
];

/** Mirrors the defaults in the Rust `AppSettings::default`. */
const DEFAULTS = {
  previewMaxBytes: 25 * 1024 * 1024,
  listPageLimit: 20_000,
  theme: "dark" as Theme,
  downloadDir: "",
  askDownloadLocation: false,
  showSystemObjects: false,
};

const form = ref({
  previewMaxBytes: ui.settings?.previewMaxBytes ?? DEFAULTS.previewMaxBytes,
  listPageLimit: ui.settings?.listPageLimit ?? DEFAULTS.listPageLimit,
  theme: (ui.settings?.theme ?? DEFAULTS.theme) as Theme,
  downloadDir: ui.settings?.downloadDir ?? DEFAULTS.downloadDir,
  askDownloadLocation: ui.settings?.askDownloadLocation ?? DEFAULTS.askDownloadLocation,
  showSystemObjects: ui.settings?.showSystemObjects ?? DEFAULTS.showSystemObjects,
});

const saving = ref(false);

const previewOptions = computed(() => {
  const known = PRESETS.some((preset) => preset.value === form.value.previewMaxBytes);
  return known
    ? PRESETS
    : [...PRESETS, { value: form.value.previewMaxBytes, label: `${humanSize(form.value.previewMaxBytes)} — custom` }];
});

/**
 * The same bindings the global key handler installs. Open and Delete are not
 * modified everywhere, so they use the platform key glyph rather than claiming
 * a modifier the handler does not require.
 */
const shortcuts = [
  { action: "Refresh", keys: shortcutLabel("R") },
  { action: "Upload", keys: shortcutLabel("U") },
  { action: "New connection", keys: shortcutLabel("N") },
  { action: "Edit connection", keys: shortcutLabel("I") },
  { action: "Address", keys: shortcutLabel("L") },
  { action: "Filter", keys: shortcutLabel("F") },
  { action: "Up", keys: shortcutLabel("ArrowUp") },
  { action: "Toggle sidebar", keys: shortcutLabel("B") },
  { action: "Select all", keys: shortcutLabel("A") },
  { action: "Open", keys: keyLabel("Enter") },
  { action: "Delete", keys: IS_MAC ? shortcutLabel("Backspace") : keyLabel("Delete") },
];

onMounted(() => {
  void ui.loadSecurity();
  void updates.loadVersion();
});

const checking = ref(false);

/** Manual check: unlike the launch check, every outcome here is worth a message. */
async function checkForUpdates() {
  checking.value = true;
  try {
    if (await updates.check()) {
      await dialogs.open<null>(UpdateDialog, (settle) => ({ resolve: settle }), "normal");
      return;
    }
    toasts.ok("This is the newest version.");
  } catch (error) {
    toasts.error((error as Error).message, "Cannot check for updates");
  } finally {
    checking.value = false;
  }
}

async function chooseDownloadDir() {
  try {
    const [path] = await pickFiles({ multiple: false, directory: true });
    if (path) form.value.downloadDir = path;
  } catch {
    /* the field stays editable by hand */
  }
}

/**
 * Restore the form, not the saved settings: the user can still cancel, and a
 * reset only takes effect when Save is pressed.
 */
function resetDefaults() {
  form.value = { ...DEFAULTS };
}

function cancel() {
  props.resolve(null);
}

async function save() {
  saving.value = true;
  try {
    const saved = await ui.saveSettings({
      previewMaxBytes: Number(form.value.previewMaxBytes),
      listPageLimit: Number(form.value.listPageLimit) || DEFAULTS.listPageLimit,
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

    <fieldset class="rounded-control border border-line p-3" data-testid="settings-shortcuts">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Keyboard shortcuts
      </legend>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-1.5">
        <div
          v-for="item in shortcuts"
          :key="item.action"
          class="flex items-baseline justify-between gap-2 text-xs"
        >
          <dt class="min-w-0 truncate text-muted">{{ item.action }}</dt>
          <dd class="shrink-0">
            <kbd class="rounded-[4px] border border-line-strong bg-inset px-1.5 py-px font-mono text-[0.625rem] text-content">
              {{ item.keys }}
            </kbd>
          </dd>
        </div>
      </dl>
    </fieldset>

    <fieldset class="rounded-control border border-line p-3" data-testid="settings-application">
      <legend class="px-1 text-[0.6875rem] font-semibold tracking-wider text-subtle uppercase">
        Application
      </legend>
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-content">
            S3 Viewer {{ updates.runningVersion || "—" }}
          </p>
          <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
            Updates are checked at launch. A newer version downloads as one signed archive,
            installs in place and restarts the app.
          </p>
        </div>
        <AppButton
          :icon="RefreshCw"
          :loading="checking"
          data-testid="settings-check-updates"
          @click="checkForUpdates"
        >
          Check now
        </AppButton>
      </div>
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
      <AppButton
        class="mr-auto"
        :icon="RotateCcw"
        data-testid="settings-reset"
        @click="resetDefaults"
      >
        Reset to defaults
      </AppButton>
      <AppButton @click="cancel">Cancel</AppButton>
      <AppButton variant="primary" :loading="saving" data-testid="settings-save" @click="save">
        Save
      </AppButton>
    </template>
  </ModalFrame>
</template>
