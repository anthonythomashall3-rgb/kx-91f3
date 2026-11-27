package app.lockqz

import org.junit.Assert.*
import org.junit.Test

class UnitTests {
    private fun query(name: String, type: Int): ByteArray {
        val b = java.nio.ByteBuffer.allocate(512)
        b.putShort(0x1234.toShort()); b.putShort(0x0100.toShort()); b.putShort(1); b.putShort(0); b.putShort(0); b.putShort(0)
        for (p in name.split('.')) { b.put(p.length.toByte()); b.put(p.toByteArray()) }
        b.put(0); b.putShort(type.toShort()); b.putShort(1)
        return b.array().copyOf(b.position())
    }
    @Test fun dnsName() { assertEquals("chat.openai.com", Dns.qname(query("chat.openai.com", 1))) }
    @Test fun blackholeA() {
        val r = Dns.blackhole(query("chatgpt.com", 1))
        assertEquals(0x12, r[0].toInt() and 255); assertEquals(0x34, r[1].toInt() and 255)      // same id
        assertEquals(1, ((r[6].toInt() and 255) shl 8) or (r[7].toInt() and 255))                // one answer
        assertArrayEquals(byteArrayOf(0, 0, 0, 0), r.copyOfRange(r.size - 4, r.size))             // 0.0.0.0
    }
    @Test fun blackholeAAAA() { val r = Dns.blackhole(query("claude.ai", 28)); assertArrayEquals(ByteArray(16), r.copyOfRange(r.size - 16, r.size)) }
    @Test fun blackholeOtherTypeHasNoAnswer() { val r = Dns.blackhole(query("claude.ai", 16)); assertEquals(0, ((r[6].toInt() and 255) shl 8) or (r[7].toInt() and 255)) }
    @Test fun udpReplySwapsAddressesAndChecksums() {
        val q = query("x.y", 1)
        val req = java.nio.ByteBuffer.allocate(28 + q.size)
        req.put(0x45); req.put(0); req.putShort((28 + q.size).toShort()); req.putShort(1); req.putShort(0); req.put(64); req.put(17); req.putShort(0)
        req.put(byteArrayOf(10, 111, 222.toByte(), 2)); req.put(byteArrayOf(10, 111, 222.toByte(), 1)); req.putShort(40000.toShort()); req.putShort(53); req.putShort((8 + q.size).toShort()); req.putShort(0); req.put(q)
        val r = Dns.udpReply(req.array(), 20, Dns.blackhole(q))
        assertArrayEquals(byteArrayOf(10, 111, 222.toByte(), 1), r.copyOfRange(12, 16)); assertArrayEquals(byteArrayOf(10, 111, 222.toByte(), 2), r.copyOfRange(16, 20))
        assertEquals(53, ((r[20].toInt() and 255) shl 8) or (r[21].toInt() and 255)); assertEquals(40000, ((r[22].toInt() and 255) shl 8) or (r[23].toInt() and 255))
        // IP header checksum verifies to 0
        var sum = 0L; for (i in 0 until 20 step 2) sum += (((r[i].toInt() and 255) shl 8) or (r[i + 1].toInt() and 255)).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        assertEquals(0xFFFFL, sum)
    }
    @Test fun blockedMatchesParentDomains() {
        DnsVpnService.setBlocklist(listOf("openai.com", "claude.ai")); DnsVpnService.locked = true
        assertTrue(DnsVpnService.isBlocked("chat.openai.com")); assertTrue(DnsVpnService.isBlocked("CLAUDE.AI."))
        assertFalse(DnsVpnService.isBlocked("notopenai.com")); assertFalse(DnsVpnService.isBlocked("brightspace.com"))
        DnsVpnService.locked = false; assertFalse(DnsVpnService.isBlocked("chat.openai.com"))
    }
    @Test fun wholeDomainsAreBlockedDuringAQuiz() {
        DnsVpnService.setBlocklist(listOf("openai.com")); DnsVpnService.locked = true
        for (h in listOf("my-chat.workers.dev", "x.y.vercel.app", "abc123.trycloudflare.com", "school.openai.azure.com", "a.ngrok-free.app", "space.hf.space"))
            assertTrue(h, DnsVpnService.isBlocked(h))
        for (h in listOf("lockqz.pages.dev", "brightspace.usc.edu", "myworkers.dev", "vercel.com")) assertFalse(h, DnsVpnService.isBlocked(h))
        DnsVpnService.locked = false; assertFalse(DnsVpnService.isBlocked("my-chat.workers.dev"))
    }
    @Test fun quizUrls() {
        val c = QuizAccessibilityService
        val attempt = "https://usc.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=123&isprv=0&qi=456"
        assertTrue(c.isQuiz(attempt)); assertEquals("123-456", c.lockId(attempt))
        assertTrue(c.isQuiz("usc.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=1&qi=2"))   // address bar without scheme
        assertTrue(c.isLeaving("https://usc.brightspace.com/d2l/lms/quizzing/user/quiz_submissions.d2l?ou=123&qi=456"))
        assertFalse(c.isQuiz("https://usc.brightspace.com/d2l/lms/quizzing/user/quizzes_list.d2l?ou=123"))
        assertFalse(c.isQuiz("https://usc.brightspace.com/d2l/home/123?returnUrl=%2Fd2l%2Flms%2Fquizzing%2Fuser%2Fattempt%2Fx%3Fqi%3D9"))
        val content = "https://usc.brightspace.com/d2l/le/content/123/fullscreen/777/ViewLocation?location=%2Fd2l%2Flms%2Fquizzing%2Fuser%2Fattempt%2Fquiz_start_frame_auto.d2l%3Fou%3D123%26qi%3D456"
        assertEquals(attempt.replace("&isprv=0", ""), c.innerUrl(content)); assertTrue(c.isQuiz(c.innerUrl(content)))
    }

    // Exam rules (27 Nov 2026): the professor's rules -> this exam's DNS list, apps and open sites (catalog = the computers' file).
    private fun cat() = org.json.JSONObject(java.io.File("src/main/assets/rules-catalog.json").readText())
    private fun rules(b: List<String>, allow: List<String> = emptyList(), block: List<String> = emptyList()) = org.json.JSONObject()
        .put("label", "Custom").put("b", org.json.JSONArray(b)).put("allow", org.json.JSONArray(allow)).put("block", org.json.JSONArray(block))
    private val off = listOf("solvers", "text", "chat", "email", "calls", "youtube", "social", "homework", "writing", "translate")
    @Test fun rulesDefaultBlocksMessaging() {
        val e = Rules.exam(cat(), rules(off), listOf("chatgpt.com", "slack.com", "quizlet.com"), "usc.brightspace.com")!!
        assertTrue("zoom.us" in e.hosts && "mail.google.com" in e.hosts && "chatgpt.com" in e.hosts && "slack.com" in e.hosts)
        assertTrue("com.whatsapp" in e.close && "us.zoom.videomeetings" in e.close && "com.google.android.gm" in e.close)
        assertTrue("com.microsoft.office.word" in e.keep); assertNull(e.web); assertTrue(e.search)
    }
    @Test fun rulesAllowedRowLeavesTheLists() {
        val e = Rules.exam(cat(), rules(off - "chat" - "homework"), listOf("chatgpt.com", "slack.com", "quizlet.com"), "")!!
        assertFalse("slack.com" in e.hosts); assertFalse("quizlet.com" in e.hosts); assertTrue("chatgpt.com" in e.hosts)
        assertTrue("com.Slack" in e.keep && "com.discord" in e.keep); assertFalse("com.discord" in e.close)
    }
    @Test fun rulesNotesOnlyOpensOnlyTheExamsSites() {
        val e = Rules.exam(cat(), rules(off + listOf("search", "wiki", "web"), allow = listOf("https://www.investopedia.com/terms", "x.com")), listOf("chatgpt.com"), "lms.other.edu")!!
        assertFalse(e.search); assertTrue("bing.com" in e.hosts)
        assertTrue(Rules.opens(e, "usc.brightspace.com/d2l/home", "")); assertTrue(Rules.opens(e, "https://lms.other.edu/d2l/x", "lms.other.edu"))
        assertTrue(Rules.opens(e, "docs.google.com/document/d/1/edit", "")); assertTrue(Rules.opens(e, "https://www.investopedia.com/terms/b/bond.asp", ""))
        assertFalse(Rules.opens(e, "https://www.nytimes.com/", "")); assertFalse(Rules.opens(e, "x.com/home", "")); assertFalse(Rules.opens(e, "en.wikipedia.org/wiki/Bond", ""))
        assertTrue(Rules.isSearch("https://www.google.com/search?q=x")); assertFalse(Rules.isSearch("docs.google.com/document/d/1"))
    }
    @Test fun rulesTypedNeverTheSystemOrTheExam() {
        val e = Rules.exam(cat(), rules(off, block = listOf("Spotify", "Chrome", "khanacademy.org", "brightspace.com", "google.com")), emptyList(), "")!!
        assertTrue("spotify" in e.typed); assertFalse("chrome" in e.typed)
        assertTrue("khanacademy.org" in e.hosts); assertFalse("brightspace.com" in e.hosts); assertFalse("google.com" in e.hosts)
    }
    @Test fun noRulesMeansLockqzAsAlways() { assertNull(Rules.exam(cat(), null, listOf("chatgpt.com"), "")) }
}
