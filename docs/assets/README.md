# README assets

These files are only used by the root [`README.md`](../../README.md).

- `logo-glow.png` is the app icon (`src-tauri/icons/512x512.png`) on a blue/teal
  halo. Regenerate it if the app icon changes; the source icon is the same one
  the landing page uses in `site/assets/icon.png`.

The screenshot and the feature icons are not duplicated here. The README uses
`site/assets/app-window.png`, the same real application capture as the landing
page, and `site/assets/icons/*.svg`, the same 64 px line icons on the app's dark
tile that the landing page puts on its feature cards. They are drawn to match
the UI accent colours (`#5EEAD4`, `#38BDF8`, `#60A5FA`) and are kept as SVG so
they stay sharp on every display. Retaking the screenshot or redrawing an icon
once updates both.
