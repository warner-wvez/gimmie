// Renders the archive HTML handed over by the popup (via storage), waits for its
// images to actually load, then opens the browser's print dialog so the user can
// save it as a PDF. Runs as an external script so it complies with the extension's
// content security policy.
chrome.storage.local.get("__print_html", (r) => {
  const root = document.getElementById("root");
  const html = r.__print_html;
  if (!html) {
    root.innerHTML = "<p>Nothing to print. Please export again from the popup.</p>";
    return;
  }
  root.innerHTML = html;
  chrome.storage.local.remove("__print_html");

  // Wait until every image has loaded (or errored), so none are missing from the
  // PDF. Cap the wait so a single slow/broken image can't block printing forever.
  const imgs = Array.from(root.querySelectorAll("img"));
  const pending = imgs.filter((im) => !im.complete);
  const MAX_WAIT_MS = 10000;

  function print() {
    window.print();
  }

  if (pending.length === 0) {
    setTimeout(print, 100);
    return;
  }

  let done = 0;
  let printed = false;
  const go = () => {
    if (printed) return;
    printed = true;
    print();
  };
  const tick = () => {
    if (++done >= pending.length) go();
  };
  pending.forEach((im) => {
    im.addEventListener("load", tick, { once: true });
    im.addEventListener("error", tick, { once: true });
  });
  // Safety net: print anyway if some images never resolve.
  setTimeout(go, MAX_WAIT_MS);
});
