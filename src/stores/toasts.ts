import { defineStore } from "pinia";
import { ref } from "vue";
import { ApiError } from "@/lib/ipc";

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

export type ToastPauseReason = "hover" | "focus";

interface TimerState {
  handle: ReturnType<typeof setTimeout> | null;
  /** When the timer would fire, in `Date.now()` terms. */
  deadline: number;
  /** When the countdown was held, so `resume` can push the deadline out. */
  pausedAt: number;
  /**
   * Why the countdown is currently held. Hover and keyboard focus are tracked
   * separately: leaving with the mouse must not restart a toast the reader is
   * still focused on, and blurring must not override a hover.
   */
  pausedBy: Set<ToastPauseReason>;
}

/**
 * Transient notifications. The store owns the timers so they survive re-renders.
 *
 * A hovered or focused toast must not disappear under the reader's cursor, so
 * `pause` freezes the deadline and `resume` pushes it out by the time the
 * countdown was held (DLG-4).
 */
export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;
  const timers = new Map<number, TimerState>();

  function schedule(id: number) {
    const state = timers.get(id);
    if (!state) return;
    const left = state.deadline - Date.now();
    if (left <= 0) {
      dismiss(id);
      return;
    }
    state.handle = setTimeout(() => {
      state.handle = null;
      dismiss(id);
    }, left);
  }

  function push(toast: Omit<Toast, "id" | "actions"> & { actions?: ToastAction[] }): number {
    const id = nextId++;
    // A toast that offers an action has to stay until the user answers it:
    // reaching its button through the whole Tab order before it auto-dismisses
    // is not a keyboard path.
    const timeout = toast.timeout ?? (toast.actions?.length ? 0 : AUTO_DISMISS[toast.level]);
    toasts.value = [...toasts.value, { ...toast, id, actions: toast.actions ?? [] }];
    if (timeout > 0) {
      timers.set(id, {
        handle: null,
        deadline: Date.now() + timeout,
        pausedAt: 0,
        pausedBy: new Set(),
      });
      schedule(id);
    }
    return id;
  }

  function pause(id: number, reason: ToastPauseReason) {
    const state = timers.get(id);
    if (!state || state.pausedBy.has(reason)) return;
    // Only the first hold stops the clock; a second reason must not move the
    // deadline twice.
    if (state.pausedBy.size === 0) {
      if (state.handle) {
        clearTimeout(state.handle);
        state.handle = null;
      }
      state.pausedAt = Date.now();
    }
    state.pausedBy.add(reason);
  }

  function resume(id: number, reason: ToastPauseReason) {
    const state = timers.get(id);
    if (!state) return;
    state.pausedBy.delete(reason);
    if (state.pausedBy.size || state.handle) return;
    // The reader gets the time the toast had left, not a fresh full timeout.
    state.deadline += Date.now() - state.pausedAt;
    schedule(id);
  }

  function dismiss(id: number) {
    const state = timers.get(id);
    if (state?.handle) clearTimeout(state.handle);
    timers.delete(id);
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  const ok = (message: string, title?: string) => push({ level: "ok", message, title });
  const warn = (message: string, title?: string) => push({ level: "warn", message, title });
  const error = (message: string, title?: string) => push({ level: "error", message, title });

  /**
   * An error toast that keeps the backend's fix-it hints.
   *
   * `ApiError.hints` is the one place that says "set addressing style to
   * virtual" or "check the region"; joining them with newlines lets the toast
   * render one instruction per line. `message` overrides the thrown message for
   * callers that add context of their own.
   */
  function apiError(apiFailure: unknown, title?: string, message?: string): number {
    const text =
      message ?? (apiFailure instanceof Error ? apiFailure.message : String(apiFailure));
    const hints = apiFailure instanceof ApiError ? apiFailure.hints : [];
    return error([text, ...hints].join("\n"), title);
  }

  function clear() {
    for (const state of timers.values()) if (state.handle) clearTimeout(state.handle);
    timers.clear();
    toasts.value = [];
  }

  return { toasts, push, dismiss, pause, resume, ok, warn, error, apiError, clear };
});
