// LOCKqz URL parsing robustness — every Brightspace quiz URL shape we might see.
// Uses the exact parser the extension + Worker use. If this fails, the flow fails for
// those students, so it must handle param order, extra params, and encoding.
let pass = 0, fail = 0;
const ok = m => { pass++; console.log("  ok:", m); };
const bad = m => { fail++; console.log("  FAIL:", m); };
const eq = (m, a, b) => (a === b ? ok(m) : bad(`${m} (got ${a}, want ${b})`));

// exact helpers (kept in sync with the Worker + extension)
const parseQi = url => (String(url).match(/qi=(\d+)/) || [])[1] || null;
const parseOu = url => (String(url).match(/ou=(\d+)/) || String(url).match(/\/home\/(\d+)/) || [])[1] || null;
const lockId  = url => `${parseOu(url) || "x"}-${parseQi(url) || "x"}`;
const isQuizPage = url => /\/d2l\/lms\/quizzing\/user\//.test(String(url));

const cases = [
  // [description, url, expect qi, expect ou, expect isQuizPage]
  ["classic quiz summary", "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=12345&ou=98765", "12345", "98765", true],
  ["params reversed order", "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?ou=98765&qi=12345", "12345", "98765", true],
  ["extra params present", "https://usc.brightspace.com/d2l/lms/quizzing/user/attempt/start.d2l?ou=98765&qi=12345&cfql=1&d2l_body_type=3", "12345", "98765", true],
  ["new-creation-experience quiz (same path)", "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=55512&ou=4041", "55512", "4041", true],
  ["attempt in progress", "https://usc.brightspace.com/d2l/lms/quizzing/user/attempt/attempt.d2l?qi=777&ou=111&ai=999", "777", "111", true],
  ["course home (no quiz)", "https://usc.brightspace.com/d2l/home/98765", null, "98765", false],
  ["quizzes list page (not an attempt)", "https://usc.brightspace.com/d2l/lms/quizzing/quizzes_list.d2l?ou=98765", null, "98765", false],
  ["trailing slash + hash", "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=321&ou=654#top", "321", "654", true],
  ["uppercase host", "HTTPS://USC.BRIGHTSPACE.COM/d2l/lms/quizzing/user/quiz_summary.d2l?qi=9&ou=8", "9", "8", true],
  ["big realistic ids", "https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_summary.d2l?qi=2048576&ou=1099988", "2048576", "1099988", true],
  ["no ids at all", "https://usc.brightspace.com/d2l/le/content/123/Home", null, null, false],
];

console.log("T1 qi/ou parsed from every shape");
for (const [d, url, eqi, eou] of cases) {
  eq(`qi: ${d}`, parseQi(url), eqi);
  eq(`ou: ${d}`, parseOu(url), eou);
}

console.log("T2 isQuizPage true ONLY on an actual attempt page");
for (const [d, url, , , isq] of cases) {
  (isQuizPage(url) === isq) ? ok(`quiz-page flag: ${d}`) : bad(`quiz-page flag: ${d} (got ${isQuizPage(url)}, want ${isq})`);
}

console.log("T3 lockId is consistent and collision-free for different quizzes");
const a = lockId("https://x/d2l/lms/quizzing/user/q.d2l?qi=1&ou=100");
const b = lockId("https://x/d2l/lms/quizzing/user/q.d2l?qi=2&ou=100");
const c = lockId("https://x/d2l/lms/quizzing/user/q.d2l?qi=1&ou=200");
eq("same quiz same id", a, "100-1");
(a !== b && a !== c && b !== c) ? ok("different quizzes -> different lockIds") : bad("lockId collision");

console.log("T4 fails safe: garbage URL never throws, yields x-x");
let threw = false;
try { lockId(null); lockId(undefined); lockId(12345); lockId({}); } catch (e) { threw = true; }
!threw ? ok("no throw on garbage input") : bad("threw on garbage input");
eq("empty-ish -> x-x", lockId(""), "x-x");

console.log("");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
