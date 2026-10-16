import type { FileKind } from "@/types";

/**
 * File classification for the list, mirroring the rules in
 * `src-tauri/src/s3/kind.rs`: extension first, then the content type, then a
 * generic bucket. The browser cannot sniff bytes before fetching them, which is
 * exactly what the backend preview does — this is the cheap guess the list needs.
 */

const EXTENSION_KINDS: Record<string, FileKind> = {
  // images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  avif: "image",
  svg: "image",
  tif: "image",
  tiff: "image",
  heic: "image",
  heif: "image",
  psd: "image",
  // audio
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  weba: "audio",
  // video
  mp4: "video",
  m4v: "video",
  webm: "video",
  ogv: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  // documents and data
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  geojson: "json",
  json5: "json",
  csv: "csv",
  tsv: "csv",
  parquet: "parquet",
  pq: "parquet",
  orc: "parquet",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
  zst: "archive",
  txt: "text",
  log: "text",
  text: "text",
  rst: "text",
  ini: "text",
  cfg: "text",
  conf: "text",
  env: "text",
  properties: "text",
  srt: "text",
  vtt: "text",
  diff: "text",
  patch: "text",
};

const CODE_EXTENSIONS = [
  "py", "pyi", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "go", "java", "kt", "kts",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "rb", "php", "swift", "scala", "sh", "bash",
  "zsh", "fish", "ps1", "bat", "sql", "yaml", "yml", "toml", "xml", "html", "htm", "css",
  "scss", "less", "lua", "pl", "r", "jl", "clj", "ex", "exs", "erl", "hs", "ml", "nim",
  "zig", "dart", "vue", "svelte", "gradle", "proto", "tf", "hcl", "cmake", "mk", "dockerfile",
];
for (const extension of CODE_EXTENSIONS) EXTENSION_KINDS[extension] = "code";

const FILENAME_KINDS: Record<string, FileKind> = {
  dockerfile: "code",
  containerfile: "code",
  makefile: "code",
  "cmakelists.txt": "code",
  ".gitignore": "text",
  ".dockerignore": "text",
  ".env": "text",
};

function kindFromContentType(contentType?: string | null): FileKind | null {
  if (!contentType) return null;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("markdown")) return "markdown";
  if (mime.includes("json")) return "json";
  if (mime.includes("parquet")) return "parquet";
  if (mime === "text/csv") return "csv";
  if (mime.startsWith("text/")) return "text";
  return null;
}

/** Classify one object for the list. */
export function detectKind(
  key: string,
  options: { isFolder?: boolean; contentType?: string | null } = {},
): FileKind {
  if (options.isFolder || key.endsWith("/")) return "folder";

  const name = (key.split("/").pop() ?? key).toLowerCase();
  const named = FILENAME_KINDS[name];
  if (named) return named;

  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const extension = name.slice(dot + 1);
    const known = EXTENSION_KINDS[extension];
    if (known) return known;
    return "binary";
  }

  return kindFromContentType(options.contentType) ?? "unknown";
}

/** File kind from a path on disk, used when uploading. */
export function kindFromPath(path: string): FileKind {
  return detectKind(path.split(/[/\\]/).pop() ?? path);
}

const KIND_LABELS: Record<FileKind, string> = {
  image: "Image",
  audio: "Audio",
  video: "Video",
  pdf: "PDF",
  text: "Text",
  markdown: "Markdown",
  code: "Code",
  json: "JSON",
  csv: "CSV",
  parquet: "Parquet",
  archive: "Archive",
  binary: "Binary",
  folder: "Folder",
  unknown: "File",
};

export function kindLabel(kind: FileKind): string {
  return KIND_LABELS[kind] ?? "File";
}

/** True when the preview panel can render the content without reading it as text. */
export function isRichPreview(kind: FileKind): boolean {
  return kind === "image" || kind === "audio" || kind === "video" || kind === "pdf";
}
