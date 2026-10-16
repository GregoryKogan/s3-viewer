// Toast notifications.

import { el, clear } from "./dom.js";

const AUTO_DISMISS = { info: 5200, ok: 4200, warn: 8000, error: 14000 };

/**
 * @param {{title?: string, message: string, level?: "info"|"ok"|"warn"|"error",
 *          actions?: Array<{label: string, onClick: () => void}>}} options
 */
export function toast({ title, message, level = "info", actions = [] }) {
  const host = document.getElementById("toasts");
  if (!host) return;

  const node = el("div", { class: `toast toast--${level}`, "data-testid": `toast-${level}` }, [
    el("div", { class: "toast__body" }, [
      title ? el("div", { class: "toast__title", text: title }) : null,
      el("div", { class: "toast__text", text: message }),
      actions.length
        ? el(
            "div",
            { class: "toast__actions", style: { display: "flex", gap: "6px", marginTop: "4px" } },
            actions.map((action) =>
              el("button", {
                class: "btn btn--sm",
                text: action.label,
                onClick: () => {
                  action.onClick();
                  dismiss();
                },
              }),
            ),
          )
        : null,
    ]),
    el("button", { class: "toast__close", text: "✕", onClick: () => dismiss() }),
  ]);

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    node.remove();
  };

  host.append(node);
  timer = setTimeout(dismiss, AUTO_DISMISS[level] ?? 6000);
  return dismiss;
}

export function clearToasts() {
  const host = document.getElementById("toasts");
  if (host) clear(host);
}

export const toastError = (message, title = "Error") => toast({ level: "error", title, message });
export const toastOk = (message, title) => toast({ level: "ok", title, message });
export const toastWarn = (message, title) => toast({ level: "warn", title, message });
