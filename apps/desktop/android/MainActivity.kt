package com.novalis.desktop

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

// Novalis override (source of truth: apps/desktop/android/MainActivity.kt,
// re-applied after `tauri android init` by scripts/android-overrides.sh — see
// MOBILE.md). Edge-to-edge is mandatory on modern Android (SDK 35+), and the
// Android WebView does NOT surface the status/navigation bars through CSS
// `env(safe-area-inset-*)` (only display cutouts). So we read the real
// system-bar + cutout insets natively and inject them as CSS variables; the web
// layer pads its chrome with `var(--nv-inset-*)` while the app background still
// extends edge to edge (so the bar areas take the app's own theme color).
class MainActivity : TauriActivity() {
  private val handler = Handler(Looper.getMainLooper())
  private var top = 0
  private var right = 0
  private var bottom = 0
  private var left = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val rootView = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val d = view.resources.displayMetrics.density
      top = (bars.top / d).toInt()
      right = (bars.right / d).toInt()
      bottom = (bars.bottom / d).toInt()
      left = (bars.left / d).toInt()
      // Insets are dispatched during layout, which can beat the WebView's first
      // page load — a single push would be lost. Re-push over the first few
      // seconds so the CSS var lands once the document exists (idempotent).
      pushSoon(view)
      insets
    }
  }

  private fun pushSoon(root: View) {
    for (delay in longArrayOf(0, 250, 750, 1500, 3000)) {
      handler.postDelayed({ push(root) }, delay)
    }
  }

  private fun push(root: View) {
    val webView = findWebView(root) ?: return
    // Guard against a not-yet-parsed document (no error spam on early calls).
    val js = """
      (function(){
        if (!document || !document.documentElement) return;
        var s = document.documentElement.style;
        s.setProperty('--nv-inset-top', '${top}px');
        s.setProperty('--nv-inset-right', '${right}px');
        s.setProperty('--nv-inset-bottom', '${bottom}px');
        s.setProperty('--nv-inset-left', '${left}px');
      })();
    """.trimIndent()
    webView.evaluateJavascript(js, null)
  }

  private fun findWebView(v: View): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }
}
