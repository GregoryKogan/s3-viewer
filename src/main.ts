import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import "@/assets/main.css";
import { marked } from "marked";
import { sanitize } from "@/lib/previewText";

/**
 * Collected page errors.
 *
 * A component that throws while rendering keeps its previous DOM, which looks
 * like "the panel is frozen on the old file". The thrown error is the only thing
 * that identifies the culprit, so it is kept where the harness can read it.
 */
const pageErrors: string[] = [];
window.addEventListener("error", (event) => {
  pageErrors.push(String(event.error?.stack ?? event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  pageErrors.push(`rejection: ${String((event.reason as Error)?.stack ?? event.reason)}`);
});
(window as unknown as { __s3viewerErrors: string[] }).__s3viewerErrors = pageErrors;

// Vue reports scheduler trouble (notably "Maximum recursive updates exceeded")
// through the console rather than by throwing, so both channels are captured.
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    pageErrors.push(`${level}: ${args.map((value) => String(value)).join(" ")}`);
    original(...args);
  };
}

const app = createApp(App);
// Without this a render error is swallowed into a console message.
app.config.errorHandler = (error, _instance, info) => {
  pageErrors.push(`vue(${info}): ${String((error as Error)?.stack ?? error)}`);
};
app.use(createPinia());
app.mount("#app");

/**
 * The end-to-end harness runs inside this window and drives the real UI.
 *
 * It needs one hook the component tree does not expose: the Markdown sanitiser,
 * so a hostile document can be checked without uploading one. Everything else it
 * uses lives on `window.__s3viewer`, published by `App.vue` once boot finishes.
 */
(window as unknown as { __s3viewerSanitizeProbe: () => unknown }).__s3viewerSanitizeProbe = () => {
  const executed = { script: false, handler: false };
  (window as unknown as { __markdownProbeExecuted: () => void }).__markdownProbeExecuted = () => {
    executed.script = true;
  };
  const hostile = [
    "# heading kept",
    "<script>window.__markdownProbeExecuted()</script>",
    '<img src="x" onerror="window.__markdownProbeExecuted()">',
    "[link](javascript:window.__markdownProbeExecuted())",
    "**bold kept**",
  ].join("\n\n");
  // Render through the real pipeline: marked, then the allow-list sanitiser. Only
  // that combination can be checked for "legitimate markup survives".
  const html = sanitize(marked.parse(hostile, { async: false }) as string);
  return { html, executed };
};
