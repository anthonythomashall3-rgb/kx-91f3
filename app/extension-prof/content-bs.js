// LOCKqz professor extension, in Brightspace (top frame of /d2l/ pages).
// Runs the same LOCKqz Sync the bookmark runs, from the extension's own copy of sync.js, on the
// professor's own Brightspace login. In an ordinary tab it syncs quietly (hidden panel, never a gate); in
// the tab the extension opened for an exam it runs the full panel, which gates the exam.
(() => {
  if (window.top !== window) return;
  const api = globalThis.browser ?? chrome;
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
  api.runtime.sendMessage({ t: "loaded" }).then(r => {
    if (!r || !r.key) return;
    me = r;
    if (r.run) inject(r, !!r.force, r.role === "gate");
  }).catch(() => {});
  // Status from sync.js (it posts to this page when loaded by the extension) -> the extension.
  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || typeof d !== "object" || d.lqzExt !== 1 || typeof d.lqz !== "string") return;
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
})();
