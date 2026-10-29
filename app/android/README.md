# LOCKqz for Android (29 Oct 2026, stage 1)

A native app (Kotlin, no third-party libraries, ~700 KB), sideloaded from https://lockqz.pages.dev
(`/download/lockqz-android.apk`). Same server protocol as the computers (device key, signed reports, `/password`,
`/verify` email codes, pay page).

How it blocks AI (no root), the way ad blockers do:
* `DnsVpnService` - a local VPN that is the phone's only DNS server. While a quiz is locked, a lookup of any
  blocklisted host (or a name under it) is answered 0.0.0.0 / ::, everything else is forwarded to the real resolver.
  The known DoH resolver addresses are routed into the tunnel and dropped (no encrypted-DNS bypass). Unlocked,
  every lookup passes. Turning the VPN off is seen at once (`onRevoke` -> tamper report, no password).
* `QuizAccessibilityService` - reads the address bar of Chrome, Firefox, Samsung Internet, Edge, Brave, Vivaldi,
  Kiwi, Opera, DuckDuckGo, Ecosia, Yandex (view ids in `URL_BARS`). A Brightspace quiz attempt page -> lock
  (signed lock report, password fetched, shown as a notification + copied to the clipboard); the submission page
  or 30 s without the quiz page -> unlock. While locked, an AI app coming to the front (ChatGPT, Gemini, Claude,
  Copilot, Perplexity, Grok, DeepSeek, Poe, Character, Meta AI, Pi, You, Le Chat, Kimi, Qwen, Bing, Notion,
  QuillBot, Grammarly keyboard, WhatsApp, Telegram, Discord, Messenger, Slack) is sent to the home screen.
* `MainActivity` - 4 taps: school email + emailed code, turn on quiz detection (Accessibility), allow the AI block
  (VPN consent), pay page. `BootReceiver` brings the tunnel back after a reboot.

Build: `cd app/android && gradle testDebugUnitTest assembleRelease` (Android SDK 35, JDK 17). CI builds the
signed release APK and publishes it with the site. Signing key (never in the repo): once, on any machine,
`keytool -genkeypair -keystore lockqz.jks -alias lockqz -keyalg RSA -keysize 2048 -validity 10000 -storepass <pass> -keypass <pass> -dname "CN=LOCKqz"`,
then GitHub -> Settings -> Secrets -> Actions: `ANDROID_KEYSTORE_B64` = `base64 -i lockqz.jks` and `ANDROID_KEYSTORE_PASS` = <pass>.
Until the secret exists CI signs with the debug key (installable; a later real-key build needs an uninstall first).
Unit tests: DNS wire helpers, blocklist matching, quiz URL rules.

Not yet: the AI hosts' resolved addresses as drop routes (warm connections on a phone), Brightspace Pulse app
(quizzes must be taken in a browser), on-device Gemini features that need no network, Samsung Galaxy AI,
emulator tests in CI. Chrome's "Secure DNS" falls back to the system resolver when the VPN's DNS is not a known
DoH provider (default "automatic" mode); a student who forces a DoH provider by hand gets it blocked by address.
