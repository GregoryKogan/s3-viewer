/**
 * DOM marking for find-in-file.
 *
 * `findMatches` reports UTF-16 offsets into the source string; by the time the
 * preview paints, highlight.js has split that string into nested `<span>`s and
 * text nodes. These helpers map one onto the other by splitting and re-wrapping
 * text nodes in place, never by rewriting `innerHTML`: the token spans, their
 * classes and the exact whitespace stay intact, so the offsets still describe
 * what is on screen.
 */

import type { MatchRange } from "@/lib/textSearch";

export const HIT_CLASS = "preview-find-hit";
export const ACTIVE_CLASS = "preview-find-active";

/** The part of one text node that a single match covers. */
interface TextRun {
  node: Text;
  /** Start of the run, relative to the node's data. */
  from: number;
  /** End of the run, relative to the node's data. */
  to: number;
}

/**
 * Unwrap every hit mark under `root` and normalise the parents it touched.
 *
 * Unwrapping alone would leave one text node per split and the next paint would
 * split those again. `normalize()` merges the adjacent text nodes back into the
 * single node highlight.js produced, so a second `markMatches` with the same
 * ranges finds the same offsets. Only nodes that were adjacent by construction
 * are merged, so whitespace is preserved and the text is restored exactly.
 */
export function clearMarks(root: ParentNode): void {
  const parents = new Set<Node>();
  for (const mark of root.querySelectorAll<HTMLElement>(`mark.${HIT_CLASS}`)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parents.add(parent);
    let child = mark.firstChild;
    while (child) {
      parent.insertBefore(child, mark);
      child = mark.firstChild;
    }
    parent.removeChild(mark);
  }
  for (const parent of parents) parent.normalize();
}

/**
 * Wrap each match in its own `<mark data-find-index="N">`, where `N` is the
 * match's index in `matches`. A match can straddle the spans highlight.js
 * emitted; then it becomes one mark per text node, and every mark of that match
 * carries the same index.
 *
 * `matches` must be in source order and non-overlapping, exactly as
 * `findMatches` returns them. Runs are split last to first: a split only ever
 * shortens the node to the left of the cut, so the offsets of every not yet
 * processed (earlier) run stay valid.
 */
export function markMatches(root: ParentNode, matches: MatchRange[]): HTMLElement[] {
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

  // One forward pass collects every run while the offsets are still those of the
  // untouched tree. Scanning the node list once per match would be O(matches ×
  // nodes), which a 2 MB log with a short query makes expensive on every
  // keystroke; this pass is O(nodes + runs).
  const runs: TextRun[][] = matches.map(() => []);
  let next = 0;
  for (let index = 0; index < nodes.length && next < matches.length; index += 1) {
    const nodeStart = starts[index];
    const nodeEnd = nodeStart + nodes[index].data.length;
    while (next < matches.length && matches[next].end <= nodeStart) next += 1;
    for (let match = next; match < matches.length; match += 1) {
      if (matches[match].start >= nodeEnd) break;
      const from = Math.max(matches[match].start, nodeStart) - nodeStart;
      const to = Math.min(matches[match].end, nodeEnd) - nodeStart;
      if (from < to) runs[match].push({ node: nodes[index], from, to });
    }
  }

  // Splitting backwards keeps the collected offsets valid. Marks are collected in
  // reverse and flipped so the caller gets them in match order, and each match's
  // own marks in document order.
  const marks: HTMLElement[][] = matches.map(() => []);
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const matchRuns = runs[index];
    for (let run = matchRuns.length - 1; run >= 0; run -= 1) {
      const mark = wrapRun(matchRuns[run], index);
      if (mark) marks[index].push(mark);
    }
    marks[index].reverse();
  }
  return marks.flat();
}

/** Wrap one run in a mark, splitting its text node so only the run moves. */
function wrapRun(run: TextRun, index: number): HTMLElement | null {
  const parent = run.node.parentNode;
  if (!parent) return null;

  // End first, then start: the second split is local to the node that now ends
  // at the run's end, so afterwards the run is exactly that node's data.
  let middle: Text = run.node;
  if (run.to < middle.data.length) middle.splitText(run.to);
  if (run.from > 0) middle = middle.splitText(run.from);

  const mark = document.createElement("mark");
  mark.className = HIT_CLASS;
  mark.dataset.findIndex = String(index);
  parent.replaceChild(mark, middle);
  mark.appendChild(middle);
  return mark;
}
