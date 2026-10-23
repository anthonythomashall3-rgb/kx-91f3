// LOCKqz service worker. Orchestrates lock/unlock with the local helper, releases
// the quiz password only after the helper confirms the lock, toggles the in-browser
// AI block, and reports heartbeats.
importScripts("config.js");

async function helper(path, method = "GET", body) {
  const r = await fetch(LOCKQZ.helper + path, {
    method,
    headers: { "Content-Type": "application/json", "X-LOCKqz-Token": LOCKQZ.token },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error("helper " + r.status);
  return r.json();
}

async function setAiBlock(on) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    on ? { enableRulesetIds: [LOCKQZ.rulesetId] }
       : { disableRulesetIds: [LOCKQZ.rulesetId] });
}

async function apiPassword(url, deviceId) {
  // Worker returns the password (per-quiz or per-course) only when it has a live lock
  // for this device on this quiz page. Returns null if none / not locked.
  const r = await fetch(`${LOCKQZ.api}/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, device_id: deviceId })
  });
  if (!r.ok) return null;
  return (await r.json()).password;
}

async function deviceId() {
  const { device_id } = await chrome.storage.local.get("device_id");
  if (device_id) return device_id;
  const id = "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await chrome.storage.local.set({ device_id: id });
  return id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "START_QUIZ") {
        const dev = await deviceId();
        await helper("/lock", "POST", { quiz_id: msg.quizId, student: msg.student });
        await setAiBlock(true);
        await chrome.storage.local.set({ active_quiz: msg.quizId, active_student: msg.student || null });
        // Liveness ping every ~1 min while the quiz is open (Chrome clamps shorter
        // periods for a published extension). Proves the BROWSER side is alive, so
        // the teacher's monitor can tell "helper killed" from "browser closed". The
        // helper pings too; both are UPDATE-only on the server, tiny at finals scale.
        chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
        let password = null;
        try { password = await apiPassword(msg.url, dev); } catch (e) {}
        sendResponse({ ok: true, password });
      } else if (msg.type === "END_QUIZ") {
        await helper("/unlock", "POST", { quiz_id: msg.quizId });
        await setAiBlock(false);
        await chrome.storage.local.remove(["active_quiz", "active_student"]);
        chrome.alarms.clear("heartbeat");
        sendResponse({ ok: true });
      } else if (msg.type === "STATUS") {
        sendResponse(await helper("/status"));
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "heartbeat") return;
  try {
    const { active_quiz, active_student } = await chrome.storage.local.get(["active_quiz", "active_student"]);
    if (!active_quiz) { chrome.alarms.clear("heartbeat"); return; }
    const dev = await deviceId();
    await fetch(`${LOCKQZ.api}/report`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: dev, event: "heartbeat", quiz_id: active_quiz, student: active_student || null, source: "ext" })
    });
  } catch (e) {}
});

// On install: register this device with the backend so the teacher roster shows it.
chrome.runtime.onInstalled.addListener(async () => {
  const dev = await deviceId();
  try {
    await fetch(`${LOCKQZ.api}/install`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: dev, platform: navigator.platform, version: chrome.runtime.getManifest().version })
    });
  } catch (e) {}
});

// Safety: if the browser restarts mid-quiz, make sure the block is re-enabled so
// the student can't dodge it by reopening Chrome.
chrome.runtime.onStartup.addListener(async () => {
  const { active_quiz } = await chrome.storage.local.get("active_quiz");
  if (active_quiz) { try { await helper("/lock", "POST", { quiz_id: active_quiz }); await setAiBlock(true); } catch (e) {} }
});
