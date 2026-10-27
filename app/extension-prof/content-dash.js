// LOCKqz professor extension, on the LOCKqz dashboard (prof.lockqz.pages.dev).
// Marks the page so the dashboard knows the extension is here, takes the professor's Sync key from the
// dashboard, passes "Sync now" to the extension, and relays sync status back. Same-window messages only.
(() => {
  const api = globalThis.browser ?? chrome;
  const V = api.runtime.getManifest().version;
  document.documentElement.dataset.lqzExt = V;
  const post = m => window.postMessage(Object.assign({}, m, { lqzExt: 1 }), location.origin);
  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.lqzExt) return;   // our own relays carry lqzExt
    if (m.lqz === "ext-key" && typeof m.key === "string" && /^lqs_[0-9a-f]{40}$/.test(m.key))
      api.runtime.sendMessage({ t: "key", key: m.key, base: location.origin }).catch(() => {});
    else if (m.lqz === "ext-sync") api.runtime.sendMessage({ t: "sync" }).catch(() => {});
  });
  api.runtime.onMessage.addListener(m => { if (m && m.t === "status" && m.m && typeof m.m.lqz === "string") post(m.m); });
  const hello = () => post({ lqz: "ext-hello", v: V });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello); else hello();
})();
