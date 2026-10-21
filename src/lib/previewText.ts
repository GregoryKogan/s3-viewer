/**
 * Pure text/table/Markdown helpers used by the preview renderers.
 *
 * Carried over from the vanilla renderer that these were tested in; the language
 * tables and the sanitiser allow-list are the parts that must not drift, so they
 * are copied verbatim rather than rewritten.
 */

import hljs from "highlight.js/lib/core";
import { extensionOf } from "@/lib/format";
import type { FileKind } from "@/types";

export const EXTENSION_LANGUAGE = {
  py: "python",
  pyi: "python",
  pyw: "python",
  ipynb: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  geojson: "json",
  json5: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  ksh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  properties: "ini",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  xsl: "xml",
  plist: "xml",
  rss: "xml",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  sql: "sql",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sbt: "scala",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  csx: "csharp",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  lua: "lua",
  pl: "perl",
  pm: "perl",
  r: "r",
  rmd: "r",
  swift: "swift",
  dart: "dart",
  ex: "ruby",
  exs: "ruby",
  erl: "erlang",
  hrl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  fs: "fsharp",
  fsx: "fsharp",
  vim: "vim",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rst: "markdown",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  mk: "makefile",
  makefile: "makefile",
  cmake: "cmake",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  hcl: "hcl",
  ps1: "powershell",
  psm1: "powershell",
  bat: "dos",
  cmd: "dos",
  diff: "diff",
  patch: "diff",
  log: "plaintext",
  srt: "plaintext",
  vtt: "plaintext",
  license: "plaintext",
  txt: "plaintext",
  text: "plaintext",
};

export const FILENAME_LANGUAGE = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "bash",
  ".dockerignore": "bash",
  ".npmignore": "bash",
  ".env": "ini",
  ".editorconfig": "ini",
  "requirements.txt": "plaintext",
};

export const DETECT_CANDIDATES = [
  "json", "yaml", "xml", "ini", "bash", "python", "javascript", "typescript",
  "sql", "cpp", "go", "rust", "java", "csharp", "markdown", "plaintext",
];

/** Above this size auto-detection is skipped: it is not worth the CPU. */
export const DETECT_MAX_BYTES = 48 * 1024;

/**
 * Which highlighter language a key should use.
 *
 * Orders of preference: the exact file name, then the extension, then — for files
 * whose type is unknown — detection over a short candidate list. Falling back to
 * `null` is deliberate: guessing wildly paints the whole file one colour, which
 * reads worse than no colour at all.
 */
export function resolveLanguage(key: string, text: string): string | null {
  const name = key.toLowerCase().split("/").pop() ?? "";
  const byName = (FILENAME_LANGUAGE as Record<string, string>)[name];
  if (byName) return byName;

  const byExtension = (EXTENSION_LANGUAGE as Record<string, string>)[extensionOf(key)];
  if (byExtension) return byExtension;

  // Detection runs every registered grammar over the text, so it is only worth
  // the CPU on genuinely small files.
  if (text && text.length <= DETECT_MAX_BYTES && typeof hljs.highlightAuto === "function") {
    try {
      const result = hljs.highlightAuto(text, DETECT_CANDIDATES);
      const language = result.language;
      if (language && language !== "plaintext" && result.relevance > 2) return language;
    } catch {
      /* detection is best-effort */
    }
  }
  return null;
}

/** Pretty-print a JSON document, or `null` when it is not valid JSON. */
export function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/** Guess the delimiter of a delimited file from its first line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/** Minimal RFC4180-ish parser: handles quotes, escaped quotes and newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Which preview views can host find-in-file.
 *
 * Rendered Markdown is markup, not the file's text, so it has no body the bar
 * could search; the Raw view shows the source and can.
 */
export function isPreviewSearchable(kind: FileKind, view: "rendered" | "raw"): boolean {
  return (
    kind === "text" ||
    kind === "code" ||
    kind === "json" ||
    (kind === "markdown" && view === "raw")
  );
}

// ------------------------------------------------------------------- sanitizer

const ALLOWED_TAGS = new Set([
  "A", "P", "BR", "HR", "EM", "STRONG", "B", "I", "U", "S", "DEL", "INS", "MARK", "SMALL", "SUB", "SUP",
  "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "SPAN", "DIV",
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "IMG", "INPUT", "DL", "DT", "DD", "FIGURE",
  "FIGCAPTION", "SECTION", "ARTICLE", "DETAILS", "SUMMARY", "KBD", "ABBR",
]);

const ALLOWED_ATTRS = new Set([
  "href", "title", "alt", "src", "class", "colspan", "rowspan", "align", "type", "checked", "disabled",
  "start", "id",
]);

const SAFE_URL = /^(https?:|mailto:|data:image\/|s3stream:|#|\/)/i;

/**
 * Strip anything executable from rendered Markdown.
 *
 * A hand-rolled walker rather than a sanitizer dependency: the allowed set is
 * small and explicit, and the preview panel is the only place where markup is
 * produced. There is an end-to-end check for this.
 */
export function sanitize(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  walk(template.content);
  return template.innerHTML;
}

function walk(root: Node): void {
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const element = node as Element;
    if (!ALLOWED_TAGS.has(element.tagName)) {
      // Keep the text of unknown tags, drop the tag itself.
      element.replaceWith(document.createTextNode(element.textContent ?? ""));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "src") && !SAFE_URL.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName === "A" && element.getAttribute("href")) {
      element.setAttribute("rel", "noreferrer noopener");
      element.setAttribute("target", "_blank");
    }
    if (element.tagName === "INPUT") {
      element.setAttribute("disabled", "");
    }
    walk(element);
  }
}
