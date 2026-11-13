// LOCKqz professor extension: the toolbar popup. Reads the extension's own storage (key, last sync) and
// /ext-status (counts only, through the Sync key) and offers Open dashboard / Sync now.
(() => {
  const api = globalThis.browser ?? chrome;
  const BASES = ["https://professor.lockqz.com", "https://lockqz.com"];
  const OLD = { "https://prof.lockqz.pages.dev": "https://professor.lockqz.com", "https://lockqz.pages.dev": "https://lockqz.com" };
  const $ = id => document.getElementById(id);
  const ago = t => { if (!t) return "never"; const m = Math.round((Date.now() - Number(t)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  const when = iso => { const t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? "" : new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const lastName = n => { const w = String(n || "").trim().split(/\s+/).filter(Boolean); return w.length ? w[w.length - 1] : ""; };
  let st = {};
  const base = () => { const b = OLD[st.base] || st.base; return BASES.includes(b) ? b : BASES[0]; };
  const setStatus = (t, cls) => { $("status").textContent = t; $("status").className = "st " + (cls || ""); };
  async function draw() {
    st = await api.storage.local.get(["key", "base", "lastSync", "signin", "status", "statusAt"]);
    if (!st.key) {
      setStatus("Not connected", "warn"); $("synced").textContent = "Open your LOCKqz dashboard once: it connects this extension by itself.";
      $("counts").textContent = ""; $("next").hidden = true; $("sync").disabled = true; return;
    }
    const s = st.status || {};
    if (st.signin) setStatus("Sign in to Brightspace to sync", "warn");
    else setStatus("Connected" + (s.name ? " \u00b7 Prof. " + lastName(s.name) : ""), "ok");
    $("synced").textContent = "Last synced " + ago(st.lastSync);
    // Protected = LOCKqz's password confirmed in Brightspace; the rest are shown as waiting.
    if (s.classes != null) $("counts").textContent = `${s.classes} class${s.classes === 1 ? "" : "es"} \u00b7 ${s.exams} exam${s.exams === 1 ? "" : "s"} protected` + (s.waiting ? ` \u00b7 ${s.waiting} waiting to be set in Brightspace` : "");
    // One line: exam \u00b7 date \u00b7 ready count (29 Oct 2026, owner: much less wordy).
    if (s.next) { $("next").hidden = false; $("next").textContent = s.next.name + " \u00b7 " + when(s.next.start) + " \u00b7 " + s.next.ready + "/" + s.next.total + " students ready"; $("next").title = (s.next.course ? s.next.course + " \u00b7 " : "") + $("next").textContent; }
    else $("next").hidden = true;
    $("sync").disabled = false;
  }
  // Fresh counts from LOCKqz (one small request per popup open, at most once a minute).
  async function fetchStatus() {
    if (!st.key || (st.statusAt && Date.now() - Number(st.statusAt) < 60000)) return;
    try {
      const r = await fetch("https://lockqz.com/api/ext-status", { headers: { "X-LOCKqz-Sync": st.key } });
      const d = await r.json(); if (r.ok && d && !d.error) { await api.storage.local.set({ status: d, statusAt: Date.now() }); await draw(); }
    } catch {}
  }
  $("dash").onclick = () => { api.tabs.create({ url: base() + "/" }); window.close(); };
  $("sync").onclick = async () => {
    $("sync").disabled = true; $("sync").textContent = "Syncing\u2026";
    try { await api.runtime.sendMessage({ t: "sync" }); } catch {}
    const t0 = Date.now(), was = !!st.signin;   // "sign in" already showing: this click is the retry, so wait for its own answer
    const wait = setInterval(async () => {
      const n = await api.storage.local.get(["lastSync", "lastCheck", "signin"]);
      if (Number(n.lastSync) > t0 || Number(n.lastCheck) > t0) { clearInterval(wait); await api.storage.local.set({ statusAt: 0 }); $("sync").textContent = "Synced"; await draw(); await fetchStatus(); setTimeout(() => { $("sync").textContent = "Sync now"; }, 2500); }
      else if ((n.signin && (!was || Date.now() - t0 > 45000)) || Date.now() - t0 > 180000) { clearInterval(wait); $("sync").textContent = "Sync now"; await draw(); }
    }, 1000);
  };
  // Another school's Brightspace: the professor types its address; the browser asks them to allow that one
  // address; LOCKqz checks that it really is a Brightspace; from then on the extension works there as at USC.
  const origin = t => { let v = String(t || "").trim().toLowerCase(); if (!v) return ""; if (!/^https?:\/\//.test(v)) v = "https://" + v;
    try { const u = new URL(v); return u.protocol === "https:" && u.hostname.includes(".") && !u.port && !u.username ? "https://" + u.hostname : ""; } catch { return ""; } };
  const USC = ["https://brightspace.usc.edu", "https://usc.brightspace.com"];
  async function drawSchool() { const s2 = await api.storage.local.get(["school"]); $("schname").textContent = s2.school ? new URL(s2.school).hostname : "USC"; }
  $("schgo").onclick = async () => {
    const o = origin($("schin").value), msg = t => { $("schmsg").textContent = t; };
    if (!o) return msg("Type your school's Brightspace address.");
    if (USC.includes(o)) { await api.runtime.sendMessage({ t: "school", school: null }); await drawSchool(); return msg("Connected."); }
    let ok = false; try { ok = await api.permissions.request({ origins: [o + "/*"] }); } catch {}   // asked right on the click
    if (!ok) return msg("Allow the address to connect it.");
    $("schgo").disabled = true; msg("Checking\u2026");
    let bs = false; try { const r = await fetch(o + "/d2l/api/versions/", { credentials: "omit" }); const d = r.ok ? await r.json() : null; bs = Array.isArray(d) && d.some(x => x && x.ProductCode === "lp"); } catch {}
    if (!bs) { try { await api.permissions.remove({ origins: [o + "/*"] }); } catch {} $("schgo").disabled = false; return msg("That is not a Brightspace address."); }
    let done = null; try { done = await api.runtime.sendMessage({ t: "school", school: o }); } catch {}
    $("schgo").disabled = false; await drawSchool();
    msg(done && done.ok ? "Connected." : "Could not connect. Try again.");
  };
  drawSchool();
  api.storage.onChanged.addListener(ch => { if (ch.lastSync || ch.signin || ch.key) draw(); if (ch.school) drawSchool(); });
  draw().then(fetchStatus);
})();
