# How GIMMIE works, code-wise

A technical walkthrough for anyone who wants to read the source and understand exactly what it does. Nothing here is hidden or minified: it's plain vanilla JavaScript, no build step, no framework, no dependencies. Load the folder and every line runs as written.

## Design constraints

- **Manifest V3.** Modern Chrome extension model: a popup, an ephemeral service worker, and content scripts injected on demand.
- **No build tooling.** No bundler, no transpiler, no `node_modules`. What's in the repo is what runs. This is deliberate: it keeps the whole thing auditable and makes "load unpacked" trivial.
- **No servers, no telemetry.** Everything executes locally in the browser. There is no backend to talk to, so there is nothing to phone home to.
- **CSP-clean.** MV3 forbids inline scripts on extension pages, so every page (`popup.html`, `printview.html`, `install.html`) loads its logic from an external `.js` file. There is not a single inline `<script>` doing work.

## File map

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions, host access, the popup, the service worker, icons. |
| `popup.html` / `popup.js` | The UI and the orchestrator. Renders results, filter/sort, and all five export formats. |
| `content.js` | The collection engine. Runs in the page's isolated world and does the actual data pulling. |
| `background.js` | Minimal service worker (install log). Present for completeness; does no runtime work. |
| `theme.js` | Light/dark theme, persisted in `localStorage`, plus the pull-cord switch. |
| `printview.html` / `printview.js` | A packaged print page used to produce PDFs via the browser's print dialog. |
| `install.html` | The self-contained install guide. |

Permissions are intentionally minimal: `activeTab`, `scripting`, `storage`, and host access to `https://x.com/*` only. No `tabs`, no broad host permissions, so Chrome never shows a "read your browsing history" warning.

## The collection engine (`content.js`)

This is the interesting part. The content script is injected into the bookmarks tab via `chrome.scripting.executeScript`, so it runs in that page's **isolated world**: it shares the DOM and cookies with x.com, but has its own JS scope. Two properties of the isolated world make the whole approach work:

1. `fetch()` from a content script is **same-origin** with the host page (x.com) and sends its cookies.
2. Those fetches are **not subject to the page's Content Security Policy**.

So the content script can call X's own internal API as the logged-in user, first-party, read-only.

### Two lanes: API first, DOM fallback

`runScan(mode)` tries `runApiScan()` first and falls back to `runDomScan()` if the API path throws. The API lane is fast and complete; the DOM lane is the resilient backstop if X ever locks the API down.

### The API lane

X's web app talks to a private GraphQL endpoint at `https://x.com/i/api/graphql/<queryId>/<Operation>`. GIMMIE replays those same calls:

- **Auth.** `gql()` sends the public web-app bearer token (the same one x.com ships in its bundle; it is not a secret), the `ct0` cookie as the `x-csrf-token` header, and `x-twitter-auth-type: OAuth2Session`. Combined with the session cookies the browser already holds, the request runs as the current user.
- **Query-id discovery.** GraphQL operations are addressed by a `queryId` that changes when X redeploys that query. `getQueryIds()` scans X's loaded JS bundles for `queryId:"...",operationName:"..."` pairs and caches the result for the life of the content script. If discovery finds nothing, it falls back to a hardcoded last-known-good set (`DEFAULT_QIDS`).
- **Feature-flag negotiation.** GraphQL requests carry a large `features` object, and X rejects calls that omit a required flag with `"features cannot be null: <name>"`. `gql()` starts from a reasonable base set and, on that specific error, parses the missing flag names, sets them to `false`, and retries. This absorbs most feature-flag drift without a code change.
- **Pagination.** `runApiScan()` calls the `Bookmarks` operation with `count: 100`, walks `bookmark_timeline_v2.timeline.instructions` for tweet entries, and follows the `cursor-bottom` value page to page until there are no new entries. Each parsed record is streamed to the popup immediately (`post("new_tweet", ...)`), so cards appear as they arrive rather than after everything finishes.

### Normalizing a post (`parseTweet`)

Each raw `tweet_results.result` is flattened into a stable shape. This handles the real-world messiness:

- **Visibility wrappers.** `unwrap()` unwraps `TweetWithVisibilityResults` to the underlying tweet.
- **Long ("note") tweets.** Text over the classic limit lives outside `legacy.full_text`, in `note_tweet.note_tweet_results.result.text`; `fullText()` prefers it and strips the trailing `t.co` media link X appends.
- **Media.** `mediaOf()` reads `extended_entities.media`, normalizes image URLs to `name=large`, and for video/GIF picks the highest-bitrate MP4 variant.
- **Stats.** Likes, reposts, replies, quotes, bookmarks, and views are pulled from `legacy` and `views.count`.
- Articles are flagged (`t.article`) and enriched in a second pass.

### Full article extraction (`fetchArticle` / `buildArticleParts`)

Long-form X articles are the depth that's otherwise trapped in the app. GIMMIE fetches each one with the `TweetResultByRestId` operation and the field toggle `withArticleRichContentState: true`, which returns the article's `content_state`: a DraftJS-style document of `blocks` plus an `entityMap`.

`buildArticleParts()` walks the blocks in order and reconstructs the article:

- Text blocks become Markdown, with `header-two`/`header-one` → `##`, list items → `-`/`1.`.
- **Atomic blocks are not all images.** X uses atomic blocks for images, horizontal-rule dividers, emoji, and embeds. The code reads each atomic block's entity **type** via the `entityMap`: `MEDIA` resolves to an image URL through `media_entities[].media_info.original_img_url`; `DIVIDER` becomes a `---`; everything else is skipped. (Getting this wrong is what caused an earlier false "images could not be matched" warning; the fix was to classify by entity type rather than assume every atomic block was an image.)

The result is `parts`: an ordered array of `{type: "text" | "image", value}` that renders identically into Markdown, PDF, and the detail view, so images land exactly where the author placed them.

### The DOM fallback (`runDomScan`)

If the API path throws on the first page, `runDomScan()` takes over: it programmatically scrolls the virtualized bookmarks list, scrapes each `article` node for id, author, text, and media, and dedupes by id. It cannot recover engagement stats reliably (they aren't consistently in the DOM), but it keeps the core export working if the API is unavailable.

## Orchestration and lifecycle (`popup.js` ↔ `content.js`)

- **Auto-detect.** On open, `popup.js` checks the active tab; if it's the bookmarks page, it calls `startScan()` immediately, so bookmarks appear with zero clicks.
- **Injection + kickoff.** `startScan()` injects `content.js` via `chrome.scripting.executeScript`, then `chrome.tabs.sendMessage({action: "start_scan"})`. A re-injection guard (`window.__gimmieLoaded`) ensures only one message listener is ever registered.
- **Streaming results.** The content script pushes `new_tweet`, `tweet_updated`, `scan_status`, and `scan_complete` messages via `chrome.runtime.sendMessage`; the popup renders them live. Incoming cards are deduped by id defensively.
- **Lifecycle via a Port.** This is the subtle bit. `chrome.runtime.sendMessage` cannot be relied on to reject when the popup closes, because the background service worker keeps the messaging channel alive. So the popup opens a long-lived `chrome.tabs.connect(tabId, {name: "gimmie-popup"})` Port. When the popup closes, the content script's `port.onDisconnect` fires reliably and sets `stopRequested`, aborting an in-flight scan instead of continuing to hit X's API for a window nobody is watching.

## Rendering and exports (`popup.js`)

Every format is built from one normalized list, so a single post and the whole archive always look the same. Exports honor the active filter and sort, so you get exactly what's on screen, in the order shown.

- **Markdown** (`buildMarkdownFor`): a header block plus numbered, horizontal-rule-separated entries. Articles use their ordered `parts`, so images appear inline. This is the format meant for LLMs.
- **JSON** (`buildJsonFor`): the full structured record per post, including `article_parts`.
- **CSV** (`buildCsvFor`): BOM-prefixed for Excel, quotes doubled, and **formula-injection-neutralized**: any cell starting with `= + - @` or a control char is prefixed with a single quote, because handles always start with `@` and would otherwise be evaluated as formulas.
- **ZIP** (`buildZip`): a dependency-free ZIP writer. It emits local file headers, a central directory, and an end-of-central-directory record using the store method (no compression), with a hand-rolled CRC-32 (precomputed table). The archive contains the combined Markdown, the JSON, and one Markdown file per post.
- **PDF** (`openPrintable` + `printview.js`): the archive HTML is handed to a packaged `printview.html` via `chrome.storage.local`, which renders it, waits for images to load (capped), and calls `window.print()`. Done this way (not an inline script) to stay CSP-compliant.

## Theme (`theme.js`)

`theme.js` runs in `<head>` before first paint and reads the saved theme from **synchronous** `localStorage`, which eliminates the flash of the wrong theme that an async `chrome.storage` read would cause. The pull-cord switch is a pointer-drag interaction with a short, bounded travel (an extension popup closes if the pointer leaves its bounds), and also toggles on tap and keyboard.

## Security posture

- **Output escaping.** All interpolated text goes through `escHtml`; URLs go through `safeUrl`, which escapes for attribute context and refuses any scheme other than `http(s)`, so a hostile value can't smuggle a `javascript:`/`data:` link into an `href`.
- **CSV injection** is neutralized as described above.
- **No secrets.** The bearer token is X's public web token, not a credential. Auth comes entirely from the user's own session cookies, which never leave the browser.
- **Minimal blast radius.** Host access is `x.com` only; the extension reads bookmarks and nothing else, and never writes to the account.

## Failure modes and where it can break

This is honest about the foundation:

- **X can change the private API.** Query ids drift (handled by discovery + fallback), feature flags drift (handled by negotiation), but a deeper schema change to the bookmarks timeline or article `content_state` would require a code update. The DOM fallback covers total API loss but not stats.
- **Rate limits.** A very large account paginating many pages could hit X's limits mid-scan. There is currently no backoff; that's a known area to harden.
- **It's early.** The engine has been tested thoroughly on real data but not yet across many accounts and scales. Treat it as a capable beta.

If you read the code and spot something wrong or a way to make it better, open an issue or a PR.
