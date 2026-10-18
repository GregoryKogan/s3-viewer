import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/lib/ipc";
import { clamp } from "@/lib/format";
import type { AppSettings, LayoutSettings, SecurityStatus, Theme, TransferResult } from "@/types";

const LAYOUT_DEFAULTS: LayoutSettings = {
  sidebar: 264,
  preview: 420,
  collapsed: false,
  previewHidden: false,
};
const SIDEBAR_MIN = 190;
const SIDEBAR_MAX = 520;
const PREVIEW_MIN = 260;

/** Must match `public/theme-init.js`, which resolves it before the app loads. */
const THEME_STORAGE_KEY = "s3viewer.theme";

function rememberTheme(value: Theme) {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* storage may be unavailable; the next launch just falls back to dark */
  }
}

/**
 * Application shell: persisted settings, panel geometry, theme, and the
 * toasts/transfers surfaces. Anything a component needs to remember between
 * launches lives here.
 */
export const useUiStore = defineStore("ui", () => {
  const settings = ref<AppSettings | null>(null);
  const security = ref<SecurityStatus | null>(null);
  const layout = ref<LayoutSettings>({ ...LAYOUT_DEFAULTS });
  /**
   * Whether the preview column is hidden, stored with the rest of the layout so
   * it survives a restart like the panel widths do. Read-only by design: the
   * store owns every mutation.
   */
  const previewHidden = computed(() => layout.value.previewHidden);
  /**
   * The preview has the main area to itself. Deliberately not persisted: a
   * maximised preview is a momentary inspection, not a workspace layout.
   */
  const previewExpanded = ref(false);
  const transfersVisible = ref(false);
  const ready = ref(false);

  const theme = computed<Theme>(() => settings.value?.theme ?? "dark");
  const previewMaxBytes = computed(() => settings.value?.previewMaxBytes ?? 25 * 1024 * 1024);

  async function load() {
    settings.value = await api.getSettings();
    if (settings.value.layout) {
      layout.value = { ...LAYOUT_DEFAULTS, ...layout.value, ...settings.value.layout };
    }
    // Keep the pre-paint copy (theme-init.js) in step with the store in case
    // the config file was edited elsewhere.
    rememberTheme(theme.value);
    applyTheme();
    applyLayoutDom();
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

  /**
   * Follow the OS while the setting is "system" (SET-2). One listener for the
   * app lifetime: `applyTheme` is also called on every save, so attaching it
   * per call would stack duplicates.
   */
  let systemThemeListenerAttached = false;
  function watchSystemTheme() {
    if (systemThemeListenerAttached) return;
    const media = globalThis.matchMedia?.("(prefers-color-scheme: light)");
    if (!media?.addEventListener) return;
    systemThemeListenerAttached = true;
    media.addEventListener("change", () => {
      if (theme.value === "system") applyTheme();
    });
  }

  /**
   * Push the layout into the document.
   *
   * Widths and the panel's visibility are expressed as CSS custom properties and
   * attributes on the root element rather than as per-component inline styles:
   * the shell is a flex layout, and a value the browser reads from the root can
   * never disagree with the store it came from.
   */
  function applyLayoutDom() {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty("--sidebar-width", `${layout.value.sidebar}px`);
    root.style.setProperty("--preview-width", `${layout.value.preview}px`);
    root.toggleAttribute("data-sidebar-collapsed", layout.value.collapsed);
    root.toggleAttribute("data-preview-hidden", previewHidden.value);
    // Both forms, because `display:none` and the `hidden` attribute answer
    // different questions and the API surface reports the attribute.
    const aside = document.getElementById("preview");
    if (aside) aside.hidden = previewHidden.value;
  }

  function applyTheme() {
    const requested = theme.value;
    const resolved = requested === "system" ? (prefersLight() ? "light" : "dark") : requested;
    document.documentElement.dataset.theme = resolved;
    watchSystemTheme();
  }

  async function saveSettings(next: Partial<AppSettings>) {
    const merged: AppSettings = {
      previewMaxBytes: settings.value?.previewMaxBytes ?? 25 * 1024 * 1024,
      listPageLimit: settings.value?.listPageLimit ?? 20_000,
      downloadDir: settings.value?.downloadDir ?? null,
      askDownloadLocation: settings.value?.askDownloadLocation ?? false,
      showSystemObjects: settings.value?.showSystemObjects ?? false,
      theme: settings.value?.theme ?? "dark",
      layout: layout.value,
      ...next,
    };
    const saved = await api.updateSettings(merged);
    // Keep the local layout: it is newer than the value that came back, and the
    // response would otherwise undo a collapse or a resize that just happened.
    settings.value = { ...saved, layout: { ...layout.value } };
    rememberTheme(settings.value.theme);
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
    applyLayoutDom();
    persistLayout();
  }

  function setPreviewWidth(width: number) {
    const max = Math.max(PREVIEW_MIN + 20, Math.round(globalThis.innerWidth * 0.7));
    layout.value.preview = clamp(Math.round(width), PREVIEW_MIN, max);
    applyLayoutDom();
    persistLayout();
  }

  function resetSidebarWidth() {
    layout.value.sidebar = LAYOUT_DEFAULTS.sidebar;
    applyLayoutDom();
    persistLayout();
  }

  function resetPreviewWidth() {
    layout.value.preview = LAYOUT_DEFAULTS.preview;
    applyLayoutDom();
    persistLayout();
  }

  function toggleSidebar() {
    layout.value.collapsed = !layout.value.collapsed;
    applyLayoutDom();
    persistLayout();
  }

  function togglePreview() {
    layout.value.previewHidden = !layout.value.previewHidden;
    // A hidden panel has no expanded state to come back to.
    if (layout.value.previewHidden) collapsePreview();
    applyLayoutDom();
    persistLayout();
  }

  /**
   * Leave the full-width view.
   *
   * The objects store calls this whenever a preview is cleared or another
   * folder opens: the list is hidden while expanded, so a stale `true` would
   * strand the user on an empty panel with no way back except Close/Escape.
   */
  function collapsePreview() {
    previewExpanded.value = false;
  }

  function togglePreviewExpanded() {
    if (previewHidden.value) return;
    previewExpanded.value = !previewExpanded.value;
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
    previewExpanded,
    transfersVisible,
    ready,
    theme,
    previewMaxBytes,
    load,
    loadSecurity,
    applyTheme,
    applyLayoutDom,
    saveSettings,
    setSidebarWidth,
    setPreviewWidth,
    resetSidebarWidth,
    resetPreviewWidth,
    toggleSidebar,
    togglePreview,
    collapsePreview,
    togglePreviewExpanded,
    clampLayoutToWindow,
  };
});

/** Kept in one place so components do not invent their own default. */
export function defaultLayout(): LayoutSettings {
  return { ...LAYOUT_DEFAULTS };
}

export type { TransferResult };
