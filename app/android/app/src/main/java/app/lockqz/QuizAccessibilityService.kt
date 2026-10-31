package app.lockqz

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors

/** The quiz watcher. Reads the browser's address bar; on a Brightspace quiz attempt page it locks (VPN
 *  block on, signed lock report, password fetched and shown), while locked it sends AI apps home and
 *  pings the server, and when the quiz page is gone (submitted / left / closed) it unlocks. */
class QuizAccessibilityService : AccessibilityService() {
    companion object {
        const val TAG = "LOCKqz-watch"
        @Volatile var instance: QuizAccessibilityService? = null
        // browser package -> address bar view id
        val URL_BARS = mapOf(
            "com.android.chrome" to "com.android.chrome:id/url_bar", "com.chrome.beta" to "com.chrome.beta:id/url_bar",
            "com.chrome.dev" to "com.chrome.dev:id/url_bar", "com.chrome.canary" to "com.chrome.canary:id/url_bar",
            "org.chromium.chrome" to "org.chromium.chrome:id/url_bar",
            "com.microsoft.emmx" to "com.microsoft.emmx:id/url_bar", "com.brave.browser" to "com.brave.browser:id/url_bar",
            "com.vivaldi.browser" to "com.vivaldi.browser:id/url_bar", "com.kiwibrowser.browser" to "com.kiwibrowser.browser:id/url_bar",
            "com.sec.android.app.sbrowser" to "com.sec.android.app.sbrowser:id/location_bar_edit_text",
            "org.mozilla.firefox" to "org.mozilla.firefox:id/mozac_browser_toolbar_url_view",
            "org.mozilla.firefox_beta" to "org.mozilla.firefox_beta:id/mozac_browser_toolbar_url_view",
            "org.mozilla.fenix" to "org.mozilla.fenix:id/mozac_browser_toolbar_url_view",
            "org.mozilla.focus" to "org.mozilla.focus:id/mozac_browser_toolbar_url_view",
            "com.opera.browser" to "com.opera.browser:id/url_field",
            "com.duckduckgo.mobile.android" to "com.duckduckgo.mobile.android:id/omnibarTextInput",
            "com.ecosia.android" to "com.ecosia.android:id/url_bar", "com.yandex.browser" to "com.yandex.browser:id/bro_omnibar_address_title_text")
        // AI apps sent to the home screen while a quiz is locked
        val AI_APPS = setOf("com.openai.chatgpt", "com.anthropic.claude", "com.google.android.apps.bard", "com.microsoft.copilot",
            "ai.perplexity.app.android", "ai.x.grok", "com.deepseek.chat", "com.quora.poe", "ai.character.app", "com.meta.ai",
            "ai.pi.app", "com.youdotcom.you", "com.mistral.lechat", "com.moonshot.kimichat", "com.alibaba.qwen", "com.zhipu.chatglm",
            "com.microsoft.bing", "com.google.android.apps.searchlite", "com.notion.id", "com.quillbot.app", "com.grammarly.android.keyboard",
            "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "com.discord", "com.facebook.orca", "com.Slack")
        val QUIZ_PATH = Regex("^/d2l/lms/quizzing/(user/|.*preview)", RegexOption.IGNORE_CASE)
        val QUIZ_ANY = Regex("^/d2l/lms/quizzing/", RegexOption.IGNORE_CASE)
        val LEAVING = Regex("quizzes_list|quiz_submissions|feedback|results|submission", RegexOption.IGNORE_CASE)
        val QI = Regex("[?&]qi=(\\d+)"); val OU = Regex("[?&]ou=(\\d+)")
        const val GRACE_MS = 30_000L
        const val BEAT_MS = 60_000L         // a phone can be force-stopped silently: short beats keep the server's view honest
        const val HOLD_BEAT_MS = 30_000L    // while the server holds a local unlock: ask again every 30 s

        fun parts(url: String): Pair<String, String> {
            val s = if ("://" in url.take(12)) url else "https://$url"
            return try { val u = java.net.URI(s); Pair(u.rawPath ?: "", u.rawQuery ?: "") } catch (_: Exception) { Pair("", "") }
        }
        fun innerUrl(url: String): String {
            val (path, query) = parts(url)
            if (Regex("^/d2l/le/(content|lessons)/\\d+/", RegexOption.IGNORE_CASE).containsMatchIn(path)) {
                val loc = query.split('&').firstOrNull { it.startsWith("location=") }?.substringAfter('=')?.let { java.net.URLDecoder.decode(it, "UTF-8") }
                if (loc != null && loc.startsWith("/d2l/")) { val s = if ("://" in url.take(12)) url else "https://$url"; val u = java.net.URI(s); return "${u.scheme}://${u.authority}$loc" }
            }
            return url
        }
        fun lockId(url: String) = "${OU.find(url)?.groupValues?.get(1) ?: "x"}-${QI.find(url)?.groupValues?.get(1) ?: "x"}"
        fun isQuizPage(url: String): Boolean { val (p, q) = parts(url); return QUIZ_PATH.containsMatchIn(p) || (QUIZ_ANY.containsMatchIn(p) && Regex("(^|&)isprv=1(&|$)", RegexOption.IGNORE_CASE).containsMatchIn(q)) }
        fun isLeaving(url: String) = isQuizPage(url) && LEAVING.containsMatchIn(parts(url).first)
        fun isQuiz(url: String) = isQuizPage(url) && QI.containsMatchIn(url) && !isLeaving(url)
    }

    private val exec = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var quiz: String? = null          // locked quiz id
    @Volatile private var quizUrl: String? = null
    @Volatile private var missingSince = 0L
    @Volatile private var lastBeat = 0L
    @Volatile private var lastSeen = 0L
    @Volatile private var pwShown: String? = null
    @Volatile private var held = false                   // the server has not vouched for the quiz end yet: block stays
    @Volatile private var holdUntil = 0L
    @Volatile private var askFailSince = 0L
    @Volatile private var pwNext = 0L
    private val capped = java.util.concurrent.ConcurrentHashMap<String, Long>()   // released quiz id -> last time its page was seen
    private val browsers = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()   // every app that opens https links
    @Volatile private var otherProfileTold = false

    override fun onServiceConnected() {
        instance = this
        DnsVpnService.onRevoked = { onVpnRevoked() }
        exec.execute {
            DnsVpnService.setBlocklist(Api.blocklist(this))
            try {   // every installed browser (anything that opens https links): the ones LOCKqz cannot read are sent home during a quiz
                val i = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://example.com/"))
                for (r in packageManager.queryIntentActivities(i, android.content.pm.PackageManager.MATCH_ALL)) browsers.add(r.activityInfo.packageName)
            } catch (_: Exception) {}
            // Resumed after a force-stop / reboot while a quiz was locked: the server hears about the gap.
            val prev = getSharedPreferences("lockqz", Context.MODE_PRIVATE).getString("locked_quiz", null)
            if (prev != null) { Api.report(this, "restarted", prev, JSONObject().put("detail", "watcher_restarted")); getSharedPreferences("lockqz", Context.MODE_PRIVATE).edit().remove("locked_quiz").apply() }
        }
        main.post(object : Runnable { override fun run() { tick(); main.postDelayed(this, 2000) } })
        Log.i(TAG, "watching")
    }
    override fun onInterrupt() {}
    override fun onDestroy() { instance = null; super.onDestroy() }

    override fun onAccessibilityEvent(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString() ?: return
        if (quiz != null && e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            if (pkg in AI_APPS || (pkg in browsers && pkg !in URL_BARS && pkg != packageName)) {
                // an AI app, or a browser LOCKqz cannot read (proxy browsers render AI sites on their servers)
                performGlobalAction(GLOBAL_ACTION_HOME)
                main.post { Toast.makeText(this, if (pkg in AI_APPS) "LOCKqz: AI is off during your quiz" else "LOCKqz: use Chrome, Firefox, Samsung Internet, Edge or Brave during the quiz", Toast.LENGTH_SHORT).show() }
                return
            }
            if (pkg == "com.google.android.googlequicksearchbox") { performGlobalAction(GLOBAL_ACTION_BACK); return }   // Assistant / Gemini overlay, Circle to Search
        }
        val barId = URL_BARS[pkg] ?: return
        val root = rootInActiveWindow ?: return
        val url = readUrl(root, barId) ?: return
        onUrl(url)
    }

    private fun readUrl(root: AccessibilityNodeInfo, id: String): String? {
        val nodes = try { root.findAccessibilityNodeInfosByViewId(id) } catch (_: Exception) { null } ?: return null
        for (n in nodes) { val t = n.text?.toString()?.trim(); if (!t.isNullOrEmpty() && !t.contains(' ')) return t }
        return null
    }

    /** Address-bar text (the browser may show the host only, or hide the scheme). */
    private fun onUrl(raw: String) {
        val url = innerUrl(raw)
        val now = System.currentTimeMillis()
        if (isQuiz(url)) {
            val id = lockId(url); lastSeen = now
            if (capped.containsKey(id)) { capped[id] = now; return }           // released by the server: never re-locked while its page stays open
            if (quiz == null) exec.execute { start(url, id) }
            else if (quiz == id) { missingSince = 0; quizUrl = url }
            else exec.execute { end("quiz_left") }
        } else if (isLeaving(url) && quiz != null && lockId(url) == quiz) {
            exec.execute { end("quiz_submitted") }
        }
    }

    /** Every 2 s: the quiz page has not been seen for the grace period -> unlock; heartbeat while locked. */
    private fun tick() {
        val now = System.currentTimeMillis()
        for ((id, seen) in capped) if (now - seen > 2 * GRACE_MS) capped.remove(id)   // page gone for a minute: a new attempt locks again
        val q = quiz ?: return
        if (!held && now - lastSeen > GRACE_MS) { exec.execute { end("quiz_closed") }; return }
        if (held && now - lastSeen > GRACE_MS && now >= holdUntil) { exec.execute { end("quiz_closed") }; return }   // ask again (30 s)
        if (now - lastBeat > (if (held) HOLD_BEAT_MS else BEAT_MS)) { lastBeat = now; exec.execute { beat(q) } }
        val u = quizUrl
        if (!held && u != null && "/attempt/" !in parts(u).first && now >= pwNext) { pwNext = now + 15_000; exec.execute { password(u, q, quiet = true) } }   // gated: new code every 5 min
    }

    private fun start(url: String, id: String) {
        if (quiz != null) return
        if (!Api.verified(this) && Api.student(this) == null) { notify("Finish LOCKqz setup", "Open LOCKqz and confirm your school email to get quiz passwords."); return }
        if (!DnsVpnService.running) { try { DnsVpnService.start(this) } catch (e: Exception) { Log.w(TAG, "vpn start: $e") }; Thread.sleep(1500) }
        if (!DnsVpnService.running) { notifyOnce("vpn", "LOCKqz is off", "Open LOCKqz and allow the AI block (VPN) to get the quiz password."); return }
        DnsVpnService.setBlocklist(Api.blocklist(this))
        DnsVpnService.locked = true; quiz = id; quizUrl = url; lastSeen = System.currentTimeMillis(); missingSince = 0; pwShown = null; held = false; pwNext = 0
        getSharedPreferences("lockqz", Context.MODE_PRIVATE).edit().putString("locked_quiz", id).apply()
        checkOtherProfiles(id)
        Log.i(TAG, "locked $id")
        val (code, j) = Api.report(this, "lock", id, JSONObject().put("url", url).put("platform", Api.platform()))
        if (j?.optBoolean("unlock") == true) { release(id, j.optString("reason", "quiz_ended")); return }
        lastBeat = System.currentTimeMillis()
        password(url, id)
        vpnNote()
    }

    /** Private DNS (DoT to a resolver of the student's choice) would answer every AI lookup past the filter. */
    private fun privateDnsOn(): String? {
        return try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            for (n in cm.allNetworks) {
                val lp = cm.getLinkProperties(n) ?: continue
                if (android.os.Build.VERSION.SDK_INT >= 28 && lp.isPrivateDnsActive) return lp.privateDnsServerName ?: "automatic"
            }
            null
        } catch (_: Exception) { null }
    }
    private fun checkOtherProfiles(id: String) {
        try {
            val um = getSystemService(Context.USER_SERVICE) as android.os.UserManager
            if (um.userProfiles.size > 1 && !otherProfileTold) { otherProfileTold = true; Api.report(this, "other_profile", id, JSONObject().put("detail", "work_profile_or_second_user")) }
        } catch (_: Exception) {}
    }

    private fun password(url: String, id: String, quiet: Boolean = false) {
        if (quiz != id) return
        privateDnsOn()?.let { srv ->
            if (!quiet) { Api.report(this, "tamper", id, JSONObject().put("detail", "private_dns:$srv")); notifyOnce("pdns", "Turn Private DNS off", "Settings > Network & internet > Private DNS > Off. LOCKqz gives you the quiz password once it is off.") }
            main.postDelayed({ if (quiz == id && pwShown == null) exec.execute { password(quizUrl ?: url, id) } }, 15_000); return
        }
        val (code, j) = Api.password(this, url)
        val pw = j?.optString("password", "")?.takeIf { it.isNotEmpty() && code == 200 }
        if (pw != null) {
            if (pwShown != pw) { pwShown = pw; showPassword(pw) }
            return
        }
        if (quiet) return
        val pay = j?.optJSONObject("pay")
        if (pay != null) {
            if (!getSharedPreferences("lockqz", Context.MODE_PRIVATE).getBoolean("pay_shown_$id", false)) {
                getSharedPreferences("lockqz", Context.MODE_PRIVATE).edit().putBoolean("pay_shown_$id", true).apply()
                notify("Pay for LOCKqz this semester", "The quiz password comes as soon as your payment arrives. Memo: ${pay.optString("code")}")
                try { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(pay.optString("url", "${Api.SITE}/pay"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
            }
            main.postDelayed({ if (quiz == id && pwShown == null) exec.execute { password(quizUrl ?: url, id) } }, 15_000); return
        }
        when (j?.optString("reason")) {
            "not started" -> notify("Quiz not open yet", "LOCKqz gives you the password when the quiz opens.")
            "gate_off" -> notify("Waiting for your professor", "The quiz password is released when your professor opens the exam.")
            "not_protected" -> { Log.i(TAG, "not protected: unlocking"); release(id, "not_protected") }
            "vm" -> notify("LOCKqz", "This quiz can't open in an emulator. Open it on the phone or computer itself.")
            else -> if (code == 402) notify("LOCKqz", j?.optString("error", "This email is in a quiz on another device.") ?: "")
                    else notify("LOCKqz", "No password yet (${code}). Retrying.")
        }
        // retry every 15 s while the quiz page is open
        main.postDelayed({ if (quiz == id && pwShown == null) exec.execute { password(quizUrl ?: url, id) } }, 15_000)
    }

    private fun showPassword(pw: String) {
        try { (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("LOCKqz", pw)) } catch (_: Exception) {}
        notify("Quiz password: $pw", "Copied to the clipboard. Paste it into Brightspace. AI stays off until you submit.", important = true)
        main.post { Toast.makeText(this, "LOCKqz password $pw (copied)", Toast.LENGTH_LONG).show() }
    }

    private fun beat(id: String) {
        val (_, j) = Api.report(this, "heartbeat", id)
        if (j?.optBoolean("unlock") == true) release(id, j.optString("reason", "quiz_ended"))
    }

    /** The server says this quiz is over for this student (submitted per the professor's Sync, or ended). */
    private fun release(id: String, reason: String) { unlockNow(id, reason, report = false); capped[id] = System.currentTimeMillis() }

    /** The quiz page is gone (submitted / left / closed). The server is ASKED before AI comes back: it vouches
     *  for the end (Brightspace's submission, or the quiz end) or, while the gate runs, holds the block;
     *  held, the watcher beats every 30 s and the server releases it right after the submission arrives. */
    private fun end(reason: String, report: Boolean = true) {
        val id = quiz ?: return
        if (!report) { unlockNow(id, reason, report = false); return }
        val now = System.currentTimeMillis()
        val det = JSONObject().put("reason", reason).put("local", true).put("ask", true)
        val (code, j) = Api.report(this, "unlock", id, JSONObject().put("detail", det))
        var hold = j?.optBoolean("hold") == true
        if (code == 0) { if (askFailSince == 0L) askFailSince = now; hold = now - askFailSince < 600_000 } else askFailSince = 0
        if (hold) {
            if (!held) { Log.i(TAG, "unlock held for $id"); notifyOnce("hold", "AI stays off a little longer", "Brightspace has not recorded your submission yet. AI comes back by itself within a minute of it reaching your professor's Brightspace, or at the quiz end.") }
            held = true; holdUntil = now + HOLD_BEAT_MS; lastBeat = now
            return
        }
        unlockNow(id, reason, report = false)
    }

    private fun unlockNow(id: String, reason: String, report: Boolean) {
        quiz = null; quizUrl = null; pwShown = null; held = false
        DnsVpnService.locked = false
        getSharedPreferences("lockqz", Context.MODE_PRIVATE).edit().remove("locked_quiz").apply()
        Log.i(TAG, "unlocked $id ($reason)")
        if (report) Api.report(this, "unlock", id, JSONObject().put("detail", JSONObject().put("reason", reason)))
        notify("Quiz over", "AI is back.", cancelAfter = true)
        vpnNote()
        if (reason != "quiz_submitted" && reason != "not_protected") capped.remove(id)   // left / closed: a return to the page locks again
    }

    private fun onVpnRevoked() {
        val id = quiz ?: return
        exec.execute {
            Api.report(this, "tamper", id, JSONObject().put("detail", "vpn_revoked"))
            notify("LOCKqz was turned off", "Turn the AI block back on in LOCKqz, or the quiz password stops.", important = true)
        }
    }

    private fun vpnNote() { /* the VPN notification text follows the lock state */ try { startService(Intent(this, DnsVpnService::class.java).setAction(DnsVpnService.ACTION_START)) } catch (_: Exception) {} }

    private val told = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private fun notifyOnce(key: String, title: String, text: String) {   // the same notice at most every 10 min
        val now = System.currentTimeMillis()
        if (now - (told[key] ?: 0L) < 600_000) return
        told[key] = now; notify(title, text, important = true)
    }
    private fun notify(title: String, text: String, important: Boolean = false, cancelAfter: Boolean = false) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("lockqz-quiz", "LOCKqz quiz", NotificationManager.IMPORTANCE_HIGH))
        val n = android.app.Notification.Builder(this, "lockqz-quiz").setSmallIcon(R.drawable.ic_lock).setContentTitle(title)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text)).setContentText(text).setOngoing(important)
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)).build()
        nm.notify(2, n)
        if (cancelAfter) main.postDelayed({ nm.cancel(2) }, 20_000)
    }
}
