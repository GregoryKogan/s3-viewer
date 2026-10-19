/**
 * Test harness for the objects store.
 *
 * The store and Pinia must be bundled by the same esbuild pass (see
 * `progressHarness.ts`). `api` is exported so a test can replace the listing
 * call and inspect the session synchronously, before any request settles;
 * `ApiError` and the toasts store let a test prove one failure yields one toast.
 */
import { createPinia, setActivePinia } from "pinia";
import { api, ApiError } from "@/lib/ipc";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useToastsStore } from "@/stores/toasts";
import { useUiStore } from "@/stores/ui";

export {
  api,
  ApiError,
  createPinia,
  setActivePinia,
  useConnectionsStore,
  useObjectsStore,
  useToastsStore,
  useUiStore,
};
