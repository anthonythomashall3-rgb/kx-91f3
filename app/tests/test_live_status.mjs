// LOCKqz — live quiz-monitor status logic (the /live endpoint + the heartbeat refresh).
// Verifies, with no network or DB:
//  - the per-student status truth table (locked / tamper / helper_killed / browser_closed / dark)
//  - a quiz-time heartbeat (every ~45s) keeps both the 60s password gate and the 90s
//    live-monitor window fresh, so a locked student is never falsely flagged
//  - heartbeat source maps to the right column (ext vs helper)
// Kept byte-for-byte in sync with functions/api/[[route]].js.

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const eq  = (m, a, b) => (a === b ? ok(m) : bad(`${m}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

const STALE = 90000;                 // live-monitor "went dark" threshold (ms)
const GATE  = 60000;                 // password-release freshness window (ms)
const age = (tMs, nowMs) => tMs == null ? null : (nowMs - tMs);

// exact copy of the Worker's status decision
function status(nowMs, lastLock, helperSeen, extSeen, tampered) {
  const a = age(lastLock, nowMs), h = age(helperSeen, nowMs), e = age(extSeen, nowMs);
  if (tampered) return "tamper";
  if (a !== null && a > STALE) {
    const helperDown = h === null || h > STALE, extDown = e === null || e > STALE;
    return helperDown && !extDown ? "helper_killed" : (extDown && !helperDown ? "browser_closed" : "dark");
  }
  return "locked";
}
// exact copy of the Worker's heartbeat column choice
const col = src => String(src || "helper").startsWith("ext") ? "ext_seen" : "helper_seen";

const T = 1_000_000_000_000;         // a fixed "now"
const fresh = T - 10_000, stale = T - 120_000;

console.log("T1 status truth table");
eq("all fresh -> locked",                 status(T, fresh, fresh, fresh, false), "locked");
eq("tamper flag wins even if fresh",      status(T, fresh, fresh, fresh, true ), "tamper");
eq("helper stale, browser fresh -> helper_killed", status(T, stale, stale, fresh, false), "helper_killed");
eq("browser stale, helper fresh -> browser_closed", status(T, stale, fresh, stale, false), "browser_closed");
eq("both stale -> dark",                  status(T, stale, stale, stale, false), "dark");
eq("both never-seen (null) -> dark",      status(T, stale, null,  null,  false), "dark");
eq("last_lock fresh overrides -> locked", status(T, fresh, stale, stale, false), "locked");

console.log("T2 a 45s heartbeat keeps a locked student from being flagged");
// student locked; last ping was 45s ago (one heartbeat interval)
const lastPing = T - 45_000;
eq("45s < 90s live window -> still locked", status(T, lastPing, lastPing, lastPing, false), "locked");
eq("45s < 60s password gate -> still fresh", age(lastPing, T) < GATE, true);

console.log("T3 heartbeat source maps to the right column");
eq("source 'helper' -> helper_seen", col("helper"), "helper_seen");
eq("source undefined -> helper_seen", col(undefined), "helper_seen");
eq("source 'ext' -> ext_seen", col("ext"), "ext_seen");
eq("source 'extension' -> ext_seen", col("extension"), "ext_seen");

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
