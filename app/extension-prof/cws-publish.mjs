// Uploads app/extension-prof/dist/lockqz-prof-chromium.zip to the Chrome Web Store and submits it for review
// (Chrome Web Store API v2, service account). Run by .github/workflows/cws.yml when the manifest version changes.
// Env: CWS_SA_KEY (the service account's JSON key), CWS_PUBLISHER (publisher id), CWS_ITEM (item id).
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const key = JSON.parse(process.env.CWS_SA_KEY || "{}");
const PUB = process.env.CWS_PUBLISHER, ITEM = process.env.CWS_ITEM;
const ZIP = new URL("./dist/lockqz-prof-chromium.zip", import.meta.url);
if (!key.client_email || !key.private_key || !PUB || !ITEM) { console.log("CWS: secrets missing - nothing uploaded."); process.exit(0); }

// Service account -> access token (signed JWT, no extra Google permissions needed).
const b64u = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64u({ alg: "RS256", typ: "JWT" }), claim = b64u({ iss: key.client_email, scope: "https://www.googleapis.com/auth/chromewebstore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
const sig = createSign("RSA-SHA256").update(head + "." + claim).sign(key.private_key).toString("base64url");
const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + sig }) })).json();
if (!tok.access_token) { console.error("CWS: could not get a token:", JSON.stringify(tok)); process.exit(1); }
const H = { Authorization: "Bearer " + tok.access_token };
const NAME = `publishers/${PUB}/items/${ITEM}`, BASE = "https://chromewebstore.googleapis.com";

let up = await (await fetch(`${BASE}/upload/v2/${NAME}:upload`, { method: "POST", headers: { ...H, "Content-Type": "application/zip" }, body: readFileSync(ZIP) })).json();
console.log("CWS upload:", JSON.stringify(up));
for (let i = 0; i < 20 && up.uploadState === "UPLOAD_IN_PROGRESS"; i++) {
  await new Promise(r => setTimeout(r, 6000));
  const st = await (await fetch(`${BASE}/v2/${NAME}:fetchStatus`, { headers: H })).json();
  console.log("CWS status:", JSON.stringify(st));
  const s = st.lastAsyncUploadState || st.uploadState; if (s && s !== "UPLOAD_IN_PROGRESS") up = { ...up, uploadState: s };
}
if (up.uploadState !== "SUCCEEDED") { console.error("CWS: upload did not succeed."); process.exit(1); }
const pub = await (await fetch(`${BASE}/v2/${NAME}:publish`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" })).json();
console.log("CWS publish:", JSON.stringify(pub));
if (pub.error) process.exit(1);
console.log("CWS: submitted for review.");
