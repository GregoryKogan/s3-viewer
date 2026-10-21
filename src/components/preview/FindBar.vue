<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "@lucide/vue";
import AppButton from "@/components/ui/AppButton.vue";
import { usePreviewFindStore } from "@/stores/previewFind";

/**
 * The find-in-file bar for the text preview.
 *
 * The bar keeps no search state of its own: the query and the three options live
 * in the store, while the match list, its error and the active hit come down as
 * props from the body that computed them. In return the bar writes only through
 * the store's actions (`step`, `toggleCase`, ...) and reports `close`; hiding the
 * bar and handing the keyboard back to the scroller belong to the parent.
 */
const props = defineProps<{
  matchCount: number;
  error: string | null;
  capped: boolean;
  activeIndex: number;
}>();

const emit = defineEmits<{ close: [] }>();

const find = usePreviewFindStore();

const input = ref<HTMLInputElement | null>(null);

/**
 * What the counter says, or `null` when it should not be there at all.
 *
 * `activeIndex` stays -1 until the body marks the first hit, and the bar shows
 * `0 of N` in that moment instead of hiding the count: how many hits a query has
 * is worth knowing before one of them is picked.
 */
const counter = computed<{ text: string; danger: boolean } | null>(() => {
  if (props.error) return { text: "Invalid regex", danger: true };
  if (!find.query) return null;
  if (props.matchCount === 0) return { text: "No results", danger: true };
  const more = props.capped ? "+" : "";
  return { text: `${props.activeIndex + 1} of ${props.matchCount}${more}`, danger: false };
});

/**
 * Focus and select the whole query when the bar opens or `show` bumps the nonce.
 *
 * Deliberately not an unconditional `@focus` handler (D7): the ⌘F gesture
 * re-selects the old query the way VS Code does, but a plain click inside the
 * field has to keep the caret where the user just put it.
 */
watch(
  () => [find.open, find.focusNonce] as const,
  async ([open]) => {
    if (!open) return;
    await nextTick();
    input.value?.focus({ preventScroll: true });
    input.value?.select();
  },
  { immediate: true },
);

/**
 * The physical letter behind a keydown.
 *
 * On macOS, holding Option rewrites `event.key` (`⌥C` arrives as `ç`), so the
 * modifier shortcuts have to read the layout-independent `event.code`; synthetic
 * events without a code fall back to the key itself.
 */
function letterOf(event: KeyboardEvent): string {
  const fromCode = /^Key([A-Z])$/.exec(event.code);
  return (fromCode?.[1] ?? event.key).toLowerCase();
}

/**
 * The bar's own keys, stopped at the root so the window-level shell shortcuts
 * never see them (⌘F opening the folder filter, Enter opening the focused
 * object). Anything not handled here is left alone and bubbles normally.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    emit("close");
    return;
  }
  if (event.key === "Enter") {
    event.stopPropagation();
    find.step(event.shiftKey ? -1 : 1);
    return;
  }

  const meta = event.metaKey || event.ctrlKey;
  if (!meta) return;

  if (letterOf(event) === "f") {
    // ⌘F inside the bar is the same gesture that opened it: re-select the query.
    event.preventDefault();
    event.stopPropagation();
    input.value?.focus({ preventScroll: true });
    input.value?.select();
    return;
  }

  if (!event.altKey) return;
  const letter = letterOf(event);
  if (letter === "c") find.toggleCase();
  else if (letter === "w") find.toggleWholeWord();
  else if (letter === "r") find.toggleRegex();
  else return;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * The three option toggles are plain buttons rather than `AppButton`s: the
 * pressed look is a soft accent fill, and a ghost `AppButton`'s own
 * `bg-transparent text-content` is emitted after the active recipe in the
 * compiled stylesheet, so it would win the cascade and hide the state. The
 * geometry still matches `AppButton`'s `sm` size (h-6, 14 px icon).
 */
const TOGGLE_CLASS =
  "grid h-6 shrink-0 place-items-center rounded-[4px] px-2 transition-colors " +
  "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent";
</script>

<template>
  <div
    class="absolute top-2 right-2 z-10 flex h-8 items-center gap-0.5 rounded-control border border-line-strong bg-elevated px-1 text-meta shadow-lg"
    data-testid="find-bar"
    @keydown="onKeydown"
  >
    <input
      ref="input"
      v-model="find.query"
      type="text"
      class="w-52 bg-transparent px-1.5 text-content placeholder:text-subtle outline-none"
      placeholder="Find"
      aria-label="Find in file"
      autocomplete="off"
      spellcheck="false"
      data-testid="find-input"
    />

    <span
      v-if="counter"
      class="tabular shrink-0 px-1 whitespace-nowrap"
      :class="counter.danger ? 'text-danger' : 'text-muted'"
      data-testid="find-counter"
    >{{ counter.text }}</span>

    <AppButton
      size="sm"
      variant="ghost"
      :icon="ChevronUp"
      :disabled="props.matchCount === 0"
      aria-label="Previous match"
      title="Previous match (⇧↩)"
      data-testid="find-prev"
      @click="find.step(-1)"
    />
    <AppButton
      size="sm"
      variant="ghost"
      :icon="ChevronDown"
      :disabled="props.matchCount === 0"
      aria-label="Next match"
      title="Next match (↩)"
      data-testid="find-next"
      @click="find.step(1)"
    />

    <button
      type="button"
      :class="[
        TOGGLE_CLASS,
        find.caseSensitive ? 'bg-accent/15 text-accent-text' : 'text-muted hover:bg-hover',
      ]"
      :aria-pressed="find.caseSensitive"
      aria-label="Match case"
      title="Match Case (⌥⌘C)"
      data-testid="find-case"
      @click="find.toggleCase()"
    >
      <CaseSensitive class="size-3.5" />
    </button>
    <button
      type="button"
      :disabled="find.regex"
      :class="[
        TOGGLE_CLASS,
        find.wholeWord ? 'bg-accent/15 text-accent-text' : 'text-muted hover:bg-hover',
      ]"
      :aria-pressed="find.wholeWord"
      aria-label="Match whole word"
      title="Match Whole Word (⌥⌘W)"
      data-testid="find-whole-word"
      @click="find.toggleWholeWord()"
    >
      <WholeWord class="size-3.5" />
    </button>
    <button
      type="button"
      :class="[
        TOGGLE_CLASS,
        find.regex ? 'bg-accent/15 text-accent-text' : 'text-muted hover:bg-hover',
      ]"
      :aria-pressed="find.regex"
      aria-label="Use regular expression"
      title="Use Regular Expression (⌥⌘R)"
      data-testid="find-regex"
      @click="find.toggleRegex()"
    >
      <Regex class="size-3.5" />
    </button>

    <AppButton
      size="sm"
      variant="ghost"
      :icon="X"
      aria-label="Close find"
      title="Close (Esc)"
      data-testid="find-close"
      @click="emit('close')"
    />
  </div>
</template>
