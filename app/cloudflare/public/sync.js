/* LOCKqz Sync - the Brightspace connector. Loaded by the teacher's "LOCKqz Sync" bookmark and
   run inside Brightspace on the teacher's OWN login (it can only see what they can see).
   1. reads every course where they are an instructor / TA: class list + quizzes
   2. saves them to LOCKqz
   3. writes each protected quiz's LOCKqz password into Brightspace (and removes released ones)
   4. shows a panel to choose which quizzes LOCKqz protects */
(async function () {
  if (document.getElementById("lqz-sync")) return;   // already open on screen
  var SRC = (document.currentScript && document.currentScript.src) || "";
  var KEY = SRC ? new URL(SRC).searchParams.get("k") : "";
  var API = SRC ? new URL(SRC).origin + "/api" : "";
  var DASH = SRC ? new URL(SRC).origin + "/dashboard" : "";

  var box = document.createElement("div");
  box.id = "lqz-sync";
  box.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:440px;max-height:85vh;overflow:auto;background:#fff;" +
    "border:2px solid #990000;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.3);font:14px -apple-system,Segoe UI,sans-serif;color:#111;text-align:left";
  box.innerHTML = '<div style="position:sticky;top:0;background:#990000;color:#fff;padding:10px 14px;font-weight:700;display:flex;justify-content:space-between">' +
    'LOCKqz Sync<span id="lqz-x" style="cursor:pointer;padding:0 4px">&#10005;</span></div><div id="lqz-b" style="padding:12px 14px">Starting...</div>';
  document.body.appendChild(box);
  var B = box.querySelector("#lqz-b");
  box.querySelector("#lqz-x").onclick = function () { box.remove(); };
  var say = function (h) { B.innerHTML = h; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var day = function (t) { return t ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" }) : ""; };

  try {
    if (!/\/d2l\//.test(location.pathname)) throw new Error("Open Brightspace first, then click LOCKqz Sync.");
    if (!KEY) throw new Error("This bookmark has no LOCKqz key. Drag a fresh one from your LOCKqz dashboard.");

    var get = async function (u) {
      var r = await fetch(u, { credentials: "include" });
      if (!r.ok) throw new Error("Brightspace answered " + r.status + " for " + u.split("?")[0]);
      return r.json();
    };
    var csrf = localStorage.getItem("XSRF.Token") || "";
    var put = function (u, b) {
      return fetch(u, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json", "X-Csrf-Token": csrf }, body: JSON.stringify(b) });
    };
    var lq = async function (path, body) {
      var r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Sync": KEY }, body: JSON.stringify(body || {}) });
      var d = await r.json().catch(function () { return { error: "LOCKqz answered " + r.status }; });
      if (r.status === 401) throw new Error("This LOCKqz Sync bookmark is no longer valid. Drag a fresh one from your dashboard.");
      if (d.error) throw new Error(d.error);
      return d;
    };
    var lqget = async function (path) {
      var r = await fetch(API + path, { headers: { "X-LOCKqz-Sync": KEY } });
      return r.json().catch(function () { return {}; });
    };
    // Brightspace special-access helpers (one user at a time). PUT grants/keeps, DELETE removes.
    var saUrl = function (ou, qi, uid) { return "/d2l/api/le/" + LE + "/" + ou + "/quizzes/" + qi + "/specialaccess/" + uid; };
    var saList = async function (ou, qi) { return get("/d2l/api/le/" + LE + "/" + ou + "/quizzes/" + qi + "/specialaccess/").catch(function () { return []; }); };
    var saPut = function (ou, qi, uid, endIso) { return put(saUrl(ou, qi, uid), { StartDate: null, EndDate: endIso, DueDate: null, SubmissionTimeLimit: null, AttemptsAllowed: null }); };
    var saDel = function (ou, qi, uid) { return fetch(saUrl(ou, qi, uid), { method: "DELETE", credentials: "include", headers: { "X-Csrf-Token": csrf } }); };

    // ---- 1. read Brightspace ----
    say("Reading your Brightspace courses...");
    var vers = await get("/d2l/api/versions/");
    var ver = function (c) { var v = vers.filter(function (x) { return x.ProductCode === c; })[0]; return v ? v.LatestVersion : null; };
    var LE = ver("le"), LP = ver("lp");
    var me = await get("/d2l/api/lp/" + LP + "/users/whoami");
    var items = [], bm = "";
    do {
      var d = await get("/d2l/api/lp/" + LP + "/enrollments/myenrollments/?orgUnitTypeId=3" + (bm ? "&bookmark=" + encodeURIComponent(bm) : ""));
      items = items.concat(d.Items || []);
      bm = d.PagingInfo && d.PagingInfo.HasMoreItems ? d.PagingInfo.Bookmark : "";
    } while (bm);
    var STAFF = /instructor|teach|professor|faculty|\bta\b|assistant|grader|designer/i;
    var staff = items.filter(function (i) { return i.Access && i.Access.IsActive !== false && STAFF.test(i.Access.ClasslistRoleName || ""); });
    if (!staff.length) throw new Error("You are not an instructor or TA in any active Brightspace course.");

    var courses = [];
    for (var n = 0; n < staff.length; n++) {
      var ou = staff[n].OrgUnit.Id;
      say("Reading course " + (n + 1) + " of " + staff.length + "<br><b>" + esc(staff[n].OrgUnit.Name) + "</b>");
      var cl = await get("/d2l/api/le/" + LE + "/" + ou + "/classlist/").catch(function () { return null; });
      var qs = [], next = "/d2l/api/le/" + LE + "/" + ou + "/quizzes/";
      while (next) { var q = await get(next).catch(function () { return null; }); if (!q) break; qs = qs.concat(q.Objects || []); next = q.Next || null; }
      courses.push({
        ou: ou, name: staff[n].OrgUnit.Name, code: staff[n].OrgUnit.Code, role: staff[n].Access.ClasslistRoleName,
        classlist: cl ? cl.map(function (s) { return { id: s.Identifier, name: s.DisplayName || ((s.FirstName || "") + " " + (s.LastName || "")).trim(),
          email: s.Email, username: s.Username, org_id: s.OrgDefinedId, role: s.ClasslistRoleDisplayName }; }) : null,
        quizzes: qs.map(function (x) { return { qi: x.QuizId, name: x.Name, active: x.IsActive, start: x.StartDate, end: x.EndDate, due: x.DueDate, has_password: !!x.Password }; })
      });
    }

    // ---- 2. save to LOCKqz ----
    say("Saving to LOCKqz...");
    var state = await lq("/sync", { whoami: { id: me.Identifier, name: ((me.FirstName || "") + " " + (me.LastName || "")).trim() }, courses: courses });

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
    }
    async function protect(ou, qi, pw) {          // put LOCKqz's password on the quiz
      var cur = await get(quizUrl(ou, qi));
      if (cur.Password === pw) return "already";
      await writePw(ou, qi, pw); return "set";
    }
    async function release(ou, qi, oldPw) {      // remove ONLY our password (never a teacher's own)
      var cur = await get(quizUrl(ou, qi));
      if (cur.Password === oldPw) await writePw(ou, qi, null);
      return "cleared";
    }
    var results = [], errors = [];
    var todo = (state.protect || []).length + (state.clear || []).length, done = 0;
    for (var i = 0; i < (state.protect || []).length; i++) {
      var x = state.protect[i]; say("Setting LOCKqz passwords in Brightspace... " + (++done) + "/" + todo);
      try { results.push({ ou: x.ou, qi: x.qi, status: await protect(x.ou, x.qi, x.password) }); }
      catch (e) { results.push({ ou: x.ou, qi: x.qi, status: "error", msg: e.message }); errors.push((x.title || x.qi) + ": " + e.message); }
    }
    for (var k = 0; k < (state.clear || []).length; k++) {
      var y = state.clear[k]; say("Removing released passwords... " + (++done) + "/" + todo);
      try { results.push({ ou: y.ou, qi: y.qi, status: await release(y.ou, y.qi, y.password) }); }
      catch (e) { results.push({ ou: y.ou, qi: y.qi, status: "error", msg: e.message }); errors.push(y.qi + ": " + e.message); }
    }
    if (results.length) await lq("/sync-result", { results: results });

    // ---- 4. panel: choose protected quizzes ----
    var prot = {}; (state.protect || []).forEach(function (p) { prot[String(p.qi)] = true; });
    var students = 0, nq = 0;
    var html = "";
    courses.forEach(function (c) {
      var learners = (c.classlist || []).filter(function (s) { return /learner|student/i.test(s.role || ""); }).length;
      students += learners; nq += c.quizzes.length;
      html += '<div style="margin:12px 0 4px;font-weight:700">' + esc(c.name.replace(/^\d+_\d+\s*/, "")) + '</div>' +
        '<div style="color:#666;font-size:12px;margin-bottom:4px">' + learners + " students &middot; " + esc(c.role) + "</div>";
      if (!c.quizzes.length) html += '<div style="color:#888;font-size:13px">No quizzes.</div>';
      c.quizzes.forEach(function (q) {
        var on = !!prot[String(q.qi)];
        html += '<div style="padding:4px 0;border-bottom:1px solid #eee">' +
          '<label style="display:flex;gap:8px;align-items:center;cursor:pointer">' +
          '<input type="checkbox" data-ou="' + c.ou + '" data-qi="' + q.qi + '"' + (on ? " checked" : "") + '>' +
          '<span style="flex:1">' + esc(q.name) + (q.start ? ' <span style="color:#888;font-size:12px">' + day(q.start) + "</span>" : "") + "</span>" +
          '<span data-st="' + q.qi + '" style="font-size:12px;color:' + (on ? "#1a7f37" : "#888") + '">' + (on ? "protected" : "") + "</span></label>" +
          '<div style="margin:4px 0 0 26px;font-size:12px"><button data-gate="' + c.ou + ":" + q.qi + '" ' + (on ? "" : "disabled ") + 'style="font:12px -apple-system;padding:2px 10px;border:1px solid #990000;border-radius:6px;background:#fff;color:#990000;cursor:pointer">Start gate</button> <span data-gst="' + q.qi + '" style="color:#888">off</span> <span style="color:#aaa">— while on, only students LOCKqz is locking can open the quiz</span></div></div>';
      });
    });
    say('<div style="background:#eafbea;padding:8px 10px;border-radius:8px">Synced ' + courses.length + " course" + (courses.length === 1 ? "" : "s") +
      ", " + students + " students, " + nq + " quizzes.</div>" +
      (errors.length ? '<div style="color:#990000;margin-top:8px">Could not update: ' + esc(errors.join("; ")) + "</div>" : "") +
      '<div style="margin-top:10px;font-weight:700">Protect with LOCKqz (blocks AI during the quiz):</div>' + html +
      '<div style="margin-top:12px"><a href="' + DASH + '" target="_blank" style="color:#990000;font-weight:700">Open LOCKqz dashboard</a></div>');

    // ---- live access gate: only students LOCKqz is actively locking can see the quiz ----
    // Teacher clicks Start and leaves this tab open. Every 10s we read who is locked (device-signed,
    // fresh) from LOCKqz and grant Brightspace special access to exactly them; anyone who stops being
    // locked (killed/uninstalled/tampered/left) is removed within ~10s, and if this tab closes every
    // grant lapses on its own because each carries a 90s rolling EndDate.
    var GATES = {};   // qi -> { ou, timer, busy }
    async function gateStep(ou, qi) {
      var end = new Date(Date.now() + 90000).toISOString();
      var live = await lqget("/live?quiz=" + ou + "-" + qi);
      var want = {}; (live.rows || []).forEach(function (r) { if (r.eligible && r.user_id) want[String(r.user_id)] = true; });
      var have = await saList(ou, qi); var haveSet = {};
      (Array.isArray(have) ? have : []).forEach(function (x) { if (x && x.UserId != null) haveSet[String(x.UserId)] = true; });
      for (var uid in want) { try { await saPut(ou, qi, uid, end); } catch (e) {} }          // grant / refresh EndDate
      for (var u2 in haveSet) { if (!want[u2]) { try { await saDel(ou, qi, u2); } catch (e) {} } } // revoke those no longer locked
      return Object.keys(want).length;
    }
    async function startGate(ou, qi, pw, st) {
      st.textContent = "starting..."; st.style.color = "#666";
      await writePw(ou, qi, pw, { AllowOnlyUsersWithSpecialAccess: true });   // hide quiz from everyone
      await lq("/gate", { ou: ou, qi: qi, on: true });
      var tick = async function () {
        if (GATES[qi].busy) return; GATES[qi].busy = true;
        try { var n = await gateStep(ou, qi); st.textContent = "LIVE — " + n + " locked in"; st.style.color = "#1a7f37"; }
        catch (e) { st.textContent = "gate error: " + e.message.slice(0, 50); st.style.color = "#990000"; }
        GATES[qi].busy = false;
      };
      GATES[qi] = { ou: ou, busy: false, timer: setInterval(tick, 10000) };
      tick();
    }
    async function stopGate(ou, qi, st) {
      if (GATES[qi]) { clearInterval(GATES[qi].timer); delete GATES[qi]; }
      st.textContent = "stopping..."; st.style.color = "#666";
      try {
        var have = await saList(ou, qi);
        for (var i = 0; i < (have || []).length; i++) { try { await saDel(ou, qi, have[i].UserId); } catch (e) {} }
        await writePw(ou, qi, pw_of(qi), { AllowOnlyUsersWithSpecialAccess: false });   // quiz open again (password still applies)
      } catch (e) {}
      await lq("/gate", { ou: ou, qi: qi, on: false });
      st.textContent = "off"; st.style.color = "#888";
    }
    var PW = {};   // qi -> current LOCKqz password, filled when protected
    (state.protect || []).forEach(function (p) { PW[String(p.qi)] = p.password; });
    function pw_of(qi) { return PW[String(qi)]; }

    B.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.onchange = async function () {
        var ou = cb.dataset.ou, qi = cb.dataset.qi, st = B.querySelector('[data-st="' + qi + '"]');
        cb.disabled = true; st.style.color = "#666"; st.textContent = "saving...";
        try {
          var r = await lq("/protect", { ou: ou, qi: qi, on: cb.checked });
          var status = cb.checked ? await protect(ou, qi, r.password) : (r.clear ? await release(ou, qi, r.clear) : "cleared");
          await lq("/sync-result", { results: [{ ou: ou, qi: qi, status: status }] });
          st.style.color = cb.checked ? "#1a7f37" : "#888"; st.textContent = cb.checked ? "protected" : "";
        } catch (e) {
          cb.checked = !cb.checked; st.style.color = "#990000"; st.textContent = e.message.slice(0, 60);
        }
        var gb = B.querySelector('[data-gate="' + cb.dataset.ou + ":" + cb.dataset.qi + '"]');
        if (gb) gb.disabled = !cb.checked;
        cb.disabled = false;
      };
    });
    B.querySelectorAll("button[data-gate]").forEach(function (gb) {
      var parts = gb.dataset.gate.split(":"), ou = parts[0], qi = parts[1];
      var st = B.querySelector('[data-gst="' + qi + '"]');
      gb.onclick = async function () {
        gb.disabled = true;
        if (!GATES[qi]) { await startGate(ou, qi, pw_of(qi), st); gb.textContent = "Stop gate"; }
        else { await stopGate(ou, qi, st); gb.textContent = "Start gate"; }
        gb.disabled = false;
      };
    });
  } catch (e) {
    say('<b style="color:#990000">' + esc(e.message) + "</b>");
  }
})();
