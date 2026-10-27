// LOCKqz professor extension, in Brightspace (top frame of /d2l/ pages).
// Runs the same LOCKqz Sync the bookmark runs, from the extension's own copy of sync.js, on the
// professor's own Brightspace login. In an ordinary tab it syncs quietly (hidden panel, never a gate); in
// the tab the extension opened for an exam it runs the full panel, which gates the exam.
// Also: (1) the one-time "Syncing your classes" card on the professor's first visit after install;
// (2) on the quiz edit / restrictions / special-access pages of an exam LOCKqz protects, the password
// field and the special-access controls are disabled with a short note (LOCKqz manages them).
(() => {
  if (window.top !== window) return;
  const api = globalThis.browser ?? chrome;
  const RED = "#990000";
  const SHIELD = (c, s) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>`;
  let me = null;   // { key, base, role: "gate" | "tmp" | "browse" }
  const inject = (r, force, visible) => {
    const u = new URL(api.runtime.getURL("sync.js"));
    u.searchParams.set("k", r.key); u.searchParams.set("base", r.base); u.searchParams.set("ext", "1");
    if (r.role !== "gate") { u.searchParams.set("nogate", "1"); if (!visible) u.searchParams.set("quiet", "1"); }
    if (force) u.searchParams.set("force", "1");
    u.searchParams.set("v", String(Date.now()));
    const s = document.createElement("script"); s.charset = "utf-8"; s.src = u.href;
    (document.body || document.documentElement).appendChild(s);
  };

  // ---- (1) first visit after install: a bottom-right card, once ----
  let card = null, cardTimer = null;
  const dashUrl = () => ((me && me.base) || "https://prof.lockqz.pages.dev") + "/";
  function showCard(bodyHtml, ms) {
    if (!card) {
      card = document.createElement("div"); card.id = "lqz-first";
      card.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483646;width:320px;background:#fff;border-radius:12px;overflow:hidden;" +
        "box-shadow:0 12px 40px rgba(0,0,0,.28);font:14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;text-align:left";
      (document.body || document.documentElement).appendChild(card);
    }
    card.innerHTML = `<div style="background:${RED};color:#fff;padding:10px 14px;font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px">${SHIELD("#fff", 18)}LOCKqz<span id="lqz-first-x" style="margin-left:auto;cursor:pointer;font-weight:400;padding:0 2px">&#10005;</span></div><div style="padding:12px 14px;line-height:1.5">${bodyHtml}</div>`;
    const x = card.querySelector("#lqz-first-x"); if (x) x.onclick = hideCard;
    const d = card.querySelector("#lqz-first-dash"); if (d) d.onclick = e => { e.preventDefault(); window.open(dashUrl(), "_blank"); hideCard(); };
    clearTimeout(cardTimer); if (ms) cardTimer = setTimeout(hideCard, ms);
  }
  function hideCard() { clearTimeout(cardTimer); if (card) card.remove(); card = null; }
  let firstWaiting = false;
  const doneCard = n => showCard(`Done${n ? ` — ${n} class${n === 1 ? "" : "es"} synced` : " — your classes are synced"}. <a id="lqz-first-dash" href="${dashUrl()}" style="color:${RED};font-weight:700;white-space:nowrap">Open dashboard</a>`, 12000);

  api.runtime.sendMessage({ t: "loaded" }).then(r => {
    if (!r || !r.key) return;
    me = r;
    if (r.first) {
      if (r.run) { firstWaiting = true; showCard("Syncing your classes… They'll be on your LOCKqz dashboard in about a minute.", 180000); }   // gone by itself if Brightspace never answers (sign-in page)
      else doneCard(0);
    }
    if (r.run) inject(r, !!r.force, r.role === "gate");
  }).catch(() => {});
  // Status from sync.js (it posts to this page when loaded by the extension) -> the extension.
  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.lqzExt !== 1 || typeof d.lqz !== "string") return;
    if (firstWaiting && (d.lqz === "synced" || d.lqz === "failed")) {
      firstWaiting = false;
      if (d.lqz === "synced") doneCard(Number(d.courses) || 0);
      else showCard(`Could not sync yet: ${String(d.error || "").replace(/[<>]/g, "").slice(0, 140)}`, 12000);
    }
    api.runtime.sendMessage({ t: "from-sync", m: d }).catch(() => {});
  });
  api.runtime.onMessage.addListener(m => {
    if (!m || !me) return;
    if (m.t === "run") inject(me, !!m.force, me.role === "gate");
    if (m.t === "show") {
      const b = document.getElementById("lqz-sync");
      if (b) b.style.display = ""; else inject(me, true, true);
    }
  });

  // ---- (2) Brightspace quiz settings of a protected exam: password + special access are LOCKqz's ----
  const QADMIN = /\/d2l\/lms\/quizzing\/admin\//i.test(location.pathname);
  const qiHere = () => { try { return new URL(location.href).searchParams.get("qi") || ""; } catch { return ""; } };
  const NOTE = `<span style="display:inline-flex;align-items:center;gap:6px;vertical-align:middle">${SHIELD(RED, 16)}<b>Managed by LOCKqz</b> — nothing to set here. Students who have LOCKqz open this exam automatically.</span>`;
  const PW_RE = /password/i, SA_RE = /special\s*access/i;
  // Every element on the page, through open shadow roots (Brightspace is built from web components).
  function* walk(root, depth) {
    if (depth > 40) return;
    const els = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of els) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot, depth + 1); }
  }
  const text = el => ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("label"))) || "") + " " + (el.id || "") + " " + String(el.textContent || "").slice(0, 80);
  function noteAfter(el) {
    const host = el.getRootNode && el.getRootNode().host ? el.getRootNode().host : el;   // the note goes beside the component, in the page
    const target = host.closest ? (host.closest("d2l-input-text, d2l-labs-input-text, .d2l-field, fieldset, div") || host) : host;
    if (target.__lqzNoted) return; target.__lqzNoted = true;
    const n = document.createElement("div"); n.className = "lqz-managed";
    n.style.cssText = `margin:6px 0 10px;padding:8px 10px;border:1px solid ${RED};border-radius:8px;background:#fff;font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a`;
    n.innerHTML = NOTE;
    target.insertAdjacentElement("afterend", n);
  }
  function lockFields() {
    let hits = 0;
    for (const el of walk(document, 0)) {
      if (hits > 40) break;
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      const t = text(el);
      if ((tag === "input" || tag === "d2l-input-text" || tag === "d2l-labs-input-text") && PW_RE.test(t) && !/confirm|login|current|new password/i.test(t)) {
        if (!el.disabled) { el.disabled = true; el.setAttribute("disabled", ""); el.setAttribute("title", "Managed by LOCKqz"); if (tag === "input") el.style.opacity = ".55"; hits++; noteAfter(el); }
      } else if ((tag === "button" || tag === "d2l-button" || tag === "d2l-button-subtle" || tag === "a" || tag === "d2l-menu-item" || tag === "input" && /checkbox|radio/i.test(el.type || "")) && SA_RE.test(t) && !el.__lqzLocked) {
        el.__lqzLocked = true; el.disabled = true; el.setAttribute("disabled", ""); el.setAttribute("aria-disabled", "true"); el.style.pointerEvents = "none"; el.style.opacity = ".55"; hits++; noteAfter(el);
      }
    }
  }
  async function maybeLock() {
    if (!QADMIN) return;
    const qi = qiHere(); if (!qi) return;
    let sched = []; try { sched = (await api.storage.local.get("schedule")).schedule || []; } catch {}
    if (!sched.some(q => q && String(q.qi) === String(qi))) return;   // not a LOCKqz-protected exam
    let busy = false;
    const run = () => { if (busy) return; busy = true; setTimeout(() => { busy = false; try { lockFields(); } catch {} }, 400); };
    run();
    new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true, attributes: false });
    setInterval(run, 3000);   // shadow-root changes do not always reach the document observer
  }
  maybeLock();
})();
