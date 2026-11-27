package com.astock.journal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 前台服务：轮询 /api/v1/live/alerts，A 级 + B 级重点实时新闻直接发系统通知。
 *
 * 为什么需要前台服务：WebView/浏览器在 App 退到后台后无法可靠地执行定时任务，
 * 也没有 Web Push。Android 要求长期后台轮询必须显示一条常驻通知。
 * 用户可以在常驻通知上点「停止监控」；重新打开 App 会再次启动。
 *
 * 通知功能已于 2026-10-31 停用：MainActivity / BootReceiver 不再启动本服务，
 * AndroidManifest.xml 中的 service 声明也已注释。保留实现便于以后恢复。
 */
public class AlertService extends Service {
    static final String ACTION_STOP = "com.astock.journal.STOP_ALERTS";

    private static final String CH_MONITOR = "astock_monitor";
    private static final String CH_ALERT = "astock_alert";
    private static final String PREFS = "alerts";
    private static final long POLL_SECONDS = 60L;
    private static final long MAX_ALERT_AGE_MS = 2L * 3600L * 1000L; // 断网很久后不补发太旧的提醒
    private static final int MONITOR_ID = 1;
    private static final int ALERT_BASE = 100000;
    private static final Pattern SK = Pattern.compile("sk=([^;]+)");

    private NotificationManager nm;
    private SharedPreferences prefs;
    private ScheduledExecutorService exec;

    @Override
    public void onCreate() {
        super.onCreate();
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        createChannels();

        Notification.Builder b = nb(CH_MONITOR)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle("A股日刊")
                .setContentText("重点新闻监控中")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(openApp())
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止监控", stopIntent());
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_LOW);
        Notification monitor = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(MONITOR_ID, monitor, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(MONITOR_ID, monitor);
        }

        exec = Executors.newSingleThreadScheduledExecutor();
        exec.scheduleWithFixedDelay(this::pollSafe, 1, POLL_SECONDS, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            prefs.edit().putBoolean("enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        prefs.edit().putBoolean("enabled", true).apply();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (exec != null) {
            exec.shutdownNow();
            exec = null;
        }
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel alert = new NotificationChannel(
                CH_ALERT, "重点快讯", NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription("A 级 + B 级重点实时新闻");
        alert.enableVibration(true);
        nm.createNotificationChannel(alert);

        NotificationChannel monitor = new NotificationChannel(
                CH_MONITOR, "新闻监控", NotificationManager.IMPORTANCE_LOW);
        monitor.setDescription("保持后台监控重点新闻");
        monitor.setShowBadge(false);
        nm.createNotificationChannel(monitor);
    }

    private Notification.Builder nb(String channel) {
        return Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, channel)
                : new Notification.Builder(this);
    }

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 10, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent stopIntent() {
        Intent i = new Intent(this, AlertService.class).setAction(ACTION_STOP);
        return PendingIntent.getService(this, 11, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void pollSafe() {
        try {
            long after = prefs.getLong("last_id", -1L);
            JSONObject res = fetch(after);
            if (res == null) return;
            JSONArray arr = res.optJSONArray("items");
            long last = res.optLong("last_id", after);
            long now = System.currentTimeMillis();
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject it = arr.optJSONObject(i);
                    if (it == null) continue;
                    // after < 0 是首次初始化：只记游标，不把历史重点新闻全部弹出来
                    if (after >= 0) {
                        try {
                            notifyAlert(it, now);
                        } catch (Exception ignored) {
                            // 系统拒绝通知也不能卡住游标，否则每轮都会重复处理同一条
                        }
                    }
                }
            }
            if (last != after) prefs.edit().putLong("last_id", last).apply();
        } catch (Exception e) {
            android.util.Log.w("AlertService", "poll failed: " + e.getClass().getSimpleName());
        }
    }

    private JSONObject fetch(long after) throws Exception {
        String cookie = currentCookie();
        JSONObject res = fetchOnce(after, cookie);
        if (res != null) return res;
        // 401：cookie 过期，用 APK 内置 appkey 换一个新的 cookie 再试一次
        cookie = refreshCookie();
        if (cookie == null) return null;
        return fetchOnce(after, cookie);
    }

    private JSONObject fetchOnce(long after, String cookie) throws Exception {
        HttpURLConnection c = null;
        try {
            URL u = new URL(SiteConfig.BASE + "api/v1/live/alerts?after=" + after);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Accept", "application/json");
            if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
            int code = c.getResponseCode();
            if (code == 401) return null;
            if (code != 200) throw new IOException("HTTP " + code);
            try (InputStream in = c.getInputStream()) {
                return new JSONObject(readAll(in));
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private String readAll(InputStream in) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.toString();
    }

    private String currentCookie() {
        try {
            String c = CookieManager.getInstance().getCookie(SiteConfig.BASE);
            if (c != null && c.contains("sk=")) return c;
        } catch (Exception ignored) {
        }
        return prefs.getString("cookie", null);
    }

    private String refreshCookie() {
        HttpURLConnection c = null;
        try {
            String url = SiteConfig.BASE + "?k=" + URLEncoder.encode(SiteConfig.APP_KEY, "UTF-8");
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(10000);
            int code = c.getResponseCode();
            if (code != 200) return null;
            String setCookie = c.getHeaderField("Set-Cookie");
            if (setCookie == null) return null;
            Matcher m = SK.matcher(setCookie);
            if (!m.find()) return null;
            String cookie = "sk=" + m.group(1);
            prefs.edit().putString("cookie", cookie).apply();
            try {
                CookieManager.getInstance().setCookie(SiteConfig.BASE, cookie + "; Path=/stocks");
                CookieManager.getInstance().flush();
            } catch (Exception ignored) {
            }
            return cookie;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void notifyAlert(JSONObject it, long now) {
        long id = it.optLong("id", 0L);
        String title = it.optString("title", "").trim();
        if (id <= 0 || title.isEmpty()) return;
        String published = it.optString("published_at", "");
        long ts = parseTime(published);
        if (ts > 0 && now - ts > MAX_ALERT_AGE_MS) return;

        String category = it.optString("category", "");
        String shortText = title.length() > 140 ? title.substring(0, 140) + "…" : title;
        String time = published.length() >= 16 ? published.substring(11, 16) : "";
        Notification.Builder b = nb(CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat_alert)
                .setContentTitle("重点快讯" + (time.isEmpty() ? "" : " · " + time))
                .setContentText(shortText)
                .setStyle(new Notification.BigTextStyle().bigText(title))
                .setSubText(category)
                .setColor(0xFFE5322D)
                .setAutoCancel(true)
                .setGroup("astock_alerts")
                .setContentIntent(openApp());
        if (ts > 0) b.setWhen(ts).setShowWhen(true);
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        }
        nm.notify(ALERT_BASE + (int) (id % 90000L), b.build());
    }

    private long parseTime(String s) {
        if (s == null || s.length() < 16) return 0L;
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA);
            f.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
            Date d = f.parse(s);
            return d == null ? 0L : d.getTime();
        } catch (Exception e) {
            return 0L;
        }
    }
}
