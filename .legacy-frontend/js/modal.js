// Modal shell: one host element, a stack of dialogs, escape/backdrop handling.

import { el, clear } from "./dom.js";

const stack = [];

function host() {
  return document.getElementById("modal-root");
}

/**
 * @param {{title: string, body: Node|Node[], footer?: Node[], size?: "normal"|"narrow",
 *          onClose?: () => void}} options
 * @returns {{close: () => void, root: HTMLElement, body: HTMLElement}}
 */
export function openModal({ title, body, footer = [], size = "normal", onClose }) {
  const root = host();
  if (!root) throw new Error("modal root missing");

  const bodyNode = el("div", { class: "modal__body" });
  const children = [].concat(body ?? []);
  for (const child of children) if (child) bodyNode.append(child);

  const closeBtn = el("button", {
    class: "btn btn--ghost btn--sm",
    text: "✕",
    "aria-label": "Close",
    onClick: () => close(),
  });

  const dialog = el(
    "div",
    {
      class: `modal ${size === "narrow" ? "modal--narrow" : ""}`,
      role: "dialog",
      "aria-modal": "true",
      "data-testid": "modal",
      onClick: (event) => event.stopPropagation(),
    },
    [
      el("header", { class: "modal__head" }, [
        el("div", { class: "modal__title", text: title, "data-testid": "modal-title" }),
        closeBtn,
      ]),
      bodyNode,
      footer.length ? el("footer", { class: "modal__foot" }, footer) : null,
    ],
  );

  const entry = { dialog, onClose };
  stack.push(entry);
  root.hidden = false;
  clear(root);
  root.append(dialog);

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKeyDown);

  function close() {
    const index = stack.indexOf(entry);
    if (index === -1) return;
    stack.splice(index, 1);
    document.removeEventListener("keydown", onKeyDown);
    if (stack.length === 0) {
      root.hidden = true;
      clear(root);
    } else {
      clear(root);
      root.append(stack[stack.length - 1].dialog);
    }
    onClose?.();
  }

  // Focus the first sensible control.
  requestAnimationFrame(() => {
    const target = dialog.querySelector("input, textarea, select, button.btn--primary");
    target?.focus();
  });

  return { close, root: dialog, body: bodyNode };
}

export function closeAllModals() {
  while (stack.length) stack[stack.length - 1] && popAndClose();
}

function popAndClose() {
  const root = host();
  const top = root?.querySelector(".modal__head .btn--ghost");
  top?.click();
}

/** A confirmation dialog. Resolves `true` when confirmed. */
export function confirmDialog({
  title,
  message,
  details = [],
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = [
      el("p", { text: message, "data-testid": "confirm-message" }),
      details.length
        ? el(
            "ul",
            { class: "detail-list", "data-testid": "confirm-details" },
            details.map((line) => el("li", { text: line })),
          )
        : null,
    ];

    const modal = openModal({
      title,
      size: "narrow",
      body,
      footer: [
        el("button", {
          class: "btn",
          text: cancelLabel,
          "data-testid": "confirm-cancel",
          onClick: () => {
            finish(false);
            modal.close();
          },
        }),
        el("button", {
          class: `btn ${danger ? "btn--danger" : "btn--primary"}`,
          text: confirmLabel,
          "data-testid": "confirm-ok",
          onClick: () => {
            finish(true);
            modal.close();
          },
        }),
      ],
      onClose: () => finish(false),
    });
  });
}

/** Single-line text prompt. Resolves the trimmed value or `null`. */
export function promptDialog({
  title,
  label,
  value = "",
  placeholder = "",
  confirmLabel = "Create",
  hint = "",
  validate,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const input = el("input", {
      type: "text",
      value,
      placeholder,
      "data-testid": "prompt-input",
    });
    const error = el("div", { class: "field__hint", style: { color: "var(--danger)" } });

    const submit = () => {
      const candidate = input.value.trim();
      const problem = validate ? validate(candidate) : null;
      if (!candidate) {
        error.textContent = "A value is required.";
        return;
      }
      if (problem) {
        error.textContent = problem;
        return;
      }
      finish(candidate);
      modal.close();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    const modal = openModal({
      title,
      size: "narrow",
      body: [
        el("div", { class: "field" }, [
          el("label", { text: label }),
          input,
          hint ? el("div", { class: "field__hint", text: hint }) : null,
          error,
        ]),
      ],
      footer: [
        el("button", {
          class: "btn",
          text: "Cancel",
          onClick: () => {
            finish(null);
            modal.close();
          },
        }),
        el("button", {
          class: "btn btn--primary",
          text: confirmLabel,
          "data-testid": "prompt-ok",
          onClick: submit,
        }),
      ],
      onClose: () => finish(null),
    });
  });
}

/** Informational dialog with a single Close button. */
export function messageDialog({ title, body, closeLabel = "Close" }) {
  const modal = openModal({
    title,
    body: [].concat(body),
    footer: [el("button", { class: "btn btn--primary", text: closeLabel, onClick: () => modal.close() })],
  });
  return modal;
}
