<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppButton from "@/components/ui/AppButton.vue";
import type { PreviewData } from "@/types";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{ data: PreviewData }>();

const ui = useUiStore();
const media = ref<HTMLMediaElement | null>(null);

const isAudio = computed(() => props.data.kind === "audio");

/**
 * A player that never reaches the output looks exactly like a working one: the
 * header arrived, so the duration is right, and only the clock stays at 0:00.
 * WebKit's player can get stuck that way — after the machine sleeps, notably —
 * and it does not recover by itself.
 */
const stalled = ref(false);
/** Bumped to rebuild the element, which is the only thing that unsticks it. */
const generation = ref(0);
let watchdog: ReturnType<typeof setTimeout> | undefined;

function stopWatchdog() {
  if (watchdog !== undefined) clearTimeout(watchdog);
  watchdog = undefined;
}

/**
 * Dropping an element out of the DOM is not enough: without this, WebKit keeps
 * the player and its output device for every file previewed in this window, and
 * the next file can end up silently mute. Abort the source, then drop it.
 */
function release(el: HTMLMediaElement | null) {
  if (!el) return;
  el.pause();
  el.removeAttribute("src");
  el.load();
}

/** Template ref: releases the outgoing player whenever the element is replaced. */
function bindMedia(el: unknown) {
  const next = (el as HTMLMediaElement | null) ?? null;
  if (next === media.value) return;
  release(media.value);
  media.value = next;
}

/**
 * Playback is wedged when the player says it plays, the data is there, and the
 * clock still sits at zero. While the stream is merely loading, `readyState`
 * stays below `HAVE_CURRENT_DATA`, so a slow file is never mistaken for a stuck
 * one. Rebuild the element once behind the user's back; only if that fails too
 * do we say anything.
 */
function onPlay(event: Event) {
  stopWatchdog();
  const el = event.target as HTMLMediaElement;
  const from = el.currentTime;
  watchdog = setTimeout(() => {
    if (el !== media.value || el.paused || el.currentTime > from) return;
    if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (generation.value > 0) {
      stalled.value = true;
      return;
    }
    generation.value += 1;
    void nextTick(() => media.value?.play().catch(() => undefined));
  }, 3000);
}

function retry() {
  stalled.value = false;
  generation.value += 1;
}

onBeforeUnmount(() => {
  stopWatchdog();
  release(media.value);
});

// Hiding the panel only sets `hidden`; the element stays mounted, so an audio
// or video track would keep playing out of sight. Pause when it leaves view.
watch(
  () => ui.previewHidden,
  (hidden) => {
    if (hidden) media.value?.pause();
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center p-3">
    <div v-if="stalled" class="flex flex-col items-start gap-2" data-testid="preview-media-stalled">
      <p class="text-meta leading-relaxed text-muted">
        The player loaded this file but playback never started. Reload the player; if it stays
        silent, restart the app.
      </p>
      <AppButton size="sm" data-testid="preview-media-retry" @click="retry()">
        Reload player
      </AppButton>
    </div>

    <audio
      v-else-if="isAudio"
      :key="generation"
      :ref="bindMedia"
      :src="props.data.streamUrl"
      controls
      preload="metadata"
      class="w-full"
      data-keyscope
      data-testid="preview-audio"
      @play="onPlay"
      @error="stalled = true"
    />
    <video
      v-else
      :key="generation"
      :ref="bindMedia"
      :src="props.data.streamUrl"
      controls
      preload="metadata"
      playsinline
      class="max-h-full w-full rounded-control bg-black"
      data-keyscope
      data-testid="preview-video"
      @play="onPlay"
      @error="stalled = true"
    />
  </div>
</template>
