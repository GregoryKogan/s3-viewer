import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/lib/ipc";
import { clamp } from "@/lib/format";
import type { AppSettings, LayoutSettings, SecurityStatus, Theme, TransferResult } from "@/types";

const LAYOUT_DEFAULTS: LayoutSettings = { sidebar: 264, preview: 420, collapsed: false };
const SIDEBAR_MIN = 190;
const SIDEBAR_MAX = 520;
const PREVIEW_MIN = 260;

/**
 * Application shell: persisted settings, panel geometry, theme, and the
 * toasts/transfers surfaces. Anything a component needs to remember between
 * launches lives here.
 */
export const useUiStore = defineStore("ui", () => {
  const settings = ref<AppSettings | null>(null);
  const security = ref<SecurityStatus | null>(null);
  const layout = ref<LayoutSettings>({ ...LAYOUT_DEFAULTS });
  const previewHidden = ref(false);
  const transfersVisible = ref(false);
  const ready = ref(false);

  const theme = computed<Theme>(() => settings.value?.theme ?? "dark");
  const previewMaxBytes = computed(() => settings.value?.previewMaxBytes ?? 25 * 1024 * 1024);

  async function load() {
    settings.value = await api.getSettings();
    if (settings.value.layout) {
      layout.value = { ...layout.value, ...settings.value.layout };
    }
    applyTheme();
    ready.value = true;
  }

  async function loadSecurity() {
    try {
      security.value = await api.securityStatus();
    } catch {
      security.value = null;
    }
  }

  function prefersLight() {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  }

  function applyTheme() {
    const requested = theme.value;
    const resolved = requested === "system" ? (prefersLight() ? "light" : "dark") : requested;
    document.documentElement.dataset.theme = resolved;
  }

  async function saveSettings(next: Partial<AppSettings>) {
    const merged: AppSettings = {
      previewMaxBytes: settings.value?.previewMaxBytes ?? 25 * 1024 * 1024,
      listPageLimit: settings.value?.listPageLimit ?? 20_000,
      downloadDir: settings.value?.downloadDir ?? null,
      showSystemObjects: settings.value?.showSystemObjects ?? false,
      theme: settings.value?.theme ?? "dark",
      layout: layout.value,
      ...next,
    };
    settings.value = await api.updateSettings(merged);
    layout.value = { ...layout.value, ...(settings.value.layout ?? {}) };
    applyTheme();
    return settings.value;
  }

  // ------------------------------------------------------------------ layout

  let layoutTimer: ReturnType<typeof setTimeout> | undefined;

  /** Persist geometry, debounced: dragging a handle must not write per pixel. */
  function persistLayout() {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      void saveSettings({ layout: { ...layout.value } }).catch(() => {});
    }, 400);
  }

  function setSidebarWidth(width: number) {
    layout.value.sidebar = clamp(Math.round(width), SIDEBAR_MIN, SIDEBAR_MAX);
    persistLayout();
  }

  function setPreviewWidth(width: number) {
    const max = Math.max(PREVIEW_MIN + 20, Math.round(globalThis.innerWidth * 0.7));
    layout.value.preview = clamp(Math.round(width), PREVIEW_MIN, max);
    persistLayout();
  }

  function resetSidebarWidth() {
    layout.value.sidebar = LAYOUT_DEFAULTS.sidebar;
    persistLayout();
  }

  function resetPreviewWidth() {
    layout.value.preview = LAYOUT_DEFAULTS.preview;
    persistLayout();
  }

  function toggleSidebar() {
    layout.value.collapsed = !layout.value.collapsed;
    persistLayout();
  }

  function togglePreview() {
    previewHidden.value = !previewHidden.value;
  }

  function clampLayoutToWindow() {
    const maxSidebar = Math.min(SIDEBAR_MAX, Math.round(globalThis.innerWidth * 0.5));
    layout.value.sidebar = clamp(layout.value.sidebar, SIDEBAR_MIN, maxSidebar);
    const maxPreview = Math.max(PREVIEW_MIN + 20, Math.round(globalThis.innerWidth * 0.7));
    layout.value.preview = clamp(layout.value.preview, PREVIEW_MIN, maxPreview);
  }

  return {
    settings,
    security,
    layout,
    previewHidden,
    transfersVisible,
    ready,
    theme,
    previewMaxBytes,
    load,
    loadSecurity,
    applyTheme,
    saveSettings,
    setSidebarWidth,
    setPreviewWidth,
    resetSidebarWidth,
    resetPreviewWidth,
    toggleSidebar,
    togglePreview,
    clampLayoutToWindow,
  };
});

/** Kept in one place so components do not invent their own default. */
export function defaultLayout(): LayoutSettings {
  return { ...LAYOUT_DEFAULTS };
}

export type { TransferResult };
