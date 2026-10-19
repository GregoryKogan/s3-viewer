# App icon source

Current icon: **Signal / Native**. The mark is three interlaced S ribbons with
round caps, on a `#0F1115` plate.

## Master files

- `_source.svg`: master vector, 1024×1024, the file to edit.
- `_source.png`: 1024×1024 raster export of the master.
- `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `512x512.png`,
  `icon.png`: PNG sizes used by the bundles and the site.
- `icon.icns`: macOS bundle icon.
- `icon.ico`: Windows icon.

## Palette

| Role | Value |
| --- | --- |
| Plate | `#0F1115` |
| Inner ribbon | `#5EEAD4` |
| Middle ribbon | `#38BDF8` |
| Outer ribbon | `#2F6FED` |

The outer ribbon is the app accent, so the app palette needs no change.

## Regenerate

```bash
pnpm tauri icon src-tauri/icons/_source.svg --output src-tauri/icons
```

This rewrites the platform icons. It also writes iOS and Android folders; this
app targets macOS and Linux, so those can be removed unless they are needed.
