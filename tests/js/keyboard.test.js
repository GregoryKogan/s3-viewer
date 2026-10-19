import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./loadTs.mjs";

const { IS_MAC, modLabel, shortcutLabel, isEditableTarget } = await loadTs("src/lib/keyboard.ts");

test("modLabel uses the platform modifier", () => {
  assert.equal(modLabel(true), "⌘");
  assert.equal(modLabel(false), "Ctrl+");
  // The real platform is detected at import time; it is a boolean either way.
  assert.equal(typeof IS_MAC, "boolean");
});

test("shortcutLabel builds letter and arrow combos", () => {
  assert.equal(shortcutLabel("R", true), "⌘R");
  assert.equal(shortcutLabel("r", true), "⌘R");
  assert.equal(shortcutLabel("R", false), "Ctrl+R");
  assert.equal(shortcutLabel("ArrowUp", true), "⌘↑");
  assert.equal(shortcutLabel("ArrowDown", false), "Ctrl+↓");
});

test("shortcutLabel normalises the named editing keys", () => {
  assert.equal(shortcutLabel("Backspace", true), "⌘⌫");
  assert.equal(shortcutLabel("Backspace", false), "Ctrl+Backspace");
  assert.equal(shortcutLabel("Delete", true), "⌘⌦");
  assert.equal(shortcutLabel("Delete", false), "Ctrl+Del");
  assert.equal(shortcutLabel("Enter", true), "⌘↩");
  assert.equal(shortcutLabel("Escape", false), "Ctrl+Esc");
  assert.equal(shortcutLabel("F", false), "Ctrl+F");
});

test("isEditableTarget recognises text fields", () => {
  assert.equal(isEditableTarget(null), false);
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "input" }), true);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(isEditableTarget({ tagName: "BUTTON" }), false);
  assert.equal(isEditableTarget({ tagName: "DIV" }), false);
});

test("isEditableTarget leaves non-text inputs to the list", () => {
  // A checkbox is a control: arrows, Delete and ⌘A must keep working when one
  // has focus, so it is not a text field.
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "radio" }), false);
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "range" }), false);
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "button" }), false);
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "search" }), true);
});

test("isEditableTarget recognises contenteditable hosts", () => {
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: false }), false);
  assert.equal(
    isEditableTarget({ tagName: "DIV", getAttribute: (name) => (name === "contenteditable" ? "" : null) }),
    true,
  );
  assert.equal(
    isEditableTarget({ tagName: "DIV", getAttribute: () => "false" }),
    false,
  );
});
