import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  currentVersion,
  findUpdate,
  installUpdate,
  restartApp,
  type FoundUpdate,
} from "@/lib/updater";
import { humanSize } from "@/lib/format";

/** What the update dialog is showing right now. */
export type UpdatePhase = "idle" | "checking" | "available" | "installing" | "restarting" | "error";

/**
 * Self-update state.
 *
 * The check runs on every launch (silently, see `App.vue`) and on demand from
 * Settings. Only an announced update opens the dialog, so a failed or empty
 * check is invisible — launching the app never depends on GitHub being up.
 */
export const useUpdatesStore = defineStore("updates", () => {
  const phase = ref<UpdatePhase>("idle");
  const runningVersion = ref("");
  const nextVersion = ref<string | null>(null);
  const notes = ref<string | null>(null);
  const downloaded = ref(0);
  const total = ref<number | null>(null);
  const error = ref<string | null>(null);

  /** The opened handle; kept so "Later" can release the bytes held in Rust. */
  let pending: FoundUpdate | null = null;
  /** A check already on the wire, so two callers share one request. */
  let inFlight: Promise<boolean> | null = null;

  const busy = computed(() => phase.value === "installing" || phase.value === "restarting");

  const percent = computed(() => {
    if (total.value === null || total.value <= 0) return null;
    return Math.min(100, Math.round((downloaded.value / total.value) * 100));
  });

  /** "12.4 MB of 23.1 MB" — or just the downloaded amount when the size is unknown. */
  const progressLabel = computed(() => {
    if (total.value === null) return humanSize(downloaded.value);
    return `${humanSize(downloaded.value)} of ${humanSize(total.value)}`;
  });

  async function loadVersion(): Promise<string> {
    if (!runningVersion.value) {
      runningVersion.value = (await currentVersion()) ?? "";
    }
    return runningVersion.value;
  }

  async function release() {
    const held = pending;
    pending = null;
    if (held) {
      try {
        await held.update.close();
      } catch {
        /* the resource is gone already */
      }
    }
  }

  /**
   * Ask the update server. Throws when the request fails, which callers treat
   * differently: the launch check ignores it, the Settings button reports it.
   */
  function check(): Promise<boolean> {
    if (phase.value === "available" || phase.value === "installing" || phase.value === "restarting") {
      return Promise.resolve(true);
    }
    if (!inFlight) {
      inFlight = runCheck().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function runCheck(): Promise<boolean> {
    await loadVersion();
    // A previous attempt may still be holding bytes in the backend.
    await release();

    phase.value = "checking";
    try {
      const found = await findUpdate();
      if (!found) {
        phase.value = "idle";
        return false;
      }
      pending = found;
      nextVersion.value = found.version;
      notes.value = found.notes;
      downloaded.value = 0;
      total.value = null;
      error.value = null;
      phase.value = "available";
      return true;
    } catch (cause) {
      phase.value = "idle";
      throw cause;
    }
  }

  /** Download and install, then restart into the new version. */
  async function install(): Promise<void> {
    if (!pending || busy.value) return;
    const found = pending;
    error.value = null;
    downloaded.value = 0;
    total.value = null;
    phase.value = "installing";
    try {
      await installUpdate(found, (progress) => {
        downloaded.value = progress.downloaded;
        total.value = progress.total;
      });
      phase.value = "restarting";
      await restartApp();
    } catch (cause) {
      phase.value = "error";
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }

  /** "Later": close the dialog and forget the pending update until next launch. */
  async function later(): Promise<void> {
    if (busy.value) return;
    await release();
    phase.value = "idle";
    nextVersion.value = null;
    notes.value = null;
    error.value = null;
    downloaded.value = 0;
    total.value = null;
  }

  return {
    phase,
    runningVersion,
    nextVersion,
    notes,
    downloaded,
    total,
    error,
    busy,
    percent,
    progressLabel,
    loadVersion,
    check,
    install,
    later,
  };
});
