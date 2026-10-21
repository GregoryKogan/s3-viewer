/** Find-in-file matcher. Pure, DOM-free, no state; the bar and the store sit on top. */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface FindResult {
  matches: MatchRange[];
  /** Non-null when `regex` is on and the query does not compile. */
  error: string | null;
  /** True when `MAX_MATCHES` cut the list short. */
  capped: boolean;
}

/** Stop collecting here: a 2 MB log matches millions of times. */
export const MAX_MATCHES = 2000;

/** Escape a literal query so it cannot act as a pattern. */
export function escapeRegExp(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All non-overlapping matches of `query` in `text`, in source order. */
export function findMatches(text: string, query: string, options: FindOptions): FindResult {
  if (!query || !text) return { matches: [], error: null, capped: false };

  const source = options.regex ? query : escapeRegExp(query);
  const flags = `g${options.caseSensitive ? "" : "i"}u`;
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, flags);
  } catch (error) {
    return { matches: [], error: error instanceof Error ? error.message : String(error), capped: false };
  }

  const matches: MatchRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // `^`, `$`, `\b` and empty alternatives match without consuming input. They
    // cannot be highlighted, so step past the position instead of collecting it.
    // The step is a whole character: under the `u` flag a lastIndex inside a
    // surrogate pair is rounded back down, which would otherwise loop forever.
    if (end === start) {
      pattern.lastIndex = start + charWidthAt(text, start);
      continue;
    }

    // Whole-word is a literal-mode convenience; a regex query is taken as written.
    if (options.wholeWord && !options.regex && !isWholeWord(text, start, end)) continue;

    matches.push({ start, end });
    if (matches.length === MAX_MATCHES) return { matches, error: null, capped: true };
  }

  return { matches, error: null, capped: false };
}

/** A word character for the whole-word check: Unicode letters, digits and `_`. */
const WORD_CHAR = /^[\p{L}\p{N}_]$/u;

/** The full character ending at `index` — a surrogate pair is one character. */
function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text.slice(index - 1, index);
}

/** The full character starting at `index` — a surrogate pair is one character. */
function charAfter(text: string, index: number): string {
  if (index >= text.length) return "";
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

/** How many code units the character at `index` occupies: 2 for a surrogate pair. */
function charWidthAt(text: string, index: number): number {
  const high = text.charCodeAt(index);
  const low = text.charCodeAt(index + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 2 : 1;
}

function isWholeWord(text: string, start: number, end: number): boolean {
  return !WORD_CHAR.test(charBefore(text, start)) && !WORD_CHAR.test(charAfter(text, end));
}
