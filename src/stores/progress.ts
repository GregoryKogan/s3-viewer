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

  /**
   * Retry actions registered by the feature that started a transfer.
   *
   * Only the owner knows how to repeat an upload (which path went to which key)
   * or a copy (which endpoints and prefixes were involved), so the store holds
   * opaque callbacks rather than trying to reconstruct the request.
   */
  const retries = ref(new Map<string, () => Promise<void>>());

  /**
   * Settled snapshots for transfers someone is still waiting on.
   *
   * `waitForAll` polls; if the user clears the panel between a transfer settling
   * and the next poll, the id disappears from the list. Caching the last settled
   * view for watched ids turns that race into the correct answer instead of a
   * wait that never ends.
   */
  const watched = new Set<string>();
  const settled = new Map<string, ProgressView>();

  /**
   * Ids whose failed/cancelled row was already retried.
   *
   * Failed and cancelled rows are kept until Clear or Retry (they carry the only
   * recovery affordance), so a successful retry must also suppress the old row
   * from the next snapshot instead of letting it pop back.
   */
  const suppressed = new Set<string>();

  const running = computed(() => items.value.filter((item) => item.state === "running"));

  /** Resolve an id that vanished from both the list and the cache. */
  function clearedOutcome(id: string): ProgressView {
    return {
      id,
      label: "cleared",
      done: 0,
      // Not success: a row that was cleared before its settle was observed is
      // terminal but unknown, so batch summaries must not report it as done.
      state: "cancelled",
      error: "the transfer was cleared before it settled",
    };
  }

  /** Refresh the list; returns false when the backend could not be asked. */
  async function poll(): Promise<boolean> {
    let snapshot: ProgressView[];
    try {
      snapshot = await api.transferProgress();
    } catch {
      return false; // keep the previous snapshot
    }

    const now = Date.now();
    for (const item of snapshot) {
      if (item.state === "running") {
        finishedAt.delete(item.id);
        continue;
      }
      if (item.state === "done") {
        if (!finishedAt.has(item.id)) finishedAt.set(item.id, now);
        // A completed transfer no longer needs its retry callback; keeping it
        // would grow the map for the life of the session.
        if (retries.value.has(item.id)) retries.value.delete(item.id);
      }
      // Keep one copy for a waiter, even if the row is about to leave the local
      // list (Clear, linger).
      if (watched.has(item.id)) settled.set(item.id, item);
    }

    items.value = snapshot
      .filter((item) => {
        if (suppressed.has(item.id)) return false;
        if (item.state === "running") return true;
        // A failure or cancellation stays until the user clears or retries it
        // (IO-3): the seven-second linger would otherwise remove Retry before a
        // batch summary even appears.
        if (item.state !== "done") return true;
        const at = finishedAt.get(item.id);
        return at === undefined || now - at < LINGER_MS;
      })
      .map((item) => item);

    // Forget ids the backend no longer reports, so the maps cannot grow.
    const live = new Set(snapshot.map((item) => item.id));
    for (const id of [...finishedAt.keys()]) {
      if (!live.has(id)) finishedAt.delete(id);
    }
    for (const id of [...suppressed]) {
      if (!live.has(id)) suppressed.delete(id);
    }
    return true;
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
    // A waiter may be between polls when the user clears: snapshot every
    // watched row the local list still considers terminal *before* the backend
    // prunes it, or the id would disappear from both sides.
    for (const item of items.value) {
      if (item.state !== "running" && watched.has(item.id)) settled.set(item.id, item);
    }

    // The backend can only forget finished entries; the local list must do the
    // same and keep running transfers visible (their cancel buttons live there).
    await api.clearTransfers().catch(() => {});
    const stillRunning = items.value.filter((item) => item.state === "running");
    items.value = stillRunning;
    const runningIds = new Set(stillRunning.map((item) => item.id));
    for (const id of [...finishedAt.keys()]) {
      if (!runningIds.has(id)) finishedAt.delete(id);
    }
    // A retry is only reachable from the row it belongs to; dropped rows take
    // their callbacks with them.
    for (const id of [...retries.value.keys()]) {
      if (!runningIds.has(id)) retries.value.delete(id);
    }
    // Keep `suppressed`: a retried row must stay hidden even if the backend
    // prune failed. The next poll drops ids the backend no longer reports.
  }

  /** Wait for one queued transfer to settle. */
  async function waitFor(id: string, timeoutMs = 120_000): Promise<ProgressView> {
    const deadline = Date.now() + timeoutMs;
    watched.add(id);
    try {
      for (;;) {
        const fresh = await poll();
        const item = items.value.find((entry) => entry.id === id);
        if (item && item.state !== "running") return item;
        const cached = settled.get(id);
        if (cached) return cached;
        // A successful poll that no longer reports the id means it was pruned
        // after Clear. Resolve instead of waiting for a row that cannot return.
        if (fresh && !item) return clearedOutcome(id);
        if (Date.now() > deadline) {
          return { id, label: "", done: 0, state: "failed", error: "timed out waiting for the transfer" };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      watched.delete(id);
      settled.delete(id);
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
    const results = new Map<string, ProgressView>();
    const remaining = new Set(ids);
    for (const id of ids) watched.add(id);
    try {
      while (remaining.size > 0) {
        const fresh = await poll();
        // One index per snapshot, so a large batch does not fan out into a
        // `find` per id per tick.
        const current = new Map(items.value.map((item) => [item.id, item]));
        for (const id of [...remaining]) {
          const item = current.get(id) ?? settled.get(id);
          if (!item) {
            // The backend answered and the id is gone, or the local list was
            // cleared after the transfer settled. Either way it is terminal and
            // must not keep the batch pending; only a failed poll is ignored.
            if (fresh) {
              results.set(id, clearedOutcome(id));
              remaining.delete(id);
            }
            continue;
          }
          if (item.state === "running") continue;
          results.set(id, item);
          remaining.delete(id);
        }
        if (remaining.size > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      for (const id of ids) {
        watched.delete(id);
        settled.delete(id);
      }
    }
    return ids.map((id) => results.get(id)!);
  }

  /** Remember how to repeat one transfer; a later registration supersedes. */
  function registerRetry(id: string, run: () => Promise<void>) {
    retries.value.set(id, run);
  }

  const hasRetry = (id: string) => retries.value.has(id);

  /**
   * Repeat a failed or cancelled transfer.
   *
   * The callback resolves once a replacement transfer has started and rejects if
   * it could not start. The old row and its callback are only dropped after a
   * successful start, so a failed Retry command leaves the affordance in place.
   */
  async function retry(id: string) {
    const run = retries.value.get(id);
    if (!run) return;
    await run();
    retries.value.delete(id);
    suppressed.add(id);
    items.value = items.value.filter((item) => item.id !== id);
  }

  return {
    items,
    running,
    retries,
    poll,
    start,
    stop,
    clear,
    waitFor,
    waitForAll,
    registerRetry,
    hasRetry,
    retry,
  };
});
