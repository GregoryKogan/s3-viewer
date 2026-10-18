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

## The screenshot

`assets/app-window.png` is a real screenshot of the application, taken with
`screencapture -l<window id>` so no other window is in frame. The connection shown
is a staging deployment whose bucket name and prefix were replaced with
`acme-data` afterwards — a screenshot is the one place where a real account name
would otherwise leak into a public page. Nothing else in the image is retouched.

To retake it: run the app against a folder of demo objects, capture the window,
then replace the connection title, the bucket path under it, and the breadcrumb.
`assets/app-window@1x.png` is a half-scale copy, offered to non-retina displays
through `srcset`.
