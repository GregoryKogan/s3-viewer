import { defineStore } from "pinia";
import { markRaw, ref, type Component } from "vue";
import type { ModalProps } from "@/components/ui/ModalFrame.vue";

export interface DialogRequest<P = Record<string, unknown>> {
  id: number;
  component: Component;
  props: P;
  size: ModalProps["size"];
  /** Reject-free cancellation: everything resolves, `null` means "cancelled". */
  onCancel?: () => void;
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
    size: ModalProps["size"] = "normal",
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
          props: { ...buildProps(settle), dialogId: id },
          size,
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

  function closeAll() {
    for (const dialog of [...stack.value]) cancel(dialog.id);
  }

  const isOpen = () => stack.value.length > 0;

  return { stack, open, close, cancel, closeAll, isOpen };
});
