package com.divarchin.online;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String GAME_URL = "https://divarchin-online.onrender.com/";
    private static final String ALLOWED_HOST = "divarchin-online.onrender.com";
    private static final int SHARE_ID = 7;
    private WebView webView;
    private LinearLayout offlineView;
    private boolean hadMainFrameError = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(16, 19, 37));
        getWindow().setNavigationBarColor(Color.rgb(16, 19, 37));

        FrameLayout base = new FrameLayout(this);
        base.setBackgroundColor(Color.rgb(13, 16, 32));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(13, 16, 32));
        base.addView(webView, new FrameLayout.LayoutParams(-1, -1));

        offlineView = new LinearLayout(this);
        offlineView.setOrientation(LinearLayout.VERTICAL);
        offlineView.setGravity(Gravity.CENTER);
        offlineView.setPadding(dp(30), dp(30), dp(30), dp(30));
        offlineView.setBackgroundColor(Color.rgb(13, 16, 32));
        TextView title = new TextView(this);
        title.setText("🧱 دیوارچین");
        title.setTextColor(Color.rgb(96,230,213));
        title.setTypeface(null, Typeface.BOLD);
        title.setTextSize(26);
        title.setGravity(Gravity.CENTER);
        offlineView.addView(title);
        TextView help = new TextView(this);
        help.setText(getString(R.string.offline_message) + "\n\nبازی آنلاین است و به اینترنت احتیاج دارد.");
        help.setTextSize(16);
        help.setTextColor(Color.WHITE);
        help.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(-1, -2);
        hp.topMargin = dp(18);
        offlineView.addView(help, hp);
        Button retry = new Button(this);
        retry.setText("تلاش دوباره");
        retry.setOnClickListener(v -> reload());
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(-2, -2);
        bp.topMargin = dp(18);
        offlineView.addView(retry, bp);
        offlineView.setVisibility(View.GONE);
        base.addView(offlineView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(base);

        WebSettings web = webView.getSettings();
        web.setJavaScriptEnabled(true);
        web.setDomStorageEnabled(true);
        web.setAllowFileAccess(false);
        web.setAllowContentAccess(false);
        web.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setSupportMultipleWindows(false);
        web.setJavaScriptCanOpenWindowsAutomatically(false);
        web.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) web.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isOurUrl(request.getUrl()) && openExternal(request.getUrl());
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                hadMainFrameError = false;
                offlineView.setVisibility(View.GONE);
                super.onPageStarted(view, url, icon);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    hadMainFrameError = true;
                    offlineView.setVisibility(View.VISIBLE);
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!hadMainFrameError) offlineView.setVisibility(View.GONE);
            }
        });
        if (state != null) webView.restoreState(state);
        else webView.loadUrl(GAME_URL);
    }

    private boolean isOurUrl(Uri url) {
        return "https".equalsIgnoreCase(url.getScheme()) && ALLOWED_HOST.equalsIgnoreCase(url.getHost());
    }

    // All non-game links open in the device browser, not inside the game WebView.
    private boolean openExternal(Uri target) {
        String scheme = target.getScheme();
        if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return true;
        try { startActivity(new Intent(Intent.ACTION_VIEW, target)); }
        catch (ActivityNotFoundException ignored) { }
        return true;
    }

    private void reload() {
        hadMainFrameError = false;
        offlineView.setVisibility(View.GONE);
        webView.loadUrl(GAME_URL);
    }

    @Override public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(Menu.NONE, SHARE_ID, Menu.NONE, "اشتراک لینک بازی").setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        return true;
    }
    @Override public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == SHARE_ID) {
            String current = webView.getUrl();
            String toShare = current != null && isOurUrl(Uri.parse(current)) ? current : GAME_URL;
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, toShare);
            startActivity(Intent.createChooser(send, "اشتراک لینک دیوارچین"));
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
    // Browser WebView navigation history is not the same as the game's SPA views.
    // Let JavaScript handle in-game Back; ask for confirmation only at the home screen.
    private void confirmExit() {
        new AlertDialog.Builder(this)
            .setTitle("خروج از دیوارچین")
            .setMessage("تمایل به خروج از بازی دارید؟")
            .setNegativeButton("خیر", (dialog, which) -> dialog.dismiss())
            .setPositiveButton("بله، خروج", (dialog, which) -> finish())
            .show();
    }
    @Override public void onBackPressed() {
        if (offlineView.getVisibility() == View.VISIBLE) { confirmExit(); return; }
        webView.evaluateJavascript(
            "window.divarchinHandleBack ? window.divarchinHandleBack() : 'exit'",
            result -> { if (result == null || result.contains("exit") || result.equals("null")) confirmExit(); }
        );
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        webView.saveState(out);
        super.onSaveInstanceState(out);
    }
    @Override protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
    private int dp(int value) { return (int)(value * getResources().getDisplayMetrics().density + .5f); }
}
