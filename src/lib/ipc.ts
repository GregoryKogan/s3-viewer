/**
 * Typed bridge to the Rust backend.
 *
 * The app is built with `withGlobalTauri`, so `window.__TAURI__` is available and
 * the core `invoke` needs no bundler. The dialog plugin is imported lazily and
 * only when present, which keeps the window usable in a plain browser during
 * development.
 */

import type {
  AppSettings,
  Capabilities,
  Connection,
  ConnectionDraft,
  ConnectionProbeDraft,
  ConnectionView,
  CopyInput,
  DeleteInput,
  DownloadInput,
  ErrorPayload,
  ListResult,
  PreviewData,
  ProbeOutcome,
  ProgressView,
  SecurityStatus,
  TransferResult,
  UploadInput,
  UploadPlanItem,
} from "@/types";

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriGlobal {
  core?: { invoke?: InvokeFn };
  invoke?: InvokeFn;
  dialog?: {
    open?: (options: Record<string, unknown>) => Promise<unknown>;
    save?: (options: Record<string, unknown>) => Promise<unknown>;
  };
  event?: {
    listen?: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
  };
}

const globalTauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;

/** A failure from the backend, keeping the structured detail the UI shows. */
export class ApiError extends Error {
  readonly kind: string;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly status: number | null;
  readonly hints: string[];

  constructor(payload: Partial<ErrorPayload> | string) {
    const source = typeof payload === "string" ? { message: payload } : payload;
    super(source.message || "Unknown error");
    this.name = "ApiError";
    this.kind = source.kind ?? "other";
    this.code = source.code ?? null;
    this.requestId = source.requestId ?? null;
    this.status = source.status ?? null;
    this.hints = source.hints ?? [];
  }

  /** One-line summary for toasts. */
  get short(): string {
    return this.code ? `${this.code}: ${this.message}` : this.message;
  }
}

function toError(raw: unknown): ApiError {
  if (raw instanceof ApiError) return raw;
  if (raw && typeof raw === "object" && ("message" in raw || "kind" in raw)) {
    return new ApiError(raw as Partial<ErrorPayload>);
  }
  return new ApiError(typeof raw === "string" ? raw : JSON.stringify(raw));
}

let cachedInvoke: InvokeFn | null = null;

async function resolveInvoke(): Promise<InvokeFn> {
  if (cachedInvoke) return cachedInvoke;
  const direct = globalTauri?.core?.invoke ?? globalTauri?.invoke;
  if (direct) {
    cachedInvoke = direct;
    return direct;
  }
  try {
    const module = (await import("@tauri-apps/api/core")) as { invoke: InvokeFn };
    cachedInvoke = module.invoke;
    return module.invoke;
  } catch {
    throw new ApiError({
      message:
        "Tauri IPC bridge is unavailable. This UI must run inside the app window (or a host that injects window.__TAURI__).",
    });
  }
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const call = await resolveInvoke();
  try {
    return await call<T>(command, args);
  } catch (raw) {
    throw toError(raw);
  }
}

// ------------------------------------------------------------------- dialogs

function normalizePicked(selected: unknown): string[] {
  if (!selected) return [];
  return Array.isArray(selected) ? selected.map(String) : [String(selected)];
}

/** Native file picker. Returns absolute paths, empty when cancelled. */
export async function pickFiles({
  multiple = true,
  directory = false,
}: { multiple?: boolean; directory?: boolean } = {}): Promise<string[]> {
  const title = directory ? "Choose a folder" : "Choose files";
  if (globalTauri?.dialog?.open) {
    return normalizePicked(await globalTauri.dialog.open({ multiple, directory, title }));
  }
  try {
    const module = (await import("@tauri-apps/plugin-dialog")) as {
      open: (options: Record<string, unknown>) => Promise<unknown>;
    };
    return normalizePicked(await module.open({ multiple, directory, title }));
  } catch (error) {
    throw new ApiError(`File dialog is unavailable: ${(error as Error)?.message ?? error}`);
  }
}

/** Native save dialog; `null` when cancelled. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (globalTauri?.dialog?.save) {
    const result = await globalTauri.dialog.save({ defaultPath: defaultName });
    return result ? String(result) : null;
  }
  try {
    const module = (await import("@tauri-apps/plugin-dialog")) as {
      save: (options: Record<string, unknown>) => Promise<unknown>;
    };
    const result = await module.save({ defaultPath: defaultName });
    return result ? String(result) : null;
  } catch {
    return null;
  }
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const register = globalTauri?.event?.listen;
  if (register) {
    return register<T>(event, (message) => handler(message.payload));
  }
  try {
    const module = (await import("@tauri-apps/api/event")) as {
      listen: <P>(name: string, cb: (event: { payload: P }) => void) => Promise<() => void>;
    };
    return await module.listen<T>(event, (message) => handler(message.payload));
  } catch {
    return () => {};
  }
}

// ------------------------------------------------------------------ commands

export const api = {
  // settings and security
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (settings: AppSettings) => invoke<AppSettings>("update_settings", { settings }),
  securityStatus: () => invoke<SecurityStatus>("security_status"),

  // connections
  listConnections: () => invoke<ConnectionView[]>("list_connections"),
  getConnection: (id: string) => invoke<ConnectionView>("get_connection", { id }),
  saveConnection: (input: ConnectionDraft) => invoke<Connection>("save_connection", { input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  duplicateConnection: (id: string) => invoke<Connection>("duplicate_connection", { id }),
  testConnection: (input: {
    id?: string | null;
    connection?: ConnectionProbeDraft | null;
    detectWrite?: boolean;
  }) => invoke<ProbeOutcome>("test_connection", { input }),
  detectCapabilities: (id: string) => invoke<Capabilities>("detect_capabilities", { id }),

  // browsing
  listObjects: (input: { connectionId: string; prefix?: string | null }) =>
    invoke<ListResult>("list_objects", { input }),
  listObjectsStream: (input: { connectionId: string; prefix?: string | null; requestId: string }) =>
    invoke<void>("list_objects_stream", { input }),
  getPreview: (input: { connectionId: string; key: string; kindHint?: string | null }) =>
    invoke<PreviewData>("get_preview", { input }),
  objectMeta: (connectionId: string, key: string) =>
    invoke<{ size: number; contentType: string }>("object_meta", { connectionId, key }),

  // transfers
  downloadObject: (input: DownloadInput) => invoke<TransferResult>("download_object", { input }),
  uploadFiles: (input: UploadInput) => invoke<UploadPlanItem[]>("upload_files", { input }),
  saveTextObject: (input: {
    connectionId: string;
    key: string;
    content: string;
    contentType?: string | null;
  }) => invoke<void>("save_text_object", { input }),
  transferProgress: () => invoke<ProgressView[]>("transfer_progress"),
  clearTransfers: () => invoke<number>("clear_transfers"),

  // mutation
  createFolder: (input: { connectionId: string; prefix: string; name: string }) =>
    invoke<string>("create_folder", { input }),
  createFile: (input: { connectionId: string; prefix: string; name: string; content?: string }) =>
    invoke<string>("create_file", { input }),
  deleteObjects: (input: DeleteInput) =>
    invoke<{ deleted: number; summary: string; id: string }>("delete_objects", { input }),
  copyObjects: (input: CopyInput) =>
    invoke<{ copied: number; summary: string; id: string }>("copy_objects", { input }),

  // filesystem
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  defaultUploadDir: () => invoke<string>("default_upload_dir"),
  ping: () => invoke<string>("ping"),
};

/** Copy text through the native clipboard, falling back to the browser API. */
export async function copyText(text: string): Promise<boolean> {
  const native = (globalThis as { __TAURI__?: { clipboardManager?: { writeText?: (t: string) => Promise<void> } } })
    .__TAURI__?.clipboardManager?.writeText;
  if (typeof native === "function") {
    try {
      await native(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const module = (await import("@tauri-apps/plugin-clipboard-manager")) as {
      writeText: (value: string) => Promise<void>;
    };
    await module.writeText(text);
    return true;
  } catch {
    /* fall through to the browser APIs */
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.focus();
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
