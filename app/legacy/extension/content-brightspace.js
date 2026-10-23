// Runs on Brightspace quiz pages. On a specific quiz page it AUTO-LOCKS AI (zero teacher
// setup needed for the blocking), fills the password if the quiz/course is registered,
// and unlocks when the student submits or leaves the quiz. lockId = "<ou>-<qi>".
(function () {
  const href = location.href;
  const qi = (href.match(/qi=(\d+)/) || [])[1];
  const ou = (href.match(/ou=(\d+)/) || [])[1];
  const lockId = `${ou || "x"}-${qi || "x"}`;
  const onQuizzing = /\/d2l\/lms\/quizzing\/user\//.test(href);
  // After-submit / list pages → make sure we are unlocked.
  const leaving = /quizzes_list|quiz_submissions|feedback|results/i.test(href);

  function send(m) { return new Promise(r => chrome.runtime.sendMessage(m, r)); }

  // Who is taking the quiz. Asks Brightspace's own whoami API same-origin (cookies
  // included), so the teacher's roster + live monitor show a real name, not "—".
  // Best-effort: any failure just yields null and the lock still works.
  async function getStudent() {
    try {
      const r = await fetch("/d2l/api/lp/1.0/users/whoami", { credentials: "include" });
      if (!r.ok) return null;
      const w = await r.json();
      return (w.UniqueName || [w.FirstName, w.LastName].filter(Boolean).join(" ") || null);
    } catch (e) { return null; }
  }

  function fillPassword(pw) {
    if (!pw) return false;
    const field = document.querySelector('input[type="password"], input[name*="assword"], input[id*="assword"]');
    if (!field) return false;
    field.value = pw;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    const btn = [...document.querySelectorAll('button, input[type="submit"], a.d2l-button')]
      .find(b => /start|begin|launch|enter/i.test(b.textContent || b.value || ""));
    if (btn) btn.click();
    return true;
  }

  function watchForSubmit() {
    const done = () => /quiz_submissions|feedback|results|submitted/i.test(location.href + " " + (document.title || ""));
    const iv = setInterval(async () => {
      if (done()) { clearInterval(iv); await send({ type: "END_QUIZ", quizId: lockId }); }
    }, 1500);
    document.addEventListener("click", e => {
      const b = e.target.closest('button, input[type="submit"]');
      if (b && /submit/i.test(b.textContent || b.value || "")) {
        setTimeout(() => send({ type: "END_QUIZ", quizId: lockId }), 1500);
      }
    }, true);
  }

  async function startFlow() {
    const banner = document.createElement("div");
    banner.textContent = "LOCKqz: locking AI for this quiz…";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#990000;color:#fff;font:600 14px -apple-system,Segoe UI,sans-serif;padding:8px;text-align:center";
    document.documentElement.appendChild(banner);
    const student = await getStudent();
    const res = await send({ type: "START_QUIZ", quizId: lockId, url: href, student });
    if (!res || !res.ok) { banner.textContent = "LOCKqz: could not lock — is the helper installed and running?"; return; }
    banner.textContent = "LOCKqz: locked. AI is blocked for this quiz.";
    if (res.password) { let t = 0; const iv = setInterval(() => { if (fillPassword(res.password) || ++t > 20) clearInterval(iv); }, 500); }
    watchForSubmit();
  }

  (async () => {
    if (!onQuizzing) return;
    if (leaving || !qi) { await send({ type: "END_QUIZ", quizId: lockId }); return; }
    startFlow();
  })();
})();
