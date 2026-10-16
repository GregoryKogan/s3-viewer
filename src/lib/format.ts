/** Formatting and key parsing helpers. Pure functions, no DOM, no state. */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** `1536` → `1.5 KB`. Returns an em dash for missing sizes. */
export function humanSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${SIZE_UNITS[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative for recent timestamps, absolute for older ones. */
export function humanDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const diff = Date.now() - date.getTime();
  if (diff >= 0 && diff < MINUTE) return "just now";
  if (diff >= 0 && diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff >= 0 && diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff >= 0 && diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}


/** The trailing path segment of a prefix, with its trailing slash removed. */
export function leafName(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  return trimmed.split("/").pop() || trimmed;
}

export function extensionOf(key: string): string {
  const name = leafName(key);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export interface Crumb {
  name: string;
  prefix: string;
}

/** Cumulative prefixes for a breadcrumb, e.g. `a/b/` → `a/`, `a/b/`. */
export function prefixSegments(prefix: string): Crumb[] {
  const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!clean) return [];
  const parts = clean.split("/");
  return parts.map((name, index) => ({
    name: name || "/",
    prefix: `${parts.slice(0, index + 1).join("/")}/`,
  }));
}

export function s3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, delay = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
