// Light / dark theme with a "pull the light cord" switch.
// Adapted from a React + Motion concept to dependency-free vanilla JS so it fits
// this no-build extension. Grab the glowing bulb and pull it down (or tap it) to
// toggle; the choice is remembered across sessions.
(function () {
  const root = document.documentElement;
  const KEY = "gimmie-theme";

  function apply(dark) {
    root.classList.toggle("dark", dark);
  }

  // This script runs in <head>, before the body paints. localStorage is synchronous
  // (unlike chrome.storage), so reading the saved choice here applies the theme
  // before the first paint — no flash of the wrong theme on open.
  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch (e) {
    /* private mode etc. */
  }
  if (saved === "dark") apply(true);
  else if (saved === "light") apply(false);
  else if (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) apply(true);

  function setTheme(dark) {
    apply(dark);
    try {
      localStorage.setItem(KEY, dark ? "dark" : "light");
    } catch (e) {
      /* ignore */
    }
  }

  function isDark() {
    return root.classList.contains("dark");
  }

  // Wire the pull switch once the DOM is present.
  document.addEventListener("DOMContentLoaded", () => {
    const sw = document.getElementById("pull-switch");
    if (!sw) return;
    const cord = sw.querySelector(".cord");
    const bulb = sw.querySelector(".bulb");

    // Kept deliberately small: an extension popup closes the instant the pointer
    // leaves its bounds, so a long drag would dismiss the popup mid-gesture. A
    // short pull (and a plain tap) keep the whole interaction inside the window.
    const BASE = 14; // resting cord length
    const MAX = 30; // how far it can be pulled (stays within the popup)
    const THRESHOLD = 18; // pull past this = a deliberate toggle
    const TAP = 4; // pull under this = a tap (also toggles)

    let dragging = false;
    let startY = 0;
    let pulled = 0;

    function onMove(e) {
      if (!dragging) return;
      pulled = Math.max(0, Math.min(MAX, e.clientY - startY));
      cord.style.height = BASE + pulled + "px";
    }

    function end() {
      if (!dragging) return;
      dragging = false;
      sw.classList.remove("dragging");
      if (pulled < TAP || pulled >= THRESHOLD) setTheme(!isDark());
      // Spring the cord back with a little bounce.
      cord.style.transition = "height 0.4s cubic-bezier(0.5, 1.7, 0.4, 1)";
      cord.style.height = BASE + "px";
      setTimeout(() => (cord.style.transition = ""), 420);
      pulled = 0;
    }

    bulb.addEventListener("pointerdown", (e) => {
      dragging = true;
      startY = e.clientY;
      pulled = 0;
      sw.classList.add("dragging");
      bulb.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bulb.addEventListener("pointermove", onMove);
    bulb.addEventListener("pointerup", end);
    bulb.addEventListener("pointercancel", end);

    // Keyboard access.
    bulb.setAttribute("tabindex", "0");
    bulb.setAttribute("role", "button");
    bulb.setAttribute("aria-label", "Toggle light or dark mode");
    bulb.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setTheme(!isDark());
      }
    });
  });
})();
