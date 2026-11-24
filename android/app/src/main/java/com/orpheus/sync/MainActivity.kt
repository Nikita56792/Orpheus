package com.orpheus.sync

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var scanner: WifiScanner? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var pageLoaded = false

    companion object {
        private const val DEFAULT_URL = "https://158.160.205.107/orpheus/"
        private const val REQ_PERMS = 1001
        private const val REQ_FILE_CHOOSER = 1002
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            val baseUa = settings.userAgentString ?: ""
            settings.userAgentString = "$baseUa OrpheusAndroid/1.0 (${Build.MODEL})"

            addJavascriptInterface(NativeBridge(), "OrpheusNative")

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (url.endsWith(".apk", ignoreCase = true)) return false
                    if (url.startsWith("https://158.160.205.107") || url.startsWith("https://nikita56792.github.io")) {
                        return false
                    }
                    return false
                }

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    pageLoaded = true
                    pushLatestScanToJs()
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    // Grant WebAudio/media requests cleanly without prompting for microphone
                    val allowed = request.resources.filter {
                        it != PermissionRequest.RESOURCE_AUDIO_CAPTURE &&
                        it != PermissionRequest.RESOURCE_VIDEO_CAPTURE
                    }.toTypedArray()
                    if (allowed.isNotEmpty()) request.grant(allowed) else request.deny()
                }

                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams
                ): Boolean {
                    fileChooserCallback?.onReceiveValue(null)
                    fileChooserCallback = filePathCallback
                    return try {
                        val intent = fileChooserParams.createIntent().apply {
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
                        startActivityForResult(intent, REQ_FILE_CHOOSER)
                        true
                    } catch (_: Throwable) {
                        fileChooserCallback = null
                        false
                    }
                }
            }
        }

        setContentView(webView)
        acquireWakeLock()

        scanner = WifiScanner(this) { scanJson ->
            mainHandler.post { pushScanJsonToJs(scanJson) }
        }

        val launchUrl = resolveStartUrl(intent)
        webView.loadUrl(launchUrl)
        ensureWifiPermissionsAndStart()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val u = intent.dataString
        if (!u.isNullOrBlank() && u.startsWith("https://")) {
            webView.loadUrl(u)
        }
    }

    private fun resolveStartUrl(intent: Intent?): String {
        val fromData = intent?.dataString
        if (!fromData.isNullOrBlank() && fromData.startsWith("https://")) return fromData
        val fromExtra = intent?.getStringExtra("url")
        if (!fromExtra.isNullOrBlank() && fromExtra.startsWith("http")) return fromExtra
        return DEFAULT_URL
    }

    private fun requiredPermissions(): Array<String> {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= 33) {
            perms.add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
        return perms.toTypedArray()
    }

    private fun hasWifiScanPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun ensureWifiPermissionsAndStart() {
        if (hasWifiScanPermission()) {
            scanner?.start()
        } else {
            requestPermissions(requiredPermissions(), REQ_PERMS)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMS && hasWifiScanPermission()) {
            scanner?.start()
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE_CHOOSER) {
            val cb = fileChooserCallback
            fileChooserCallback = null
            if (cb != null) {
                val results: Array<Uri>? = if (resultCode == RESULT_OK && data != null) {
                    val clip = data.clipData
                    if (clip != null && clip.itemCount > 0) {
                        Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
                    } else {
                        data.data?.let { arrayOf(it) }
                    }
                } else null
                cb.onReceiveValue(results)
            }
        }
    }

    private fun pushLatestScanToJs() {
        val json = scanner?.lastScanJson ?: return
        if (json.length > 2) pushScanJsonToJs(json)
    }

    private fun pushScanJsonToJs(scanJson: String) {
        if (!pageLoaded) return
        val quoted = JSONObject.quote(scanJson)
        webView.evaluateJavascript(
            "window.__orpheusOnNativeWifiScan && window.__orpheusOnNativeWifiScan($quoted);",
            null
        )
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(PowerManager::class.java)
            if (pm != null && wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OrpheusSync::AudioWifi").apply {
                    acquire(4 * 60 * 60 * 1000L)
                }
            }
        } catch (_: Throwable) {}
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        if (hasWifiScanPermission()) scanner?.start()
    }

    override fun onDestroy() {
        scanner?.destroy()
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Throwable) {}
        webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    inner class NativeBridge {
        @JavascriptInterface
        fun getLastWifiScan(): String = scanner?.lastScanJson ?: "[]"

        @JavascriptInterface
        fun requestWifiScan() {
            mainHandler.post {
                if (hasWifiScanPermission()) {
                    scanner?.start()
                    scanner?.triggerImmediateRead()
                } else {
                    ensureWifiPermissionsAndStart()
                }
            }
        }

        @JavascriptInterface
        fun getDeviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    }
}
