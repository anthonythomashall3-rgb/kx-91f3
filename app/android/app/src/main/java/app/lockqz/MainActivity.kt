package app.lockqz

import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.net.VpnService
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.Executors

/** Setup in three taps + the pay page: 1) school email (confirmed by an emailed code), 2) turn on quiz
 *  detection (Accessibility), 3) allow the AI block (VPN). Then nothing to do until the exam. */
class MainActivity : Activity() {
    private val exec = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var b1: Button; private lateinit var b2: Button; private lateinit var b3: Button; private lateinit var b4: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad * 2, pad, pad) }
        col.addView(TextView(this).apply { text = "LOCKqz"; textSize = 36f; setTypeface(null, Typeface.BOLD); setTextColor(Color.parseColor("#990000")); gravity = Gravity.CENTER })
        status = TextView(this).apply { textSize = 15f; setPadding(0, pad, 0, pad) }
        col.addView(status)
        b1 = step("1. Confirm your school email") { setupEmail() }
        b2 = step("2. Turn on quiz detection") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        b3 = step("3. Allow the AI block") { val i = VpnService.prepare(this); if (i != null) startActivityForResult(i, 1) else onActivityResult(1, RESULT_OK, null) }
        b4 = step("4. Pay the semester fee") { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${Api.SITE}/pay"))) }
        for (b in listOf(b1, b2, b3, b4)) col.addView(b)
        col.addView(TextView(this).apply { text = "Install + payment required to open your Brightspace exams.\nTake quizzes in Chrome, Firefox, Samsung Internet, Edge or Brave."; textSize = 13f; setPadding(0, pad, 0, 0); setTextColor(Color.parseColor("#7a1414")) })
        setContentView(ScrollView(this).apply { addView(col) })
        if (android.os.Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 2)
    }
    private fun step(label: String, onClick: () -> Unit) = Button(this).apply { text = label; isAllCaps = false; textSize = 16f; setOnClickListener { onClick() } }

    override fun onResume() { super.onResume(); refresh() }

    private fun accessibilityOn(): Boolean {
        val s = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return s.contains("$packageName/") || QuizAccessibilityService.instance != null
    }

    private fun refresh() {
        val email = Api.student(this); val ver = Api.verified(this)
        val a11y = accessibilityOn(); val vpn = VpnService.prepare(this) == null
        b1.text = if (ver) "✓ $email" else if (email != null) "1. Confirm the code sent to $email" else "1. Confirm your school email"
        b2.text = if (a11y) "✓ Quiz detection on" else "2. Turn on quiz detection"
        b3.text = if (vpn) "✓ AI block allowed" else "3. Allow the AI block"
        status.text = if (ver && a11y && vpn) "LOCKqz is ready. Nothing to do until your exam — just open it in Brightspace."
                      else "Finish the steps below. Each is needed to open your Brightspace exams."
        if (vpn && a11y && !DnsVpnService.running) DnsVpnService.start(this)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == 1 && resultCode == RESULT_OK) DnsVpnService.start(this)
        refresh()
    }

    // ---- email + code (same server flow as the computers: /verify status/check/send/code/token) ----
    private fun setupEmail() {
        exec.execute {
            val st = Api.verify(this, "status")
            if (st == null) { say("LOCKqz can't reach its server right now. Try again in a minute."); return@execute }
            if (st.optBoolean("verified") && st.has("student")) { Api.setStudent(this, st.optString("student"), true, st.optString("vtoken").ifEmpty { null }); main.post { refresh() }; return@execute }
            val saved = Api.student(this); val vt = Api.vtoken(this)
            if (saved != null && vt != null) {
                val r = Api.verify(this, "token", email = saved, vtoken = vt)
                if (r?.optBoolean("verified") == true) { Api.setStudent(this, saved, true, r.optString("vtoken").ifEmpty { vt }); main.post { refresh() }; return@execute }
            }
            main.post { askEmail(saved ?: "") }
        }
    }
    private fun askEmail(prefill: String) {
        val input = EditText(this).apply { inputType = InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS; setText(prefill); hint = "you@usc.edu" }
        AlertDialog.Builder(this).setTitle("LOCKqz setup (one time only)").setMessage("Enter your school email (the one Brightspace uses):").setView(input)
            .setPositiveButton("OK") { _, _ ->
                val email = input.text.toString().trim().lowercase()
                if (!Regex("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$").matches(email)) { say("That is not an email address."); return@setPositiveButton }
                exec.execute {
                    val chk = Api.verify(this, "check", email = email)
                    val name = chk?.optString("name", "")?.ifEmpty { null }
                    main.post {
                        AlertDialog.Builder(this).setTitle(if (name != null) "Is this you?" else "Not on a class list yet")
                            .setMessage(if (name != null) "$name\n$email" else "$email is not on a LOCKqz class list yet. Check the spelling.")
                            .setNegativeButton(if (name != null) "No, retype" else "Retype") { _, _ -> askEmail(email) }
                            .setPositiveButton(if (name != null) "Yes" else "Use it") { _, _ -> Api.setStudent(this, email, false); sendCode(email) }.show()
                    }
                }
            }.setNegativeButton("Cancel", null).show()
    }
    private fun sendCode(email: String, resend: Boolean = false) {
        exec.execute {
            val r = Api.verify(this, "send", email = email)
            when {
                r?.optBoolean("bound") == true -> { Api.setStudent(this, email, false); main.post { refresh() } }   // codes off on the server
                r?.optBoolean("sent") == true -> main.post { askCode(email, if (resend) "New code sent.\n\n" else "") }
                else -> say("LOCKqz couldn't send the code (${r?.optString("error") ?: "no answer"}). Try again in a few minutes.")
            }
        }
    }
    private fun askCode(email: String, note: String) {
        val input = EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER; hint = "6-digit code" }
        AlertDialog.Builder(this).setTitle("Check your email").setMessage(note + "We emailed a 6-digit code to\n$email\n\nType it here (check Junk/Spam if you don't see it):").setView(input)
            .setPositiveButton("OK") { _, _ ->
                val code = input.text.toString().trim()
                exec.execute {
                    val r = Api.verify(this, "code", email = email, code = code)
                    when {
                        r?.optBoolean("verified") == true -> { Api.setStudent(this, email, true, r.optString("vtoken").ifEmpty { null }); say("Done. LOCKqz is set up and won't ask again."); main.post { refresh() } }
                        r?.optBoolean("resent") == true -> main.post { askCode(email, if (r.optString("error") == "expired") "That code expired. We sent a new one.\n\n" else "Too many wrong tries. We sent a new code.\n\n") }
                        r?.optString("error") == "wrong_code" -> main.post { askCode(email, "That code is wrong (${r.optInt("tries_left")} tries left).\n\n") }
                        else -> say("Could not check the code (${r?.optString("error") ?: "no answer"}). Try again.")
                    }
                }
            }.setNeutralButton("Send new code") { _, _ -> sendCode(email, resend = true) }
            .setNegativeButton("Change email") { _, _ -> Api.setStudent(this, null, false); askEmail("") }.show()
    }
    private fun say(msg: String) { main.post { AlertDialog.Builder(this).setTitle("LOCKqz").setMessage(msg).setPositiveButton("OK", null).show() } }
}

/** After a reboot: bring the AI-block tunnel back (consent persists), so the phone is ready without a tap. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (i.action == Intent.ACTION_BOOT_COMPLETED && VpnService.prepare(c) == null) DnsVpnService.start(c)
    }
}
