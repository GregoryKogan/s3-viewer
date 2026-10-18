import {
  Archive,
  File,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Music,
  Table2,
  Binary,
  type LucideIcon,
} from "@lucide/vue";
import type { FileKind } from "@/types";

/**
 * Icon and colour per file kind. A tinted icon per type reads far faster than a
 * monochrome one, while the folder tint stays the same everywhere so folders are
 * recognisable at a glance.
 *
 * The class names are semantic: `main.css` maps each one to a `--kind-*`
 * variable, so the same icon is legible on the dark and the light surface.
 */
interface KindStyle {
  icon: LucideIcon;
  className: string;
}

const STYLES: Record<FileKind, KindStyle> = {
  folder: { icon: Folder, className: "kind-folder" },
  image: { icon: ImageIcon, className: "kind-image" },
  audio: { icon: Music, className: "kind-audio" },
  video: { icon: Film, className: "kind-video" },
  pdf: { icon: FileText, className: "kind-pdf" },
  markdown: { icon: FileText, className: "kind-markdown" },
  json: { icon: FileJson, className: "kind-json" },
  csv: { icon: FileSpreadsheet, className: "kind-csv" },
  parquet: { icon: Table2, className: "kind-parquet" },
  code: { icon: FileCode, className: "kind-code" },
  text: { icon: FileText, className: "kind-text" },
  archive: { icon: Archive, className: "kind-archive" },
  binary: { icon: Binary, className: "kind-binary" },
  unknown: { icon: File, className: "kind-unknown" },
};

export function kindStyle(kind: FileKind): KindStyle {
  return STYLES[kind] ?? STYLES.unknown;
}
