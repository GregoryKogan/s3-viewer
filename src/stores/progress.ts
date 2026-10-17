import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/lib/ipc";
import type { ProgressView } from "@/types";

/** Transfers surface: polling the backend progress list. */
export const useProgressStore = defineStore("transfers", () => {
  const items = ref<ProgressView[]>([]);
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * When each transfer stopped running.
   *
   * The backend keeps its progress list until it is told to clear it; leaving a
   * finished download on screen forever is noise, so the panel forgets them on
   * its own after a few seconds.
   */
  const finishedAt = new Map<string, number>();
  const LINGER_MS = 7000;

  const running = computed(() => items.value.filter((item) => item.state === "running"));

  async function poll() {
    let snapshot: ProgressView[];
    try {
      snapshot = await api.transferProgress();
    } catch {
      return; // keep the previous snapshot
    }

    const now = Date.now();
    for (const item of snapshot) {
      if (item.state === "running") finishedAt.delete(item.id);
      else if (!finishedAt.has(item.id)) finishedAt.set(item.id, now);
    }

    items.value = snapshot
      .filter((item) => {
        if (item.state === "running") return true;
        const at = finishedAt.get(item.id);
        return at === undefined || now - at < LINGER_MS;
      })
      .map((item) => item);

    // Forget ids the backend no longer reports, so the map cannot grow.
    const live = new Set(snapshot.map((item) => item.id));
    for (const id of [...finishedAt.keys()]) {
      if (!live.has(id)) finishedAt.delete(id);
    }
  }

  function start() {
    if (timer) return;
    void poll();
    timer = setInterval(poll, 700);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  async function clear() {
    await api.clearTransfers().catch(() => {});
    finishedAt.clear();
    items.value = [];
  }

  /** Wait for one queued transfer to settle. */
  async function waitFor(id: string, timeoutMs = 120_000): Promise<ProgressView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await poll();
      const item = items.value.find((entry) => entry.id === id);
      if (item && item.state !== "running") return item;
      if (Date.now() > deadline) {
        return { id, label: "", done: 0, state: "failed", error: "timed out waiting for the transfer" };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return { items, running, poll, start, stop, clear, waitFor };
});
