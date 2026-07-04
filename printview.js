// Renders the archive HTML handed over by the popup (via storage), then opens the
// browser's print dialog so the user can save it as a PDF. Runs as an external
// script so it complies with the extension's content security policy.
chrome.storage.local.get("__print_html", (r) => {
  const html = r.__print_html;
  if (!html) {
    document.getElementById("root").innerHTML = "<p>Nothing to print. Please export again from the popup.</p>";
    return;
  }
  document.getElementById("root").innerHTML = html;
  chrome.storage.local.remove("__print_html");
  // Let images begin loading and layout settle before invoking print.
  setTimeout(() => window.print(), 500);
});
