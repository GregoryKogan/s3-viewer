import { defineStore } from "pinia";
import { markRaw, ref, type Component } from "vue";
/** Shared geometry, from a plain module so the store imports no component. */
import type { ModalSize } from "@/components/ui/types";

export type DialogSize = ModalSize;

export interface DialogRequest<P = Record<string, unknown>> {
  id: number;
  component: Component;
  props: P;
  size: DialogSize;
  /**
   * Whether a backdrop click may close it. Forms with unsaved input opt out so
   * a stray click cannot throw the work away (DLG-2); Escape and the close
   * button still work.
   */
  dismissible: boolean;
  /** Reject-free cancellation: everything resolves, `null` means "cancelled". */
  onCancel?: () => void;
}

export interface DialogOpenOptions {
  /** Defaults to `true`; pass `false` for a form the user is filling in. */
  dismissible?: boolean;
}

/**
 * Modal stack.
 *
 * A dialog is a component plus its props; `open` returns a promise that the
 * component settles by calling `resolve`. Feature components therefore own their
 * own markup and validation instead of the shell knowing about every dialog.
 */
export const useDialogsStore = defineStore("dialogs", () => {
  const stack = ref<DialogRequest[]>([]);
  const resolvers = new Map<number, (value: unknown) => void>();
  let nextId = 1;

  function open<R>(
    component: Component,
    buildProps: (settle: (value: R) => void) => Record<string, unknown>,
    size: DialogSize = "normal",
    options: DialogOpenOptions = {},
  ): Promise<R> {
    const id = nextId++;
    return new Promise<R>((resolve) => {
      const settle = (value: R) => close(id, value);
      resolvers.set(id, resolve as (value: unknown) => void);
      stack.value = [
        ...stack.value,
        {
          id,
          component: markRaw(component),
          props: buildProps(settle),
          size,
          dismissible: options.dismissible ?? true,
        },
      ];
    });
  }

  /** Settle a dialog and pop it. */
  function close<R>(id: number, value: R) {
    const resolve = resolvers.get(id);
    if (resolve) {
      resolvers.delete(id);
      resolve(value);
    }
    stack.value = stack.value.filter((dialog) => dialog.id !== id);
  }

  function cancel(id: number) {
    close(id, null);
  }

  const isOpen = () => stack.value.length > 0;

  return { stack, open, close, cancel, isOpen };
});
