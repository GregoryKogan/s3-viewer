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

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Midnight at the start of the local calendar day `date` falls in. */
function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Absolute, scannable dates: `Today 14:05`, `Yesterday 09:12`, `12 Oct`, and
 * `12 Oct 2025` outside the current year. Relative ages ("3h ago") are useless
 * when comparing two versions of a file, so the only relative part left is the
 * day itself.
 *
 * `now` is injectable so tests do not depend on the wall clock. Missing values
 * stay an em dash and an unparseable value is returned unchanged, as before.
 */
export function humanDate(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const day = startOfDay(date);
  if (day === startOfDay(now)) return `Today ${time}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === startOfDay(yesterday)) return `Yesterday ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return (sameYear ? DAY_MONTH : DAY_MONTH_YEAR).format(date);
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

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Parent directory of a filesystem path.
 *
 * Used when a cancelled single download is retried: the original absolute
 * destination must not be reused (the cancelled task can still be streaming and
 * may delete it), so the retry targets the parent and lets the backend reserve a
 * fresh unique name. Returns "" when the path has no directory part.
 */
export function parentDirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return "";
  return slash === 0 ? "/" : path.slice(0, slash);
}
