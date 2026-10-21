/**
 * Find-in-file highlights through the CSS Custom Highlight API.
 *
 * `findMatches` reports UTF-16 offsets into the source string; by the time the
 * preview paints, highlight.js has split that string into nested `<span>`s and
 * text nodes. These helpers map one onto the other once per repaint and register
 * one `Range` per match under two `::highlight()` names. No DOM node is touched:
 * the token spans, their classes and the exact whitespace stay as highlight.js
 * emitted them, so the offsets still describe what is on screen.
 */

import type { MatchRange } from "@/lib/textSearch";

export const HIT_HIGHLIGHT = "preview-find-hit";
export const ACTIVE_HIGHLIGHT = "preview-find-active";

/**
 * The highlight registry, or null on a webview without the CSS Custom Highlight
 * API (WebKitGTK < 2.44). The caller still gets its ranges there — the counter
 * and Enter/⇧Enter keep working, only the paint is missing.
 */
function registry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined"
    ? CSS.highlights
    : null;
}

/** Delete both registrations; a webview without the API has nothing to delete. */
export function clearHighlights(): void {
  const highlights = registry();
  highlights?.delete(HIT_HIGHLIGHT);
  highlights?.delete(ACTIVE_HIGHLIGHT);
}

/**
 * Build one `Range` per match in `root` and register them all as
 * `preview-find-hit`. Returns the ranges in match order so the caller can
 * promote one of them to the active highlight.
 *
 * `matches` must be in source order and non-overlapping, exactly as
 * `findMatches` returns them. The registry is assumed cleared by the caller: an
 * empty list paints nothing and returns nothing rather than leaving stale ranges
 * from the previous query.
 *
 * Unlike the old mark wrapper this never splits a text node, so the offsets from
 * the single walk stay valid: a range only reads the start of the first text node
 * a match touches and the end of the last, even when the match straddles two
 * highlight.js spans.
 */
export function paintMatches(root: ParentNode, matches: MatchRange[]): Range[] {
  if (!matches.length) return [];

  // The text nodes in document order, with the source offset each one starts at.
  const nodes: Text[] = [];
  const starts: number[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push(text);
    starts.push(offset);
    offset += text.data.length;
  }

  // One forward pass maps every match onto the first and last text node it
  // touches. Scanning the node list once per match would be O(matches × nodes),
  // which a 2 MB log with a short query makes expensive on every keystroke;
  // this pass is O(nodes + matches).
  const ranges = matches.map(() => new Range());
  const started = matches.map(() => false);
  let next = 0;
  for (let index = 0; index < nodes.length && next < matches.length; index += 1) {
    const nodeStart = starts[index];
    const nodeEnd = nodeStart + nodes[index].data.length;
    while (next < matches.length && matches[next].end <= nodeStart) next += 1;
    for (let match = next; match < matches.length; match += 1) {
      if (matches[match].start >= nodeEnd) break;
      const from = Math.max(matches[match].start, nodeStart) - nodeStart;
      const to = Math.min(matches[match].end, nodeEnd) - nodeStart;
      if (from >= to) continue;
      const range = ranges[match];
      if (!started[match]) {
        range.setStart(nodes[index], from);
        started[match] = true;
      }
      range.setEnd(nodes[index], to);
    }
  }

  registry()?.set(HIT_HIGHLIGHT, new Highlight(...ranges));
  return ranges;
}

/**
 * Make `range` the only active highlight, or remove it when there is none.
 *
 * The registration is replaced on every repaint and every step, and it is made
 * after `paintMatches`, so the active range paints on top of the hit tint it
 * overlaps.
 */
export function setActiveHighlight(range: Range | null): void {
  const highlights = registry();
  if (!highlights) return;
  if (range) highlights.set(ACTIVE_HIGHLIGHT, new Highlight(range));
  else highlights.delete(ACTIVE_HIGHLIGHT);
}
