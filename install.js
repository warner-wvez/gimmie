// Browser picker for the install guide. Lives in its own file because this page
// also opens as an extension page, where inline scripts are blocked by CSP.
(function () {
  var KEY = "gimmie-install-browser";
  var VALID = ["chrome", "edge", "brave"];

  function detect() {
    if (navigator.brave) return "brave";
    var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    for (var i = 0; i < brands.length; i++) {
      if (brands[i].brand === "Microsoft Edge") return "edge";
    }
    if (/Edg\//.test(navigator.userAgent)) return "edge";
    return "chrome";
  }

  function apply(name) {
    document.body.setAttribute("data-browser", name);
    var buttons = document.querySelectorAll("#browser-picker button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("active", buttons[i].getAttribute("data-pick") === name);
    }
    try { localStorage.setItem(KEY, name); } catch (e) { /* storage may be unavailable */ }
  }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  apply(VALID.indexOf(saved) !== -1 ? saved : detect());

  var buttons = document.querySelectorAll("#browser-picker button");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      apply(this.getAttribute("data-pick"));
    });
  }
})();
