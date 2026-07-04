(function () {
  // Re-injected on every scan. Guard so we only register one message listener
  // and keep state across injections.
  if (window.__bmExporterLoaded) return;
  window.__bmExporterLoaded = true;

  const STORAGE_KEY = "latest_exported_tweet_id";
  const NO_NEW_THRESHOLD = 5;
  const SCROLL_PAUSE_MS = 700;

  // Public web app bearer (same token x.com's own site ships). Used with the
  // logged-in session cookie so requests run as the current user, read-only.
  const BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  // Last-known-good query ids. These can drift when X redeploys; getQueryIds()
  // refreshes them from X's own loaded code, and the whole API path falls back to
  // DOM scraping if anything here goes stale.
  const DEFAULT_QIDS = {
    Bookmarks: "tUVliYsHyxrQIT4HXUWNdA",
    TweetResultByRestId: "-4_LMahNlI4MuLJ-EAFEog",
  };

  let scanning = false;
  let stopRequested = false;

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function ct0() {
    return (document.cookie.match(/ct0=([^;]+)/) || [])[1] || "";
  }

  // Fire-and-forget to the popup. When the popup is gone the send has no consumer;
  // swallow the rejection. Popup-closed detection is handled by the Port disconnect
  // below (sendMessage can't be relied on to reject, because the background service
  // worker keeps the messaging channel alive).
  function post(action, extra) {
    return chrome.runtime.sendMessage(Object.assign({ action }, extra || {})).catch(() => {});
  }

  function normImg(url) {
    try {
      const u = new URL(url);
      u.searchParams.set("name", "large");
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Query-id discovery (best effort; DEFAULT_QIDS is the fallback)
  // ---------------------------------------------------------------------------

  // Discovery scans X's bundles and is slow, so its result is cached for the life
  // of this content script. A scan, plus any on-demand article fetches, all reuse
  // the same ids instead of re-downloading and re-parsing the bundles each time.
  let qidCache = null;

  async function getQueryIds() {
    if (qidCache) return qidCache;
    const found = Object.assign({}, DEFAULT_QIDS);
    const wanted = Object.keys(found);
    const discovered = Object.create(null); // which ops we actually found in the bundles
    try {
      const srcs = [
        ...new Set(
          performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .concat([...document.querySelectorAll("script[src]")].map((s) => s.src))
            .filter((n) => n && n.includes("twimg.com") && n.endsWith(".js"))
        ),
      ];
      for (const src of srcs) {
        // Stop once we've found every wanted op at least once in the bundles.
        if (wanted.every((w) => discovered[w])) break;
        let txt = "";
        try {
          txt = await (await fetch(src)).text();
        } catch (e) {
          continue;
        }
        for (const m of txt.matchAll(
          /queryId:"([^"]{15,30})"\s*,\s*operationName:"([A-Za-z]+)"/g
        )) {
          if (wanted.includes(m[2])) {
            found[m[2]] = m[1];
            discovered[m[2]] = true;
          }
        }
      }
    } catch (e) {
      /* keep defaults */
    }
    qidCache = found;
    return found;
  }

  // ---------------------------------------------------------------------------
  // GraphQL GET with adaptive feature-flag negotiation
  // ---------------------------------------------------------------------------

  // Feature flags X wants change over time. We start from a reasonable set and,
  // when the server complains "features cannot be null: X", we add X=false and retry.
  function baseFeatures() {
    return {
      graphql_timeline_v2_bookmark_timeline: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      articles_preview_enabled: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      communities_web_enable_tweet_community_results_fetch: true,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      rweb_video_timestamps_enabled: true,
      rweb_tipjar_consumption_enabled: false,
      verified_phone_label_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    };
  }

  async function gql(qid, op, variables, fieldToggles) {
    const features = baseFeatures();
    const token = ct0();
    for (let attempt = 0; attempt < 12; attempt++) {
      let url =
        `https://${location.host}/i/api/graphql/${qid}/${op}` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(features))}`;
      if (fieldToggles) url += `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;

      let res, json;
      try {
        res = await fetch(url, {
          credentials: "include",
          headers: {
            authorization: "Bearer " + BEARER,
            "x-csrf-token": token,
            "x-twitter-auth-type": "OAuth2Session",
            "x-twitter-active-user": "yes",
            "x-twitter-client-language": "en",
          },
        });
      } catch (e) {
        throw new Error("network: " + e.message);
      }
      try {
        json = await res.json();
      } catch (e) {
        json = null;
      }
      if (res.ok && json && !json.errors) return json;

      const msg = json && json.errors ? json.errors.map((e) => e.message).join("; ") : "http " + res.status;
      const missing = msg.match(/features cannot be null:? ([A-Za-z0-9_,\s]+)/i);
      if (missing) {
        missing[1].split(/[,\s]+/).filter(Boolean).forEach((f) => (features[f] = false));
        continue;
      }
      // Unrecoverable (bad query id, auth, rate limit): let the caller fall back.
      throw new Error(msg.slice(0, 160));
    }
    throw new Error("feature negotiation did not converge");
  }

  // ---------------------------------------------------------------------------
  // Result parsing
  // ---------------------------------------------------------------------------

  function unwrap(result) {
    // Tweets can be wrapped as TweetWithVisibilityResults.
    if (result && result.__typename === "TweetWithVisibilityResults") return result.tweet;
    return result;
  }

  function statsOf(t, legacy) {
    const views = t.views && (t.views.count != null ? Number(t.views.count) : null);
    return {
      likes: legacy.favorite_count ?? 0,
      reposts: legacy.retweet_count ?? 0,
      replies: legacy.reply_count ?? 0,
      quotes: legacy.quote_count ?? 0,
      bookmarks: legacy.bookmark_count ?? 0,
      views: Number.isFinite(views) ? views : null,
    };
  }

  function mediaOf(legacy) {
    const media = (legacy.extended_entities && legacy.extended_entities.media) || [];
    const out = [];
    const seen = new Set();
    for (const m of media) {
      let url = m.media_url_https || "";
      if (m.type === "video" || m.type === "animated_gif") {
        // Prefer the highest-bitrate mp4 for video, else keep the thumbnail.
        const variants = (m.video_info && m.video_info.variants) || [];
        const mp4 = variants
          .filter((v) => v.content_type === "video/mp4" && v.bitrate)
          .sort((a, b) => b.bitrate - a.bitrate)[0];
        if (mp4) url = mp4.url;
      } else {
        url = normImg(url);
      }
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    return out;
  }

  function fullText(t, legacy) {
    // Long ("note") tweets carry their full body outside legacy.full_text.
    const note = t.note_tweet && t.note_tweet.note_tweet_results && t.note_tweet.note_tweet_results.result;
    if (note && note.text) return note.text.trim();
    let txt = legacy.full_text || "";
    // Strip the trailing t.co media link X appends to the text.
    txt = txt.replace(/\s+https:\/\/t\.co\/\w+$/, "").trim();
    return txt;
  }

  function userOf(t) {
    const u = (t.core && t.core.user_results && t.core.user_results.result) || {};
    const c = u.core || u.legacy || {};
    return {
      user: c.name || "Unknown",
      handle: "@" + (c.screen_name || "unknown"),
    };
  }

  // Turn one tweet_results.result into our normalized record (no article body yet).
  function parseTweet(resultRaw) {
    const t = unwrap(resultRaw);
    if (!t || !t.legacy) return null;
    const legacy = t.legacy;
    const id = t.rest_id || legacy.id_str;
    const { user, handle } = userOf(t);
    const isArticle = !!t.article;
    return {
      id,
      url: `https://x.com/${handle.replace(/^@/, "")}/status/${id}`,
      user,
      handle,
      date: legacy.created_at ? new Date(legacy.created_at).toISOString() : new Date().toISOString(),
      text: fullText(t, legacy) || (isArticle ? "[Article]" : ""),
      type: isArticle ? "article" : "tweet",
      images: mediaOf(legacy),
      stats: statsOf(t, legacy),
      _articleRest: isArticle ? id : null,
      enriched: !isArticle, // plain tweets are complete already
      parts: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Article body (full text + inline images, in author order) via one API call
  // ---------------------------------------------------------------------------

  function buildArticleParts(art) {
    const cs = art.content_state;
    if (!cs || !Array.isArray(cs.blocks)) return null;

    // Map each media entity id -> best image url.
    const mediaById = {};
    (art.media_entities || []).forEach((m) => {
      const info = m.media_info || {};
      if (info.original_img_url) mediaById[m.media_id] = normImg(info.original_img_url);
    });
    // entity key -> { type, mediaId }. Atomic blocks aren't all images: X uses them
    // for dividers, emoji, links and embeds too, so we need the entity TYPE to tell
    // a real image apart from a horizontal rule.
    const entities = {};
    const em = cs.entityMap;
    const emList = Array.isArray(em) ? em : Object.entries(em || {}).map(([k, v]) => ({ key: k, value: v }));
    emList.forEach((e) => {
      const v = e.value || e;
      const key = e.key != null ? e.key : v.key;
      const items = (v.data && v.data.mediaItems) || [];
      entities[key] = { type: v.type, mediaId: items[0] && items[0].mediaId };
    });

    const parts = [];
    let imagesSeen = 0; // atomic blocks that are genuinely images
    let imagesResolved = 0;
    for (const b of cs.blocks) {
      if (b.type === "atomic") {
        const key = b.entityRanges && b.entityRanges[0] && b.entityRanges[0].key;
        const ent = key != null ? entities[key] : null;
        const etype = ent && ent.type;
        if (etype === "MEDIA") {
          imagesSeen++;
          const url = ent.mediaId && mediaById[ent.mediaId];
          if (url) {
            parts.push({ type: "image", value: url });
            imagesResolved++;
          }
        } else if (etype === "DIVIDER") {
          parts.push({ type: "text", value: "---" });
        }
        // Other atomics (emoji, links, embedded tweets) have no standalone form
        // here; skip them without counting them as lost images.
      } else {
        const text = (b.text || "").trim();
        if (!text) continue;
        if (b.type === "header-two" || b.type === "header-one") parts.push({ type: "text", value: "## " + text });
        else if (b.type === "unordered-list-item") parts.push({ type: "text", value: "- " + text });
        else if (b.type === "ordered-list-item") parts.push({ type: "text", value: "1. " + text });
        else parts.push({ type: "text", value: text });
      }
    }
    // Warn only when a genuine image entity failed to resolve, which would signal an
    // actual X format change. console.debug keeps it out of the extensions error list
    // while still available in devtools for diagnosis.
    if (imagesSeen > imagesResolved) {
      console.debug(
        `[GIMMIE] Article ${art.rest_id || "?"}: ${imagesSeen - imagesResolved} of ${imagesSeen} images could not be matched.`
      );
    }
    return parts.length ? parts : null;
  }

  async function fetchArticle(qids, tweet) {
    const json = await gql(
      qids.TweetResultByRestId,
      "TweetResultByRestId",
      {
        tweetId: tweet._articleRest,
        includePromotedContent: false,
        withBirdwatchNotes: false,
        withVoice: false,
        withCommunity: true,
      },
      {
        withArticleRichContentState: true,
        withArticlePlainText: false,
        withArticleSummaryText: true,
      }
    );
    const r = unwrap(json && json.data && json.data.tweetResult && json.data.tweetResult.result);
    const art = r && r.article && r.article.article_results && r.article.article_results.result;
    if (!art) return null;

    const parts = buildArticleParts(art);
    const title = art.title || "";
    let text = "";
    let images = [];
    if (parts) {
      text = parts.filter((p) => p.type === "text").map((p) => p.value).join("\n\n");
      images = parts.filter((p) => p.type === "image").map((p) => p.value);
    }
    if (title) text = "# " + title + "\n\n" + text;
    return { title, text: text.trim(), images, parts };
  }

  // ---------------------------------------------------------------------------
  // Bookmarks paging
  // ---------------------------------------------------------------------------

  function entriesFrom(json) {
    const tl =
      json &&
      json.data &&
      (json.data.bookmark_timeline_v2 || json.data.bookmark_timeline) &&
      (json.data.bookmark_timeline_v2 || json.data.bookmark_timeline).timeline;
    const instructions = (tl && tl.instructions) || [];
    const all = instructions.flatMap((i) => i.entries || []);
    const tweets = [];
    let cursor = null;
    for (const e of all) {
      if (e.entryId && e.entryId.startsWith("tweet-")) {
        const res = e.content && e.content.itemContent && e.content.itemContent.tweet_results && e.content.itemContent.tweet_results.result;
        if (res) tweets.push(res);
      } else if (e.entryId && e.entryId.includes("cursor-bottom")) {
        cursor = e.content && e.content.value;
      }
    }
    return { tweets, cursor };
  }

  async function runApiScan(mode) {
    const qids = await getQueryIds();

    let watermarkId = null;
    if (mode === "smart_sync") {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      watermarkId = stored[STORAGE_KEY] != null ? String(stored[STORAGE_KEY]) : null;
    }

    const collected = [];
    const seen = new Set();
    let cursor = null;
    let page = 0;
    let newestId = null;
    let reachedWatermark = false;

    post("scan_status", { phase: "collecting", note: "Connecting to your bookmarks" });

    while (!stopRequested && !reachedWatermark) {
      page++;
      const vars = { count: 100, includePromotedContent: false };
      if (cursor) vars.cursor = cursor;

      let json;
      try {
        json = await gql(qids.Bookmarks, "Bookmarks", vars);
      } catch (e) {
        if (page === 1) throw e; // total failure on page 1 -> caller falls back to DOM
        break; // partial success: keep what we have
      }

      const { tweets, cursor: next } = entriesFrom(json);
      let newInPage = 0;
      for (const raw of tweets) {
        const rec = parseTweet(raw);
        if (!rec || seen.has(rec.id)) continue;
        if (mode === "smart_sync" && watermarkId && BigInt(rec.id) <= BigInt(watermarkId)) {
          reachedWatermark = true;
          break;
        }
        seen.add(rec.id);
        if (!newestId) newestId = rec.id;
        collected.push(rec);
        newInPage++;
        post("new_tweet", { data: rec });
      }

      post("scan_status", {
        phase: "collecting",
        note: `Loaded ${collected.length} bookmarks (page ${page})`,
        count: collected.length,
        page,
      });

      if (!next || newInPage === 0) break;
      cursor = next;
      await sleep(350); // gentle pacing between pages
    }

    // Enrich articles (full body + inline images) one call at a time.
    const articles = collected.filter((t) => t.type === "article" && t._articleRest);
    if (articles.length && !stopRequested) {
      post("scan_status", { phase: "articles", note: "Reading full articles", done: 0, total: articles.length });
      let done = 0;
      for (const t of articles) {
        if (stopRequested) break;
        try {
          const data = await fetchArticle(qids, t);
          if (data) {
            if (data.text) t.text = data.text;
            if (data.images && data.images.length) t.images = data.images;
            t.parts = data.parts || null;
          }
        } catch (e) {
          /* leave the preview text as-is */
        }
        t.enriched = true;
        done++;
        post("tweet_updated", { id: t.id, data: t });
        post("scan_status", { phase: "articles", note: `Read article ${done} of ${articles.length}`, done, total: articles.length });
        await sleep(250);
      }
    }

    if (newestId) chrome.storage.local.set({ [STORAGE_KEY]: newestId });
    post("scan_status", { phase: "done", note: "All done", count: collected.length });
    post("scan_complete", { total: collected.length, via: "api" });
    return collected.length;
  }

  // ===========================================================================
  // DOM fallback (the original scroll-and-scrape path) - used only if the API
  // route fails outright, so the extension still works if X locks the API down.
  // ===========================================================================

  function getTweetIdAndUrl(article) {
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const href = link.getAttribute("href") || "";
    const match = href.match(/\/status\/(\d+)/);
    if (!match) return null;
    const base = window.location.origin;
    const path = href.startsWith("http") ? href : base + (href.startsWith("/") ? href : "/" + href);
    return { id: match[1], url: path };
  }

  function extractImagesDom(article) {
    const images = [];
    const seen = new Set();
    article.querySelectorAll("img").forEach((img) => {
      const src = img.src || img.getAttribute("src") || "";
      if (!src.includes("pbs.twimg.com/media") && !src.includes("pbs.twimg.com/card_img")) return;
      const n = normImg(src);
      if (!seen.has(n)) {
        seen.add(n);
        images.push(n);
      }
    });
    return images;
  }

  function scrapeDom(article) {
    try {
      const idUrl = getTweetIdAndUrl(article);
      if (!idUrl) return null;
      const userEl = article.querySelector('div[data-testid="User-Name"]');
      if (!userEl) return null;
      const timeEl = article.querySelector("time");
      const textEl = article.querySelector('div[data-testid="tweetText"]');
      let text = textEl ? textEl.innerText.trim() : "";
      let type = "tweet";
      const isArt = !!article.querySelector('[data-testid="article"], [data-testid="article-title"], [data-testid="articleTitle"]');
      if (!text || isArt) {
        type = "article";
        if (!text) text = "[Article - open link for full content]";
      }
      return {
        id: idUrl.id,
        url: idUrl.url,
        user: userEl.innerText.split("\n")[0],
        handle: userEl.innerText.split("\n")[1] || "@unknown",
        date: timeEl ? timeEl.getAttribute("datetime") : new Date().toISOString(),
        text,
        type,
        images: extractImagesDom(article),
        stats: null, // engagement stats aren't reliably in the DOM
        enriched: true,
        parts: null,
      };
    } catch (e) {
      return null;
    }
  }

  async function runDomScan(mode) {
    let watermarkId = null;
    if (mode === "smart_sync") {
      const r = await chrome.storage.local.get(STORAGE_KEY);
      watermarkId = r[STORAGE_KEY] != null ? String(r[STORAGE_KEY]) : null;
    }
    const collected = [];
    const seen = new Set();
    let stuck = 0;
    let lastY = -1;
    let rounds = 0;
    const MAX_ROUNDS = 600;

    post("scan_status", { phase: "collecting", note: "Scanning your bookmarks" });
    window.scrollTo(0, 0);
    await sleep(400);

    while (rounds++ < MAX_ROUNDS && !stopRequested) {
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"], article'));
      let newInRound = 0;
      for (const article of articles) {
        const idUrl = getTweetIdAndUrl(article);
        if (!idUrl || seen.has(idUrl.id)) continue;
        if (mode === "smart_sync" && watermarkId && BigInt(idUrl.id) <= BigInt(watermarkId)) {
          finishDom(collected);
          return collected.length;
        }
        const rec = scrapeDom(article);
        if (!rec) continue;
        seen.add(idUrl.id);
        newInRound++;
        collected.push(rec);
        post("new_tweet", { data: rec });
      }

      const docEl = document.scrollingElement || document.documentElement;
      window.scrollBy(0, Math.max(600, Math.round(window.innerHeight * 1.2)));
      await sleep(SCROLL_PAUSE_MS);
      const y = docEl.scrollTop;
      const scrolled = y > lastY + 2;
      lastY = y;
      post("scan_status", { phase: "collecting", note: `Scanning... ${collected.length} found`, count: collected.length });
      if (newInRound === 0 && !scrolled) {
        if (++stuck >= NO_NEW_THRESHOLD) break;
      } else stuck = 0;
    }
    finishDom(collected);
    return collected.length;
  }

  function finishDom(collected) {
    if (collected.length) chrome.storage.local.set({ [STORAGE_KEY]: collected[0].id });
    post("scan_status", { phase: "done", note: "All done", count: collected.length });
    post("scan_complete", { total: collected.length, via: "dom" });
  }

  // ---------------------------------------------------------------------------
  // Orchestration: try the fast API path, fall back to DOM scraping
  // ---------------------------------------------------------------------------

  async function runScan(mode) {
    scanning = true;
    stopRequested = false;
    try {
      await runApiScan(mode);
    } catch (e) {
      console.log("[Bookmark Exporter] API path unavailable, using page scan:", e.message);
      post("scan_status", { phase: "collecting", note: "Reading the page directly" });
      try {
        await runDomScan(mode);
      } catch (e2) {
        console.error(e2);
        post("scan_complete", { total: 0, via: "error" });
      }
    } finally {
      scanning = false;
    }
  }

  // The popup holds a long-lived Port open for its whole lifetime. When the popup
  // closes, onDisconnect fires here reliably (unlike sendMessage, which resolves
  // against the background context and never rejects). If a scan is in flight, stop
  // it: no one is listening, and continuing just burns the user's X rate limit.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "gimmie-popup") return;
    port.onDisconnect.addListener(() => {
      if (scanning) stopRequested = true;
    });
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start_scan" && request.mode) {
      if (scanning) {
        sendResponse({ ok: false, busy: true });
        return true;
      }
      runScan(request.mode).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (request.action === "stop_scan") {
      stopRequested = true;
      sendResponse({ ok: true });
      return true;
    }
    // On-demand single-article fetch for "pick" mode (when the user opens/selects one).
    if (request.action === "fetch_article" && request.tweet) {
      (async () => {
        try {
          const qids = await getQueryIds();
          const data = await fetchArticle(qids, request.tweet);
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }
  });
})();
