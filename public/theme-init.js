// Runs from <head>, before the app module and the first paint.
//
// The settings arrive asynchronously from Rust, so waiting for `ui.load()`
// would show the dark theme for a frame to a light-theme user (SET-3). The
// value is mirrored to localStorage by `ui.saveSettings` / `ui.load`.
//
// Plain JS on purpose: the TypeScript bundle has not loaded yet, and the
// `script-src 'self'` CSP forbids an inline script.
(function () {
  var THEME_KEY = "s3viewer.theme";
  var stored = null;
  try {
    stored = window.localStorage.getItem(THEME_KEY);
  } catch (error) {
    // Local storage can be unavailable; the HTML already defaults to dark.
    return;
  }

  var theme = stored === "light" || stored === "dark" ? stored : "dark";
  if (stored === "system") {
    var prefersLight =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches;
    theme = prefersLight ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
})();
