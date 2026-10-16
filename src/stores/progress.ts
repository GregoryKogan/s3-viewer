import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "@/lib/ipc";
import type { ProgressView } from "@/types";

/** Transfers surface: polling the backend progress list. */
export const useProgressStore = defineStore("transfers", () => {
  const items = ref<ProgressView[]>([]);
  let timer: ReturnType<typeof setInterval> | undefined;

  const running = computed(() => items.value.filter((item) => item.state === "running"));

  async function poll() {
    try {
      items.value = await api.transferProgress();
    } catch {
      /* the panel simply keeps the previous snapshot */
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

export { useUiStore };
