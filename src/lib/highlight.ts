/**
 * highlight.js, configured once.
 *
 * Only the grammars the app can actually name are registered: detection over
 * every bundled language is what made the old renderer crawl on big files.
 */

import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  cpp,
  csharp,
  css,
  dart,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  perl,
  php,
  plaintext,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

hljs.configure({ ignoreUnescapedHTML: true });

/** Highlight `text` as `language`, or return escaped text when it is not registered. */
export function highlight(text: string, language: string | null): string {
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      /* fall through to the plain rendering */
    }
  }
  return escapeHtml(text);
}

/** As `highlight`, but lets the registered grammars compete on small inputs. */
export function highlightDetected(text: string, candidates: string[]): string {
  try {
    return hljs.highlightAuto(text, candidates).value;
  } catch {
    return escapeHtml(text);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default hljs;
