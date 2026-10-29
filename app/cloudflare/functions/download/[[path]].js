// Wrong-computer guard for the student installers ($0: a Pages Function, no extra requests).
// The download page already shows only this computer's installer. This catches the rest: a forwarded
// direct link, or a file fetched on a Mac for a Windows PC (or the reverse). A browser on the wrong OS
// gets a short page with the right installer; "?anyway=1" still serves the file (another computer).
// Non-browser fetches (curl, PowerShell, the helpers' self-update) are never touched.
const PAGE = (title, body) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LOCKqz</title>
<style>body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#f6f4ef}
.w{max-width:520px;margin:48px auto;padding:0 16px}.c{background:#fff;border:1px solid #ddd8ce;border-radius:12px;overflow:hidden}
.h{background:#990000;color:#fff;font-weight:700;padding:14px 20px;display:flex;gap:8px;align-items:center}.b{padding:20px;display:grid;gap:14px}
h1{font-size:20px;margin:0}p{margin:0}.btn{display:inline-block;background:#990000;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:8px;justify-self:start}
.m{color:#6b6861;font-size:14px}.m a{color:#6b6861}</style></head><body><div class="w"><div class="c">
<div class="h"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>LOCKqz</div>
<div class="b"><h1>${title}</h1>${body}</div></div></div></body></html>`,
  { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export function osOf(ua) {
  ua = String(ua || "");
  if (!/Mozilla\//.test(ua)) return null;                                   // not a browser: never interfere
  if (/Android/.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua)) return "phone";
  if (/Windows/.test(ua) && !/Windows Phone/.test(ua)) return "win";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";                          // iPadOS desktop UA: page handles it
  return null;                                                              // Linux / ChromeOS: let it through
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url), f = url.pathname.split("/").pop() || "";
  const want = /\.pkg$/i.test(f) ? "mac" : /\.exe$/i.test(f) ? "win" : /\.apk$/i.test(f) ? "android" : null;
  if (!want || url.searchParams.has("anyway")) return ctx.next();
  const os = osOf(ctx.request.headers.get("user-agent"));
  if (!os || os === want) return ctx.next();
  const name = { mac: "Mac", win: "Windows", android: "Android" };
  if (os === "phone") return PAGE("Open this on your computer or Android phone",
    `<p>LOCKqz installs on the Mac, Windows or Linux computer, or the Android phone, you take exams on. It cannot run on an iPhone or iPad.</p><p>On that device, go to <b>${url.host}</b>.</p>`);
  const right = os === "mac" ? "/download/lockqz-mac.pkg" : os === "win" ? "/download/lockqz-win.exe" : "/download/lockqz-android.apk";
  return PAGE(`This is the ${name[want]} installer, but this computer is a ${name[os]}`,
    `<p>It would not open here. Download the ${name[os]} version instead:</p><a class="btn" href="${right}">Download LOCKqz for ${name[os]}</a>` +
    `<p class="m">Installing on a different ${name[want]} computer? <a href="${url.pathname}?anyway=1">Download the ${name[want]} installer anyway</a></p>`);
}
