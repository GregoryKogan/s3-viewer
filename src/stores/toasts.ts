import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastLevel = "info" | "ok" | "warn" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  level: ToastLevel;
  title?: string;
  message: string;
  actions: ToastAction[];
  timeout?: number;
}

const AUTO_DISMISS: Record<ToastLevel, number> = {
  info: 5200,
  ok: 4200,
  warn: 8000,
  error: 14_000,
};

/** Transient notifications. The store owns the timers so they survive re-renders. */
export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function push(toast: Omit<Toast, "id" | "actions"> & { actions?: ToastAction[] }): number {
    const id = nextId++;
    const timeout = toast.timeout ?? AUTO_DISMISS[toast.level];
    toasts.value = [...toasts.value, { ...toast, id, actions: toast.actions ?? [] }];
    if (timeout > 0) {
      timers.set(
        id,
        setTimeout(() => dismiss(id), timeout),
      );
    }
    return id;
  }

  function dismiss(id: number) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  const info = (message: string, title?: string) => push({ level: "info", message, title });
  const ok = (message: string, title?: string) => push({ level: "ok", message, title });
  const warn = (message: string, title?: string) => push({ level: "warn", message, title });
  const error = (message: string, title?: string) => push({ level: "error", message, title });

  function clear() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    toasts.value = [];
  }

  return { toasts, push, dismiss, info, ok, warn, error, clear };
});
