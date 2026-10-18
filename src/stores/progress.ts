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

  /**
   * Wait for a batch of transfers to settle with one shared poll loop.
   *
   * There is no deadline on purpose: a large upload legitimately outlasts any
   * fixed cap, and answering "timed out" would toast a false failure and reload
   * the folder while the PUT is still running. A genuinely hung transfer leaves
   * this pending; the transfers panel stays visible and Task 6 adds cancel.
   */
  async function waitForAll(ids: string[]): Promise<ProgressView[]> {
    const settled = new Map<string, ProgressView>();
    const remaining = new Set(ids);
    while (remaining.size > 0) {
      await poll();
      // One index per snapshot, so a large batch does not fan out into a
      // `find` per id per tick.
      const current = new Map(items.value.map((item) => [item.id, item]));
      for (const id of [...remaining]) {
        const item = current.get(id);
        if (!item || item.state === "running") continue;
        settled.set(id, item);
        remaining.delete(id);
      }
      if (remaining.size > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return ids.map((id) => settled.get(id)!);
  }

  return { items, running, poll, start, stop, clear, waitFor, waitForAll };
});
