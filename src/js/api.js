// Bridge to the Rust backend.
//
// The app is built with `withGlobalTauri`, so `window.__TAURI__` is present and
// no bundler is needed for Tauri itself. `@tauri-apps/api` is used only for the
// dialog plugin, and only when it is installed.

const globalTauri = globalThis.__TAURI__ ?? null;

/**
 * Normalised, user-facing error object.
 * Rust returns `{ kind, message, code, requestId, status, hints }`.
 */
export class ApiError extends Error {
  constructor(payload) {
    const message = payload?.message || String(payload) || "Unknown error";
    super(message);
    this.name = "ApiError";
    this.kind = payload?.kind ?? "other";
    this.code = payload?.code ?? null;
    this.requestId = payload?.requestId ?? null;
    this.status = payload?.status ?? null;
    this.hints = payload?.hints ?? [];
  }

  /** One-line summary for toasts. */
  get short() {
    if (this.code) return `${this.code}: ${this.message}`;
    return this.message;
  }
}

function toError(raw) {
  if (raw instanceof ApiError) return raw;
  if (raw && typeof raw === "object" && ("message" in raw || "kind" in raw)) {
    return new ApiError(raw);
  }
  return new ApiError({ kind: "other", message: typeof raw === "string" ? raw : JSON.stringify(raw) });
}

async function getInvoke() {
  if (globalTauri?.core?.invoke) return globalTauri.core.invoke;
  if (globalTauri?.invoke) return globalTauri.invoke;
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke;
  } catch {
    return null;
  }
}

let invokeFn = null;

/** Call a Rust command. Throws {@link ApiError}. */
export async function invoke(command, args = {}) {
  if (!invokeFn) {
    invokeFn = await getInvoke();
    if (!invokeFn) {
      throw new ApiError({
        kind: "other",
        message:
          "Tauri IPC bridge is unavailable. This UI must run inside the app window (or a host that injects window.__TAURI__).",
      });
    }
  }
  try {
    return await invokeFn(command, args);
  } catch (raw) {
    throw toError(raw);
  }
}

/** True when the native file dialog is reachable. */
export async function hasDialog() {
  if (globalTauri?.dialog?.open) return true;
  try {
    await import("@tauri-apps/plugin-dialog");
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the native file picker. Returns absolute paths (or [] when cancelled).
 */
export async function pickFiles({ multiple = true, directory = false } = {}) {
  if (globalTauri?.dialog?.open) {
    const selected = await globalTauri.dialog.open({ multiple, directory, title: directory ? "Choose a folder" : "Choose files" });
    return normalizePick(selected);
  }
  try {
    const mod = await import("@tauri-apps/plugin-dialog");
    const selected = await mod.open({ multiple, directory });
    return normalizePick(selected);
  } catch (err) {
    throw new ApiError({
      kind: "other",
      message: `File dialog is unavailable: ${err?.message ?? err}`,
    });
  }
}

function normalizePick(selected) {
  if (!selected) return [];
  if (Array.isArray(selected)) return selected.slice();
  return [selected];
}

export async function pickSavePath(defaultName) {
  if (globalTauri?.dialog?.save) {
    return globalTauri.dialog.save({ defaultPath: defaultName });
  }
  try {
    const mod = await import("@tauri-apps/plugin-dialog");
    return mod.save({ defaultPath: defaultName });
  } catch {
    return null;
  }
}

/** Event subscription (used for OS drag & drop). Falls back to a no-op. */
export async function listen(event, handler) {
  if (globalTauri?.event?.listen) return globalTauri.event.listen(event, handler);
  try {
    const mod = await import("@tauri-apps/api/event");
    return mod.listen(event, handler);
  } catch {
    return () => {};
  }
}

export const api = {
  // settings & security
  getSettings: () => invoke("get_settings"),
  updateSettings: (settings) => invoke("update_settings", { settings }),
  securityStatus: () => invoke("security_status"),

  // connections
  listConnections: () => invoke("list_connections"),
  getConnection: (id) => invoke("get_connection", { id }),
  saveConnection: (input) => invoke("save_connection", { input }),
  deleteConnection: (id) => invoke("delete_connection", { id }),
  duplicateConnection: (id) => invoke("duplicate_connection", { id }),
  testConnection: (input) => invoke("test_connection", { input }),
  detectCapabilities: (id) => invoke("detect_capabilities", { id }),

  // browsing
  listObjects: (input) => invoke("list_objects", { input }),
  getPreview: (input) => invoke("get_preview", { input }),
  objectMeta: (connectionId, key) => invoke("object_meta", { connectionId, key }),

  // transfers
  downloadObject: (input) => invoke("download_object", { input }),
  uploadFiles: (input) => invoke("upload_files", { input }),
  saveTextObject: (input) => invoke("save_text_object", { input }),
  transferProgress: () => invoke("transfer_progress"),
  clearTransfers: () => invoke("clear_transfers"),

  // mutation
  createFolder: (input) => invoke("create_folder", { input }),
  createFile: (input) => invoke("create_file", { input }),
  deleteObjects: (input) => invoke("delete_objects", { input }),
  copyObjects: (input) => invoke("copy_objects", { input }),

  // filesystem
  revealInFileManager: (path) => invoke("reveal_in_file_manager", { path }),
  openPath: (path) => invoke("open_path", { path }),
  defaultUploadDir: () => invoke("default_upload_dir"),
  ping: () => invoke("ping"),
};
