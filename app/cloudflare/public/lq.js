/* LOCKqz shared look: "LOCK" black + "qz" red everywhere, the red lock loader (locks and unlocks while
   a page waits, with how long it should take and a random "Did you know?"), and the test-run welcome. */
(function () {
  if (window.lqLoading) return;
  var RED = "#990000";
  var FACTS = [
    "Octopuses have three hearts.",
    "Honey never spoils. Archaeologists have found edible honey in ancient Egyptian tombs.",
    "A day on Venus is longer than its year.",
    "Bananas are berries, but strawberries are not.",
    "Sharks have been around longer than trees.",
    "Wombat poop is cube-shaped.",
    "USC was founded in 1880, when Los Angeles had about 11,000 people.",
    "The Tommy Trojan statue was unveiled at USC in 1930.",
    "Oxford University is older than the Aztec Empire.",
    "Cleopatra lived closer in time to the Moon landing than to the building of the Great Pyramid.",
    "The first computer \"bug\" was a real moth, found in a Harvard computer in 1947.",
    "Linus Yale Jr. patented the modern pin-tumbler lock in the 1860s. The idea goes back to ancient Egypt.",
    "Your brain uses about 20% of your body's energy.",
    "A group of flamingos is called a flamboyance.",
    "Sunlight takes about 8 minutes and 20 seconds to reach Earth.",
    "Scotland's national animal is the unicorn.",
    "The dot over a lowercase i or j is called a tittle.",
    "There are more possible games of chess than atoms in the observable universe.",
    "Reviewing notes a little at a time, spread over days, beats cramming the night before.",
    "Saturn is less dense than water.",
    "Koala fingerprints look almost exactly like human ones.",
    "The Hollywood sign first read \"Hollywoodland.\"",
    "Venus is the hottest planet, even though Mercury is closer to the Sun.",
    "Nobody knows for sure where the word \"quiz\" comes from."
  ];
  var last = -1;
  function fact() { var i; do { i = Math.floor(Math.random() * FACTS.length); } while (i === last && FACTS.length > 1); last = i; return FACTS[i]; }
  var css = ".lq-l{color:#000!important}.lq-q{color:" + RED + "!important}" +
    ".lqload{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 8px;text-align:center;font-family:inherit}" +
    ".lqload .lqmsg{font-weight:600;color:#111;font-size:15px;margin:0}.lqload .lqfact{color:#666;font-size:13px;max-width:380px;margin:4px 0 0}" +
    ".lqload .lqfact b{color:" + RED + "}.lqload.small{padding:8px 4px;gap:4px}.lqload.small .lqmsg{font-size:14px}" +
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
      '<p class="lqmsg">' + esc(msg) + (eta ? ". " + esc(eta) : "") + '</p>' +
      '<p class="lqfact"><b>Did you know?</b> ' + esc(fact()) + '</p></div>';
  };
  window.lqFact = fact;
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
    if (p.closest && p.closest("script,style,textarea,title,option,.lq-l,.lq-q,[contenteditable]")) return;
    var parts = t.nodeValue.split("LOCKqz"), f = document.createDocumentFragment();
    parts.forEach(function (s, i) {
      if (s) f.appendChild(document.createTextNode(s));
      if (i < parts.length - 1) {
        var a = document.createElement("span"); a.className = "lq-l"; a.textContent = "LOCK";
        var b = document.createElement("span"); b.className = "lq-q"; b.textContent = "qz";
        f.appendChild(a); f.appendChild(b);
      }
    });
    p.replaceChild(f, t);
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
