// Virtual machines (31 Oct): LOCKqz inside a VM locks only the VM; the real computer around it keeps AI.
// The helper reports `vm` with its /password request -> no password (reason "vm"), one 'vm' event per quiz,
// the professor's live view shows "vm" and the gate never admits that device. The admin may test in a VM.
// Also checks the helpers + agents + Android carry the field and the reason. Real API, in-memory SQLite.
import { withPayT } from "./pay_t.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac, createHash, randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, ".."), CF = join(APP, "cloudflare");
const tmp = mkdtempSync(join(tmpdir(), "lqz-vm-"));
writeFileSync(join(tmp, "route.mjs"), readFileSync(join(CF, "functions", "api", "[[route]].js")));
const { onRequest } = await import(pathToFileURL(join(tmp, "route.mjs")).href);

let pass = 0, fail = 0;
const check = (m, c, i = "") => { if (c) { pass++; console.log("  ok:", m); } else { fail++; console.log("  FAIL:", m + (i ? `  (${i})` : "")); } };
const sign = (key, path, ts, body) => createHmac("sha256", key).update(`POST\n${path}\n${ts}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
function d1real(sqlite) {
  const mk = () => { let args = [], st = null;
    return { _sql(sql){ st = sqlite.prepare(sql); return this; },
      bind(...a){ args = a.map(x => x===undefined?null:typeof x==="boolean"?Number(x):x); this._run=()=>st.run(...args); return this; },
      first: async()=> st.get(...args) ?? null, all: async()=>({results:st.all(...args)}),
      run: async()=>({meta:{changes:Number(st.run(...args).changes)}}) }; };
  return { prepare(sql){ return mk()._sql(sql); }, async batch(sts){ for (const s of sts) s._run(); } };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(join(CF, "schema.sql"), "utf8"));
for (const m of readdirSync(CF).filter(f => /^migrate_\d+.*\.sql$/.test(f)).sort()) { try { sqlite.exec(readFileSync(join(CF, m), "utf8")); } catch (e) { if (!/duplicate column|already exists|table .* already/.test(e.message)) throw e; } }
const BASE = "https://lockqz.test", ADMIN = "admin-test-key-vm";
const env = { DB: d1real(sqlite), TEACHER_KEY: ADMIN, ADMIN_EMAIL: "boss@usc.edu", REQUIRE_SIGNED: "1", STUDENT_FEE: "5", STUDENT_FEE_FROM: "2000-01-01", PAY_SECRET: "y".repeat(24), MAIL_SINK: async () => true };
async function call(path, body, { key = null, device = null, teacher = null, get = false } = {}) {
  body = withPayT(path, body, env);
  const raw = JSON.stringify(body ?? {});
  const h = { "Content-Type": "application/json" };
  if (teacher) h["X-LOCKqz-Teacher"] = teacher;
  if (key) { const ts = String(Math.floor(Date.now()/1000)); h["X-LOCKqz-Device"] = device; h["X-LOCKqz-Time"] = ts; h["X-LOCKqz-Sig"] = sign(key, `/api${path}`, ts, raw); }
  const res = await onRequest({ request: new Request(BASE + "/api" + path, get ? { method: "GET", headers: h } : { method: "POST", headers: h, body: raw }), env });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const qurl = (ou, qi) => `https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${qi}&ou=${ou}`;
async function student(dev, email) {
  const k = randomBytes(32).toString("hex");
  await call("/register", { device_id: dev, key: k, student: email, platform: "windows" });
  sqlite.prepare("UPDATE devices SET student_verified=1 WHERE device_id=?").run(dev);
  return k;
}
const pay = email => onRequest({ request: new Request(BASE + "/api/pay/notify", { method: "POST", headers: { "Content-Type": "application/json", "X-LOCKqz-Pay": env.PAY_SECRET }, body: JSON.stringify({ payments: [{ txn: "z:" + email, amount: 5, note: email, via: "zelle" }] }) }), env });
const protect = (ou, qi) => sqlite.prepare("INSERT INTO quizzes (quiz_id,title,password,created_at,qi,teacher_id,lock_id,ou,gated) VALUES (?,?,?,datetime('now'),?,?,?,?,0)").run("q" + ou + qi, "Quiz", "LQ-" + ou + qi, qi, "x", `${ou}-${qi}`, ou);
async function pw(dev, k, ou, qi, extra = {}) {
  await call("/report", { event: "lock", quiz_id: `${ou}-${qi}`, student: null }, { key: k, device: dev });
  return call("/password", { url: qurl(ou, qi), ...extra }, { key: k, device: dev });
}
const vmEvents = dev => sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE device_id=? AND event='vm'").get(dev).n;

console.log("V1 a paid student inside a virtual machine gets no password");
protect("4001", "41");
const kv = await student("dev-vm01", "vmuser@usc.edu"); await pay("vmuser@usc.edu");
let r = await pw("dev-vm01", kv, "4001", "41", { vm: "parallels" });
check("vm reported -> 403 reason vm, no password", r.status === 403 && r.data?.reason === "vm" && !r.data?.password, JSON.stringify(r));
r = await pw("dev-vm01", kv, "4001", "41", { vm: "parallels" });
check("asked again -> still refused", r.data?.reason === "vm");
check("logged once per quiz (no event flood)", vmEvents("dev-vm01") === 1, String(vmEvents("dev-vm01")));
r = await pw("dev-vm01", kv, "4001", "41", { vm: "  " });
check("blank vm field = a real computer (password)", /^LQ-/.test(r.data?.password || ""), JSON.stringify(r.data));

console.log("V2 the same class, a real computer: unchanged");
const kr = await student("dev-real1", "real@usc.edu"); await pay("real@usc.edu");
r = await pw("dev-real1", kr, "4001", "41");
check("no vm field -> the quiz password", /^LQ-/.test(r.data?.password || ""), JSON.stringify(r.data));

console.log("V3 the admin may test inside a virtual machine");
const ka = await student("dev-boss1", "boss@usc.edu"); await pay("boss@usc.edu");
r = await pw("dev-boss1", ka, "4001", "41", { vm: "vmware" });
check("admin's confirmed email + vm -> password, nothing logged", /^LQ-/.test(r.data?.password || "") && vmEvents("dev-boss1") === 0, JSON.stringify(r.data));

console.log("V4 a class not using LOCKqz is untouched (not_protected first)");
r = await pw("dev-vm01", kv, "9999", "99", { vm: "parallels" });
check("unprotected class -> not_protected, not vm", r.data?.reason === "not_protected", JSON.stringify(r.data));

console.log("V5 the professor's live view: 'vm', never eligible for the gate");
r = await call("/live?quiz=4001-41", null, { teacher: ADMIN, get: true });
const rows = r.data?.rows || [];
const vmRow = rows.find(x => x.device_id === "dev-vm01"), realRow = rows.find(x => x.device_id === "dev-real1");
check("vm device shows status vm", vmRow?.status === "vm", JSON.stringify(vmRow));
check("vm device is not eligible (the gate never grants it access)", vmRow && vmRow.eligible === false);
check("real device still locked", realRow?.status === "locked", JSON.stringify(realRow));

console.log("V6 the clients carry the field and the reason");
const rd = p => readFileSync(join(APP, p), "utf8");
const py = rd("mac/lockqzd.py"), ps = rd("windows/lockqzd.ps1"), agm = rd("mac/lockqz-agent.py"), agw = rd("windows/lockqz-agent.ps1");
const api = rd("android/app/src/main/java/app/lockqz/Api.kt"), qas = rd("android/app/src/main/java/app/lockqz/QuizAccessibilityService.kt");
const dash = rd("cloudflare/public/dashboard.html"), sync = rd("cloudflare/public/sync.js");
check("Mac/Linux helper: hv_vmm_present + hw.model, systemd-detect-virt + DMI + WSL", py.includes("kern.hv_vmm_present") && py.includes('"hw.model"') && py.includes("systemd-detect-virt") && py.includes("/sys/class/dmi/id/") && py.includes('"wsl"'));
check("Mac/Linux helper sends vm with /password and passes reason vm to the agent", py.includes('pbody["vm"] = vm_guest()') && py.includes('reason == "vm"'));
check("Windows helper: hardware strings only (never HypervisorPresent), sends vm, passes the reason", ps.includes("function LQ-VmGuest") && ps.includes("Win32_ComputerSystem") && !/HypervisorPresent\s*-eq|\.HypervisorPresent\)/.test(ps) && ps.includes("$pb.vm = $script:VmKind") && ps.includes('($why -eq "vm")'));
check("agents tell the student once (Mac/Linux + Windows)", agm.includes('reason == "vm"') && agm.includes("virtual machine") && agw.includes('($why -eq "vm")') && agw.includes("virtual machine"));
check("Android: emulator detection sent as vm + notice", api.includes("fun emulator()") && api.includes('put("vm", e)') && qas.includes('"vm" ->'));
check("dashboard label for vm", /vm:\["red","Virtual machine/.test(dash));
check("gate revokes a vm device at once", /REVOKE\s*=\s*\{[^}]*\bvm\s*:\s*1/.test(sync));
check("test hook only through LOCKQZ_TEST_VM (no network/config switch)", py.includes('os.environ.get("LOCKQZ_TEST_VM")') && ps.includes("$env:LOCKQZ_TEST_VM"));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
