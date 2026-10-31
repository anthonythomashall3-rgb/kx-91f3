package app.lockqz

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Device identity + the signed LOCKqz API, the same protocol as the Mac/Windows/Linux helpers:
 *  register once (trust on first use), then every POST carries
 *  X-LOCKqz-Device / X-LOCKqz-Time / X-LOCKqz-Sig = hex(HMAC-SHA256(key, "POST\n<path>\n<time>\n<sha256(body)>")). */
object Api {
    const val SITE = "https://lockqz.pages.dev"
    const val BASE = "$SITE/api"
    private const val TAG = "LOCKqz"
    @Volatile var skew = 0L          // server clock - ours (seconds), learnt from a 401
    @Volatile var registered = false

    private fun prefs(c: Context) = c.getSharedPreferences("lockqz", Context.MODE_PRIVATE)
    fun deviceId(c: Context): String {
        val p = prefs(c); p.getString("device_id", null)?.let { return it }
        val id = "android-" + java.util.UUID.randomUUID().toString()
        p.edit().putString("device_id", id).apply(); return id
    }
    fun key(c: Context): String {
        val p = prefs(c); p.getString("device_key", null)?.let { return it }
        val b = ByteArray(32); SecureRandom().nextBytes(b)
        val k = b.joinToString("") { "%02x".format(it) }
        p.edit().putString("device_key", k).apply(); return k
    }
    fun student(c: Context): String? = prefs(c).getString("student", null)
    fun setStudent(c: Context, email: String?, verified: Boolean, vtoken: String? = null) {
        val e = prefs(c).edit().putString("student", email).putBoolean("verified", verified)
        if (vtoken != null) e.putString("vtoken", vtoken)
        e.apply()
    }
    fun verified(c: Context) = prefs(c).getBoolean("verified", false)
    fun vtoken(c: Context): String? = prefs(c).getString("vtoken", null)
    fun platform() = "android-${Build.VERSION.RELEASE}-${Build.MANUFACTURER}".take(60)

    private fun sha256Hex(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun hmacHex(key: String, msg: String): String {
        val mac = Mac.getInstance("HmacSHA256"); mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
        return mac.doFinal(msg.toByteArray()).joinToString("") { "%02x".format(it) }
    }

    /** POST JSON; (status, json). Signed with the device key unless [signed] is false. Never throws. */
    fun call(c: Context, path: String, body: JSONObject, signed: Boolean = true): Pair<Int, JSONObject?> {
        val raw = body.toString().toByteArray()
        for (attempt in 0..2) {
            try {
                val url = URL(BASE + path)
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 8000; readTimeout = 8000; doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("User-Agent", "LOCKqz/${BuildConfig.VERSION_NAME} (Android)")
                    if (signed) {
                        val ts = (System.currentTimeMillis() / 1000 + skew).toString()
                        val msg = "POST\n${url.path}\n$ts\n${sha256Hex(raw)}"
                        setRequestProperty("X-LOCKqz-Device", deviceId(c)); setRequestProperty("X-LOCKqz-Time", ts)
                        setRequestProperty("X-LOCKqz-Sig", hmacHex(key(c), msg))
                    }
                }
                conn.outputStream.use { it.write(raw) }
                val code = conn.responseCode
                val stream = if (code < 400) conn.inputStream else conn.errorStream
                val text = stream?.use { s -> ByteArrayOutputStream().also { s.copyTo(it) }.toString("UTF-8") } ?: ""
                val j = try { JSONObject(text) } catch (_: Exception) { null }
                if (code == 401 && signed && attempt < 2 && j != null) {
                    if (j.has("server_time")) skew = j.optLong("server_time") - System.currentTimeMillis() / 1000
                    if (j.optString("why") == "unregistered") { registered = false; register(c) }
                    continue
                }
                return Pair(code, j)
            } catch (e: Exception) {
                Log.w(TAG, "api $path: $e"); if (attempt == 2) return Pair(0, null); Thread.sleep(2000L * (attempt + 1))
            }
        }
        return Pair(0, null)
    }

    fun register(c: Context): Boolean {
        if (registered) return true
        val (code, _) = call(c, "/register", JSONObject().put("device_id", deviceId(c)).put("key", key(c))
            .put("version", BuildConfig.VERSION_NAME).put("platform", platform()).put("student", student(c) ?: JSONObject.NULL), signed = false)
        if (code == 200) registered = true
        return registered
    }

    fun report(c: Context, event: String, quizId: String?, extra: JSONObject? = null): Pair<Int, JSONObject?> {
        register(c)
        val b = JSONObject().put("device_id", deviceId(c)).put("event", event).put("quiz_id", quizId ?: JSONObject.NULL)
            .put("student", student(c) ?: JSONObject.NULL)
            .put("ts", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date()))
        if (extra != null) for (k in extra.keys()) b.put(k, extra.get(k))
        return call(c, "/report", b)
    }

    /** "" on a real phone; a short name on an emulator (Android Studio, Genymotion, BlueStacks ...). A quiz taken in
     *  an emulator is locked only inside it - the computer around it keeps AI - so the server gives no password. */
    fun emulator(): String {
        val f = Build.FINGERPRINT.lowercase(); val h = Build.HARDWARE.lowercase(); val p = Build.PRODUCT.lowercase()
        val m = Build.MODEL.lowercase(); val man = Build.MANUFACTURER.lowercase(); val b = Build.BRAND.lowercase()
        return when {
            h == "goldfish" || h == "ranchu" || h.startsWith("vbox") || h.contains("nox") || h == "ttvm_x86" -> "emulator-$h"
            f.startsWith("generic") || f.contains("emulator") || f.contains("vbox") || f.contains("test-keys") && b == "generic" -> "emulator"
            p.contains("sdk_gphone") || p.contains("emulator") || p.contains("simulator") || p.startsWith("sdk") || p.contains("vbox86p") || p.contains("bluestacks") -> "emulator-$p".take(40)
            m.contains("android sdk built for") || m.contains("emulator") || man.contains("genymotion") || b.contains("bluestacks") -> "emulator"
            else -> ""
        }
    }
    fun password(c: Context, url: String) = call(c, "/password", JSONObject().put("url", url).put("device_id", deviceId(c))
        .apply { val e = emulator(); if (e.isNotEmpty()) put("vm", e) })

    /** One-time student email setup: op = status | check | send | code | token | google_start. */
    fun verify(c: Context, op: String, email: String? = null, code: String? = null, vtoken: String? = null): JSONObject? {
        val b = JSONObject().put("op", op).put("device_id", deviceId(c))
        if (email != null) b.put("email", email); if (code != null) b.put("code", code); if (vtoken != null) b.put("vtoken", vtoken)
        register(c)
        val (st, j) = call(c, "/verify", b)
        return j?.also { it.put("status", st) }
    }

    /** The served AI blocklist (plain hosts), cached; the built-in seed until the first fetch succeeds. */
    fun blocklist(c: Context, refresh: Boolean = false): List<String> {
        val p = prefs(c)
        val cached = p.getString("blocklist", null)
        val age = System.currentTimeMillis() - p.getLong("blocklist_at", 0)
        if (cached != null && !refresh && age < 12 * 3600_000L) return cached.split('\n').filter { it.isNotBlank() }
        try {
            val conn = (URL("$BASE/blocklist").openConnection() as HttpURLConnection).apply { connectTimeout = 8000; readTimeout = 8000; setRequestProperty("User-Agent", "LOCKqz/${BuildConfig.VERSION_NAME} (Android)") }
            val text = conn.inputStream.use { s -> ByteArrayOutputStream().also { s.copyTo(it) }.toString("UTF-8") }
            val arr = JSONObject(text).getJSONArray("domains")
            val hosts = (0 until arr.length()).map { arr.getString(it).lowercase() }.filter { Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$").matches(it) }
            if (hosts.size > 50) { p.edit().putString("blocklist", hosts.joinToString("\n")).putLong("blocklist_at", System.currentTimeMillis()).apply(); return hosts }
        } catch (e: Exception) { Log.w(TAG, "blocklist: $e") }
        return cached?.split('\n')?.filter { it.isNotBlank() } ?: SEED
    }

    val SEED = listOf("openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com", "anthropic.com", "claude.ai", "gemini.google.com",
        "bard.google.com", "generativelanguage.googleapis.com", "copilot.microsoft.com", "perplexity.ai", "grok.com", "x.ai", "deepseek.com",
        "mistral.ai", "poe.com", "character.ai", "meta.ai", "pi.ai", "you.com", "kagi.com", "notebooklm.google.com", "huggingface.co",
        "web.whatsapp.com", "web.telegram.org", "discord.com", "quillbot.com", "chat.z.ai", "kimi.com", "qwen.ai")
}
