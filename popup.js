// ============================================================
// GIMMIE - popup logic
// Collection runs through content.js (X's own data API, with a page-scraping
// fallback). This file drives the UI, the live activity readout, and the exports.
// Views: welcome -> scan/results -> detail
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

// Filter + sort state for the results list.
let sortBy = "recent"; // recent | oldest | posted_new | posted_old | likes | views | reposts
let typeFilter = "all"; // all | tweet | article
let searchText = "";

// ---------- Animated count ----------
// Runs only while the displayed number is catching up to the real count, then
// stops. animateCount() restarts it whenever a new card arrives.

let countRAF = null;

function tickCount() {
  const el = document.getElementById("count");
  const target = tweetsData.length;
  if (el && displayCount !== target) {
    const step = Math.max(1, Math.ceil((target - displayCount) / 4));
    displayCount = Math.min(target, displayCount + step);
    el.innerText = displayCount;
  }
  if (displayCount !== target) {
    countRAF = requestAnimationFrame(tickCount);
  } else {
    countRAF = null; // caught up; stop spinning
  }
}

function animateCount() {
  if (countRAF == null) countRAF = requestAnimationFrame(tickCount);
}

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
  scan: document.getElementById("view-scan"),
  detail: document.getElementById("view-detail"),
};
function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
}

// ---------- Init / routing ----------

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  activeTabId = tab.id;
  const url = tab.url || "";
  // On the bookmarks page, don't make them click anything: start collecting right
  // away so they see their bookmarks the moment the popup opens.
  if (url.includes("x.com/i/bookmarks")) {
    startScan("full_export", true);
  } else {
    showView("welcome");
  }
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
  // Take them to their bookmarks, then start collecting automatically once it loads.
  showView("scan");
  document.getElementById("flow-row").style.display = "none";
  document.getElementById("count-label").innerText = "opening your bookmarks...";
  progressIndeterminate();
  chrome.tabs.update(activeTabId, { url: "https://x.com/i/bookmarks" });
  function onUpdated(tabId, info, tab) {
    if (tabId !== activeTabId || info.status !== "complete") return;
    if (!(tab.url || "").includes("/i/bookmarks")) return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    startScan("full_export", true);
  }
  chrome.tabs.onUpdated.addListener(onUpdated);
});

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
  document.getElementById("no-match").style.display = "none";
  resetControls();
  document.getElementById("flow-row").style.display = "flex";
  const activityEl = document.getElementById("activity");
  activityEl.style.display = "";
  activityEl.classList.remove("done");
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
  if (idToIndex.has(tweet.id)) return; // ignore duplicate broadcasts (defensive)
  const index = tweetsData.length;
  tweetsData.push(tweet);
  idToIndex.set(tweet.id, index);
  animateCount(); // ease the counter up to the new total
  if (index === 0) document.getElementById("controls").style.display = "flex";

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
  // Keep a live filter honest as cards stream in (a changed sort is applied in full
  // when the scan finishes or the user touches a control).
  if (filtersActive() && !tweetMatches(tweet)) div.style.display = "none";
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

// ---------- Filter + sort ----------

function tweetMatches(t) {
  if (typeFilter !== "all" && t.type !== typeFilter) return false;
  if (searchText) {
    const hay = `${t.user || ""} ${t.handle || ""} ${t.text || ""}`.toLowerCase();
    if (!hay.includes(searchText)) return false;
  }
  return true;
}

const _dateMs = (t) => Date.parse(t.date || "") || 0;
const _stat = (t, f) => (t.stats && typeof t.stats[f] === "number" ? t.stats[f] : 0);

// Returns tweetsData indices in the order they should display, honoring the sort.
// Insertion order is "recently bookmarked" (X returns newest bookmarks first).
function sortIndices(indices) {
  const arr = indices.slice();
  switch (sortBy) {
    case "oldest":
      return arr.reverse();
    case "posted_new":
      return arr.sort((a, b) => _dateMs(tweetsData[b]) - _dateMs(tweetsData[a]));
    case "posted_old":
      return arr.sort((a, b) => _dateMs(tweetsData[a]) - _dateMs(tweetsData[b]));
    case "likes":
      return arr.sort((a, b) => _stat(tweetsData[b], "likes") - _stat(tweetsData[a], "likes"));
    case "views":
      return arr.sort((a, b) => _stat(tweetsData[b], "views") - _stat(tweetsData[a], "views"));
    case "reposts":
      return arr.sort((a, b) => _stat(tweetsData[b], "reposts") - _stat(tweetsData[a], "reposts"));
    case "recent":
    default:
      return arr;
  }
}

// Indices currently visible (pass the filter), in sorted order.
function visibleOrderedIndices() {
  const visible = tweetsData.map((_, i) => i).filter((i) => tweetMatches(tweetsData[i]));
  return sortIndices(visible);
}

function filtersActive() {
  return typeFilter !== "all" || searchText !== "" || sortBy !== "recent";
}

// Hide non-matching cards, reorder the visible ones in the DOM per the sort, and
// keep the empty-state + export label in sync. Indices never change, so selection
// and enrichment updates stay valid.
function applyFilterSort() {
  const area = document.getElementById("results-area");
  tweetsData.forEach((t, i) => {
    if (cardEls[i]) cardEls[i].style.display = tweetMatches(t) ? "" : "none";
  });
  const ordered = visibleOrderedIndices();
  ordered.forEach((i) => {
    if (cardEls[i]) area.appendChild(cardEls[i]);
  });
  const hasResults = tweetsData.length > 0;
  document.getElementById("no-match").style.display =
    hasResults && ordered.length === 0 ? "block" : "none";
  updateExportLabel(ordered.length);
}

// When a filter/search narrows the list, the bulk export follows what's shown.
function updateExportLabel(visibleCount) {
  const label = document.getElementById("export-label");
  if (!label) return;
  const total = tweetsData.length;
  label.textContent =
    filtersActive() && visibleCount < total ? `Download ${visibleCount} shown` : "Download all";
}

// The list the bulk export uses: filtered + sorted, so you export exactly what you
// see, in the order you see it.
function currentExportList() {
  return visibleOrderedIndices().map((i) => tweetsData[i]);
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
  const failed = info && info.via === "error";
  document.getElementById("stopBtn").style.display = "none";
  document.getElementById("scanAgainBtn").style.display = "block";
  // The live progress readouts have done their job; the green count now signals
  // "done", so hide them at rest instead of leaving Ready/Done stacked and cramped.
  document.getElementById("flow-row").style.display = "none";
  document.getElementById("activity").style.display = "none";

  if (tweetsData.length === 0) {
    // A genuine failure (blocked, signed out, X changed) is not the same as an
    // empty bookmarks list. Say which, so the user isn't sent to check the wrong thing.
    if (failed) {
      document.getElementById("count-label").innerText = "couldn't load";
      document.getElementById("results-area").innerHTML = `
        <div class="empty">
          <b>Something went wrong</b>
          We couldn't read your bookmarks. Make sure you're signed in to X, then hit Start over to try again. If it keeps happening, X may have changed and GIMMIE needs an update.
        </div>`;
    } else {
      document.getElementById("count-label").innerText = "found";
      document.getElementById("results-area").innerHTML = `
        <div class="empty">
          <b>Nothing found yet</b>
          Make sure you're on your X bookmarks page and have posts saved, then try again.
        </div>`;
    }
    return;
  }

  document.getElementById("scan-count").classList.add("done");
  applyFilterSort(); // settle the final order/filter now that everything is in
  if (autoProcessArticles) {
    document.getElementById("count-label").innerText = "ready to export";
    document.getElementById("export-bar").style.display = "block";
  } else {
    document.getElementById("count-label").innerText = "pick posts to export";
  }
}

// ---------- Filter/sort controls wiring ----------

function resetControls() {
  sortBy = "recent";
  typeFilter = "all";
  searchText = "";
  const s = document.getElementById("filterSearch");
  if (s) s.value = "";
  document.getElementById("filterClear").style.display = "none";
  document.getElementById("sortBy").value = "recent";
  document.querySelectorAll("#typeFilter .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.type === "all")
  );
  document.getElementById("controls").style.display = "none";
}

let searchDebounce = null;
document.getElementById("filterSearch").addEventListener("input", (e) => {
  const v = e.target.value;
  document.getElementById("filterClear").style.display = v ? "flex" : "none";
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchText = v.trim().toLowerCase();
    applyFilterSort();
  }, 120);
});

document.getElementById("filterClear").addEventListener("click", () => {
  const s = document.getElementById("filterSearch");
  s.value = "";
  searchText = "";
  document.getElementById("filterClear").style.display = "none";
  applyFilterSort();
  s.focus();
});

document.getElementById("sortBy").addEventListener("change", (e) => {
  sortBy = e.target.value;
  applyFilterSort();
});

document.querySelectorAll("#typeFilter .seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    typeFilter = btn.dataset.type;
    document.querySelectorAll("#typeFilter .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    applyFilterSort();
  });
});

document.getElementById("scanAgainBtn").addEventListener("click", () => location.reload());

// ---------- On-demand article fetch (pick mode) ----------
// No tabs: ask the content script to pull one article through the API.

function requestArticle(index) {
  const t = tweetsData[index];
  if (!t || t.type !== "article" || t.enriched || t._fetching) return;
  t._fetching = true;
  chrome.tabs.sendMessage(activeTabId, { action: "fetch_article", tweet: t }, (resp) => {
    t._fetching = false;
    // Read lastError so Chrome doesn't log an unchecked-error warning, and so a
    // dropped message (content script gone) is distinguishable from an empty result.
    if (chrome.runtime.lastError) {
      // The message never landed. Leave the article un-enriched so a later open or
      // select can retry, rather than marking it done with no content.
      applyUpdate(t.id, t);
      return;
    }
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
        <a class="img-row" href="${safeUrl(src)}" target="_blank">
          <span class="img-idx">${i + 1}</span>
          <span class="img-url">${escHtml(src)}</span>
        </a>`;
    });
  }

  if (tweet.stats) {
    html += `<div class="d-label">Engagement</div>${statsRowHtml(tweet.stats).replace("stat-row", "stat-row stat-row-detail")}`;
  }

  html += `<div class="d-source"><a href="${safeUrl(tweet.url)}" target="_blank">${escHtml(tweet.url)}</a></div>`;
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
      <div class="meta">${shortDate(t)} · <a href="${safeUrl(t.url)}">${esc(t.url)}</a>${
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
  else return; // unknown format: nothing exported, so no prompt
  setTimeout(maybeShowStarPrompt, 700);
}

// ---------- "Star the repo" nudge, shown after an export ----------
// Appears at most once per popup session, stops for good once the user stars or
// dismisses, and gives up on its own after a few ignored showings so it never nags.
const STAR_KEY = "gimmie-star";
const STAR_MAX_SHOWS = 3;
let starShownThisSession = false;

function maybeShowStarPrompt() {
  if (starShownThisSession) return;
  let state = null;
  try {
    state = localStorage.getItem(STAR_KEY);
  } catch (e) {
    /* private mode */
  }
  if (state === "done") return;
  const shows = parseInt(state || "0", 10) || 0;
  if (shows >= STAR_MAX_SHOWS) return;
  try {
    localStorage.setItem(STAR_KEY, String(shows + 1));
  } catch (e) {
    /* ignore */
  }
  starShownThisSession = true;
  const toast = document.getElementById("star-toast");
  toast.style.display = "flex";
  void toast.offsetHeight; // force reflow so the slide-in transition runs reliably
  toast.classList.add("show");
  // Slide it back out on its own so the export controls aren't blocked for long.
  setTimeout(() => hideStarPrompt(false), 9000);
}

function hideStarPrompt(done) {
  const toast = document.getElementById("star-toast");
  toast.classList.remove("show");
  setTimeout(() => {
    toast.style.display = "none";
  }, 400);
  if (done) {
    try {
      localStorage.setItem(STAR_KEY, "done");
    } catch (e) {
      /* ignore */
    }
  }
}

// The Star control is a real link (leads straight to the repo). Let it navigate on
// its own; we only record that the user acted so the prompt won't return.
document.getElementById("starGoBtn").addEventListener("click", () => hideStarPrompt(true));
document.getElementById("starDismissBtn").addEventListener("click", () => hideStarPrompt(true));

// Wire every format button in the export bar. Exports follow the current filter and
// sort, so you get exactly what's shown, in the order it's shown.
document.querySelectorAll("#export-bar [data-format]").forEach((btn) => {
  btn.addEventListener("click", () => exportList(currentExportList(), btn.dataset.format));
});

// NotebookLM: a deliberate, secondary action. Downloads the markdown, then opens
// NotebookLM so the user can drop the file in. Only on explicit click.
document.getElementById("btnNotebookLM").addEventListener("click", () => {
  const list = currentExportList();
  if (!list.length) return;
  exportList(list, "md");
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// URL for an href: escape it for attribute context and refuse any scheme other
// than http(s), so a hostile value can't smuggle in javascript:/data: links.
function safeUrl(u) {
  const s = String(u || "");
  return /^https?:\/\//i.test(s) ? escHtml(s) : "#";
}
