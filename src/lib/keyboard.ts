/**
 * Platform keyboard labels.
 *
 * The app runs on macOS and Linux with one set of handlers, but the labels the
 * user reads must match the modifier their platform actually uses. Everything
 * here is a pure function except the one-time platform detection, so the labels
 * can be unit-tested without a DOM.
 */

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return /mac/i.test(platform) || /mac os x|macintosh|iphone|ipad/i.test(nav.userAgent || "");
}

/** True when the running platform uses the Command key. */
export const IS_MAC = detectMac();

/** `⌘` on macOS, `Ctrl+` everywhere else. */
export function modLabel(mac = IS_MAC): "⌘" | "Ctrl+" {
  return mac ? "⌘" : "Ctrl+";
}

/** Keys whose glyph differs between a Mac keyboard and a PC keyboard. */
const NAMED_KEYS: Record<string, { mac: string; other: string }> = {
  backspace: { mac: "⌫", other: "Backspace" },
  delete: { mac: "⌦", other: "Del" },
  del: { mac: "⌦", other: "Del" },
  arrowup: { mac: "↑", other: "↑" },
  up: { mac: "↑", other: "↑" },
  arrowdown: { mac: "↓", other: "↓" },
  down: { mac: "↓", other: "↓" },
  arrowleft: { mac: "←", other: "←" },
  left: { mac: "←", other: "←" },
  arrowright: { mac: "→", other: "→" },
  right: { mac: "→", other: "→" },
  enter: { mac: "↩", other: "Enter" },
  return: { mac: "↩", other: "Enter" },
  escape: { mac: "esc", other: "Esc" },
  esc: { mac: "esc", other: "Esc" },
  tab: { mac: "⇥", other: "Tab" },
  space: { mac: "Space", other: "Space" },
  pageup: { mac: "PgUp", other: "PgUp" },
  pagedown: { mac: "PgDn", other: "PgDn" },
  home: { mac: "↖", other: "Home" },
  end: { mac: "↘", other: "End" },
};

/**
 * A key's platform glyph without a modifier: `keyLabel("Enter")` is `↩` on
 * macOS and `Enter` elsewhere. Hint rows that describe unmodified keys (arrows,
 * Enter) use this so they do not claim a modifier the handler does not need.
 */
export function keyLabel(key: string, mac = IS_MAC): string {
  const named = NAMED_KEYS[key.trim().toLowerCase()];
  if (named) return mac ? named.mac : named.other;
  const trimmed = key.trim();
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
}

/**
 * A complete shortcut label: `shortcutLabel("R")` is `⌘R` on macOS and
 * `Ctrl+R` on Linux. Named keys use the platform glyph, so
 * `shortcutLabel("Backspace")` is `⌘⌫` on macOS and `Ctrl+Backspace` on Linux.
 */
export function shortcutLabel(key: string, mac = IS_MAC): string {
  return `${modLabel(mac)}${keyLabel(key.trim(), mac)}`;
}

/**
 * Whether a keydown target is a text field the app must not hijack.
 *
 * Accepts any object: tests pass fake elements because Node has no DOM, and the
 * handler passes the real `event.target`.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  const tag = (element.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (element.isContentEditable === true) return true;
  const editable = element.getAttribute?.("contenteditable");
  return editable !== null && editable !== undefined && editable !== "false";
}
