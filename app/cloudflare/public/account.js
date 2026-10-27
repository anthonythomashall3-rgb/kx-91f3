/* LOCKqz download page: gear icon (top right) -> Account + Settings.
   Account: sign in with an emailed 6-digit code (token kept in this browser for 30 days), then this
   semester's payment, subscription (cancel auto-renew / turn back on), your computers (view only), sign out.
   Settings: email me my receipts, privacy policy, contact support.
   Everything here is separate from the install steps: if this file fails, the page still installs. */
(function () {
  "use strict";
  var wrap = document.getElementById("lqgear"), btn = document.getElementById("lqgearbtn"), menu = document.getElementById("lqmenu"), acc = document.getElementById("lqm-acc");
  if (!wrap || !btn || !menu || !acc) return;
  var API = /\.pages\.dev$/.test(location.hostname) ? "https://lockqz.pages.dev/api" : "/api";
  var KEY = "lqz_acct", state = { step: "out", email: "", busy: false, data: null, confirm: null, msg: "" };

  // ---- the saved sign-in (this browser only; every access wrapped: private windows / blocked storage) ----
  // mem: the same sign-in for this tab when the browser refuses storage.
  var mem = null;
  function saved() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { v = null; }
    v = v || mem;
    if (v && v.token && v.email && Number(v.exp) > Date.now()) return v;
    if (v) forget();
    return null;
  }
  function save(v) { mem = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function forget() { mem = null; try { localStorage.removeItem(KEY); } catch (e) {} }

  function api(body) {
    return fetch(API + "/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { d = d || {}; d._status = r.status; return d; }); },
            function () { return { error: "network", message: "No connection. Try again.", _status: 0 }; });
  }
  // A small element builder (text always as text, never as HTML).
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in (attrs || {})) {
      var v = attrs[k]; if (v == null || v === false) continue;
      if (k === "text") n.textContent = v; else if (k === "on") { for (var ev in v) n.addEventListener(ev, v[ev]); } else n.setAttribute(k, v === true ? "" : v);
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function day(d) { if (!d) return ""; var x = new Date(String(d).slice(0, 10) + "T12:00:00Z"); return isNaN(x) ? "" : x.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); }
  function money(n) { n = Number(n) || 0; return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function cap(s) { s = String(s || "card"); return s.charAt(0).toUpperCase() + s.slice(1); }
  function msgEl() { return state.msg ? el("p", { "class": "lqm-msg", role: "status", text: state.msg }) : null; }

  // ---- open / close ----
  function isOpen() { return !menu.hidden; }
  function open() { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); render(); var f = menu.querySelector("input,button,a"); if (f) f.focus(); }
  function close(back) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); state.confirm = null; if (back) btn.focus(); }
  btn.addEventListener("click", function () { isOpen() ? close(false) : open(); });
  document.addEventListener("keydown", function (e) { if ((e.key === "Escape" || e.key === "Esc") && isOpen()) { e.preventDefault(); close(true); } });
  // A click outside closes it (a button the menu just redrew away is no longer in the page: not "outside").
  document.addEventListener("click", function (e) { if (isOpen() && e.target && e.target.isConnected !== false && !wrap.contains(e.target)) close(false); });

  // ---- Account ----
  function render() {
    acc.innerHTML = "";
    var s = saved();
    if (s && state.step !== "in") { state.step = "in"; state.email = s.email; }
    if (!s && state.step === "in") { state.step = "out"; state.data = null; }
    if (state.step === "out") {
      acc.appendChild(el("button", { type: "button", "class": "lqm-btn lqm-prime", text: "Sign in", on: { click: function () { state.step = "email"; state.msg = ""; render(); focusIn(); } } }));
      if (state.msg) acc.appendChild(msgEl());
    } else if (state.step === "email") {
      var f = el("form", { "class": "lqm-form", novalidate: true }, [
        el("label", { "for": "lqm-em", text: "School email" }),
        el("input", { id: "lqm-em", type: "email", autocomplete: "email", inputmode: "email", placeholder: "you@usc.edu", value: state.email || "", required: true }),
        el("button", { type: "submit", "class": "lqm-btn lqm-prime", text: state.busy ? "Sending…" : "Email me a code", disabled: state.busy }), msgEl()]);
      f.addEventListener("submit", function (e) { e.preventDefault(); sendCode(f.querySelector("input").value); });
      acc.appendChild(f);
    } else if (state.step === "code") {
      var g = el("form", { "class": "lqm-form", novalidate: true }, [
        el("p", { "class": "lqm-small", text: "We emailed a 6-digit code to " + state.email + "." }),
        el("label", { "for": "lqm-code", text: "Code" }),
        el("input", { id: "lqm-code", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]*", required: true }),
        el("button", { type: "submit", "class": "lqm-btn lqm-prime", text: state.busy ? "Checking…" : "Sign in", disabled: state.busy }), msgEl(),
        el("div", { "class": "lqm-links" }, [
          el("button", { type: "button", "class": "lqm-link", text: "Send a new code", on: { click: function () { sendCode(state.email); } } }),
          el("button", { type: "button", "class": "lqm-link", text: "Use another email", on: { click: function () { state.step = "email"; state.msg = ""; render(); focusIn(); } } })])]);
      g.addEventListener("submit", function (e) { e.preventDefault(); signIn(g.querySelector("input").value); });
      acc.appendChild(g);
    } else {
      acc.appendChild(el("p", { "class": "lqm-email", text: state.email }));
      if (!state.data) { acc.appendChild(el("p", { "class": "lqm-small", role: "status", text: state.msg || "Loading…" })); if (!state.busy && !state.msg) load(); }
      else signedIn(state.data);
      acc.appendChild(el("button", { type: "button", "class": "lqm-btn", text: "Sign out", on: { click: function () { forget(); state = { step: "out", email: "", busy: false, data: null, confirm: null, msg: "" }; render(); focusIn(); } } }));
    }
  }
  function focusIn() { var f = acc.querySelector("input") || acc.querySelector("button"); if (f) f.focus(); }
  function sendCode(email) {
    email = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { state.msg = "Enter your school email."; state.step = "email"; render(); focusIn(); return; }
    state.email = email; state.busy = true; state.msg = ""; render();
    api({ op: "send", email: email }).then(function (d) {
      state.busy = false;
      if (d.sent) { state.step = "code"; state.msg = ""; }
      else state.msg = d.error === "too_many_codes" ? "Too many codes for now. Try again in an hour." : d.error === "mail_busy" ? "Email is busy right now. Try again later." : (d.message || "Could not send the code. Try again.");
      render(); focusIn();
    });
  }
  function signIn(code) {
    code = String(code || "").replace(/\D/g, "");
    if (code.length !== 6) { state.msg = "Enter the 6-digit code."; render(); focusIn(); return; }
    state.busy = true; state.msg = ""; render();
    api({ op: "code", email: state.email, code: code }).then(function (d) {
      state.busy = false;
      if (d.token) { save({ token: d.token, email: d.email, exp: Date.now() + (Number(d.days) || 30) * 86400000 }); state.step = "in"; state.data = null; state.msg = ""; render(); focusIn(); return; }
      state.msg = d.error === "wrong_code" ? "Wrong code." + (d.tries_left ? " " + d.tries_left + " tries left." : "") : (d.message || "Try again.");
      render(); focusIn();
    });
  }
  function authed(body) { var s = saved(); if (!s) { state.step = "out"; render(); return Promise.resolve({ error: "signed_out" }); } body.token = s.token; return api(body).then(function (d) { if (d._status === 401) { forget(); state = { step: "out", email: "", busy: false, data: null, confirm: null, msg: "Signed out. Sign in again." }; render(); } return d; }); }
  function load() {
    state.busy = true;
    authed({ op: "status" }).then(function (d) { state.busy = false; if (d.error) { if (d._status !== 401) { state.msg = d.message || "Could not load your account."; render(); } return; } state.data = d; state.msg = ""; render(); });
  }
  function row(label, kids) { return el("div", { "class": "lqm-row2" }, [el("span", { "class": "lqm-k", text: label })].concat(kids)); }
  function signedIn(d) {
    if (d.required === false) acc.appendChild(row("This semester", [el("b", { "class": "lqm-ok", text: "No payment needed" })]));
    else if (d.paid) acc.appendChild(row(d.term || "This semester", [el("b", { "class": "lqm-ok", text: "Paid ✓" }), d.until ? el("span", { "class": "lqm-small", text: " until " + day(d.until) }) : null]));
    else acc.appendChild(row(d.term || "This semester", [el("b", { "class": "lqm-bad", text: "Not paid" }), " ", d.pay_url ? el("a", { "class": "lqm-pay", href: d.pay_url, text: "Pay" }) : null]));
    // Auto-renew
    var r = d.renew, box = el("div", { "class": "lqm-block" });
    if (r && r.on) {
      box.appendChild(row("Auto-renew", [el("b", { text: "On" }), el("span", { "class": "lqm-small", text: " · " + cap(r.brand) + " •••• " + (r.last4 || "") })]));
      box.appendChild(el("p", { "class": "lqm-small", text: "Next: " + money(r.amount) + " on " + day(r.next_day) + " for " + r.next_term + "." }));
      if (r.failed) box.appendChild(el("p", { "class": "lqm-warn" }, ["Last renewal didn’t go through: " + r.failed + ". ", d.pay_url ? el("a", { href: d.pay_url, text: "Pay here" }) : null]));
      if (state.confirm === "renew") {
        box.appendChild(el("div", { "class": "lqm-confirm", role: "alertdialog", "aria-labelledby": "lqm-cq" }, [
          el("p", { id: "lqm-cq", text: "Cancel your subscription? Your card is never charged again." }),
          el("div", { "class": "lqm-links" }, [
            el("button", { type: "button", "class": "lqm-btn lqm-red", text: "Yes, cancel subscription", on: { click: function () { setRenew(false); } } }),
            el("button", { type: "button", "class": "lqm-btn", text: "Keep it", on: { click: function () { state.confirm = null; render(); var b = acc.querySelector(".lqm-red"); if (b) b.focus(); } } })])]));
      } else box.appendChild(el("button", { type: "button", "class": "lqm-btn lqm-red", text: "Cancel subscription", on: { click: function () { state.confirm = "renew"; render(); var b = acc.querySelector(".lqm-confirm .lqm-red"); if (b) b.focus(); } } }));
    } else if (r) {
      box.appendChild(row("Auto-renew", [el("b", { text: "Off" }), el("span", { "class": "lqm-small", text: " · " + cap(r.brand) + " •••• " + (r.last4 || "") })]));
      box.appendChild(el("button", { type: "button", "class": "lqm-btn", text: "Turn auto-renew on", on: { click: function () { setRenew(true); } } }));
    } else box.appendChild(row("Auto-renew", [el("b", { text: "Off" })]));
    acc.appendChild(box);
    // Your computers
    var devs = d.devices || [], list = el("ul", { "class": "lqm-devs" });
    devs.forEach(function (x) {
      list.appendChild(el("li", null, [el("span", { "class": "lqm-dn" }, [el("b", { text: x.os || "Computer" }),
        el("span", { "class": "lqm-small", text: (x.version ? " · LOCKqz " + x.version : "") + (x.last_seen ? " · last seen " + day(x.last_seen) : "") })])]));
    });
    acc.appendChild(el("div", { "class": "lqm-block" }, [el("p", { "class": "lqm-k", text: "Your computers" }),
      devs.length ? list : el("p", { "class": "lqm-small", text: "None yet. Install LOCKqz below." }),
      devs.length ? el("p", { "class": "lqm-small", text: "To free a computer, email lockqz.app@gmail.com." }) : null]));
    if (state.msg) acc.appendChild(msgEl());
  }
  function setRenew(on) {
    state.msg = ""; state.confirm = null;
    authed({ op: "renew", on: on }).then(function (d) {
      if (d.ok) { state.msg = on ? "Subscription on: your card renews each semester." : "Subscription cancelled. Your card is never charged again; this semester stays active."; return authed({ op: "status" }).then(function (s) { if (!s.error) state.data = s; render(); }); }
      if (d._status !== 401) { state.msg = d.message || "Try again."; render(); }
    });
  }

  // ---- Settings ----
  var rc = document.getElementById("lqm-rcpt"), rcm = document.getElementById("lqm-rcpt-msg");
  if (rc) rc.addEventListener("click", function () {
    if (!saved()) { rcm.textContent = "Sign in first (Account above)."; if (state.step === "out") { state.step = "email"; render(); } focusIn(); return; }
    rc.disabled = true; rcm.textContent = "Sending…";
    authed({ op: "receipts" }).then(function (d) {
      rc.disabled = false;
      rcm.textContent = d.sent ? (d.again ? "Already sent to " + d.to + " in the last 10 minutes." : "Sent to " + d.to + ".") : d._status === 401 ? "Sign in first (Account above)." : (d.message || "Try again.");
    });
  });
})();
