// LOCKqz professor extension: background.
// 1. Syncs by itself: whenever the professor uses Brightspace (at most every 15 min), and every 6 h in a
//    background tab while the browser is open. An unchanged Brightspace costs LOCKqz no request.
// 2. Exams: from 65 min before each LOCKqz-protected exam until it ends (and its gate has stopped), keeps
//    its own pinned Brightspace tab open, where LOCKqz Sync gates the exam (no tab for the professor to keep).
// 3. Dashboard "Sync now": runs in an open Brightspace tab, or a background one it opens and closes.
// It never signs in for the professor: if Brightspace asks for a sign-in, it tells them.
const api = globalThis.browser ?? chrome;
const BS_HOME = "https://brightspace.usc.edu/d2l/home";
const BS_URLS = ["https://brightspace.usc.edu/d2l/*", "https://usc.brightspace.com/d2l/*"];
const DASH_URLS = ["https://prof.lockqz.pages.dev/*"];
const MIN = 60000;
const QUIET_MS = 15 * MIN, BG_MS = 6 * 60 * MIN, LEAD_MS = 65 * MIN, AFTER_MS = 10 * MIN;
const NO_ANSWER_MS = 3 * MIN, TMP_MAX_MS = 4 * MIN, NOTE_EVERY_MS = 60 * MIN;
const BASES = ["https://prof.lockqz.pages.dev", "https://lockqz.pages.dev"];
const API = "https://lockqz.pages.dev/api";   // one API (main site secrets)
const SEEN_MS = 4 * 60 * MIN;   // check in with LOCKqz this often while the browser is open (T-70 email stays quiet)
const get = k => api.storage.local.get(k);
const set = o => api.storage.local.set(o);
const tabAlive = async id => { if (id == null) return null; try { return await api.tabs.get(id); } catch { return null; } };
const badge = t => { try { api.action.setBadgeText({ text: t }); api.action.setBadgeBackgroundColor({ color: "#990000" }); } catch {} };

function startAlarm() { api.alarms.create("tick", { periodInMinutes: 1 }); }
api.runtime.onInstalled.addListener(d => {
  startAlarm();
  // First install: open the dashboard once, so it hands this extension the professor's Sync key.
  if (d && d.reason === "install") api.tabs.create({ url: BASES[0] + "/" });
});
api.runtime.onStartup.addListener(async () => {
  startAlarm();
  await set({ gateTab: null, tmpTab: null });   // tab ids do not survive a browser restart
});
api.alarms.onAlarm.addListener(a => { if (a.name === "tick") serial(tick); });

// Is an exam running (or about to) that LOCKqz gates? Quiz dates come from the last sync.
function examNow(st, now) {
  if (!st.autoGate) return false;
  return (st.schedule || []).some(q => {
    if (!q || q.active === false) return false;
    const s = q.start ? Date.parse(q.start) : null, e = q.end ? Date.parse(q.end) : null;
    if (s !== null && !isNaN(s) && now < s - LEAD_MS) return false;
    if (e !== null && !isNaN(e) && now > e + AFTER_MS) return false;
    return true;
  });
}

async function note(st, now, text) {
  if (now - Number(st.notedAt || 0) < NOTE_EVERY_MS) return;
  await set({ notedAt: now });
  try { api.notifications.create("lqz", { type: "basic", iconUrl: "icon128.png", title: "LOCKqz", message: text }); } catch {}
}
api.notifications.onClicked.addListener(async () => {
  const st = await get(["gateTab", "tmpTab"]);
  const t = (await tabAlive(st.gateTab)) || (await tabAlive(st.tmpTab));
  if (t) { await api.tabs.update(t.id, { active: true }); try { await api.windows.update(t.windowId, { focused: true }); } catch {} }
  else api.tabs.create({ url: BS_HOME });
});

async function tick() {
  const now = Date.now();
  const st = await get(["key", "schedule", "autoGate", "gateTab", "gateOpenedAt", "gateSeen", "gates", "tmpTab", "tmpAt", "tmpAsked", "lastSync", "notedAt"]);
  if (!st.key) return;
  const gate = await tabAlive(st.gateTab);
  const gatesRunning = Number(st.gates) > 0 && now - Number(st.gateSeen || 0) < 2 * MIN;
  if (examNow(st, now) || (gate && gatesRunning)) {
    if (!gate) {
      // The page's "loaded" message waits behind this event (serial), so the id is saved before it is read.
      const t = await api.tabs.create({ url: BS_HOME, active: false, pinned: true });
      await set({ gateTab: t.id, gateOpenedAt: now, gateSeen: 0, gates: 0 });
    } else if (now - Math.max(Number(st.gateOpenedAt || 0), Number(st.gateSeen || 0)) > NO_ANSWER_MS) {
      // The exam tab is not running LOCKqz Sync: almost always a Brightspace sign-in page.
      badge("!"); await set({ signin: true });
      await note(st, now, "Your exam is coming up. Sign in to Brightspace in the LOCKqz tab so LOCKqz can open it for your students. Click here.");
    }
  } else if (gate) {
    try { await api.tabs.remove(gate.id); } catch {}
    await set({ gateTab: null, gates: 0 });
  }
  // A background sync tab that never answered.
  const tmp = await tabAlive(st.tmpTab);
  if (tmp && now - Number(st.tmpAt || 0) > TMP_MAX_MS) {
    if (st.tmpAsked) {   // the professor pressed Sync now: leave the tab so they can sign in
      relay({ lqz: "failed", error: "Brightspace didn't answer. Sign in to Brightspace in the tab LOCKqz opened, then press Sync now." });
      try { await api.tabs.update(tmp.id, { active: true }); } catch {}
    } else { try { await api.tabs.remove(tmp.id); } catch {} badge("!"); }
    await set({ tmpTab: null, signin: true });
  }
  // Every 6 h while the browser is open: a quiet sync in a background tab (new quizzes, roster changes).
  if (!tmp && !gate && now - Number(st.lastSync || 0) > BG_MS && now - Number(st.tmpAt || 0) > BG_MS) await syncNow(false);
  // Every 4 h while the browser is open: "I'm here" to LOCKqz (one tiny request; the server writes at most
  // once per 4 h). Without it LOCKqz emails the professor an hour before an exam to open Chrome.
  const seen = await get(["seenAt"]);
  if (now - Number(seen.seenAt || 0) > SEEN_MS) {
    await set({ seenAt: now });
    try { await fetch(API + "/ext-seen", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Sync": st.key }, body: "{}" }); } catch {}
  }
}

async function syncNow(asked) {
  const now = Date.now();
  const st = await get(["gateTab", "tmpTab"]);
  const gate = await tabAlive(st.gateTab);
  const tabs = gate ? [gate] : await api.tabs.query({ url: BS_URLS });
  for (const t of tabs) {
    try { await api.tabs.sendMessage(t.id, { t: "run", force: true }); return; } catch {}   // no content script there: next one
  }
  if (await tabAlive(st.tmpTab)) return;   // one already on its way
  const t = await api.tabs.create({ url: BS_HOME, active: false });   // its "loaded" waits behind this event (serial)
  await set({ tmpTab: t.id, tmpAt: now, tmpAsked: !!asked });
}

async function relay(m) {
  let tabs = [];
  try { tabs = await api.tabs.query({ url: DASH_URLS }); } catch {}
  for (const t of tabs) api.tabs.sendMessage(t.id, { t: "status", m }).catch(() => {});
}

// sendResponse + return true: works in Chrome, Edge and Firefox (Chrome ignores a returned Promise).
// One event at a time: two messages at once (e.g. the dashboard handing over the key twice) must never
// both open a background tab.
let chain = Promise.resolve();
const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serial(() => handle(msg, sender)).then(r => sendResponse(r), () => sendResponse(undefined));
  return true;
});
async function handle(msg, sender) {
  if (!msg || typeof msg !== "object") return;
  const now = Date.now(), tab = sender && sender.tab ? sender.tab.id : null;
  if (msg.t === "key") {
    if (typeof msg.key !== "string" || !/^lqs_[0-9a-f]{40}$/.test(msg.key) || !BASES.includes(msg.base)) return;
    const st = await get(["key", "lastSync"]);
    await set({ key: msg.key, base: msg.base });
    if (st.key !== msg.key || !st.lastSync) await syncNow(false);   // first connect (or a new key): sync now
    return { ok: true };
  }
  if (msg.t === "sync") { await syncNow(true); return { ok: true }; }
  if (msg.t === "loaded") {
    const st = await get(["key", "base", "gateTab", "tmpTab", "lastRun", "welcomed", "lastSync"]);
    if (!st.key) return {};
    const role = tab === st.gateTab ? "gate" : tab === st.tmpTab ? "tmp" : "browse";
    if (role === "gate") await set({ gateSeen: now });
    // The professor's first Brightspace visit after install (or reinstall: storage starts empty): the
    // content script shows the one-time "Syncing your classes" card. Never again after that.
    const first = role === "browse" && !st.welcomed;
    if (first) await set({ welcomed: now });
    const extra = first ? { first: true, synced: !!st.lastSync } : {};
    if (role === "browse" && now - Number(st.lastRun || 0) < QUIET_MS) return { key: st.key, base: st.base, role, run: false, ...extra };
    await set({ lastRun: now });
    return { key: st.key, base: st.base, role, run: true, force: role === "tmp", ...extra };
  }
  if (msg.t === "from-sync") {
    const m = msg.m || {};
    const st = await get(["gateTab", "tmpTab"]);
    if (tab != null && tab === st.gateTab) await set({ gateSeen: now, gates: Number(m.gates) || 0 });
    if (m.lqz === "schedule") {
      await set({ schedule: Array.isArray(m.quizzes) ? m.quizzes.slice(0, 500) : [], autoGate: !!m.auto_gate });
      setTimeout(() => serial(tick), 0);   // after this message is answered (one event at a time)
      return;
    }
    if (m.lqz === "synced") { await set({ lastSync: now, signin: false, statusAt: 0 }); badge(""); }
    if (m.lqz === "failed") badge("!");
    if ((m.lqz === "synced" || m.lqz === "failed") && tab != null && tab === st.tmpTab) {
      await set({ tmpTab: null });
      setTimeout(() => api.tabs.remove(tab).catch(() => {}), 1500);
    }
    if (["hello", "synced", "failed", "busy", "changed"].includes(m.lqz)) relay(m);
    return;
  }
}

// The toolbar icon opens the popup (popup.html: status, Open dashboard, Sync now).
