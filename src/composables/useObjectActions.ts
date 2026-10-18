import { computed } from "vue";
import { api, copyText, pickFiles, pickSavePath } from "@/lib/ipc";
import { s3Uri, humanSize, leafName } from "@/lib/format";
import { uploadScopeFor } from "@/lib/keys";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useToastsStore } from "@/stores/toasts";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { useDialogs } from "@/composables/useDialogs";
import CopyMoveDialog, { type CopyMoveResult } from "@/components/dialogs/CopyMoveDialog.vue";
import CreateFileDialog, { type CreateFileResult } from "@/components/dialogs/CreateFileDialog.vue";
import UploadConflictDialog, {
  type UploadConflictChoice,
} from "@/components/dialogs/UploadConflictDialog.vue";
import type { ObjectEntry, ProgressView, TransferResult, UploadPlanItem } from "@/types";

interface Options {
  /** Called after a mutation so the caller can refresh whatever it owns. */
  onChanged?: () => void;
}

/** How an upload treats keys that already exist. */
export interface UploadPolicy {
  overwrite: boolean;
  skipExisting?: boolean;
  /** The `uploadConflicts` answer, reused so Skip does not scan twice. */
  skipKeys?: string[];
}

/**
 * The connection/folder an upload was aimed at.
 *
 * Captured before the conflict scan or a dialog: those can outlive the folder on
 * screen, and a slow upload must still land where the user dropped it.
 */
export interface UploadTarget {
  connectionId: string;
  prefix: string;
  sessionConnectionId: string | null;
}

/** One copy/move request, kept whole so Retry can repeat it verbatim. */
interface CopyRequest {
  sourceConnectionId: string;
  destConnectionId: string;
  destPrefix: string;
  keys: string[];
  moveObjects: boolean;
}

/**
 * Every mutating operation the browser offers.
 *
 * Actions live here rather than in a component so the toolbar, the row buttons,
 * the context menu and the keyboard shortcuts all share one implementation — and
 * so the confirmation policy is applied in exactly one place.
 */
export function useObjectActions(options: Options = {}) {
  const objects = useObjectsStore();
  const connections = useConnectionsStore();
  const transfers = useProgressStore();
  const ui = useUiStore();
  const toasts = useToastsStore();
  const dialogs = useDialogs();

  const changed = () => options.onChanged?.() ?? objects.reload();

  const targets = computed<ObjectEntry[]>(() =>
    objects.selected.size ? objects.selectedEntries : [],
  );

  /** Mutations act on the selection, or on the focused row when it is empty. */
  const writeTargets = computed<ObjectEntry[]>(() => objects.deleteTargets);

  /**
   * Guard against a session that no longer matches the active connection.
   *
   * The listing is a snapshot of one connection; acting with the active
   * connection's id and this listing's keys can touch the wrong bucket when two
   * connections share key names. Aborting is the only safe answer, and the
   * active root is reloaded so the screen matches again.
   */
  function sessionMatchesActive(): boolean {
    const active = connections.active;
    if (!active) return false;
    if (objects.sessionConnectionId === active.id) return true;
    toasts.error(
      "The folder on screen belongs to a different connection. It was reloaded from the active connection.",
      "Connection changed",
    );
    void objects.reloadSession();
    return false;
  }

  /** Writes need a writable connection; say why instead of failing silently. */
  function canWrite(): boolean {
    if (connections.canWriteActive) return true;
    toasts.warn("This connection does not allow writes. Nothing was changed.", "Read-only connection");
    return false;
  }

  function captureTarget(connectionId?: string): UploadTarget | null {
    const connection = connections.active;
    if (!connection) return null;
    return {
      connectionId: connectionId ?? connection.id,
      prefix: objects.prefix,
      sessionConnectionId: objects.sessionConnectionId,
    };
  }

  /** Is the screen still showing the folder this operation started from? */
  function sameTarget(target: UploadTarget): boolean {
    return (
      objects.sessionConnectionId === target.sessionConnectionId &&
      objects.prefix === target.prefix
    );
  }

  // ---------------------------------------------------------------- downloads

  /**
   * Download one key, honouring the "ask where to save" setting.
   *
   * By key rather than by entry because the preview panel has a key and no row
   * (PRV-1). Every download path funnels through here so the policy cannot be
   * bypassed by one of them. A batch passes `destDir`: it chose the folder once,
   * so no per-file save dialog is allowed to appear (IO-2).
   */
  async function downloadKey(
    key: string,
    name?: string,
    { destDir, quiet = false }: { destDir?: string; quiet?: boolean } = {},
  ): Promise<TransferResult | null> {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive()) return null;

    // "Ask every time" means exactly that: pick the destination first, and treat
    // cancelling the dialog as cancelling the download. A batch destination has
    // already answered the question for every file.
    let destPath: string | null = null;
    if (!destDir && ui.settings?.askDownloadLocation) {
      destPath = await pickSavePath(name ?? leafName(key));
      if (!destPath) return null;
    }

    try {
      const result = await api.downloadObject({
        connectionId: connection.id,
        key,
        destPath,
        destDir: destDir ?? null,
      });
      transfers.start();
      return result;
    } catch (error) {
      // A batch reports one summary instead of one toast per file.
      if (!quiet) toasts.error((error as Error).message, "Download failed");
      return null;
    }
  }

  function downloadEntry(entry: ObjectEntry) {
    return downloadKey(entry.key, entry.name);
  }

  async function downloadSelection() {
    if (!sessionMatchesActive()) return;
    const entries = targets.value.filter((entry) => !entry.isFolder);
    if (!entries.length) {
      toasts.warn("Folders cannot be downloaded directly. Open the folder and select its files.", "Nothing to download");
      return;
    }

    // One directory dialog for the whole batch. Off means the stored download
    // folder, which the backend already applies when `destDir` is absent.
    let destDir: string | undefined;
    if (ui.settings?.askDownloadLocation) {
      try {
        const picked = await pickFiles({ directory: true, multiple: false });
        if (!picked.length) return;
        destDir = picked[0];
      } catch (error) {
        toasts.error((error as Error).message, "Cannot choose a download folder");
        return;
      }
    }

    const results = await Promise.all(
      entries.map((entry) => downloadKey(entry.key, entry.name, { destDir, quiet: true })),
    );
    const started = results.filter((result): result is TransferResult => result !== null);
    const failedToStart = entries.length - started.length;
    if (failedToStart) {
      toasts.error(
        `${failedToStart} of ${entries.length} downloads could not start.`,
        "Download failed",
      );
    }
    const ids = started.map((result) => result.id);
    if (!ids.length) return;

    // The batch settles in the background: one summary if something failed.
    void (async () => {
      const outcomes = await transfers.waitForAll(ids);
      const failed = outcomes.filter((outcome) => outcome.state === "failed");
      if (!failed.length) return;
      const first = failed[0].error ?? "the download failed";
      toasts.error(
        failed.length === ids.length
          ? first
          : `${failed.length} of ${ids.length} downloads failed. ${first}`,
        "Download failed",
      );
    })();
  }

  // ------------------------------------------------------------------ clipboard

  async function copyUri(entry: ObjectEntry) {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive()) return;
    const uri = s3Uri(connection.bucket, entry.key);
    if (await copyText(uri)) toasts.ok(`Copied ${uri}`);
    else toasts.error("The clipboard is not available.");
  }

  async function copySelectionUris() {
    const connection = connections.active;
    const entries = targets.value;
    if (!connection || !entries.length || !sessionMatchesActive()) return;
    const text = entries.map((entry) => s3Uri(connection.bucket, entry.key)).join("\n");
    if (!(await copyText(text))) {
      toasts.error("The clipboard is not available.");
      return;
    }
    toasts.ok(entries.length === 1 ? `Copied ${text}` : `Copied ${entries.length} S3 URIs`);
  }

  // ------------------------------------------------------------------- uploads

  async function upload() {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive() || !canWrite()) return;
    try {
      const paths = await pickFiles({ multiple: true });
      if (!paths.length) return;
      await queueUploads(paths);
    } catch (error) {
      toasts.error((error as Error).message, "Cannot upload");
    }
  }

  /** Pick one directory and upload its whole tree (IO-4). */
  async function uploadFolder() {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive() || !canWrite()) return;
    try {
      const paths = await pickFiles({ directory: true, multiple: false });
      if (!paths.length) return;
      await queueUploads(paths);
    } catch (error) {
      toasts.error((error as Error).message, "Cannot upload");
    }
  }

  /**
   * Shared upload entry point for the file picker, drag & drop and the folder
   * picker.
   *
   * Read-only and stale-session checks happen before any scanning or dialog, and
   * the destination is captured before the conflict scan so a slow check cannot
   * redirect the upload to a folder the user navigated to meanwhile.
   */
  async function queueUploads(paths: string[]) {
    const connection = connections.active;
    if (!connection || !paths.length || !sessionMatchesActive() || !canWrite()) return;

    const target = captureTarget(connection.id);
    if (!target) return;

    // With "Ask before overwriting" off the meaning is "replace silently" (IO-1).
    let policy: UploadPolicy = { overwrite: true };
    if (connection.security.confirmOverwrite) {
      let conflicts: string[];
      try {
        conflicts = await api.uploadConflicts({
          connectionId: target.connectionId,
          prefix: target.prefix,
          localPaths: paths,
          overwrite: false,
        });
      } catch (error) {
        // Fail closed: an unknown conflict state must not silently overwrite.
        toasts.error((error as Error).message, "Cannot check for existing files");
        return;
      }

      if (conflicts.length) {
        const choice = await dialogs.store.open<UploadConflictChoice | null>(
          UploadConflictDialog,
          (settle) => ({ conflicts, prefix: target.prefix, resolve: settle }),
          "narrow",
        );
        if (!choice) return;
        policy =
          choice === "skip"
            ? { overwrite: false, skipExisting: true, skipKeys: conflicts }
            : { overwrite: true };
      } else {
        // Nothing exists yet: a new key needs no overwrite and no second scan.
        policy = { overwrite: false };
      }
    }

    await uploadPaths(paths, policy, target);
  }

  /**
   * Start the transfers and report one summary when the batch settles.
   *
   * `target` is the captured destination; when it is omitted the current folder
   * is used after the usual guards.
   */
  async function uploadPaths(
    paths: string[],
    policy: UploadPolicy = { overwrite: false },
    target?: UploadTarget,
  ) {
    const connection = connections.active;
    const captured =
      target ??
      (connection
        ? {
            connectionId: connection.id,
            prefix: objects.prefix,
            sessionConnectionId: objects.sessionConnectionId,
          }
        : null);
    if (!captured || !paths.length) return;
    if (!target && (!connection || !sessionMatchesActive() || !canWrite())) return;

    try {
      const plan = await api.uploadFiles({
        connectionId: captured.connectionId,
        prefix: captured.prefix,
        localPaths: paths,
        overwrite: policy.overwrite,
        skipExisting: policy.skipExisting ?? false,
        skipKeys: policy.skipKeys ?? [],
      });
      transfers.start();
      if (!plan.length) return;

      // Every transfer can be repeated on its own: a partially failed folder
      // upload is the case Retry exists for (IO-3).
      registerUploadRetries(plan, captured);

      const outcomes = await transfers.waitForAll(plan.map((item) => item.id));
      reportUploadBatch(plan, outcomes, captured);

      if (sameTarget(captured)) await objects.reload();
    } catch (error) {
      toasts.error((error as Error).message, "Cannot upload");
    }
  }

  function registerUploadRetries(plan: UploadPlanItem[], target: UploadTarget) {
    for (const item of plan) {
      if (item.skipped) continue;
      transfers.registerRetry(item.id, () => retryUpload(item, target));
    }
  }

  /** Re-upload exactly one plan item to its key, replacing any existing key. */
  async function retryUpload(item: UploadPlanItem, target: UploadTarget) {
    try {
      const prefix = uploadScopeFor(item.key, leafName(item.localPath));
      const plan = await api.uploadFiles({
        connectionId: target.connectionId,
        prefix,
        localPaths: [item.localPath],
        overwrite: true,
      });
      transfers.start();
      if (!plan.length) {
        toasts.warn(`Nothing to upload for ${item.key}.`, "Retry skipped");
        return;
      }
      registerUploadRetries(plan, target);
      const outcomes = await transfers.waitForAll(plan.map((entry) => entry.id));
      reportUploadBatch(plan, outcomes, target);
      if (sameTarget(target)) await objects.reload();
    } catch (error) {
      toasts.error((error as Error).message, "Cannot retry the upload");
    }
  }

  /**
   * One toast for a finished upload batch (IO-7).
   *
   * Cancelled is not success: a cancelled batch reports what was cancelled,
   * never "N files uploaded". Failures name the first error and how many failed.
   */
  function reportUploadBatch(
    plan: UploadPlanItem[],
    outcomes: ProgressView[],
    target: UploadTarget,
  ) {
    const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
    const skipped = plan.filter((item) => item.skipped).length;
    let uploaded = 0;
    let failed = 0;
    let cancelled = 0;
    let firstError: string | null = null;
    for (const item of plan) {
      if (item.skipped) continue;
      const outcome = byId.get(item.id);
      if (outcome?.state === "done") uploaded += 1;
      else if (outcome?.state === "failed") {
        failed += 1;
        firstError ??= outcome.error ?? "the upload failed";
      } else if (outcome?.state === "cancelled") cancelled += 1;
    }

    const where = target.prefix || "/";
    const attempted = plan.length - skipped;
    if (failed) {
      const parts = [`${failed} of ${attempted} uploads failed. ${firstError}`];
      if (cancelled) parts.push(`${cancelled} cancelled.`);
      if (skipped) parts.push(`${skipped} skipped.`);
      toasts.error(parts.join(" "), "Upload failed");
      return;
    }
    if (cancelled) {
      const parts = [`${cancelled} of ${attempted} uploads were cancelled.`];
      if (uploaded) parts.push(`${uploaded} uploaded.`);
      if (skipped) parts.push(`${skipped} skipped.`);
      toasts.warn(parts.join(" "), "Upload cancelled");
      return;
    }

    const parts: string[] = [];
    if (uploaded) {
      parts.push(`${uploaded} file${uploaded === 1 ? "" : "s"} uploaded to ${where}.`);
    }
    if (skipped) {
      parts.push(`${skipped} skipped because ${skipped === 1 ? "it already exists" : "they already exist"}.`);
    }
    toasts.ok(parts.join(" ") || "Nothing was uploaded.");
  }

  // ------------------------------------------------------------------ creation

  async function createFolder() {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive() || !canWrite()) return;
    const name = await dialogs.prompt({
      title: "New folder",
      label: "Folder name",
      confirmLabel: "Create folder",
      hint: "S3 has no real folders — this creates a zero-byte marker key ending in “/”.",
      validate: (value) => (value.includes("/") ? "The name must not contain “/”." : null),
    });
    if (!name) return;
    try {
      await api.createFolder({ connectionId: connection.id, prefix: objects.prefix, name });
      toasts.ok(`Folder “${name}” created.`);
      await objects.reload();
    } catch (error) {
      toasts.error((error as Error).message, "Cannot create folder");
    }
  }

  async function createFile() {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive() || !canWrite()) return;
    const target = captureTarget(connection.id);
    if (!target) return;

    const result = await dialogs.store.open<CreateFileResult | null>(
      CreateFileDialog,
      (settle) => ({ prefix: target.prefix, resolve: settle }),
      "normal",
    );
    if (!result) return;

    try {
      // The backend returns the key, so the new object can be selected and
      // previewed even when the folder listing is filtered.
      const key = await api.createFile({
        connectionId: target.connectionId,
        prefix: target.prefix,
        name: result.name,
        content: result.content,
      });
      toasts.ok(`File “${result.name}” created.`);
      if (!sameTarget(target)) return;
      await objects.reload();
      selectAndPreview(key);
    } catch (error) {
      toasts.error((error as Error).message, "Cannot create file");
    }
  }

  /** After a reload, put the new object in the selection and the preview. */
  function selectAndPreview(key: string) {
    const entry = objects.entries.find((item) => item.key === key);
    if (!entry) return;
    objects.selectOnly(key);
    objects.focus(key);
    void objects.previewEntry(entry, { force: true });
  }

  // ------------------------------------------------------------------ deletion

  async function deleteSelection() {
    const connection = connections.active;
    const entries = writeTargets.value;
    if (!connection || !entries.length || !sessionMatchesActive() || !canWrite()) return;

    const folders = entries.filter((entry) => entry.isFolder);
    const files = entries.filter((entry) => !entry.isFolder);
    const details: string[] = [];
    if (folders.length) {
      details.push(
        `${folders.length} folder(s) will be deleted recursively, including everything inside them:`,
        ...folders.slice(0, 5).map((entry) => `  ${entry.key}`),
      );
    }
    if (files.length) {
      details.push(
        `${files.length} file(s), ${humanSize(files.reduce((sum, entry) => sum + entry.size, 0))}:`,
        ...files.slice(0, 5).map((entry) => `  ${entry.key}`),
      );
    }
    details.push("This cannot be undone.");

    if (connection.security.confirmDelete) {
      const confirmed = await dialogs.confirm({
        title: "Delete objects",
        message: `Permanently delete ${entries.length} selected item(s) from “${connection.name}”?`,
        details,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!confirmed) return;
    }

    const target = captureTarget(connection.id);
    if (!target) return;
    await executeDelete(
      target,
      entries.map((entry) => entry.key),
    );
  }

  /**
   * Delete `keys` and wait for the single progress entry.
   *
   * Retry repeats exactly this request; S3 deletes are idempotent, so a partial
   * failure can safely run again.
   */
  async function executeDelete(target: UploadTarget, keys: string[]) {
    try {
      const result = await api.deleteObjects({ connectionId: target.connectionId, keys });
      transfers.start();
      transfers.registerRetry(result.id, () => executeDelete(target, keys));
      // The request was accepted, so the rows are going away; a failed start
      // leaves the selection intact.
      objects.clearSelection();
      if (objects.previewKey && keys.some((key) => key === objects.previewKey)) {
        objects.clearPreview();
      }
      // A copy of the keys is deleted, but the screen may have moved on; the
      // listing is only refreshed when it still shows the same folder.
      const [outcome] = await transfers.waitForAll([result.id]);
      if (outcome.state === "failed") {
        toasts.error(outcome.error ?? "the delete failed", "Delete failed");
      } else if (outcome.state === "cancelled") {
        toasts.warn(
          "The delete was cancelled. Some objects may already be gone.",
          "Delete cancelled",
        );
      } else {
        toasts.ok(`${result.deleted} object(s) deleted.`);
      }
      if (sameTarget(target)) await objects.reload();
    } catch (error) {
      toasts.error((error as Error).message, "Cannot delete");
    }
  }

  // ----------------------------------------------------------------- copy/move

  async function transferSelection(moveObjects: boolean) {
    const entries = writeTargets.value;
    const source = connections.active;
    if (!entries.length || !source || !sessionMatchesActive() || !canWrite()) return;
    const target = captureTarget(source.id);
    if (!target) return;

    const result = await dialogs.store.open<CopyMoveResult | null>(
      CopyMoveDialog,
      (settle) => ({
        moveObjects,
        connections: connections.all,
        sourceConnectionId: source.id,
        sourcePrefix: objects.prefix,
        entries,
        resolve: settle,
      }),
    );
    if (!result) return;

    await executeCopy(
      {
        sourceConnectionId: source.id,
        destConnectionId: result.destinationConnectionId,
        destPrefix: result.destinationPrefix,
        keys: entries.map((entry) => entry.key),
        moveObjects,
      },
      target,
    );
  }

  /** Run one copy/move request and wait for its single progress entry. */
  async function executeCopy(request: CopyRequest, target: UploadTarget) {
    const title = request.moveObjects ? "Move failed" : "Copy failed";
    try {
      const outcome = await api.copyObjects(request);
      transfers.start();
      transfers.registerRetry(outcome.id, () => executeCopy(request, target));
      const [settled] = await transfers.waitForAll([outcome.id]);
      if (settled.state === "failed") {
        toasts.error(settled.error ?? "the operation failed", title);
      } else if (settled.state === "cancelled") {
        toasts.warn(
          `The ${request.moveObjects ? "move" : "copy"} was cancelled. Some objects may already have ${request.moveObjects ? "moved" : "been copied"}.`,
          request.moveObjects ? "Move cancelled" : "Copy cancelled",
        );
      } else {
        toasts.ok(
          `${outcome.copied} object(s).`,
          request.moveObjects ? "Moved" : "Copied",
        );
        if (sameTarget(target)) await objects.reload();
      }
    } catch (error) {
      toasts.error((error as Error).message, request.moveObjects ? "Cannot move" : "Cannot copy");
    }
  }

  return {
    targets,
    writeTargets,
    downloadKey,
    downloadEntry,
    downloadSelection,
    copyUri,
    copySelectionUris,
    upload,
    uploadFolder,
    queueUploads,
    uploadPaths,
    createFolder,
    createFile,
    deleteSelection,
    transferSelection,
    changed,
  };
}
