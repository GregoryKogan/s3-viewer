import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * Find-in-file state for the text preview.
 *
 * The matcher is pure and the highlights are DOM work, so the store holds only
 * what the bar and the text body must agree on: the query, the three options,
 * and which hit is active. Not persisted (D6): the options survive files and a
 * closed bar for the session, a restart starts clean like the rest of the
 * preview state.
 */
export const usePreviewFindStore = defineStore("previewFind", () => {
  /** The bar is visible. */
  const open = ref(false);
  const query = ref("");
  const caseSensitive = ref(false);
  const wholeWord = ref(false);
  const regex = ref(false);
  /** Index into the current match list; -1 when no hit is active. */
  const activeIndex = ref(-1);
  const matchCount = ref(0);
  /** Bumped by `show` so an already-mounted bar re-focuses its input. */
  const focusNonce = ref(0);

  function show() {
    open.value = true;
    focusNonce.value += 1;
  }

  function hide() {
    open.value = false;
    activeIndex.value = -1;
    matchCount.value = 0;
  }

  /** A new file starts with an empty query but keeps the options (D6). */
  function resetQuery() {
    query.value = "";
    activeIndex.value = -1;
  }

  function setQuery(value: string) {
    query.value = value;
    activeIndex.value = -1;
  }

  function setActive(index: number) {
    activeIndex.value = index;
  }

  function setMatchCount(count: number) {
    matchCount.value = count;
  }

  /**
   * Move the active hit by `delta`, wrapping at both ends; a count of 0 is a
   * no-op.
   *
   * From -1 (nothing active yet) a forward step lands on 0 and a backward step
   * on the last hit, because that is the hit the bar shows before the first
   * active one is set.
   */
  function step(delta: number) {
    const count = matchCount.value;
    if (count <= 0) return;
    // "Nothing active" counts as before the first hit when moving forward and
    // after the last when moving backward, so both directions wrap naturally.
    const from = activeIndex.value >= 0 ? activeIndex.value : delta < 0 ? count : -1;
    activeIndex.value = ((from + delta) % count + count) % count;
  }

  function toggleCase() {
    caseSensitive.value = !caseSensitive.value;
  }

  /** Whole word is ignored in regex mode (D4), so the toggle refuses to move. */
  function toggleWholeWord() {
    if (regex.value) return;
    wholeWord.value = !wholeWord.value;
  }

  /** Turning regex on clears whole word for the same reason (D4). */
  function toggleRegex() {
    regex.value = !regex.value;
    if (regex.value) wholeWord.value = false;
  }

  return {
    open,
    query,
    caseSensitive,
    wholeWord,
    regex,
    activeIndex,
    matchCount,
    focusNonce,
    show,
    hide,
    resetQuery,
    setQuery,
    setActive,
    setMatchCount,
    step,
    toggleCase,
    toggleWholeWord,
    toggleRegex,
  };
});
