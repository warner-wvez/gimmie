// ============================================================
// Bookmark Exporter - popup logic
// Collection now runs through content.js (X's own data API, with a
// page-scraping fallback). This file drives the UI, the live activity
// readout, and the exports.
// Views: welcome -> start -> scan/results -> detail
// ============================================================

let tweetsData = [];
let idToIndex = new Map();
let cardTextEls = [];
let cardEls = [];
let selectedIdx = new Set();
let currentDetailTweet = null;
let activeTabId = null;

let scanPhase = "idle"; // idle | collecting | articles | done
let autoProcessArticles = true;
let displayCount = 0; // animated count, eases toward tweetsData.length
let scanPort = null; // live Port to the content script; its disconnect stops a running scan

// ---------- Animated count ----------

function tickCount() {
  const el = document.getElementById("count");
  if (!el) return;
  const target = tweetsData.length;
  if (displayCount !== target) {
    const step = Math.max(1, Math.ceil((target - displayCount) / 4));
    displayCount = Math.min(target, displayCount + step);
    el.innerText = displayCount;
  }
  requestAnimationFrame(tickCount);
}
requestAnimationFrame(tickCount);

// ---------- Progress + activity readout ----------

function progressIndeterminate() {
  const p = document.getElementById("progress");
  p.classList.remove("done");
  p.classList.add("indeterminate");
}
function progressSet(pct) {
  const p = document.getElementById("progress");
  p.classList.remove("indeterminate", "done");
  document.getElementById("progress-fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
}
function progressDone() {
  document.getElementById("progress-fill").style.width = "100%";
  document.getElementById("progress").classList.add("done");
}

// The three-step flow chip row (Collect -> Read articles -> Ready)
function setFlowStep(step) {
  ["collect", "articles", "ready"].forEach((name) => {
    const el = document.getElementById("flow-" + name);
    if (!el) return;
    el.classList.remove("active", "complete");
    const order = ["collect", "articles", "ready"];
    const cur = order.indexOf(step);
    const mine = order.indexOf(name);
    if (mine < cur) el.classList.add("complete");
    else if (mine === cur) el.classList.add("active");
  });
}

function setActivity(text) {
  const el = document.getElementById("activity-text");
  if (el) el.innerText = text;
}

const views = {
  welcome: document.getElementById("view-welcome"),
  start: document.getElementById("view-start"),
  scan: document.getElementById("view-scan"),
  detail: document.getElementById("view-detail"),
};
function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

// ---------- Init / routing ----------

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  const tab = tabs[0];
  activeTabId = tab.id;
  const url = tab.url || "";
  const onBookmarks = url.includes("x.com/i/bookmarks") || url.includes("twitter.com/i/bookmarks");
  if (!onBookmarks) {
    showView("welcome");
    return;
  }
  const stored = await chrome.storage.local.get("latest_exported_tweet_id");
  if (stored.latest_exported_tweet_id) {
    document.getElementById("scanNewBtn").style.display = "block";
  }
  showView("start");
});

// ---------- Install / share guide ----------
document.querySelectorAll("[data-open-install]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("install.html") });
  });
});

// ---------- Welcome: go to bookmarks ----------

document.getElementById("goToBookmarksBtn").addEventListener("click", () => {
  const scanBtn = document.getElementById("scanAllBtn");
  const startTitle = document.getElementById("start-title");
  const startSub = document.getElementById("start-sub");
  showView("start");
  startTitle.innerText = "Loading your bookmarks...";
  startSub.innerText = "Hang tight, we're opening your saved posts on X.";
  scanBtn.disabled = true;
  chrome.tabs.update(activeTabId, { url: "https://x.com/i/bookmarks" });
  function onUpdated(tabId, info, tab) {
    if (tabId !== activeTabId || info.status !== "complete") return;
    const u = tab.url || "";
    if (!u.includes("/i/bookmarks")) return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    startTitle.innerText = "You're all set";
    startSub.innerText = "Your bookmarks are open. Hit the button and we'll collect everything.";
    scanBtn.disabled = false;
  }
  chrome.tabs.onUpdated.addListener(onUpdated);
});

// ---------- Start: scan buttons ----------

document.getElementById("scanAllBtn").addEventListener("click", () => startScan("full_export", true));
document.getElementById("scanPickBtn").addEventListener("click", () => startScan("full_export", false));
document.getElementById("scanNewBtn").addEventListener("click", () => startScan("smart_sync", true));

function startScan(mode, autoProcess) {
  autoProcessArticles = autoProcess;
  scanPhase = "collecting";

  tweetsData = [];
  idToIndex = new Map();
  cardTextEls = [];
  cardEls = [];
  selectedIdx = new Set();
  displayCount = 0;

  showView("scan");
  document.getElementById("count").innerText = "0";
  document.getElementById("count-label").innerText = "found so far";
  document.getElementById("scan-count").classList.remove("done");
  document.getElementById("export-bar").style.display = "none";
  document.getElementById("selbar").style.display = "none";
  document.getElementById("scanAgainBtn").style.display = "none";
  const stopBtn = document.getElementById("stopBtn");
  stopBtn.style.display = "block";
  stopBtn.disabled = false;
  document.getElementById("results-area").innerHTML = "";
  document.getElementById("flow-row").style.display = "flex";
  document.getElementById("activity").classList.remove("done");
  setFlowStep("collect");
  setActivity("Getting started...");
  progressIndeterminate();

  chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ["content.js"] }, () => {
    // Hold a Port open to the content script for as long as this popup lives. If the
    // popup closes mid-scan, the content script's onDisconnect fires and stops the
    // scan, so we don't keep hitting X's API for a window nobody is watching.
    try {
      if (scanPort) scanPort.disconnect();
      scanPort = chrome.tabs.connect(activeTabId, { name: "gimmie-popup" });
      scanPort.onDisconnect.addListener(() => {
        // Read lastError so Chrome doesn't log an unchecked-error warning.
        void chrome.runtime.lastError;
        scanPort = null;
      });
    } catch (e) {
      /* connection is best-effort; the scan still runs without it */
    }
    setTimeout(() => {
      chrome.tabs.sendMessage(activeTabId, { action: "start_scan", mode });
    }, 60);
  });
}

// Stop
document.getElementById("stopBtn").addEventListener("click", () => {
  chrome.tabs.sendMessage(activeTabId, { action: "stop_scan" });
  setActivity("Finishing up...");
  document.getElementById("stopBtn").disabled = true;
});

// ---------- Incoming scan messages ----------

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "new_tweet") {
    addCard(request.data);
  } else if (request.action === "tweet_updated") {
    applyUpdate(request.id, request.data);
  } else if (request.action === "scan_status") {
    handleStatus(request);
  } else if (request.action === "scan_complete") {
    finishScan(request);
  }
});

function handleStatus(s) {
  if (s.note) setActivity(s.note);
  if (s.phase === "collecting") {
    scanPhase = "collecting";
    setFlowStep("collect");
    progressIndeterminate();
    document.getElementById("count-label").innerText = "found so far";
  } else if (s.phase === "articles") {
    scanPhase = "articles";
    setFlowStep("articles");
    document.getElementById("count-label").innerText = "reading articles";
    if (s.total) progressSet((s.done / s.total) * 100);
  } else if (s.phase === "done") {
    setFlowStep("ready");
  }
}

function addCard(tweet) {
  const index = tweetsData.length;
  tweetsData.push(tweet);
  idToIndex.set(tweet.id, index);

  const isArticle = tweet.type === "article";
  const imgCount = tweet.images ? tweet.images.length : 0;

  let badges = "";
  if (isArticle) badges += `<span class="badge badge-article">Article</span>`;
  if (imgCount > 0) {
    badges += `<span class="badge badge-img">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
      ${imgCount}</span>`;
  }

  const div = document.createElement("div");
  div.className = "card card-enter";
  div.innerHTML = `
    <input type="checkbox" class="card-check" title="Select for download">
    <div class="card-body">
      <div class="card-top">
        <div class="card-who">
          <span class="c-user">${escHtml(tweet.user)}</span>
          <span class="c-handle">${escHtml(tweet.handle)}</span>
          ${badges}
        </div>
        <span class="c-date">${(tweet.date || "").substring(0, 10)}</span>
      </div>
      <div class="c-text">${escHtml((tweet.text || "").substring(0, 130))}${(tweet.text || "").length > 130 ? "..." : ""}</div>
      ${statsRowHtml(tweet.stats)}
    </div>
  `;
  div.querySelector(".card-body").addEventListener("click", () => openDetail(index));
  div.querySelector(".card-check").addEventListener("change", (e) => toggleSelect(index, e.target.checked));

  cardTextEls[index] = div.querySelector(".c-text");
  cardEls[index] = div;
  document.getElementById("results-area").appendChild(div);
  requestAnimationFrame(() => div.classList.remove("card-enter"));
}

function fmt(n) {
  if (n == null) return "-";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function statsRowHtml(stats) {
  if (!stats) return "";
  const item = (label, val) => `<span class="stat" title="${label}">${statIcon(label)}${fmt(val)}</span>`;
  return `<div class="stat-row">
    ${item("Replies", stats.replies)}
    ${item("Reposts", stats.reposts)}
    ${item("Likes", stats.likes)}
    ${item("Views", stats.views)}
  </div>`;
}

function statIcon(kind) {
  const paths = {
    Replies: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>',
    Reposts: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
    Likes: '<path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/>',
    Views: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths[kind] || ""}</svg>`;
}

// Article enrichment arrived: refresh that card's preview + badge + stats
function applyUpdate(id, data) {
  const index = idToIndex.get(id);
  if (index == null) return;
  tweetsData[index] = data;
  const el = cardTextEls[index];
  if (el) {
    el.textContent = (data.text || "").substring(0, 130) + ((data.text || "").length > 130 ? "..." : "");
  }
  const card = cardEls[index];
  if (card && data.images && data.images.length > 0 && !card.querySelector(".badge-img")) {
    const who = card.querySelector(".card-who");
    if (who) {
      const b = document.createElement("span");
      b.className = "badge badge-img";
      b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> ${data.images.length}`;
      who.appendChild(b);
    }
  }
  if (currentDetailTweet && currentDetailTweet.id === id) {
    currentDetailTweet = data;
    document.getElementById("detail-body").innerHTML = buildDetailHTML(data);
    setDetailFmtEnabled(true);
  }
  updateSelbar();
}

function finishScan(info) {
  scanPhase = "done";
  progressDone();
  setActivity(info && info.via === "dom" ? "Done (read from the page)" : "Done");
  document.getElementById("activity").classList.add("done");
  document.getElementById("stopBtn").style.display = "none";
  document.getElementById("scanAgainBtn").style.display = "block";

  if (tweetsData.length === 0) {
    document.getElementById("count-label").innerText = "found";
    document.getElementById("flow-row").style.display = "none";
    document.getElementById("results-area").innerHTML = `
      <div class="empty">
        <b>Nothing found yet</b>
        Make sure you're on your X bookmarks page and have posts saved, then try again.
      </div>`;
    return;
  }

  document.getElementById("scan-count").classList.add("done");
  if (autoProcessArticles) {
    document.getElementById("count-label").innerText = "ready to export";
    document.getElementById("export-bar").style.display = "block";
  } else {
    document.getElementById("count-label").innerText = "open one, or check posts to download";
  }
}

document.getElementById("scanAgainBtn").addEventListener("click", () => location.reload());

// ---------- On-demand article fetch (pick mode) ----------
// No tabs: ask the content script to pull one article through the API.

function requestArticle(index) {
  const t = tweetsData[index];
  if (!t || t.type !== "article" || t.enriched || t._fetching) return;
  t._fetching = true;
  chrome.tabs.sendMessage(activeTabId, { action: "fetch_article", tweet: t }, (resp) => {
    t._fetching = false;
    if (resp && resp.ok && resp.data) {
      if (resp.data.text) t.text = resp.data.text;
      if (resp.data.images && resp.data.images.length) t.images = resp.data.images;
      t.parts = resp.data.parts || null;
    }
    t.enriched = true;
    applyUpdate(t.id, t);
  });
}

// ---------- Selection ----------

function toggleSelect(index, on) {
  if (on) {
    selectedIdx.add(index);
    requestArticle(index);
  } else {
    selectedIdx.delete(index);
  }
  if (cardEls[index]) cardEls[index].classList.toggle("selected", on);
  updateSelbar();
}

function selectionPending() {
  for (const i of selectedIdx) {
    const t = tweetsData[i];
    if (t && t.type === "article" && !t.enriched) return true;
  }
  return false;
}

function updateSelbar() {
  const n = selectedIdx.size;
  const bar = document.getElementById("selbar");
  if (n === 0) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "block";
  const pending = selectionPending();
  bar.querySelectorAll("[data-format]").forEach((b) => (b.disabled = pending));
  document.getElementById("sel-count").innerText = pending
    ? `${n} selected · reading article...`
    : `${n} selected`;
}

// ---------- Detail view ----------

function buildDetailHTML(tweet) {
  const isArticle = tweet.type === "article";
  let html = `
    <div class="d-meta">
      <div>
        <span class="d-name">${escHtml(tweet.user)}</span>
        <span class="d-handle">${escHtml(tweet.handle)}</span>
        ${isArticle ? '<span class="badge badge-article" style="margin-left:6px;">Article</span>' : ""}
      </div>
      <div class="d-date">${(tweet.date || "").substring(0, 10)}</div>
    </div>
  `;

  if (isArticle && !tweet.enriched) {
    html += `
      <div class="loading" id="article-loading">
        <div class="spinner"></div>
        <span>Reading the full article...</span>
      </div>`;
  }

  html += `<div class="d-text" id="d-text">${escHtml(tweet.text || "")}</div>`;

  if (tweet.images && tweet.images.length > 0) {
    html += `<div class="d-label">Media (${tweet.images.length}), in order</div>`;
    tweet.images.forEach((src, i) => {
      html += `
        <a class="img-row" href="${src}" target="_blank">
          <span class="img-idx">${i + 1}</span>
          <span class="img-url">${src}</span>
        </a>`;
    });
  }

  if (tweet.stats) {
    html += `<div class="d-label">Engagement</div>${statsRowHtml(tweet.stats).replace("stat-row", "stat-row stat-row-detail")}`;
  }

  html += `<div class="d-source"><a href="${tweet.url}" target="_blank">${tweet.url}</a></div>`;
  return html;
}

function setDetailFmtEnabled(on) {
  document.querySelectorAll("#detail-fmt [data-format]").forEach((b) => (b.disabled = !on));
}

function openDetail(index) {
  currentDetailTweet = tweetsData[index];
  const tweet = currentDetailTweet;
  document.getElementById("detail-body").innerHTML = buildDetailHTML(tweet);
  showView("detail");
  if (tweet.type === "article" && !tweet.enriched) {
    setDetailFmtEnabled(false);
    requestArticle(index);
  } else {
    setDetailFmtEnabled(true);
  }
}

document.getElementById("backBtn").addEventListener("click", () => {
  currentDetailTweet = null;
  document.getElementById("detail-body").innerHTML = "";
  showView("scan");
});

document.querySelectorAll("#detail-fmt [data-format]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (currentDetailTweet) downloadSingleTweet(currentDetailTweet, btn.dataset.format);
  });
});

// ---------- Exports ----------

// Every export format is built from these shared helpers so a single post and the
// whole archive always look the same.

function shortDate(t) {
  return (t.date || "").substring(0, 10);
}

function statsInline(stats) {
  if (!stats) return "";
  const parts = [
    `${fmt(stats.likes)} likes`,
    `${fmt(stats.reposts)} reposts`,
    `${fmt(stats.replies)} replies`,
    `${fmt(stats.quotes)} quotes`,
    `${fmt(stats.bookmarks)} bookmarks`,
  ];
  if (stats.views != null) parts.push(`${fmt(stats.views)} views`);
  return parts.join(" · ");
}

// The body (text + media), shared by single and bulk markdown.
function bodyMarkdown(tweet) {
  const isArticle = tweet.type === "article";
  let md = "";
  if (isArticle && tweet.parts && tweet.parts.length) {
    tweet.parts.forEach((p) => {
      if (p.type === "text") md += `${p.value}\n\n`;
      else if (p.type === "image") md += `![image](${p.value})\n\n`;
    });
  } else {
    md += `${tweet.text}\n\n`;
    if (tweet.images && tweet.images.length > 0) {
      md += `**Media (in order):**\n\n`;
      tweet.images.forEach((src, i) => {
        md += `${i + 1}. ${src}\n`;
      });
      md += `\n`;
    }
  }
  return md;
}

// One clearly-bounded entry: a numbered, typed heading, a metadata line, the body,
// and a horizontal rule closing it off so posts never blur together.
function entryMarkdown(tweet, n) {
  const type = tweet.type === "article" ? "Article" : "Tweet";
  let md = `## ${n}. ${type} — ${tweet.user} (${tweet.handle})\n\n`;
  md += `- **Posted:** ${shortDate(tweet)}\n`;
  md += `- **Link:** ${tweet.url}\n`;
  if (tweet.stats) md += `- **Engagement:** ${statsInline(tweet.stats)}\n`;
  md += `\n`;
  md += bodyMarkdown(tweet);
  md += `---\n\n`;
  return md;
}

function buildMarkdownFor(list) {
  const articles = list.filter((t) => t.type === "article").length;
  let head = `# X Bookmarks Archive\n\n`;
  head += `**Exported:** ${todayStamp()}  \n`;
  head += `**Posts:** ${list.length}${articles ? ` (${articles} articles, ${list.length - articles} tweets)` : ""}\n\n`;
  head += `> **For AI tools (NotebookLM, etc.):** Each numbered section below is one saved post, separated by a horizontal rule. Prioritize the post text and article content. Media links and engagement counts are provided for context. Group posts that read like a thread.\n\n`;
  head += `---\n\n`;
  let body = "";
  list.forEach((t, i) => {
    body += entryMarkdown(t, i + 1);
  });
  return head + body;
}

function buildArchiveMarkdown() {
  return buildMarkdownFor(tweetsData);
}

// -------- JSON: full structured data, one object per post --------
function buildJsonFor(list) {
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      source: "x.com/i/bookmarks",
      count: list.length,
      posts: list.map((t) => ({
        id: t.id,
        type: t.type,
        user: t.user,
        handle: t.handle,
        date: t.date,
        url: t.url,
        text: t.text,
        images: t.images || [],
        stats: t.stats || null,
        article_parts: t.parts || null,
      })),
    },
    null,
    2
  );
}

// -------- CSV --------
function buildCsvFor(list) {
  let csv = "﻿Type,User,Handle,Date,Text,Likes,Reposts,Replies,Quotes,Bookmarks,Views,Images,URL\n";
  // Neutralize spreadsheet formula injection: a cell starting with = + - @ (or a
  // control char that some parsers strip to reach one) is treated as a formula by
  // Excel/Sheets. Handles always start with "@", so prefix those cells with a
  // single quote so the value is shown as literal text.
  const cell = (v) => {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  list.forEach((t) => {
    const safeText = (t.text || "").replace(/[\r\n]+/g, " ");
    const imgs = (t.images || []).join(" | ");
    const type = t.type === "article" ? "Article" : "Tweet";
    const s = t.stats || {};
    csv +=
      [
        cell(type), cell(t.user), cell(t.handle), cell(t.date), cell(safeText),
        cell(s.likes), cell(s.reposts), cell(s.replies), cell(s.quotes), cell(s.bookmarks), cell(s.views),
        cell(imgs), cell(t.url),
      ].join(",") + "\n";
  });
  return csv;
}

// -------- PDF: render the archive on a packaged print page and let the browser's
//              print dialog save it as a PDF. No PDF library bundled. --------
// The body HTML is built here (all values escaped) and handed to printview.html
// via storage; printview.js injects it and calls window.print(). Kept off an inline
// script so it complies with the extension's content security policy.
function buildPrintBodyHtml(list) {
  const esc = escHtml;
  let rows = "";
  list.forEach((t, i) => {
    const type = t.type === "article" ? "Article" : "Tweet";
    let body = "";
    if (t.type === "article" && t.parts && t.parts.length) {
      t.parts.forEach((p) => {
        if (p.type === "text") body += `<p>${esc(p.value)}</p>`;
        else if (p.type === "image") body += `<img src="${esc(p.value)}" alt="">`;
      });
    } else {
      body += `<p>${esc(t.text || "").replace(/\n/g, "<br>")}</p>`;
      (t.images || []).forEach((src) => (body += `<img src="${esc(src)}" alt="">`));
    }
    rows += `<article>
      <h2>${i + 1}. ${type} — ${esc(t.user)} <span class="h">${esc(t.handle)}</span></h2>
      <div class="meta">${shortDate(t)} · <a href="${esc(t.url)}">${esc(t.url)}</a>${
      t.stats ? " · " + esc(statsInline(t.stats)) : ""
    }</div>
      ${body}
    </article>`;
  });
  return `<h1>X Bookmarks Archive</h1>
    <div class="sub">Exported ${todayStamp()} · ${list.length} posts</div>${rows}`;
}

function openPrintable(list) {
  chrome.storage.local.set({ __print_html: buildPrintBodyHtml(list) }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("printview.html") });
  });
}

function triggerDownload(text, mime, filename) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function baseName(list) {
  if (list.length === 1) {
    return `${(list[0].handle || "post").replace(/[^a-z0-9_]/gi, "_")}_${shortDate(list[0])}`;
  }
  return `x_bookmarks_${todayStamp()}`;
}

// ---------- ZIP (store method, no compression, no dependency) ----------
// Bundles the combined archive, the raw JSON, and one .md file per post so the
// user gets each bookmark as its own file too.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function buildZip(files) {
  // files: [{name, text}]
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = [].concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0)
    );
    chunks.push(new Uint8Array(local), nameBytes, data);
    const localSize = local.length + nameBytes.length + data.length;
    const cen = [].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
    );
    central.push(new Uint8Array(cen), nameBytes);
    offset += localSize;
  }
  let centralSize = 0;
  central.forEach((c) => (centralSize += c.length));
  const end = new Uint8Array(
    [].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralSize), u32(offset), u16(0)
    )
  );
  const blobParts = chunks.concat(central, [end]);
  return new Blob(blobParts, { type: "application/zip" });
}

function downloadZip(list) {
  const files = [
    { name: "bookmarks_archive.md", text: buildMarkdownFor(list) },
    { name: "bookmarks_data.json", text: buildJsonFor(list) },
  ];
  list.forEach((t, i) => {
    const num = String(i + 1).padStart(3, "0");
    const who = (t.handle || "post").replace(/[^a-z0-9_]/gi, "_");
    files.push({ name: `posts/${num}_${who}.md`, text: entryMarkdown(t, i + 1) });
  });
  const blob = buildZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName(list)}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- Export a given list in a given format ----------
function exportList(list, format) {
  if (!list.length) return;
  const name = baseName(list);
  if (format === "md") triggerDownload(buildMarkdownFor(list), "text/markdown", `${name}.md`);
  else if (format === "pdf") openPrintable(list);
  else if (format === "json") triggerDownload(buildJsonFor(list), "application/json", `${name}.json`);
  else if (format === "csv") triggerDownload(buildCsvFor(list), "text/csv;charset=utf-8;", `${name}.csv`);
  else if (format === "zip") downloadZip(list);
}

// Wire every format button in the export bar (data-format attribute).
document.querySelectorAll("#export-bar [data-format]").forEach((btn) => {
  btn.addEventListener("click", () => exportList(tweetsData, btn.dataset.format));
});

// NotebookLM: a deliberate, secondary action. Downloads the markdown, then opens
// NotebookLM so the user can drop the file in. Only on explicit click.
document.getElementById("btnNotebookLM").addEventListener("click", () => {
  if (!tweetsData.length) return;
  exportList(tweetsData, "md");
  chrome.tabs.create({ url: "https://notebooklm.google.com/" });
});

// Selected posts: same format menu, scoped to the checked posts.
document.querySelectorAll("#selbar [data-format]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (selectionPending()) return;
    const idxs = [...selectedIdx].sort((a, b) => a - b);
    if (!idxs.length) return;
    exportList(idxs.map((i) => tweetsData[i]), btn.dataset.format);
  });
});

document.getElementById("selClearBtn").addEventListener("click", () => {
  selectedIdx.forEach((i) => {
    if (!cardEls[i]) return;
    cardEls[i].classList.remove("selected");
    const cb = cardEls[i].querySelector(".card-check");
    if (cb) cb.checked = false;
  });
  selectedIdx = new Set();
  updateSelbar();
});

// Single post from the detail view, in the chosen format.
function downloadSingleTweet(tweet, format) {
  exportList([tweet], format || "md");
}

// ---------- Utils ----------

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
