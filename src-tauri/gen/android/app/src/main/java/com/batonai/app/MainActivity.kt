package com.batonai.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var browser: WebView? = null
  private var backPending = false

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    browser = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
    )
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      private fun delegateBack() {
        isEnabled = false
        try { onBackPressedDispatcher.onBackPressed() }
        finally { isEnabled = true }
      }

      override fun handleOnBackPressed() {
        if (ViewCompat.getRootWindowInsets(window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
          WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
          return
        }
        if (backPending) return
        val view = browser
        if (view == null) { delegateBack(); return }
        backPending = true
        view.evaluateJavascript(
          "(function(){try{const back=window.__batonHandleSystemBack;" +
            "return typeof back==='function'?back():null;}catch(e){console.error(e);return true;}})()"
        ) { result ->
          backPending = false
          when (result) {
            "true" -> Unit
            "false" -> moveTaskToBack(true)
            // Landing/scanner and other pages retain Tauri's existing back behavior.
            else -> delegateBack()
          }
        }
      }
    })
  }
}
