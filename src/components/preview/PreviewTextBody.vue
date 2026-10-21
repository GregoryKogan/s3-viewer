<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import FindBar from "./FindBar.vue";
import { ACTIVE_CLASS, HIT_CLASS, clearMarks, markMatches } from "@/lib/searchMarks";
import { findMatches } from "@/lib/textSearch";
import { usePreviewFindStore } from "@/stores/previewFind";

/**
 * The scrollable text of a preview plus the find-in-file bar over it.
 *
 * Both text renderers (highlighted code and raw Markdown) mount this, so the
 * matcher, the marks and the bar have one home: the renderers only decide what
 * the text is and whether it arrives highlighted.
 */
const props = defineProps<{
  source: string;
  markup: string | null;
}>();

const find = usePreviewFindStore();

const scroller = ref<HTMLPreElement | null>(null);
const code = ref<HTMLElement | null>(null);

/**
 * The string the matcher and the marks agree on (D9).
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

/** The index the marks were last painted with, so only a real move scrolls. */
let painted = -1;

/**
 * Give the active hit its class and bring it into view.
 *
 * A repaint replaces every mark, so the class has to be re-applied even when
 * `activeIndex` did not move. Scrolling is the part that waits for an actual
 * change: otherwise every keystroke would jump the viewport.
 */
function paintActive() {
  const root = code.value;
  if (!root) return;
  const index = find.activeIndex;
  let first: HTMLElement | null = null;
  for (const mark of root.querySelectorAll<HTMLElement>(`mark.${HIT_CLASS}`)) {
    if (mark.dataset.findIndex === String(index)) {
      mark.classList.add(ACTIVE_CLASS);
      first ??= mark;
    } else {
      mark.classList.remove(ACTIVE_CLASS);
    }
  }
  // A repaint resets the store to -1 just before it sets the first hit. That
  // round trip is not a move, so leave `painted` alone: typing must not
  // recentre the view on every keystroke.
  if (index < 0) return;
  if (index === painted) return;
  painted = index;
  first?.scrollIntoView({ block: "center", inline: "nearest" });
}

/**
 * Repaint the marks after the rendered text or the search changed.
 *
 * `nextTick` comes first: `v-html` replaces the whole subtree, and marks built
 * before that replacement would be thrown away with the old content.
 */
async function repaint() {
  await nextTick();
  const root = code.value;
  if (!root) return;
  clearMarks(root);

  const { matches, error } = result.value;
  // A closed bar shows no count, and `hide()` promises zero: a retained query
  // must not leave `matchCount` at the old list length.
  find.setMatchCount(find.open ? matches.length : 0);

  // The counter reads `activeIndex + 1`, so an index left over from a longer
  // previous list would show "8 of 2". A repaint replaces the marks anyway, so
  // it starts over at the first hit, or at none.
  if (!find.open || !find.query || error) {
    find.setActive(-1);
  } else {
    markMatches(root, matches);
    find.setActive(matches.length ? 0 : -1);
  }
  paintActive();
}

/** Hiding the bar is the parent's decision; the marks and the keyboard are ours. */
function closeFind() {
  find.hide();
  const root = code.value;
  if (root) clearMarks(root);
  scroller.value?.focus();
}

watch(() => find.activeIndex, paintActive);

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

defineExpose({ closeFind });
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
