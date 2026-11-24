package com.orpheus.sync

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import org.json.JSONArray

class WifiScanner(
    ctx: Context,
    private val onScanJson: (String) -> Unit,
) {
    private val appCtx = ctx.applicationContext
    private val wifi = appCtx.getSystemService(WifiManager::class.java)
    private val lm = appCtx.getSystemService(LocationManager::class.java)
    private val thread = HandlerThread("orpheus-wifi").also { it.start() }
    private val h = Handler(thread.looper)

    @Volatile private var running = false
    @Volatile private var registered = false
    @Volatile var lastScanJson: String = "[]"
        private set

    private var limited = false
    private var refusedInRow = 0
    private var lastReqNs = 0L
    private var lastOkReqNs = 0L
    private var lastScanNs = 0L
    private var lastLimitCheckNs = 0L
    private var seenResUs = 0L
    private var retryScheduled = false
    private val sysListener = LocationListener { }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val updated = i.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false)
            onBroadcast(updated)
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            val now = SystemClock.elapsedRealtimeNanos()
            if (Build.VERSION.SDK_INT >= 30 && now - lastLimitCheckNs > 10_000_000_000L) {
                lastLimitCheckNs = now
                checkLimited()
            }
            if (limited) {
                pollResults(now)
                if (now - lastOkReqNs >= LIMITED_GAP_NS && now - lastReqNs >= 5_000_000_000L) {
                    requestScanInternal()
                }
            } else if (!retryScheduled && now - maxOf(lastReqNs, lastScanNs) > 6_000_000_000L) {
                requestScanInternal()
            }
            h.postDelayed(this, 1000L)
        }
    }

    fun isLocationEnabled(): Boolean {
        return runCatching { lm?.isLocationEnabled ?: true }.getOrDefault(true)
    }

    fun start() {
        if (running) return
        running = true
        h.post {
            if (!registered) {
                try {
                    val filter = IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
                    if (Build.VERSION.SDK_INT >= 33) {
                        appCtx.registerReceiver(receiver, filter, null, h, Context.RECEIVER_EXPORTED)
                    } else {
                        appCtx.registerReceiver(receiver, filter, null, h)
                    }
                    registered = true
                } catch (_: Throwable) {}
            }
            checkLimited()
            emitCachedIfPresent()
            requestScanInternal()
            h.post(tick)
        }
    }

    fun stop() {
        running = false
        retryScheduled = false
        h.post {
            h.removeCallbacksAndMessages(null)
            if (registered) {
                runCatching { appCtx.unregisterReceiver(receiver) }
                registered = false
            }
            stopSysScans()
        }
    }

    fun destroy() {
        stop()
        h.post { thread.quitSafely() }
    }

    fun triggerImmediateRead() {
        h.post {
            emitCachedIfPresent()
            if (running && !limited) {
                val now = SystemClock.elapsedRealtimeNanos()
                if (now - lastReqNs > 1_500_000_000L) requestScanInternal()
            }
        }
    }

    private fun checkLimited() {
        if (Build.VERSION.SDK_INT >= 30 && wifi != null) {
            val v = runCatching { wifi.isScanThrottleEnabled }.getOrDefault(false)
            setLimited(v)
        }
    }

    private fun setLimited(v: Boolean) {
        if (v == limited) return
        limited = v
        if (v) startSysScans() else stopSysScans()
    }

    @SuppressLint("MissingPermission")
    private fun startSysScans() {
        runCatching {
            if (lm != null && lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 1000L, 0f, sysListener, h.looper)
            }
        }
    }

    private fun stopSysScans() {
        runCatching { lm?.removeUpdates(sysListener) }
    }

    private fun requestScanInternal() {
        if (!running || wifi == null) return
        retryScheduled = false
        @Suppress("DEPRECATION")
        val ok = runCatching { wifi.startScan() }.getOrDefault(false)
        lastReqNs = SystemClock.elapsedRealtimeNanos()
        if (ok) {
            lastOkReqNs = lastReqNs
            refusedInRow = 0
        } else {
            refusedInRow++
        }
        if (Build.VERSION.SDK_INT < 30 && refusedInRow >= 2) {
            setLimited(true)
        }
        if (limited) return
        if (!ok) {
            retryScheduled = true
            h.postDelayed({ if (running && retryScheduled) requestScanInternal() }, 2000L)
        }
    }

    @SuppressLint("MissingPermission")
    private fun onBroadcast(updated: Boolean) {
        if (!running || wifi == null) return
        val now = SystemClock.elapsedRealtimeNanos()
        val res = runCatching { wifi.scanResults }.getOrElse { emptyList() }
        if (updated && res.isNotEmpty()) {
            val newest = res.maxOfOrNull { it.timestamp } ?: 0L
            if (!limited || newest > seenResUs + 500_000L) {
                consume(res, now, allowStale = false)
            }
        }
        if (!limited) requestScanInternal()
    }

    @SuppressLint("MissingPermission")
    private fun pollResults(now: Long) {
        val w = wifi ?: return
        val res = runCatching { w.scanResults }.getOrNull() ?: return
        val newest = res.maxOfOrNull { it.timestamp } ?: return
        if (newest <= seenResUs + 500_000L) return
        if (now - newest * 1000L > 8_000_000_000L) {
            seenResUs = newest
            return
        }
        consume(res, now, allowStale = false)
    }

    @SuppressLint("MissingPermission")
    private fun emitCachedIfPresent() {
        val w = wifi ?: return
        val res = runCatching { w.scanResults }.getOrNull() ?: return
        if (res.isNotEmpty()) {
            consume(res, SystemClock.elapsedRealtimeNanos(), allowStale = true)
        }
    }

    private fun consume(res: List<ScanResult>, now: Long, allowStale: Boolean) {
        val bestByBssid = HashMap<String, Int>(res.size)
        for (r in res) {
            val bssid = r.BSSID?.trim()?.lowercase() ?: continue
            if (bssid.isEmpty() || bssid == "00:00:00:00:00:00") continue
            val ageNs = now - r.timestamp * 1000L
            if (!allowStale && ageNs > 8_000_000_000L) continue
            if (allowStale && ageNs > 90_000_000_000L) continue
            val prev = bestByBssid[bssid]
            if (prev == null || r.level > prev) {
                bestByBssid[bssid] = r.level
            }
        }
        if (bestByBssid.isEmpty()) return

        seenResUs = maxOf(seenResUs, res.maxOfOrNull { it.timestamp } ?: 0L)
        lastScanNs = now

        val arr = JSONArray()
        for ((b, lvl) in bestByBssid) {
            val pair = JSONArray()
            pair.put(b)
            pair.put(lvl)
            arr.put(pair)
        }
        val json = arr.toString()
        lastScanJson = json
        onScanJson(json)
    }

    companion object {
        private const val LIMITED_GAP_NS = 30_000_000_000L
    }
}
