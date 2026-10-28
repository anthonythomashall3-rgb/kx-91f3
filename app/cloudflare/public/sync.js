/* LOCKqz Sync - the Brightspace connector. Loaded by the professor's "LOCKqz Sync" bookmark and
   run inside Brightspace on the professor's OWN login (it can only see what they can see).
   1. reads every course where they are an instructor / TA: class list + quizzes
   2. saves them to LOCKqz
   3. writes each protected quiz's LOCKqz password into Brightspace (and removes released ones)
   4. shows a panel to choose which quizzes LOCKqz protects
   Brightspace API shapes used here (docs.valence.desire2learn.com): ObjectListPage {Objects, Next}
   (basic/apicall.html), PagedResultSet {Items, PagingInfo} (myenrollments, res/enroll.html),
   QuizAttemptData.Completed = UTCDateTime|null, SpecialAccessData {StartDate, EndDate, DueDate,
   SubmissionTimeLimit, AttemptsAllowed} (res/quiz.html). XSRF: D2L's own frau-xsrf-token reads
   localStorage "XSRF.Token", else GET /d2l/lp/auth/xsrf-tokens -> {referrerToken}. */
(async function () {
  var SRC = (document.currentScript && document.currentScript.src) || "";
  // auto=1: the open Sync panel re-checks Brightspace by itself (every AUTO_MS). It talks to LOCKqz only
  // when something in Brightspace changed, or once FORCE_MS has passed (so changes made on the dashboard
  // reach Brightspace within the hour); otherwise it costs LOCKqz nothing.
  // force=1: the professor pressed "Sync now" on the LOCKqz dashboard: same as auto, but always syncs.
  var Q = SRC ? new URL(SRC).searchParams : null;
  var FORCE = !!Q && Q.get("force") === "1";
  var ASKED = FORCE;   // a sync someone asked for (FORCE is cleared below when there is no panel yet)
  var AUTO = (!!Q && Q.get("auto") === "1") || FORCE;
  var AUTO_MS = 15 * 60000, FORCE_MS = 60 * 60000;
  var W = typeof window !== "undefined" ? window : null;
  // ext=1: loaded by the LOCKqz professor browser extension from its own package (SRC is the extension's
  // address). base= then names the LOCKqz site (only the two real ones are accepted); quiet=1 keeps the
  // panel hidden (it syncs in the background); nogate=1 never starts or resumes a gate in this tab (a
  // tab the professor browses away from must never own a gate; the extension opens its own tab for that).
  var EXT = !!Q && Q.get("ext") === "1";
  var BASES = ["https://prof.lockqz.pages.dev", "https://lockqz.pages.dev"];
  var ORIGIN = SRC ? (EXT ? (BASES.indexOf(Q.get("base")) >= 0 ? Q.get("base") : BASES[0]) : new URL(SRC).origin) : "";
  var QUIET = EXT && Q.get("quiet") === "1", NOGATE = EXT && Q.get("nogate") === "1";
  var DASH_ORIGIN = ORIGIN;
  // Messages to the LOCKqz dashboard tab (the one that opened this tab, or the one that asked last): no
  // data, only "connected" / "synced" / "failed", and only to the dashboard's own origin.
  var tell = function (m) {
    if (!W || !DASH_ORIGIN) return;
    // The extension listens on this page (relayed to the dashboard and its own tab bookkeeping).
    if (EXT) try { W.postMessage(Object.assign({}, m, { lqzExt: 1, gates: Object.keys(GATES || {}).length }), location.origin); } catch (e) {}
    [[W.__lqzDash, W.__lqzDashOrigin], [W.opener, DASH_ORIGIN]].forEach(function (t, i, all) {
      if (!t[0] || !t[1] || (i && t[0] === all[0][0])) return;
      try { if (!t[0].closed) t[0].postMessage(m, t[1]); } catch (e) {}
    });
  };
  var open = document.getElementById("lqz-sync");
  if (open && !AUTO) { open.style.display = ""; return; }      // already running here: show it again (never a 2nd copy)
  if (AUTO && open && open.dataset && open.dataset.gates === "1") {   // a gate owns this tab: never replace it
    if (FORCE) tell({ lqz: "busy", why: "A quiz gate is running in Brightspace. Sync after the quiz." });
    return;
  }
  if (AUTO && !open) { if (!FORCE) return; AUTO = false; FORCE = false; }   // asked from the dashboard, no panel: a normal Sync
  var KEY = SRC ? new URL(SRC).searchParams.get("k") : "";
  var API = SRC ? (/\.pages\.dev$/.test(new URL(ORIGIN).hostname) ? "https://lockqz.pages.dev/api" : ORIGIN + "/api") : "";   // one API (main site secrets)
  var DASH = SRC ? ORIGIN + "/dashboard" : "";

  var box = document.createElement("div");
  box.id = "lqz-sync";
  box.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:440px;max-height:85vh;overflow:auto;background:#fff;" +
    "border:2px solid #990000;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);font:14px -apple-system,Segoe UI,sans-serif;color:#111;text-align:left";
  box.innerHTML = '<div style="position:sticky;top:0;background:#fff;color:#111;border-bottom:2px solid #990000;padding:10px 14px;font-weight:700;display:flex;justify-content:space-between">' +
    '<span><span style="color:#000">LOCK</span><span style="color:#990000">qz</span> Sync</span><span id="lqz-x" style="cursor:pointer;padding:0 4px">&#10005;</span></div><div id="lqz-b" style="padding:12px 14px">Starting...</div>';
  // The shared LOCKqz look (red lock loader, LOCK black / qz red), from the LOCKqz site.
  var LW = typeof window !== "undefined" ? window : {};
  try { if (SRC && !LW.lqLoading && document.head) { var lqs = document.createElement("script"); lqs.src = EXT ? new URL("lq.js", SRC).href : new URL(SRC).origin + "/lq.js"; document.head.appendChild(lqs); } } catch (e) {}
  if (QUIET) box.style.display = "none";   // the extension's background sync: the icon shows the panel
  if (!AUTO) document.body.appendChild(box);   // an auto re-check shows its panel only if something changed
  var B = box.querySelector("#lqz-b");
  var AUTOGATE = false;   // the server's REQUIRE_GATE: gate every protected quiz by itself (set by /sync)
  var GATES = {};   // qi -> { ou, timer, tick, busy, keep:{uid:true}, qs:[every quiz-date version seen], endMs, note, written }
  // box.dataset.gates = "1" while any gate runs: an automatic re-sync never replaces a panel that owns a gate.
  var markGates = function () { if (box.dataset) box.dataset.gates = Object.keys(GATES).length ? "1" : ""; };
  var GPW = {};     // qi -> last gate code Brightspace holds AND LOCKqz confirmed
  var ORIG = {};    // qi -> {password, hidden}: the professor's own quiz settings before LOCKqz changed them
  // X: with a gate on, only hide (the gate must keep running; clicking the bookmark shows it again).
  box.querySelector("#lqz-x").onclick = function () {
    if (!Object.keys(GATES).length) { box.remove(); return; }
    if (confirm("A gate is on. Hide this panel? The gate keeps running while this tab is open.")) box.style.display = "none";
  };
  var say = function (h) { B.innerHTML = h; if (LW.lqBrand) LW.lqBrand(B); };
  // A waiting step: the red lock loader with how long it should take (plain text until lq.js loads).
  var wait = function (msg, eta) { if (LW.lqLoading) say(LW.lqLoading(msg, eta)); else say(msg + "... " + eta); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var day = function (t) { return t ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : ""; };
  var dt = function (s) { var t = s ? Date.parse(s) : NaN; return isNaN(t) ? null : t; };
  var EXPIRED = "Brightspace session expired — reload Brightspace and click Sync again.";
  var expired = function () { var e = new Error(EXPIRED); e.expired = true; return e; };
  // Staff roles (any school's names) and the LIS context roles Brightspace sends (not institution roles).
  var STAFF = /instructor|teach|professor|faculty|lecturer|tutor|course leader|\bta\b|assistant|grader|designer/i;
  var INSTR = /instructor|teacher|professor|faculty|lecturer|course leader/i;
  var LIS_STAFF = /^(urn:lti:role:ims\/lis\/(Instructor|TeachingAssistant)|http:\/\/purl\.imsglobal\.org\/vocab\/lis\/v2\/membership(#Instructor|\/Instructor#TeachingAssistant))/;
  var GRACE = 15 * 60000;   // a gate stops by itself this long after the quiz's end

  try {
    if (!/\/d2l\//.test(location.pathname)) throw new Error("Open Brightspace first, then click LOCKqz Sync.");
    if (!KEY) throw new Error("This bookmark has no LOCKqz key. Drag a fresh one from your LOCKqz dashboard.");

    // Brightspace GET. A login page / HTML answer (session ended) is never parsed as data.
    var get = async function (u) {
      var r = await fetch(u, { credentials: "include" });
      if (r.status === 401) throw expired();
      if (!r.ok) { var e = new Error("Brightspace answered " + r.status + " for " + String(u).split("?")[0]); e.status = r.status; throw e; }
      if (/text\/html/i.test((r.headers && r.headers.get && r.headers.get("Content-Type")) || "")) throw expired();
      try { return await r.json(); } catch (x) { throw expired(); }
    };
    // Every page of an ObjectListPage, or an error. Never a silent partial list.
    var pages = async function (u, max) {
      var all = [], next = u, n = 0;
      while (next) {
        if (++n > (max || 200)) throw new Error("too many pages from Brightspace");
        var d = await get(next);
        if (Array.isArray(d)) return all.concat(d);
        if (!d || typeof d !== "object" || !Array.isArray(d.Objects)) throw new Error("unexpected Brightspace answer for " + String(u).split("?")[0]);
        all = all.concat(d.Objects); next = d.Next || null;
      }
      return all;
    };
    var csrf = ""; try { csrf = localStorage.getItem("XSRF.Token") || ""; } catch (e) {}
    var csrfAt = 0;
    var xsrf = async function (force) {
      if (csrf && !(force && Date.now() - csrfAt > 5000)) return csrf;   // after a 403: at most one refetch per 5 s
      if (force) csrfAt = Date.now();
      try { var r = await fetch("/d2l/lp/auth/xsrf-tokens", { credentials: "include" }); if (r.ok) { var j = await r.json(); if (j && j.referrerToken) csrf = j.referrerToken; } } catch (e) {}
      return csrf;
    };
    var send = async function (method, u, b) {
      var used = "";
      var go = async function () {
        used = await xsrf(); var h = { "X-Csrf-Token": used }; if (b) h["Content-Type"] = "application/json";
        return fetch(u, { method: method, credentials: "include", headers: h, body: b ? JSON.stringify(b) : undefined });
      };
      var r = await go();
      if (r.status === 403) { var old = used; await xsrf(true); if (csrf && csrf !== old) r = await go(); }   // stale token: once more with the new one
      return r;
    };
    var put = function (u, b) { return send("PUT", u, b); };
    var lqErr = function (d, status) {
      if (d && d.reason === "other_school") return new Error("LOCKqz is not set up for this school yet.");
      if (status === 401) return new Error("This LOCKqz Sync bookmark is no longer valid. Drag a fresh one from your dashboard.");
      return d && d.error ? new Error(d.error) : null;
    };
    var lq = async function (path, body) {
      var r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Sync": KEY }, body: JSON.stringify(body || {}) });
      var d = await r.json().catch(function () { return { error: "LOCKqz answered " + r.status }; });
      var e = lqErr(d, r.status); if (e) throw e;
      return d;
    };
    var lqget = async function (path) {
      var r = await fetch(API + path, { headers: { "X-LOCKqz-Sync": KEY } });
      return r.json().catch(function () { return {}; });
    };
    var lqpost = async function (path, body) {
      var r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Sync": KEY }, body: JSON.stringify(body || {}) });
      return r.json().catch(function () { return {}; });
    };
    var lqres = async function (path, body) {   // {ok, status, data}: for writes whose success matters
      try { var r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Sync": KEY }, body: JSON.stringify(body || {}) });
        var d = await r.json().catch(function () { return {}; }); return { ok: r.ok && !d.error, status: r.status, data: d }; }
      catch (e) { return { ok: false, status: 0, data: {} }; }
    };
    // N at a time (Brightspace special-access writes are one user per call).
    var pool = async function (list, n, fn) {
      var i = 0, w = [];
      var run = async function () { while (i < list.length) { var x = list[i++]; await fn(x); } };
      for (var k = 0; k < Math.min(n, list.length); k++) w.push(run());
      await Promise.all(w);
    };
    // Brightspace special-access helpers (one user at a time). PUT grants/keeps, DELETE removes.
    var saUrl = function (ou, qi, uid) { return "/d2l/api/le/" + LE + "/" + ou + "/quizzes/" + qi + "/specialaccess/" + uid; };
    var saList = function (ou, qi) { return pages("/d2l/api/le/" + LE + "/" + ou + "/quizzes/" + qi + "/specialaccess/"); };   // throws on any error
    var qd = function (q) { return { StartDate: (q && q.StartDate) || null, EndDate: (q && q.EndDate) || null, DueDate: (q && q.DueDate) || null }; };
    // A LOCKqz grant only makes the hidden quiz visible: the quiz's OWN dates, no time limit, no attempts.
    var saPut = function (ou, qi, uid, q) { var d = qd(q); return put(saUrl(ou, qi, uid), { StartDate: d.StartDate, EndDate: d.EndDate, DueDate: d.DueDate, SubmissionTimeLimit: null, AttemptsAllowed: null }); };
    var saDel = function (ou, qi, uid) { return send("DELETE", saUrl(ou, qi, uid)); };
    // Is this special access one LOCKqz made? (same dates as the quiz -- or 0.4.0's null start/due -- and no
    // time limit / attempts). An accommodation always differs, so it is never removed.
    var ourGrant = function (sa, qs) {
      if (!sa) return false;
      var tl = sa.SubmissionTimeLimit; if ((tl && tl.IsEnforced !== false) || sa.AttemptsAllowed) return false;
      return (qs || []).some(function (q) { return dt(sa.EndDate) === dt(q.EndDate) &&
        ((dt(sa.StartDate) === dt(q.StartDate) && dt(sa.DueDate) === dt(q.DueDate)) || (dt(sa.StartDate) === null && dt(sa.DueDate) === null)); });
    };

    // ---- 1. read Brightspace ----
    wait("Reading your Brightspace courses", "This usually takes under a minute");
    var vers = await get("/d2l/api/versions/");
    var ver = function (c) { var v = vers.filter(function (x) { return x.ProductCode === c; })[0]; return v ? v.LatestVersion : null; };
    var LE = ver("le"), LP = ver("lp");
    var me = await get("/d2l/api/lp/" + LP + "/users/whoami");
    // Newest courses first and active ones only, so a long teaching history never pushes this term out.
    var items = [], bm = "", sortQ = "&isActive=true&sortBy=-StartDate";
    for (var pg = 0; pg < 100; pg++) {
      var d;
      try { d = await get("/d2l/api/lp/" + LP + "/enrollments/myenrollments/?orgUnitTypeId=3" + sortQ + (bm ? "&bookmark=" + encodeURIComponent(bm) : "")); }
      catch (e) { if (e.status === 400 && sortQ && !pg) { sortQ = ""; pg--; continue; } throw e; }   // a Brightspace without these filters
      items = items.concat(d.Items || []);
      bm = d.PagingInfo && d.PagingInfo.HasMoreItems ? d.PagingInfo.Bookmark : "";
      if (!bm) break;
    }
    var ended = function (i) { var e = dt(i.Access && i.Access.EndDate); return e !== null && e < Date.now() - 14 * 86400000; };
    var lisStaff = function (i) { return ((i.Access && i.Access.LISRoles) || []).some(function (r) { return LIS_STAFF.test(String(r)); }); };
    var staff = items.filter(function (i) { return i.Access && i.Access.IsActive !== false && !ended(i) && (STAFF.test(i.Access.ClasslistRoleName || "") || lisStaff(i)); });
    staff.sort(function (a, b) { return (dt(b.Access.StartDate) || Date.now()) - (dt(a.Access.StartDate) || Date.now()); });
    staff = staff.slice(0, 80);   // LOCKqz reads at most 80 courses per Sync
    if (!staff.length) throw new Error("You are not an instructor or TA in any active Brightspace course.");

    // The quiz's own timing (QuizReadData.SubmissionTimeLimit / LateSubmissionInfo / SubmissionGracePeriod):
    // LOCKqz works out how long an attempt begun before the end may run past it (extended time).
    var timing = function (x) {
      var t = x && x.SubmissionTimeLimit, l = x && x.LateSubmissionInfo;
      return { tl: t && t.IsEnforced && Number(t.TimeLimitValue) > 0 ? Number(t.TimeLimitValue) : null,
               late: l && l.LateSubmissionOption != null ? Number(l.LateSubmissionOption) : null,
               late_min: l && l.LateLimitMinutes != null ? Number(l.LateLimitMinutes) : null,
               grace: x && x.SubmissionGracePeriod != null ? Number(x.SubmissionGracePeriod) : null };
    };
    var courses = [], OWNPW = {};
    var LQFMT = /^LQ-([0-9A-F]{10}|[A-HJ-NP-Z2-9]{8})$/;   // passwords LOCKqz makes (fixed / gate code): never the professor's own
    for (var n = 0; n < staff.length; n++) {
      var ou = staff[n].OrgUnit.Id;
      say("Reading course " + (n + 1) + " of " + staff.length + "<br><b>" + esc(staff[n].OrgUnit.Name) + "</b>");
      var cl = null, qs = null;
      try { cl = await pages("/d2l/api/le/" + LE + "/" + ou + "/classlist/paged/"); }
      catch (e) { if (e.expired) throw e; cl = await get("/d2l/api/le/" + LE + "/" + ou + "/classlist/").catch(function (e2) { if (e2.expired) throw e2; return null; }); }
      if (cl && !Array.isArray(cl)) cl = null;
      // A failed or partial quiz list is sent as null: LOCKqz then keeps what it had (never wipes a course).
      try { qs = await pages("/d2l/api/le/" + LE + "/" + ou + "/quizzes/"); } catch (e) { if (e.expired) throw e; qs = null; }
      (qs || []).forEach(function (x) { if (x.Password && !LQFMT.test(x.Password)) OWNPW[String(x.QuizId)] = true; });
      courses.push({
        ou: ou, name: staff[n].OrgUnit.Name, code: staff[n].OrgUnit.Code, role: staff[n].Access.ClasslistRoleName,
        lis_roles: (staff[n].Access.LISRoles || []).map(String),
        classlist: cl ? cl.map(function (s) { return { id: s.Identifier, name: s.DisplayName || ((s.FirstName || "") + " " + (s.LastName || "")).trim(),
          email: s.Email, username: s.Username, org_id: s.OrgDefinedId, role: s.ClasslistRoleDisplayName, role_id: s.RoleId == null ? undefined : s.RoleId }; }) : null,
        quizzes: qs ? qs.map(function (x) { return Object.assign({ qi: x.QuizId, name: x.Name, active: x.IsActive, start: x.StartDate, end: x.EndDate, due: x.DueDate, has_password: !!x.Password, lq_password: !!x.Password && LQFMT.test(x.Password) }, timing(x)); }) : null
      });
    }

    // Nothing changed in Brightspace since the last sync (and it was under an hour ago): an auto re-check
    // stops here, without a single LOCKqz request. Only a fingerprint is kept (no class data, no key).
    var hashStr = function (s) { var a = 0x811c9dc5, b = 0x1b873593; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619) >>> 0; b = Math.imul(b ^ c, 2246822519) >>> 0; } return a.toString(16) + "." + b.toString(16); };
    // The fingerprint leaves out has_password but keeps lq_password (is LOCKqz's password on it?), so a
    // password changed or removed by hand in Brightspace triggers a sync that puts it right. After this
    // sync's own writes the fingerprint is re-taken with the results (no extra sync for LOCKqz's changes).
    var FPK = "lqz.sync." + hashStr(KEY), prev = null;
    var fpOf = function () { return hashStr(JSON.stringify(courses, function (k, v) { return k === "has_password" ? undefined : v; })); };
    var FP = fpOf();
    try { prev = JSON.parse(localStorage.getItem(FPK) || "null"); } catch (e) { prev = null; }
    var autoLine = function () { return "Re-syncs by itself every 15 min while this tab is open · checked " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
    // The extension's background sync, no panel yet: nothing changed in Brightspace within the hour -> no
    // LOCKqz request at all (same rule as the panel's own re-check).
    if (QUIET && !AUTO && !ASKED && prev && prev.fp === FP && Date.now() - Number(prev.at || 0) < FORCE_MS) {
      box.remove(); tell({ lqz: "synced", ok: true, unchanged: true }); return;
    }
    if (AUTO) {
      if (!FORCE && prev && prev.fp === FP && Date.now() - Number(prev.at || 0) < FORCE_MS) { var al = open.querySelector("#lqz-auto"); if (al) al.textContent = autoLine(); return; }
      if (!document.body.contains(open) || (open.dataset && open.dataset.gates === "1")) {
        if (FORCE) tell({ lqz: "busy", why: "A quiz gate is running in Brightspace. Sync after the quiz." });
        return;
      }
      if (open.style.display === "none") box.style.display = "none";
      open.remove(); document.body.appendChild(box);   // the old panel's own re-check timer stops with it
    }

    // ---- 2. save to LOCKqz ----
    wait("Saving to LOCKqz", "This takes a few seconds");
    var state = await lq("/sync", { host: location.host, whoami: { id: me.Identifier, name: ((me.FirstName || "") + " " + (me.LastName || "")).trim() }, courses: courses });
    AUTOGATE = !!(state && state.auto_gate);
    // What the SERVER confirms it saved (C3): orig_password_saved / orig_hidden_saved. A row with neither
    // saved -> null (nothing known yet), so saveOrig still saves the professor's settings first.
    var origOf = function (row) {
      if (!row) return null;
      var pwS = row.orig_password_saved === true, hS = row.orig_hidden_saved === true || (row.orig_hidden_saved === undefined && row.orig_hidden != null);
      return pwS || hS ? { password: pwS ? (row.orig_password || null) : null, hidden: hS ? !!row.orig_hidden : false, pwSaved: pwS, hiddenSaved: hS } : null;
    };
    (state.protect || []).concat(state.clear || []).forEach(function (r) { var o = origOf(r); if (o) ORIG[String(r.qi)] = o; });

    // ---- 3. passwords into / out of Brightspace ----
    var rt = function (o) { var t = o && o.Text; return { Text: { Content: (t && (t.Html || t.Text)) || "", Type: (t && t.Html) ? "Html" : "Text" }, IsDisplayed: !!(o && o.IsDisplayed) }; };
    var quizUrl = function (ou, qi) { return "/d2l/api/le/" + LE + "/" + ou + "/quizzes/" + qi; };
    async function writePw(ou, qi, pw, extra) {
      var cur = await get(quizUrl(ou, qi));
      var w = Object.assign({}, cur, { Instructions: rt(cur.Instructions), Description: rt(cur.Description), Header: rt(cur.Header), Footer: rt(cur.Footer), Password: pw }, extra || {});
      w.NumberOfAttemptsAllowed = (cur.AttemptsAllowed && !cur.AttemptsAllowed.IsUnlimited) ? cur.AttemptsAllowed.NumberOfAttemptsAllowed : null;
      delete w.AttemptsAllowed; delete w.QuizId; delete w.ActivityId;
      if (!w.RestrictIPAddressRange || !w.RestrictIPAddressRange.length) w.RestrictIPAddressRange = null;
      var r = await put(quizUrl(ou, qi), w);
      if (!r.ok) throw new Error("Brightspace " + r.status + ": " + (await r.text()).slice(0, 140));
      var after = await get(quizUrl(ou, qi));
      if ((after.Password || null) !== (pw || null)) throw new Error("password did not stick");
      return after;
    }
    // Ours = the fixed LOCKqz password, or a gate code (LQ- + 10 hex, or the last one this tab wrote).
    var ROT = /^LQ-[0-9A-F]{10}$/;
    var isGate = function (p, qi) { return !!p && (ROT.test(p) || p === GPW[qi] || (GATES[qi] && GATES[qi].written === p)); };
    var ours = function (p, qi) { return !!p && (isGate(p, qi) || p === PW[String(qi)] || /^LQ-[A-HJ-NP-Z2-9]{8}$/.test(p)); };
    // Save the professor's own password / hidden setting ONCE, before LOCKqz first changes the quiz.
    // Skipped only for what the server has confirmed saved (ORIG[qi].pwSaved / hiddenSaved); a failed
    // save throws, so LOCKqz never overwrites a setting it could not save first.
    async function saveOrig(ou, qi, cur) {
      qi = String(qi);
      var o = { password: ours(cur.Password, qi) ? null : (cur.Password || null), hidden: !!cur.AllowOnlyUsersWithSpecialAccess && !isGate(cur.Password, qi) };
      var k = ORIG[qi] || {}, item = { ou: String(ou), qi: qi, status: "orig" };
      if (!k.pwSaved && o.password != null) item.orig_password = o.password;
      if (!k.hiddenSaved && o.hidden) item.orig_hidden = true;
      var sent = "orig_password" in item || "orig_hidden" in item;
      if (sent) await lq("/sync-result", { results: [item] });
      ORIG[qi] = { password: k.pwSaved ? k.password : o.password, hidden: k.hiddenSaved ? !!k.hidden : o.hidden,
                   pwSaved: !!k.pwSaved || "orig_password" in item, hiddenSaved: !!k.hiddenSaved || "orig_hidden" in item };
    }
    async function protect(ou, qi, pw) {          // put LOCKqz's password on the quiz
      var cur = await get(quizUrl(ou, qi));
      if (cur.Password === pw) return "already";
      await saveOrig(ou, qi, cur);
      await writePw(ou, qi, pw); return "set";
    }
    async function release(ou, qi, oldPw, orig) {      // remove ONLY our password; put the professor's own settings back
      qi = String(qi);
      var cur = await get(quizUrl(ou, qi)), o = orig || ORIG[qi] || null;
      var mine = !!cur.Password && (cur.Password === oldPw || ours(cur.Password, qi));
      if (mine) {
        var extra = {};
        if (o) extra.AllowOnlyUsersWithSpecialAccess = !!o.hidden;
        else if (isGate(cur.Password, qi)) extra.AllowOnlyUsersWithSpecialAccess = false;   // our gate hid it
        await writePw(ou, qi, o ? o.password : null, extra);
      }
      delete GPW[qi]; delete ORIG[qi];
      return "cleared";
    }
    var PW = {};   // qi -> current LOCKqz password, filled when protected
    (state.protect || []).forEach(function (p) { PW[String(p.qi)] = p.password; });
    function pw_of(qi) { return PW[String(qi)]; }
    var results = [], errors = [];
    var todo = (state.protect || []).length + (state.clear || []).length, done = 0;
    for (var i = 0; i < (state.protect || []).length; i++) {
      var x = state.protect[i]; say("Setting LOCKqz passwords in Brightspace... " + (++done) + "/" + todo);
      if (Number(x.gated) === 1) continue;   // gate on: the gate owns this quiz's password (resumed below)
      try { results.push({ ou: x.ou, qi: x.qi, status: await protect(x.ou, x.qi, x.password) }); }
      catch (e) { if (e.expired) throw e; results.push({ ou: x.ou, qi: x.qi, status: "error", msg: e.message }); errors.push((x.title || x.qi) + ": " + e.message); }
    }
    for (var k = 0; k < (state.clear || []).length; k++) {
      var y = state.clear[k]; say("Removing released passwords... " + (++done) + "/" + todo);
      try { results.push({ ou: y.ou, qi: y.qi, status: await release(y.ou, y.qi, y.password, origOf(y)) }); }
      catch (e) { if (e.expired) throw e; results.push({ ou: y.ou, qi: y.qi, status: "error", msg: e.message }); errors.push(y.qi + ": " + e.message); }
    }
    if (results.length) await lq("/sync-result", { results: results });
    results.forEach(function (r) {
      var on = r.status === "set" || r.status === "already" ? true : r.status === "cleared" ? false : null;
      if (on === null) return;
      courses.forEach(function (c) { if (String(c.ou) === String(r.ou)) (c.quizzes || []).forEach(function (q) { if (String(q.qi) === String(r.qi)) q.lq_password = on; }); });
    });
    FP = fpOf();
    try { localStorage.setItem(FPK, JSON.stringify({ fp: FP, at: Date.now() })); } catch (e) {}
    tell({ lqz: "synced", ok: !errors.length, courses: courses.length, errors: errors.length });

    // ---- Send email (every class): the same install email the dashboard's Send email button writes, to
    // the class's students from Brightspace's own class list. (Who has installed LOCKqz is shown only on
    // the dashboard: the Sync bookmark's key never reads LOCKqz data about students, FERPA.)
    var INSTALL = "https://lockqz.pages.dev";
    var myName = ((me.FirstName || "") + " " + (me.LastName || "")).trim();
    function mailLink(c, learnersL) {
      var nextQ = openQ(c).filter(function (q) { var st = dt(q.start); return st !== null && st > Date.now(); })
        .sort(function (a, b) { return dt(a.start) - dt(b.start); })[0];
      var subj = "Install LOCKqz before " + (nextQ ? nextQ.name : "our next exam") + " (" + cname(c) + ")";
      var body = "Hi,\n\nOur Brightspace exams in " + cname(c) + " use LOCKqz. You need it installed once, or the exam will not open for you.\n\n1. Go to " + INSTALL + "\n2. Click Download and run the installer.\n\nIf you already installed LOCKqz, you are all set. That is all. It only blocks AI tools while an exam is open and turns itself off after.\n\n" + myName;
      var bcc = learnersL.map(function (s) { return s.email; }).filter(Boolean).join(",");
      var href = "mailto:?" + (bcc ? "bcc=" + encodeURIComponent(bcc) + "&" : "") + "subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(body);
      if (href.length > 1900) href = "mailto:?subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(body);   // mail apps drop longer links
      return '<a class="lqmail" data-ou="' + c.ou + '" href="' + esc(href) + '" title="Email this class the LOCKqz install link" style="color:#990000;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap">Send email</a>';
    }

    // ---- 4. panel: choose protected quizzes ----
    var prot = {}; (state.protect || []).forEach(function (p) { prot[String(p.qi)] = true; });
    // Same classes, same order, same names and the same on/off as the LOCKqz dashboard:
    //  * only the classes LOCKqz saved for this account (state.ous; the dashboard lists exactly these);
    //  * sorted by name, Brightspace's term prefix cut the dashboard's way (cname);
    //  * a class is ON when it is not turned off (state.class_off) and every quiz that has not ended is
    //    protected (dashboard classStats); quizzes that ended are listed, without a switch, under "past".
    var SHOWN = null; if (state && Array.isArray(state.ous)) { SHOWN = {}; state.ous.forEach(function (o) { SHOWN[String(o)] = true; }); }
    var CLASSOFF = {}; (state.class_off || []).forEach(function (o) { CLASSOFF[String(o)] = true; });
    var byName = function (a, b) { var x = String(a.name || ""), y = String(b.name || ""); return x < y ? -1 : x > y ? 1 : 0; };
    var cname = function (c) { return String(c.name || c.ou).replace(/^\d+_\w+\s*/, ""); };
    var endedQ = function (q) { var e = dt(q.end), d = dt(q.due), n = Date.now(); return (e !== null && e < n) || (d !== null && e === null && d < n - 86400000); };
    // A quiz whose gate is still on stays listed after its end, so a reloaded tab resumes the gate and the
    // gate stops itself (15 min after the end) instead of leaving the quiz hidden.
    var GATED = {}; (state.protect || []).forEach(function (p) { if (Number(p.gated) === 1) GATED[String(p.qi)] = true; });
    var openQ = function (c) { return (c.quizzes || []).filter(function (q) { return !endedQ(q) || GATED[String(q.qi)]; }); };
    var view = courses.filter(function (c) { return !SHOWN || SHOWN[String(c.ou)]; }).sort(byName);
    var notMine = courses.length - view.length;
    var students = 0, nq = 0, unread = 0;
    var html = "";
    view.forEach(function (c) {
      var learnersL = (c.classlist || []).filter(function (s) { return !INSTR.test(s.role || "") && !!(s.role || "").trim(); });
      var learners = learnersL.length;
      students += learners; nq += openQ(c).length;
      html += '<div style="display:flex;align-items:center;gap:12px;margin:16px 0 6px">' +
        '<span style="flex:1;min-width:0;font-weight:700">' + esc(cname(c)) + '</span>' +
        mailLink(c, learnersL) +
        '<label class="lqsw" title="LOCKqz for the whole class"><input type="checkbox" class="lqcls-all" data-cls="' + c.ou + '"><span class="lqsl"></span></label>' +
        '</div>';
      if (!c.quizzes) { unread++; html += '<div style="color:#990000;font-size:13px">Could not read quizzes from Brightspace. Click Sync again.</div>'; return; }
      var openList = openQ(c).slice().sort(byName), past = c.quizzes.filter(function (q) { return endedQ(q) && !GATED[String(q.qi)]; }).sort(byName);
      if (!openList.length) html += '<div style="color:#888;font-size:13px">No upcoming quizzes' + (CLASSOFF[String(c.ou)] ? " · LOCKqz is off for this class." : " · new ones are protected by themselves.") + "</div>";
      openList.forEach(function (q) {
        var on = !!prot[String(q.qi)], own = !on && OWNPW[String(q.qi)];
        var sd = q.start ? day(q.start) : "", ed = q.end ? day(q.end) : "";
        var dates = (sd || ed || q.active === false) ? '<span style="color:#888;font-size:12px;display:block;margin-top:2px">' + (q.active === false ? "hidden in Brightspace" + (sd || ed ? " · " : "") : "") + esc(sd && ed ? sd + " – " + ed : (sd || ed)) + "</span>" : "";
        html += '<div style="padding:9px 0;border-bottom:1px solid #eee;display:flex;align-items:center;gap:12px">' +
          '<span style="flex:1;min-width:0"><span style="font-weight:600">' + esc(q.name) + "</span>" + dates + "</span>" +
          '<label class="lqsw"><input type="checkbox" data-ou="' + c.ou + '" data-qi="' + q.qi + '"' + (on ? " checked" : "") + '><span class="lqsl"></span></label>' +
          '<span data-st="' + q.qi + '" style="display:none">' + (on ? "protected" : own ? "has its own password" : "") + "</span>" +
          '<span style="display:none"><button data-gate="' + c.ou + ":" + q.qi + '"' + (on ? "" : " disabled") + '>Start gate</button> <span data-gst="' + q.qi + '">off</span></span>' +
          "</div>";
      });
      if (past.length) html += '<details style="margin-top:6px;color:#888;font-size:13px"><summary>' + past.length + " past</summary>" +
        past.map(function (q) { return '<div style="padding:4px 0">' + esc(q.name) + "</div>"; }).join("") + "</details>";
    });
    say('<style>.lqsw{position:relative;display:inline-block;width:40px;height:24px;flex:none}.lqsw input{position:absolute;opacity:0;width:0;height:0;margin:0}.lqsl{position:absolute;inset:0;background:#ccc;border-radius:24px;transition:.15s;cursor:pointer}.lqsl:before{content:"";position:absolute;height:18px;width:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}.lqsw input:checked+.lqsl{background:#990000}.lqsw input:checked+.lqsl:before{transform:translateX(16px)}.lqsw input:disabled+.lqsl{opacity:.55;cursor:default}</style><div style="background:#eafbea;padding:8px 10px;border-radius:8px">Synced ' + view.length + " class" + (view.length === 1 ? "" : "es") +
      ", " + students + " students, " + nq + " quizzes.</div>" +
      (notMine ? '<div style="color:#888;font-size:12px;margin-top:6px">' + notMine + " other Brightspace course" + (notMine === 1 ? " is" : "s are") + " not on your LOCKqz account (another professor runs LOCKqz there, or Brightspace does not list you as its instructor yet).</div>" : "") +
      (unread ? '<div style="color:#990000;margin-top:8px">' + unread + " course" + (unread === 1 ? "" : "s") + " not read: LOCKqz kept the quizzes it had.</div>" : "") +
      (errors.length ? '<div style="color:#990000;margin-top:8px">Could not update: ' + esc(errors.join("; ")) + "</div>" : "") +
      '<div style="margin-top:10px;font-weight:700">Protect with LOCKqz (blocks AI during the quiz):</div>' + html +
      '<div style="margin-top:12px"><a id="lqz-dash" href="' + DASH + '" target="_blank" style="color:#990000;font-weight:700">Open LOCKqz dashboard</a></div>' +
      '<div id="lqz-auto" style="color:#888;font-size:12px;margin-top:6px">' + esc(autoLine()) + "</div>");

    // ---- live access gate: only students LOCKqz is actively locking can see the quiz ----
    // Professor clicks Start and leaves this tab open. Every 10s we read who is locked (device-signed,
    // fresh) and grant Brightspace special access to exactly them. Safety rules (25 Oct 2026):
    //  * special access that existed BEFORE the gate, or that LOCKqz did not create (accommodations,
    //    even ones added while the gate runs), is never changed or removed;
    //  * a grant copies the quiz's own Start/Due/End dates and is given the moment a student locks once
    //    the quiz has started per Brightspace; a sleeping/closed tab or a wifi blip never locks an
    //    honest student out; grants are removed only on positive evidence (tamper, stopped, submitted);
    //  * the special-access list must be read in full, or nothing is granted/removed this round;
    //  * the quiz is hidden only after Brightspace accepted a test grant, and shown again by itself if
    //    every grant keeps failing; the gate stops by itself 15 min after the quiz's end;
    //  * no IP lock; the password changes only when its code changes, and counts only once LOCKqz has
    //    confirmed it, so the app always hands out exactly what Brightspace holds.
    var REVOKE = { tamper: 1, helper_killed: 1, done: 1, left_early: 1 };
    // Who Brightspace shows as having SUBMITTED this quiz, with when (QuizAttemptData.Completed, a
    // UTCDateTime, null while in progress). A student with an attempt still open is not counted.
    async function submittedUsers(ou, qi) {
      var by = {};
      try {
        (await pages("/d2l/api/le/" + LE + "/" + ou + "/quizzes/" + qi + "/attempts/", 100)).forEach(function (a) {
          if (!a || a.UserId == null) return;
          var c0 = [a.Completed, a.TimeCompleted, a.CompletionDate].filter(function (v) { return typeof v === "string" && dt(v) !== null; })[0];   // documented: Completed
          var u = String(a.UserId), c = c0 || null, b = by[u] = by[u] || { at: null, open: false };
          if (c) { if (!b.at || dt(c) > dt(b.at)) b.at = c; } else b.open = true;
        });
      } catch (e) { if (e.expired) throw e; return []; }
      return Object.keys(by).filter(function (u) { return by[u].at && !by[u].open; }).map(function (u) { return { id: u, completed: by[u].at }; });
    }
    // A student enrolled after the last Sync is not in LOCKqz's class list yet (and no re-sync runs while
    // a gate is on): match their confirmed email against Brightspace's own class list, read here at most
    // once a minute per course and only while such a student is waiting. Costs LOCKqz no request.
    var BSIDS = {};
    async function bsIds(ou) {
      var c = BSIDS[ou]; if (c && Date.now() - c.at < 60000) return c.map;
      var map = {}, cl = null;
      try { cl = await pages("/d2l/api/le/" + LE + "/" + ou + "/classlist/paged/"); } catch (e) { if (e.expired) throw e; }
      (Array.isArray(cl) ? cl : []).forEach(function (s) { if (s && s.Email && s.Identifier != null && !STAFF.test(s.ClasslistRoleDisplayName || "")) map[String(s.Email).toLowerCase()] = String(s.Identifier); });
      BSIDS[ou] = { at: Date.now(), map: map };
      return map;
    }
    async function gateStep(ou, qi) {
      var g = GATES[qi], live = await lqget("/live?quiz=" + ou + "-" + qi);
      if (!live || !live.rows) throw new Error("LOCKqz not reachable");
      var miss = live.rows.filter(function (r) { return !r.user_id && r.email && r.sv && !r.unpaid && r.verified === true && r.status === "locked"; });
      if (miss.length) { var ids = await bsIds(ou); miss.forEach(function (r) { var u = ids[String(r.email).toLowerCase()]; if (u) r.user_id = u; }); }
      // Brightspace dates changed during the gate (professor moved the start / extended the end): the
      // server's start check and quiz end follow (/gate on keeps the gate's accommodation list).
      if (g.datesNew) { var nd = g.datesNew;
        if ((await lqres("/gate", { ou: ou, qi: qi, on: true, start: nd.StartDate, end: nd.EndDate })).ok && g.datesNew === nd) g.datesNew = null; }
      // Confirm real submissions to the server, throttled to once per ~20s; each student sent once.
      if (!g.nextSub || Date.now() >= g.nextSub) {
        g.nextSub = Date.now() + 20000; g.subsSent = g.subsSent || {};
        var subs = (await submittedUsers(ou, qi)).filter(function (s) { return !g.subsSent[s.id]; });
        if (subs.length && (await lqres("/submitted", { ou: ou, qi: qi, quiz: ou + "-" + qi, users: subs, user_ids: subs.map(function (s) { return s.id; }) })).ok)
          subs.forEach(function (s) { g.subsSent[s.id] = true; });
      }
      var want = {}, revoke = {};
      // Admitted the moment they lock once the quiz has started per Brightspace's own (fresh) start date.
      var q0 = g.qs[g.qs.length - 1], begun = dt(q0 && q0.StartDate) === null || Date.now() >= dt(q0.StartDate);
      live.rows.forEach(function (r) { if (!r.user_id) return; var u = String(r.user_id);
        if (r.eligible || (begun && r.verified === true && r.status === "locked")) want[u] = true; else if (REVOKE[r.status]) revoke[u] = true; });
      var have = await saList(ou, qi), haveMap = {};
      have.forEach(function (x) { if (x && x.UserId != null) haveMap[String(x.UserId)] = x.SpecialAccess || {}; });
      // Special access the professor / OSAS added WHILE the gate runs (extra time, another day, a makeup):
      // an accommodation like the ones kept at start. Told to LOCKqz once (one write), so the student's
      // own window counts there too (no start check, no end-based release). Never changed or removed.
      var acc = Object.keys(haveMap).filter(function (u) { return !g.keep[u] && !ourGrant(haveMap[u], g.qs); });
      if (acc.length && !(g.accNext && Date.now() < g.accNext)) {
        if ((await lqres("/gate", { ou: ou, qi: qi, on: true, add_keep: acc })).ok) acc.forEach(function (u) { g.keep[u] = true; });
        else g.accNext = Date.now() + 60000;   // retried once a minute, not every round
      }
      var res = { n: 0, bad: 0, stuck: 0, tried: 0, del: 0, rows: live.rows.length };   // admitted, could not admit, could not remove
      var add = Object.keys(want).filter(function (u) { if (g.keep[u] || haveMap[u]) { res.n++; return false; } return true; });
      await pool(add, 8, async function (u) {
        res.tried++; var pr = await saPut(ou, qi, u, g.qs[g.qs.length - 1]).catch(function () { return null; });
        if (pr && pr.ok) res.n++; else res.bad++;
      });
      // Only a grant that still looks exactly like LOCKqz's (one the professor edited is theirs now).
      var del = Object.keys(revoke).filter(function (u) { return haveMap[u] && !g.keep[u] && !want[u] && ourGrant(haveMap[u], g.qs); });
      res.del = del.length;
      await pool(del, 8, async function (u) {
        var dr = await saDel(ou, qi, u).catch(function () { return null; });
        if (!dr || !dr.ok) res.stuck++;
      });
      g.allFail = res.tried && res.bad === res.tried && !res.n ? (g.allFail || 0) + 1 : 0;
      if (g.nextRot && Date.now() < g.nextRot) return res;   // code changes every 5 min
      try {
        var rot = await lqpost("/rotating", { ou: ou, qis: [qi] });
        var c = rot && rot.codes && rot.codes[qi], code = c ? c.cur : null;
        if (c) g.nextRot = (c.bucket + 1) * 300000 + 2000;
        if (code && GPW[qi] !== code) {
          if (g.written !== code) { var after = await writePw(ou, qi, code, { AllowOnlyUsersWithSpecialAccess: true }); g.written = code; addDates(g, after); }
          var cf = await lqres("/rotated", { ou: ou, qi: qi, code: code });   // the app hands out a code only once LOCKqz has it
          if (cf.ok) { GPW[qi] = code; g.rotNote = ""; } else { g.nextRot = 0; g.rotNote = "new code not confirmed by LOCKqz, retrying"; }
        }
      } catch (e) { if (e.expired) throw e; g.nextRot = 0; }
      return res;
    }
    // Every version of the quiz's dates seen while gating (grants made under any of them stay "ours").
    // A change after the gate started is sent to the server (its start check / end) on the next round.
    function addDates(g, q) {
      var d = qd(q), last = g.qs[g.qs.length - 1];
      if (last && (dt(last.StartDate) !== dt(d.StartDate) || dt(last.EndDate) !== dt(d.EndDate))) g.datesNew = d;
      if (!g.qs.some(function (x) { return JSON.stringify(x) === JSON.stringify(d); })) g.qs.push(d);
      g.endMs = dt(d.EndDate);
    }
    // Brightspace must accept AND remove one grant before the quiz is hidden (a role that cannot give
    // special access would otherwise lock the whole class out). Tried on a learner with no special access.
    async function testGrant(ou, qi, cur, before) {
      var c = courses.filter(function (x) { return String(x.ou) === String(ou); })[0], skip = {};
      before.forEach(function (u) { skip[u] = true; });
      var t = ((c && c.classlist) || []).filter(function (s) { return s.id != null && !skip[String(s.id)] && String(s.id) !== String(me.Identifier) && !STAFF.test(s.role || ""); })[0];
      if (!t) return;
      var r = await saPut(ou, qi, t.id, cur);
      if (!r.ok) throw new Error("Brightspace refused special access (" + r.status + "). Quiz not hidden.");
      var d = await saDel(ou, qi, t.id);
      if (!d.ok) d = await saDel(ou, qi, t.id);
      if (!d.ok) throw new Error("Brightspace refused removing special access (" + d.status + "). Quiz not hidden.");
    }
    async function startGate(ou, qi, pw, st, resume) {
      st.textContent = "starting..."; st.style.color = "#666";
      if (!pw) throw new Error("protect this quiz first");
      var cur = await get(quizUrl(ou, qi));
      var have = await saList(ou, qi);   // must read in full: this is the accommodation list LOCKqz never touches
      var before = have.filter(function (x) { return resume || cur.AllowOnlyUsersWithSpecialAccess || !ourGrant(x.SpecialAccess, [qd(cur)]); })
        .map(function (x) { return String(x.UserId); });
      var g;
      var when = { start: cur.StartDate || null, end: cur.EndDate || null };   // current dates for the server's start check
      if (resume) g = await lq("/gate", { ou: ou, qi: qi, on: true, keep: before, start: when.start, end: when.end });
      else {
        await saveOrig(ou, qi, cur);
        await testGrant(ou, qi, cur, have.map(function (x) { return String(x.UserId); }));
        await writePw(ou, qi, pw, { AllowOnlyUsersWithSpecialAccess: true });   // hide quiz from everyone else
        try { g = await lq("/gate", { ou: ou, qi: qi, on: true, keep: before, start: when.start, end: when.end }); }   // server keeps the FIRST list
        catch (e) { try { await writePw(ou, qi, pw, { AllowOnlyUsersWithSpecialAccess: !!(ORIG[qi] && ORIG[qi].hidden) }); } catch (e2) {} throw e; }
      }
      var keep = {}; (g.keep || []).forEach(function (u) { keep[String(u)] = true; });
      var tick = async function () {
        var G = GATES[qi]; if (!G || G.busy) return; G.busy = true;
        try {
          if (G.endMs !== null && Date.now() > G.endMs + GRACE) { G.busy = false; await stopGate(ou, qi, st, "quiz ended"); showGateBtn(ou, qi); return; }
          // Hidden and waiting: no LOCKqz requests until 2 min before the start; while nobody has locked
          // in yet, one round every 30 s instead of every 10 s (Cloudflare free plan).
          var g0 = G.qs[G.qs.length - 1], sMs = AUTOGATE ? dt(g0 && g0.StartDate) : null;
          if (sMs !== null && Date.now() < sMs - 120000) {
            st.textContent = "Gate on · quiz hidden · admits locked students from " + new Date(sMs).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            st.style.color = "#1a7f37"; G.busy = false; return;
          }
          if (G.idleUntil && Date.now() < G.idleUntil) { G.busy = false; return; }
          var r = await gateStep(ou, qi);
          // Rounds: 10 s while anything changes; 30 s once the quiz has run 5 min and 3 rounds changed nothing
          // (any new lock / admit / removal goes back to 10 s); 60 s after the quiz's end (submissions only).
          var calm = !r.tried && !r.del && r.rows === G.lastRows; G.lastRows = r.rows; G.calm = calm ? (G.calm || 0) + 1 : 0;
          var s0 = dt(g0 && g0.StartDate), late = s0 === null || Date.now() > s0 + 300000, now0 = Date.now();
          G.idleUntil = G.endMs !== null && now0 > G.endMs ? now0 + 50000 : (!r.rows && AUTOGATE) || (late && G.calm >= 3) ? now0 + 20000 : 0;
          if (G.allFail >= 3) { G.busy = false; await stopGate(ou, qi, st, "stopped: Brightspace refused special access, quiz shown again"); showGateBtn(ou, qi); return; }
          st.textContent = "LIVE — " + r.n + " locked in" + (r.bad ? " · " + r.bad + " not admitted (Brightspace error)" : "") +
            (r.stuck ? " · " + r.stuck + " not removed (Brightspace error)" : "") + (G.rotNote ? " · " + G.rotNote : "") + (G.note ? " · " + G.note : "");
          st.style.color = r.bad || r.stuck || G.note || G.rotNote ? "#990000" : "#1a7f37";
        }
        catch (e) { st.textContent = (e.expired ? e.message : "gate error: " + e.message.slice(0, 50)) + " (retrying)"; st.style.color = "#990000"; }
        G.busy = false;
      };
      GATES[qi] = { ou: ou, busy: false, keep: keep, qs: [], endMs: null, tick: tick, timer: setInterval(tick, 10000) }; markGates();
      addDates(GATES[qi], cur);
      tick();
    }
    // Errors are thrown (not hidden). On failure the gate is put back on, so Brightspace and LOCKqz agree.
    async function stopGate(ou, qi, st, why) {
      var g = GATES[qi]; if (g) { clearInterval(g.timer); delete GATES[qi]; markGates(); }
      st.textContent = "stopping..."; st.style.color = "#666";
      var stuck = 0;
      try {
        var keep = (g && g.keep) || {};
        var have = await saList(ou, qi), cur = await get(quizUrl(ou, qi)), qs = ((g && g.qs) || []).concat([qd(cur)]);
        var del = have.filter(function (x) { var u = String(x.UserId); return !keep[u] && ourGrant(x.SpecialAccess, qs); });
        // Quiz open again FIRST, then LOCKqz's grants removed: a student still inside an attempt (extra
        // time past the end) is never, even for a second, on a hidden quiz without special access.
        var o = ORIG[String(qi)];   // quiz open again as the professor had it (LOCKqz password still applies)
        await writePw(ou, qi, pw_of(qi) || (o && o.password) || null, { AllowOnlyUsersWithSpecialAccess: o ? !!o.hidden : false, RestrictIPAddressRange: null });
        await pool(del, 8, async function (x) { var dr = await saDel(ou, qi, String(x.UserId)).catch(function () { return null; }); if (!dr || !dr.ok) stuck++; });
        delete GPW[qi];
        await lq("/gate", { ou: ou, qi: qi, on: false });
      } catch (e) {
        delete GPW[qi];
        if (g) { g.busy = false; g.nextRot = 0; g.written = null; g.note = "stop failed: " + e.message.slice(0, 60); g.timer = setInterval(g.tick, 10000); GATES[qi] = g; markGates(); if (!why) g.tick(); }
        throw e;
      }
      st.textContent = (why ? why + " · " : "") + (stuck ? "off · " + stuck + " LOCKqz access not removed (Brightspace error)" : "off");
      st.style.color = stuck || /refused/.test(why || "") ? "#990000" : "#888";
    }

    var CBS = {};   // qi -> its checkbox
    var gateBtn = function (ou, qi) { return B.querySelector('[data-gate="' + ou + ":" + qi + '"]'); };
    var showGateBtn = function (ou, qi) {
      var gb = gateBtn(ou, qi), cb = CBS[qi]; if (!gb) return;
      gb.textContent = GATES[qi] ? "Stop gate" : "Start gate";
      gb.disabled = !GATES[qi] && !(cb && cb.checked);
    };
    B.querySelectorAll("input[data-qi]").forEach(function (cb) {
      CBS[cb.dataset.qi] = cb;
      cb.onchange = async function () {
        var ou = cb.dataset.ou, qi = cb.dataset.qi, st = B.querySelector('[data-st="' + qi + '"]'), gst = B.querySelector('[data-gst="' + qi + '"]');
        var gb = gateBtn(ou, qi); if (gb) gb.disabled = true;
        cb.disabled = true; st.style.color = "#666"; st.textContent = "saving...";
        try {
          if (!cb.checked && GATES[qi]) await stopGate(ou, qi, gst);   // turning LOCKqz off: stop its gate first
          var r = await lq("/protect", { ou: ou, qi: qi, on: cb.checked });
          if (cb.checked) PW[String(qi)] = r.password;
          var status = cb.checked ? await protect(ou, qi, r.password) : await release(ou, qi, r.clear, origOf(r));
          if (!cb.checked) delete PW[String(qi)];
          await lq("/sync-result", { results: [{ ou: ou, qi: qi, status: status }] });
          st.style.color = cb.checked ? "#1a7f37" : "#888"; st.textContent = cb.checked ? "protected" : "";
          if (!cb.__lqBulk) tell({ lqz: "changed" });   // the dashboard redraws at once
        } catch (e) {
          cb.checked = !cb.checked; st.style.color = "#990000"; st.textContent = e.message.slice(0, 60);
        }
        cb.disabled = false;
        showGateBtn(ou, qi);
        var cls = B.querySelector('input[data-cls="' + ou + '"]'); if (cls && cls.__refl && !cb.__lqBulk) cls.__refl();
      };
    });
    B.querySelectorAll("input[data-cls]").forEach(function (ca) {
      if (!ca.dataset || !ca.dataset.cls) return;   // real class toggles only (tests have none)
      var ou = ca.dataset.cls;
      var kids = function () { return [].slice.call(B.querySelectorAll('input[data-ou="' + ou + '"][data-qi]')); };
      // ON = not turned off for the class and every listed (not ended) quiz protected: the dashboard's rule.
      var refl = function () { var k = kids(); ca.checked = !CLASSOFF[ou] && k.every(function (c) { return c.checked; }); };
      refl(); ca.__refl = refl;
      ca.onchange = async function () {
        var want = ca.checked; ca.disabled = true;
        var r = await lqres("/class", { ou: ou, on: want });
        if (!r.ok) { ca.disabled = false; refl(); alert((r.data && r.data.error) || "LOCKqz could not change this class. Try again."); return; }
        if (want) delete CLASSOFF[ou]; else CLASSOFF[ou] = true;
        var k = kids();
        for (var i = 0; i < k.length; i++) { if (k[i].checked !== want) { k[i].checked = want; k[i].__lqBulk = true; try { if (k[i].onchange) await k[i].onchange(); } finally { k[i].__lqBulk = false; } } }
        ca.disabled = false; refl();
        tell({ lqz: "changed" });
      };
    });
    B.querySelectorAll("button[data-gate]").forEach(function (gb) {
      var parts = gb.dataset.gate.split(":"), ou = parts[0], qi = parts[1];
      var st = B.querySelector('[data-gst="' + qi + '"]');
      gb.onclick = async function () {
        gb.disabled = true;
        var stopping = !!GATES[qi];
        if (stopping && typeof AG_DONE !== "undefined") AG_DONE[qi] = true;
        try {
          if (!stopping) await startGate(ou, qi, pw_of(qi), st);
          else await stopGate(ou, qi, st);
        } catch (e) {
          var msg = (stopping ? "stop failed: " : "start failed: ") + e.message.slice(0, 80);
          if (GATES[qi]) GATES[qi].note = msg;
          st.textContent = msg + (GATES[qi] ? " (gate still on)" : ""); st.style.color = "#990000";
        }
        showGateBtn(ou, qi);
      };
    });
    // Resume any gate that was on before this tab was (re)opened, so a reload never strands a class
    // (a gate whose quiz has ended stops on its first tick).
    (state.protect || []).forEach(function (p) {
      if (NOGATE || Number(p.gated) !== 1) return;
      var gb = B.querySelector('[data-gate="' + p.ou + ":" + p.qi + '"]'), st = B.querySelector('[data-gst="' + p.qi + '"]');
      if (!gb || !st || GATES[String(p.qi)]) return;
      startGate(String(p.ou), String(p.qi), pw_of(p.qi), st, true).then(function () { showGateBtn(String(p.ou), String(p.qi)); })
        .catch(function (e) { st.textContent = "resume failed: " + e.message.slice(0, 60); st.style.color = "#990000"; });
    });

    // ---- automatic gate: every LOCKqz-protected quiz is gated (hidden; only students LOCKqz is locking
    // are let in), from 60 min before its start until it ends. Started once per quiz per tab; a professor
    // who presses Stop gate keeps it off in this tab. Checked every minute in the browser (no requests).
    var AG_DONE = {}, AG_MS = 60 * 60000;
    var qInfo = function (ou, qi) { for (var i = 0; i < courses.length; i++) if (String(courses[i].ou) === String(ou))
      for (var j = 0; j < (courses[i].quizzes || []).length; j++) if (String(courses[i].quizzes[j].qi) === String(qi)) return courses[i].quizzes[j]; return null; };
    var autoGate = function () {
      (state.protect || []).forEach(function (p) {
        var ou = String(p.ou), qi = String(p.qi);
        if (GATES[qi] || AG_DONE[qi] || Number(p.gated) === 1 || !pw_of(qi)) return;
        var q = qInfo(ou, qi) || {}, s = dt(q.start), e = dt(q.end), now = Date.now();
        if (q.active === false || (e !== null && now > e) || (s !== null && s - now > AG_MS)) return;
        var gb = gateBtn(ou, qi), st = B.querySelector('[data-gst="' + qi + '"]');
        if (!gb || !st) return;
        AG_DONE[qi] = true;
        startGate(ou, qi, pw_of(qi), st).then(function () { showGateBtn(ou, qi); })
          .catch(function (er) { st.textContent = "auto gate failed: " + er.message.slice(0, 60) + " (click Start gate)"; st.style.color = "#990000"; showGateBtn(ou, qi); });
      });
    };
    // For the extension: when each protected quiz runs, so it can open its own Brightspace tab for the gate.
    if (EXT) tell({ lqz: "schedule", auto_gate: !!state.auto_gate, quizzes: (state.protect || []).map(function (p) {
      var q = qInfo(String(p.ou), String(p.qi)) || {}, c0 = courses.filter(function (x) { return String(x.ou) === String(p.ou); })[0];
      return { ou: String(p.ou), qi: String(p.qi), name: String(q.name || p.title || "").slice(0, 120), course: c0 ? cname(c0).slice(0, 120) : "", start: q.start || null, end: q.end || null, active: q.active !== false, gated: Number(p.gated) === 1 }; }) });
    if (state.auto_gate && !NOGATE) autoGate();
    var agTimer = state.auto_gate && !NOGATE && setInterval(function () { if (!(document.body.contains && document.body.contains(box))) { clearInterval(agTimer); return; } autoGate(); }, 60000);

    // ---- the dashboard's "Sync now" button ----
    // The dashboard link opens the dashboard as this tab's child (so it can talk to this tab); a dashboard
    // tab that opened this one can too. It may only ask "are you there?" and "sync now" -- nothing else.
    var dl = B.querySelector && B.querySelector("#lqz-dash");
    if (dl && W) dl.onclick = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); W.open(DASH, "lqzdash"); };
    if (W && W.addEventListener && !W.__lqzListen) {
      W.__lqzListen = true; W.__lqzSrc = SRC;
      var DASHES = [DASH_ORIGIN, "https://prof.lockqz.pages.dev", "https://lockqz.pages.dev"];
      W.addEventListener("message", function (e) {
        if (DASHES.indexOf(e.origin) < 0 || !e.data || typeof e.data !== "object" || !e.source) return;
        W.__lqzDash = e.source; W.__lqzDashOrigin = e.origin;
        if (e.data.lqz === "ping") { try { e.source.postMessage({ lqz: "hello" }, e.origin); } catch (x) {} return; }
        if (e.data.lqz !== "sync") return;
        var u = new URL(W.__lqzSrc); u.searchParams.delete("auto"); u.searchParams.set("force", "1"); u.searchParams.set("v", String(Date.now()));
        var sc = document.createElement("script"); sc.src = u.href; document.body.appendChild(sc);
      });
      setInterval(function () { tell({ lqz: "hello" }); }, 30000);   // in-browser only: costs nothing
    }
    tell({ lqz: "hello" });

    // ---- automatic re-sync while this panel stays open (hidden counts as open) ----
    // Every 15 min: a fresh copy of this script re-reads Brightspace (new quizzes, added/dropped students,
    // changed dates) and syncs only if something changed. Never while a gate runs, and never while the
    // professor is using the panel (2 min after their last click or key).
    var touched = Date.now();
    if (box.addEventListener) ["pointerdown", "keydown"].forEach(function (ev) { box.addEventListener(ev, function () { touched = Date.now(); }, true); });
    var again = setInterval(function () {
      if (!(document.body.contains && document.body.contains(box))) { clearInterval(again); return; }
      markGates();
      if (box.dataset.gates || Date.now() - touched < 120000) return;
      var u = new URL(SRC); u.searchParams.set("auto", "1"); u.searchParams.set("v", String(Date.now()));
      var s = document.createElement("script"); s.src = u.href; document.body.appendChild(s);
    }, AUTO_MS);
  } catch (e) {
    tell({ lqz: "failed", error: String(e && e.message || e).slice(0, 200) });
    say('<b style="color:#990000">' + esc(e.message) + "</b>");
  }
})();
