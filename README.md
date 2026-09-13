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

## Development

Vanilla, no build step. Three files:

- `manifest.json` — Manifest V3, content script on `youtube.com`.
- `content.js` — detects the Videos tab, reads YouTube's DOM, renders the gallery.
- `gallery.css` — gallery styles, rendered inside a Shadow DOM.

Load the repository folder as an unpacked extension; after each change hit ⟳
on the extension card and reload the YouTube tab.

### Constraints

- YouTube enforces **Trusted Types**: no `innerHTML`, everything goes through `createElement`.
- YouTube is a SPA: the button is re-inserted on every `yt-navigate-finish`.
- Thumbnails top out at `maxresdefault.jpg` (1280 × 720), with a fallback to
  `hqdefault.jpg` when the HD variant does not exist (YouTube then returns a
  120 × 90 placeholder, detected through `naturalWidth`).

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
