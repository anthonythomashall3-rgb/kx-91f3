package app.lockqz

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** The AI block for every app on the phone, the way ad blockers do it (no root): a local VPN that is the
 *  phone's only DNS server. While a quiz is locked, a lookup of a blocklisted host (or any name under it)
 *  is answered with 0.0.0.0 / ::, everything else is forwarded to the real resolver; the known DoH
 *  resolver addresses and the AI hosts' resolved addresses are routed INTO the tunnel and dropped
 *  (encrypted-DNS bypass closed, connections an app already held open die). Unlocked, every lookup passes.
 *  The student turning the VPN off is seen at once (onRevoke): the watcher reports it and no password comes. */
class DnsVpnService : VpnService() {
    companion object {
        const val TAG = "LOCKqz-vpn"
        const val DNS_IP = "10.111.222.1"
        const val OWN_IP = "10.111.222.2"
        const val ACTION_START = "app.lockqz.START"
        const val ACTION_STOP = "app.lockqz.STOP"
        @Volatile var running = false
        @Volatile var locked = false          // set by the watcher: block only during the quiz
        @Volatile var blocked: Set<String> = emptySet()
        @Volatile var blockIps: Set<String> = emptySet()
        @Volatile var upstream: List<InetAddress> = emptyList()
        var onRevoked: (() -> Unit)? = null
        val DOH_IPS = listOf("1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "162.159.61.3", "162.159.61.4",
            "172.64.41.3", "172.64.41.4", "146.112.41.2", "94.140.14.14", "94.140.15.15", "194.242.2.2", "76.76.2.11", "185.71.138.138",
            "223.5.5.5", "223.6.6.6", "1.12.12.12", "120.53.53.53")
        fun start(c: Context) { c.startForegroundService(Intent(c, DnsVpnService::class.java).setAction(ACTION_START)) }
        fun stop(c: Context) { c.startForegroundService(Intent(c, DnsVpnService::class.java).setAction(ACTION_STOP)) }
        fun setBlocklist(hosts: List<String>) { blocked = hosts.map { it.lowercase() }.toSet() }
        /** Is this name (or a parent domain of it) on the list? */
        fun isBlocked(name: String): Boolean {
            if (!locked) return false
            var n = name.lowercase().trimEnd('.')
            while (true) {
                if (n in blocked) return true
                val i = n.indexOf('.'); if (i < 0) return false
                n = n.substring(i + 1)
            }
        }
    }

    private var tun: ParcelFileDescriptor? = null
    private val stopFlag = AtomicBoolean(false)
    private var worker: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(1, notification())   // always, at once: a foreground start must show its notification
        if (intent?.action == ACTION_STOP) { teardown(); stopSelf(); return START_NOT_STICKY }
        if (tun == null) { establish(); if (tun == null) { teardown(); stopSelf(); return START_NOT_STICKY } }
        return START_STICKY
    }

    private fun establish() {
        try {
            upstream = realDns()
            val b = Builder().setSession("LOCKqz").setMtu(1500)
                .addAddress(OWN_IP, 32).addDnsServer(DNS_IP).addRoute(DNS_IP, 32)
            for (ip in DOH_IPS) try { b.addRoute(ip, 32) } catch (_: Exception) {}
            for (ip in blockIps) try { if (ip.contains('.')) b.addRoute(ip, 32) } catch (_: Exception) {}
            try { b.addDisallowedApplication(packageName) } catch (_: Exception) {}   // our own API calls never loop through the tunnel
            b.setConfigureIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
            tun = b.establish() ?: run { Log.w(TAG, "establish returned null (consent missing)"); return }
            running = true; stopFlag.set(false)
            worker = Thread { loop() }.apply { isDaemon = true; start() }
            Log.i(TAG, "tunnel up, upstream=$upstream, block routes=${blockIps.size}")
        } catch (e: Exception) { Log.e(TAG, "establish: $e") }
    }

    /** Re-establish with the current block routes (called by the watcher after the address list changes). */
    fun reestablish() { teardown(); establish() }

    private fun realDns(): List<InetAddress> {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val out = mutableListOf<InetAddress>()
        try {
            for (n in cm.allNetworks) {
                val caps = cm.getNetworkCapabilities(n) ?: continue
                if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) continue
                cm.getLinkProperties(n)?.dnsServers?.let { out.addAll(it) }
            }
        } catch (_: Exception) {}
        if (out.isEmpty()) out.addAll(listOf(InetAddress.getByName("8.8.8.8"), InetAddress.getByName("1.1.1.1")))
        return out.distinct()
    }

    private fun loop() {
        val fd = tun ?: return
        val input = FileInputStream(fd.fileDescriptor); val output = FileOutputStream(fd.fileDescriptor)
        val buf = ByteArray(32767)
        while (!stopFlag.get()) {
            val n = try { input.read(buf) } catch (e: Exception) { break }
            if (n <= 0) continue
            try { handle(buf, n, output) } catch (e: Exception) { Log.w(TAG, "packet: $e") }
        }
    }

    /** IPv4/UDP to DNS_IP:53 -> answer or forward. Anything else that reached the tunnel is a blocked
     *  address (DoH resolver, AI host): dropped by doing nothing. */
    private fun handle(p: ByteArray, n: Int, out: FileOutputStream) {
        if (n < 28 || (p[0].toInt() shr 4) != 4) return
        val ihl = (p[0].toInt() and 0x0f) * 4
        if (p[9].toInt() != 17) return                                     // not UDP
        val dst = "${p[16].toInt() and 255}.${p[17].toInt() and 255}.${p[18].toInt() and 255}.${p[19].toInt() and 255}"
        val dport = ((p[ihl + 2].toInt() and 255) shl 8) or (p[ihl + 3].toInt() and 255)
        if (dst != DNS_IP || dport != 53) return
        val q = p.copyOfRange(ihl + 8, n)
        val name = Dns.qname(q) ?: return
        val reply: ByteArray = if (isBlocked(name)) Dns.blackhole(q) else forward(q) ?: return
        out.write(Dns.udpReply(p, ihl, reply))
    }

    private fun forward(q: ByteArray): ByteArray? {
        for (srv in upstream) {
            try {
                DatagramSocket().use { s ->
                    protect(s); s.soTimeout = 2500
                    s.send(DatagramPacket(q, q.size, InetSocketAddress(srv, 53)))
                    val r = DatagramPacket(ByteArray(4096), 4096); s.receive(r)
                    return r.data.copyOf(r.length)
                }
            } catch (_: Exception) {}
        }
        return null
    }

    private fun notification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel("lockqz", "LOCKqz", NotificationManager.IMPORTANCE_LOW))
        return Notification.Builder(this, "lockqz").setSmallIcon(R.drawable.ic_lock).setContentTitle("LOCKqz")
            .setContentText(if (locked) "Quiz in progress: AI is blocked" else "Ready. Nothing to do until your exam.")
            .setOngoing(true).setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)).build()
    }
    fun refreshNotification() { try { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(1, notification()) } catch (_: Exception) {} }

    private fun teardown() {
        stopFlag.set(true); running = false
        try { tun?.close() } catch (_: Exception) {}; tun = null
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
    }
    override fun onRevoke() { Log.w(TAG, "VPN revoked by the user"); teardown(); onRevoked?.invoke(); super.onRevoke() }
    override fun onDestroy() { teardown(); super.onDestroy() }
}

/** Minimal DNS wire helpers. */
object Dns {
    fun qname(q: ByteArray): String? {
        if (q.size < 17) return null
        var off = 12; val parts = mutableListOf<String>()
        while (off < q.size) {
            val l = q[off].toInt() and 255; off++
            if (l == 0) break
            if (l and 0xC0 != 0 || off + l > q.size) return null
            parts.add(String(q, off, l, Charsets.US_ASCII)); off += l
        }
        return parts.joinToString(".")
    }
    private fun qtype(q: ByteArray): Int {
        var off = 12
        while (off < q.size) { val l = q[off].toInt() and 255; off++; if (l == 0) break; off += l }
        return if (off + 2 <= q.size) ((q[off].toInt() and 255) shl 8) or (q[off + 1].toInt() and 255) else 1
    }
    /** The hosts-file answer: A 0.0.0.0 / AAAA :: for the asked type (NOERROR, so nothing retries elsewhere). */
    fun blackhole(q: ByteArray): ByteArray {
        val t = qtype(q)
        val qEnd = run { var off = 12; while (off < q.size) { val l = q[off].toInt() and 255; off++; if (l == 0) break; off += l }; off + 4 }
        val b = ByteBuffer.allocate(qEnd + 32)
        b.put(q, 0, 2); b.putShort(0x8180.toShort()); b.putShort(1); b.putShort(if (t == 1 || t == 28) 1 else 0); b.putShort(0); b.putShort(0)
        b.put(q, 12, qEnd - 12)
        if (t == 1) { b.putShort(0xC00C.toShort()); b.putShort(1); b.putShort(1); b.putInt(60); b.putShort(4); b.put(ByteArray(4)) }
        else if (t == 28) { b.putShort(0xC00C.toShort()); b.putShort(28); b.putShort(1); b.putInt(60); b.putShort(16); b.put(ByteArray(16)) }
        return b.array().copyOf(b.position())
    }
    /** Wrap a DNS reply in a UDP/IPv4 packet back to the asker (swap addresses/ports, fresh checksums). */
    fun udpReply(req: ByteArray, ihl: Int, payload: ByteArray): ByteArray {
        val total = 20 + 8 + payload.size
        val p = ByteBuffer.allocate(total)
        p.put((0x45).toByte()); p.put(0); p.putShort(total.toShort()); p.putShort(0); p.putShort(0x4000.toShort()); p.put(64); p.put(17); p.putShort(0)
        p.put(req, 16, 4); p.put(req, 12, 4)                                    // src = original dst, dst = original src
        p.put(req, ihl + 2, 2); p.put(req, ihl, 2)                              // ports swapped
        p.putShort((8 + payload.size).toShort()); p.putShort(0); p.put(payload)
        val a = p.array()
        val ipSum = checksum(a, 0, 20); a[10] = (ipSum shr 8).toByte(); a[11] = ipSum.toByte()
        // UDP checksum over pseudo header + UDP segment
        val pseudo = ByteBuffer.allocate(12 + 8 + payload.size)
        pseudo.put(a, 12, 8); pseudo.put(0); pseudo.put(17); pseudo.putShort((8 + payload.size).toShort()); pseudo.put(a, 20, 8 + payload.size)
        var us = checksum(pseudo.array(), 0, pseudo.position()); if (us == 0) us = 0xFFFF
        a[26] = (us shr 8).toByte(); a[27] = us.toByte()
        return a
    }
    private fun checksum(b: ByteArray, off: Int, len: Int): Int {
        var sum = 0L; var i = off
        while (i < off + len - 1) { sum += (((b[i].toInt() and 255) shl 8) or (b[i + 1].toInt() and 255)).toLong(); i += 2 }
        if (len % 2 == 1) sum += ((b[off + len - 1].toInt() and 255) shl 8).toLong()
        while (sum shr 16 != 0L) sum = (sum and 0xFFFF) + (sum shr 16)
        return (sum.inv() and 0xFFFF).toInt()
    }
}
