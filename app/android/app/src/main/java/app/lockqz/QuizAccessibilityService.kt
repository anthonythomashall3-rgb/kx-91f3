package app.lockqz

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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
 *  block on, signed lock report, password fetched and entered in the quiz page's password box by LOCKqz:
 *  never shown or copied), while locked it sends AI apps home and pings the server, and when the quiz page
 *  is gone (submitted / left / closed) it unlocks. */
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
    @Volatile private var pwShown: String? = null       // the quiz password LOCKqz holds: entered by LOCKqz, never shown
    @Volatile private var pwSince = 0L
    @Volatile private var pwFilledAt = 0L
    @Volatile private var pwTried = 0L
    @Volatile private var pwTold = false
    @Volatile private var pwNoted = false
    @Volatile private var held = false                   // the server has not vouched for the quiz end yet: block stays
    @Volatile private var holdUntil = 0L
    @Volatile private var askFailSince = 0L
    @Volatile private var pwNext = 0L
    @Volatile private var lastVerCheck = 0L
    private val capped = java.util.concurrent.ConcurrentHashMap<String, Long>()   // released quiz id -> last time its page was seen
    private val browsers = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()   // every app that opens https links
    @Volatile private var otherProfileTold = false
    @Volatile private var pdnsTold = false               // Private DNS already reported for this lock
    @Volatile private var exam: Rules.Exam? = null       // the professor's rules for the locked exam (null: LOCKqz's own lists)
    @Volatile private var lastBack = 0L
    private val labels = java.util.concurrent.ConcurrentHashMap<String, String>()   // package -> app name ("" = a system app)
    private val catalog: JSONObject? by lazy { try { JSONObject(assets.open("rules-catalog.json").bufferedReader().use { it.readText() }) } catch (_: Exception) { null } }

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
            // The professor's rules: an allowed row's apps stay open (a chat app the professor allows), a blocked row's go
            // home, and so does an app the professor named (never one of the phone's own).
            val ex = exam
            val ai = pkg in AI_APPS && (ex == null || pkg !in ex.keep)
            val shut = ex != null && pkg != packageName && (pkg in ex.close || typedApp(pkg, ex))
            if (ai || shut || (pkg in browsers && pkg !in URL_BARS && pkg != packageName)) {
                // an AI app, an app not open in this exam, or a browser LOCKqz cannot read (proxy browsers render AI sites on their servers)
                performGlobalAction(GLOBAL_ACTION_HOME)
                main.post { Toast.makeText(this, if (ai) "LOCKqz: AI is off during your quiz" else if (shut) "LOCKqz: this app is not open during your exam" else "LOCKqz: use Chrome, Firefox, Samsung Internet, Edge or Brave during the quiz", Toast.LENGTH_SHORT).show() }
                return
            }
            if (pkg == "com.google.android.googlequicksearchbox") { performGlobalAction(GLOBAL_ACTION_BACK); return }   // Assistant / Gemini overlay, Circle to Search
        }
        val barId = URL_BARS[pkg] ?: return
        val root = rootInActiveWindow ?: return
        val url = readUrl(root, barId) ?: return
        onUrl(url)
        // The professor's rules: with all other websites blocked, a page the exam does not open goes back (so does a Google
        // search when web search is blocked). Never while the student is typing in the address bar.
        val ex = exam
        if (quiz != null && ex != null && !barFocused(root, barId)) {
            val u = innerUrl(url); val now = System.currentTimeMillis()
            if ((!Rules.opens(ex, u, quizHost()) || (!ex.search && Rules.isSearch(u))) && !isQuizPage(u) && now - lastBack > 1500) {
                lastBack = now; performGlobalAction(GLOBAL_ACTION_BACK)
                main.post { Toast.makeText(this, "LOCKqz: this site is not open during your exam", Toast.LENGTH_SHORT).show() }
                return
            }
        }
        if (quiz != null && pwShown != null) fillPassword(root, url)
    }

    private fun barFocused(root: AccessibilityNodeInfo, id: String): Boolean =
        try { root.findAccessibilityNodeInfosByViewId(id).any { it.isFocused } } catch (_: Exception) { false }
    private fun hostOf(u: String): String = try { java.net.URI(if ("://" in u.take(12)) u else "https://$u").host?.lowercase() ?: "" } catch (_: Exception) { "" }
    private fun quizHost(): String = hostOf(quizUrl ?: "")
    /** An app the professor named in "Also block" (by its name on the phone); never one of the phone's own apps. */
    private fun typedApp(pkg: String, ex: Rules.Exam): Boolean {
        if (ex.typed.isEmpty()) return false
        val name = labels.getOrPut(pkg) {
            try {
                val ai = packageManager.getApplicationInfo(pkg, 0)
                if ((ai.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0) "" else packageManager.getApplicationLabel(ai).toString().lowercase()
            } catch (_: Exception) { "" }
        }
        return name.isNotEmpty() && name in ex.typed
    }
    /** The professor's rules for this exam -> this exam's DNS list and apps; none: LOCKqz's own lists as always. */
    private fun applyRules(r: JSONObject?, url: String) {
        val cat = catalog
        val e = if (cat != null && r != null) Rules.exam(cat, r, Api.blocklist(this), hostOf(innerUrl(url))) else null
        exam = e
        DnsVpnService.setBlocklist(e?.hosts ?: Api.blocklist(this))
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
        if (quiz == null && now - lastVerCheck > 6 * 3600_000L) { lastVerCheck = now; exec.execute { checkUpdate() } }
        for ((id, seen) in capped) if (now - seen > 2 * GRACE_MS) capped.remove(id)   // page gone for a minute: a new attempt locks again
        val q = quiz ?: return
        if (!held && now - lastSeen > GRACE_MS) { exec.execute { end("quiz_closed") }; return }
        if (held && now - lastSeen > GRACE_MS && now >= holdUntil) { exec.execute { end("quiz_closed") }; return }   // ask again (30 s)
        if (now - lastBeat > (if (held) HOLD_BEAT_MS else BEAT_MS)) { lastBeat = now; exec.execute { beat(q) } }
        val u = quizUrl
        if (!held && u != null && "/attempt/" !in parts(u).first && now >= pwNext) { pwNext = now + 15_000; exec.execute { password(u, q, quiet = true) } }   // gated: new code every 5 min
        if (pwShown != null && u != null && "/attempt/" !in parts(u).first) {
            rootInActiveWindow?.let { r -> r.packageName?.toString()?.let { URL_BARS[it] }?.let { id -> readUrl(r, id)?.let { fillPassword(r, it) } } }
            if (pwFilledAt == 0L && !pwTold && now - pwSince > 40_000) {
                pwTold = true; notify("LOCKqz has the quiz password ready", "Open the quiz's start page (the one with Start Quiz): LOCKqz enters it there.")
            }
        }
    }

    private fun start(url: String, id: String) {
        if (quiz != null) return
        if (!Api.verified(this) && Api.student(this) == null) { notify("Finish LOCKqz setup", "Open LOCKqz and confirm your school email to get quiz passwords."); return }
        if (!DnsVpnService.running) { try { DnsVpnService.start(this) } catch (e: Exception) { Log.w(TAG, "vpn start: $e") }; Thread.sleep(1500) }
        if (!DnsVpnService.running) { notifyOnce("vpn", "LOCKqz is off", "Open LOCKqz and allow the AI block (VPN) to get the quiz password."); return }
        DnsVpnService.setBlocklist(Api.blocklist(this)); exam = null   // another exam's rules never carry over
        DnsVpnService.locked = true; quiz = id; quizUrl = url; lastSeen = System.currentTimeMillis(); missingSince = 0; pwShown = null; held = false; holdUntil = 0; askFailSince = 0; pwNext = 0; pdnsTold = false
        pwFilledAt = 0; pwTold = false; pwNoted = false
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
            if (!quiet) { pdnsTold = true; Api.report(this, "tamper", id, JSONObject().put("detail", "private_dns:$srv")); notifyOnce("pdns", "Turn Private DNS off", "Settings > Network & internet > Private DNS > Off. LOCKqz gives you the quiz password once it is off.") }
            main.postDelayed({ if (quiz == id && pwShown == null) exec.execute { password(quizUrl ?: url, id) } }, 15_000); return
        }
        val (code, j) = Api.password(this, url)
        val pw = j?.optString("password", "")?.takeIf { it.isNotEmpty() && code == 200 }
        if (pw != null) {
            if (quiz == id) applyRules(j?.optJSONObject("rules"), url)
            if (pwShown != pw) { pwShown = pw; showPassword(pw) }
            return
        }
        if (quiet) return
        val pay = j?.optJSONObject("pay")
        if (pay != null) {
            if (!getSharedPreferences("lockqz", Context.MODE_PRIVATE).getBoolean("pay_shown_$id", false)) {
                getSharedPreferences("lockqz", Context.MODE_PRIVATE).edit().putBoolean("pay_shown_$id", true).apply()
                val line = if (pay.isNull("line")) "" else pay.optString("line").trim().trimEnd('.')   // each way at its own price: "$200 by Zelle, or $210 by card or Venmo"
                val memo = if (!pay.isNull("zelle") || !pay.isNull("venmo")) " Memo for Zelle or Venmo: ${pay.optString("code")}." else ""
                notify("Pay for LOCKqz this semester", (if (line.isNotEmpty()) "$line.$memo " else "Memo: ${pay.optString("code")}. ") + "The quiz password comes as soon as your payment arrives.")
                try { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(pay.optString("url", "${Api.WEB}/pay"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
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

    /** The quiz password is never shown or copied (a password a student can read can be passed to a device without
     *  LOCKqz): LOCKqz enters it in the quiz page's password box itself (fillPassword, on every look while the quiz's
     *  start page is in front). */
    private fun showPassword(pw: String) {
        pwSince = System.currentTimeMillis(); pwFilledAt = 0; pwTold = false
        main.post { rootInActiveWindow?.let { r -> r.packageName?.toString()?.let { URL_BARS[it] }?.let { id -> readUrl(r, id)?.let { fillPassword(r, it) } } } }
        if (!pwNoted) { pwNoted = true; notify("AI is off for your quiz", "LOCKqz enters the quiz password for you. Just start the quiz. AI stays off until you submit.", important = true) }
    }

    /** Puts the password into each empty password box of the locked quiz's own start page in the browser in front
     *  (never inside the attempt, never another page), at most once a second. -> boxes filled now. */
    private fun fillPassword(root: AccessibilityNodeInfo, rawUrl: String): Int {
        val pw = pwShown ?: return 0
        val now = System.currentTimeMillis()
        if (now - pwTried < 1000) return 0
        pwTried = now
        val url = innerUrl(rawUrl)
        if (!isQuiz(url) || lockId(url) != quiz || "/attempt/" in parts(url).first) return 0
        var n = 0
        try {
            val todo = ArrayDeque<AccessibilityNodeInfo>(); todo.add(root)
            var seen = 0
            while (todo.isNotEmpty() && seen < 3000) {
                val node = todo.removeLast(); seen++
                if (node.isPassword && node.isEditable && node.text.isNullOrEmpty()) {
                    val args = android.os.Bundle()
                    args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, pw)
                    if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) n++
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let { todo.add(it) }
            }
        } catch (e: Exception) { Log.w(TAG, "password box: $e") }
        if (n > 0) { pwFilledAt = now; Log.i(TAG, "quiz password entered in the quiz page ($n box)") }
        return n
    }

    private fun beat(id: String) {
        // Private DNS switched on in the middle of the quiz: the professor is told once, the student is told how to undo it.
        val srv = privateDnsOn()
        if (srv == null) pdnsTold = false
        else if (!pdnsTold) { pdnsTold = true; Api.report(this, "tamper", id, JSONObject().put("detail", "private_dns:$srv")); notify("Turn Private DNS off", "Settings > Network & internet > Private DNS > Off. Your professor sees that it is on.", important = true) }
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
        if (held && now < holdUntil) return   // asked < 30 s ago (ticks queued while the answer was on its way): one ask per 30 s
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
        quiz = null; quizUrl = null; pwShown = null; held = false; holdUntil = 0; askFailSince = 0   // the next quiz's 10-minute wait starts fresh
        exam = null   // the professor's rules end with the exam
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
    /** A newer LOCKqz on the site: one notification per version (never during a quiz); tapping it downloads the
     *  new app, which installs over this one (same signing key). Android apps do not update themselves. */
    private fun checkUpdate() {
        val v = Api.latestVersion(this) ?: return
        if (quiz != null || !Api.newer(v, BuildConfig.VERSION_NAME)) return
        val p = getSharedPreferences("lockqz", Context.MODE_PRIVATE)
        if (p.getString("update_told", null) == v) return
        p.edit().putString("update_told", v).apply()
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(NotificationChannel("lockqz-quiz", "LOCKqz quiz", NotificationManager.IMPORTANCE_HIGH))
            val open = PendingIntent.getActivity(this, 1, Intent(Intent.ACTION_VIEW, android.net.Uri.parse("${Api.WEB}/download/lockqz-android.apk")), PendingIntent.FLAG_IMMUTABLE)
            nm.notify(3, android.app.Notification.Builder(this, "lockqz-quiz").setSmallIcon(R.drawable.ic_lock).setContentTitle("Update LOCKqz")
                .setContentText("Version $v is ready. Tap to download it, then open the file to install.").setAutoCancel(true).setContentIntent(open).build())
        } catch (e: Exception) { Log.w(TAG, "update notice: $e") }
    }
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
