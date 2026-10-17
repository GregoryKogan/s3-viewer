import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import "@/assets/main.css";
import { marked } from "marked";
import { sanitize } from "@/lib/previewText";

const app = createApp(App);
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
