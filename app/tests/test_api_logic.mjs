// LOCKqz API logic tests. Verifies the pure rules the Worker depends on:
//  - parsing ou/qi from Brightspace URLs
//  - the lockId derivation (must match on extension + server)
//  - the "release password only if locked in the last 60s" rule
//  - password resolution order (quiz password first, else course password)
// No network, no live DB — a tiny in-memory stand-in. Exits non-zero on any failure.

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const eq  = (m, a, b) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(`${m}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

// --- the exact helpers the Worker uses (kept in sync) ---
const parseQi = url => (String(url).match(/qi=(\d+)/) || [])[1] || null;
const parseOu = url => (String(url).match(/ou=(\d+)/) || String(url).match(/\/home\/(\d+)/) || [])[1] || null;
const lockId  = url => `${parseOu(url) || "x"}-${parseQi(url) || "x"}`;
const isFresh = (lastLockMs, nowMs) => lastLockMs != null && (nowMs - lastLockMs < 60000);

// --- in-memory DB stand-in ---
const db = { quizzes: {}, courses: {}, locks: {} };
function reportLock(device, lid, atMs) { db.locks[`${device}|${lid}`] = atMs; }
function reportUnlock(device, lid)     { delete db.locks[`${device}|${lid}`]; }
function resolvePassword(url, device, nowMs) {
  const qi = parseQi(url), ou = parseOu(url), lid = lockId(url);
  const last = db.locks[`${device}|${lid}`];
  if (!isFresh(last ?? null, nowMs)) return { code: 403, password: null };
  let pw = null;
  if (qi && db.quizzes[qi]) pw = db.quizzes[qi];
  if (!pw && ou && db.courses[ou]) pw = db.courses[ou];
  return { code: 200, password: pw };
}

const U_QUIZ   = "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=12345&ou=98765";
const U_COURSE = "https://usc.brightspace.com/d2l/home/98765";

console.log("T1 URL parsing");
eq("qi parsed", parseQi(U_QUIZ), "12345");
eq("ou parsed from quiz url", parseOu(U_QUIZ), "98765");
eq("ou parsed from /home/ url", parseOu(U_COURSE), "98765");
eq("lockId for quiz", lockId(U_QUIZ), "98765-12345");
eq("no ids -> x-x", lockId("https://x.com/nothing"), "x-x");

console.log("T2 freshness window (60s)");
eq("fresh at 0s", isFresh(1000, 1000), true);
eq("fresh at 59s", isFresh(1000, 1000 + 59000), true);
eq("stale at 61s", isFresh(1000, 1000 + 61000), false);
eq("never locked is stale", isFresh(null, 5000), false);

console.log("T3 password released ONLY when locked");
db.quizzes["12345"] = "LQ-QUIZPASS";
let r = resolvePassword(U_QUIZ, "devA", 10000);
eq("no lock -> 403, no password", [r.code, r.password], [403, null]);
reportLock("devA", "98765-12345", 10000);
r = resolvePassword(U_QUIZ, "devA", 10000);
eq("locked -> 200 + quiz password", [r.code, r.password], [200, "LQ-QUIZPASS"]);

console.log("T4 lock is per-device (another device can't use it)");
r = resolvePassword(U_QUIZ, "devB", 10000);
eq("devB not locked -> 403", [r.code, r.password], [403, null]);

console.log("T5 lock expires after 60s");
r = resolvePassword(U_QUIZ, "devA", 10000 + 61000);
eq("stale lock -> 403", [r.code, r.password], [403, null]);

console.log("T6 course password fallback when no quiz password");
delete db.quizzes["12345"];
db.courses["98765"] = "LQ-COURSEPASS";
reportLock("devA", "98765-12345", 20000);
r = resolvePassword(U_QUIZ, "devA", 20000);
eq("falls back to course password", [r.code, r.password], [200, "LQ-COURSEPASS"]);

console.log("T7 quiz password takes priority over course password");
db.quizzes["12345"] = "LQ-QUIZWINS";
r = resolvePassword(U_QUIZ, "devA", 20000);
eq("quiz password wins", r.password, "LQ-QUIZWINS");

console.log("T8 unlock removes the ability to get the password");
reportUnlock("devA", "98765-12345");
r = resolvePassword(U_QUIZ, "devA", 20000);
eq("after unlock -> 403", [r.code, r.password], [403, null]);

console.log("T9 a page with no registered quiz/course yields no password even if locked");
reportLock("devA", "98765-12345", 30000);
delete db.quizzes["12345"]; delete db.courses["98765"];
r = resolvePassword(U_QUIZ, "devA", 30000);
eq("locked but unregistered -> 200 + null", [r.code, r.password], [200, null]);

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
