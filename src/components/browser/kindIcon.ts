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
 */
interface KindStyle {
  icon: LucideIcon;
  className: string;
}

const STYLES: Record<FileKind, KindStyle> = {
  folder: { icon: Folder, className: "text-amber-400/90" },
  image: { icon: ImageIcon, className: "text-sky-400/90" },
  audio: { icon: Music, className: "text-emerald-400/90" },
  video: { icon: Film, className: "text-violet-400/90" },
  pdf: { icon: FileText, className: "text-rose-400/90" },
  markdown: { icon: FileText, className: "text-sky-300/90" },
  json: { icon: FileJson, className: "text-amber-300/90" },
  csv: { icon: FileSpreadsheet, className: "text-emerald-300/90" },
  parquet: { icon: Table2, className: "text-teal-300/90" },
  code: { icon: FileCode, className: "text-indigo-300/90" },
  text: { icon: FileText, className: "text-slate-300/80" },
  archive: { icon: Archive, className: "text-orange-300/90" },
  binary: { icon: Binary, className: "text-slate-400/80" },
  unknown: { icon: File, className: "text-slate-400/80" },
};

export function kindStyle(kind: FileKind): KindStyle {
  return STYLES[kind] ?? STYLES.unknown;
}
