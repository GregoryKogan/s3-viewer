/**
 * Typed bridge to the Rust backend.
 *
 * The app is built with `withGlobalTauri`, so every plugin reaches the page
 * through `window.__TAURI__` and nothing here needs a dynamic import.
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
  DownloadFolderInput,
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
  dialog?: {
    open?: (options: Record<string, unknown>) => Promise<unknown>;
    save?: (options: Record<string, unknown>) => Promise<unknown>;
  };
  event?: {
    listen?: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
  };
  clipboardManager?: { writeText?: (text: string) => Promise<void> };
}

const tauri = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__;

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
    // Rust now serializes camelCase, but older payloads and hand-built objects
    // may still carry `request_id`; accept both rather than losing the id.
    const payload = raw as Partial<ErrorPayload> & { request_id?: string | null };
    return new ApiError({
      kind: payload.kind,
      message: payload.message,
      code: payload.code,
      requestId: payload.requestId ?? payload.request_id ?? null,
      status: payload.status,
      hints: payload.hints,
    });
  }
  return new ApiError(typeof raw === "string" ? raw : JSON.stringify(raw));
}

/**
 * Whether a failure means "this key does not exist".
 *
 * The S3 client reports a missing key as `{ kind: "s3", code: "NoSuchKey" }`
 * with no HTTP status, so the code list must mirror the backend's `is_missing`
 * (`src-tauri/src/commands.rs`). Probes that ask "is this address an object or
 * a folder?" may legitimately fall back on a 404. Any other failure (denied,
 * network, bad credentials) must be reported as itself instead of being
 * mislabelled "Nothing found".
 */
export function isNotFound(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.kind === "notFound" || error.status === 404) return true;
  const code = error.code?.trim().toLowerCase() ?? "";
  return code === "404" || code === "http404" || code === "notfound" || code.startsWith("nosuch");
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const call = tauri?.core?.invoke;
  if (!call) {
    throw new ApiError({
      message:
        "Tauri IPC bridge is unavailable. This UI must run inside the app window (or a host that injects window.__TAURI__).",
    });
  }
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
  const open = tauri?.dialog?.open;
  if (!open) throw new ApiError("File dialog is unavailable outside the app window.");
  return normalizePicked(await open({ multiple, directory, title }));
}

/** Native save dialog; `null` when cancelled. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  const save = tauri?.dialog?.save;
  if (!save) return null;
  const result = await save({ defaultPath: defaultName });
  return result ? String(result) : null;
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const register = tauri?.event?.listen;
  return register ? register<T>(event, (message) => handler(message.payload)) : () => {};
}

// ------------------------------------------------------------------ commands

export const api = {
  // settings and security
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (settings: AppSettings) => invoke<AppSettings>("update_settings", { settings }),
  securityStatus: () => invoke<SecurityStatus>("security_status"),

  // connections
  listConnections: () => invoke<ConnectionView[]>("list_connections"),
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
  /** Download a whole prefix into a new directory below `destDir`. */
  downloadFolder: (input: DownloadFolderInput) =>
    invoke<TransferResult>("download_folder", { input }),
  uploadFiles: (input: UploadInput) => invoke<UploadPlanItem[]>("upload_files", { input }),
  /** Keys from the same upload plan that already exist. Uploads nothing. */
  uploadConflicts: (input: UploadInput) => invoke<string[]>("upload_conflicts", { input }),
  /** Cancel a transfer that is still running; finished ids are an error. */
  cancelTransfer: (id: string) => invoke<void>("cancel_transfer", { id }),
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
  /** Open an http(s) link from rendered Markdown in the system browser. */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  /** Read a text file the user picked in the native dialog. */
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
};

/** Copy text through the native clipboard, falling back to the browser API. */
export async function copyText(text: string): Promise<boolean> {
  const writeText = tauri?.clipboardManager?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText(text);
      return true;
    } catch {
      /* fall through to the browser API */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
