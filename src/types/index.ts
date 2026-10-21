/**
 * Wire types. These mirror the `Serialize` shapes in `src-tauri/src/model.rs`
 * and `store.rs` one-for-one, so a change on the Rust side surfaces here as a
 * type error rather than a runtime surprise.
 */

export type AddressingStyle = "virtual" | "path" | "auto";
export type SignatureVersion = "s3v4" | "v4" | "s3v2";
export type ChecksumCalculation = "whenSupported" | "whenRequired";
export type ChecksumValidation = "whenSupported" | "whenRequired";
export type Theme = "dark" | "light" | "system";

export type FileKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "text"
  | "markdown"
  | "code"
  | "json"
  | "csv"
  | "parquet"
  | "archive"
  | "binary"
  | "folder"
  | "unknown";

export type CapabilityLevel = "rw" | "ro" | "none";

export interface SecuritySettings {
  confirmDelete: boolean;
  confirmOverwrite: boolean;
  confirmBulk: boolean;
  detectPermissions: boolean;
  autoProbeOnConnect: boolean;
  readOnlyMode: boolean;
}

export interface Capabilities {
  canList: boolean;
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  probed: boolean;
  details?: string[];
}

export interface Connection {
  id: string;
  name: string;
  endpointUrl: string;
  region: string;
  accessKeyId: string;
  sessionTokenPresent: boolean;
  bucket: string;
  prefix: string;
  addressingStyle: AddressingStyle;
  signatureVersion: SignatureVersion;
  payloadSigningEnabled: boolean;
  requestChecksumCalculation: ChecksumCalculation;
  responseChecksumValidation: ChecksumValidation;
  security: SecuritySettings;
  lastUsedAt?: string;
  createdAt: string;
}

export interface ConnectionView {
  connection: Connection;
  capabilities?: Capabilities;
  hasSecret: boolean;
}

/** Payload accepted by `save_connection`; omitting the secret keeps the stored one. */
export interface ConnectionDraft {
  id?: string | null;
  name: string;
  endpointUrl: string;
  region?: string | null;
  accessKeyId: string;
  secretAccessKey?: string | null;
  sessionToken?: string | null;
  clearSessionToken?: boolean;
  bucket: string;
  prefix?: string | null;
  addressingStyle?: AddressingStyle;
  signatureVersion?: SignatureVersion;
  payloadSigningEnabled?: boolean;
  requestChecksumCalculation?: ChecksumCalculation;
  responseChecksumValidation?: ChecksumValidation;
  security?: SecuritySettings;
}

/** The connection fields the probe can be run against, saved or not. */
export interface ConnectionProbeDraft {
  endpointUrl: string;
  region?: string | null;
  accessKeyId: string;
  secretAccessKey?: string | null;
  sessionToken?: string | null;
  bucket: string;
  prefix?: string | null;
  addressingStyle?: AddressingStyle;
  signatureVersion?: SignatureVersion;
}

export interface ObjectEntry {
  key: string;
  name: string;
  isFolder: boolean;
  size: number;
  lastModified?: string | null;
  etag?: string | null;
  storageClass?: string | null;
  kind: FileKind;
}

export interface ListResult {
  prefix: string;
  entries: ObjectEntry[];
  truncated: boolean;
  warning?: string | null;
}

export interface TablePreview {
  columns: string[];
  rows: string[][];
  totalRows: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
}

export interface PreviewData {
  kind: FileKind;
  key: string;
  size: number;
  contentType: string;
  etag?: string | null;
  lastModified?: string | null;
  text?: string | null;
  base64?: string | null;
  table?: TablePreview | null;
  streamUrl: string;
  truncated: boolean;
  unavailableReason?: string | null;
}

export type ProgressState = "running" | "done" | "failed" | "cancelled";

export interface ProgressView {
  id: string;
  label: string;
  done: number;
  total?: number | null;
  state: ProgressState;
  error?: string | null;
  resultPath?: string | null;
}

export interface AppSettings {
  previewMaxBytes: number;
  listPageLimit: number;
  /** In-memory folder-listing cache budget in bytes; 0 disables it. */
  listingCacheMaxBytes: number;
  downloadDir?: string | null;
  /** Ask for a destination on every download instead of using `downloadDir`. */
  askDownloadLocation: boolean;
  showSystemObjects: boolean;
  theme: Theme;
  layout: LayoutSettings;
}

export interface LayoutSettings {
  sidebar: number;
  preview: number;
  collapsed: boolean;
  /** The preview column is hidden; persisted with the rest of the layout. */
  previewHidden: boolean;
}

export interface SecurityStatus {
  masterKeyInKeychain: boolean;
  configPath: string;
  configVersion: number;
  connectionCount: number;
  homeDownloadDir: string;
  theme: Theme;
}

export interface ProbeOutcome {
  capabilities: Capabilities;
  sampleKeys: string[];
  prefix: string;
  bucket: string;
  endpoint: string;
  signatureVersion: string;
  addressingStyle: string;
}

export interface TransferResult {
  id: string;
  path: string;
}

export interface UploadPlanItem {
  id: string;
  localPath: string;
  key: string;
  /** The key already exists and `skipExisting` was set; nothing was uploaded. */
  skipped: boolean;
}

// -------------------------------------------------------------- listing stream

export interface ListingPageEvent {
  requestId: string;
  prefix: string;
  entries: ObjectEntry[];
  total: number;
  done: boolean;
}

export interface ListingDoneEvent {
  requestId: string;
  prefix: string;
  total: number;
  files: number;
  truncated: boolean;
  warning?: string | null;
}

export interface ListingErrorEvent {
  /** The internal listing request id, used to drop stale events. */
  requestId: string;
  error: {
    kind: string;
    message: string;
    code?: string;
    hints?: string[];
    /** The S3 request id, when the backend captured one. */
    requestId?: string | null;
  };
}

/**
 * Structured detail behind the last listing failure. The list itself still
 * shows the plain message; this is what the error state expands into hints and
 * a request id.
 */
export interface ListErrorDetail {
  hints: string[];
  code: string | null;
  requestId: string | null;
}

// ---------------------------------------------------------------------- errors

export interface ErrorPayload {
  kind: string;
  message: string;
  code?: string | null;
  requestId?: string | null;
  status?: number | null;
  hints?: string[];
}

// ------------------------------------------------------------------- transfers

export interface DownloadInput {
  connectionId: string;
  key: string;
  destPath?: string | null;
  /** Directory for a batch download. `destPath` wins when both are set. */
  destDir?: string | null;
}

export interface DownloadFolderInput {
  connectionId: string;
  /** Folder key, e.g. `photos/`. A trailing slash is added when missing. */
  prefix: string;
  /** Parent directory the folder is created in; the configured one when absent. */
  destDir?: string | null;
}

export interface UploadInput {
  connectionId: string;
  prefix: string;
  localPaths: string[];
  overwrite: boolean;
  /** Leave keys that already exist untouched instead of uploading them. */
  skipExisting?: boolean;
  /**
   * Keys the caller already knows exist (the `uploadConflicts` answer). With
   * `skipExisting` they are skipped without a second HEAD scan.
   */
  skipKeys?: string[];
}

export interface DeleteInput {
  connectionId: string;
  keys: string[];
}

export interface CopyInput {
  sourceConnectionId: string;
  destConnectionId: string;
  keys: string[];
  destPrefix: string;
  moveObjects: boolean;
}
