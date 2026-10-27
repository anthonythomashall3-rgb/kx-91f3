// Tests: add the pay-link token (t = HMAC(email), as LOCKqz puts in every pay link) to /pay/* calls that
// name an email, the way the real pay page does when opened from the link. Tests of the no-token path pass t: null.
import { createHmac } from "node:crypto";
export function payT(env, email) {
  return createHmac("sha256", String(env.ROT_SECRET || env.TEACHER_KEY || "lqz-fallback")).update("lqz-pay-status:" + String(email || "").trim().toLowerCase()).digest("hex").slice(0, 32);
}
export function withPayT(path, body, env) {
  if (!/^\/pay\/(start|stripe|renew|bank)$/.test(String(path)) || !body || typeof body !== "object" || !body.email || "t" in body) return body;
  return { ...body, t: payT(env, body.email) };
}
