// Minimal W3C WebDriver client. tauri-driver speaks this protocol on :4444, so
// the suite can drive the real app window — no browser-in-a-browser, no
// dependency, and screenshots come out of the app itself rather than the screen.

import fs from "node:fs";
import path from "node:path";

export class WebDriver {
  constructor({ port = 4444, host = "127.0.0.1", sessionId = null } = {}) {
    this.base = `http://${host}:${port}`;
    this.sessionId = sessionId;
    this.artifacts = path.join(import.meta.dirname, "artifacts");
    fs.mkdirSync(this.artifacts, { recursive: true });
  }

  async #call(method, url, body) {
    const response = await fetch(`${this.base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) {
      const error = parsed?.value?.message ?? text;
      throw new Error(`WebDriver ${method} ${url} -> ${response.status}: ${error}`);
    }
    if (parsed?.value?.error) {
      throw new Error(`WebDriver ${method} ${url}: ${parsed.value.error} — ${parsed.value.message}`);
    }
    return parsed?.value;
  }

  async start(capabilities = {}) {
    const value = await this.#call("POST", "/session", {
      capabilities: { alwaysMatch: { ...capabilities }, firstMatch: [{}] },
    });
    this.sessionId = value.sessionId ?? value.session_id;
    return this.sessionId;
  }

  async quit() {
    if (!this.sessionId) return;
    try {
      await this.#call("DELETE", `/session/${this.sessionId}`);
    } catch {
      /* the process may already be gone */
    }
    this.sessionId = null;
  }

  async #session(method, suffix, body) {
    if (!this.sessionId) throw new Error("WebDriver session is not started");
    return this.#call(method, `/session/${this.sessionId}${suffix}`, body);
  }

  // ---------------------------------------------------------------- navigation

  async #find(using, value) {
    return this.#session("POST", "/element", { using, value });
  }

  /** @returns {Promise<string>} element id */
  async findElement(selector, { timeout = 15_000, strategy = "css selector" } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    for (;;) {
      try {
        const found = await this.#find(strategy, selector);
        const id = typeof found === "string" ? found : found?.["element-6066-11e4-a52e-4f735466cecf"];
        if (id) return id;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() > deadline) {
        throw new Error(`Element not found: ${selector} (${lastError?.message ?? "no match"})`);
      }
      await sleep(150);
    }
  }

  async findElements(selector, { strategy = "css selector" } = {}) {
    const value = await this.#session("POST", "/elements", { using: strategy, value: selector });
    return (value ?? []).map(
      (entry) => (typeof entry === "string" ? entry : entry["element-6066-11e4-a52e-4f735466cecf"]),
    );
  }

  /** Poll until the selector matches, or return null without throwing. */
  async waitFor(selector, { timeout = 15_000 } = {}) {
    try {
      return await this.findElement(selector, { timeout });
    } catch {
      return null;
    }
  }

  async waitForGone(selector, { timeout = 15_000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = await this.findElements(selector);
      if (!found.length) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }

  async text(elementId) {
    return this.#session("GET", `/element/${elementId}/text`);
  }

  async attribute(elementId, name) {
    return this.#session("GET", `/element/${elementId}/attribute/${name}`);
  }

  async click(elementId) {
    return this.#session("POST", `/element/${elementId}/click`, {});
  }

  async clickSelector(selector, options = {}) {
    const id = await this.findElement(selector, options);
    await this.click(id);
    return id;
  }

  async type(elementId, text, { clear = true } = {}) {
    if (clear) await this.#session("POST", `/element/${elementId}/clear`, {});
    // WebDriver sends each character to the focused element.
    const chunks = String(text).match(/[\s\S]{1,200}/g) ?? [];
    for (const chunk of chunks) {
      await this.#session("POST", `/element/${elementId}/value`, { text: chunk });
    }
  }

  async typeSelector(selector, text, options = {}) {
    const id = await this.findElement(selector, options);
    await this.type(id, text, options);
    return id;
  }

  async keys(value) {
    return this.#session("POST", "/actions", {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ],
        },
      ],
    });
  }

  async execute(script, args = []) {
    return this.#session("POST", "/execute/sync", { script, args });
  }

  async screenshot(name = `shot-${Date.now()}`) {
    const base64 = await this.#session("GET", "/screenshot");
    const file = path.join(this.artifacts, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    return file;
  }

  async url() {
    return this.#session("GET", "/url");
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until it returns a truthy value or the timeout expires. */
export async function waitUntil(fn, { timeout = 15_000, interval = 200, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}${last ? ` (last: ${last})` : ""}`);
    }
    await sleep(interval);
  }
}
