/* LOCKqz shared look: "LOCK" black + "qz" red everywhere, the red lock loader (locks and unlocks while
   a page waits, with how long it should take), and the test-run welcome. */
(function () {
  if (window.lqLoading) return;
  var RED = "#990000";
  var css = ".lq-l{color:#000!important}.lq-q{color:" + RED + "!important}" +
    // On a red (or any dark) background - buttons, red bars - the whole word takes the text colour (white).
    ".lq.lq-inv .lq-l,.lq.lq-inv .lq-q,.prime .lq-l,.prime .lq-q{color:inherit!important}" +
    ".lqload{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 8px;text-align:center;font-family:inherit}" +
    ".lqload .lqmsg{font-weight:600;color:#111;font-size:15px;margin:0}" +
    ".lqload.small{padding:8px 4px;gap:4px}.lqload.small .lqmsg{font-size:14px}" +
    ".lqsh{animation:lqsh 1.8s ease-in-out infinite}" +
    "@keyframes lqsh{0%,20%{transform:translateY(0)}45%,70%{transform:translateY(-5px)}95%,100%{transform:translateY(0)}}" +
    "@media (prefers-reduced-motion:reduce){.lqsh{animation:none}}" +
    ".lqwel{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}" +
    ".lqwel>div{background:#fff;border-radius:14px;max-width:440px;width:100%;padding:28px 24px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3);font:16px -apple-system,Segoe UI,sans-serif;color:#111}" +
    ".lqwel h2{margin:8px 0 10px;font-size:24px}.lqwel p{margin:8px 0;line-height:1.45}.lqwel button{margin-top:14px;min-height:46px;padding:0 28px;border:0;border-radius:10px;background:" + RED + ";color:#fff;font-weight:700;font-size:16px;cursor:pointer}";
  function addCss() { if (document.getElementById("lqcss")) return; var s = document.createElement("style"); s.id = "lqcss"; s.textContent = css; (document.head || document.documentElement).appendChild(s); }
  addCss();
  // The lock: red body, shackle lifts (unlocked) and drops back (locked), over and over.
  function lockSvg(size) {
    return '<svg aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + RED + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="overflow:visible">' +
      '<path class="lqsh" d="M8 11V7a4 4 0 0 1 8 0v4"/><rect x="5" y="11" width="14" height="10" rx="2" fill="' + RED + '"/><circle cx="12" cy="16" r="1.4" fill="#fff" stroke="none"/></svg>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // lqLoading("Processing your payment", "This should take no longer than a minute.", {small:true})
  window.lqLoading = function (msg, eta, o) {
    o = o || {};
    return '<div class="lqload' + (o.small ? " small" : "") + '" role="status" aria-live="polite">' + lockSvg(o.small ? 28 : 44) +
      '<p class="lqmsg">' + esc(msg) + (eta ? ". " + esc(eta) : "") + '</p></div>';
  };
  // "LOCKqz" anywhere in text -> LOCK (black) + qz (red). Skips inputs, scripts, titles, and text already done.
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, TITLE: 1, OPTION: 1, NOSCRIPT: 1 };
  function brand(root) {
    if (!root) return;
    if (root.nodeType === 3) { one(root); return; }
    if (root.nodeType !== 1 || SKIP[root.tagName] || (root.classList && (root.classList.contains("lq-l") || root.classList.contains("lq-q")))) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), list = [], n;
    while ((n = w.nextNode())) if (n.nodeValue.indexOf("LOCKqz") >= 0) list.push(n);
    list.forEach(one);
  }
  function one(t) {
    var p = t.parentNode; if (!p || SKIP[p.nodeName] || t.nodeValue.indexOf("LOCKqz") < 0) return;
    if (p.closest && p.closest("script,style,textarea,title,option,.lq,.lq-l,.lq-q,[contenteditable]")) return;
    var parts = t.nodeValue.split("LOCKqz"), f = document.createDocumentFragment();
    parts.forEach(function (s, i) {
      if (s) f.appendChild(document.createTextNode(s));
      if (i < parts.length - 1) {
        // One wrapper, so a flex/gap parent (header logos) never pulls LOCK and qz apart.
        var w = document.createElement("span"); w.className = "lq"; w.style.whiteSpace = "nowrap";
        var a = document.createElement("span"); a.className = "lq-l"; a.textContent = "LOCK";
        var b = document.createElement("span"); b.className = "lq-q"; b.textContent = "qz";
        w.appendChild(a); w.appendChild(b); f.appendChild(w); if (onDark(p)) w.className += " lq-inv";
      }
    });
    p.replaceChild(f, t);
  }
  // True when the nearest painted background behind el is red or dark (red "qz" / black "LOCK" would vanish).
  function onDark(el) {
    try {
      for (; el && el.nodeType === 1; el = el.parentElement) {
        var m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
        if (!m || (m.length > 3 && +m[3] === 0)) continue;
        var r = +m[0], g = +m[1], b = +m[2];
        return (r > 110 && g < 80 && b < 80) || (0.299 * r + 0.587 * g + 0.114 * b) < 110;
      }
    } catch (e) {}
    return false;
  }
  window.lqBrand = brand;
  // On LOCKqz's own pages: brand now and whatever is drawn later. (Inside Brightspace, sync.js brands its panel itself.)
  if (!/brightspace/.test(location.host)) {
    var start = function () {
      brand(document.body);
      new MutationObserver(function (ms) { ms.forEach(function (m) { m.addedNodes.forEach(brand); if (m.type === "characterData") one(m.target); }); })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
  }
  // Test-run welcome (only for the people the server marks as trial testers). Shown once per browser.
  window.lqWelcome = function (who) {
    var k = "lqz_welcome_" + String(who || "").toLowerCase();
    try { if (localStorage.getItem(k)) return; } catch (e) {}
    var d = document.createElement("div"); d.className = "lqwel";
    d.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="lqwelh">' + lockSvg(44) +
      '<h2 id="lqwelh">Welcome to the test run!</h2>' +
      '<p>You are exempt from paying during this trial period. Have fun testing!</p>' +
      '<p>Thank you for joining me on the USC students’ edification journey.</p>' +
      '<p><i>Locks keep honest people honest.</i></p><button type="button">Let’s go</button></div>';
    d.querySelector("button").onclick = function () { try { localStorage.setItem(k, "1"); } catch (e) {} d.remove(); };
    document.body.appendChild(d); brand(d);
  };
})();
