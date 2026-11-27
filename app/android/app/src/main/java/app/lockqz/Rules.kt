package app.lockqz

import org.json.JSONArray
import org.json.JSONObject

/** Exam rules (27 Nov 2026): what the professor lets students use in this exam (the /password answer's "rules": the
 *  blocked row keys, the professor's own sites and programs). Each row's apps and sites are LOCKqz's own
 *  (assets/rules-catalog.json, the same file as the computers'): a blocked row's apps are sent home and its sites stop
 *  answering; an allowed row's apps and sites stay open even when they are on LOCKqz's own lists; with all other
 *  websites blocked, a browser page the exam does not open is sent back. AI is always blocked. */
object Rules {
    class Exam(val label: String, val hosts: List<String>, val close: Set<String>, val keep: Set<String>,
               val typed: Set<String>, val web: List<String>?, val search: Boolean)

    private val HOST = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z][a-z0-9-]+$")
    private val NAME = Regex("^[A-Za-z0-9][A-Za-z0-9 ._&+()'-]{0,59}$")
    private val PROG = Regex("\\.(app|exe)$", RegexOption.IGNORE_CASE)
    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)

    /** A site typed by the professor -> its host ("https://www.x.com/a" -> "x.com"), "" when it is not a site. */
    fun host(v: String): String {
        var s = v.trim().lowercase().replace(SCHEME, "")
        s = s.split(Regex("[/?#]"), 2)[0].replace(Regex(":\\d+$"), "").trimEnd('.')
        if (s.startsWith("www.")) s = s.substring(4)
        return if (s.length <= 100 && HOST.matches(s)) s else ""
    }
    fun under(h: String, d: String) = h == d || h.endsWith(".$d")
    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.opt(it) as? String }

    /** The catalog and the server's rules -> this exam; null without rules (LOCKqz as always). aiHosts = LOCKqz's own list. */
    fun exam(catalog: JSONObject, rules: JSONObject?, aiHosts: List<String>, quizHost: String): Exam? {
        val r = rules ?: return null
        val b = r.optJSONArray("b") ?: return null
        val rows = catalog.optJSONObject("rows") ?: return null
        val keys = rows.keys().asSequence().toList()
        val blocked = strs(b).filter { it in keys }.toSet()
        val allowed = keys.filter { it !in blocked }
        fun row(k: String, f: String) = strs(rows.optJSONObject(k)?.optJSONArray(f))
        // An allowed row's own sites leave the list; nothing else ever does.
        val gone = allowed.flatMap { row(it, "hosts") + row(it, "paths") }.map { it.lowercase() }.toSet()
        val out = LinkedHashSet<String>()
        for (h in aiHosts) { val e = h.lowercase(); if (e !in gone) out.add(e) }
        val add = blocked.flatMap { row(it, "hosts") }.toMutableList()
        if ("search" in blocked) add += strs(catalog.optJSONArray("search_hosts")).filter { '/' !in it }
        val keepSites = strs(catalog.optJSONArray("base_allow")).map { it.substringBefore('/') }
        val never = strs(catalog.optJSONArray("never_close")).map { it.lowercase() }.toSet()
        val typed = LinkedHashSet<String>()
        for (x in strs(r.optJSONArray("block")).take(20)) {
            val h = if (x.endsWith(".exe", ignoreCase = true)) "" else host(x)
            // never the exam, sign-in or LOCKqz (the server refuses them too)
            if (h.isNotEmpty() && keepSites.none { under(it, h) || under(h, it) }) add += h
            val n = if (PROG.containsMatchIn(x)) x.replace(PROG, "") else if (h.isNotEmpty()) "" else x
            if (n.isNotEmpty() && NAME.matches(n) && n.lowercase() !in never) typed += n.lowercase()
        }
        for (e in add) { val l = e.lowercase(); if (HOST.matches(l)) out.add(l) }
        val close = blocked.flatMap { row(it, "android") }.toSet()
        val keep = allowed.flatMap { row(it, "android") }.toSet()
        var web: List<String>? = null
        if ("web" in blocked) {
            val bh = out.toList()
            val allow = strs(r.optJSONArray("allow")).map { host(it) }.filter { it.isNotEmpty() }.take(20)
            val cand = strs(catalog.optJSONArray("base_allow")) + allowed.flatMap { row(it, "hosts") + row(it, "paths") + row(it, "web") } +
                (if (HOST.matches(quizHost)) listOf(quizHost) else emptyList()) + allow
            val w = LinkedHashSet<String>()
            for (e0 in cand) {
                val e = e0.lowercase()
                if (e in allow && bh.any { under(e.substringBefore('/'), it) }) continue   // a typed site never opens a blocked one
                w.add(e)
            }
            web = w.toList()
        }
        return Exam(r.optString("label", ""), out.toList(), close, keep, typed, web, "search" !in blocked)
    }

    /** May this page stay open in this exam? url as the address bar shows it (the scheme may be hidden). */
    fun opens(e: Exam, url: String, quizHost: String): Boolean {
        val web = e.web ?: return true
        val u = if (SCHEME.containsMatchIn(url)) url else "https://$url"
        val p = try { java.net.URI(u) } catch (_: Exception) { return true }
        val sc = (p.scheme ?: "").lowercase()
        if (sc != "http" && sc != "https") return true
        val h = (p.host ?: return true).lowercase(); val hs = h.removePrefix("www.")
        val path = (p.rawPath ?: "").ifEmpty { "/" }.lowercase()
        if (quizHost.isNotEmpty() && (h == quizHost || hs == quizHost)) return true
        return web.any { w ->
            val d = w.substringBefore('/')
            (h == d || hs == d || h.endsWith(".$d")) && (w.indexOf('/') < 0 || path.startsWith("/" + w.substringAfter('/', "")))
        }
    }

    /** A Google web search page (closed when the professor blocks web search). */
    fun isSearch(url: String): Boolean {
        val u = if (SCHEME.containsMatchIn(url)) url else "https://$url"
        val p = try { java.net.URI(u) } catch (_: Exception) { return false }
        val h = (p.host ?: return false).lowercase()
        return Regex("^(www\\.)?google\\.[a-z.]+$").matches(h) && (p.rawPath ?: "").startsWith("/search")
    }
}
