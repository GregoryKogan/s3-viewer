import { computed } from "vue";
import { api, copyText, pickFiles, pickSavePath } from "@/lib/ipc";
import { s3Uri, humanSize } from "@/lib/format";
import { validateKey } from "@/lib/keys";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useToastsStore } from "@/stores/toasts";
import { useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";
import { useDialogs } from "@/composables/useDialogs";
import CopyMoveDialog, { type CopyMoveResult } from "@/components/dialogs/CopyMoveDialog.vue";
import type { ObjectEntry } from "@/types";

interface Options {
  /** Called after a mutation so the caller can refresh whatever it owns. */
  onChanged?: () => void;
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

  // ---------------------------------------------------------------- downloads

  async function downloadEntry(entry: ObjectEntry) {
    const connection = connections.active;
    if (!connection) return;

    // "Ask every time" means exactly that: pick the destination first, and treat
    // cancelling the dialog as cancelling the download.
    let destPath: string | null = null;
    if (ui.settings?.askDownloadLocation) {
      destPath = await pickSavePath(entry.name);
      if (!destPath) return;
    }

    try {
      await api.downloadObject({ connectionId: connection.id, key: entry.key, destPath });
      transfers.start();
    } catch (error) {
      toasts.error((error as Error).message, "Download failed");
    }
  }

  async function downloadSelection() {
    const entries = targets.value.filter((entry) => !entry.isFolder);
    if (!entries.length) {
      toasts.warn("Folders cannot be downloaded directly. Open the folder and select its files.", "Nothing to download");
      return;
    }
    await Promise.all(entries.map(downloadEntry));
  }

  // ------------------------------------------------------------------ clipboard

  async function copyUri(entry: ObjectEntry) {
    const connection = connections.active;
    if (!connection) return;
    const uri = s3Uri(connection.bucket, entry.key);
    if (await copyText(uri)) toasts.ok(`Copied ${uri}`);
    else toasts.error("The clipboard is not available.");
  }

  async function copySelectionUris() {
    const connection = connections.active;
    const entries = targets.value;
    if (!connection || !entries.length) return;
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
    if (!connection) return;
    if (connection.security.readOnlyMode) {
      toasts.warn("This connection is in read-only mode.", "Upload blocked");
      return;
    }
    try {
      const paths = await pickFiles({ multiple: true });
      if (!paths.length) return;
      await uploadPaths(paths);
    } catch (error) {
      toasts.error((error as Error).message, "Cannot upload");
    }
  }

  async function uploadPaths(paths: string[]) {
    const connection = connections.active;
    if (!connection || !paths.length) return;
    try {
      const plan = await api.uploadFiles({
        connectionId: connection.id,
        prefix: objects.prefix,
        localPaths: paths,
        overwrite: false,
      });
      transfers.start();
      toasts.info(`${plan.length} file${plan.length === 1 ? "" : "s"} → ${objects.prefix || "/"}`, "Upload started");
    } catch (error) {
      toasts.error((error as Error).message, "Cannot upload");
    }
  }

  // ------------------------------------------------------------------ creation

  async function createFolder() {
    const connection = connections.active;
    if (!connection) return;
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
    if (!connection) return;
    const name = await dialogs.prompt({
      title: "New file",
      label: "File name",
      confirmLabel: "Create file",
      hint: "An empty object is created. The extension decides how it is previewed.",
      validate: (value) => validateKey(value),
    });
    if (!name) return;
    try {
      await api.createFile({ connectionId: connection.id, prefix: objects.prefix, name, content: "" });
      toasts.ok(`File “${name}” created.`);
      await objects.reload();
    } catch (error) {
      toasts.error((error as Error).message, "Cannot create file");
    }
  }

  // ------------------------------------------------------------------ deletion

  async function deleteSelection() {
    const connection = connections.active;
    const entries = targets.value;
    if (!connection || !entries.length) return;

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

    try {
      const result = await api.deleteObjects({
        connectionId: connection.id,
        keys: entries.map((entry) => entry.key),
      });
      transfers.start();
      objects.clearSelection();
      const outcome = await transfers.waitFor(result.id);
      if (outcome.state === "failed") toasts.error(outcome.error ?? "the delete failed", "Delete failed");
      else toasts.ok(`${result.deleted} object(s) deleted.`);
      await objects.reload();
    } catch (error) {
      toasts.error((error as Error).message, "Cannot delete");
    }
  }

  // ----------------------------------------------------------------- copy/move

  async function transferSelection(moveObjects: boolean) {
    const entries = targets.value;
    const source = connections.active;
    if (!entries.length || !source) return;

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

    try {
      const outcome = await api.copyObjects({
        sourceConnectionId: source.id,
        destConnectionId: result.destinationConnectionId,
        keys: entries.map((entry) => entry.key),
        destPrefix: result.destinationPrefix,
        moveObjects,
      });
      transfers.start();
      toasts.info(`${outcome.copied} object(s).`, moveObjects ? "Moving" : "Copying");
      const settled = await transfers.waitFor(outcome.id);
      if (settled.state === "failed") {
        toasts.error(settled.error ?? "the operation failed", moveObjects ? "Move failed" : "Copy failed");
      }
      await changed();
    } catch (error) {
      toasts.error((error as Error).message, moveObjects ? "Cannot move" : "Cannot copy");
    }
  }

  return {
    targets,
    downloadEntry,
    downloadSelection,
    copyUri,
    copySelectionUris,
    upload,
    uploadPaths,
    createFolder,
    createFile,
    deleteSelection,
    transferSelection,
    changed,
  };
}
