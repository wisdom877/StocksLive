package com.astock.journal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** 开机后恢复重点新闻监控；用户点过「停止监控」则不再自动启动。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // 通知功能已停用（2026-10-31）：开机不再启动 AlertService。
        // 恢复时取消下面整段注释，并同时恢复 MainActivity / AndroidManifest.xml。
        /*
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        // 默认 false：用户至少打开过一次 App（MainActivity 会置 true）才开机自启
        if (!context.getSharedPreferences("alerts", Context.MODE_PRIVATE)
                .getBoolean("enabled", false)) return;
        Intent svc = new Intent(context, AlertService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception ignored) {
            // 部分厂商会拦截开机启动；用户下次打开 App 时仍会启动
        }
        */
    }
}
