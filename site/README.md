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
the 22 px mark in the header and the favicon, so it has to follow the app icon:
when `src-tauri/icons/_source.svg` changes and the platform icons are regenerated
with `pnpm tauri icon`, copy the new `128x128.png` over it. Do not redraw the mark
here.

## The screenshot

`assets/app-window.png` is a real screenshot of the application, taken with
`screencapture -l<window id>` so no other window is in frame. It is a 1280×820
window captured on a retina display, hence 2560×1640; `assets/app-window@1x.png`
is the half-scale copy offered to non-retina displays through `srcset`.

The connection shown is a staging deployment renamed to `Acme Analytics`; its
bucket and prefix were replaced with `acme-data/analytics/` afterwards. A
screenshot is the one place where a real account name would otherwise leak into a
public page. The window title is set to the product name for the capture; in
normal use it names the open connection and its path. Nothing else in the image
is retouched.

To retake it: run the app against a folder of demo objects under a throwaway
prefix, name the connection something publishable, select an image so the preview
panel has content, capture the window, and replace the bucket path on its card.
The breadcrumb shows the connection name rather than the bucket, so it usually
needs no retouching.
