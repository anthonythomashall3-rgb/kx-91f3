// LOCKqz, on a student's computer during a LOCKqz exam (the LOCKqz app adds this extension to the browser
// for the length of the exam and takes it out again). On the exam's own Brightspace pages it puts the
// exam's LOCKqz password into the page's password box, so the student never types or pastes it.
// The LOCKqz app hands the password over in the address (#lqz=...); this script takes it out of the
// address at once, keeps it for the exam's later pages (the browser's session memory, never on disk), and
// answers in the address: #lqz-got = it has the password, #lqz-in = it is in the page's password box.
// It never runs inside the attempt, and it touches nothing but a password box.
(() => {
  if (window.top !== window || window.__lqzQuiz) return;
  window.__lqzQuiz = 1;
  const api = globalThis.browser ?? chrome;
  const path = () => location.pathname;
  const onQuiz = () => /\/d2l\/lms\/quizzing\/user\//i.test(path()) && !/\/attempt\//i.test(path());
  if (!/\/d2l\/lms\/quizzing\/user\//i.test(path())) return;
  const qi = () => { try { return new URL(location.href).searchParams.get("qi") || ""; } catch { return ""; } };
  let pw = "", done = new WeakSet(), said = "";
  const say = h => { if (said === h) return; said = h; try { history.replaceState(history.state, "", location.pathname + location.search + "#" + h); } catch {} };

  // Every element of the page, also inside Brightspace's own components (open shadow roots).
  function* walk(root) {
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); }
  }
  const labelOf = el => {
    let t = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "") + " " + (el.name || "") + " " + (el.id || "");
    try { for (const l of el.labels || []) t += " " + l.textContent; } catch {}
    const host = el.getRootNode && el.getRootNode().host;   // <d2l-input-text label="Password">
    if (host) t += " " + (host.getAttribute("label") || "") + " " + (host.getAttribute("aria-label") || "") + " " + (host.getAttribute("name") || "");
    return t;
  };
  const boxes = () => {
    const out = [];
    for (const el of walk(document)) {
      if (el.tagName !== "INPUT" || el.disabled || el.readOnly) continue;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "password" || (/^(text|search|)$/.test(type) && /password/i.test(labelOf(el)))) out.push(el);
    }
    return out;
  };
  function fill() {
    if (!pw || !onQuiz()) return;
    let n = 0;
    for (const el of boxes()) {
      if (done.has(el) && el.value === pw) { n++; continue; }
      try {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(el, pw);
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        done.add(el); n++;
      } catch {}
    }
    say(n ? "lqz-in" : "lqz-got");
  }
  function take() {
    const m = /^#lqz=(.+)$/.exec(location.hash);
    if (!m) return false;
    let v = ""; try { v = decodeURIComponent(m[1]); } catch { v = m[1]; }
    if (!/^[\x21-\x7e]{4,64}$/.test(v)) return false;
    pw = v; done = new WeakSet(); said = "";
    try { api.runtime.sendMessage({ t: "spw", pw, qi: qi() }).catch(() => {}); } catch {}
    fill();
    return true;
  }
  addEventListener("hashchange", take);
  if (!take()) {
    try { api.runtime.sendMessage({ t: "gpw", qi: qi() }).then(r => { if (r && r.pw && !pw) { pw = r.pw; fill(); } }).catch(() => {}); } catch {}
  }
  // The password box may arrive later on the same page (Brightspace builds its pages in steps).
  let timer = 0;
  try { new MutationObserver(() => { if (!pw || timer) return; timer = setTimeout(() => { timer = 0; fill(); }, 300); }).observe(document.documentElement, { childList: true, subtree: true }); } catch {}
  setInterval(() => { if (pw) fill(); }, 2000);
})();
