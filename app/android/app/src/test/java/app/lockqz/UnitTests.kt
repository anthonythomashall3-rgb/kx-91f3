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
}
