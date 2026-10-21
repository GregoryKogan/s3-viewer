import type { FileKind } from "@/types";

/**
 * How the list names a file kind. The backend classifies every `ObjectEntry`
 * (`src-tauri/src/s3/kind.rs`) and sends `kind`, so the frontend only labels it.
 */
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
