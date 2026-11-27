/* 顶栏中间那一块：左边是实时心率（有样本才出现），右边还是「待机 ›」。
   轻点立刻进待机；按住 1.2 秒走满一条进度线，才算「进入待机模式」（顺手把常亮打开）。
   时长和退出待机的长按一致，手感统一。 */
var SB_MID_HOLD = 1200;
var sbMidHeld = false;
var SB_DIM_AFTER = 30000;            // 待机闲置 30 秒后降亮，碰一下立刻恢复

/* 长按进入待机的手感：越接近闭合，脉冲越密、越重；闭合那一下单独来一记重击。
   iPhone 壳里走 wkHaptic（UIImpactFeedbackGenerator），没有桥接的浏览器不硬震。 */
var SB_MID_HAPTIC = [
  { p: 0.16, style: "light",  i: 0.26 },
  { p: 0.38, style: "light",  i: 0.44 },
  { p: 0.58, style: "medium", i: 0.62 },
  { p: 0.75, style: "medium", i: 0.80 },
  { p: 0.88, style: "heavy",  i: 0.92 },
  { p: 0.96, style: "heavy",  i: 1.00 },
  { p: 1.00, style: "final",  i: 1.00 }
];
function sbHoldHaptic(style, intensity) {
  if (typeof window.wkHaptic === "function") {
    try { return window.wkHaptic(style, intensity); } catch (e) {}
  }
  // 只有非壳环境才退回 navigator.vibrate；壳里的旧 polyfill 是整段强震，不能用来做渐强
  if (!window.wkNativeCap && navigator.vibrate) {
    try { navigator.vibrate(style === "final" ? 35 : 4 + Math.round(intensity * 9)); } catch (e) {}
  }
}

(function sbHintOnLoad() {
  const add = () => {
    const mid = $("#top-mid");
    if (!mid || mid.querySelector(".sb-hint")) return;
    const h = document.createElement("span");
    h.className = "sb-hint";
    h.innerHTML = `<span class="sb-hint-hr" id="sb-hint-hr" hidden><b id="sb-hint-bpm">—</b>`
      + `<svg viewBox="0 0 120 16" preserveAspectRatio="none" aria-hidden="true"><path id="sb-hint-path" d=""/></svg></span>`
      + `<span class="sb-hint-l">待机 <i>›</i></span>`;
    mid.appendChild(h);
    const ring = document.createElement("i");
    ring.className = "sb-mid-ring";
    ring.id = "sb-mid-ring";
    mid.appendChild(ring);
    sbBindMidHold(mid);
    // 没新样本时也要把「已经停了」画出来，所以慢拍重绘一次
    setInterval(() => { if (document.hidden) return; try { sbPaintHr(); } catch (e) {} }, 15000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})();

function sbBindMidHold(mid) {
  let t0 = 0, raf = 0, pid = null, opened = false, finishTimer = 0, hapticAt = 0;
  const ring = () => $("#sb-mid-ring");
  const reset = () => {
    t0 = 0; pid = null; opened = false; hapticAt = 0;
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const r = ring();
    if (r) { r.style.setProperty("--p", "0"); r.style.opacity = "0"; }
  };
  const enter = () => {
    sbMidHeld = true;
    reset();
    if (typeof sbAwakeSet === "function") sbAwakeSet(true);
    sbOpen();
  };
  const step = () => {
    if (!t0) return;
    const p = Math.min(1, (performance.now() - t0) / SB_MID_HOLD);
    const r = ring();
    if (r) { r.style.opacity = "1"; r.style.setProperty("--p", p.toFixed(3)); }
    while (hapticAt < SB_MID_HAPTIC.length && p >= SB_MID_HAPTIC[hapticAt].p) {
      const h = SB_MID_HAPTIC[hapticAt++];
      sbHoldHaptic(h.style, h.i);
    }
    if (p >= 1) {
      opened = true;
      if (r) { r.style.opacity = "1"; r.style.setProperty("--p", "1"); }
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      // 让环完整显示一拍再进待机，别一到 100% 就瞬间消失
      finishTimer = setTimeout(() => { if (opened) enter(); }, 180);
      return;
    }
    raf = requestAnimationFrame(step);
  };
  const begin = (e, id) => {
    if (pid !== null) return;
    // iOS 上长按文字会弹选择/放大镜，不拦就会被 pointercancel 掉
    e.preventDefault();
    sbMidHeld = false;
    opened = false;
    hapticAt = 0;
    pid = id;
    if (typeof id === "number") { try { mid.setPointerCapture(id); } catch (err) {} }
    const r = ring();
    if (r) { r.style.opacity = "1"; r.style.setProperty("--p", "0.001"); }
    t0 = performance.now();
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(step);
  };
  mid.addEventListener("pointerdown", (e) => begin(e, e.pointerId));
  // 老 WebKit 偶尔只给 touch 事件，补一条同样路径；谁先到谁占位，不会双触发
  mid.addEventListener("touchstart", (e) => begin(e, "touch"), { passive: false });
  mid.addEventListener("pointerup", (e) => {
    if (pid === null || e.pointerId !== pid) return;
    reset();
  });
  mid.addEventListener("pointercancel", reset);
  mid.addEventListener("touchend", () => { if (pid === "touch") reset(); }, { passive: true });
  mid.addEventListener("touchcancel", () => { if (pid === "touch") reset(); }, { passive: true });
  // 长按期间别让浏览器弹菜单/选中文本
  mid.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ============================================================
   待机 / 专注六页（StandBy 风格）
   方案 A：应用内全屏层   +   方案 D：旋转舞台

   · 竖屏锁定下，舞台把屏幕宽高互换后 rotate(90deg)，按「横版 852×393」排版；
     用户把手机横过来看就是正的。舞台用 100vh/100vw 现算，不写死尺寸。
   · 舞台内部一律 absolute（fixed 在 transform 里会错位）。
   · 分页靠 scroll-snap：整块 transform 会连带触摸坐标，物理竖滑就是横向翻页，
     不需要自己换算 dx/dy。
   · 所有顶层函数 sb 前缀、状态挂 state.sb，避免和 8 个分区抢全局名字。
   ============================================================ */
var SB_PAGES = 7;

function sbPad(n) { return String(n).padStart(2, "0"); }

/* 北京时间（和全站一致：把 UTC+8 的墙钟当 UTC 读） */
function sbNow() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    y, m, d: day,
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    dow: d.getUTCDay(),
    week: ["日", "一", "二", "三", "四", "五", "六"][d.getUTCDay()],
    day: `${y}-${sbPad(m)}-${sbPad(day)}`,
    md: `${m}月${day}日`,
  };
}

function sbState() {
  if (!state.sb) {
    state.sb = {
      built: false, on: false, page: 0, flip: false, land: false, pinned: false, pinTimer: null, swipeTimer: null,
      day: "", tickTimer: null, idleTimer: null, dimTimer: null, dimmed: false,
      wx: null, wxAt: 0, work: null, workAt: 0,
      awake: (function () { try { return localStorage.getItem("sbAwake") !== "0"; } catch (e) { return true; } })(),
      awakeTimer: null,
      dash: null, dashAt: 0, quotes: null, quotesAt: 0, dashBusy: false, quoteBusy: false,
      stocks: null, stocksAt: 0, stockBusy: false,
      downX: 0, downY: 0, downAt: 0, downEl: null, photoTimer: null,
    };
  }
  return state.sb;
}

function sbIsOn() { return !!(state.sb && state.sb.on); }

/* ---------- 建 DOM（只建一次） ---------- */
/* ---------- CarPlay：第 7 页是壳的原生图层，网页只做入口与状态 ---------- */
var SB_CP_LAST = -1;

function sbCarPlayMsg(payload) {
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkCarPlay;
    if (h) { h.postMessage(payload); return true; }
  } catch (e) { /* 浏览器预览没有壳 */ }
  return false;
}

function sbCarPlaySheet(show, ssid, note, wifi) {
  const sheet = $("#sb-cp-sheet");
  if (!sheet) return;
  if (!show) {
    sheet.classList.remove("on");
    sheet.classList.add("hidden");
    try { document.activeElement && document.activeElement.blur(); } catch (e) {}
    return;
  }
  sheet.classList.remove("hidden");
  requestAnimationFrame(() => sheet.classList.add("on"));
  const has = wifi !== false;
  const si = $("#sb-cp-ssid"), pw = $("#sb-cp-pwd");
  const form = $("#sb-cp-form"), nowifi = $("#sb-cp-nowifi");
  const h1 = $("#sb-cp-h1"), p = $("#sb-cp-p");
  if (form) form.classList.toggle("hidden", !has);
  if (nowifi) nowifi.classList.toggle("hidden", has);
  if (h1) h1.textContent = has ? "连接 CarPlay" : "没有 Wi-Fi";
  if (p) p.textContent = has
    ? "CarPlay 走本机局域网，需要先连一个 Wi-Fi。Wi-Fi 可以没有互联网，手机数据照样走蜂窝。"
    : "CarPlay 走本机局域网，蜂窝数据不能替代。";
  if (si) si.value = ssid || "";
  if (pw) pw.value = "";
  if (!has) return;
  setTimeout(() => {
    try { (ssid ? pw : si)?.focus(); } catch (e) {}
  }, 360);
}

function sbCarPlaySubmit() {
  const si = $("#sb-cp-ssid"), pw = $("#sb-cp-pwd");
  const ssid = ((si && si.value) || "").trim();
  if (!ssid) {
    if (si) {
      si.classList.add("bad");
      setTimeout(() => si.classList.remove("bad"), 1200);
      try { si.focus(); } catch (e) {}
    }
    return;
  }
  sbCarPlaySheet(false);
  sbCarPlayMsg({ cmd: "start", ssid: ssid, password: (pw && pw.value) || "" });
  sbCarPlaySet("starting", "");
}

function sbCarPlaySet(state, message) {
  const page = document.querySelector('#sb .sb-p[data-p="6"]');
  if (!page) return;
  const prev = page.dataset.cp;
  page.dataset.cp = state;
  page.classList.toggle("sb-cp-live", state === "video");
  const box = $("#sb");
  if (box) box.classList.toggle("sb-cp-video", state === "video");
  const hint = $("#sb-cp-hint");
  if (hint) {
    let text = "长按 Hello 进入 CarPlay";
    if (state === "starting") text = "正在启动 CarPlay…";
    else if (state === "auth") text = message || "正在认证配件…";
    else if (state === "ready") text = message || "已连接，正在协商画面…";
    else if (state === "video") text = "CarPlay 已连接";
    else if (state === "failed") text = message || "启动失败，长按重试";
    else if (state === "credentials") text = "需要先连接 Wi-Fi";
    hint.textContent = text;
  }
  if (state !== "credentials") sbCarPlaySheet(false);
  if (state === "failed" && prev !== "failed") sbCarPlayFailHaptic();
}

/* 连接失败：三记短促重击，明显区别于成功时的那一下收尾 */
function sbCarPlayFailHaptic() {
  if (typeof window.wkHaptic === "function") {
    [[0, 0.78], [140, 1], [320, 0.72]].forEach(([ms, i]) => {
      setTimeout(() => { try { window.wkHaptic("heavy", i); } catch (e) {} }, ms);
    });
    return;
  }
  if (!window.wkNativeCap && navigator.vibrate) {
    try { navigator.vibrate([28, 55, 28, 55, 28]); } catch (e) {}
  }
}

/* 第 7 页的 Hello 长按进入：不叠按钮，长按 1 秒才算数 */
function sbBindHelloHold() {
  const h = $("#sb-cp-hello");
  if (!h) return;
  // 只有压在 Hello 标题上才算；整页空白不再响应长按
  const hit = h.querySelector(".sb-hello-t") || h;
  let timer = 0, pid = null, hapticTimers = [];
  const cancel = () => {
    clearTimeout(timer); timer = 0; pid = null;
    hapticTimers.forEach(clearTimeout); hapticTimers = [];
    h.classList.remove("press");
  };
  const begin = (e, id) => {
    if (pid !== null) return;
    e.preventDefault();
    pid = id;
    if (typeof id === "number") { try { hit.setPointerCapture(id); } catch (err) {} }
    h.classList.add("press");
    clearTimeout(timer);
    hapticTimers.forEach(clearTimeout);
    // 和顶栏「待机」同一套渐强节奏，只是 1 秒走完：越接近触发越密越重，最后一记重击。
    hapticTimers = SB_MID_HAPTIC.map((step) => setTimeout(() => {
      if (pid !== null) sbHoldHaptic(step.style, step.i);
    }, step.p * 1000));
    timer = setTimeout(() => {
      timer = 0; pid = null;
      h.classList.remove("press");
      const page = document.querySelector('#sb .sb-p[data-p="6"]');
      const st = page && page.dataset.cp;
      if (st === "starting" || st === "auth" || st === "ready" || st === "video") return;
      sbCarPlayStart();
    }, 1000);
  };
  hit.addEventListener("pointerdown", (e) => begin(e, e.pointerId));
  hit.addEventListener("touchstart", (e) => begin(e, "touch"), { passive: false });
  hit.addEventListener("pointerup", (e) => { if (pid === null || e.pointerId === pid) cancel(); });
  hit.addEventListener("pointercancel", cancel);
  hit.addEventListener("touchend", () => { if (pid === "touch") cancel(); }, { passive: true });
  hit.addEventListener("touchcancel", () => { if (pid === "touch") cancel(); }, { passive: true });
  hit.addEventListener("contextmenu", (e) => e.preventDefault());
}

window.wkCarPlayState = function (payload) {
  const p = typeof payload === "string" ? { state: payload, msg: "" } : (payload || {});
  const st = String(p.state || "idle");
  if (st === "credentials") {
    sbCarPlaySheet(true, String(p.ssid || ""), String(p.msg || ""), p.wifi !== false);
    return;
  }
  sbCarPlaySet(st, String(p.msg || ""));
};

function sbCarPlayStart() {
  if (!sbCarPlayMsg({ cmd: "start" })) { sbCarPlaySet("failed", "当前壳版本不支持 CarPlay"); return; }
  sbCarPlaySet("starting", "");
}

function sbCarPlayForget() {
  sbCarPlayMsg({ cmd: "forget" });
  sbCarPlaySheet(true, "", "输入要连接的 Wi-Fi", true);
}

function sbCarPlayPage(idx) {
  const box = $("#sb");
  if (box) box.classList.toggle("sb-cp-page", idx === 6);
  if (idx === 6) {
    sbCarPlayMsg({ cmd: "geometry", flip: box && box.classList.contains("sb-flip") ? 1 : 0 });
    sbDimOff();
  } else if (SB_CP_LAST === 6) {
    sbCarPlayMsg({ cmd: "stop" });
    sbCarPlaySheet(false);
    sbDimArm();
  }
  SB_CP_LAST = idx;
}

/* ---------- 固定：锁当前页、禁翻页、禁退出；再点一下解锁 ---------- */
function sbPaintPin() {
  const s = sbState();
  const box = $("#sb"), b = $("#sb-pin");
  if (box) box.classList.toggle("sb-pinned", !!s.pinned);
  if (b) {
    b.classList.toggle("on", !!s.pinned);
    b.textContent = s.pinned ? "已固定" : "固定";
    b.setAttribute("aria-pressed", s.pinned ? "true" : "false");
  }
}

function sbPinPing() {
  const s = sbState();
  if (!s.pinned || !s.on) return;
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
    if (h) h.postMessage({ cmd: "awake", on: 1 });
  } catch (e) {}
}

function sbPin() {
  const s = sbState();
  s.pinned = !s.pinned;
  clearInterval(s.pinTimer);
  s.pinTimer = null;
  if (s.pinned) { sbPinPing(); s.pinTimer = setInterval(sbPinPing, 3000); }
  else {
    try {
      const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
      if (h) h.postMessage({ cmd: "awake", on: s.awake && s.on ? 1 : 0 });
    } catch (e) {}
  }
  sbPaintPin();
  sbIdleReset();
}

function sbBuild() {
  const s = sbState();
  if (s.built) return;
  s.built = true;
  const box = document.createElement("section");
  box.id = "sb";
  box.className = "hidden";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = `
  <div class="sb-stage">
    <i class="sb-safe" aria-hidden="true"></i>
    <div class="sb-top">
      <button type="button" class="sb-back" id="sb-back" aria-label="长按退出待机">
        <svg viewBox="0 0 24 24" class="sb-back-c" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>
        <svg viewBox="0 0 40 40" class="sb-back-ring" aria-hidden="true">
          <circle class="sb-ring-bg" cx="20" cy="20" r="18.5"/>
          <circle class="sb-ring-fg" id="sb-ring-fg" cx="20" cy="20" r="18.5"/>
        </svg>
      </button>

      <button type="button" class="sb-focus" id="sb-focus" hidden>
        <i class="sb-fdot"></i><span id="sb-focus-t"></span>
      </button>
      <span class="sb-batt" id="sb-batt" hidden>
        <svg viewBox="0 0 30 14" aria-hidden="true">
          <rect class="sb-batt-box" x="1" y="1.6" width="24" height="10.8" rx="3"/>
          <rect class="sb-batt-fill" id="sb-batt-fill" x="3" y="3.6" width="12" height="6.8" rx="1.6"/>
          <path class="sb-batt-nub" d="M27 5.2h1.4a1.2 1.2 0 0 1 1.2 1.2v1.2a1.2 1.2 0 0 1-1.2 1.2H27z"/>
        </svg>
        <b id="sb-batt-t">—</b>
      </span>
    </div>

    <div class="sb-track" id="sb-track">
      <!-- 0 日历 -->
      <div class="sb-p sb-cal" data-p="0">
        <div class="sb-cal-l">
          <div class="sb-cal-md" id="sb-cal-md">11月26日</div>
          <div class="sb-cal-wk"><b id="sb-cal-wk">周四</b><i id="sb-cal-lunar">农历 初二</i></div>
          <span class="sb-cap sb-cal-tr" id="sb-cal-tr"></span>
          <div class="sb-glass" id="sb-cal-meta"></div>
          <div class="sb-hr sb-cal-hr idle" id="sb-cal-hr">
            <b id="sb-cal-hr-bpm">—</b><span>BPM</span>
            <svg viewBox="0 0 240 28" preserveAspectRatio="none" aria-hidden="true"><path id="sb-cal-hr-path" d=""></path></svg>
          </div>
        </div>
        <div class="sb-cal-r sb-glass">
          <div class="sb-grid-h"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
          <div class="sb-grid" id="sb-grid"></div>
        </div>
      </div>

      <!-- 1 今日 · 行情 -->
      <div class="sb-p sb-day" data-p="1">
        <div class="sb-day-hd">
          <span class="sb-cap" id="sb-mkt-state">行情 —</span>
          <span class="sb-cap sb-mkt-wx" id="sb-wx-line"></span>
        </div>
        <div class="sb-day-main">
          <div class="sb-day-l sb-glass" data-sb-peek="hold">
            <div class="sb-day-k">今日盈亏</div>
            <div class="sb-day-v" id="sb-mkt-today">—</div>
            <div class="sb-day-s" id="sb-mkt-sub"></div>
            <div class="sb-day-s sb-day-s2" id="sb-mkt-cnt"></div>
            <div class="sb-hr idle" id="sb-hr">
              <b id="sb-hr-bpm">—</b><span>BPM</span>
              <svg viewBox="0 0 240 28" preserveAspectRatio="none" aria-hidden="true"><path id="sb-hr-path" d=""></path></svg>
            </div>
          </div>
          <div class="sb-day-r sb-glass" id="sb-mkt-rows"></div>
        </div>
        <div class="sb-stamp" id="sb-mkt-stamp"></div>
      </div>

      <!-- 2 数字钟 -->
      <div class="sb-p sb-clock" data-p="2">
        <div class="sb-big"><span id="sb-hm">--:--</span><i id="sb-sec">--</i></div>
        <div class="sb-caps">
          <span class="sb-cap" id="sb-c-date"></span>
          <span class="sb-cap" id="sb-c-meta"></span>
        </div>
      </div>

      <!-- 3 模拟钟 -->
      <div class="sb-p sb-wo" data-p="3">
        <div class="sb-wo-l sb-glass">
          <div class="sb-wo-k">体能训练</div>
          <div class="sb-wo-step" id="sb-wo-step">没有进行中的训练</div>
          <div class="sb-wo-time"><b id="sb-wo-time">--:--</b><span id="sb-wo-sub">剩余</span></div>
          <div class="sb-wo-note" id="sb-wo-note"></div>
          <div class="sb-wo-metrics" id="sb-wo-metrics"></div>
        </div>
        <div class="sb-wo-r sb-glass">
          <div class="sb-wo-hd">
            <span class="sb-wo-k">心率</span>
            <span class="sb-wo-zone" id="sb-wo-zone">未接入</span>
          </div>
          <div class="sb-wo-bpm"><b id="sb-wo-bpm">—</b><span>BPM</span></div>
          <svg class="sb-wo-curve" viewBox="0 0 240 56" preserveAspectRatio="none" aria-hidden="true"><path id="sb-wo-path" d=""></path></svg>
          <div class="sb-wo-zones" id="sb-wo-zones"></div>
          <div class="sb-wo-stats" id="sb-wo-stats">
            <span>峰值<b id="sb-wo-peak">—</b></span>
            <span>均值<b id="sb-wo-avg">—</b></span>
            <span>高强度<b id="sb-wo-hard">—</b><em>分</em></span>
            <span>中强度<b id="sb-wo-easy">—</b><em>分</em></span>
          </div>
          <div class="sb-wo-legend"><span>静息</span><span>热身</span><span>燃脂</span><span>有氧</span><span>无氧</span><span>极限</span></div>
        </div>
      </div>

      <!-- 4 正在播放：镜像系统「音乐」，封面 + 歌词 + 遥控 -->
      <div class="sb-p sb-mu" data-p="4" data-sb-lyr="1">
        <div class="sb-mu-art" id="sb-mu-art"><span>♪</span></div>
        <div class="sb-mu-body">
          <div class="sb-mu-meta">
            <div class="sb-mu-t" id="sb-mu-title">未在播放</div>
            <div class="sb-mu-a" id="sb-mu-artist">在系统「音乐」里放一首</div>
          </div>
          <div class="sb-mu-foot">
          <div class="sb-mu-rail" id="sb-mu-prog">
            <b id="sb-mu-el">0:00</b>
            <span class="sb-mu-track"><i id="sb-mu-fill"></i></span>
            <b id="sb-mu-du">0:00</b>
          </div>
          <div class="sb-mu-row">
            <div class="sb-mu-ctl" id="sb-mu-ctl">
              <button type="button" data-muctl="prev" aria-label="上一首"></button>
              <button type="button" class="play" data-muctl="toggle" id="sb-mu-toggle" aria-label="播放/暂停"></button>
              <button type="button" data-muctl="next" aria-label="下一首"></button>
            </div>
            <div class="sb-mu-tools">
              <button type="button" class="sb-mu-chip" id="sb-mu-listbtn">列表</button>
              <button type="button" class="sb-mu-chip" id="sb-mu-searchbtn">搜索</button>
            </div>
          </div>
          </div>
        </div>
      </div>

      <!-- 5 钟 + 日程 -->
      <div class="sb-p sb-duo" data-p="5">
        <div class="sb-duo-l">
          <div class="sb-big sb-big-sm"><span id="sb-hm2">--:--</span></div>
          <div class="sb-caps" style="margin-top:calc(var(--sb-u) * 14px)">
            <span class="sb-cap" id="sb-d-date"></span>
          </div>
          <div class="sb-duo-f" id="sb-duo-f"></div>
        </div>
        <div class="sb-duo-r sb-glass">
          <div class="sb-duo-h" id="sb-ag-h">今天</div>
          <div class="sb-ag" id="sb-agenda"></div>
        </div>
      </div>

      <!-- 6 CarPlay：画面由壳的原生层盖在这块 699×393 上 -->
      <div class="sb-p sb-cp" data-p="6">
        <div class="sb-hello" id="sb-cp-hello">
          <span class="sb-hello-t" data-text="Hello CarPlay!">Hello CarPlay!</span>
          <span class="sb-hello-hint" id="sb-cp-hint">长按 Hello 进入 CarPlay</span>
        </div>
      </div>
    </div>

    <span class="sb-awake" id="sb-awake" aria-hidden="true"><i></i></span>
    <button type="button" class="sb-flip" id="sb-flip" aria-label="翻转屏幕方向">翻转</button>
    <button type="button" class="sb-pin" id="sb-pin" aria-pressed="false">固定</button>
    <div class="sb-dots" id="sb-dots"></div>
  </div>

    <div class="sb-mlyr hidden" id="sb-mlyr">
      <div class="sheet-body">
        <div class="sheet-head">
          <b id="sb-mlyr-t">歌词</b>
          <button type="button" class="icon-btn" id="sb-mlyr-x" aria-label="关闭">✕</button>
        </div>
        <div class="sb-mlyr-list" id="sb-mlyr-list"></div>
      </div>
    </div>

    <div class="sb-mup hidden" id="sb-mup">
      <div class="sheet-body">
        <div class="sheet-head">
          <button type="button" class="sb-mup-back hidden" id="sb-mup-back">‹ 播放列表</button>
          <b id="sb-mup-t">音乐</b>
          <button type="button" class="icon-btn" id="sb-mup-x" aria-label="关闭">✕</button>
        </div>
        <div class="sb-mup-in">
          <div class="sb-mup-tabs">
            <button type="button" data-mutab="list" class="on">播放列表</button>
            <button type="button" data-mutab="songs">歌曲</button>
            <button type="button" data-mutab="search">搜索专辑</button>
          </div>
          <div class="sb-mup-q hidden" id="sb-mup-q">
            <input id="sb-mup-qin" type="search" placeholder="搜 Apple Music 里的专辑、歌手"
                   enterkeyhint="search" autocomplete="off">
          </div>
          <div class="sb-mup-rows" id="sb-mup-rows"></div>
        </div>
      </div>
    </div>

    <div class="sb-peek hidden" id="sb-peek">
      <div class="sheet-body">
        <div class="sheet-head">
          <b id="sb-peek-t">持仓</b>
          <button type="button" class="icon-btn" id="sb-peek-x" aria-label="关闭">✕</button>
        </div>
        <div class="sb-peek-list" id="sb-peek-list"></div>
      </div>
    </div>

    <div class="sb-cp-sheet hidden" id="sb-cp-sheet">
      <div class="sheet-body">
        <div class="sheet-head">
          <b>CarPlay</b>
          <button type="button" class="icon-btn" id="sb-cp-x" aria-label="关闭">✕</button>
        </div>
        <div class="sb-cp-body">
          <div class="sb-cp-lead">
            <div class="sb-cp-eyebrow"><i></i>WI-FI</div>
            <div class="sb-cp-h1" id="sb-cp-h1">连接 CarPlay</div>
            <div class="sb-cp-p" id="sb-cp-p">CarPlay 走本机局域网，需要先连一个 Wi-Fi。Wi-Fi 可以没有互联网，手机数据照样走蜂窝。</div>
            <div class="sb-cp-chips">
              <span>无需互联网</span><span>密码只存本机</span><span>可随时停止</span>
            </div>
          </div>
          <div class="sb-cp-side">
            <div id="sb-cp-form">
              <div class="sb-cp-field">
                <span>Wi-Fi</span>
                <input id="sb-cp-ssid" type="text" placeholder="网络名称" autocapitalize="none" autocorrect="off" spellcheck="false">
              </div>
              <div class="sb-cp-field">
                <span>密码</span>
                <input id="sb-cp-pwd" type="password" placeholder="开放网络留空" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done">
              </div>
              <div class="sb-cp-actions">
                <button type="button" class="sb-cp-cancel" id="sb-cp-cancel">取消</button>
                <button type="button" class="sb-cp-ok" id="sb-cp-ok">开始</button>
              </div>
            </div>
            <div id="sb-cp-nowifi" class="hidden">
              <div class="sb-cp-nowifi-t">切换步骤</div>
              <div class="sb-cp-nowifi-s">设置 → 无线局域网 → 连接一个网络。可以没有互联网，手机数据仍走蜂窝。</div>
              <button type="button" class="sb-cp-ok" id="sb-cp-wifi-set">打开 Wi-Fi 设置</button>
              <button type="button" class="sb-cp-cancel" id="sb-cp-retry">重试</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="sb-due hidden" id="sb-due">
      <div class="sheet-body">
        <div class="sheet-head">
          <b id="sb-due-t">待处理</b>
          <button type="button" class="icon-btn" id="sb-due-x" aria-label="收起">✕</button>
        </div>
        <div class="sb-due-body" id="sb-due-body"></div>
      </div>
    </div>
`;

  document.body.appendChild(box);
  // 两颗胶囊挂在 #sb 根上：翻转时只转文字，不跟着舞台整体位移
  ["#sb-back", "#sb-flip", "#sb-pin", "#sb-awake"].forEach((sel) => {
    const b = box.querySelector(sel);
    if (b) box.appendChild(b);
  });

  // 退出待机改成「长按返回键、进度环走满一圈」：待机挂在那儿，误触一下不该直接踢出去。
  // 有面板打开时，单击还是先关面板（那一层本来就不需要防误触）。
  sbBindBackHold();
  sbBindHelloHold();
  $("#sb-flip").addEventListener("click", (e) => { e.stopPropagation(); sbFlip(); });
  box.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-sb-lyr]");
    if (hit && sbState().page === 4) {
      if (e.target.closest(".sb-mu-ctl, .sb-mu-rail, .sb-mu-chip")) return;
      const s2 = sbState();
      if (s2.downX != null && Math.abs(e.clientX - s2.downX) > 12) return;   // 刚是滑动翻页，不是点
      e.stopPropagation();
      sbLyrOpen();
      return;
    }
    const line = e.target.closest("#sb-mlyr-list p[data-t]");
    if (line && SB_LYR.open) {
      const t = Number(line.dataset.t) || 0;
      if (typeof muSend === "function") muSend("seek", t);
      const m = muState(); m.elapsed = t;
      sbLyrPaint(true);
    }
  }, true);
  $("#sb-mlyr-x").addEventListener("click", (e) => { e.stopPropagation(); sbLyrClose(); });
  const listBtn = $("#sb-mu-listbtn"), searchBtn = $("#sb-mu-searchbtn"), mup = $("#sb-mup");
  if (listBtn) listBtn.addEventListener("click", (e) => { e.stopPropagation(); sbMuPaneOpen("list"); });
  if (searchBtn) searchBtn.addEventListener("click", (e) => { e.stopPropagation(); sbMuPaneOpen("search"); });
  if (mup) {
    mup.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
    mup.querySelectorAll("[data-mutab]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      SB_MUP.cur = null; SB_MUP.curName = ""; SB_MUP.tracks = [];
      SB_MUP.tab = b.dataset.mutab === "search" ? "search" : (b.dataset.mutab === "songs" ? "songs" : "list");
      sbMuWant(SB_MUP.tab);
      sbMuPanePaint();
      if (SB_MUP.tab === "search") setTimeout(() => { const q = $("#sb-mup-qin"); if (q) q.focus(); }, 120);
    }));
    const x = $("#sb-mup-x");
    if (x) x.addEventListener("click", (e) => { e.stopPropagation(); sbMuPaneClose(); });
    const back = $("#sb-mup-back");
    if (back) back.addEventListener("click", (e) => {
      e.stopPropagation();
      SB_MUP.cur = null; SB_MUP.curName = ""; SB_MUP.tracks = []; SB_MUP.tracksLoading = false;
      sbMuPanePaint();
    });
    const q = $("#sb-mup-qin");
    if (q) q.addEventListener("input", () => {
      clearTimeout(SB_MUP.timer);
      SB_MUP.timer = setTimeout(() => sbMuSearch(q.value), 420);
    });
    const rows = $("#sb-mup-rows");
    // 行重建（换歌单 / 换页签 / 搜索）后自动补封面，省得在每个分支里手动调
    if (rows) new MutationObserver(() => sbMuArtFill()).observe(rows, { childList: true });
    if (rows) rows.addEventListener("click", (e) => {
      const r = e.target.closest(".sb-mup-row");
      if (!r) return;
      e.stopPropagation();
      if (r.dataset.url) { sbOpenUrl(r.dataset.url); sbMuPaneClose(); return; }
      if (r.dataset.pl) {
        const pl = SB_LIB.playlists.find((x) => String(x.id) === String(r.dataset.pl)) || {};
        SB_MUP.cur = String(r.dataset.pl);
        SB_MUP.curName = pl.name || "播放列表";
        SB_MUP.tracks = [];
        SB_MUP.tracksLoading = true;
        sbMuPanePaint();
        if (typeof muSend === "function") muSend("playlistItems", SB_MUP.cur);
        return;
      }
      if (r.dataset.track) {
        if (typeof muSend === "function") muSend("playlistTrack", { list: SB_MUP.cur, track: r.dataset.track });
        sbMuPaneClose();
        return;
      }
      if (r.dataset.song) { if (typeof muSend === "function") muSend("song", r.dataset.song); sbMuPaneClose(); return; }
      if (r.dataset.hist) sbMuPlayHist(r.dataset.hist);
    });
  }
  $("#sb-focus").addEventListener("click", (e) => { e.stopPropagation(); sbPeekOpen("focus"); });
  $("#sb-peek-x").addEventListener("click", (e) => { e.stopPropagation(); sbPeekClose(); });
  box.addEventListener("click", sbPeekClick, true);
  const due = $("#sb-due");
  if (due) due.addEventListener("click", sbDueClick, true);
  if (due) due.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
  $("#sb-due-x").addEventListener("click", (e) => { e.stopPropagation(); sbDueHide(); });
  box.addEventListener("pointerdown", sbDown, true);
  box.addEventListener("pointerup", sbUp, true);
  box.addEventListener("pointercancel", sbUp, true);
  const track = $("#sb-track");
  // 翻页自己接管：原生 scroll + scroll-snap 在 rotate 过的舞台里会被 WebKit 吃掉惯性，
  // 表现就是「点一下它才动一下」。这里按住时 1:1 跟着手指走，松手再按距离/速度吸到整页。
  track.style.touchAction = "none";
  track.addEventListener("touchstart", sbDragStart, { passive: true });
  track.addEventListener("touchmove", sbDragMove, { passive: false });
  track.addEventListener("touchend", sbDragEnd, { passive: true });
  track.addEventListener("touchcancel", sbDragEnd, { passive: true });
  track.addEventListener("scroll", sbScroll, { passive: true });
  $("#sb-dots").addEventListener("click", (e) => {
    const b = e.target.closest("[data-dot]");
    if (!b) return;
    e.stopPropagation();
    sbGo(Number(b.dataset.dot));
  });
  document.addEventListener("visibilitychange", sbVis);
  document.addEventListener("keydown", sbKey);
  // 壳体切横竖屏时 innerWidth/Height 会变，舞台尺寸和安全区必须跟着重算
  const relayout = () => { if (!sbIsOn()) return; sbLayout(); };
  window.addEventListener("resize", relayout);
  window.addEventListener("orientationchange", () => setTimeout(relayout, 160));


  const muCtl = $("#sb-mu-ctl");
  if (muCtl && typeof MU_ICON !== "undefined") {
    muCtl.children[0].innerHTML = MU_ICON.prev;
    muCtl.children[2].innerHTML = MU_ICON.next;
    muCtl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-muctl]");
      if (!b) return;
      e.stopPropagation();
      if (typeof muSend === "function") muSend(b.dataset.muctl);
    });
  }
  const muProg = $("#sb-mu-prog");
  if (muProg) {
    muProg.addEventListener("click", (e) => {
      const m = (typeof muState === "function" ? muState() : {}) || {};
      const dur = Number(m.dur) || 0;
      if (!dur) return;
      const track = muProg.querySelector(".sb-mu-track") || muProg;
      const r = track.getBoundingClientRect();
      let ratio = (e.clientX - r.left) / r.width;
      if (sbState().land === false) ratio = 1 - ratio;   // 竖屏预览时舞台转过 90°，横坐标方向要翻过来
      ratio = Math.max(0, Math.min(1, ratio));
      if (typeof muSend === "function") muSend("seek", ratio * dur);
      // 兜底：壳那边 1 秒才会推新进度，先把本地 elapsed 改掉，不然这一秒又被旧值刷回去
      m.elapsed = ratio * dur;
      const f = $("#sb-mu-fill");
      if (f) f.style.width = (ratio * 100) + "%";
      const e2 = $("#sb-mu-el");
      if (e2 && typeof muFmt === "function") e2.textContent = muFmt(ratio * dur);
    });
  }
  const cpGo = $("#sb-cp-go");
  if (cpGo) cpGo.addEventListener("click", (e) => { e.stopPropagation(); sbCarPlayStart(); });
  const cpReset = $("#sb-cp-reset");
  if (cpReset) cpReset.addEventListener("click", (e) => { e.stopPropagation(); sbCarPlayForget(); });
  const cpSheet = $("#sb-cp-sheet");
  if (cpSheet) cpSheet.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
  const cpOk = $("#sb-cp-ok"), cpCancel = $("#sb-cp-cancel"), cpX = $("#sb-cp-x");
  if (cpOk) cpOk.addEventListener("click", (e) => { e.stopPropagation(); sbCarPlaySubmit(); });
  [cpCancel, cpX].forEach((b) => b && b.addEventListener("click", (e) => {
    e.stopPropagation(); sbCarPlaySheet(false); sbCarPlayMsg({ cmd: "stop" }); sbCarPlaySet("idle", "");
  }));
  const cpWiFi = $("#sb-cp-wifi-set");
  if (cpWiFi) cpWiFi.addEventListener("click", (e) => { e.stopPropagation(); sbCarPlayMsg({ cmd: "wifiSettings" }); });
  const cpRetry = $("#sb-cp-retry");
  if (cpRetry) cpRetry.addEventListener("click", (e) => {
    e.stopPropagation(); sbCarPlaySheet(false); sbCarPlayMsg({ cmd: "start" }); sbCarPlaySet("starting", "");
  });
  const pin = $("#sb-pin");
  if (pin) pin.addEventListener("click", (e) => { e.stopPropagation(); sbPin(); });

  const dots = $("#sb-dots");
  dots.innerHTML = Array.from({ length: SB_PAGES }, (_, i) =>
    `<button type="button" data-dot="${i}" aria-label="第 ${i + 1} 页"></button>`).join("");
}

/* 让壳把屏幕转过去：1 = 横屏（待机），0 = 恢复竖屏（应用） */
function sbOrient(on) {
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
    if (h) h.postMessage({ cmd: "orient", on: on ? 1 : 0 });
  } catch (e) { /* 浏览器里没有壳，靠舞台自己 rotate */ }
}

/* ---------- 舞台尺寸 / 安全区 ---------- */
function sbLayout() {
  const s = sbState();
  const box = $("#sb");
  if (!box) return;
  const vw = window.innerWidth || 393;
  const vh = window.innerHeight || 852;
  const land = vw > vh + 1;
  s.land = land;
  box.classList.toggle("sb-land", land);
  box.classList.toggle("sb-flip", !!s.flip);
  const stage = box.querySelector(".sb-stage");
  if (!stage) return;
  if (land) {
    stage.style.width = vw + "px";
    stage.style.height = vh + "px";
  } else {
    stage.style.width = vh + "px";
    stage.style.height = vw + "px";
  }
  const sh = land ? vh : vw;   // 舞台高度：竖屏时等于屏宽
  const u = sh / 393;
  box.style.setProperty("--sb-u", String(u));
  // 安全区：竖屏旋转后，原来的 top/bottom inset 落到舞台的左右
  const probe = box.querySelector(".sb-safe");
  let it = 0, ib = 0, il = 0, ir = 0;
  if (probe) {
    const cs = getComputedStyle(probe);
    it = parseFloat(cs.paddingTop) || 0;
    ib = parseFloat(cs.paddingBottom) || 0;
    il = parseFloat(cs.paddingLeft) || 0;
    ir = parseFloat(cs.paddingRight) || 0;
  }
  let left, right;
  if (land) { left = il; right = ir; }
  else { left = s.flip ? ib : it; right = s.flip ? it : ib; }
  box.style.setProperty("--sb-pl", Math.max(20, left + 20) + "px");
  box.style.setProperty("--sb-pr", Math.max(20, right + 16) + "px");
  sbGo(s.page, true);
}

/* ---------- 返回键：长按退出 ---------- */
var SB_BACK_HOLD = 1200;            // 一圈走完要按住多久（ms）

function sbBindBackHold() {
  const btn = $("#sb-back");
  const fg = $("#sb-ring-fg");
  if (!btn) return;
  let raf = 0, t0 = 0, done = false;

  const paint = (p) => {
    if (!fg) return;
    // 18.5 半径的周长 ≈ 116.24，dashoffset 从满到 0 就是「走一圈」
    fg.style.strokeDashoffset = String(116.24 * (1 - p));
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    done = false;
    btn.classList.remove("press");
    paint(0);
  };
  const tick = () => {
    const p = Math.min(1, (Date.now() - t0) / SB_BACK_HOLD);
    paint(p);
    if (p >= 1) {
      done = true;
      btn.classList.remove("press");
      try { navigator.vibrate && navigator.vibrate(28); } catch (e) {}
      sbClose();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (sbState().pinned) return;
    const pk = $("#sb-peek"), due = $("#sb-due");
    if ((pk && !pk.classList.contains("hidden")) || (due && !due.classList.contains("hidden"))) {
      done = false;
      return;                       // 有面板：这一下交给 pointerup 去关面板
    }
    done = false;
    t0 = Date.now();
    btn.classList.add("press");
    paint(0);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }, true);

  const release = (e) => {
    if (!raf && !done) return;
    if (e) { e.stopPropagation(); }
    if (!done) stop();
  };
  btn.addEventListener("pointerup", (e) => {
    if (!done) {
      // 没按满就松手 = 当作一次轻点：先关面板，面板都关着就什么都不做（退出必须长按）
      stop();
      const pk = $("#sb-peek"), due = $("#sb-due");
      if (pk && !pk.classList.contains("hidden")) { e.stopPropagation(); sbPeekClose(); return; }
      if (due && !due.classList.contains("hidden")) { e.stopPropagation(); sbDueHide(); return; }
      e.stopPropagation();
    }
  }, true);
  btn.addEventListener("pointercancel", (e) => release(e), true);
  btn.addEventListener("pointerleave", (e) => release(e), true);
  // 长按期间别让浏览器弹菜单
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
}

function sbFlip() {
  const s = sbState();
  if (s.pinned) return;
  s.flip = !s.flip;
  sbLayout();
  if (SB_CP_LAST === 6) sbCarPlayMsg({ cmd: "geometry", flip: s.flip ? 1 : 0 });
  sbIdleReset();
}

/* ---------- 常亮：右上角呼吸点 ----------
   点按 3 秒一次呼吸，涨到最大的那一拍向壳（和应用自己）报一次「还在」，
   壳收到 awake 就把 isIdleTimerDisabled 打开，屏幕不会自己暗下去。 */
/* ---------- 电量：壳把 UIDevice 的电量推上来（网页拿不到电池 API） ----------
   满格宽度固定 18 单位，按百分比填；充电时图标换成闪电色，数字仍是真的电量。 */
function sbBattery(level, charging) {
  const s = sbState();
  const lv = Number(level);
  s.batt = (isFinite(lv) && lv >= 0 && lv <= 1) ? lv : null;
  s.battChg = !!charging && Number(charging) !== 0;
  sbPaintBatt();
}

function sbPaintBatt() {
  const s = sbState();
  const el = $("#sb-batt"), fill = $("#sb-batt-fill"), t = $("#sb-batt-t");
  if (!el) return;
  const lv = s.batt;
  if (lv === null || lv === undefined) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle("chg", !!s.battChg);
  el.classList.toggle("low", lv <= 0.2 && !s.battChg);
  if (fill) fill.setAttribute("width", (1.2 + lv * 17).toFixed(1));
  if (t) t.textContent = Math.round(lv * 100) + "%";
}

function sbAskBatt() {
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
  if (h) { try { h.postMessage({ cmd: "batt" }); } catch (e) {} }
}

function sbAwakeOn() { return !!sbState().awake; }

function sbAwakePaint() {
  const el = $("#sb-awake");
  if (el) el.classList.toggle("off", !sbState().awake);
}

function sbAwakePing() {
  const s = sbState();
  if (!s.on || !s.awake) return;
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
    if (h) h.postMessage({ cmd: "awake", on: 1 });
  } catch (e) { /* 浏览器里没有壳，靠下面的活动兜底 */ }
  try { document.dispatchEvent(new Event("pointermove")); } catch (e) {}
}

function sbAwakeStop() {
  const s = sbState();
  if (s.awakeTimer) { clearTimeout(s.awakeTimer); s.awakeTimer = null; }
}

function sbAwakeSet(on) {
  const s = sbState();
  s.awake = !!on;
  try { localStorage.setItem("sbAwake", s.awake ? "1" : "0"); } catch (e) {}
  sbAwakePaint();
  sbAwakeStop();
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
    if (h) h.postMessage({ cmd: "awake", on: s.awake && s.on ? 1 : 0 });
  } catch (e) {}
  if (s.awake && s.on) sbAwakeStart();
}

function sbAwakeStart() {
  const s = sbState();
  if (!s.on || !s.awake) return;
  sbAwakeStop();
  // 和 CSS 的呼吸节拍对齐：0% 小、50% 最大，正好 1.5 秒时叫一次，之后每 3 秒一次
  const beat = () => {
    sbAwakePing();
    s.awakeTimer = setTimeout(beat, 3000);
  };
  s.awakeTimer = setTimeout(beat, 1500);
}

/* 退出 App 再重进时，如果上一次是在待机里（没被手动退出），直接回到待机。
   启动时 app-chart 的 boot() 比这个脚本先跑，所以不能只靠 showApp 里的一次调用，
   这里自己盯着：等启动图撤掉、不是登录页，再进待机。 */
function sbAutoRestore() {
  let stay = "0";
  try { stay = localStorage.getItem("sbStay") || "0"; } catch (e) { return; }
  if (stay !== "1") return;
  const tick = (n) => {
    if (sbIsOn()) return;
    if (document.querySelector("#login:not(.hidden)")) return;      // 退到登录页就别进
    const app = document.querySelector("#app");
    const ready = app && !app.classList.contains("hidden") && !document.querySelector("#splash");
    if (!ready) { if (n < 60) setTimeout(() => tick(n + 1), 120); return; }
    sbOpen();
  };
  setTimeout(() => tick(0), 120);
}

/* ---------- 开关 ---------- */
function sbOpen() {
  const s = sbState();
  sbBuild();
  if (s.on) return;
  // 进待机前先把可能残留的 CarPlay 原生层收掉，避免黑屏/触控被它挡住
  try { sbCarPlayMsg({ cmd: "stop" }); } catch (e) {}
  const n = sbNow();
  s.day = n.day;
  s.on = true;
  s.page = Math.max(0, Math.min(SB_PAGES - 1, Number(s.page) || 0));
  const box = $("#sb");
  document.body.classList.add("sb-on");
  try { localStorage.setItem("sbStay", "1"); } catch (e) {}
  sbOrient(1);
  if (!s.battTimer) s.battTimer = setInterval(() => { if (sbState().on && !document.hidden) sbAskBatt(); }, 60000);          // 待机一律横屏：壳把 SupportedInterfaceOrientations 切到 landscapeRight
  box.classList.remove("hidden");
  box.setAttribute("aria-hidden", "false");
  sbAskBatt();
  sbPaintBatt();
  if (typeof muSend === "function") muSend("start");   // 待机里那一页要镜像正在播放，先让壳开始 1Hz 推送
  s.lastTouch = Date.now();
  s.lastTurn = Date.now();
  sbLayout();
  sbPaintAll();
  requestAnimationFrame(() => {
    if (!s.on) return;
    box.classList.add("on");
    sbGo(s.page, true);   // 等舞台真正有宽度后再落位，避免开在第二页时停在中间
  });
  // 壳转屏是异步的，转完尺寸才会变：这里再补一次落位，免得停在转屏前算出来的竖屏尺寸
  setTimeout(() => { if (s.on) { sbLayout(); sbPaintAll(); } }, 420);
  // 还竖着说明那一拍没转成功，再补一次（壳里第二拍一定会走 geometry 请求）
  setTimeout(() => { if (s.on && window.innerWidth < window.innerHeight) sbOrient(1); }, 700);
  sbIdleReset();
  sbAwakePaint();
  sbAwakeStart();
  sbStartTimers();
  sbLoadWx();
  sbLoadWork();
  sbLoadDash();
  sbLoadQuotes();
  sbLoadStocks();
  try {
    if (typeof wkLoadCalData === "function") {
      const p = wkLoadCalData();
      // 农历/节假日是异步拉的，回来要连日期行一起重画（不然「农历 十八」停在空）
      if (p && p.then) p.then(() => { const n2 = sbNow(); sbPaintCal(n2); sbPaintTexts(n2); }).catch(() => {});
    }
  } catch (e) { /* 农历/节假日拿不到就按工作日算 */ }
}

function sbClose(instant) {
  const s = sbState();
  if (!s.on) return;
  s.pinned = false;
  clearInterval(s.pinTimer); s.pinTimer = null;
  sbPaintPin();
  if (SB_CP_LAST === 6) sbCarPlayMsg({ cmd: "stop" });
  s.on = false;
  sbDimOff();
  sbOrient(0);
  if (typeof muSend === "function") muSend("stop");
  setTimeout(() => sbOrient(0), 600);   // 退出时也补一拍，别停在横屏里看竖屏页面
  sbDueHide();
  sbLyrClose(true);
  if (typeof sbMuPaneClose === "function") sbMuPaneClose(true);
  sbAwakeStop();
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
    if (h) h.postMessage({ cmd: "awake", on: 0 });
  } catch (e) {}
  sbStopTimers();
  clearTimeout(s.idleTimer);
  const box = $("#sb");
  const pk0 = $("#sb-peek");
  if (pk0) { pk0.classList.remove("on"); pk0.classList.add("hidden"); }
  document.body.classList.remove("sb-on");
  try { localStorage.setItem("sbPage", String(s.page)); localStorage.setItem("sbStay", "0"); } catch (e) {}
  if (!box) return;
  box.classList.remove("on");
  box.setAttribute("aria-hidden", "true");
  const done = () => {
    box.classList.add("hidden");
    box.classList.remove("sb-incog");
  };
  if (instant) done(); else setTimeout(done, 190);
}

function sbStartTimers() {
  const s = sbState();
  if (s.tickTimer) return;
  s.tickTimer = setInterval(sbTick, 1000);
}

function sbStopTimers() {
  const s = sbState();
  if (s.tickTimer) { clearInterval(s.tickTimer); s.tickTimer = null; }
}

function sbVis() {
  const s = sbState();
  if (!s.on) return;
  if (document.hidden) { sbDimOff(); sbStopTimers(); }
  else { sbStartTimers(); sbPaintAll(); sbIdleReset(); }
}

function sbKey(e) {
  const s = sbState();
  if (!s.on) return;
  if (e.key === "Escape") {
    const pk = $("#sb-peek");
    if (pk && !pk.classList.contains("hidden")) { sbPeekClose(); return; }
    sbClose(); return;
  }
  // 物理竖滑＝舞台横滑，方向键按舞台坐标走
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { sbGo(s.page + 1); e.preventDefault(); }
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") { sbGo(s.page - 1); e.preventDefault(); }
}

/* ---------- 无操作自动轮播 ----------
   静置 20 秒后开始，每 12 秒翻一页；有任何触摸/按键/开面板都重新计时。
   提醒弹层、展开层、整屏歌词开着时不翻，免得把正在看的东西翻走。 */
var SB_AUTO_IDLE = 20000;
var SB_AUTO_TURN = 12000;

function sbAutoTurn() {
  const s = sbState();
  if (!s.on) return;
  const now = Date.now();
  if (now - (s.lastTouch || 0) < SB_AUTO_IDLE) return;
  if (now - (s.lastTurn || 0) < SB_AUTO_TURN) return;
  const pk = $("#sb-peek");
  if (pk && !pk.classList.contains("hidden")) return;
  const due = $("#sb-due");
  if (due && !due.classList.contains("hidden")) return;
  if (typeof SB_LYR !== "undefined" && SB_LYR.open) return;
  if (typeof SB_MUP !== "undefined" && SB_MUP.open) return;
  s.lastTurn = now;
  sbGo((s.page + 1) % SB_PAGES, false, true);
}

/* ---------- 分页 ---------- */
function sbGo(i, silent, auto) {
  const s = sbState();
  if (s.pinned && !silent) return;
  const track = $("#sb-track");
  if (!track) return;
  const idx = Math.max(0, Math.min(SB_PAGES - 1, i));
  s.page = idx;
  const w = track.clientWidth || 1;
  if (track.scrollLeft !== idx * w) {
    track.scrollTo({ left: idx * w, behavior: silent ? "auto" : "smooth" });
  }
  sbPaintDots();
  sbCarPlayPage(idx);
  if (idx === 1) { sbLoadWx(); sbLoadDash(); sbLoadQuotes(); sbLoadStocks(); }
  if (idx === 5) sbLoadWork();
  // 自动轮播不碰 idle / 隐藏态：隐藏的 chrome 只在手动干预时回来
  if (auto) s.autoUntil = Date.now() + 900;
  else { s.autoUntil = 0; sbIdleReset(); }
}

function sbScroll() {
  const s = sbState();
  if (!s.on) return;
  if (s.autoUntil && Date.now() < s.autoUntil) return;
  const track = $("#sb-track");
  if (!track) return;
  const w = track.clientWidth || 1;
  const idx = Math.max(0, Math.min(SB_PAGES - 1, Math.round(track.scrollLeft / w)));
  if (idx !== s.page) {
    s.page = idx;
    sbPaintDots();
    if (idx === 1) { sbLoadWx(); sbLoadDash(); sbLoadQuotes(); sbLoadStocks(); }
    if (idx === 5) sbLoadWork();
    sbIdleReset();
  }
}

/* ---------- 翻页：跟手拖动 ---------- */
function sbDragTheta() {
  try {
    const st = document.querySelector("#sb .sb-stage");
    const m = new DOMMatrixReadOnly(getComputedStyle(st).transform);
    return Math.atan2(m.b, m.a);
  } catch (e) { return 0; }
}

function sbDragStart(e) {
  const s = sbState();
  const sheet = $("#sb-cp-sheet");
  if (!s.on || s.pinned || (sheet && !sheet.classList.contains("hidden")) || e.touches.length !== 1) return;
  const track = $("#sb-track");
  if (!track) return;
  clearTimeout(s.swipeTimer);
  $("#sb").classList.add("sb-swipe");
  const t = e.touches[0];
  s.drag = true;
  s.dragMoved = false;
  s.dragX = t.clientX;
  s.dragY = t.clientY;
  s.dragLeft = track.scrollLeft;
  s.dragT = Date.now();
  s.dragV = 0;
}

function sbDragMove(e) {
  const s = sbState();
  const track = $("#sb-track");
  if (!s.on || !s.drag || !track || e.touches.length !== 1) return;
  const t = e.touches[0];
  const dx = t.clientX - s.dragX, dy = t.clientY - s.dragY;
  if (!s.dragMoved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
  s.dragMoved = true;
  const th = sbDragTheta();
  // 屏幕位移换回舞台的横轴位移（竖屏时舞台转了 90°，手指上滑就是下一张）
  const along = Math.cos(th) * dx + Math.sin(th) * dy;
  track.scrollLeft = s.dragLeft - along;
  const now = Date.now();
  const dt = Math.max(1, now - s.dragT);
  s.dragV = (-along) / dt;         // 舞台横轴上的速度（px/ms）
  s.dragT = now;
  s.scrollingAt = now;
  e.preventDefault();
}

function sbDragEnd() {
  const s = sbState();
  const track = $("#sb-track");
  if (!s.drag) return;
  s.drag = false;
  clearTimeout(s.swipeTimer);
  if (!track || !s.dragMoved) { $("#sb").classList.remove("sb-swipe"); return; }
  s.swipeTimer = setTimeout(() => $("#sb").classList.remove("sb-swipe"), 420);
  s.dragMoved = false;
  const w = track.clientWidth || 1;
  const moved = track.scrollLeft - s.dragLeft;     // 正数＝去了后一张
  const v = s.dragV * 1000;                        // px/s
  let page = Math.round(track.scrollLeft / w);
  // 只有真的拖出去一段（>6% 屏宽）才认速度，避免手指轻轻一抖就整页翻走
  if (Math.abs(moved) > w * 0.18 || (Math.abs(v) > 320 && Math.abs(moved) > w * 0.06)) {
    page = moved > 0 || v > 0 ? Math.floor(s.dragLeft / w) + 1 : Math.ceil(s.dragLeft / w) - 1;
  }
  page = Math.max(0, Math.min(SB_PAGES - 1, page));
  s.page = page;
  s.scrollingAt = Date.now();
  sbGlide(page);
}

/* 松手后的落页：自己补一段短动画，取代 smooth scrollTo（后者在旋转舞台里经常一顿一顿 */
function sbGlide(page) {
  const track = $("#sb-track");
  if (!track) return;
  const w = track.clientWidth || 1;
  const from = track.scrollLeft, to = page * w;
  if (Math.abs(to - from) < 1) { sbGo(page, true); return; }
  const t0 = performance.now();
  const dur = Math.min(360, 150 + Math.abs(to - from) / 3);
  const ease = (u) => 1 - Math.pow(1 - u, 3);
  const step = (now) => {
    const u = Math.min(1, (now - t0) / dur);
    track.scrollLeft = from + (to - from) * ease(u);
    if (u < 1) requestAnimationFrame(step);
    else sbGo(page, true);
  };
  requestAnimationFrame(step);
}

function sbPaintDots() {
  const s = sbState();
  $$("#sb-dots [data-dot]").forEach((b) => b.classList.toggle("on", Number(b.dataset.dot) === s.page));
}

/* ---------- 点击 / 长按 ---------- */
function sbDown(e) {
  const s = sbState();
  s.downX = e.clientX; s.downY = e.clientY; s.downAt = Date.now(); s.downEl = e.target;
  s.lastTouch = Date.now();
  sbIdleReset();
}

function sbUp(e) {
  const s = sbState();
  if (!s.on) return;
  const dx = Math.abs(e.clientX - s.downX), dy = Math.abs(e.clientY - s.downY);
  if (dx < 12 && dy < 12 && Date.now() - s.downAt < 450) {
    const el = s.downEl;
    if (el && el.closest && el.closest("button")) return;
    sbTap(e);
  }
}

function sbTap(e) {
  const s = sbState();
  if (!s.on) return;
  if (e && e.target && e.target.closest && e.target.closest("button")) return;
  // 可跳转的数据块自己处理点击，别顺手把圆点/翻转隐掉
  if (e && e.target && e.target.closest && (e.target.closest("#sb-peek") || e.target.closest("#sb-due") || e.target.closest("#sb-cp-sheet"))) return;
  sbIdleReset();
}

/* 闲置降亮：CarPlay 页除外；任何操作都先还原，再重新计时。 */
function sbDimOff() {
  const s = sbState();
  clearTimeout(s.dimTimer); s.dimTimer = null;
  if (!s.dimmed) return;
  s.dimmed = false;
  try { if (window.wkBrightness) window.wkBrightness(false); } catch (e) {}
}

function sbDimArm() {
  const s = sbState();
  clearTimeout(s.dimTimer); s.dimTimer = null;
  if (!s.on || s.page === 6) { sbDimOff(); return; }
  s.dimTimer = setTimeout(() => {
    s.dimTimer = null;
    if (!s.on || s.page === 6 || document.hidden) return;
    if (typeof window.wkBrightness !== "function") return;
    s.dimmed = true;
    try { window.wkBrightness(true); } catch (e) { s.dimmed = false; }
  }, SB_DIM_AFTER);
}

function sbIdleReset() {
  const s = sbState();
  clearTimeout(s.idleTimer);
  sbDimOff();
  const box = $("#sb");
  if (box) box.classList.remove("sb-incog");
  s.idleTimer = setTimeout(() => {
    if (s.on) $("#sb").classList.add("sb-incog");
  }, 5000);
  sbDimArm();
}

function sbMidTap(e) {
  e.preventDefault();
  e.stopPropagation();
  if (sbMidHeld) { sbMidHeld = false; return; }   // 长按已经进过了，这次的 click 不再重复
  sbOpen();
}

/* ---------- 展开层：数据块只展开细节，点击不再跳到应用里 ---------- */
var SB_PEEK_TITLE = { hold: "持仓", work: "今天", focus: "专注", shift: "班次", alerts: "提醒" };

function sbPeekRow(k, v, cls, v2) {
  return `<div class="sb-peek-row">`
    + `<span class="sb-peek-k">${esc(k)}</span>`
    + `<b class="sb-peek-v ${cls || ""}">${esc(v)}</b>`
    + (v2 ? `<span class="sb-peek-v2">${esc(v2)}</span>` : "")
    + `</div>`;
}

function sbPeekRow2(main, meta) {
  return `<div class="sb-peek-row l2">`
    + `<div class="sb-peek-l2"><b>${esc(main)}</b><span>${esc(meta)}</span></div>`
    + `</div>`;
}

function sbPeekOpen(kind) {
  const s = sbState();
  if (!s.on) return;
  const box = $("#sb-peek");
  if (!box) return;
  const t = $("#sb-peek-t"), list = $("#sb-peek-list");
  if (t) t.textContent = SB_PEEK_TITLE[kind] || "";
  if (list) {
    if (kind === "alerts") { list.innerHTML = `<div class="sb-peek-empty">读取中…</div>`; sbPeekAlerts(list); }
    else list.innerHTML = sbPeekRows(kind);
  }
  if (list) sbPannable(list);
  if (list) list.scrollTop = 0;
  box.classList.remove("hidden");
  requestAnimationFrame(() => box.classList.add("on"));
  sbIdleReset();
}

function sbPeekClose(after) {
  const box = $("#sb-peek");
  if (!box) return;
  box.classList.remove("on");
  setTimeout(() => { box.classList.add("hidden"); if (after) after(); }, 150);
}

/* ---------- 待处理：到点时待机自己上滑，不退出待机 ----------
   以前一到点就 sbClose 掉待机、整屏切到工作页，用户手上正看着待机就被弹走；
   现在改成底部上滑一张面板，当前这条能直接「稍后 / 知道了」，下面顺带列出今天还没做的事。 */
function sbDueShow(a) {
  const s = sbState();
  if (!s.on || !a) return;
  s.due = a;
  const box = $("#sb-due");
  if (!box) return;
  sbDuePaint(a);
  if (!box.classList.contains("hidden") && box.classList.contains("on")) { sbIdleReset(); return; }
  box.classList.remove("hidden");
  requestAnimationFrame(() => box.classList.add("on"));
  sbIdleReset();
}

function sbDueHide() {
  const box = $("#sb-due");
  if (!box || box.classList.contains("hidden")) return;
  box.classList.remove("on");
  sbIdleReset();                   // 收起后这一小段先别重排心率/曲线
  setTimeout(() => { if (box && !box.classList.contains("on")) box.classList.add("hidden"); }, 170);
}

function sbDuePaint(a) {
  const s = sbState();
  const body = $("#sb-due-body");
  if (!body || !a) return;
  const kind = a.kind || "task";
  if (a.kind === "shift") { /* 上班提醒只有一个动作，下面按钮自然变成一枚 */ }
  const kindLabel = kind === "focus" ? "专注提醒" : kind === "shift" ? "上班提醒" : kind === "daily" ? "每日提醒" : "日程到点";
  const focusEnd = kind === "focus" && /_end$/.test(String(a.id || "")) && !!a.runId;
  const noTask = kind === "task" && !a.task;
  const meta = String(a.meta || "");
  const when = meta.indexOf("·") >= 0 ? meta.slice(0, meta.indexOf("·")).trim() : meta.trim();
  const restOfMeta = meta.indexOf("·") >= 0 ? meta.slice(meta.indexOf("·") + 1).trim() : "";
  const actSnooze = (kind === "shift" || noTask || (kind === "focus" && !focusEnd)) ? "" : focusEnd ? "跳过这一步" : "10 分钟后再提醒";
  const actOff = focusEnd ? "进入下一步" : "知道了";
  const rest = sbDueRest(a);
  body.innerHTML = `
    <div class="sb-due-now">
      <div class="sb-due-now-top">
        <div class="sb-due-meta"><i class="sb-due-dot"></i><span>${esc(kindLabel)}${when ? " · " + esc(when) : ""}</span></div>
        <div class="sb-due-title">${esc(a.title || "到点提醒")}</div>
        ${restOfMeta ? `<div class="sb-due-sub">${esc(restOfMeta)}</div>` : ""}
      </div>
      <div class="sb-due-acts">
        ${actSnooze ? `<button type="button" class="sb-due-btn" data-sb-due-act="snooze">${esc(actSnooze)}</button>` : ""}
        <button type="button" class="sb-due-btn primary" data-sb-due-act="off">${esc(actOff)}</button>
      </div>
    </div>
    ${rest}`;
}

/* 今天还没做完的日程（不含当前这条），只用来让用户看清「后面还有几件」 */
function sbDueRest(a) {
  const s = sbState();
  const today = sbNow().day;
  const curId = a && a.task ? String(a.task.id) : "";
  const open = (((s.work && s.work.tasks) || []))
    .filter((t) => !t.done && String(t.due_at || "").slice(0, 10) === today && String(t.id) !== curId)
    .sort((x, y) => (String(x.due_at) < String(y.due_at) ? -1 : 1))
    .slice(0, 5);
  if (!open.length) return "";
  return `<div class="sb-due-side"><div class="sb-due-rest-h">今天还有</div><div class="sb-due-rest">`
    + open.map((t) => `<div class="sb-due-row"><b>${esc(String(t.due_at).slice(11, 16))}</b>`
      + `<span>${esc(t.title || "")}</span></div>`).join("")
    + `</div></div>`;
}

function sbDueClick(e) {
  const b = e.target && e.target.closest ? e.target.closest("[data-sb-due-act]") : null;
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const act = b.dataset.sbDueAct;
  sbDueHide();                     // 先把面板收起来，视觉上立刻有反馈
  // 真正的处理（停铃、改期、重算通知）放到下一拍，别卡住这次收起的动画
  requestAnimationFrame(() => setTimeout(() => {
    try { if (typeof window.wkAlarmAction === "function") window.wkAlarmAction(act); }
    catch (err) { /* 动作失败也别把待机卡住 */ }
  }, 0));
}

function sbPeekRows(kind) {
  const s = sbState();
  const out = [];
  const cls = (v) => (Number(v) > 0 ? "up" : Number(v) < 0 ? "down" : "");
  if (kind === "hold") {
    const qs = Object.entries((s.quotes && s.quotes.quotes) || {})
      .map(([code, x]) => ({ code, ...x }))
      .filter((x) => sbNum(x.pct) !== null);
    const held = ((s.stocks || []).filter((r) => (r.bucket || "watch") === "hold" && Number(r.shares) > 0))
      .map((r) => {
        const q0 = qs.find((x) => String(x.code || "") === String(r.code));
        if (!q0) return null;
        const alias = (Array.isArray(r.custom_tags) && r.custom_tags[0]) || r.group_name || q0.name || "";
        return { ...q0, alias, shares: Number(r.shares) || 0, cost: Number(r.cost) || 0 };
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.pct) - Number(a.pct));
    const h = (s.dash && s.dash.hold) || null;
    if (h) {
      out.push(sbPeekRow("今日", sbFmtSigned(h.today), cls(h.today)));
      out.push(sbPeekRow("市值 · 浮动", `${Number(h.mv || 0).toFixed(2)} · ${sbFmtSigned(h.pct)}%`));
    }
    held.forEach((x) => out.push(sbPeekRow(x.alias, `${sbFmtSigned(x.pct)}%`, cls(x.pct),
      x.price === undefined || x.price === null ? "" : num(x.price, 3))));
    if (!held.length) return out.join("") || `<div class="sb-peek-empty">还没有持仓</div>`;
    return out.join("");
  }
  if (kind === "work") {
    const today = sbNow().day;
    const tasks = ((s.work && s.work.tasks) || [])
      .filter((t) => String(t.due_at || "").slice(0, 10) === today)
      .sort((a, b) => (String(a.due_at) < String(b.due_at) ? -1 : 1));
    const open = tasks.filter((t) => !t.done);
    open.forEach((t) => out.push(sbPeekRow(String(t.due_at).slice(11, 16), t.title || "")));
    if (!tasks.length) out.push(`<div class="sb-peek-empty">今天没有安排</div>`);
    const doneN = tasks.length - open.length;
    if (doneN) out.push(`<div class="sb-peek-note">另有 ${doneN} 项已完成</div>`);
    return out.join("");
  }
  if (kind === "focus") {
    const run = (s.work && s.work.focus && s.work.focus.run) || null;
    if (!run) {
      out.push(`<div class="sb-peek-empty">现在没有在跑的场次</div>`);
      return out.join("");
    }
    const steps = run.snapshot || [];
    const idx = Number(run.step_idx) || 0;
    steps.forEach((st, i) => {
      const mark = i < idx ? "✓ " : i === idx ? "· " : "";
      const mins = Number(st.minutes) || 0;
      out.push(sbPeekRow(`${i + 1}. ${mark}${st.title || ""}`, `${String(st.anchor || "").slice(0, 5)} · ${mins} 分`, i === idx ? "on" : ""));
    });
    return out.join("");
  }
  if (kind === "shift") {
    const base = sbNow();
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(base.y, base.m - 1, base.d + i));
      const day = d.toISOString().slice(0, 10);
      const sh = sbShiftInfo(day);
      const wk = ["日", "一", "二", "三", "四", "五", "六"][d.getUTCDay()];
      const txt = !sh ? "—" : sh.rest ? "休息" : sh.type
        ? (sh.type.start && sh.type.end
          ? `${sh.type.name} ${String(sh.type.start).slice(0, 5)}–${String(sh.type.end).slice(0, 5)}`
          : String(sh.type.name || "—"))
        : "未排班";
      out.push(sbPeekRow(`${day.slice(5)} 周${wk}`, txt, i === 0 ? "on" : ""));
    }
    return out.join("");
  }
  return out.join("");
}

async function sbPeekAlerts(list) {
  const s = sbState();
  if (!s.alerts || Date.now() - s.alertsAt > 60e3) {
    try { s.alerts = await api("price-alerts", { noRetry: true }, 10000); s.alertsAt = Date.now(); }
    catch (e) { s.alerts = null; }
  }
  if (!s.on) return;
  const d = s.alerts;
  if (!d) { list.innerHTML = `<div class="sb-peek-empty">提醒数据暂时取不到</div>`; return; }
  const evs = d.events || [];
  const act = d.active || [];
  const out = [];
  out.push(`<div class="sb-peek-sub">最近触发</div>`);
  if (!evs.length) out.push(`<div class="sb-peek-empty">还没有触发过</div>`);
  evs.slice(0, 4).forEach((e) => out.push(sbPeekRow2(
    e.name || e.code || "",
    [String(e.fired_at || "").slice(5, 16),
      `${(ALERT_KIND_LABEL && ALERT_KIND_LABEL[e.kind]) || e.kind} ${num(e.value, 3)}`,
      e.price === undefined || e.price === null ? "" : `现价 ${num(e.price, 3)}`].filter(Boolean).join(" · "))));
  out.push(`<div class="sb-peek-sub">在用的提醒</div>`);
  if (!act.length) out.push(`<div class="sb-peek-empty">还没有设置提醒</div>`);
  act.slice(0, 4).forEach((a) => out.push(sbPeekRow2(
    a.name || a.code || "",
    `${(ALERT_KIND_LABEL && ALERT_KIND_LABEL[a.kind]) || a.kind} ${num(a.value, 3)}`)));
  list.innerHTML = out.join("");
}



/* 待机里的详情是一层被旋转过的高层，WebKit 的原生滚动在这种 transform 里常失灵：
   这里自己做拖动滚动，按舞台的实际旋转把屏幕位移换回内容的纵向位移 */
function sbPannable(list) {
  if (!list || list.dataset.sbPan) return;
  list.dataset.sbPan = "1";
  list.style.touchAction = "none";
  let sx = 0, sy = 0, top = 0, drag = false, moved = false;
  const theta = () => {
    try {
      const st = document.querySelector("#sb .sb-stage");
      const m = new DOMMatrixReadOnly(getComputedStyle(st).transform);
      return Math.atan2(m.b, m.a);
    } catch (e) { return 0; }
  };
  list.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; top = list.scrollTop; drag = true; moved = false;
  }, { passive: true });
  list.addEventListener("touchmove", (e) => {
    if (!drag || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    moved = true;
    const th = theta();
    const v = -Math.sin(th) * dx + Math.cos(th) * dy;   // 内容的纵向位移
    list.scrollTop = top - v;
    e.preventDefault();
  }, { passive: false });
  const end = () => { drag = false; };
  list.addEventListener("touchend", end, { passive: true });
  list.addEventListener("touchcancel", end, { passive: true });
  list.addEventListener("click", (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
  }, true);
}

function sbPeekClick(e) {
  const el = e.target && e.target.closest ? e.target.closest("[data-sb-peek]") : null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  sbPeekOpen(el.dataset.sbPeek);
}



/* ---------- 每秒 ---------- */
function sbTick() {
  const s = sbState();
  if (!s.on || document.hidden) return;
  const n = sbNow();
  if (n.day !== s.day) {
    s.day = n.day;
    sbPaintCal(n);
    sbPaintTexts(n);
  }
  sbPaintTime(n);
  // 正在滑动或刚松手的那半秒先只走时钟：卡片背面没有模糊了，但重排 DOM 仍会吃掉滑动的帧
  if (Date.now() - (s.scrollingAt || 0) > 500) {
    sbPaintHr();
    sbPaintWorkout(n);
  sbMuPaint();
  sbLyrPaint();
    sbPaintHealth();
    sbPaintFocus();
  }
  // 到点提醒现在在待机里自己上滑显示（#sb-due），不再为了弹卡退出待机；
  // 只有编辑弹层 / 登录这类真正挡住全屏的层才让位
  const sheet = $("#sheet:not(.hidden)");
  const login = $("#login:not(.hidden)");
  if (sheet || login) { sbClose(true); return; }
  sbAutoTurn();
  if (s.work && Date.now() - s.workAt > 60e3) sbLoadWork();
  if (s.dash && Date.now() - s.dashAt > 60e3) sbLoadDash();
  if (s.quotes && Date.now() - s.quotesAt > 60e3) sbLoadQuotes();
  if (s.stocks && Date.now() - s.stocksAt > 10 * 60e3) sbLoadStocks();
  if (Date.now() - (s.hrAt || 0) > 25e3) sbLoadHr();
}

/* ---------- 数据 ---------- */
async function sbLoadWx() {
  const s = sbState();
  if (!s.on) return;
  if (s.wx && Date.now() - s.wxAt < 10 * 60e3) return;
  if (s.wxBusy) return;
  s.wxBusy = true;
  try {
    const d = await api("weather", { noRetry: true }, 9000);
    if (d && d.ok) { s.wx = d; s.wxAt = Date.now(); }
    else { s.wxAt = Date.now() - 8 * 60e3; }   // 失败 2 分钟后重试，不每秒打上游
  } catch (e) { s.wxAt = Date.now() - 8 * 60e3; }
  s.wxBusy = false;
  sbPaintMarket();
}

async function sbLoadHr() {
  const s = sbState();
  if (!s.on || s.hrBusy) return;
  s.hrBusy = true;
  try {
    const d = await api("hr", { noRetry: true }, 8000);
    if (d && d.ok) {
      s.hrAt = Date.now();
      if (Number(d.max_bpm)) s.hrMax = Number(d.max_bpm);
      if (d.metrics && typeof d.metrics === "object") {
        s.health = Object.assign({}, s.health || {}, d.metrics);
        s.healthAt = Number(d.metrics_at) * 1000 || s.healthAt;
      }
      const remote = (d.samples || [])
        .map((x) => {
          let t = Number(x.at) || 0;
          if (t && t < 1e12) t *= 1000;   // 服务端存的是秒，本地是毫秒
          return { v: Number(x.bpm), t };
        })
        .filter((x) => x.v >= 25 && x.v <= 240);
      if (remote.length) {
        const seen = new Map((s.hr || []).map((x) => [x.t, x]));
        remote.forEach((x) => seen.set(x.t, x));
        // 留 30 分钟：强度分钟要按分钟分桶，只留一分钟的样本算不出来
        const cut = Date.now() - 30 * 60 * 1000;
        s.hr = [...seen.values()].filter((x) => x.t >= cut)
          .sort((a, b) => a.t - b.t).slice(-1800);
      }
    } else {
      s.hrAt = Date.now() - 10e3;
    }
  } catch (e) {
    s.hrAt = Date.now() - 10e3;
  }
  s.hrBusy = false;
  sbPaintHr();
}

async function sbLoadWork() {
  const s = sbState();
  if (!s.on || s.workBusy) return;
  s.workBusy = true;
  try {
    const d = await api("work", { noRetry: true }, 12000);
    if (d) { s.work = d; s.workAt = Date.now(); state.work = d; }
    else { s.workAt = Date.now(); }
  } catch (e) { s.workAt = Date.now(); }   // 失败也记时，60 秒后才重试，不每秒打后端
  s.workBusy = false;
  sbPaintFocus();
  sbPaintAgenda();
  sbPaintMeta();   // 班次/待办/专注都靠这份数据，晚到也要补画一次
  if (s.due && $("#sb-due") && !$("#sb-due").classList.contains("hidden")) sbDuePaint(s.due);
}

/* ---------- 画一屏 ---------- */
function sbPaintAll() {
  const n = sbNow();
  sbPaintTexts(n);
  sbPaintCal(n);
  sbPaintMarket();
  sbPaintMeta();
  sbPaintTime(n);
  sbPaintHr();
  sbPaintWorkout(n);
  sbMuPaint();
  sbPaintAgenda();
  sbPaintFocus();
  sbPaintHealth();
  sbPaintDots();
}

function sbLunar(day) {
  try { return (typeof wkLunarText === "function" && wkLunarText(day)) || ""; } catch (e) { return ""; }
}

function sbDateLine(n) {
  const l = sbLunar(n.day);
  return `${n.md} 周${n.week}${l ? ` · 农历 ${l}` : ""}`;
}

function sbPaintTexts(n) {
  $("#sb-cal-md").textContent = n.md;
  $("#sb-cal-wk").textContent = `周${n.week}`;
  const l = sbLunar(n.day);
  $("#sb-cal-lunar").textContent = l ? `农历 ${l}` : "";
  $("#sb-cal-lunar").style.display = l ? "" : "none";
  $("#sb-c-date").textContent = sbDateLine(n);
  $("#sb-d-date").textContent = sbDateLine(n);
  $("#sb-ag-h").textContent = "今天";
}

function sbPaintTime(n) {
  const hm = `${sbPad(n.hh)}:${sbPad(n.mm)}`;
  $("#sb-hm").textContent = hm;
  $("#sb-hm2").textContent = hm;
  $("#sb-sec").textContent = sbPad(n.ss);
}

function sbPaintAnalog(n) {
  const sec = n.ss * 6;
  const min = n.mm * 6 + n.ss * 0.1;
  const hr = (n.hh % 12) * 30 + n.mm * 0.5;
  const el = (id) => document.getElementById(id);
  if (el("sb-ah")) el("sb-ah").setAttribute("transform", `rotate(${hr} 100 100)`);
  if (el("sb-am")) el("sb-am").setAttribute("transform", `rotate(${min} 100 100)`);
  if (el("sb-as")) el("sb-as").setAttribute("transform", `rotate(${sec} 100 100)`);
}

function sbIsTrading(day) {
  let hol = null;
  try { hol = (typeof wkHolidayOf === "function" && wkHolidayOf(day)) || null; } catch (e) { hol = null; }
  if (hol && hol.off) return false;
  if (hol && hol.work) return true;
  const [y, m, d] = String(day).split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5;
}

function sbPaintCal(n) {
  const grid = $("#sb-grid");
  if (!grid) return;
  const y = n.y, m = n.m;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = n.d;
  let cells = "";
  for (let i = 0; i < lead; i++) cells += `<span class="sb-gc blank"></span>`;
  for (let d = 1; d <= days; d++) {
    const day = `${y}-${sbPad(m)}-${sbPad(d)}`;
    const hol = (function () { try { return (typeof wkHolidayOf === "function" && wkHolidayOf(day)) || null; } catch (e) { return null; } })();
    const off = !!(hol && hol.off);
    const wk = !!(hol && hol.work);
    const cls = ["sb-gc"];
    if (d === today) cls.push("today");
    if (off) cls.push("off");
    if (wk) cls.push("wk");
    cells += `<span class="${cls.join(" ")}">${d}</span>`;
  }
  const tail = (7 - ((lead + days) % 7)) % 7;
  for (let i = 0; i < tail; i++) cells += `<span class="sb-gc blank"></span>`;
  grid.innerHTML = cells;
  let left = 0;
  for (let d = today; d <= days; d++) {
    if (sbIsTrading(`${y}-${sbPad(m)}-${sbPad(d)}`)) left++;
  }
  const box = $("#sb-cal-tr");
  if (box) box.textContent = left ? `本月还有 ${left} 个交易日` : "本月交易日已走完";
}

function sbNum(v) { return v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v); }

/* ---------- 第 1 页：今日 · 行情 ---------- */
function sbFmtSigned(v, d) {
  const n = sbNum(v);
  if (n === null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(d === undefined ? 2 : d)}`;
}
function sbWxLine() {
  const d = sbState().wx;
  if (!d) return "";
  const now = d.now || {};
  const t = sbNum(now.temp);
  const desc = now.desc ? ` ${now.desc}` : "";
  return `${t === null ? "—" : Math.round(t)}°${desc}`;
}

async function sbLoadQuotes() {
  const s = sbState();
  if (!s.on || s.quoteBusy) return;
  if (s.quotes && Date.now() - s.quotesAt < 60e3) return;
  s.quoteBusy = true;
  try {
    const d = await api("quotes", { noRetry: true }, 12000);
    if (d && d.quotes) { s.quotes = d; s.quotesAt = Date.now(); }
    else { s.quotesAt = Date.now() - 45e3; }
  } catch (e) { s.quotesAt = Date.now() - 45e3; }
  s.quoteBusy = false;
  sbPaintMarket();
}

async function sbLoadStocks() {
  const s = sbState();
  if (!s.on || s.stockBusy) return;
  if (s.stocks && Date.now() - s.stocksAt < 10 * 60e3) return;
  s.stockBusy = true;
  try {
    const d = await api("stocks", { noRetry: true }, 12000);
    if (d) { s.stocks = d.stocks || d || []; s.stocksAt = Date.now(); }
    else { s.stocksAt = Date.now() - 8 * 60e3; }
  } catch (e) { s.stocksAt = Date.now() - 8 * 60e3; }
  s.stockBusy = false;
  sbPaintMarket();
}

async function sbLoadDash() {
  const s = sbState();
  if (!s.on || s.dashBusy) return;
  if (s.dash && Date.now() - s.dashAt < 60e3) return;
  s.dashBusy = true;
  try {
    const d = await api("dashboard", { noRetry: true }, 15000);
    if (d) { s.dash = d; s.dashAt = Date.now(); }
    else { s.dashAt = Date.now() - 45e3; }
  } catch (e) { s.dashAt = Date.now() - 45e3; }
  s.dashBusy = false;
  sbPaintMarket();
  sbPaintMeta();
}

function sbPaintMarket() {
  const s = sbState();
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  const q = s.quotes, d = s.dash;
  // 顶行：市场状态（收盘/交易中）+ 行情是否延迟；右边是天气一行
  let stateTxt = "行情 —";
  if (q && q.market) stateTxt = q.market.text || (q.market.state === "open" ? "交易中" : "已收盘");
  // 收盘后上游缓存旧一点是正常的，只在开市时提示延迟，别在夜里挂个「延迟」吓人
  if (q && q.stale && q.market && q.market.state === "open") stateTxt += " · 延迟";
  set("#sb-mkt-state", stateTxt);
  set("#sb-wx-line", sbWxLine());

  const h = (d && d.hold) || null;
  const today = h ? sbNum(h.today) : null;
  const tv = $("#sb-mkt-today");
  if (tv) {
    tv.textContent = sbFmtSigned(today);
    // 没有数据时别用 66px 的大字号画一个「—」，那是一根横线不是数字
    tv.className = "sb-day-v" + (today === null ? " sb-day-v-empty" : today > 0 ? " up" : today < 0 ? " down" : "");
  }
  set("#sb-mkt-sub", h
    ? `市值 ${sbNum(h.mv) === null ? "—" : Number(h.mv).toFixed(2)} · 浮动 ${h.pct === null || h.pct === undefined ? "—" : sbFmtSigned(h.pct) + "%"}`
    : "还没有持仓数据");
  set("#sb-mkt-cnt", h && sbNum(h.n) !== null ? `持仓 ${Math.round(sbNum(h.n))} 只 · 成本 ${Number(h.cost || 0).toFixed(0)}` : "");

  // 右栏：持仓里涨最猛 / 跌最狠 / 未读提醒（实在没有持仓就退回全部自选）
  const rows = [];
  const qs = Object.entries((q && q.quotes) || {})
    .map(([code, x]) => ({ code, ...x }))
    .filter((x) => sbNum(x.pct) !== null && !x.stale);
  // 持仓带的自定义标签（「黄金联接」「美股·生物科技」）比基金全名短得多，待机屏上用它更省字
  const held = ((s.stocks || []).filter((r) => (r.bucket || "watch") === "hold" && Number(r.shares) > 0))
    .map((r) => {
      const q0 = qs.find((x) => String(x.code || "") === String(r.code));
      if (!q0) return null;
      const alias = (Array.isArray(r.custom_tags) && r.custom_tags[0]) || r.group_name || q0.name || "";
      return { ...q0, alias };
    })
    .filter(Boolean);
  const pool = held.length ? held : qs.map((x) => ({ ...x, alias: x.name || "" }));
  let top = null, low = null;
  if (pool.length) {
    pool.sort((a, b) => Number(b.pct) - Number(a.pct));
    top = pool[0]; low = pool[pool.length - 1];
  }
  const lead = top || (d && d.lead);
  if (lead) rows.push(["领涨", `${lead.alias || lead.name || ""}`, sbFmtSigned(lead.pct) + "%", "hold"]);
  if (low && (!lead || low.code !== lead.code)) rows.push(["领跌", `${low.alias || low.name || ""}`, sbFmtSigned(low.pct) + "%", "hold"]);
  const un = d ? Number(d.alert_unread) || 0 : null;
  rows.push(["提醒", un === null ? "—" : un ? `${un} 条未读` : "没有未读", "", "alerts"]);
  const box = $("#sb-mkt-rows");
  if (box) {
    box.innerHTML = rows.map(([k, name, val, act]) =>
      `<div class="sb-day-row"${act ? ` data-sb-peek="${act}"` : ""}><em>${k}</em><b><span>${esc(name)}</span><i class="${val.startsWith("+") ? "up" : val.startsWith("-") ? "down" : ""}">${esc(val)}</i></b></div>`
    ).join("");
  }
  const stamp = q && q.market && q.market.server_time
    ? `数据 ${String(q.market.server_time).slice(11, 16)}`
    : (d ? "数据 —" : "");
  set("#sb-mkt-stamp", stamp);
}

/* ---------- 心率：只画真实采样，没人喂数就保持「未接入」 ----------
   网页在 iOS 里拿不到 HealthKit，心率全靠壳里的蓝牙中心（BleHeart）当 BLE 外设收样本，
   收到就 push window.sbHrSample(bpm, at)；也可以用快捷指令 POST 上来。
   曲线和数字就会跟着动；没有任何数据时不画假的波形。 */
function sbHrSample(bpm, at) {
  const s = sbState();
  const v = Number(bpm);
  if (!v || v < 25 || v > 240) return;
  s.hr = s.hr || [];
  s.hr.push({ v, t: Number(at) || Date.now() });
  // 留 30 分钟（1Hz 最多 1800 条）：只留 40 条的话「高强度分钟」根本没法算
  if (s.hr.length > 1800) s.hr.shift();
  sbPaintHr();
}

var SB_HR_ZONES = [
  { name: "静息", lo: 0, hi: 50, color: "#8e8e93", tip: "强度偏低，还没热起来" },
  { name: "热身", lo: 50, hi: 60, color: "#5ac8fa", tip: "热身区间，再顶两分钟就进燃脂" },
  { name: "燃脂", lo: 60, hi: 70, color: "#30d158", tip: "燃脂区间，轻松、能长时间扛" },
  { name: "有氧", lo: 70, hi: 80, color: "#ffd60a", tip: "有氧区间，能说话但微喘，最值得久待" },
  { name: "无氧", lo: 80, hi: 90, color: "#ff9f0a", tip: "无氧区间，说话费劲，单次别超十分钟" },
  { name: "极限", lo: 90, hi: 999, color: "#ff453a", tip: "极限区间，尽快把强度降下来" },
];

function sbHrMax() {
  const s = sbState();
  const v = Number(s.hrMax) || Number(localStorage.getItem("hrMax")) || 0;
  return v >= 120 && v <= 230 ? v : 190;
}

function sbHrZoneIdx(bpm) {
  const pct = (Number(bpm) / sbHrMax()) * 100;
  for (let i = SB_HR_ZONES.length - 1; i >= 0; i--) if (pct >= SB_HR_ZONES[i].lo) return i;
  return 0;
}

function sbHrPath(arr, w, h, px) {
  const vs = arr.map((x) => x.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 10) { const mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5; }
  lo -= 2; hi += 2;
  const pts = arr.map((x, i, a) => {
    const k = a.length > 1 ? i / (a.length - 1) : 0.5;
    const y = (h - 2) - ((x.v - lo) / (hi - lo)) * (h - 6);
    return `${(k * (w - px * 2) + px).toFixed(1)},${y.toFixed(1)}`;
  });
  if (pts.length === 1) pts.unshift(pts[0]);
  return `M${pts.join(" L")}`;
}

/* 近 30 分钟的强度账：按分钟分桶取均值，再用最大心率的百分比判强度。
   WHO / Apple 的口径——中强度 1 分钟记 1 分钟，高强度 1 分钟记 2 分钟。
   这里只做「够不够、练了多久」的提示，不替用户下训练结论。 */
function sbHrStats(windowMs) {
  const s = sbState();
  const now = Date.now();
  const win = windowMs || 30 * 60 * 1000;
  const list = (s.hr || []).filter((x) => now - x.t <= win && now - x.t >= 0);
  if (!list.length) return null;
  const max = sbHrMax();
  const buckets = new Map();
  for (const x of list) {
    const k = Math.floor(x.t / 60000);
    const b = buckets.get(k) || { sum: 0, n: 0, peak: 0 };
    b.sum += x.v; b.n += 1; if (x.v > b.peak) b.peak = x.v;
    buckets.set(k, b);
  }
  let hard = 0, easy = 0;
  for (const b of buckets.values()) {
    const avg = b.sum / b.n;
    if (avg >= max * 0.8) hard += 2;
    else if (avg >= max * 0.6) easy += 1;
  }
  const peak = Math.max(...list.map((x) => x.v));
  const avg = list.reduce((a, x) => a + x.v, 0) / list.length;
  return { peak: Math.round(peak), avg: Math.round(avg), hard, easy, n: list.length };
}

function sbPaintHrStats() {
  const st = sbHrStats(30 * 60 * 1000);
  const pk = $("#sb-wo-peak"), av = $("#sb-wo-avg"), hd = $("#sb-wo-hard"), ez = $("#sb-wo-easy");
  const box = $("#sb-wo-stats");
  if (!pk) return;
  if (!st) {
    if (box) box.classList.add("idle");
    if (pk) pk.textContent = "—";
    if (av) av.textContent = "—";
    if (hd) hd.textContent = "—";
    if (ez) ez.textContent = "—";
    return;
  }
  if (box) box.classList.remove("idle");
  if (pk) pk.textContent = String(st.peak);
  if (av) av.textContent = String(st.avg);
  if (hd) hd.textContent = String(Math.round(st.hard));
  if (ez) ez.textContent = String(Math.round(st.easy));
}

function sbPaintHr() {
  const s = sbState();
  const now = Date.now();
  const list = (s.hr || []).filter((x) => now - x.t < 15 * 60 * 1000);
  const last = list.length ? list[list.length - 1] : null;
  const fresh = last && now - last.t < 120 * 1000;      // 小胶囊：两分钟内才算「在跳」
  const recent = last && now - last.t < 10 * 60 * 1000;  // 体能页：手表十分钟一条也算这一场的区间

  // 顶栏中间：心率数字 + 迷你曲线（90 秒没新样本就收起来，回到纯「待机 ›」）
  const th = $("#sb-hint-hr"), tb = $("#sb-hint-bpm"), tp = $("#sb-hint-path");
  if (th) {
    const lit = !!last && now - last.t < 90 * 1000;
    th.hidden = !lit;
    if (tb) tb.textContent = lit ? String(Math.round(last.v)) : "";
    if (tp) tp.setAttribute("d", lit ? sbHrPath(list.slice(-40), 120, 16, 2) : "");
    th.style.color = "";      // 颜色交给样式表（固定红，区间色只留在体能页）
  }

  // 今日盈亏页的小胶囊
  const box = $("#sb-hr");
  const path = $("#sb-hr-path");
  const bpmEl = $("#sb-hr-bpm");
  if (box) {
    box.classList.toggle("idle", !fresh);
    if (bpmEl) bpmEl.textContent = last ? String(Math.round(last.v)) : "—";
    if (path) path.setAttribute("d", list.length ? sbHrPath(list.slice(-60), 240, 28, 1) : "");
  }

  // 日历页左下：只要在跳就在，跟今日盈亏同款排布
  const cb = $("#sb-cal-hr"), cp = $("#sb-cal-hr-path"), cbp = $("#sb-cal-hr-bpm");
  if (cb) {
    cb.classList.toggle("idle", !fresh);
    if (cbp) cbp.textContent = last ? String(Math.round(last.v)) : "—";
    if (cp) cp.setAttribute("d", list.length ? sbHrPath(list.slice(-60), 240, 28, 2) : "");
  }

  // 体能训练页
  const wb = $("#sb-wo-bpm"), wz = $("#sb-wo-zone"), wp = $("#sb-wo-path");
  if (wb) wb.textContent = last ? String(Math.round(last.v)) : "—";
  if (wp) wp.setAttribute("d", list.length ? sbHrPath(list.slice(-60), 240, 56, 2) : "");
  const idx = last ? sbHrZoneIdx(last.v) : -1;
  if (wz) {
    const z = idx >= 0 ? SB_HR_ZONES[idx] : null;
    wz.textContent = z ? z.name : "未接入";
    wz.classList.toggle("stale", !!z && !recent);
    wz.style.color = z ? z.color : "";
    wz.style.borderColor = z ? z.color + "66" : "";
  }
  const zbox = $("#sb-wo-zones");
  if (zbox && !zbox.childElementCount) {
    zbox.innerHTML = SB_HR_ZONES.map((z) => `<i style="color:${z.color}"></i>`).join("");
  }
  if (zbox) {
    [...zbox.children].forEach((el, i) => el.classList.toggle("on", i === idx && !!recent));
  }
  s.hrZone = idx >= 0 && recent ? idx : -1;
  sbPaintHrStats();
}

function sbPaintWorkout() {
  const s = sbState();
  const run = s.work && s.work.focus && s.work.focus.run;
  const stepEl = $("#sb-wo-step"), timeEl = $("#sb-wo-time"), subEl = $("#sb-wo-sub"), noteEl = $("#sb-wo-note");
  const card = $("#sb .sb-wo-l");
  let info = null;
  if (run && run.status === "running" && typeof focusStepInfo === "function") {
    try { info = focusStepInfo(run); } catch (e) { info = null; }
  }
  if (card) card.classList.toggle("idle", !info);
  if (!info) {
    if (stepEl) stepEl.textContent = "没有进行中的训练";
    if (timeEl) timeEl.textContent = "—";
    if (subEl) subEl.textContent = "待机";
    if (noteEl) noteEl.textContent = "去工作台开一场专注，这里会跟着走";
  } else {
    const left = Math.max(0, info.endMs - (typeof wkNowMs === "function" ? wkNowMs() : Date.now()));
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    if (timeEl) timeEl.textContent = `${mm}:${sbPad(ss)}`;
    if (subEl) subEl.textContent = "剩余";
    if (stepEl) stepEl.textContent = `第 ${info.idx + 1}/${info.total} 步 · ${(info.step && info.step.title) || "专注"}`;
    if (noteEl) {
      const z = s.hrZone;
      noteEl.textContent = z >= 0 ? SB_HR_ZONES[z].tip : "心率还没接上，先按步走";
    }
  }
  // 区间条上的颜色也在提示「现在算有氧还是无氧」
  const z = s.hrZone;
  const zonePill = $("#sb-wo-zone");
  if (zonePill && z >= 0 && info) zonePill.title = SB_HR_ZONES[z].tip;
}

/* ---------- 健康指标（壳把 HealthKit 的今日汇总推上来） ----------
   只显示真实数值；某个字段没拿到就不出现，不拿 0 冒充。 */
var SB_HEALTH_CELLS = [
  { k: "active_energy", label: "活动", unit: "kcal", round: 0 },
  { k: "steps", label: "步数", unit: "", round: 0 },
  { k: "distance", label: "距离", unit: "km", round: 2 },
  { k: "exercise_min", label: "运动", unit: "分", round: 0 },
  { k: "stand_hours", label: "站立", unit: "时", round: 0 },
];

function sbHealthSnapshot(o) {
  const s = sbState();
  if (!o || typeof o !== "object") return;
  const m = o.metrics && typeof o.metrics === "object" ? o.metrics : o;
  s.health = Object.assign({}, s.health || {}, m);
  s.healthAt = Date.now();
  if (o.max_bpm) s.hrMax = Number(o.max_bpm);
  sbPaintHealth();
  // 推一份到服务端，换设备/重开页面也能看到同一组数
  try {
    api("health", { method: "POST", idempotent: true, body: { metrics: s.health, max_bpm: sbHrMax() } }, 8000).catch(() => {});
  } catch (e) {}
}

function sbHealthState(o) {
  const s = sbState();
  s.healthState = o || {};
  sbPaintHealth();
}

function sbPaintHealth() {
  const s = sbState();
  const box = $("#sb-wo-metrics");
  if (!box) return;
  const h = s.health || {};
  const cells = SB_HEALTH_CELLS.filter((c) => h[c.k] !== undefined && h[c.k] !== null && isFinite(Number(h[c.k])));
  box.innerHTML = cells.map((c) => {
    const v = Number(h[c.k]);
    const txt = c.round === 0 ? String(Math.round(v)) : v.toFixed(c.round);
    return `<div><b>${txt}</b><span>${c.label}${c.unit ? " " + c.unit : ""}</span></div>`;
  }).join("");
  box.classList.toggle("on", cells.length > 0);

  const st = s.healthState || {};
  const note = $("#sb-wo-note");
  if (note && (!s.hr || !s.hr.length)) {
    if (st.error) note.textContent = st.error;
    else if (st.ok === false) note.textContent = "还没收到心率 · 更多 → 心率接入";
  }
}

/* 给壳/外部一个稳定入口，命名沿用 sb 前缀 */
window.sbHrSample = sbHrSample;
window.sbHealthSnapshot = sbHealthSnapshot;
window.sbHealthState = sbHealthState;

/* ---------- 另外三页的关键信息（班次 / 待办 / 专注 / 提醒） ---------- */
/* shiftInfo() 读的是全局 state.work；待机自己拉的那份在 s.work，借用时临时换一下再换回来 */
function sbShiftInfo(day) {
  const s = sbState();
  if (!s.work || typeof shiftInfo !== "function") return null;
  const save = state.work;
  state.work = s.work;
  try { return shiftInfo(day); } catch (e) { return null; } finally { state.work = save; }
}

function sbTodayStats() {
  const s = sbState();
  const day = sbNow().day;
  const wk = s.work || {};
  const tasks = (wk.tasks || []).filter((t) => String(t.due_at || "").slice(0, 10) === day);
  const open = tasks.filter((t) => !t.done);
  const run = (wk.focus && wk.focus.run) || null;
  const running = run && run.status === "running";
  const steps = running ? (run.snapshot || []) : [];
  const shift = sbShiftInfo(day);
  return {
    openN: open.length,
    shiftTxt: !shift ? "" : (shift.type
      ? `${shift.type.name} ${String(shift.type.start || "").slice(0, 5)}–${String(shift.type.end || "").slice(0, 5)}`
      : (shift.rest ? "休息" : "未排班")),
    shiftShort: shift && shift.type ? `${shift.type.name} ${String(shift.type.start || "").slice(0, 5)}` : (shift && shift.rest ? "休息" : ""),
    focusTxt: running ? `${Number(run.step_idx) + 1}/${steps.length || 0}` : "",
    alert: (sbState().dash ? Number(sbState().dash.alert_unread) || 0 : null),
  };
}

function sbPaintMeta() {
  const st = sbTodayStats();
  const box = $("#sb-cal-meta");
  if (box) {
    const rows = [];
    if (st.shiftTxt) rows.push(`<div data-sb-peek="shift">班次 <b>${esc(st.shiftTxt)}</b></div>`);
    rows.push(`<div data-sb-peek="${st.focusTxt ? "focus" : "work"}">待办 <b>${st.openN ? st.openN + " 项" : "没有"}</b>${st.focusTxt ? ` · 专注 <b>第 ${st.focusTxt} 步</b>` : ""}</div>`);
    rows.push(st.alert === null ? `<div>提醒 <b>—</b></div>`
      : `<div data-sb-peek="alerts">提醒 <b>${st.alert ? st.alert + " 条未读" : "没有未读"}</b></div>`);
    box.innerHTML = rows.join("");
  }
  const cm = $("#sb-c-meta");
  if (cm) {
    const hold = (sbState().dash && sbState().dash.hold) || null;
    const today = hold ? sbNum(hold.today) : null;
    const alertTxt = st.alert ? `提醒 ${st.alert}` : "无提醒";
    const alertBit = `<span data-sb-peek="alerts">${alertTxt}</span>`;
    cm.innerHTML = hold
      ? `<span data-sb-peek="hold" class="${today === null ? "" : today > 0 ? "up" : today < 0 ? "down" : ""}">今日 ${sbFmtSigned(today)}</span> · ${alertBit}`
      : `<span data-sb-peek="work">${esc(st.openN + " 项待办")}</span> · ${alertBit}`;
  }
  const df = $("#sb-duo-f");
  if (df) {
    df.dataset.sbPeek = "shift";
    df.textContent = [st.shiftTxt, st.alert === null ? "" : (st.alert ? `${st.alert} 条提醒` : "没有未读提醒")]
      .filter(Boolean).join(" · ");
  }
}

/* 待机第 5 页：镜像系统「音乐」的横屏播放器 */
function sbMuPaint() {
  const title = $("#sb-mu-title");
  if (!title) return;
  const m = (typeof muState === "function" ? muState() : {}) || {};
  const key = (typeof muKey === "function") ? muKey(m) : "";
  const art = $("#sb-mu-art");
  const a = state.musicArt;
  const url = a && a.url && a.key === key ? a.url : "";
  if (art) {
    if (url) {
      if (art.dataset.u !== url) { art.style.backgroundImage = `url("${url}")`; art.dataset.u = url; }
      art.classList.add("on");
    } else if (art.classList.contains("on")) {
      art.style.backgroundImage = ""; art.dataset.u = ""; art.classList.remove("on");
    }
  }
  // 壳没拿到 artwork（云端曲目经常是 nil）就自己按歌名+艺人抓一张，抓不到也隔 20 秒再试
  if (!url && m.title && typeof muFetchCover === "function") muFetchCover(m);

  // 记录「最近在听」，播放列表就是它
  if (key && m.title) {
    if (SB_MUP.lastK !== key) { SB_MUP.lastK = key; sbMuHistPush(m, url); }
    if (url && SB_MUP.artK !== key) { SB_MUP.artK = key; sbMuHistArt(key, url); }
  }

  title.textContent = m.title || "未在播放";
  const ar = $("#sb-mu-artist");
  if (ar) ar.textContent = m.title ? [m.artist, m.album].filter(Boolean).join(" · ") : (m.auth === "denied" ? "媒体库权限被拒绝" : "在系统「音乐」里放一首");

  const dur = Number(m.dur) || 0, cur = Number(m.elapsed) || 0;
  const fill = $("#sb-mu-fill");
  if (fill) fill.style.width = dur > 0 ? Math.min(100, (cur / dur) * 100) + "%" : "0%";
  const el = $("#sb-mu-el"), du = $("#sb-mu-du"), tog = $("#sb-mu-toggle");
  if (el) el.textContent = muFmt(cur);
  if (du) du.textContent = muFmt(dur);
  if (tog && tog.dataset.st !== (m.state || "")) {
    tog.dataset.st = m.state || "";
    tog.innerHTML = m.state === "playing" ? MU_ICON.pause : MU_ICON.play;
  }

}

/* ---------- 整屏歌词：复用待机展开层的壳（.sheet-body / .sheet-head） ---------- */
if (document.readyState === "complete") setTimeout(sbAutoRestore, 0);
else window.addEventListener("load", () => setTimeout(sbAutoRestore, 0));

var SB_LYR = { open: false, key: "", idx: -1, rendered: false };

function sbLyrOpen() {
  const m = (typeof muState === "function" ? muState() : {}) || {};
  if (!m.title) return;
  const el = $("#sb-mlyr");
  if (!el || SB_LYR.open) return;
  SB_LYR.open = true; SB_LYR.key = ""; SB_LYR.idx = -1; SB_LYR.rendered = false;
  const t = $("#sb-mlyr-t");
  if (t) t.textContent = m.title;
  el.classList.remove("hidden");
  // 必须先把层显示出来再算滚动：隐藏时 clientHeight 是 0，居中会算成「贴顶」
  requestAnimationFrame(() => {
    el.classList.add("on");
    requestAnimationFrame(() => sbLyrPaint(true));
  });
}

function sbLyrClose(silent) {
  const el = $("#sb-mlyr");
  if (!el) return;
  SB_LYR.open = false;
  el.classList.remove("on");
  SB_LYR.idx = -1; SB_LYR.key = ""; SB_LYR.rendered = false;
  if (silent) el.classList.add("hidden");
  else setTimeout(() => { if (!SB_LYR.open) el.classList.add("hidden"); }, 180);
}

function sbLyrPaint(force) {
  if (!SB_LYR.open) return;
  const list = $("#sb-mlyr-list");
  if (!list) return;
  const m = (typeof muState === "function" ? muState() : {}) || {};
  const key = (typeof muKey === "function") ? muKey(m) : "";
  const ly = state.lyric;
  if (force || SB_LYR.key !== key || !SB_LYR.rendered) {
    SB_LYR.key = key;
    SB_LYR.rendered = false;
    if (!ly || ly.key !== key) {
      list.innerHTML = `<p class="sb-mlyr-empty">${m.title ? "歌词还没取到" : "还没在播"}</p>`;
      if (m.title && typeof muFetchLyric === "function") muFetchLyric(m);
      return;
    }
    if (!ly.entries || !ly.entries.length) {
      list.innerHTML = `<p class="sb-mlyr-empty">${esc(ly.msg || "这首没取到歌词")}</p>`;
      return;
    }
    SB_LYR.rendered = true;
    SB_LYR.first = true;
    // 每行两层：底下一层是没唱到的暗字，上面一层白字用 clip-path 从左往右揭开
    list.innerHTML = ly.entries.slice(0, 400).map((e) =>
      `<p data-t="${e.t}">`
      + `<span class="sb-mlyr-b">${esc(e.s)}</span>`
      + `<span class="sb-mlyr-f">${esc(e.s)}</span>`
      + `</p>`).join("");
    SB_LYR.idx = -1;
  }
  const entries = (ly && ly.entries) || [];
  if (!entries.length) return;
  const cur = Number(m.elapsed) || 0;
  let idx = -1;
  for (let i = 0; i < entries.length; i++) { if (entries[i].t <= cur + 0.15) idx = i; else break; }
  const ps = list.children;
  if (!ps.length) return;
  if (idx !== SB_LYR.idx) {
    SB_LYR.idx = idx;
    for (let i = 0; i < ps.length; i++) {
      ps[i].classList.toggle("on", i === idx);
      ps[i].classList.toggle("past", idx >= 0 && i < idx);
    }
    if (idx >= 0 && ps[idx]) {
      ps[idx].dataset.fresh = "1";
      const top = ps[idx].offsetTop - list.clientHeight / 2 + ps[idx].offsetHeight / 2;
      // 首屏直接落位，之后换句走缓动，跟 Apple Music 一样是「滑到位」而不是跳
      if (SB_LYR.first) { list.scrollTop = top; SB_LYR.first = false; }
      else { try { list.scrollTo({ top: Math.max(0, top), behavior: "smooth" }); } catch (e) { list.scrollTop = top; } }
    }
  }
  // 逐字覆盖：按这一句到下一句的时长，把白字从左edge推到右edge（每秒一拍，靠 CSS 补平）
  if (idx >= 0 && ps[idx]) {
    const t0 = entries[idx].t;
    const t1 = entries[idx + 1] ? entries[idx + 1].t : t0 + 3.2;
    // 目标取「下一秒」的进度：1Hz 刷新 + 0.96s 线性过渡，正好一秒走完一秒的量
    const p = Math.max(0, Math.min(1, (cur + 1 - t0) / Math.max(0.4, t1 - t0)));
    const f = ps[idx].querySelector(".sb-mlyr-f");
    if (f) {
      if (f.dataset.fresh === "1") {
        f.dataset.fresh = "0";
        f.style.transition = "none";
        f.style.clipPath = "inset(0 100% 0 0)";
        requestAnimationFrame(() => { f.style.transition = ""; });
      }
      const ins = (100 - p * 100).toFixed(2);
      if (f.dataset.p !== ins) { f.dataset.p = ins; f.style.clipPath = `inset(0 ${ins}% 0 0)`; }
    }
  }
}

/* ---------- 播放列表 / 搜索专辑 ----------
   自签包没有 MusicKit 能力，所以「搜到就点播」不能自己来。这里的做法是：
   搜索走 Apple 的公开目录接口（iTunes Search，就是 Apple Music 的库），
   点结果把 music.apple.com 的地址交给壳 UIApplication.open 打开系统「音乐」，
   播起来之后待机这页继续镜像它 —— 声音始终是 Apple Music 在放。 */
var SB_MUP = { open: false, tab: "list", rows: [], term: "", busy: false, lastK: "", artK: "" };
var SB_LIB = { playlists: [], songs: [], auth: "", at: 0, songsAt: 0 };
var SB_MUP = { open: false, tab: "list", rows: [], term: "", busy: false, lastK: "", artK: "",
               cur: null, curName: "", tracks: [], tracksLoading: false };

window.sbMusicTracks = function (d) {
  SB_MUP.tracks = (d && d.tracks) || [];
  if (d && d.name) SB_MUP.curName = d.name;
  SB_MUP.tracksLoading = false;
  if (SB_MUP.open && SB_MUP.cur) sbMuPanePaint();
};

/* 壳把「音乐」资料库读上来（MPMediaQuery，只能看到这台设备上已有的内容） */
window.sbMusicLib = function (d) {
  SB_LIB.playlists = (d && d.playlists) || [];
  SB_LIB.auth = (d && d.auth) || "";
  SB_LIB.at = Date.now();
  if (SB_MUP.open) sbMuPanePaint();
};
window.sbMusicSongs = function (d) {
  SB_LIB.songs = (d && d.songs) || [];
  SB_LIB.auth = (d && d.auth) || SB_LIB.auth;
  SB_LIB.songsAt = Date.now();
  if (SB_MUP.open) sbMuPanePaint();
};
function sbMuWant(tab) {
  if (typeof muSend !== "function") return;
  if (tab === "list" && sbMuWantLib()) muSend("lib");
  if (tab === "songs" && sbMuWantSongs()) muSend("songs");
}
function sbMuWantLib() { return !SB_LIB.at || Date.now() - SB_LIB.at > 90e3; }
function sbMuWantSongs() { return !SB_LIB.songsAt || Date.now() - SB_LIB.songsAt > 90e3; }

function sbOpenUrl(u) {
  if (!u) return;
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
    if (h) { h.postMessage({ cmd: "open", url: u }); return; }
  } catch (e) {}
  try { window.open(u, "_blank"); } catch (e) {}
}

function sbMuHistGet() {
  try { return JSON.parse(localStorage.getItem("sbMuHist") || "[]") || []; } catch (e) { return []; }
}
function sbMuHistSave(a) {
  try { localStorage.setItem("sbMuHist", JSON.stringify(a.slice(0, 30))); } catch (e) {}
}
function sbMuHistPush(m, art) {
  const key = (typeof muKey === "function") ? muKey(m) : "";
  if (!key || !m.title) return;
  const arr = sbMuHistGet();
  const i = arr.findIndex((x) => x.key === key);
  const old = i >= 0 ? arr.splice(i, 1)[0] : {};
  arr.unshift({ key: key, title: m.title, artist: m.artist || "", album: m.album || "",
                dur: Number(m.dur) || 0, art: art || old.art || "", at: Date.now() });
  sbMuHistSave(arr);
}
function sbMuHistArt(key, art) {
  if (!art) return;
  const arr = sbMuHistGet();
  const i = arr.findIndex((x) => x.key === key);
  if (i >= 0 && arr[i].art !== art) { arr[i].art = art; sbMuHistSave(arr); }
}

function sbMuPaneOpen(tab) {
  const el = $("#sb-mup");
  if (!el) return;
  SB_MUP.open = true;
  SB_MUP.tab = (tab === "search" || tab === "songs") ? tab : "list";
  SB_MUP.rows = [];
  SB_MUP.cur = null; SB_MUP.curName = ""; SB_MUP.tracks = []; SB_MUP.tracksLoading = false;
  el.classList.remove("hidden");
  sbMuWant(SB_MUP.tab);
  requestAnimationFrame(() => { el.classList.add("on"); sbMuPanePaint(); });
}

function sbMuPaneClose(silent) {
  const el = $("#sb-mup");
  if (!el) return;
  SB_MUP.open = false;
  el.classList.remove("on");
  const q = $("#sb-mup-qin");
  if (q) { try { q.blur(); } catch (e) {} }
  if (silent) el.classList.add("hidden");
  else setTimeout(() => { if (!SB_MUP.open) el.classList.add("hidden"); }, 180);
}

function sbMuRow(it, kind) {
  let name = "", sub = "", att = "";
  if (kind === "playlist") {
    name = it.name || "";
    sub = `${it.count || 0} 首` + (it.count ? "" : "");
    att = `data-pl="${esc(it.id)}"`;
  } else if (kind === "hist") {
    name = it.title || "";
    sub = [it.artist, it.album].filter(Boolean).join(" · ") || "最近在听";
    att = `data-hist="${esc(it.key)}"`;
  } else if (kind === "song") {
    name = it.title || "";
    sub = [it.artist, it.album].filter(Boolean).join(" · ") || "资料库";
    att = `data-song="${esc(it.id)}"`;
  } else if (kind === "track") {
    name = it.title || "";
    sub = [it.artist, it.album].filter(Boolean).join(" · ") || "资料库";
    att = `data-track="${esc(it.id)}"`;
  } else {
    name = it.name || "";
    sub = [it.artist, it.year].filter(Boolean).join(" · ") || "Apple Music";
    att = `data-url="${esc(it.url)}"`;
  }
  const art = it.art || "";
  const cls = art ? "sb-mup-art on" : "sb-mup-art";
  const bg = art ? ` style="background-image:url('${art}')"` : "";
  // 壳里没给封面（云端曲目常为 nil）就记下歌名/艺人/时长，由 sbMuArtFill 走 cover 接口补
  const artq = art ? "" : ` data-artq="${esc(sbArtKeyOf(it))}"`;
  return `<button type="button" class="sb-mup-row" ${att}${artq}>`
    + `<span class="${cls}"${bg}></span>`
    + `<span class="sb-mup-txt"><b>${esc(name)}</b><i>${esc(sub)}</i></span>`
    + `<span class="sb-mup-go">›</span></button>`;
}

/* ---------- 曲目封面补齐 ----------
   壳里的 playlistItems 只给歌名/艺人，云端曲目 artwork 常为 nil，于是这一级全是 ♪ 占位。
   这里复用播放页那支 cover 接口（title+artist+dur 查封面），按行懒加载、并发 3，
   命中就写进 localStorage 缓存，下次直接秒出；查不到就保持占位，不反复打接口。 */
const SB_ART_CK = "sbArtCacheV1";
const SB_ART_MAX = 240;

function sbArtKeyOf(it) {
  return [it.title || it.name || "", it.artist || "", Math.round(Number(it.dur) || 0)].join("|");
}
function sbArtCacheRead() {
  try { return JSON.parse(localStorage.getItem(SB_ART_CK) || "{}"); } catch (e) { return {}; }
}
function sbArtCacheWrite(k, url) {
  const c = sbArtCacheRead();
  c[k] = url;
  const ks = Object.keys(c);
  while (ks.length > SB_ART_MAX) delete c[ks.shift()];
  try { localStorage.setItem(SB_ART_CK, JSON.stringify(c)); } catch (e) {}
}
/* 44u 的格子最多 132px@3x：把服务端给的 500 大图换成 150 的小图，
   QQ 那套是 T002R500x500M… → T002R150x150M…，iTunes 是 …/100x100bb.jpg → 150x150bb.jpg */
function sbArtThumb(url) {
  return String(url)
    .replace(/R\d+x\d+M/, "R150x150M")
    .replace(/\/\d+x\d+bb\.jpg/, "/150x150bb.jpg");
}
function sbArtApply(row, url) {
  const box = row.querySelector(".sb-mup-art");
  if (!box) return;
  box.style.backgroundImage = `url("${sbArtThumb(url)}")`;
  box.style.backgroundSize = "cover";        // 行内只覆盖图片源，尺寸/位置显式补上，免得被 shorthand 重置
  box.style.backgroundPosition = "center";
  box.classList.add("on");
  row.removeAttribute("data-artq");
}
function sbMuArtFill() {
  const rows = [...document.querySelectorAll("#sb-mup-rows .sb-mup-row[data-artq]")];
  if (!rows.length) return;
  const cache = sbArtCacheRead();
  let idx = 0;
  const next = () => {
    if (idx >= rows.length) return;
    const row = rows[idx++];
    const key = row.getAttribute("data-artq") || "";
    if (!key) return;
    if (cache[key]) { sbArtApply(row, cache[key]); return next(); }
    const [title, artist, dur] = key.split("|");
    if (!title) { row.removeAttribute("data-artq"); return next(); }
    api(`cover?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&dur=${dur || 0}`,
        { noRetry: true }, 9000)
      .then((d) => {
        if (d && d.ok && d.url) { sbArtCacheWrite(key, d.url); sbArtApply(row, d.url); }
        else row.removeAttribute("data-artq");
      })
      .catch(() => row.removeAttribute("data-artq"))
      .then(() => setTimeout(next, 120));
  };
  for (let i = 0; i < 3; i++) setTimeout(next, i * 60);
}

function sbMuPanePaint() {
  const el = $("#sb-mup");
  if (!el) return;
  const t = $("#sb-mup-t");
  const inList = !!SB_MUP.cur;
  if (t) t.textContent = inList ? (SB_MUP.curName || "播放列表") : "音乐";
  const tabs = el.querySelector(".sb-mup-tabs");
  if (tabs) tabs.classList.toggle("hidden", inList);
  const back = $("#sb-mup-back");
  if (back) back.classList.toggle("hidden", !inList);
  el.querySelectorAll("[data-mutab]").forEach((b) => b.classList.toggle("on", b.dataset.mutab === SB_MUP.tab));
  const q = $("#sb-mup-q");
  if (q) q.classList.toggle("hidden", inList || SB_MUP.tab !== "search");
  const rows = $("#sb-mup-rows");
  if (!rows) return;

  if (inList) {
    if (SB_MUP.tracksLoading) { rows.innerHTML = `<p class="sb-mup-empty">正在读这个列表…</p>`; return; }
    if (!SB_MUP.tracks.length) { rows.innerHTML = `<p class="sb-mup-empty">这个列表里没有可播放的曲目。</p>`; return; }
    rows.innerHTML = SB_MUP.tracks.map((x) => sbMuRow(x, "track")).join("");
    return;
  }

  if (SB_MUP.tab === "list") {
    if (!SB_LIB.playlists.length) {
      const hist = sbMuHistGet();
      const note = SB_LIB.at
        ? "「音乐」资料库没读出播放列表。<br>这里只能看到已下载或已同步到这台设备的内容；纯云端的列表要在「音乐」App 里先下载一首。"
        : "正在读「音乐」资料库…";
      rows.innerHTML = `<p class="sb-mup-empty">${note}</p>`
        + (hist.length ? `<p class="sb-mup-sub">最近在听</p>` + hist.map((x) => sbMuRow(x, "hist")).join("") : "");
      return;
    }
    rows.innerHTML = SB_LIB.playlists.map((x) => sbMuRow(x, "playlist")).join("");
    return;
  }

  if (SB_MUP.tab === "songs") {
    if (!SB_LIB.songs.length) {
      rows.innerHTML = `<p class="sb-mup-empty">${SB_LIB.songsAt ? "资料库里没有歌（只统计已同步到这台设备的）。" : "正在读「音乐」资料库…"}</p>`;
      return;
    }
    rows.innerHTML = SB_LIB.songs.map((x) => sbMuRow(x, "song")).join("");
    return;
  }

  if (SB_MUP.busy) { rows.innerHTML = `<p class="sb-mup-empty">正在搜…</p>`; return; }
  if (!SB_MUP.term) { rows.innerHTML = `<p class="sb-mup-empty">输入专辑或歌手，从 Apple Music 目录里找。</p>`; return; }
  if (!SB_MUP.rows.length) { rows.innerHTML = `<p class="sb-mup-empty">没搜到「${esc(SB_MUP.term)}」。</p>`; return; }
  rows.innerHTML = SB_MUP.rows.map((x) => sbMuRow(x, "album")).join("");
}

function sbMuSearch(term) {
  term = (term || "").trim();
  SB_MUP.term = term;
  SB_MUP.rows = [];
  if (!term) { SB_MUP.busy = false; sbMuPanePaint(); return; }
  SB_MUP.busy = true;
  sbMuPanePaint();
  api(`music/search?term=${encodeURIComponent(term)}&kind=album&limit=24`, { noRetry: true }, 12000)
    .then((d) => {
      if (SB_MUP.term !== term) return;
      SB_MUP.busy = false;
      SB_MUP.rows = (d && d.items) || [];
      sbMuPanePaint();
    })
    .catch(() => {
      if (SB_MUP.term !== term) return;
      SB_MUP.busy = false;
      SB_MUP.rows = [];
      sbMuPanePaint();
    });
}

function sbMuPlayHist(key) {
  const it = sbMuHistGet().find((x) => x.key === key);
  if (!it) return;
  const term = [it.title, it.artist].filter(Boolean).join(" ");
  api(`music/search?term=${encodeURIComponent(term)}&kind=song&limit=8`, { noRetry: true }, 12000)
    .then((d) => {
      const hit = ((d && d.items) || []).find((x) => x.url);
      if (hit) { sbOpenUrl(hit.url); sbMuPaneClose(); }
      else if (typeof toast === "function") toast("Apple Music 里没找到这首");
    })
    .catch(() => { if (typeof toast === "function") toast("搜索失败"); });
}

function sbPaintAgenda() {
  const s = sbState();
  const box = $("#sb-agenda");
  if (!box) return;
  const n = sbNow();
  const tasks = ((s.work && s.work.tasks) || [])
    .filter((t) => String(t.due_at || "").slice(0, 10) === n.day);
  const open = tasks.filter((t) => !t.done).sort((a, b) => (a.due_at < b.due_at ? -1 : 1));
  if (!open.length) {
    box.innerHTML = `<div class="sb-ag-empty">今天没有安排</div>`;
    return;
  }
  box.innerHTML = open.slice(0, 2).map((t) => {
    const hm = String(t.due_at || "").slice(11, 16);
    return `<div class="sb-ag-row" data-sb-peek="work"><b>${hm}</b><span>${esc(t.title || "")}</span></div>`;
  }).join("") + `<div class="sb-ag-more" data-sb-peek="work">共 ${open.length} 项未完成</div>`;
}

function sbLeftText(ms) {
  const d = Math.max(0, ms);
  const h = Math.floor(d / 3600000);
  const m = Math.floor((d % 3600000) / 60000);
  const s = Math.floor((d % 60000) / 1000);
  // 超过一小时别再显示「76:28」这种分:秒，读起来像 76 分还是 76 秒说不清
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m}:${sbPad(s)}`;
}

function sbPaintFocus() {
  const s = sbState();
  const bar = $("#sb-focus");
  if (!bar) return;
  const run = s.work && s.work.focus && s.work.focus.run;
  if (!run || run.status !== "running" || typeof focusStepInfo !== "function") {
    bar.hidden = true;
    return;
  }
  let info = null;
  try { info = focusStepInfo(run); } catch (e) { info = null; }
  if (!info) { bar.hidden = true; return; }
  const left = sbLeftText(info.endMs - (typeof wkNowMs === "function" ? wkNowMs() : Date.now()));
  const title = (info.step && info.step.title) || "专注";
  // 快照里没有 anchor 的老场次 endMs 会是 NaN：只报步次和标题，不硬编一个「剩 NaN」
  const leftOk = isFinite(info.endMs);
  const txt = `第 ${info.idx + 1}/${info.total} 步 · ${title}${leftOk ? ` · 剩 ${left}` : ""}`;
  const el = $("#sb-focus-t");
  if (el && el.textContent !== txt) el.textContent = txt;
  bar.hidden = false;
}

/* 脚本加载即补上顶栏入口提示；DOM 还没到时等一拍 */
(function sbHintOnLoad() {
  const add = () => {
    const mid = $("#top-mid");
    if (!mid || mid.querySelector(".sb-hint")) return;
    const h = document.createElement("span");
    h.className = "sb-hint";
    h.innerHTML = `待机 <i>›</i>`;
    mid.appendChild(h);
    mid.addEventListener("click", sbMidTap);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})();
