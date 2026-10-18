/**
 * Self-updates, frontend side.
 *
 * The work happens in Rust: `tauri-plugin-updater` fetches the release manifest,
 * downloads the bundle, verifies its minisign signature and swaps the app on
 * disk. This module only wraps that in promises the UI can await, and imports
 * the plugin packages lazily so a plain browser (and the Node test runner) never
 * loads them.
 */

import type { Update } from "@tauri-apps/plugin-updater";

/** An update the backend has confirmed and is holding a handle to. */
export interface FoundUpdate {
  /** Opaque handle; `close()` releases the bytes the backend keeps around. */
  update: Update;
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  /** `null` when the server did not announce a size. */
  total: number | null;
}

/** Whether the window runs inside the Tauri app rather than a plain browser. */
export function canSelfUpdate(): boolean {
  return Boolean((globalThis as { __TAURI__?: unknown }).__TAURI__);
}

export async function currentVersion(): Promise<string | null> {
  if (!canSelfUpdate()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Resolves to the pending update, or `null` when this build is the newest one. */
export async function findUpdate(): Promise<FoundUpdate | null> {
  // A plain browser has no backend to ask; treat it like "nothing newer".
  if (!canSelfUpdate()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    update,
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body?.trim() || null,
  };
}

/**
 * Downloads and installs the update.
 *
 * On macOS and Linux the caller must relaunch afterwards; on a `.deb` install
 * Linux asks for the administrator password through pkexec, so this can stay
 * pending for a while without reporting progress.
 */
export async function installUpdate(
  found: FoundUpdate,
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await found.update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress({ downloaded: 0, total });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({ downloaded, total });
        break;
      case "Finished":
        onProgress({ downloaded, total });
        break;
    }
  });
}

export async function restartApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
