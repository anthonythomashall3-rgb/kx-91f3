// LOCKqz professor extension: the toolbar popup. Reads the extension's own storage (key, last sync) and
// /ext-status (counts only, through the Sync key) and offers Open dashboard / Sync now.
(() => {
  const api = globalThis.browser ?? chrome;
  const BASES = ["https://prof.lockqz.pages.dev", "https://lockqz.pages.dev"];
  const $ = id => document.getElementById(id);
  const ago = t => { if (!t) return "never"; const m = Math.round((Date.now() - Number(t)) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  const when = iso => { const t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? "" : new Date(t).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const lastName = n => { const w = String(n || "").trim().split(/\s+/).filter(Boolean); return w.length ? w[w.length - 1] : ""; };
  let st = {};
  const base = () => (BASES.includes(st.base) ? st.base : BASES[0]);
  const setStatus = (t, cls) => { $("status").textContent = t; $("status").className = "st " + (cls || ""); };
  async function draw() {
    st = await api.storage.local.get(["key", "base", "lastSync", "signin", "status", "statusAt"]);
    if (!st.key) {
      setStatus("Not connected", "warn"); $("synced").textContent = "Open your LOCKqz dashboard once: it connects this extension by itself.";
      $("counts").textContent = ""; $("next").hidden = true; $("sync").disabled = true; return;
    }
    const s = st.status || {};
    if (st.signin) setStatus("Sign in to Brightspace to sync", "warn");
    else setStatus("Connected" + (s.name ? " · Prof. " + lastName(s.name) : ""), "ok");
    $("synced").textContent = "Last synced " + ago(st.lastSync);
    if (s.classes != null) $("counts").textContent = `${s.classes} class${s.classes === 1 ? "" : "es"} · ${s.exams} exam${s.exams === 1 ? "" : "s"} protected`;
    if (s.next) { $("next").hidden = false; $("next").innerHTML = ""; const b = document.createElement("b"); b.textContent = "Next exam: " + (s.next.course ? s.next.course + " · " : "") + s.next.name;
      $("next").append(b, document.createTextNode(when(s.next.start) + " · " + s.next.ready + "/" + s.next.total + " students installed")); }
    else $("next").hidden = true;
    $("sync").disabled = false;
  }
  // Fresh counts from LOCKqz (one small request per popup open, at most once a minute).
  async function fetchStatus() {
    if (!st.key || (st.statusAt && Date.now() - Number(st.statusAt) < 60000)) return;
    try {
      const r = await fetch("https://lockqz.pages.dev/api/ext-status", { headers: { "X-LOCKqz-Sync": st.key } });
      const d = await r.json(); if (r.ok && d && !d.error) { await api.storage.local.set({ status: d, statusAt: Date.now() }); await draw(); }
    } catch {}
  }
  $("dash").onclick = () => { api.tabs.create({ url: base() + "/" }); window.close(); };
  $("sync").onclick = async () => {
    $("sync").disabled = true; $("sync").textContent = "Syncing…";
    try { await api.runtime.sendMessage({ t: "sync" }); } catch {}
    const t0 = Date.now();
    const wait = setInterval(async () => {
      const n = await api.storage.local.get(["lastSync", "signin"]);
      if (Number(n.lastSync) > t0) { clearInterval(wait); await api.storage.local.set({ statusAt: 0 }); $("sync").textContent = "Synced"; await draw(); await fetchStatus(); setTimeout(() => { $("sync").textContent = "Sync now"; }, 2500); }
      else if (n.signin || Date.now() - t0 > 180000) { clearInterval(wait); $("sync").textContent = "Sync now"; await draw(); }
    }, 1000);
  };
  api.storage.onChanged.addListener(ch => { if (ch.lastSync || ch.signin || ch.key) draw(); });
  draw().then(fetchStatus);
})();
