#!/usr/bin/env python3
"""LOCKqz Android app (29 Oct 2026): structural checks (the CI job compiles it, runs its JUnit tests and signs the APK).
 A1 project files, version from app/VERSION, one signing key committed and wired to debug + release
 A2 manifest: VPN + accessibility services with the right permissions, boot receiver, no network-sensitive extras
 A3 the quiz URL rules mirror the Mac agent's regexes; AI app list covers the big chats + messaging; URL bars for the big browsers
 A4 DNS filter answers A/AAAA like the hosts file, DoH addresses routed into the tunnel; VPN revoke is reported
 A5 site: APK download for Android visitors, wrong-device guard knows Android, release.yml builds + publishes + checks the APK
"""
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); APP = os.path.dirname(HERE); AND = os.path.join(APP, "android")
PASS = FAIL = 0
def check(m, c, extra=""):
    global PASS, FAIL
    if c: PASS += 1; print("  ok:", m)
    else: FAIL += 1; print("  FAIL:", m, ("[" + str(extra)[:200] + "]") if extra else "")
def rd(p): return open(os.path.join(AND, p)).read()

print("A1 project")
for f in ["settings.gradle.kts", "build.gradle.kts", "app/build.gradle.kts", "app/src/main/AndroidManifest.xml",
          "app/src/main/java/app/lockqz/Api.kt", "app/src/main/java/app/lockqz/DnsVpnService.kt", "app/src/main/java/app/lockqz/QuizAccessibilityService.kt",
          "app/src/main/java/app/lockqz/MainActivity.kt", "app/src/test/java/app/lockqz/UnitTests.kt", "app/src/main/res/xml/accessibility.xml", "README.md"]:
    check("exists: " + f, os.path.isfile(os.path.join(AND, f)))
g = rd("app/build.gradle.kts")
check("version comes from app/VERSION", 'file("../VERSION")' in g and "versionName = lqVersion" in g)
check("one signing key for debug + release, from the CI secret, never in the repo", g.count('if (haveKey) "lockqz" else "debug"') == 2 and 'System.getenv("LOCKQZ_KEYSTORE")' in g and not os.path.exists(os.path.join(AND, "keystore")) and "keystore/" in rd(".gitignore"))
check("CI writes the key from the secret and removes it", "ANDROID_KEYSTORE_B64" in open(os.path.join(APP, "..", ".github/workflows/release.yml")).read())
check("no third-party runtime dependencies (small APK, nothing to audit)", re.search(r"implementation\(", g) is None)
check("local.properties / build output ignored", "local.properties" in rd(".gitignore") and "build/" in rd(".gitignore"))

print("A2 manifest")
m = rd("app/src/main/AndroidManifest.xml")
check("VPN service bound by the system only", 'android:name=".DnsVpnService" android:permission="android.permission.BIND_VPN_SERVICE"' in m and "android.net.VpnService" in m)
check("accessibility service bound by the system only, with its config", 'android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"' in m and '@xml/accessibility' in m)
check("boot receiver", "BOOT_COMPLETED" in m)
check("permissions: internet, foreground service, notifications, boot, network state - nothing else",
      set(re.findall(r'uses-permission android:name="android\.permission\.([A-Z_]+)"', m)) == {"INTERNET", "FOREGROUND_SERVICE", "POST_NOTIFICATIONS", "RECEIVE_BOOT_COMPLETED", "ACCESS_NETWORK_STATE"})
a = rd("app/src/main/res/xml/accessibility.xml")
check("accessibility: view ids + window content, no gestures", "flagReportViewIds" in a and 'canPerformGestures="false"' in a)

print("A3 rules + lists")
q = rd("app/src/main/java/app/lockqz/QuizAccessibilityService.kt"); mac = open(os.path.join(APP, "mac", "lockqz-agent.py")).read()
for name, pat in [("QUIZ_PATH", r"\^/d2l/lms/quizzing/\(user/\|\.\*preview\)"), ("LEAVING", r"quizzes_list\|quiz_submissions\|feedback\|results\|submission")]:
    check("%s regex matches the Mac agent's" % name, re.search(pat, q) is not None and re.search(pat, mac) is not None)
for p in ["com.openai.chatgpt", "com.anthropic.claude", "com.google.android.apps.bard", "com.microsoft.copilot", "ai.perplexity.app.android", "ai.x.grok", "com.deepseek.chat", "com.whatsapp", "org.telegram.messenger", "com.discord"]:
    check("AI/messaging app sent home: " + p, '"%s"' % p in q)
for b in ["com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser", "com.microsoft.emmx", "com.brave.browser", "com.duckduckgo.mobile.android"]:
    check("address bar read: " + b, '"%s" to' % b in q)
check("Content/Lessons frame URL decoded (inner quiz URL)", "fun innerUrl" in q and 'startsWith("/d2l/")' in q)
check("lock report before /password; unlock reported with a reason; heartbeat obeys the server's unlock", 'Api.report(this, "lock"' in q and 'Api.report(this, "unlock"' in q and 'optBoolean("unlock")' in q)
check("the password is shown + copied, never typed into the page", "setPrimaryClip" in q and "performAction(" not in q)

print("A4 DNS filter")
d = rd("app/src/main/java/app/lockqz/DnsVpnService.kt")
check("tunnel = DNS server + DoH drop routes, own app excluded", 'addDnsServer(DNS_IP)' in d and 'for (ip in DOH_IPS) try { b.addRoute(ip, 32) }' in d and "addDisallowedApplication(packageName)" in d)
check("blocked names answered 0.0.0.0 / :: (NOERROR), others forwarded to the real resolver with a protected socket", "fun blackhole" in d and "protect(s)" in d and "realDns()" in d)
check("block only while locked; parent domains match", "if (!locked) return false" in d and "n = n.substring(i + 1)" in d)
check("VPN revoked -> watcher told", "override fun onRevoke()" in d and "onRevoked?.invoke()" in d and '"vpn_revoked"' in q)
check("same protocol as the helpers: HMAC headers, register, platform tag android-", all(x in rd("app/src/main/java/app/lockqz/Api.kt") for x in ['"POST\\n${url.path}\\n$ts\\n${sha256Hex(raw)}"', "X-LOCKqz-Sig", '"/register"', '"android-']))

print("A5 site + CI")
idx = open(os.path.join(APP, "cloudflare/public/index.html")).read(); guard = open(os.path.join(APP, "cloudflare/functions/download/[[path]].js")).read()
rel = open(os.path.join(APP, "..", ".github/workflows/release.yml")).read()
check("download page: Android gets the APK + 3 steps", "/download/lockqz-android.apk" in idx and "install unknown apps" in idx)
check("wrong-device guard: Android recognised, iPhone told plainly", '"android"' in guard and "cannot run on an iPhone or iPad" in guard)
check("release.yml: android job (unit tests + signed APK), artifact into the deploy, live magic check", "assembleRelease" in rel and "lockqz-android.apk 'PK'" in rel and "name: lockqz-android" in rel)
print("\nRESULT: %d passed, %d failed" % (PASS, FAIL)); sys.exit(1 if FAIL else 0)
