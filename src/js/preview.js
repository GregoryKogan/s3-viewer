// Preview panel renderers.
//
// Everything here is DOM construction via `el()` — no innerHTML with object
// content, so an object key or a Markdown file cannot inject markup. Markdown is
// the single exception (it must produce markup) and goes through `sanitize()`.

import { el, clear, copyText } from "./dom.js";
import { humanSize, kindLabel, extensionOf } from "./format.js";
import { toastOk, toastError } from "./toast.js";

import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import sql from "highlight.js/lib/languages/sql";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import ini from "highlight.js/lib/languages/ini";
import markdown from "highlight.js/lib/languages/markdown";
import csharp from "highlight.js/lib/languages/csharp";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import lua from "highlight.js/lib/languages/lua";
import perl from "highlight.js/lib/languages/perl";
import r from "highlight.js/lib/languages/r";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import scala from "highlight.js/lib/languages/scala";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import makefile from "highlight.js/lib/languages/makefile";
import protobuf from "highlight.js/lib/languages/protobuf";
import graphql from "highlight.js/lib/languages/graphql";
import powershell from "highlight.js/lib/languages/powershell";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";
import { marked } from "marked";

const LANGUAGES = {
  python,
  csharp,
  ruby,
  php,
  lua,
  perl,
  r,
  swift,
  kotlin,
  scala,
  dart,
  dockerfile,
  makefile,
  protobuf,
  graphql,
  powershell,
  diff,
  plaintext,
  javascript,
  typescript,
  json,
  bash,
  yaml,
  xml,
  css,
  sql,
  go,
  rust,
  java,
  cpp,
  ini,
  markdown,
};
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

// Keep highlighting cheap for pathological inputs.
hljs.configure({ ignoreUnescapedHTML: true, throwOnError: false });

const EXTENSION_LANGUAGE = {
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

/** Files that are identified by name rather than by extension. */
const FILENAME_LANGUAGE = {
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

/** Languages tried, in order, when a file's type cannot be named exactly. */
const DETECT_CANDIDATES = [
  "json", "yaml", "xml", "ini", "bash", "python", "javascript", "typescript",
  "sql", "cpp", "go", "rust", "java", "csharp", "markdown", "plaintext",
];

/** Above this size auto-detection is skipped: it is not worth the CPU. */
const DETECT_MAX_BYTES = 48 * 1024;

marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });

/**
 * @param {object} data  PreviewData returned by Rust.
 * @param {{onDownload: Function, onSaveText: Function, onToggleView: Function,
 *          view?: "rendered"|"raw"}} options
 */
export function renderPreview(data, options = {}) {
  const { view = "rendered" } = options;

  if (data.unavailableReason && !data.text && !isMedia(data.kind)) {
    return messageBlock("Preview unavailable", data.unavailableReason);
  }
  if (data.unavailableReason && isMedia(data.kind)) {
    return messageBlock("Preview unavailable", data.unavailableReason);
  }

  switch (data.kind) {
    case "image":
      return renderImage(data);
    case "audio":
      return renderAudio(data, options);
    case "video":
      return renderVideo(data, options);
    case "pdf":
      return renderPdf(data);
    case "markdown":
      return renderMarkdown(data, options, view);
    case "parquet":
      return data.table
        ? renderTable(data, options)
        : messageBlock(
            "Preview unavailable",
            data.unavailableReason ?? "This Parquet file could not be read.",
          );
    case "json":
    case "csv":
    case "code":
    case "text":
      return renderText(data, options);
    default:
      return messageBlock(
        "Preview unavailable",
        data.unavailableReason ??
          `No in-app preview for ${kindLabel(data.kind).toLowerCase()} content. Download the file to inspect it locally.`,
      );
  }
}

function isMedia(kind) {
  return kind === "image" || kind === "audio" || kind === "video" || kind === "pdf";
}

function messageBlock(title, text) {
  return el("div", { class: "preview-message", "data-testid": "preview-unavailable" }, [
    el("h3", { text: title }),
    el("p", { text }),
  ]);
}

function infoBar(data, extra = []) {
  const bits = [humanSize(data.size), data.contentType];
  if (data.etag) bits.push(`etag ${String(data.etag).slice(0, 10)}`);
  return el("div", { class: "preview-toolbar" }, [
    el("span", { class: "muted", text: bits.filter(Boolean).join(" · ") }),
    el("span", { style: { flex: "1" } }),
    ...extra,
  ]);
}

function truncatedNotice(data) {
  if (!data.truncated) return null;
  return el("div", { class: "preview-truncated", "data-testid": "preview-truncated" }, [
    el("span", { text: "Showing only the beginning of the file." }),
  ]);
}

function copyButton(text) {
  return el("button", {
    class: "btn btn--ghost btn--sm",
    text: "Copy",
    onClick: async () => {
      const ok = await copyText(text);
      if (ok) toastOk("Copied to the clipboard.");
      else toastError("The clipboard is not available.");
    },
  });
}

// ------------------------------------------------------------------- renderers

function renderImage(data) {
  const frame = el("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "1",
      minHeight: "200px",
      overflow: "auto",
      padding: "8px",
    },
  });
  const image = el("img", {
    class: "preview-image",
    src: data.streamUrl,
    alt: data.key,
    "data-testid": "preview-image",
    onError: () => {
      clear(frame);
      frame.append(
        messageBlock(
          "Cannot render this image",
          "The browser cannot decode this format. Download the file and open it locally.",
        ),
      );
    },
  });
  frame.append(image);
  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data),
    truncatedNotice(data),
    frame,
  ]);
}

function renderAudio(data, { onDownload }) {
  const audio = el("audio", {
    class: "preview-media",
    src: data.streamUrl,
    controls: true,
    preload: "metadata",
    "data-testid": "preview-audio",
  });
  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data),
    el("div", { class: "preview-audio" }, [
      audio,
      el("p", {
        class: "muted",
        style: { marginTop: "10px" },
        text: "Audio streams straight from S3 — seeking works without downloading the whole file.",
      }),
      el("button", { class: "btn", text: "Download", onClick: onDownload }),
    ]),
  ]);
}

function renderVideo(data, { onDownload }) {
  const video = el("video", {
    class: "preview-media",
    src: data.streamUrl,
    controls: true,
    preload: "metadata",
    playsinline: true,
    "data-testid": "preview-video",
    style: { maxHeight: "60vh", background: "#000" },
  });
  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data),
    el("div", { style: { padding: "8px" } }, [video]),
    el("div", { style: { padding: "0 12px 12px" } }, [
      el("p", {
        class: "muted",
        text: "Ranged reads are used, so playback starts immediately and seeking works.",
      }),
      el("button", { class: "btn", text: "Download", onClick: onDownload }),
    ]),
  ]);
}

function renderPdf(data) {
  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data),
    el("iframe", {
      class: "preview-frame",
      src: data.streamUrl,
      title: data.key,
      "data-testid": "preview-pdf",
    }),
  ]);
}

function renderMarkdown(data, { onToggleView }, view) {
  const text = data.text ?? "";
  const controls = [
    el("div", { class: "field__row", style: { gap: "2px" } }, [
      el("button", {
        class: `btn btn--sm ${view === "rendered" ? "btn--primary" : "btn--ghost"}`,
        text: "Rendered",
        "data-testid": "md-view-rendered",
        onClick: () => onToggleView("rendered"),
      }),
      el("button", {
        class: `btn btn--sm ${view === "raw" ? "btn--primary" : "btn--ghost"}`,
        text: "Raw",
        "data-testid": "md-view-raw",
        onClick: () => onToggleView("raw"),
      }),
    ]),
    copyButton(text),
  ];

  const body =
    view === "raw"
      ? el("pre", { class: "preview-code", "data-testid": "preview-code" }, [el("code", { text })])
      : el("div", {
          class: "preview-markdown",
          "data-testid": "preview-markdown",
          html: sanitize(marked.parse(text)),
        });

  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data, controls),
    truncatedNotice(data),
    body,
  ]);
}

/**
 * Which highlighter language a key should use.
 *
 * Orders of preference: the exact file name, then the extension, then — for
 * files whose type is unknown — detection over a short candidate list. Falling
 * back to plain text is deliberate: guessing wildly paints the whole file one
 * colour, which reads worse than no colour at all.
 */
export function resolveLanguage(key, text) {
  const name = key.toLowerCase().split("/").pop() ?? "";
  const byName = FILENAME_LANGUAGE[name];
  if (byName) return byName;

  const byExtension = EXTENSION_LANGUAGE[extensionOf(key)];
  if (byExtension) return byExtension;

  // Detection runs every registered grammar over the text, so it is only worth
  // the CPU on genuinely small files. Big ones get the extension mapping or
  // plain text.
  if (text && text.length <= DETECT_MAX_BYTES && typeof hljs.highlightAuto === "function") {
    try {
      const result = hljs.highlightAuto(text, DETECT_CANDIDATES);
      const language = result.language;
      // `plaintext` or nothing means detection was not conclusive.
      if (language && language !== "plaintext" && result.relevance > 2) return language;
    } catch {
      /* detection is best-effort */
    }
  }
  return null;
}

function renderText(data, options) {
  const text = data.text ?? "";
  const language = resolveLanguage(data.key, text);
  const code = el("code");

  // CSV/TSV get a real table; everything else gets syntax highlighting.
  if (data.kind === "csv" || (language === undefined && /\.(csv|tsv)$/i.test(data.key))) {
    return renderCsv(data, text, options);
  }

  code.className = "hljs";
  if (language && hljs.getLanguage(language)) {
    try {
      code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      code.textContent = text;
    }
  } else if (text.length <= DETECT_MAX_BYTES) {
    // Unknown type (an extension we do not map): let the registered languages
    // compete, constrained to a short candidate list.
    try {
      const guess = hljs.highlightAuto(text, DETECT_CANDIDATES);
      code.innerHTML = guess.value;
    } catch {
      code.textContent = text;
    }
  } else {
    code.textContent = text;
  }

  const pretty = language === "json" ? tryPrettyJson(text) : null;
  const shown = pretty ?? text;

  if (pretty && code.innerHTML) {
    try {
      code.className = "hljs";
      code.innerHTML = hljs.highlight(pretty, { language: "json", ignoreIllegals: true }).value;
    } catch {
      code.textContent = pretty;
    }
  }

  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data, [copyButton(shown)]),
    truncatedNotice(data),
    el("pre", { class: "preview-code", "data-testid": "preview-code" }, [code]),
  ]);
}

function tryPrettyJson(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

function renderCsv(data, text, options) {
  const delimiter = /\.tsv$/i.test(data.key) ? "\t" : detectDelimiter(text);
  const rows = parseDelimited(text, delimiter).slice(0, 500);
  const table = el("table", {}, [
    el(
      "thead",
      {},
      [el("tr", {}, (rows[0] ?? []).map((cell) => el("th", { text: cell })))],
    ),
    el(
      "tbody",
      {},
      rows.slice(1).map((row) => el("tr", {}, row.map((cell) => el("td", { text: cell })))),
    ),
  ]);
  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data, [copyButton(text)]),
    el("div", { class: "preview-markdown", "data-testid": "preview-table" }, [
      table,
      rows.length >= 500
        ? el("p", { class: "muted", text: "Only the first 500 rows are shown." })
        : null,
    ]),
  ]);
}

/** Generic table renderer, used for Parquet (CSV has its own parser). */
function renderTable(data, options) {
  const table = data.table;
  const node = el("table", {}, [
    el(
      "thead",
      {},
      [el("tr", {}, table.columns.map((column) => el("th", { text: column, title: column })))],
    ),
    el(
      "tbody",
      {},
      table.rows.map((row) =>
        el("tr", {}, table.columns.map((_, index) => el("td", { text: row[index] ?? "" }))),
      ),
    ),
  ]);

  const notes = [];
  if (table.truncatedRows) {
    notes.push(`Showing the first ${table.rows.length} of ${table.totalRows.toLocaleString()} rows.`);
  }
  if (table.truncatedColumns) {
    notes.push(`Showing the first ${table.columns.length} columns.`);
  }

  return el("div", { style: { display: "flex", flexDirection: "column", height: "100%" } }, [
    infoBar(data, options.onDownload ? [el("button", {
      class: "btn btn--ghost btn--sm",
      text: "Download",
      onClick: options.onDownload,
    })] : []),
    el("div", { class: "preview-markdown preview-table-wrap", "data-testid": "preview-table" }, [
      table.rows.length ? node : el("p", { class: "muted", text: "The file has no rows." }),
      ...notes.map((note) => el("p", { class: "muted", text: note })),
      el("p", {
        class: "muted",
        text: `${table.columns.length} column(s) · ${table.totalRows.toLocaleString()} row(s) in the file`,
      }),
    ]),
  ]);
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/** Minimal RFC4180-ish parser: handles quotes and escaped quotes. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
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
 * small and explicit, and the panel is the only place where markup is produced.
 */
export function sanitize(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  walk(template.content);
  return template.innerHTML;
}

function walk(root) {
  for (const node of [...root.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    if (!ALLOWED_TAGS.has(node.tagName)) {
      // Keep the text of unknown tags, drop the tag itself.
      const text = document.createTextNode(node.textContent ?? "");
      node.replaceWith(text);
      continue;
    }

    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) {
        node.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !SAFE_URL.test(attr.value.trim())) {
        node.removeAttribute(attr.name);
      }
    }
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("rel", "noreferrer noopener");
      node.setAttribute("target", "_blank");
    }
    if (node.tagName === "INPUT") {
      node.setAttribute("disabled", "");
    }
    walk(node);
  }
}
