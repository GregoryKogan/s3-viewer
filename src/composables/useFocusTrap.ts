import { onBeforeUnmount, onMounted, type Ref } from "vue";

/**
 * What Tab can reach inside a dialog.
 *
 * `[tabindex="-1"]` is programmatic-only (the frame itself), so it is excluded
 * from cycling. The query is rerun on every key: dialogs hide and show whole
 * sections (advanced settings, validation errors), so a cached list goes stale.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

function candidates(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.getAttribute("tabindex") !== "-1" &&
      element.getAttribute("aria-hidden") !== "true" &&
      isVisible(element),
  );
}

/**
 * Keep keyboard focus inside one modal frame.
 *
 * On mount it focuses the element marked `[autofocus]`, otherwise the first
 * focusable control, otherwise the frame (which carries `tabindex="-1"`). Tab
 * and Shift+Tab cycle within that list; on unmount the element that had focus
 * before the dialog opened gets it back.
 *
 * The trap listens on the document because focus starts inside the dialog but
 * may escape if a control unmounts mid-interaction. A stacked dialog is kept in
 * the DOM with `v-show`, and it must not steal keys from the visible one, so
 * every key first checks that the frame still has a layout box
 * (`offsetParent !== null`).
 */
export function useFocusTrap(frame: Ref<HTMLElement | null>): void {
  let previousFocus: HTMLElement | null = null;

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const root = frame.value;
    // `offsetParent` is `null` for `display: none`, which is how DialogHost
    // hides every dialog except the top one.
    if (!root || root.offsetParent === null) return;

    const items = candidates(root);
    if (!items.length) {
      event.preventDefault();
      root.focus();
      return;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = Boolean(active && root.contains(active));

    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMounted(() => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = frame.value;
    if (root && root.offsetParent !== null) {
      const preferred = root.querySelector<HTMLElement>("[autofocus]");
      if (preferred && !preferred.hasAttribute("disabled") && isVisible(preferred)) {
        preferred.focus();
      } else {
        (candidates(root)[0] ?? root).focus();
      }
    }
    document.addEventListener("keydown", onKeydown, true);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("keydown", onKeydown, true);
    // The trigger may have been removed with the dialog (a row action, a menu
    // item), so never focus a detached node.
    if (previousFocus?.isConnected) previousFocus.focus();
  });
}
