package com.orpheus.sync

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var rootLayout: FrameLayout
    private lateinit var webView: WebView
    private lateinit var offlineOverlay: LinearLayout
    private var scanner: WifiScanner? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var pageLoaded = false
    @Volatile private var destroyed = false
    private var lastTargetUrl: String = DEFAULT_URL

    companion object {
        private const val DEFAULT_URL = "https://158.160.205.107/orpheus/"
        private val TRUSTED_HOSTS = setOf("158.160.205.107", "nikita56792.github.io")
        private const val REQ_PERMS = 1001
        private const val REQ_FILE_CHOOSER = 1002
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val isDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val bgColor = if (isDark) Color.BLACK else Color.parseColor("#F5F5F7")

        rootLayout = FrameLayout(this).apply {
            setBackgroundColor(bgColor)
            // Корректные отступы под status bar / navigation bar на Android 15–16 (edge-to-edge)
            setOnApplyWindowInsetsListener { v, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                } else {
                    @Suppress("DEPRECATION")
                    v.setPadding(
                        insets.systemWindowInsetLeft,
                        insets.systemWindowInsetTop,
                        insets.systemWindowInsetRight,
                        insets.systemWindowInsetBottom
                    )
                }
                insets
            }
        }

        webView = WebView(this).apply {
            setBackgroundColor(bgColor)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            val baseUa = settings.userAgentString ?: ""
            settings.userAgentString = "$baseUa OrpheusAndroid/1.1 (${Build.MODEL})"

            addJavascriptInterface(NativeBridge(), "OrpheusNative")

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url ?: return false
                    val url = uri.toString()
                    val host = uri.host?.lowercase() ?: ""
                    if (
                        host == "ya.ru" || host.endsWith(".ya.ru") ||
                        host == "oauth.yandex.ru" || host.endsWith(".yandex.ru") ||
                        host == "passport.yandex.ru" ||
                        url.endsWith(".apk", ignoreCase = true)
                    ) {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                            return true
                        } catch (_: Throwable) {}
                    }
                    if (!TRUSTED_HOSTS.contains(host)) {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                            return true
                        } catch (_: Throwable) {}
                    }
                    return false
                }

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    if (destroyed) return
                    if (url != "about:blank") {
                        pageLoaded = true
                        offlineOverlay.visibility = View.GONE
                        pushLatestScanToJs()
                    }
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError
                ) {
                    super.onReceivedError(view, request, error)
                    if (!destroyed && request.isForMainFrame) {
                        pageLoaded = false
                        offlineOverlay.visibility = View.VISIBLE
                    }
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
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

        offlineOverlay = buildOfflineOverlay(isDark)
        rootLayout.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        rootLayout.addView(offlineOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(rootLayout)

        acquireWakeLock()

        scanner = WifiScanner(this) { scanJson ->
            if (!destroyed) {
                mainHandler.post { pushScanJsonToJs(scanJson) }
            }
        }

        lastTargetUrl = resolveStartUrl(intent)
        webView.loadUrl(lastTargetUrl)
        ensureWifiPermissionsAndStart()
    }

    private fun buildOfflineOverlay(isDark: Boolean): LinearLayout {
        val fg = if (isDark) Color.WHITE else Color.parseColor("#1D1D1F")
        val sub = if (isDark) Color.parseColor("#98989D") else Color.parseColor("#6E6E73")
        val bg = if (isDark) Color.BLACK else Color.parseColor("#F5F5F7")
        val dp = resources.displayMetrics.density

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(bg)
            visibility = View.GONE
            val pad = (28 * dp).toInt()
            setPadding(pad, pad, pad, pad)

            addView(TextView(context).apply {
                text = "Нет подключения к серверу"
                textSize = 20f
                setTextColor(fg)
                gravity = Gravity.CENTER
            })
            addView(TextView(context).apply {
                text = "Проверьте Wi-Fi или мобильную сеть и нажмите «Повторить»."
                textSize = 14f
                setTextColor(sub)
                gravity = Gravity.CENTER
                setPadding(0, (10 * dp).toInt(), 0, (22 * dp).toInt())
            })
            addView(Button(context).apply {
                text = "Повторить"
                isAllCaps = false
                setBackgroundColor(Color.parseColor("#007AFF"))
                setTextColor(Color.WHITE)
                setPadding((28 * dp).toInt(), (12 * dp).toInt(), (28 * dp).toInt(), (12 * dp).toInt())
                setOnClickListener {
                    visibility = View.GONE
                    webView.loadUrl(lastTargetUrl)
                }
            })
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val trusted = sanitizeTrustedUrl(intent.dataString)
        if (trusted != null) {
            lastTargetUrl = trusted
            webView.loadUrl(trusted)
        }
    }

    private fun sanitizeTrustedUrl(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        if (scheme != "https" || !TRUSTED_HOSTS.contains(host)) return null
        return raw
    }

    private fun resolveStartUrl(intent: Intent?): String {
        return sanitizeTrustedUrl(intent?.dataString)
            ?: sanitizeTrustedUrl(intent?.getStringExtra("url"))
            ?: DEFAULT_URL
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
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine) return false
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
        }
        return true
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
        if (destroyed || !pageLoaded) return
        val quoted = JSONObject.quote(scanJson)
        runCatching {
            webView.evaluateJavascript(
                "window.__orpheusOnNativeWifiScan && window.__orpheusOnNativeWifiScan($quoted);",
                null
            )
        }
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
        destroyed = true
        pageLoaded = false
        mainHandler.removeCallbacksAndMessages(null)
        scanner?.destroy()
        scanner = null
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Throwable) {}
        try {
            webView.stopLoading()
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.destroy()
        } catch (_: Throwable) {}
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
        fun getWifiStatus(): String {
            return JSONObject()
                .put("hasPermission", hasWifiScanPermission())
                .put("locationEnabled", scanner?.isLocationEnabled() ?: true)
                .toString()
        }

        @JavascriptInterface
        fun requestWifiScan() {
            mainHandler.post {
                if (destroyed) return@post
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
