import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import { useConnectionsStore } from "@/stores/connections";
import { useDialogsStore } from "@/stores/dialogs";
import { useToastsStore } from "@/stores/toasts";
import type { Connection } from "@/types";

/**
 * Actions on a saved connection that need a dialog or a toast.
 *
 * The card menu and the edit dialog both offer removal; one implementation
 * keeps the wording, the confirmation and the toast from drifting apart.
 */
export function useConnectionActions() {
  const connections = useConnectionsStore();
  const toasts = useToastsStore();
  const dialogs = useDialogsStore();

  /** Remove a saved connection after one confirmation. True when it is gone. */
  async function remove(connection: Connection): Promise<boolean> {
    // Removing a connection is destructive and irreversible, so it gets the
    // same explicit confirmation as deleting objects (CON-7).
    const confirmed = await dialogs.open<boolean>(
      ConfirmDialog,
      (settle) => ({
        title: `Remove “${connection.name}”?`,
        message:
          "This removes the connection and its saved credentials from this computer. Objects in the bucket are unaffected.",
        confirmLabel: "Remove",
        danger: true,
        resolve: settle,
      }),
      "narrow",
    );
    if (!confirmed) return false;
    try {
      await connections.remove(connection.id);
      toasts.ok(`Connection “${connection.name}” removed.`);
      return true;
    } catch (error) {
      toasts.apiError(error, "Cannot remove connection");
      return false;
    }
  }

  return { remove };
}
