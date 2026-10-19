/**
 * Test harness for the objects store.
 *
 * The store and Pinia must be bundled by the same esbuild pass (see
 * `progressHarness.ts`). `api` is exported so a test can replace the listing
 * call and inspect the session synchronously, before any request settles.
 */
import { createPinia, setActivePinia } from "pinia";
import { api } from "@/lib/ipc";
import { useConnectionsStore } from "@/stores/connections";
import { useObjectsStore } from "@/stores/objects";
import { useUiStore } from "@/stores/ui";

export { api, createPinia, setActivePinia, useConnectionsStore, useObjectsStore, useUiStore };
