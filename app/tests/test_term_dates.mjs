// Each school's own term dates: TERM_DATES (JSON) replaces the built-in calendar for that school's server
// settings; a broken setting changes nothing.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), CF = join(HERE, "..", "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-terms-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);
let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
let n = 0;
async function until(extra) {
  const sqlite = new DatabaseSync(":memory:"); sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
  const db = { prepare(sql) { const st = sqlite.prepare(sql); let a = [];
    const o = { bind(...x) { a = x.map(v => v === undefined ? null : typeof v === "boolean" ? Number(v) : v); return o; }, first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }),
      run: async () => ({ meta: { changes: Number(st.run(...a).changes) } }), _run() { st.run(...a); } }; return o; }, async batch(sts) { for (const s of sts) s._run(); } };
  const env = { DB: db, TEACHER_KEY: "admin-key-0123456789", PAY_SECRET: "pay-secret-0123456789", STUDENT_FEE_FROM: "2020-01-01", LIVE_CACHE_MS: "0", ...extra };
  const r = await onRequest({ request: new Request("https://lockqz.pages.dev/api/pay/start", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0." + (++n) }, body: JSON.stringify({ email: "sam@stateu.edu" }) }), env });
  return await r.json().catch(() => null);
}
const base = await until({});
check("the pay page names a term and its last day", /^\d{4}[123]$/.test(String(base?.term)) && /^\d{4}-\d{2}-\d{2}$/.test(String(base?.until)), JSON.stringify(base));
// the school's own dates for every term near today (the test does not depend on today's date)
const y = new Date().getFullYear(), own = {};
for (const yy of [y - 1, y, y + 1]) { own[`${yy}1`] = [`${yy}-01-02`, `${yy}-04-30`]; own[`${yy}2`] = [`${yy}-05-01`, `${yy}-08-15`]; own[`${yy}3`] = [`${yy}-08-16`, `${yy}-12-31`]; }
const mine = await until({ TERM_DATES: JSON.stringify(own) });
check("a school's own dates are used", !!mine?.term && mine.until === own[mine.term][1], JSON.stringify(mine));
check("and they differ from the built-in calendar", mine?.until !== base?.until || mine?.term !== base?.term, `${base?.term} ${base?.until}`);
const broken = await until({ TERM_DATES: "{ not json" });
check("a setting that is not JSON changes nothing", broken?.term === base?.term && broken?.until === base?.until, JSON.stringify(broken));
const bad = {}; for (const k of Object.keys(own)) bad[k] = [own[k][1], own[k][0]];   // end before start
bad["2027x"] = ["2027-01-01", "2027-02-01"]; bad[`${y}1`] = "soon";
const wrong = await until({ TERM_DATES: JSON.stringify(bad) });
check("entries that are not two dates in order are left out", wrong?.term === base?.term && wrong?.until === base?.until, JSON.stringify(wrong));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
