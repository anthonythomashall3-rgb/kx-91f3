(async function () {
  const h = document.getElementById("helper");
  const l = document.getElementById("lock");
  chrome.runtime.sendMessage({ type: "STATUS" }, (s) => {
    if (!s || s.ok === false || s.error) {
      h.textContent = "not running"; h.className = "dot bad";
      l.textContent = "—"; return;
    }
    h.textContent = "running"; h.className = "dot ok";
    const locked = s.state === "locked" || s.engine_locked;
    l.textContent = locked ? "LOCKED" : "unlocked";
    l.className = "dot " + (locked ? "bad" : "ok");
  });
})();
