<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import FindBar from "./FindBar.vue";
import { clearHighlights, paintMatches, setActiveHighlight } from "@/lib/searchMarks";
import { findMatches } from "@/lib/textSearch";
import { usePreviewFindStore } from "@/stores/previewFind";

/**
 * The scrollable text of a preview plus the find-in-file bar over it.
 *
 * Both text renderers (highlighted code and raw Markdown) mount this, so the
 * the matcher, the highlights and the bar have one home: the renderers only
 * decide what the text is and whether it arrives highlighted.
 */
const props = defineProps<{
  source: string;
  markup: string | null;
}>();

const find = usePreviewFindStore();

const scroller = ref<HTMLPreElement | null>(null);
const code = ref<HTMLElement | null>(null);

/**
 * The string the matcher and the highlights agree on (D9).
 *
 * HTML parsing rewrites CRLF and CR to LF inside the `<pre>`, while `findMatches`
 * reports offsets into the string it was given. Running it on raw CRLF would
 * drift by one code unit per line break, so the search and the plain-text branch
 * both use the normalised string. `markup` is passed through untouched: the
 * parser normalises it the same way.
 */
const text = computed(() => props.source.replace(/\r\n?/g, "\n"));

const result = computed(() =>
  findMatches(text.value, find.query, {
    caseSensitive: find.caseSensitive,
    wholeWord: find.wholeWord,
    regex: find.regex,
  }),
);

/** The ranges the hit highlight was built from, in match order. */
let ranges: Range[] = [];

/** The index the highlights were last painted with, so only a real move scrolls. */
let painted = -1;

/**
 * Promote the active hit's range and bring it into view.
 *
 * A repaint replaces every range, so the active highlight is re-registered even
 * when `activeIndex` did not move. Scrolling is the part that waits for an
 * actual change: otherwise every keystroke would jump the viewport.
 */
function paintActive() {
  const index = find.activeIndex;
  const range = ranges[index] ?? null;
  setActiveHighlight(range);
  // A repaint resets the store to -1 just before it sets the first hit. That
  // round trip is not a move, so leave `painted` alone: typing must not
  // recentre the view on every keystroke.
  if (index < 0) return;
  if (index === painted) return;
  painted = index;

  // `scrollIntoView` is gone with the marks: centre the range's box in the
  // scroller's own box, and nudge horizontally only when the hit is clipped.
  const box = scroller.value;
  if (!range || !box) return;
  const rect = range.getBoundingClientRect();
  // A range left over from a replaced subtree has no box; scrolling to it would
  // jump the view to the top.
  if (!rect.width && !rect.height) return;
  const view = box.getBoundingClientRect();
  box.scrollTop += rect.top - view.top - (view.height - rect.height) / 2;
  if (rect.left < view.left) box.scrollLeft += rect.left - view.left;
  else if (rect.right > view.right) box.scrollLeft += rect.right - view.right;
}

/**
 * Repaint the highlights after the rendered text or the search changed.
 *
 * `nextTick` comes first: `v-html` replaces the whole subtree, and ranges built
 * before that replacement would point into detached nodes.
 */
async function repaint() {
  await nextTick();
  const root = code.value;
  if (!root) return;
  clearHighlights();
  ranges = [];

  const { matches, error } = result.value;
  find.matchCount = matches.length;

  // The counter reads `activeIndex + 1`, so an index left over from a longer
  // previous list would show "8 of 2". A repaint replaces the ranges anyway, so
  // it starts over at the first hit, or at none.
  if (!find.open || !find.query || error) {
    find.activeIndex = -1;
  } else {
    ranges = paintMatches(root, matches);
    find.activeIndex = matches.length ? 0 : -1;
  }
  paintActive();
}

/** Hiding the bar is the parent's decision; the highlights and the keyboard are ours. */
function closeFind() {
  find.hide();
  clearHighlights();
  scroller.value?.focus();
}

watch(() => find.activeIndex, paintActive);

/**
 * Reopening the bar is a new look at the file even when the query and the active
 * hit are the same as before: the user may have scrolled away, so the first hit
 * has to be brought back into view. Keeping the index guard for every other
 * repaint is what stops typing from recentring the view on each keystroke.
 */
watch(
  () => find.open,
  (open) => {
    if (open) painted = -1;
  },
);

/**
 * `immediate`: a body that mounts while the bar is already open (a raw Markdown
 * view, a re-keyed renderer) has marks to paint but no prop change to wake it.
 * `find.open` is watched too, or reopening the bar on a kept query would show a
 * counter and no highlights.
 */
watch(
  [
    () => props.source,
    () => props.markup,
    () => find.query,
    () => find.caseSensitive,
    () => find.wholeWord,
    () => find.regex,
    () => find.open,
  ],
  repaint,
  { immediate: true },
);
</script>

<template>
  <!-- `@container` is what the bar's counter and toggle rules query: without it
       they never come back as the preview widens (D10). -->
  <div class="relative @container flex min-h-0 flex-1 flex-col">
    <!-- eslint-disable-next-line vue/no-v-html -- produced by highlight.js from escaped text -->
    <pre
      ref="scroller"
      class="scrollbar min-h-0 flex-1 overflow-auto p-3 font-mono text-meta leading-relaxed whitespace-pre text-content"
      tabindex="-1"
      data-preview-scroll
      data-testid="preview-code"
    ><code v-if="markup !== null" ref="code" class="hljs" v-html="markup" /><code
      v-else
      ref="code"
      class="hljs"
    >{{ text }}</code></pre>

    <FindBar
      v-if="find.open"
      :match-count="find.matchCount"
      :error="result.error"
      :capped="result.capped"
      :active-index="find.activeIndex"
      @close="closeFind()"
    />
  </div>
</template>
