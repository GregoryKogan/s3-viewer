import { computed } from "vue";
import { api, copyText, pickFiles, pickSavePath } from "@/lib/ipc";
import { s3Uri, humanSize, leafName, parentDirOf } from "@/lib/format";
import { uploadScopeFor } from "@/lib/keys";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useToastsStore } from "@/stores/toasts";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { useDialogsStore } from "@/stores/dialogs";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PromptDialog from "@/components/ui/PromptDialog.vue";
import CopyMoveDialog, { type CopyMoveResult } from "@/components/dialogs/CopyMoveDialog.vue";
import CreateFileDialog, { type CreateFileResult } from "@/components/dialogs/CreateFileDialog.vue";
import UploadConflictDialog, {
  type UploadConflictChoice,
} from "@/components/dialogs/UploadConflictDialog.vue";
import type {
  CopyOutcome,
  DeleteOutcome,
  ObjectEntry,
  ProgressView,
  TransferResult,
  UploadPlanItem,
} from "@/types";

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

/** One operation's transfer, as the shared runner sees it. */
interface TransferJob<R> {
  /** The backend call that creates the progress entry; a throw means nothing started. */
  start: () => Promise<R>;
  /** Arm Retry: once for the request, or once per entry an upload plan created. */
  retry?: (result: R) => void;
  /** Runs after the backend accepted the request — only delete drops rows here. */
  accepted?: (result: R) => void;
  /** Wait for the entry and report it; omitted when the transfers panel owns it. */
  settle?: (result: R) => void | Promise<void>;
  /** Leave the settle running: Retry resolves once the replacement exists. */
  background?: boolean;
  /** Toast title when the whole flow throws; omit so Retry surfaces the failure. */
  failure?: string;
}

/**
 * Every mutating operation the browser offers.
 *
 * Actions live here rather than in a component so the toolbar, the row buttons,
 * the context menu and the keyboard shortcuts all share one implementation — and
 * so the confirmation policy is applied in exactly one place.
 */
export function useObjectActions() {
  const objects = useObjectsStore();
  const connections = useConnectionsStore();
  const transfers = useProgressStore();
  const ui = useUiStore();
  const toasts = useToastsStore();
  const dialogs = useDialogsStore();

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

  // ---------------------------------------------------------------- transfers

  async function runTransfer<R>(job: TransferJob<R> & { failure: string }): Promise<R | null>;
  async function runTransfer<R>(job: TransferJob<R>): Promise<R>;
  /**
   * Start one transfer and run the lifecycle every operation shares: start the
   * progress poll, arm Retry, run the accepted side effects, then settle.
   *
   * The operation still owns its request, its Retry target and its summary; this
   * keeps their order — and the "toast, or let Retry see it" failure rule — in
   * one place.
   */
  async function runTransfer<R>(job: TransferJob<R>): Promise<R | null> {
    try {
      const result = await job.start();
      transfers.start();
      job.retry?.(result);
      job.accepted?.(result);
      if (job.settle) {
        if (job.background) void job.settle(result);
        else await job.settle(result);
      }
      return result;
    } catch (error) {
      if (!job.failure) throw error;
      toasts.apiError(error, job.failure);
      return null;
    }
  }

  // ---------------------------------------------------------------- downloads

  /**
   * Start one download and register a retry for its progress id.
   *
   * The captured destination is part of the retry, so a cancelled download can
   * be repeated without asking for a path again. The backend has created the
   * progress entry before this resolves; a thrown error means nothing started.
   */
  async function startDownload(
    connectionId: string,
    key: string,
    { destPath = null, destDir = null }: { destPath?: string | null; destDir?: string | null } = {},
  ): Promise<TransferResult> {
    // Cancellation is cooperative: a cancelled task can still be streaming and
    // later remove its file. Reusing an explicit `destPath` on retry would let
    // the old task delete the retry's bytes, so retry into the parent directory
    // and let the backend reserve a fresh unique name. A batch already passes a
    // directory and is safe for the same reason.
    const retryTarget = destPath
      ? { destPath: null, destDir: parentDirOf(destPath) || null }
      : { destPath: null, destDir };
    return runTransfer({
      start: () => api.downloadObject({ connectionId, key, destPath, destDir }),
      retry: (result) =>
        transfers.registerRetry(result.id, async () => {
          await startDownload(connectionId, key, retryTarget);
        }),
    });
  }

  /**
   * Download one key, honouring the "ask where to save" setting.
   *
   * By key rather than by entry because the preview panel has a key and no row
   * (PRV-1). Every single-object path funnels through here so the policy cannot
   * be bypassed by one of them. A multi-file batch passes `destDir`: it chose
   * the folder once, so no per-file save dialog is allowed to appear (IO-2).
   */
  async function downloadKey(
    key: string,
    name?: string,
    { destDir }: { destDir?: string } = {},
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
      return await startDownload(connection.id, key, { destPath, destDir: destDir ?? null });
    } catch (error) {
      toasts.apiError(error, "Download failed");
      return null;
    }
  }

  function downloadEntry(entry: ObjectEntry) {
    return downloadKey(entry.key, entry.name);
  }

  /**
   * Start one folder download. It gets no Retry: repeating it would download the
   * same tree a second time under `folder (1)`, which is not what "retry the
   * failed transfer" means. The whole folder is one progress entry.
   */
  async function startFolderDownload(
    connectionId: string,
    key: string,
    destDir: string | null,
  ): Promise<TransferResult> {
    return runTransfer({
      start: () => api.downloadFolder({ connectionId, prefix: key, destDir }),
    });
  }

  /**
   * Download one folder, honouring the "ask where to save" setting.
   *
   * `destDir` is the parent directory the folder is created in; without it the
   * backend uses the configured download directory. Used by the preview's folder
   * card and by a single-folder selection, so the policy lives here and not in a
   * component.
   */
  async function downloadFolderKey(
    key: string,
    { destDir }: { destDir?: string | null } = {},
  ): Promise<TransferResult | null> {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive()) return null;

    let parent = destDir ?? null;
    if (!destDir && ui.settings?.askDownloadLocation) {
      try {
        const picked = await pickFiles({ directory: true, multiple: false });
        if (!picked.length) return null;
        parent = picked[0];
      } catch (error) {
        toasts.apiError(error, "Cannot choose a download folder");
        return null;
      }
    }

    try {
      return await startFolderDownload(connection.id, key, parent);
    } catch (error) {
      toasts.apiError(error, "Download failed");
      return null;
    }
  }

  async function downloadSelection() {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive()) return;
    // Selection, or the cursor row when nothing is selected — the same set
    // Delete and the context menu act on.
    const entries = writeTargets.value;
    if (!entries.length) return;

    // One item keeps the ordinary "ask where to save" policy: a directory
    // dialog for a single object is a needless extra step (MINOR 1).
    if (entries.length === 1) {
      const entry = entries[0];
      if (entry.isFolder) await downloadFolderKey(entry.key);
      else await downloadEntry(entry);
      return;
    }

    // One directory dialog for the whole batch. Off means the stored download
    // folder, which the backend already applies when `destDir` is absent. It is
    // the parent folder for both: files land in it, each folder becomes a
    // subdirectory of it.
    let destDir: string | null = null;
    if (ui.settings?.askDownloadLocation) {
      try {
        const picked = await pickFiles({ directory: true, multiple: false });
        if (!picked.length) return;
        destDir = picked[0];
      } catch (error) {
        toasts.apiError(error, "Cannot choose a download folder");
        return;
      }
    }

    // Start every item; a start failure is a batch failure, not one toast per
    // item. The first error and the counts are reported once the started
    // transfers have also settled (MINOR 2).
    const started: TransferResult[] = [];
    const startErrors: string[] = [];
    for (const entry of entries) {
      try {
        started.push(
          entry.isFolder
            ? await startFolderDownload(connection.id, entry.key, destDir)
            : await startDownload(connection.id, entry.key, { destDir }),
        );
      } catch (error) {
        startErrors.push((error as Error).message);
      }
    }

    const total = entries.length;
    if (!started.length) {
      if (startErrors.length) {
        toasts.error(
          `${startErrors.length} of ${total} downloads failed. ${startErrors[0]}`,
          "Download failed",
        );
      }
      return;
    }

    void (async () => {
      const outcomes = await transfers.waitForAll(started.map((result) => result.id));
      const lateFailed = outcomes.filter((outcome) => outcome.state === "failed");
      const failed = startErrors.length + lateFailed.length;
      if (!failed) return;
      const first = startErrors[0] ?? lateFailed[0]?.error ?? "the download failed";
      toasts.error(`${failed} of ${total} downloads failed. ${first}`, "Download failed");
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
    const entries = writeTargets.value;
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
      toasts.apiError(error, "Cannot upload");
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
      toasts.apiError(error, "Cannot upload");
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
        const message = (error as Error).message;
        const actionable = /too many files to check/i.test(message)
          ? `${message} Turn off “Ask before overwriting” for this connection to replace without the pre-check, or upload a smaller folder.`
          : message;
        toasts.apiError(error, "Cannot check for existing files", actionable);
        return;
      }

      if (conflicts.length) {
        const choice = await dialogs.open<UploadConflictChoice | null>(
          UploadConflictDialog,
          (settle) => ({ conflicts, prefix: target.prefix, resolve: settle }),
          "narrow",
          { dismissible: false },
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

    await runTransfer({
      start: () =>
        api.uploadFiles({
          connectionId: captured.connectionId,
          prefix: captured.prefix,
          localPaths: paths,
          overwrite: policy.overwrite,
          skipExisting: policy.skipExisting ?? false,
          skipKeys: policy.skipKeys ?? [],
        }),
      // Every transfer can be repeated on its own: a partially failed folder
      // upload is the case Retry exists for (IO-3).
      retry: (plan) => registerUploadRetries(plan, captured),
      // An empty plan started nothing, so there is nothing to report or reload.
      settle: (plan) => (plan.length ? settleUpload(plan, captured) : undefined),
      failure: "Cannot upload",
    });
  }

  /** Wait for a started upload and report its one summary. */
  async function settleUpload(plan: UploadPlanItem[], target: UploadTarget) {
    const outcomes = await transfers.waitForAll(plan.map((item) => item.id));
    reportUploadBatch(plan, outcomes, target);
    if (sameTarget(target)) await objects.reload();
  }

  function registerUploadRetries(plan: UploadPlanItem[], target: UploadTarget) {
    for (const item of plan) {
      if (item.skipped) continue;
      transfers.registerRetry(item.id, () => retryUpload(item, target));
    }
  }

  /**
   * Start a retry for exactly one plan item.
   *
   * This resolves once the replacement transfers exist and rejects when nothing
   * could start, so the progress store only drops the old Retry affordance on a
   * successful start. The wait and the summary continue in the background.
   */
  async function retryUpload(item: UploadPlanItem, target: UploadTarget) {
    const prefix = uploadScopeFor(item.key, leafName(item.localPath));
    const plan = await runTransfer({
      start: () =>
        api.uploadFiles({
          connectionId: target.connectionId,
          prefix,
          localPaths: [item.localPath],
          overwrite: true,
        }),
      retry: (started) => registerUploadRetries(started, target),
      settle: (started) => (started.length ? settleUpload(started, target) : undefined),
      background: true,
    });
    // Nothing was left to upload: reject so the progress store keeps the old
    // Retry affordance instead of dropping it for a transfer that never started.
    if (!plan.length) throw new Error(`Nothing to upload for ${item.key}.`);
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
    const name = await dialogs.open<string | null>(
      PromptDialog,
      (settle) => ({
        title: "New folder",
        label: "Folder name",
        confirmLabel: "Create folder",
        hint: "S3 has no real folders — this creates a zero-byte marker key ending in “/”.",
        validate: (value: string) => (value.includes("/") ? "The name must not contain “/”." : null),
        resolve: settle,
      }),
      "narrow",
    );
    if (!name) return;
    try {
      await api.createFolder({ connectionId: connection.id, prefix: objects.prefix, name });
      toasts.ok(`Folder “${name}” created.`);
      await objects.reload();
    } catch (error) {
      toasts.apiError(error, "Cannot create folder");
    }
  }

  async function createFile() {
    const connection = connections.active;
    if (!connection || !sessionMatchesActive() || !canWrite()) return;
    const target = captureTarget(connection.id);
    if (!target) return;

    const result = await dialogs.open<CreateFileResult | null>(
      CreateFileDialog,
      (settle) => ({ prefix: target.prefix, resolve: settle }),
      "normal",
      { dismissible: false },
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
      toasts.apiError(error, "Cannot create file");
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
      const confirmed = await dialogs.open<boolean>(
        ConfirmDialog,
        (settle) => ({
          title: "Delete objects",
          message: `Permanently delete ${entries.length} selected item(s) from “${connection.name}”?`,
          details,
          confirmLabel: "Delete",
          danger: true,
          resolve: settle,
        }),
        "narrow",
      );
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
   * Drop the rows a delete is removing, once the request was accepted — a failed
   * start leaves the selection intact.
   */
  function deleteRows(keys: string[]) {
    objects.clearSelection();
    if (objects.previewKey && keys.some((key) => key === objects.previewKey)) {
      objects.clearPreview();
    }
  }

  /** One delete request: start, retry and settle, shared by the run and its Retry. */
  function deleteJob(target: UploadTarget, keys: string[]): TransferJob<DeleteOutcome> {
    return {
      start: () => api.deleteObjects({ connectionId: target.connectionId, keys }),
      retry: (result) => transfers.registerRetry(result.id, () => retryDelete(target, keys)),
      accepted: () => deleteRows(keys),
      settle: (result) => settleDelete(result, target),
    };
  }

  /** Retry start: resolves once the replacement exists, settles in the background. */
  async function retryDelete(target: UploadTarget, keys: string[]) {
    await runTransfer({ ...deleteJob(target, keys), background: true });
  }

  async function settleDelete(result: DeleteOutcome, target: UploadTarget) {
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
    // A partial delete leaves a half-old listing; refresh whenever the session
    // still points at the folder that was acted on.
    if (sameTarget(target)) await objects.reload();
  }

  /**
   * Delete `keys` and wait for the single progress entry.
   *
   * Retry repeats exactly this request; S3 deletes are idempotent, so a partial
   * failure can safely run again.
   */
  async function executeDelete(target: UploadTarget, keys: string[]) {
    await runTransfer({ ...deleteJob(target, keys), failure: "Cannot delete" });
  }

  // ----------------------------------------------------------------- copy/move

  async function transferSelection(moveObjects: boolean) {
    const entries = writeTargets.value;
    const source = connections.active;
    if (!entries.length || !source || !sessionMatchesActive() || !canWrite()) return;
    const target = captureTarget(source.id);
    if (!target) return;

    const result = await dialogs.open<CopyMoveResult | null>(
      CopyMoveDialog,
      (settle) => ({
        moveObjects,
        connections: connections.all,
        sourceConnectionId: source.id,
        sourcePrefix: objects.prefix,
        entries,
        resolve: settle,
      }),
      "normal",
      { dismissible: false },
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

  /** One copy/move request: start, retry and settle, shared by the run and its Retry. */
  function copyJob(request: CopyRequest, target: UploadTarget): TransferJob<CopyOutcome> {
    return {
      start: () => api.copyObjects(request),
      retry: (outcome) => transfers.registerRetry(outcome.id, () => retryCopy(request, target)),
      settle: (outcome) => settleCopy(outcome, request, target),
    };
  }

  /** Retry start: resolves once the replacement exists, settles in the background. */
  async function retryCopy(request: CopyRequest, target: UploadTarget) {
    await runTransfer({ ...copyJob(request, target), background: true });
  }

  async function settleCopy(outcome: CopyOutcome, request: CopyRequest, target: UploadTarget) {
    const [settled] = await transfers.waitForAll([outcome.id]);
    if (settled.state === "failed") {
      toasts.error(settled.error ?? "the operation failed", request.moveObjects ? "Move failed" : "Copy failed");
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
    }
    // A failed or cancelled move can still have moved some keys; refresh on
    // every terminal outcome so the listing is never half-stale (MINOR 5).
    if (sameTarget(target)) await objects.reload();
  }

  /** Run one copy/move request and wait for its single progress entry. */
  async function executeCopy(request: CopyRequest, target: UploadTarget) {
    await runTransfer({
      ...copyJob(request, target),
      failure: request.moveObjects ? "Cannot move" : "Cannot copy",
    });
  }

  return {
    targets,
    writeTargets,
    downloadKey,
    downloadFolderKey,
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
  };
}
