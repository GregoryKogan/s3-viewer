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
  /** Milliseconds left when the timer is (re)started. */
  remaining: number;
  startedAt: number;
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
 * `pause` banks the time left and `resume` starts a fresh timer from it (DLG-4).
 */
export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<Toast[]>([]);
  let nextId = 1;
  const timers = new Map<number, TimerState>();

  function schedule(id: number) {
    const state = timers.get(id);
    if (!state) return;
    if (state.remaining <= 0) {
      dismiss(id);
      return;
    }
    state.startedAt = Date.now();
    state.handle = setTimeout(() => {
      state.handle = null;
      dismiss(id);
    }, state.remaining);
  }

  function push(toast: Omit<Toast, "id" | "actions"> & { actions?: ToastAction[] }): number {
    const id = nextId++;
    const timeout = toast.timeout ?? AUTO_DISMISS[toast.level];
    toasts.value = [...toasts.value, { ...toast, id, actions: toast.actions ?? [] }];
    if (timeout > 0) {
      timers.set(id, {
        handle: null,
        remaining: timeout,
        startedAt: Date.now(),
        pausedBy: new Set(),
      });
      schedule(id);
    }
    return id;
  }

  function pause(id: number, reason: ToastPauseReason) {
    const state = timers.get(id);
    if (!state || state.pausedBy.has(reason)) return;
    // Only bank the elapsed time on the first hold; a second reason must not
    // subtract the paused interval twice.
    if (state.pausedBy.size === 0 && state.handle) {
      clearTimeout(state.handle);
      state.handle = null;
      state.remaining = Math.max(0, state.remaining - (Date.now() - state.startedAt));
    }
    state.pausedBy.add(reason);
  }

  function resume(id: number, reason: ToastPauseReason) {
    const state = timers.get(id);
    if (!state) return;
    state.pausedBy.delete(reason);
    if (state.pausedBy.size === 0 && !state.handle) schedule(id);
  }

  function dismiss(id: number) {
    const state = timers.get(id);
    if (state?.handle) clearTimeout(state.handle);
    timers.delete(id);
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  const info = (message: string, title?: string) => push({ level: "info", message, title });
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

  return { toasts, push, dismiss, pause, resume, info, ok, warn, error, apiError, clear };
});
