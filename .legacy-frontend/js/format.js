// Shared formatting helpers. Kept tiny and pure so they are easy to eyeball.

export function humanSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${bytes} B`;
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function humanDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const now = Date.now();
  const diff = now - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff >= 0 && diff < minute) return "just now";
  if (diff >= 0 && diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff >= 0 && diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff >= 0 && diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, {
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}

export function kindLabel(kind) {
  const labels = {
    image: "Image",
    audio: "Audio",
    video: "Video",
    pdf: "PDF",
    text: "Text",
    markdown: "Markdown",
    code: "Code",
    json: "JSON",
    csv: "CSV",
    archive: "Archive",
    binary: "Binary",
    folder: "Folder",
    unknown: "File",
  };
  return labels[kind] ?? kind;
}

export function kindIcon(kind, isFolder) {
  if (isFolder) return "📁";
  const icons = {
    image: "🖼",
    audio: "🎵",
    video: "🎬",
    pdf: "📕",
    text: "📄",
    markdown: "📝",
    code: "⌨",
    json: "🧾",
    csv: "📊",
    archive: "🗜",
    binary: "⚙",
  };
  return icons[kind] ?? "📄";
}

/** Split a key into breadcrumb segments, always ending with a trailing slash. */
export function prefixSegments(prefix) {
  const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!clean) return [];
  return clean.split("/").map((name, index, all) => ({
    name: name || "/",
    prefix: `${all.slice(0, index + 1).join("/")}/`,
  }));
}

export function fileName(key) {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

export function extensionOf(key) {
  const name = fileName(key);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function debounce(fn, delay = 160) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function pluralize(count, one, many) {
  return count === 1 ? one : many;
}
