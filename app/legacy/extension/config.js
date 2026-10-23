// LOCKqz extension config. The installer writes the matching token/api into the
// helper's config.json; keep these two in sync.
const LOCKQZ = {
  helper: "http://127.0.0.1:8787",      // local helper (the blocking service)
  token: "lqz-8f3k9x2p7m",               // shared with the local helper (config.json)
  api: "https://lockdownqz.pages.dev/api",   // Cloudflare (live)
  // A quiz is a LOCKqz quiz when its Brightspace title contains this tag.
  quizTag: "[LOCKqz]",
  rulesetId: "ai_block"
};
if (typeof module !== "undefined") module.exports = LOCKQZ;
