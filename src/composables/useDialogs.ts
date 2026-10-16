import { useDialogsStore } from "@/stores/dialogs";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PromptDialog from "@/components/ui/PromptDialog.vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  hint?: string;
  validate?: (value: string) => string | null;
}

/**
 * Promise-based dialogs.
 *
 * Each helper pushes a component onto the modal stack and settles it through the
 * store, so callers write straight-line code
 * (`if (!(await confirm(...))) return;`) instead of threading callbacks.
 */
export function useDialogs() {
  const store = useDialogsStore();

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return store.open<boolean>(
      ConfirmDialog,
      (settle) => ({
        title: options.title,
        message: options.message,
        details: options.details ?? [],
        confirmLabel: options.confirmLabel ?? "Confirm",
        cancelLabel: options.cancelLabel ?? "Cancel",
        danger: options.danger ?? false,
        resolve: settle,
      }),
      "narrow",
    );
  }

  function prompt(options: PromptOptions): Promise<string | null> {
    return store.open<string | null>(
      PromptDialog,
      (settle) => ({
        title: options.title,
        label: options.label,
        initial: options.initial ?? "",
        placeholder: options.placeholder ?? "",
        confirmLabel: options.confirmLabel ?? "Create",
        hint: options.hint ?? "",
        validate: options.validate,
        resolve: settle,
      }),
      "narrow",
    );
  }

  return { confirm, prompt, store };
}
