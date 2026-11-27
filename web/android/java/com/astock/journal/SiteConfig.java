package com.astock.journal;

/**
 * 构建模板：build_apk.sh 从 android/site.conf 和 data/appkey 注入下列占位符。
 * 源码里的占位符不能直接编译运行，必须走 build_apk.sh。
 */
final class SiteConfig {
    static final String SITE_ORIGIN = "__SITE_ORIGIN__";
    static final String BASE = "__SITE_BASE__";
    static final String APP_KEY = "__APP_KEY__";

    private SiteConfig() {
    }
}
