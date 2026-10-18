/**
 * Test harness for the progress store.
 *
 * Pinia and the store must be bundled by the same esbuild pass or the test would
 * hold a different Pinia instance than the store uses. The `api` object is
 * exported so a test can replace the two IPC calls the store makes.
 */
import { createPinia, setActivePinia } from "pinia";
import { api } from "@/lib/ipc";
import { useProgressStore } from "@/stores/progress";

export { api, createPinia, setActivePinia, useProgressStore };
