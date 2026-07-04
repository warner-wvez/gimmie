# GIMMIE — X Bookmark Exporter

Save your X (Twitter) bookmarks as a clean, well-structured file, ready for NotebookLM and other AI tools. GIMMIE pulls the full text of posts and articles, keeps images in order, includes engagement stats, and lets you export everything or just the posts you pick.

Everything runs locally in your browser. Your bookmarks never leave your machine, and GIMMIE collects nothing about you. See [PRIVACY.md](PRIVACY.md).

## What it does

- **Collects your bookmarks fast.** Reads your saved posts through X's own data channel using your logged-in session, so there is no slow page scrolling.
- **Reads full articles.** Long-form X articles come through complete: title, every paragraph in order, and every image placed inline where the author put it.
- **Captures engagement stats.** Likes, reposts, replies, quotes, bookmarks, and views for every post.
- **Exports in the format you want.** Markdown (recommended for AI tools), PDF, JSON, CSV, or a ZIP bundle.
- **One, some, or all.** Export a single post, only the posts you check, or your whole archive.
- **Light and dark mode.** Pull the light cord in the top corner to switch. Your choice is remembered.

## Install (unpacked)

GIMMIE is a standard Chrome/Edge extension. To run it from source:

1. Download or clone this repository.
2. Open `chrome://extensions` in your browser.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin the extension, open your X bookmarks, and click the icon.

## How to use

1. Open [x.com/i/bookmarks](https://x.com/i/bookmarks) (the extension can take you there).
2. Click the GIMMIE icon and choose how to collect:
   - **Grab everything** — collects all bookmarks and reads every article, ready to export as one file.
   - **Browse and pick** — lists your bookmarks quickly so you can open or check only the ones you want.
3. Export. Markdown is the default and works best with NotebookLM and other AI tools. PDF, JSON, CSV, and ZIP are also available. There is also a one-click **Send to NotebookLM**.

## How it works

GIMMIE reads your bookmarks the same way the X website itself does, using your existing logged-in session, entirely on your computer. If that path is ever unavailable, it automatically falls back to reading the bookmarks page directly, so it keeps working.

Because it depends on how X structures its data, X changing its site can occasionally break collection until GIMMIE is updated. If something stops working, please open an issue.

## Formats

| Format | Best for |
| --- | --- |
| Markdown | AI tools (NotebookLM, etc.), reading, notes |
| PDF | A readable, shareable document |
| JSON | Developers, reprocessing, structured data |
| CSV | Spreadsheets |
| ZIP | The full archive plus one Markdown file per post |

## Privacy

No data collection, no external servers, no tracking. Everything happens locally in your browser using your own session. Full details in [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE).

---

Not affiliated with or endorsed by X Corp. "X" and "Twitter" are trademarks of their respective owners; they are used here only to describe what this tool works with.
