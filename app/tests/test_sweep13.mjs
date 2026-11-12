// Bug sweep 13 (11 Nov 2026), real API on in-memory SQLite:
//   E1 an email's subject is always one line (an exam or class name with line breaks cannot add a header line),
//      and no email shows raw HTML from a name.
//   E2 a class-list email with spaces around it is stored trimmed, so the student is found by his email.
//   E3 no LOCKqz page may be shown inside another site's frame (_headers).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-sweep13-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const RealDate = Date; let fakeNow = RealDate.parse("2026-11-12T18:00:00Z");
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }
globalThis.Date = FakeDate;
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort())
  for (const st of readFileSync(join(CF, m), "utf8").replace(/^\s*--.*$/gm, "").split(";")) { try { if (st.trim()) sqlite.exec(st); } catch {} }
const db = { prepare(sql) { const st = sqlite.prepare(sql); let args = [];
  const o = { bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); return o; },
    first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }), run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }), _run() { st.run(...args); } }; return o; },
  async batch(sts) { for (const s of sts) s._run(); } };
const MAILS = [];
const env = { DB: db, TEACHER_KEY: "admin-key", REQUIRE_SIGNED: "1", ROT_SECRET: "rs", LIVE_CACHE_MS: "0", PAID_CACHE_MS: "0", PAY_SECRET: "paysecret-0123456789", ADMIN_EMAIL: "admin@usc.edu", MAIL_SINK: async m => { MAILS.push(m); return true; },
  PROF_TOTAL: "6500", PROF_CARD_TOTAL: "6500", PROF_ZELLE_TOTAL: "6300", PROF_BANK_TOTAL: "6500", PROF_OTHER_PRICE: "5000", ZELLE_TO: "(858) 900-4347", REQUIRE_GATE: "1" };
let ip = 0;
async function api(path, body, { teacher, pay, get } = {}) { const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.13." + ((++ip >> 8) & 255) + "." + (ip & 255) };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher; if (pay) h["X-LOCKqz-Pay"] = env.PAY_SECRET;
  const res = await onRequest({ request: new Request("https://lockqz.pages.dev/api" + path, { method: get ? "GET" : "POST", headers: h, body: get ? undefined : JSON.stringify(body ?? {}) }), env, waitUntil: () => {} });
  return { status: res.status, data: await res.json().catch(() => null) }; }

const EVIL = '<img src=x onerror=alert(1)>"\'><script>alert(2)</script>', NL = "Final\r\nBcc: evil@evil.example\r\n\r\n<b>x</b>";
const ADMIN = (await api("/signup", { email: "admin@usc.edu", password: "adminpass1", name: "A H" })).data.token;
const roster = [{ id: "8001", name: "Pat " + EVIL, email: "p@usc.edu", role: "Instructor" }, { id: "9100", name: "Stu " + EVIL, email: "  Stu.Zero@USC.edu ", role: "Student" },
  ...Array.from({ length: 5 }, (_, i) => ({ id: String(9101 + i), name: "Stu " + i, email: `s${i}@usc.edu`, role: "Student" }))];
await api("/sync", { courses: [{ ou: "500", name: "20263_14792 ECON 203: " + EVIL, classlist: roster, quizzes: [] }] }, { teacher: ADMIN });
const inv = (await api("/invite", { email: "p@usc.edu" }, { teacher: ADMIN })).data.code;
const H = { teacher: (await api("/signup", { email: "p@usc.edu", password: "profpass12", name: "Pat " + NL + EVIL, invite: inv })).data.token };
const soon = h => new RealDate(fakeNow + h * 3600000).toISOString();
const Q = [{ qi: "1", name: NL + EVIL, active: true, start: soon(50), end: soon(52) }, { qi: "2", name: "Quiz " + EVIL, active: true, start: soon(2.5), end: soon(4) }];
const sync = () => api("/sync", { whoami: { id: "8001" }, courses: [{ ou: "500", name: "20263_14792 ECON 203: " + NL + EVIL, classlist: roster, quizzes: Q }] }, H);
await sync();
const memo = (await api("/my-sections", undefined, { ...H, get: true })).data.memo;
await api("/pay/notify", { payments: [{ txn: "pz1", amount: 6300, payer: "Pat " + EVIL, note: memo, via: "zelle" }] }, { pay: true });
const r = await sync(); await api("/sync-result", { results: (r.data.protect || []).map(p => ({ ou: "500", qi: p.qi, status: "set" })) }, H);
for (let i = 0; i < 60; i++) { fakeNow += 3600000; await api("/pay/tick", {}, { pay: true }); await api("/cron", {}, { pay: true }); if (i % 6 === 0) await sync(); }
await api("/support", { email: "s0@usc.edu", message: "help " + EVIL + NL, name: NL + EVIL }, {});
const named = MAILS.filter(m => /Final/.test(m.subject));
check("E1 emails about the exam were sent (reminders to the class and the professor)", named.length >= 2 && MAILS.length >= 6, MAILS.length + " mails, " + named.length + " with the exam name");
check("E1 every subject, Reply-To and recipient is one line", MAILS.every(m => !/[\r\n]/.test([m.subject, m.replyTo || "", ...[].concat(m.to)].join("|"))), JSON.stringify(MAILS.find(m => /[\r\n]/.test(m.subject))?.subject || "").slice(0, 120));
check("E1 the exam's name is still in the subject, on one line", named.every(m => m.subject.includes("Final Bcc: evil@evil.example <b>x</b>")), named[0]?.subject.slice(0, 120));
check("E1 no email shows raw HTML from a name (exam, class, professor, student, support message)", MAILS.every(m => !m.html || !/<img src=x|<script>alert|<b>x<\/b>/.test(m.html)));
check("E1 no email says undefined / null / NaN", MAILS.every(m => !/undefined|\bnull\b|NaN|\[object/.test(m.text + m.subject)));

const em = sqlite.prepare("SELECT email FROM roster WHERE user_id='9100'").get()?.email;
check("E2 a class-list email with spaces and capitals is stored trimmed and lower-case", em === "stu.zero@usc.edu", JSON.stringify(em));

// E4: Forget removes everything stored for an email, an unused invitation included
await api("/invite", { email: "gone@usc.edu" }, { teacher: ADMIN });
const before = sqlite.prepare("SELECT COUNT(*) n FROM invites WHERE email='gone@usc.edu'").get().n;
const fg = await api("/forget", { email: "gone@usc.edu" }, { teacher: ADMIN });
check("E4 Forget also removes an unused invitation sent to that email", before === 1 && fg.status === 200 && sqlite.prepare("SELECT COUNT(*) n FROM invites WHERE email='gone@usc.edu'").get().n === 0, before + " " + fg.status + " " + JSON.stringify(fg.data));

const hd = readFileSync(join(CF, "public", "_headers"), "utf8");
check("E3 every page forbids being framed by another site", /^\/\*\n  X-Frame-Options: DENY\n  Content-Security-Policy: frame-ancestors 'none'\n/m.test(hd) && hd.includes("/download/lockqz-prof-firefox.xpi\n  Content-Type: application/x-xpinstall"));
const pages = readdirSync(join(CF, "public")).filter(f => /\.(html|js)$/.test(f)).map(f => readFileSync(join(CF, "public", f), "utf8")).join("\n");
check("E3 no LOCKqz page frames another LOCKqz page", !/<iframe|createElement\(["']iframe/i.test(pages));

globalThis.Date = RealDate;
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
