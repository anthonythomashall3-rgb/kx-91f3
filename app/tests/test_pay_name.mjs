import { withPayT } from "./pay_t.mjs";
// A Zelle or Venmo with no memo (PAY_NAME_MATCH): the payer's name counts for a student only when it is
// exactly the student price and the name is the Brightspace name of exactly one student who has a pay code
// and has paid nothing this term. Real API, in-memory SQLite.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-payname-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
function d1(sqlite) {
  const mk = () => { let args = []; let st = null;
    return { _sql(sql) { st = sqlite.prepare(sql); return this; },
      bind(...a) { args = a.map(x => x === undefined ? null : typeof x === "boolean" ? Number(x) : x); this._run = () => st.run(...args); return this; },
      first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }),
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }) }; };
  return { prepare(sql) { return mk()._sql(sql); }, async batch(sts) { for (const s of sts) s._run(); } };
}
const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
const BASE = "https://lockqz.test", SECRET = "test-pay-secret-0123456789";
// The live settings: tax on, students $200 by Zelle and $210 by Venmo.
const ON = { DB: d1(sqlite), TEACHER_KEY: "admin-test-key", REQUIRE_SIGNED: "1", ZELLE_TO: "(858) 900-4347", STUDENT_VENMO: "1", VENMO_TO: "LOCKqz", STUDENT_FEE: "180", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: SECRET,
  TAX_RATE: "0.25", TAX_FROM: "2000-01-01T00:00:00Z", STUDENT_TOTAL: "200", STUDENT_OTHER_TOTAL: "210", PAY_NAME_MATCH: "1" };
const OFF = { ...ON, PAY_NAME_MATCH: "0" };
const call = async (env, path, body) => { const res = await onRequest({ request: new Request(BASE + "/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(withPayT(path, body, env) ?? {}) }), env }); let data = null; try { data = await res.json(); } catch {} return { status: res.status, data }; };
const notify = (env, payments) => onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": SECRET }, body: JSON.stringify({ payments }) }), env }).then(r => r.json());
const paid = async email => (await call(ON, "/pay/start", { email })).data.paid === true;
const roster = (email, name, ou = "500") => sqlite.prepare("INSERT OR REPLACE INTO roster (ou,user_id,name,email,role,synced_at) VALUES (?,?,?,?,?,?)").run(ou, email, name, email, "Learner", new Date().toISOString());
const students = { "maria@usc.edu": "Maria Garcia Lopez", "john@usc.edu": "Smith, John", "john2@usc.edu": "John Smith", "wei@usc.edu": "Wei Chen", "priya@usc.edu": "Priya Natarajan", "sam@usc.edu": "Samuel O'Neil-Diaz", "nocode@usc.edu": "Noah Code" };
for (const [e, n] of Object.entries(students)) roster(e, n);
const codes = {};
for (const e of Object.keys(students)) if (e !== "nocode@usc.edu") codes[e] = (await call(ON, "/pay/start", { email: e })).data.code;
check("setup: each student has a pay code and is unpaid", Object.values(codes).every(c => /^LQS[A-Z0-9]{5}$/.test(c)) && !(await paid("maria@usc.edu")), JSON.stringify(codes));
let n, tx = 0; const z = (payer, amount = 200, extra = {}) => ({ txn: "zelle:t" + (++tx), amount, note: "", via: "zelle", payer, ...extra });

console.log("N1 off: a payment with no memo is never guessed");
n = await notify(OFF, [z("MARIA GARCIA LOPEZ")]);
check("PAY_NAME_MATCH off: not matched", n.results?.[0]?.matched === null && !(await paid("maria@usc.edu")), JSON.stringify(n));

console.log("N2 on: the payer's name is one unpaid student's Brightspace name");
n = await notify(ON, [z("MARIA GARCIA LOPEZ")]);
check("exact name, exact price: that student is paid", n.results?.[0]?.matched === "student" && n.results[0].email === "maria@usc.edu" && n.results[0].paid === true && await paid("maria@usc.edu"), JSON.stringify(n));
check("Admin sees how it was matched", /\[name match: MARIA GARCIA LOPEZ\]/.test(String(sqlite.prepare("SELECT note FROM payments WHERE code=?").get(codes["maria@usc.edu"])?.note)));
n = await notify(ON, [z("Wei X Chen")]);
check("a middle name on the bank's side still matches", n.results?.[0]?.email === "wei@usc.edu" && await paid("wei@usc.edu"), JSON.stringify(n));
n = await notify(ON, [z("SAMUEL ONEIL-DIAZ")]);
check("a name the bank spells differently is not guessed", n.results?.[0]?.matched === null && !(await paid("sam@usc.edu")), JSON.stringify(n));
n = await notify(ON, [z("Samuel O'Neil-Diaz")]);
check("apostrophes and hyphens as in Brightspace: matched", n.results?.[0]?.email === "sam@usc.edu", JSON.stringify(n));

console.log("N3 never guessed");
n = await notify(ON, [z("John Smith")]);
check("two unpaid students with that name: waits for the admin", n.results?.[0]?.matched === null && !(await paid("john@usc.edu")) && !(await paid("john2@usc.edu")), JSON.stringify(n));
n = await notify(ON, [z("Priya Natarajan", 150)]);
check("not the student price: waits", n.results?.[0]?.matched === null && !(await paid("priya@usc.edu")), JSON.stringify(n));
n = await notify(ON, [z("Priya Natarajan", 210)]);
check("the Venmo price sent by Zelle: waits", n.results?.[0]?.matched === null && !(await paid("priya@usc.edu")), JSON.stringify(n));
n = await notify(ON, [z("Anita Natarajan")]);
check("a parent's name: waits", n.results?.[0]?.matched === null && !(await paid("priya@usc.edu")), JSON.stringify(n));
n = await notify(ON, [z("Priya")]);
check("one word only: waits", n.results?.[0]?.matched === null, JSON.stringify(n));
n = await notify(ON, [z("Priya Natarajan", 200, { needs_review: true, review_reason: "forwarded" })]);
check("an alert held for review: never matched by name", n.results?.[0]?.review === true && !(await paid("priya@usc.edu")), JSON.stringify(n));
n = await notify(ON, [z("Noah Code")]);
check("a student with no pay code (never set LOCKqz up): waits", n.results?.[0]?.matched === null, JSON.stringify(n));
n = await notify(ON, [z("Maria Garcia Lopez")]);
check("a student who has already paid: a second payment under her name is not guessed", n.results?.[0]?.matched === null, JSON.stringify(n));
n = await notify(ON, [z("Nobody Known")]);
check("a name on no class list: waits", n.results?.[0]?.matched === null, JSON.stringify(n));

console.log("N4 Venmo at its own price; the memo still wins");
n = await notify(ON, [{ txn: "venmo:v1", amount: 210, note: "", via: "venmo", payer: "Priya Natarajan" }]);
check("Venmo of $210 with no note, her name: paid", n.results?.[0]?.email === "priya@usc.edu" && await paid("priya@usc.edu"), JSON.stringify(n));
n = await notify(ON, [z("Wei Chen", 200, { note: codes["john@usc.edu"] })]);
check("a memo code decides, whatever the payer's name", n.results?.[0]?.email === "john@usc.edu" && await paid("john@usc.edu"), JSON.stringify(n));
n = await notify(ON, [z("John Smith")]);
check("now only one John Smith is unpaid: his name is enough", n.results?.[0]?.email === "john2@usc.edu" && await paid("john2@usc.edu"), JSON.stringify(n));
sqlite.prepare("DELETE FROM payments WHERE code=?").run(codes["sam@usc.edu"]);
n = await notify(ON, [z("Samuel O'Neil-Diaz"), z("Samuel O'Neil-Diaz")]);
check("two payments under one name in one batch: the first counts, the second waits", n.results?.[0]?.email === "sam@usc.edu" && n.results?.[1]?.matched === null, JSON.stringify(n));
const wt = readFileSync(join(CF, "wrangler.toml"), "utf8");
check("the live setting is on", /^PAY_NAME_MATCH = "1"$/m.test(wt));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
