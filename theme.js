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
    const bulb = sw.querySelector(".bulb");

    // The bulb is dragged straight down and follows the pointer 1:1 via a transform
    // (no layout thrash). Pull past THRESHOLD, or a plain tap, toggles the theme.
    // Travel is capped so the gesture stays inside the popup (a popup closes if the
    // pointer leaves its bounds).
    const MAX = 40; // furthest the bulb can be pulled, in px
    const THRESHOLD = 22; // pull past this = a deliberate toggle
    const TAP = 5; // release under this = a tap (also toggles)

    let dragging = false;
    let startY = 0;
    let y = 0; // current pull distance

    const setY = (v) => {
      bulb.style.transform = "translateY(" + v + "px)";
    };

    function onDown(e) {
      dragging = true;
      startY = e.clientY;
      y = 0;
      bulb.classList.remove("springing"); // follow the finger with no easing
      bulb.classList.add("grabbing");
      try {
        bulb.setPointerCapture(e.pointerId);
      } catch (_) {}
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      y = Math.max(0, Math.min(MAX, e.clientY - startY));
      setY(y);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      bulb.classList.remove("grabbing");
      const toggle = y < TAP || y >= THRESHOLD;
      bulb.classList.add("springing"); // spring back with a bounce
      setY(0);
      if (toggle) setTheme(!isDark());
      y = 0;
    }

    bulb.addEventListener("pointerdown", onDown);
    bulb.addEventListener("pointermove", onMove);
    bulb.addEventListener("pointerup", onUp);
    bulb.addEventListener("pointercancel", onUp);
    bulb.addEventListener("lostpointercapture", onUp);

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
