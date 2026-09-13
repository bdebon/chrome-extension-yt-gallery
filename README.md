# YouTube Contemplatif

A Chrome extension that adds a **Contempler** button to the *Videos* tab of a
YouTube channel and opens a full-screen, museum-like gallery. Built for
ambient / AI-art channels: generated images, hour-long soundscapes, thumbnails
that deserve better than YouTube's grid.

## Install

No Web Store listing (yet). Install it as an unpacked extension:

1. Download the latest `youtube-contemplatif-vX.Y.Z.zip` from the
   [Releases page](https://github.com/bdebon/chrome-extension-yt-gallery/releases).
2. Unzip it somewhere you will keep (Chrome loads the extension from that folder).
3. Open `chrome://extensions` (Arc: `arc://extensions`), enable **Developer mode**.
4. Click **Load unpacked** and pick the unzipped folder.
5. Open a channel's Videos tab, e.g.
   <https://www.youtube.com/@spiritual_brother/videos>. The **Contempler** chip
   sits next to the *Latest / Popular / Oldest* filters.

Updates are not automatic: the gallery header shows a small badge when a newer
release exists. Download it, unzip over the same folder, and hit ⟳ on the
extension card.

## Usage

| Action | Effect |
| --- | --- |
| Click a thumbnail | plays the video (YouTube's own navigation, no reload) |
| Cmd/Ctrl + click | opens the video in a new tab |
| Right-click a thumbnail | opens that video in Cinema mode |
| `C` | toggles Grid / Cinema |
| `←` `→` | previous / next video (Cinema) |
| `Enter` | plays the displayed video (Cinema) |
| `Esc` | Cinema → Grid, then Grid → close |

The gallery loads the rest of the channel automatically as you scroll. Videos
whose view count stands out from their batch get a 2 × 2 cell. When you go
back from a video you launched from the gallery, it reopens at the same spot.

## HD thumbnails in Cinema mode

YouTube thumbnails top out at 1280 × 720: on a Retina screen, Cinema mode
stretches them and they turn blurry. The extension upscales them ×2
(2560 × 1440) **locally, on your GPU**, with a compact Real-ESRGAN
super-resolution model (`realesr-general-x4v3`, ≈ 5 MB) run by ONNX Runtime Web
through WebGPU. Nothing leaves your machine.

- The 720p shows up immediately; the HD version fades in over it once ready
  (≈ 3 s per image on an M1 Mac, neighbours are prepared ahead of time).
- The model erases the grain of illustrations, so the high frequencies of the
  original are added back on top (`GRAIN` in `offscreen.js`).
- Results are kept in the extension's cache: an image is never computed twice.
- Without WebGPU (or on any error), it silently stays at 720p.
- Inference runs in an offscreen document (`chrome.offscreen`) because
  YouTube's CSP forbids WebAssembly in the page.
- Demo only: the **HD** chip in the header (or the `H` key) toggles the HD
  layer to compare before / after.

## Development

Vanilla, no build step:

- `manifest.json` — Manifest V3, content script on `youtube.com`, service worker, offscreen document.
- `content.js` — detects the Videos tab, reads YouTube's DOM, renders the gallery.
- `gallery.css` — gallery styles, rendered inside a Shadow DOM.
- `background.js` — service worker; opens the offscreen document on demand.
- `offscreen.html` / `offscreen.js` — thumbnail super-resolution (tiles, grain, cache, queue).
- `vendor/ort/` — ONNX Runtime Web 1.29 (JSPI + WebGPU build, MIT, ≈ 16 MB).
- `models/realesr-general-x4v3.onnx` — Real-ESRGAN model (BSD-3-Clause, Xintao Wang et al.).

Load the repository folder as an unpacked extension; after each change hit ⟳
on the extension card and reload the YouTube tab.

### Constraints

- YouTube enforces **Trusted Types**: no `innerHTML`, everything goes through `createElement`.
- YouTube is a SPA: the button is re-inserted on every `yt-navigate-finish`.
- Thumbnails top out at `maxresdefault.jpg` (1280 × 720), with a fallback to
  `hqdefault.jpg` when the HD variant does not exist (YouTube then returns a
  120 × 90 placeholder, detected through `naturalWidth`).
- Super-resolution needs WebGPU and JSPI (Chrome ≥ 137); the extension pages
  declare `'wasm-unsafe-eval'` in their CSP to load the runtime.

## Releases

Releases are cut by [Release Please](https://github.com/googleapis/release-please):
every push to `main` updates a release pull request; merging it tags a version,
bumps `manifest.json`, and attaches the extension zip to the GitHub release.

Commit messages therefore follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat: …` for a minor bump, `fix: …` for a patch, `feat!: …` for a breaking change.
Other prefixes (`chore:`, `docs:`, `refactor:`) do not trigger a release.

## Contributing

Issues and pull requests are welcome, in English or French. Keep the code
vanilla and dependency-free unless there is a very good reason.

## License

[MIT](LICENSE)
