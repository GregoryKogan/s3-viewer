# Landing page

Static files, published to GitHub Pages by `.github/workflows/site.yml`. There is
no build step: `index.html`, `styles.css` and `assets/` are what the browser gets.

## One-time repository setup

Pages has to be pointed at Actions once, in **Settings → Pages → Build and
deployment → Source: GitHub Actions**. Until then the deploy workflow fails with a
message about Pages not being enabled.

After that every push that touches `site/` republishes the page at
<https://gregorykogan.github.io/s3-viewer/>.

## Download links

The buttons point at `releases/latest/download/S3-Viewer.dmg`, not at a versioned
file name. The release workflow renames each build to that fixed name, so the page
never has to be edited when a version ships.

| Asset | Platform |
| --- | --- |
| `S3-Viewer.dmg` | macOS, universal (Apple Silicon and Intel) |
| `S3-Viewer.AppImage` | Linux, portable |
| `S3-Viewer-amd64.deb` | Linux, Debian/Ubuntu |
| `SHA256SUMS.txt` | checksums for the three above |

## The logo

`assets/icon.png` is a byte-for-byte copy of `src-tauri/icons/128x128.png`. It is
the 22 px mark in the header and the raster favicon, so it has to follow the app
icon: when `src-tauri/icons/_source.svg` changes and the platform icons are
regenerated with `pnpm tauri icon`, copy the new `128x128.png` over it. Do not
redraw the mark here.

`assets/favicon.svg` is `src-tauri/icons/_source.svg` with the fixed width and
height removed, so the browser can scale it; it is the favicon modern browsers
pick. `assets/apple-touch-icon.png` is the 180 px copy of
`src-tauri/icons/_source.png` used when the page is saved to an iOS home screen.
Both come from the same source as the app icon and must be refreshed with it.

## The screenshot

`assets/app-window.png` is a real screenshot of the application, taken with
`screencapture -l<window id>` so no other window is in frame. It is a 1280×820
window captured on a retina display, hence 2560×1640; `assets/app-window@1x.png`
is the half-scale copy offered to non-retina displays through `srcset`.

Eight demo connections fill the sidebar so the app reads as a tool someone uses,
not a fresh install. Their names and addresses are invented — `Anchor & Pine`,
`Bluebird Studio`, `Cinder Labs`, `Harbor Light`, `Juniper Sound`, `Kestrel
Works`, `Marlow Press`, `Northwind Radio` — and every card is scoped to a
disposable prefix in a scratch bucket. The addresses on the cards were replaced
with those fictional ones in the running UI before the capture, so no real bucket
name appears in the image. The window title is set to the product name for the
capture; in normal use it names the open connection and its path.

The preview is `icon.svg`: the app's own logo, taken from
`src-tauri/icons/_source.svg`. It is named so it sorts into the middle of the
list, which keeps the selected row and the preview at the vertical centre of the
window instead of at the bottom edge. The listing has two folders and twelve
files so all of it fits without scrolling.

To retake it: run the app against demo objects under a throwaway prefix, create
eight connections with publishable names, point every one at a disposable prefix,
select the SVG at the row you want to feature, replace the card addresses with
fictional ones, capture the window, and rebuild `assets/app-window@1x.png` with
`sips -z 820 1280`. The breadcrumb shows the connection name rather than the
bucket, so it needs no retouching.
