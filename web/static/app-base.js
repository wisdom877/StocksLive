/* 壳在页面还没跑完时点通知进来：先把提醒 id 攒在数组里，app-work.js 起来后再补弹 */
if (typeof window.wkNativeAlarm !== "function") {
  window.wkNativeAlarm = (id) => { (window.__wkAlarmQ = window.__wkAlarmQ || []).push(String(id)); };
}
/* build: 2026-11-25 19:20 启动兜底 + 更多面板限高 */
const API = "api/v1";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ── 外观：跟随系统 / 浅色 / 深色 ─────────────────────────────
   以前主题完全挂在 prefers-color-scheme 上，WebView 不上报这个信号时就「切了没反应」。
   现在统一落到 html[data-theme]，系统外观只在「跟随系统」时提供初值。 */
const THEME_KEY = "appTheme";
function themeMode() { try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; } }
function themeIsDark(mode) {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  try { return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches); } catch (e) { return false; }
}
const THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };
/* 「跟随系统」能看到的只是容器上报的外观：App 内嵌运行时它由 App 自己的深色设置决定，
   手机系统切浅色不一定会传进来。所以把实际解析出来的深浅直接写在入口上，不再让人猜。 */
function themeLabelNow() {
  const m = themeMode();
  return m === "auto" ? `跟随系统 · 现在${themeIsDark("auto") ? "深色" : "浅色"}` : THEME_LABEL[m];
}
function applyTheme(mode) {
  const m = mode || themeMode();
  const dark = themeIsDark(m);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try { localStorage.setItem(THEME_KEY, m); } catch (e) { /* 隐私模式下写不进去，不影响当次 */ }
  document.querySelectorAll('meta[name="theme-color"]').forEach((n) => n.remove());
  const meta = document.createElement("meta");
  meta.name = "theme-color"; meta.content = dark ? "#000000" : "#f5f5f7";
  document.head.appendChild(meta);
  const sub = $("#more-theme-sub");
  if (sub) sub.textContent = themeLabelNow();
  return dark;
}
function openThemeSheet() {
  const cur = themeMode();
  const html = `<div class="seg" id="theme-seg">${Object.keys(THEME_LABEL).map((k) =>
    `<button type="button" data-theme-opt="${k}" class="${cur === k ? "on" : ""}">${THEME_LABEL[k]}</button>`).join("")}</div>
    <p class="tiny muted" style="margin:12px 2px 0;line-height:1.55">「跟随系统」跟的是容器上报的外观。在 App 里打开时它由 App 自己的深色设置决定，手机系统切浅色不一定传进来（现在它认到的是${themeIsDark("auto") ? "深色" : "浅色"}）。要定死就直接选浅色 / 深色。</p>`;
  openSheet("外观", html);
  $$("#theme-seg [data-theme-opt]").forEach((b) => (b.onclick = () => {
    applyTheme(b.dataset.themeOpt);
    $$("#theme-seg [data-theme-opt]").forEach((x) => x.classList.toggle("on", x === b));
    setTimeout(closeSheet, 160);
  }));
}

/* 玻璃质感：四档单选就放在「更多」里。样式全在 glass.css，这里只负责把 GLASS 的选择画出来（GLASS:BEGIN） */
function openGlassSheet() {
  if (!window.GLASS) return;
  openSheet("玻璃质感", GLASS.html());
  GLASS.bind(document);
}
/* GLASS:END */

/* 修改访问密码：先验原密码，再写新密码；成功后当前会话继续有效 */
function openPasswordSheet() {
  openSheet("修改密码", `<form id="pw-form" class="pw-form" autocomplete="off">
    <div class="field"><label>原密码</label><input id="pw-old" type="password" autocomplete="current-password" placeholder="先验证当前密码" required></div>
    <div class="field"><label>新密码</label><input id="pw-new" type="password" autocomplete="new-password" placeholder="至少 8 位" required></div>
    <div class="field"><label>确认新密码</label><input id="pw-confirm" type="password" autocomplete="new-password" placeholder="再输一次" required></div>
    <p class="pw-err" id="pw-err"></p>
    <p class="pw-note">改完不用重新登录，新密码下次登录时生效。</p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-close>取消</button><button type="submit" class="btn primary" id="pw-save">保存</button></div>
  </form>`);
  setTimeout(() => { try { $("#pw-old").focus(); } catch (e) {} }, 80);
  $("#pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const old = $("#pw-old").value;
    const next = $("#pw-new").value;
    const err = $("#pw-err");
    err.textContent = "";
    if (next.length < 8) { err.textContent = "新密码至少 8 位"; return; }
    if (next !== $("#pw-confirm").value) { err.textContent = "两次输入的新密码不一致"; return; }
    const btn = $("#pw-save");
    btn.disabled = true;
    btn.textContent = "验证中…";
    try {
      await api("password", { method: "POST", body: { old, new: next } });
      try { document.activeElement && document.activeElement.blur(); } catch (e) {}
      closeSheet();
      toast("密码已更新");
    } catch (ex) {
      err.textContent = ex.message || "修改失败";
      btn.disabled = false;
      btn.textContent = "保存";
    }
  });
}
/* 有些 WebView 不派发 prefers-color-scheme 的 change 事件，切了系统外观页面就一直停在旧色。
   这里在「跟随系统」时自己做兜底：回到前台时对齐一次，平时每 2 秒比一次，不一致才重算。 */
function themeRefreshAuto() {
  if (themeMode() !== "auto") return;
  const want = themeIsDark("auto") ? "dark" : "light";
  if (document.documentElement.getAttribute("data-theme") !== want) applyTheme("auto");
}
try {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener ? mq.addEventListener("change", themeRefreshAuto) : mq.addListener(themeRefreshAuto);
} catch (e) { /* 没有 matchMedia 就只用手选 */ }
document.addEventListener("visibilitychange", () => { if (!document.hidden) themeRefreshAuto(); });
/* 原来这里有个 2 秒 setInterval 空转查主题：matchMedia 的 change 回调 + 回前台已经够了，
   去掉它等于少一个 1Hz/2Hz 的唤醒源（手机上一直醒着就是热。 */
applyTheme(themeMode());

/* 新闻功能已按要求下线（2026-10-29）：页面容器在 index.html 里整段注释，
   这里用一个开关兜住所有渲染入口，代码一行没删。恢复：把下面改成 true，再取消 index.html 里那段注释。 */
const NEWS_ON = false;

const KIND_LABEL = { idea: "想法", note: "记录", news: "新闻", analysis: "分析", theme: "题材" };
const REPORT_KIND = { pre: "盘前", mid: "午间", post: "盘后" };
const CAT_CLASS = { 战事: "war", 油价: "oil", 政策: "policy", 行业: "industry", 市场: "" };

const state = {
  view: "hold",
  // 顶栏「日程 / 记录」是独立页：记住打开前在哪一页、滚到哪，再点同一图标关闭时回到那里
  pageBack: { feed: "", note: "" },
  pageScroll: { feed: 0, note: 0, hold: 0, watch: 0 },
  infoTab: "focus",
  feed: null,
  board: { stocks: [], tags: [], market: null },
  tagFilter: { hold: "", watch: "" },
  tagOrder: { hold: [], watch: [] },   // 标签条手动顺序（后端 meta 存，持仓/关注各一套）
  tagSorting: "",                      // 正在排序的 bucket；空 = 普通模式
  groupByTag: { hold: false, watch: false },
  notes: [],
  noteTags: [],
  noteKind: "note",
  noteTag: "",
  noteStock: "",
  pollTimer: null,
  rankBy: "pct", rankFilters: {},
  pollBusy: false,
  boardSig: "",
  liveShown: 10,
  focusShown: 15,
  tagShowAll: {},
  tagSort: "purity",
  tagDir: "asc",
  // 记住上次选的纯度模式（“已隐藏”不记住，避免重开页面只剩隐藏项）
  tagPurity: (() => {
    try {
      const v = localStorage.getItem("tagPurity");
      return v === "clean" || v === "core" ? v : "all";
    } catch { return "all"; }
  })(),
  tagShown: 100,
  tagData: null,
  tagResolved: "",
  holdTab: "mine",
  clockSkew: 0,
  serverSkew: 0,
  resumeAt: 0,
  tagItems: [],
  tagName: "",
  tagAll: [],
  tagChipAll: false,
  focusItems: [],
  focusDay: "",
  focusFrom: null,
  focusTo: null,
  focusRange: {},
  focusCat: "",
  focusByDay: {},
  focusDays: [],
  favorites: [],
  favCount: 0,
  favLoaded: false,
  liveTab: "live",
  liveDay: "",
  liveFrom: null,
  liveTo: null,
  liveDays: [],
  hot: null,
  hotTab: "today",
  mktTab: "quote",
  hotShowAll: false,
  hotTailAll: false,
  noteDay: "",
  noteFrom: null,
  noteTo: null,
  noteDays: [],
  noteToday: "",
  liveDigest: false,
  digests: [],
  digestTotal: 0,
  digestShown: 10,   // 实时新闻里的总结列表：默认显示 10 张，点「查看更多」每次再展开 10 张
  digestToday: "",   // 北京时间今天（后端 /digest 返回）
  digestDay: "",     // 总结面板当前查看的日期
  digestSlot: "",    // 总结面板当前查看的时段：am=早，pm=晚
  digestMarks: [],   // 总结上的标红 / 下划线 / 批注
  watchTab: "mine",
  repKey: "",
  focusKey: "",
  liveKey: "",
  liveFilter: "",
  liveLevel: "",
  liveSearch: "",
  liveSearchItems: [],
  // 展开阅读的新闻 id：自动刷新会重建列表，但展开状态要留着
  liveOpen: new Set(),
  eventsKey: "",
  klineTimer: null,
  heatSrc: "ths",
  trendSort: "streak",   // 连涨 / 成交额 / 累计 / 涨幅 / 规模
  trendDir: "desc",      // 当前排序方向：asc 正序 / desc 逆序
  trendDate: "",         // 当前查看日期；"" = 最新
  trendDates: [],
  trendData: null,
  etfOverlap: {},        // code -> 持仓重合结果（前十大估算）
  trendOverlapSeq: 0,
  // trendFilter: "",    // 板块标签筛选已下线（卡片内标签仅展示）
  liveFull: false,
  liveLimit: 60,
  liveTotal: 0,
  liveHasMore: false,
  liveStats: null,      // 服务端全量统计：{total, levels:{A,B,C}, cats:{...}}
  liveRange: false,     // 当前是否多天区间（liveDay 为空时别被 feed 重置成今天）
  trashDays: 7,
};

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function num(v, d = 2) {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function px(v) {
  if (!v) return "—";
  return num(v, v < 10 ? 3 : 2);
}
function capText(v) {
  if (v === null || v === undefined) return "—";
  return Number(v).toFixed(1) + "亿";
}
function metsParts(q) {
  const has = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));
  return [
    `流通 ${has(q.float_cap) ? capText(q.float_cap) : "—"}`,
    `换手 ${has(q.turnover_rate) ? Number(q.turnover_rate).toFixed(2) + "%" : "—"}`,
    `量比 ${has(q.vol_ratio) ? Number(q.vol_ratio).toFixed(2) : "—"}`,
    `PE ${has(q.pe) ? Number(q.pe).toFixed(1) : "—"}`,
  ];
}
const UNTAGGED = "__untagged__";

/* ---------- 前端错误留痕（只存本机，不上传） ----------
   写操作失败不再静默：api() 里非 GET 的失败会自动记一条，其余关键路径也可以直接调 logErr()。
   入口：更多 → 最近错误。 */
const ERR_LOG_KEY = "errlog";
const ERR_LOG_MAX = 20;
function errLogRead() {
  let a = [];
  try {
    a = JSON.parse(localStorage.getItem(ERR_LOG_KEY) || "[]");
  } catch { return []; }
  if (!Array.isArray(a)) return [];
  // 老版本留下的「同一个错误连刷两行」在读取时并成一条（带上次数），列表里不再重复
  const out = [];
  a.forEach((r) => {
    if (!r) return;
    const prev = out[out.length - 1];
    if (prev && prev.tag === r.tag && prev.msg === r.msg && Math.abs((prev.t || 0) - (r.t || 0)) < 5 * 60e3) {
      prev.n = (Number(prev.n) || 1) + (Number(r.n) || 1);
      prev.t = Math.max(prev.t || 0, r.t || 0);
    } else out.push({ ...r });
  });
  return out;
}
function logErr(tag, e) {
  const msg = e && e.message !== undefined ? String(e.message || e) : String(e || "");
  const row = { t: Date.now(), tag: String(tag || "?"), msg: (msg || "unknown").slice(0, 200), n: 1 };
  try { console.warn("[err]", row.tag, row.msg, e && e.stack ? e.stack : ""); } catch { /* 控制台没有也不影响留痕 */ }
  try {
    const a = errLogRead();
    // 同一条接口、同一句原因在 5 分钟内重复失败（重试 / 每秒重跑）就并成一条记次数，
    // 不要在列表里刷两行一模一样的「网络错误」，那看着像修不好的 bug
    const last = a[0];
    if (last && last.tag === row.tag && last.msg === row.msg && Date.now() - (last.t || 0) < 5 * 60e3) {
      last.t = row.t;
      last.n = (Number(last.n) || 1) + 1;
    } else {
      a.unshift(row);
    }
    localStorage.setItem(ERR_LOG_KEY, JSON.stringify(a.slice(0, ERR_LOG_MAX)));
  } catch { /* 隐私模式禁 localStorage 时不挡主流程 */ }
  return row;
}
window.addEventListener("error", (e) => logErr("onerror", e && (e.message || e.error)));
window.addEventListener("unhandledrejection", (e) => logErr("promise", e && e.reason));

/* 关注优先级：A 排最前，其次 B、C，未设置的排最后 */
const PRI_RANK = { A: 0, B: 1, C: 2 };
/* 界面上不出现 A/B/C，只用颜色和「高/中/低」提示区分 */
const PRI_NAME = { A: "高", B: "中", C: "低" };
function priName(p) { return PRI_NAME[p] || ""; }
function priRank(p) {
  return PRI_RANK[p] ?? 3;
}
function priChips(code, cur) {
  return ["A", "B", "C"].map((p) =>
    `<button type="button" class="chip pri-chip pri-${p} ${cur === p ? "on" : ""}" data-set-pri="${p}" data-pri-code="${code}" title="优先级 ${priName(p)}" aria-label="优先级 ${priName(p)}"><i class="pri-dot"></i><b class="pri-k">${p}</b></button>`).join("") +
    `<button type="button" class="chip ${cur ? "" : "on"}" data-set-pri="" data-pri-code="${code}">无</button>`;
}
function bindPriChips(root, code) {
  $$("[data-set-pri]", root).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.disabled) return;
      await setStockPriority(code, b.dataset.setPri);
    };
  });
}
async function setStockPriority(code, pri) {
  const s = (state.board.stocks || []).find((x) => x.code === code);
  if (!s) return;
  const next = PRI_RANK[pri] === undefined ? "" : pri;
  if ((s.priority || "") === next) return;
  try {
    await api(`stocks/${code}`, { method: "PATCH", body: { priority: next } });
    s.priority = next;
    const sq = $("#sq-pri");
    if (sq && document.contains(sq)) {
      sq.innerHTML = `<span class="pri-label">优先级</span>${priChips(code, next)}`;
      bindPriChips(sq, code);
    }
    renderBucket(s.bucket);
    toast(next ? `优先级已设为${priName(next)}` : "已取消优先级");
  } catch (e) {
    toast(e.message);
  }
}
function customTagsOf(s) {
  return Array.isArray(s && s.custom_tags) ? s.custom_tags : [];
}
function tagLabel(t) {
  return t === UNTAGGED ? "未分类" : t;
}
function externalTagsHtml(tags, clickable = true) {
  const list = (tags || []).filter(Boolean).slice(0, 4);
  if (!list.length) return '<span class="muted tiny">暂无外网标签</span>';
  return list.map((t) => clickable
    ? `<button type="button" class="tag tag-btn" data-api-tag="${esc(t)}">${esc(t)}</button>`
    : `<span class="tag">${esc(t)}</span>`).join("");
}
function appendTag(input, tag) {
  if (!input || !tag) return;
  const vals = input.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  if (!vals.includes(tag)) vals.push(tag);
  input.value = vals.join(",");
}
function bindApiTagChips(box, input) {
  if (!box) return;
  $$("[data-api-tag]", box).forEach((b) => {
    b.onclick = () => {
      appendTag(input, b.dataset.apiTag);
      toast(`已填入「${b.dataset.apiTag}」`);
    };
  });
}

function pctText(v) {
  if (v === null || v === undefined) return "—";
  return (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%";
}
function cls(v) {
  if (v === null || v === undefined || Math.abs(v) < 1e-9) return "flat";
  return v > 0 ? "up" : "down";
}
/* 代码右边标市场：沪 / 深 / 创（北交所兜底标北） */
function marketTag(code) {
  const c = String(code || "");
  if (!/^\d{6}$/.test(c)) return "";
  if (/^(4|8|92)/.test(c)) return "北";
  if (/^(688|689|60[0135]|5[01]|56|58|9)/.test(c)) return "沪";
  if (/^(300|301)/.test(c)) return "创";
  if (/^(000|001|002|003|15|16|18|12|13)/.test(c)) return "深";
  return "";
}
function mktBadge(code) {
  const m = marketTag(code);
  if (!m) return "";
  const k = m === "沪" ? "sh" : m === "深" ? "sz" : m === "创" ? "cy" : "bj";
  return `<span class="mkt-badge mk-${k}">${m}</span>`;
}
/* 原生 confirm() 在 App 内置浏览器里常被静默拦掉——点删除看着像没反应，
   而且外层如果是 async 又没 catch，接口报错也会一起被吞。
   涉及删数据的确认统一走这里：第一次点只把按钮变成确认态，4 秒内再点一次才真正执行。 */
function armAsk(btn, text, ms = 4000) {
  if (!btn) return true;                       // 没有可锚定的按钮就不拦
  if (btn.dataset.armed === "1") {
    clearTimeout(btn._armT);
    delete btn.dataset.armed;
    btn.classList.remove("armed");
    if (btn._armHtml != null) { btn.innerHTML = btn._armHtml; btn._armHtml = null; }
    return true;
  }
  btn._armHtml = btn.innerHTML;
  btn.dataset.armed = "1";
  btn.classList.add("armed");
  btn.textContent = text;
  clearTimeout(btn._armT);
  btn._armT = setTimeout(() => {
    delete btn.dataset.armed;
    btn.classList.remove("armed");
    if (btn._armHtml != null) { btn.innerHTML = btn._armHtml; btn._armHtml = null; }
  }, ms);
  return false;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 1800);
}

/* ---------- 读接口短缓存（隧道一次往返 1~3s，来回切页不该反复拉） ---------- */
// 写操作（非 GET）成功后整表清空，页面上任何增删改都会自动失效，不用手工 sync。
const _memo = new Map();
// GET 的 ETag 缓存：手动带 If-None-Match，命中 304 直接用上次解析好的数据（省隧道流量）
const _httpCache = new Map();
function memoFresh(key, ttl) {
  const e = _memo.get(key);
  return e && Date.now() - e.ts < ttl ? e.data : null;
}
function memoSet(key, data) {
  _memo.set(key, { ts: Date.now(), data });
}
// 盘中勤一点，收盘后没必要反复拉
function liveTtl(base) {
  return marketOpen() ? base : base * 8;
}
const _inflightGet = new Map();

async function api(path, opts = {}, timeout = 15000) {
  const method0 = (opts.method || "GET").toUpperCase();
  if (method0 !== "GET") return _apiOnce(path, opts, timeout);
  // 同一路径正在飞就复用同一个 promise：切 tab / 滚动 / 回前台同时触发时不会各发一条
  const infl = _inflightGet.get(path);
  if (infl) return infl;
  const pr = _apiOnce(path, opts, timeout);
  _inflightGet.set(path, pr);
  pr.then(() => { if (_inflightGet.get(path) === pr) _inflightGet.delete(path); },
         () => { if (_inflightGet.get(path) === pr) _inflightGet.delete(path); });
  return pr;
}

async function _apiOnce(path, opts = {}, timeout = 15000) {
  const method = (opts.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const idem = isGet || !!opts.idempotent;
  // 写操作多重试一次：后端重启（部署/重启服务）通常 2~4 秒，退避两次刚好等它起来
  const tries = idem && !opts.noRetry ? (isGet ? 2 : 3) : 1;
  const { headers: optHeaders, body: optBody, noRetry, idempotent, ...rest } = opts;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), timeout);
    const cached = isGet ? _httpCache.get(path) : null;
    let r;
    try {
      r = await fetch(`${API}/${path}`, {
        credentials: "same-origin",
        cache: "no-store",
        ...rest,
        headers: {
          "Content-Type": "application/json",
          ...(cached ? { "If-None-Match": cached.etag } : {}),
          ...(optHeaders || {}),
        },
        signal: ctl.signal,
        body: optBody ? JSON.stringify(optBody) : undefined,
      });
    } catch (e) {
      clearTimeout(tid);
      lastErr = new Error(e.name === "AbortError" ? "网络超时，请重试" : "网络错误");
      if (i + 1 < tries) { await new Promise((ok) => setTimeout(ok, i === 0 ? 800 : 2400)); continue; }
      if (!isGet) logErr(`write:${path}`, lastErr);
      throw lastErr;
    }
    clearTimeout(tid);
    if (r.status === 401) {
      showLogin();
      throw new Error("未登录");
    }
    if (r.status === 304) {
      if (cached) return cached.data;
      throw new Error("缓存状态异常，请刷新重试");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || data.detail || `请求失败（${r.status}）`);
      if (!isGet) logErr(`write:${path}`, err);
      throw err;
    }
    if (isGet) {
      const et = r.headers && r.headers.get ? r.headers.get("ETag") : null;
      if (et) _httpCache.set(path, { etag: et, data });
    } else {
      _memo.clear(); // 写成功后所有读缓存失效
      _httpCache.clear();
      // 广播出去：工作台/待机/班表都监听，改完一处立刻重拉一份，不用等重启
      try { window.dispatchEvent(new CustomEvent("api:write", { detail: { path } })); } catch (e) {}
    }
    return data;
  }
  throw lastErr;
}

/* ---------- auth ---------- */
var __splashAt = performance.now();
function hideSplash() {
  const sp = $("#splash"); if (!sp) return;
  // 让手写 Wisdom 至少完整写完一遍，再淡出；不能一登录成功就把启动层瞬删。
  const left = Math.max(0, 1500 - (performance.now() - __splashAt));
  setTimeout(() => {
    sp.classList.add("out");
    setTimeout(() => { if (sp.parentNode) sp.remove(); }, 480);
  }, left);
}
function showLogin() {
  if (window.__bootGuard) { clearTimeout(window.__bootGuard); try { sessionStorage.removeItem("bootReload"); } catch (e) {} }
  hideSplash();
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  stopPoll();
}
function showApp() {
  if (window.__bootGuard) { clearTimeout(window.__bootGuard); try { sessionStorage.removeItem("bootReload"); } catch (e) {} }
  hideSplash();
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (typeof sbAutoRestore === "function") sbAutoRestore();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-err").textContent = "";
  try {
    await api("login", { method: "POST", body: { password: $("#pw").value } });
    $("#pw").value = "";
    await boot();
  } catch (err) {
    $("#login-err").textContent = err.message;
  }
});
$("#logout").addEventListener("click", async () => {
  await api("logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ---------- 回收站 ---------- */
const TRASH_ORDER = [["stock", "个股"], ["note", "记录"], ["news", "新闻"], ["report", "日报"], ["group", "分组"]];

$("#trash").addEventListener("click", () => openTrash().catch((e) => toast(e.message)));

async function openTrash() {
  const d = await api("trash").catch(() => ({ items: [] }));
  renderTrash(d.items || [], d.days || state.trashDays || 7);
}

function renderTrash(items, days = state.trashDays || 7) {
  const head = `<div class="tiny muted" style="margin-bottom:10px">删掉的都会留在这里；笔记不会自动清理，其他 ${days} 天后自动清空</div>`;
  if (!items.length) {
    openSheet("回收站", head + `<div class="empty">回收站是空的</div>`);
    return;
  }
  const secs = [];
  TRASH_ORDER.forEach(([k, label]) => {
    const arr = items.filter((x) => x.kind === k);
    if (arr.length) secs.push([label, arr]);
  });
  const rest = items.filter((x) => !TRASH_ORDER.some(([k]) => k === x.kind));
  if (rest.length) secs.push(["其他", rest]);
  const body = secs.map(([label, arr]) => `
    <div class="trash-sec">${label}<span class="tiny">${arr.length}</span></div>
    ${arr.map((x) => `<div class="trash-row" data-tid="${x.id}">
      <div class="l"><div class="nm">${esc(x.title || "（空）")}</div>
        <div class="cd">${esc(bjTime(x.deleted_at))}</div></div>
      <div class="acts"><button class="tbtn" data-restore="${x.id}">恢复</button>
        <button class="tbtn drop" data-purge="${x.id}">删掉</button></div>
    </div>`).join("")}`).join("");
  openSheet(`回收站 · ${items.length} 项`, head + body +
    `<button class="btn ghost small" id="trash-clear" style="margin-top:10px;width:100%">清空回收站</button>`);

  $$("#sheet [data-restore]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api(`trash/${b.dataset.restore}/restore`, { method: "POST", idempotent: true });
        toast(`已恢复：${r.title || ""}`);
        await refreshAfterRestore(r.kind);
        await openTrash();
      } catch (e) { toast(e.message); b.disabled = false; }
    };
  });
  $$("#sheet [data-purge]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api(`trash/${b.dataset.purge}`, { method: "DELETE", idempotent: true });
        await openTrash();
      } catch (e) { toast(e.message); b.disabled = false; }
    };
  });
  const clr = $("#trash-clear");
  if (clr) clr.onclick = async () => {
    if (!armAsk(clr, `再点一次确认清空 ${items.length} 项`)) return;
    clr.disabled = true;
    try {
      const r = await api("trash", { method: "DELETE", idempotent: true });
      toast(`已清空 ${r.removed ?? items.length} 项`);
      await openTrash();
    } catch (e) {
      toast(e.message);
      clr.disabled = false;
    }
  };
}

function bjTime(s) {
  if (!s) return "";
  const t = new Date(s.replace(" ", "T") + "Z");
  if (isNaN(t.getTime())) return s.slice(5, 16);
  return new Date(t.getTime() + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
}

async function refreshAfterRestore(kind) {
  if (kind === "stock") await loadBoard(true).catch(() => {});
  else if (kind === "note") { await loadNotes().catch(() => {}); await loadBoard(true).catch(() => {}); }
  else if (kind === "news" || kind === "report") { await loadFeed(true).catch(() => {}); }
}

/* ---------- nav ---------- */
function activateView(v) {
  // 待机全屏层盖着时，任何视图切换先把它收掉，避免「已经切页但还黑屏」的状态打架
  if (typeof sbIsOn === "function" && sbIsOn()) sbClose(true);
  if (typeof closeSheet === "function") closeSheet();
  if (state.sel && state.sel.key && state.view !== v) exitSel();
  state.view = v;
  $$(".view").forEach((el) => el.classList.add("hidden"));
  const vv = $("#view-" + v);
  if (vv) vv.classList.remove("hidden");
  $$(".tabbar button").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (typeof updateTabThumb === "function") updateTabThumb(true);
  // 顶栏中间那根长条：工作页和行情页都显示（行情页第一行在 117pt 以下，静止时不压字，
  // 滚动时玻璃自带 blur，透出来的是虚化层，不会糊成一片可读的字）
  document.body.classList.toggle("top-mid-on", v === "work" || v === "hold");
  paintTopPageButtons();
  if (typeof refreshStickyTops === "function") requestAnimationFrame(refreshStickyTops);
}
/* 日程 / 记录图标：打开时高亮，并提示「再点关闭」 */
function paintTopPageButtons() {
  // 新闻面板是压在页面上的全屏层：它打开时，日程/记录图标不算当前页签
  const dg = $("#digest");
  const dgOpen = !!(dg && !dg.classList.contains("hidden"));
  const cal = $("#btn-cal");
  if (cal) {
    const on = !dgOpen && state.view === "feed" && state.infoTab === "focus";
    cal.classList.toggle("on", on);
    cal.title = on ? "关闭日程" : "日程";
    cal.setAttribute("aria-label", cal.title);
  }
  const notesBtn = $("#btn-notes");
  if (notesBtn) {
    const on = !dgOpen && state.view === "note";
    notesBtn.classList.toggle("on", on);
    notesBtn.title = on ? "关闭记录" : "记录";
    notesBtn.setAttribute("aria-label", notesBtn.title);
  }
}
/* 顶栏「日程 / 记录」：从哪一页打开就记住哪一页（连同滚动位置），
   再点同一图标＝关闭并回到那一页。新闻面板打开时也要把「新闻页」本身记进去，
   关闭后回到新闻页，而不是掉到它背后的行情/自选页。 */
/* 自动记录是后台写的（异动能监控），停在记录/分析/批注页时每 3 分钟看一次有没有新条目 */
let autoNoteTimer = null;
function watchAutoNotes() {
  if (autoNoteTimer) return;
  autoNoteTimer = setInterval(async () => {
    if (state.view !== "note" || document.hidden) return;
    const ae = document.activeElement;
    if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
    const sh = $("#sheet");
    if (sh && !sh.classList.contains("hidden")) return;
    try {
      const d = await api("notes", { noRetry: true }, 10000);
      const items = (d && (d.items || d.notes)) || [];
      const newest = items.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
      const cur = (state.notes || []).reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
      if (newest > cur) { await loadNotes(); toast("已同步新的自动记录"); }
    } catch (e) { /* 静默失败 */ }
  }, 180000);
}

function openTopPage(v) {
  const dg = $("#digest");
  const dgOpen = !!(dg && !dg.classList.contains("hidden"));
  if (v === "note") watchAutoNotes();
  if (state.view === v) {
    // 新闻面板压在同一页上时，先收起面板露出这一页，别把整页关掉
    if (dgOpen) closeDigestPanel();
    else closeTopPage(v);
    return false;
  }
  if (dgOpen) {
    const body = $("#dg-body");
    state.pageBack[v] = {
      digest: true,
      view: state.view,
      scrollY: window.scrollY || 0,
      bodyScroll: body ? body.scrollTop || 0 : 0,
    };
  } else {
    state.pageBack[v] = state.view;
  }
  state.pageScroll[state.view] = window.scrollY || 0;
  setView(v);
  window.scrollTo(0, 0);
  return true;
}
function closeTopPage(v) {
  const back = state.pageBack[v];
  state.pageBack[v] = "";
  if (back && typeof back === "object" && back.digest) {
    restoreDigest(back);
    return;
  }
  const target = back && back !== v ? back : "hold";
  const y = state.pageScroll[target] || 0;
  setView(target);
  // 列表是异步重建的，先立刻回位，再在渲染后补一次（期间切走就别再拉滚动）
  requestAnimationFrame(() => { if (state.view === target) window.scrollTo(0, y); });
  setTimeout(() => { if (state.view === target) window.scrollTo(0, y); }, 260);
}
/* 从日程/记录页关闭后，把原来压着的新闻面板原样放回来：
   不再重新拉数据，保留当时打开的日期、时段、总结/未读页签和滚动位置。 */
function restoreDigest(s) {
  const target = s.view || "hold";
  activateView(target);
  const box = $("#digest");
  if (!box) return;
  box.classList.remove("hidden");
  document.body.classList.add("dg-open");
  lockPageScroll(true, "digest");
  syncDigestTop();
  paintDigestNav(true);
  startInboxPoll();
  const body = $("#dg-body");
  const y = Number(s.bodyScroll) || 0;
  if (body) {
    body.scrollTop = y;
    requestAnimationFrame(() => { if (body.isConnected && state.view === target) body.scrollTop = y; });
  }
  window.scrollTo(0, Number(s.scrollY) || 0);
  schedulePoll();
}
function isWatchPane() { return state.view === "hold" && state.holdTab === "watch"; }
function setView(v) {
  if (v === "watch") { activateView("hold"); setHoldTab("watch"); return; }
  // 切页时退出标签排序模式（顺序在松手时已存，这里只负责关掉抖动）
  closeDigestPanel();
  if (state.tagSorting) exitTagSort(state.tagSorting, "", true);
  // 从全局搜索点进来也算一次跳转，先关搜索层
  closeGlobalSearch({ keepInput: true });
  activateView(v);
  if (v === "feed") loadFeed().catch(() => {});
  if (v === "hold") {
    if (state.holdTab === "market") { if (state.mktTab === "hot") loadHot().catch(() => {}); else loadMarket(); }
    else if (state.holdTab === "watch") (state.watchTab === "trend" ? loadTrend(false, state.trendDate) : loadBoard().catch(() => {}));
    else loadBoard().catch(() => {});
  }
  if (v === "work") { renderWork(); loadWork().catch(() => {}); }
  if (v === "note") {
    if (window.__jitterStart) window.__jitterStart();
    // 先用手上已有的数据把这一页画满（seg/标签条/记录卡），再去拉网络。
    // 否则进去时用于切换「记录/分析/批注」的分段控件是 0 高度，数据到位后整块往下跳 30 多像素。
    renderNoteDays();
    renderNoteFilters();
    renderNotes();
    loadNotes().catch(() => setTimeout(() => loadNotes().catch(() => {}), 1200));
  }
  schedulePoll();
}
/* 点已选中的选项卡 = 刷新这一块（页面上所有 ↻ 按钮已删除） */
async function refreshPane(scope) {
  try {
    if (scope === "news") return await pullLiveNews();
    if (scope === "focus") { _memo.delete("feed"); await loadFeed(); toast("已刷新"); return; }
    if (scope === "hold") { _memo.delete("board"); await loadBoard(); toast("已刷新"); return; }
    if (scope === "market") { await loadMarket(true, true); toast("已刷新"); return; }
    if (scope === "analysis") { await loadAnalysis(true); toast("已刷新"); return; }
    if (scope === "hot") { await loadHot(true, true); toast("已刷新为实时数据"); return; }
    if (scope === "watch") { _memo.delete("board"); await loadBoard(); toast("已刷新"); return; }
    if (scope === "trend") { await loadTrend(true, state.trendDate); toast("已刷新"); return; }
    // if (scope === "heat") { await loadHeat(state.heatSrc, true); toast("已刷新"); return; }   // 热度榜已下线
    if (scope === "tag") {
      const box = $("#tag-chips");
      if (box) delete box.dataset.ready;
      await loadTagPick();
      const cur = $("#tag-chips .chip.on");
      if (cur && cur.dataset.tag) await loadTagMembers(cur.dataset.tag);
      toast("已刷新");
      return;
    }
    if (scope === "note") { _memo.delete("notes"); await loadNotes(); toast("已刷新"); return; }
  } catch (e) { toast(`刷新失败：${e.message}`); }
}

/* ---------- 底部导航：按 Apple HIG 做成直接操控 ----------
   1. 按下不打乱布局，拖动时滑块 1:1 跟手，不做夸张拉伸；
   2. 到两端有轻微阻尼，松手用 Apple 风格的 ease-out 弹簧归位；
   3. 跨过页签中心时给一次轻触反馈，快速甩动按速度投影到目标；
   4. 点按仍然只触发一次，拖动结束不会再补一次 click。 */
let _tabSuppressClick = false;
function initTabDrag() {
  const nav = document.querySelector(".tabbar");
  if (!nav) return;
  const thumb = document.createElement("div");
  thumb.className = "tab-thumb";
  nav.appendChild(thumb);
  const btns = () => [...nav.querySelectorAll("button")];
  const reduceMotion = () =>
    !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let drag = null, moved = false;

  function measure() {
    const nr = nav.getBoundingClientRect();
    const list = btns();
    const rects = list.map((b) => {
      const r = b.getBoundingClientRect();
      return { l: r.left - nr.left, w: r.width, c: r.left - nr.left + r.width / 2 };
    });
    return { nr, list, rects };
  }
  function activeIdx() {
    const i = btns().findIndex((b) => b.classList.contains("on"));
    return i < 0 ? 0 : i;
  }
  function nearestIdx(x, m) {
    let best = 0, dist = Infinity;
    m.rects.forEach((r, i) => {
      const d = Math.abs(r.c - x);
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  }
  function setThumb(left, animate) {
    thumb.classList.toggle("anim", !!animate && !reduceMotion());
    thumb.style.left = `${left}px`;
  }
  window.updateTabThumb = function (animate) {
    const m = measure();
    const i = activeIdx();
    const r = m.rects[i];
    if (!r) return;
    thumb.style.width = `${r.w}px`;
    setThumb(r.l, animate);
    btns().forEach((b, j) => b.classList.toggle("near", j === i));
  };
  const lift = (on) => thumb.classList.toggle("lift", on);

  nav.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const m = measure();
    const idx = nearestIdx(e.clientX - m.nr.left, m);
    const r = m.rects[idx];
    if (!r) return;
    thumb.style.width = `${r.w}px`;
    setThumb(r.l, false);                 // 按下即对齐到最近页签，不做迟滞
    drag = {
      id: e.pointerId, sx: e.clientX, sy: e.clientY,
      grab: e.clientX - m.nr.left - r.c, m, w: r.w, idx,
      vx: 0, lastX: e.clientX, lastT: performance.now(), cx: r.c,
    };
    moved = false;
    btns().forEach((b, i) => b.classList.toggle("near", i === idx));
    try { nav.setPointerCapture(e.pointerId); } catch (err) {}
    nav.classList.add("dragging");
  });

  nav.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!moved) {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.hypot(dx, dy) < 6) return;
      moved = true;
      lift(true);
      thumb.classList.remove("anim");
    }
    const m = drag.m;
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastT);
    const inst = (e.clientX - drag.lastX) / dt;
    drag.vx = drag.vx * 0.72 + inst * 0.28;
    drag.lastX = e.clientX;
    drag.lastT = now;

    // 端点阻尼：越界只给一点回弹余量，手感接近 UIScrollView 的 rubber band
    let cx = e.clientX - m.nr.left - drag.grab;
    const min = m.rects[0].c, max = m.rects[m.rects.length - 1].c;
    if (cx < min) cx = min - Math.min(8, (min - cx) * 0.38);
    else if (cx > max) cx = max + Math.min(8, (cx - max) * 0.38);
    drag.cx = cx;
    const left = Math.max(0, Math.min(m.nr.width - drag.w, cx - drag.w / 2));
    setThumb(left, false);

    const idx = nearestIdx(cx, m);
    if (idx !== drag.idx) {
      drag.idx = idx;
      btns().forEach((b, i) => b.classList.toggle("near", i === idx));
    }
  });

  function end(e, allowSelect) {
    if (!drag || e.pointerId !== drag.id) return;
    const wasMoved = moved, m = drag.m;
    const before = activeIdx();
    let idx = drag.idx;
    if (wasMoved && allowSelect) {
      // 快速甩动时按速度往前投影 120ms；慢拖则落在最近的中心
      const projected = drag.cx + drag.vx * 120;
      idx = nearestIdx(projected, m);
    }
    drag = null;
    moved = false;
    nav.classList.remove("dragging");
    lift(false);
    btns().forEach((b) => b.classList.remove("near"));
    thumb.style.width = `${m.rects[idx].w}px`;
    setThumb(m.rects[idx].l, true);

    if (!wasMoved && allowSelect) {
      // 点按：不依赖浏览器补发 click（setPointerCapture 后 click 可能落到 nav 上），
      // 直接按松手位置派一次，再拦掉系统补发的那次，保证一次点按只切一次。
      _tabSuppressClick = true;
      setTimeout(() => { _tabSuppressClick = false; }, 400);
      const b = m.list[idx];
      if (b) b.click();
      setTimeout(() => window.updateTabThumb(true), 60);
    } else if (wasMoved && allowSelect && idx !== before) {
      // 指头抬起落到哪一格就切哪一格；这次不要再多派发一次 click
      _tabSuppressClick = true;
      setTimeout(() => { _tabSuppressClick = false; }, 400);
      const b = m.list[idx];
      if (b) b.click();
      setTimeout(() => window.updateTabThumb(true), 60);
    } else {
      window.updateTabThumb(true);
    }
  }
  nav.addEventListener("pointerup", (e) => end(e, true));
  nav.addEventListener("pointercancel", (e) => end(e, false));
  nav.addEventListener("click", (e) => {
    // 只拦手指抬起后系统补发的那次 click（detail>=1）；我们主动派的 click 是 detail 0，要放行
    if (_tabSuppressClick && e.detail !== 0) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  window.updateTabThumb(false);
  window.addEventListener("resize", () => window.updateTabThumb(false));
  window.addEventListener("orientationchange", () => setTimeout(() => window.updateTabThumb(false), 120));
}
initTabDrag();

$$(".tabbar button").forEach((b) => {
  if (b.id === "tab-news") return;   // 新闻按钮打开面板，不是切换页面
  b.addEventListener("click", () => {
  const same = state.view === b.dataset.view;
  setView(b.dataset.view);
  if (same) {
    if (state.view === "hold") {
      if (state.holdTab === "market") return refreshPane(state.mktTab === "analysis" ? "analysis" : state.mktTab === "hot" ? "hot" : "market");
      if (state.holdTab === "watch") return refreshPane(state.watchTab === "trend" ? "trend" : state.watchTab === "tag" ? "tag" : "watch");
      return refreshPane("hold");
    }
    if (state.view === "note") return refreshPane("note");
    return refreshPane(state.infoTab === "focus" ? "focus" : "news");
  }
  });
});

/* 入口互换：底部「新闻」打开 / 再点收起总结面板，顶栏「记录」直达记录页 */
$("#tab-news").addEventListener("click", () => {
  const box = $("#digest");
  if (box && !box.classList.contains("hidden")) closeDigestPanel();
  else openDigestPanel();
});
/* 记录：再点一次顶栏 ✎ 关闭，回到打开前的页面 */
$("#btn-notes").addEventListener("click", () => openTopPage("note"));

/* ---------- market + poll ---------- */
function renderMarketPill(m) {
  // 顶栏不再显示开盘状态（换成了全局搜索图标），只把数据留在 state 里给轮询/时点判断用
  if (m) state.board.market = m;
}
function marketOpen() {
  const s = state.board.market && state.board.market.state;
  return s === "open" || s === "pre";
}
/* 开盘/集合竞价/午休都优先看分时；收盘后默认日 K */
function marketActive() {
  const s = state.board.market && state.board.market.state;
  return s === "open" || s === "pre" || s === "lunch";
}
// 用户正在滑动/触摸时，暂停定时重绘：避免 3s 轮询与滚动抢主线程造成掉帧
let _busyTs = 0;
["touchstart", "touchmove", "wheel", "scroll"].forEach((ev) =>
  addEventListener(ev, () => { _busyTs = Date.now(); }, { passive: true, capture: true }));
const userBusy = () => Date.now() - _busyTs < 350;
function marketState() {
  return (state.board.market && state.board.market.state) || "closed";
}
/* 行情列表（持仓/自选/市场总览）；热度榜、标签选股走第三方接口不算 */
function isQuoteView() {
  if (state.view === "hold") {
    if (state.holdTab === "watch") return !["heat", "trend"].includes(state.watchTab);
    return !(state.holdTab === "market" && state.mktTab === "hot");
  }
  return false;
}
/* 下一次「恢复交易」的时刻（北京时间）：收盘→下一个工作日 9:15，午休→13:00。
   集合竞价 9:15 才开始，不能像旧逻辑那样在 9:14 醒来后又把下一次算到明天。 */
function nextResumeAt() {
  // 还没拿到 board 时 clockSkew=0；Date.now() 是 UTC，默认按北京时间 +8h 算，
  // 否则首次请求失败后可能把下一次开盘算错 8 小时。
  const skew = state.clockSkew || 8 * 3600e3;
  const bj = Date.now() + skew;
  const dayMs = 86400e3;
  const now = new Date(bj);
  const todayStart = bj - ((now.getUTCHours() * 60 + now.getUTCMinutes()) * 60000
    + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
  let at;
  if (marketState() === "lunch") {
    at = todayStart + 13 * 3600e3;
  } else {
    at = todayStart + 9 * 3600e3 + 15 * 60000;
    if (bj >= at) at += dayMs;
    while ([0, 6].includes(new Date(at).getUTCDay())) at += dayMs;  // 跳过周末
  }
  return at - skew;  // 换回本机时钟
}

function pollDelay() {
  if (!isQuoteView()) return 60000;
  // 5 秒一拍：3 秒让基带一直醒着，行情半天也不见得变一次；SSE/详情页另有 3 秒推送兜住细看
  if (marketOpen()) return 5000;
  if (!state.resumeAt) state.resumeAt = nextResumeAt();
  const until = state.resumeAt - Date.now();
  // 距开盘/午休恢复不到 1 分钟：精确睡到边界；已经过点则 15s 后复查，
  // 既不把下一次错误地算到明天，也不在时钟抖动时每秒打上游。
  if (until <= 0) return 15000;
  if (until < 60000) return Math.max(2000, until);
  return Math.min(until, 30 * 60000);
}

function schedulePoll(wait) {
  stopPoll();
  if (!["feed", "hold", "watch"].includes(state.view)) return;
  state.pollTimer = setTimeout(runPoll, wait == null ? pollDelay() : wait);
}

/* 当前 tab 实际对应的刷新函数；轮询、切回前台、关弹层共用，避免刷新错的数据 */
async function refreshVisible(silent) {
  if (state.view === "feed") return loadFeed(silent);
  if (state.view === "hold" && state.holdTab === "market" && state.mktTab === "hot") return loadHot();
  if (state.view === "hold" && state.holdTab === "market") return loadMarket(false, false, !!silent);
  if (isWatchPane() && state.watchTab === "trend") return;   // 趋势结果一天只变一次，轮询不重复拉
  return loadBoard(silent);
}

async function runPoll() {
  if (!["feed", "hold", "watch"].includes(state.view)) return;
  if (document.hidden) return schedulePoll();
  const quotes = isQuoteView();
  if (quotes && !marketOpen()) {
    // 醒来到开盘时刻才抓一次，其余只是复查时间，零请求
    if (state.resumeAt && Date.now() >= state.resumeAt - 2000) {
      try { await refreshVisible(true); } catch (e) { /* 忽略 */ }
    }
    return schedulePoll();
  }
  if (userBusy()) { schedulePoll(800); return; }
  // 正在展开读新闻：别在眼皮底下重建列表（会把刚展开的内容收回去）
  if (state.view === "feed" && newsReading()) { schedulePoll(); return; }
  if (state.sel && state.sel.key) { schedulePoll(); return; }
  const sh = $("#sheet");
  if (sh && !sh.classList.contains("hidden")) { schedulePoll(); return; }
  if (state.pollBusy) { schedulePoll(500); return; }
  state.pollBusy = true;
  const started = Date.now();
  try {
    await refreshVisible(true);
  } catch (e) {
    // 单次失败不打断轮询
  } finally {
    state.pollBusy = false;
    // 固定节拍：下一拍从本轮开始算，而不是等请求完成后再等 3 秒
    schedulePoll(Math.max(300, pollDelay() - (Date.now() - started)));
  }
}
function stopPoll() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

/* ---------- 1. feed ---------- */
/* 报告正文排版：markdown 表格 / 分点 / 小字映射 / 涨跌上色 */
function repInline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/([+\-]\d+(?:\.\d+)?%)/g, (m) =>
      `<span class="pct ${m.startsWith("-") ? "down" : "up"}">${m}</span>`);
}

/* 单元格：纯数字/金额/百分比右对齐（"5板/3家" 这类计数字段算文本） */
function repNumCell(c) {
  const t = c.replace(/\*\*/g, "").replace(/<[^>]+>/g, "").trim();
  return /^[+\-]?\d[\d,.]*\s*(%|亿|万|倍|点|元)?$/.test(t);
}

function fmtReport(txt) {
  const lines = String(txt || "").split(/\r?\n/);
  let out = [];
  let table = [];
  const flush = () => {
    if (!table.length) return;
    const parse = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const rows = table.filter((l) => !/^\|?[\s:|-]+\|?$/.test(l)).map(parse);
    if (!rows.length) { table = []; return; }
    const ncol = Math.max(...rows.map((r) => r.length));
    const numeric = Array.from({ length: ncol }, (_, j) => {
      const vals = rows.slice(1).map((r) => r[j] || "").filter(Boolean);
      return vals.length > 0 && vals.filter((v) => repNumCell(v)).length >= Math.ceil(vals.length * 0.6);
    });
    out.push(`<div class="tb-wrap"><table>${rows.map((cells, i) =>
      `<tr>${cells.map((c, j) => {
        const tag = i === 0 ? "th" : "td";
        const plain = c.replace(/\*\*/g, "").replace(/<[^>]+>/g, "").trim();
        const nw = plain.length > 0 && plain.length <= 5 && !/\s/.test(plain) ? " nw" : "";
        return `<${tag} class="${numeric[j] ? "num" : "lf"}${nw}">${repInline(c)}</${tag}>`;
      }).join("")}</tr>`).join("")}</table></div>`);
    table = [];
  };
  for (const raw of lines) {
    const ln = raw.replace(/\s+$/, "");
    if (/^\s*\|.*\|?\s*$/.test(ln) && ln.includes("|")) {
      const t = ln.trim();
      if (t.split("|").length > 2) { table.push(t); continue; }
    }
    flush();
    if (!ln.trim()) { out.push(""); continue; }
    if (/^#{1,6}\s+/.test(ln)) out.push(`<div class="h">${repInline(ln.replace(/^#{1,6}\s+/, ""))}</div>`);
    else if (/^\s*[一二三四五六七八九十]+[、.]/.test(ln) && ln.length < 40) out.push(`<div class="h">${repInline(ln.trim())}</div>`);
    else if (/^\s*[-*•]\s+/.test(ln)) out.push(`<div class="li">${repInline(ln.replace(/^\s*[-*•]\s+/, ""))}</div>`);
    else if (/^\s*(→|->|⇒)/.test(ln)) out.push(`<div class="map">${repInline(ln.trim())}</div>`);
    else out.push(repInline(ln));
  }
  flush();
  return out.join("\n");
}

/* 按「一、二、三……」把正文切成卡片（兼容 `## 一、` 写法）；没有编号标题就整段一张卡 */
function reportCards(txt) {
  const src = String(txt || "");
  if (!/[一二三四五六七八九十]+、/.test(src)) return `<div class="rp-cards">${fmtReport(src)}</div>`;
  const lines = src.split(/\r?\n/);
  const blocks = [];
  const pre = [];
  let cur = null;
  for (const raw of lines) {
    const ln = raw.replace(/\s+$/, "");
    const title = ln.replace(/^\s*#{1,4}\s*/, "").replace(/^\*\*(.+?)\*\*$/, "$1").trim();
    const isHead = /^[一二三四五六七八九十]+、\s*\S/.test(title) && title.length <= 30 && !/[。；]$/.test(title);
    if (isHead) {
      if (cur) blocks.push(cur);
      cur = { t: title, b: [] };
      continue;
    }
    (cur ? cur.b : pre).push(ln);
  }
  if (cur) blocks.push(cur);
  if (!blocks.length) return `<div class="rp-cards">${fmtReport(src)}</div>`;
  const head = pre.map((x) => x.trim()).filter(Boolean)
    .filter((x, i) => !(i === 0 && /^【/.test(x)))
    .map((x) => `<div class="rp-pre">${repInline(x)}</div>`).join("");
  return `<div class="rp-cards">${head}${blocks.map((b) =>
    `<section class="rp-card"><div class="rp-h">${repInline(b.t)}</div>
      <div class="rp-b">${fmtReport(b.b.join("\n"))}</div></section>`).join("")}</div>`;
}

async function loadFeed(silent) {
  loadDigests().catch(() => {});
  const hit = !silent && memoFresh("feed", liveTtl(30000));
  if (hit) {
    if (state.feed !== hit) applyFeed(hit);
    schedulePoll();
    return;
  }
  const d = await api("feed", silent ? { noRetry: true } : {}, silent ? 10000 : 15000);
  memoSet("feed", d);
  applyFeed(d);
  if (!silent) schedulePoll();
}

function bjWeekday(day) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y) return "";
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function prevDay(day) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y) return "";
  const t = new Date(Date.UTC(y, m - 1, d) - 86400000);
  return t.toISOString().slice(0, 10);
}
function dayLabel(day, today) {
  if (!day) return "";
  if (day === today) return "今天";
  if (day === prevDay(today)) return "昨天";
  return `${day.slice(5)} ${bjWeekday(day)}`;
}

// 统计对象的稳定签名：键序变化不算变化，避免无意义重绘
function liveStatsSig(s) {
  if (!s) return "";
  const cats = Object.keys(s.cats || {}).sort().map((k) => `${k}:${s.cats[k]}`).join(",");
  const lv = s.levels || {};
  return `${s.total || 0}|${lv.A || 0},${lv.B || 0},${lv.C || 0}|${cats}`;
}

function applyFeed(d) {
  state.feed = d;
  state.trashDays = d.trash_days || state.trashDays || 7;
  state.liveLimit = d.live_limit || state.liveLimit || 60;
  // 老版本 boot 缓存里可能已经有 200 条：先当成“已加载全部”，刷新时不要把列表缩回 60
  if ((d.live || []).length > state.liveLimit) state.liveFull = true;
  renderMarketPill(d.market || state.board.market);
  state.report = d.report || null;
  state.reportRead = !!d.read;

  state.today = d.today || state.today || "";
  renderFocusEvents(d.events || []);

  // 需关注 = 关键日程（可编辑） + 你自己添加的条目
  state.focusItems = d.focus || [];
  if (typeof d.saved_count === "number") state.favCount = d.saved_count;
  renderFocus(state.focusItems);

  // 实时新闻：日期选择（默认今天；已选跨天区间时 liveDay 为空，别被 feed 重置回今天）
  if ((d.live_days || []).length) state.liveDays = d.live_days;
  if (!state.liveDay && !state.liveRange) state.liveDay = state.today;
  renderLiveDays();
  if (state.liveDay === state.today) {
    const live = d.live || [];
    const liveKey = `${state.liveDay}:${live.length}:${(live[0] || {}).id || ""}:${d.live_limit || ""}`;
    const changed = liveKey !== state.liveKey;
    if (changed) {
      if (state.liveFull && (state.liveAll || []).length) {
        // 已经加载过更多页：把 feed 的新 60 条并到前面，别缩回 60 条
        const ids = new Set(live.map((x) => x.id));
        state.liveAll = [...live, ...state.liveAll.filter((x) => !ids.has(x.id))];
      } else {
        state.liveAll = live;
      }
    }
    // 当天全量统计（首屏只带 60 条）：总数 / A、B、C 级 / 分类都用服务端数字
    const wasHasMore = state.liveHasMore;
    const statsChanged = d.live_stats ? liveStatsSig(d.live_stats) !== liveStatsSig(state.liveStats) : false;
    if (d.live_stats) {
      state.liveStats = d.live_stats;
      state.liveTotal = Number(d.live_stats.total || 0);
    } else if (typeof d.live_total === "number") {
      state.liveTotal = d.live_total;
    }
    state.liveHasMore = state.liveTotal > (state.liveAll || []).length;
    // 有人正展开读新闻：先把数据收进内存，不重建 DOM；收起后下一拍再画
    if ((changed || statsChanged || state.liveHasMore !== wasHasMore) && !newsReading()) {
      state.liveKey = liveKey;
      renderLive(state.liveAll, d.live_at);
    }
  }

}

/* 资讯页：新闻（已下线，见 NEWS_ON）/ 需关注＝日程（顶栏日历入口） */
function setInfoTab(tab) {
  state.infoTab = NEWS_ON && tab !== "focus" ? "news" : "focus";
  const seg = $("#info-seg");
  if (seg) seg.classList.toggle("one", seg.querySelectorAll("button").length <= 1);
  $$("#info-seg button").forEach((b) => b.classList.toggle("on", b.dataset.itab === state.infoTab));
  paintTopPageButtons();
  const news = $("#info-news");
  if (news) news.classList.toggle("hidden", state.infoTab !== "news");
  const focus = $("#info-focus");
  if (focus) focus.classList.toggle("hidden", state.infoTab !== "focus");
}
/* 顶栏日历＝需关注（只放关键日程）；再点一次关闭，回到打开前的页面 */
const calBtn = $("#btn-cal");
if (calBtn) calBtn.addEventListener("click", () => {
  const dg = $("#digest");
  const dgOpen = !!(dg && !dg.classList.contains("hidden"));
  if (state.view === "feed" && state.infoTab === "focus") {
    // 新闻面板压在日程页上：先收起面板，仍留在日程页
    if (dgOpen) closeDigestPanel();
    else closeTopPage("feed");
    return;
  }
  // 已在日程页只是切到「需关注」时，不用改返回目标
  if (state.view !== "feed") openTopPage("feed");
  else if (dgOpen) closeDigestPanel();
  setInfoTab("focus");
});
const infoSeg = $("#info-seg");
if (infoSeg) infoSeg.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-itab]");
  if (!b) return;
  const same = state.infoTab === b.dataset.itab;
  setInfoTab(b.dataset.itab);
  if (same) refreshPane(b.dataset.itab === "focus" ? "focus" : "news");
});
setInfoTab(state.infoTab);


/* ---------- 热门板块（昨日 / 上午 / 今日，与昨日对比） ---------- */
async function loadHot(force, realtime) {
  const box = $("#hot-body");
  if (!box) return;
  // 今日热门盘中最多缓存 60 秒（切回标签就能看到较新的数据）；昨日热门不着急
  const ttl = state.hotTab === "today" ? liveTtl(60000) : liveTtl(300000);
  if (!force && state.hot && Date.now() - (state.hotAt || 0) < ttl) {
    renderHot();
    return;
  }
  // 已经有内容就保留着，只提示刷新中，避免整块闪空
  if (force && !box.children.length) box.innerHTML = `<div class="empty">刷新中…</div>`;

  const d = await api(realtime ? "hot?force=1" : "hot", {}, 45000);
  state.hot = d;
  state.hotAt = Date.now();
  if (!state.hotBound) {
    state.hotTab = "today";
    state.hotBound = true;
    $$("#hot-seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === "today"));
  }
  renderHot();
}

function hotCmp(base, name) {
  const v = base && base[name];
  return v === undefined || v === null ? null : v;
}

function renderHot() {
  const d = state.hot;
  const box = $("#hot-body");
  if (!box) return;
  showHotPanel();
  if (!d) return;
  const tab = state.hotTab;
  const t = tab === "yesterday" ? d.yesterday : d.latest;
  if (!t) { box.innerHTML = `<div class="empty">暂无数据</div>`; return; }
  // 休市日「今日/昨日」会名不副实（实际是上一交易日的快照），标签直接写那天的日期
  const segBox = $("#hot-seg");
  if (segBox) {
    const tDay = d.latest && d.latest.day ? String(d.latest.day).slice(5) : "";
    const yDay = d.yesterday && d.yesterday.day ? String(d.yesterday.day).slice(5) : "";
    const isLive = d.latest && d.today && String(d.latest.day) === String(d.today);
    const tBtn = segBox.querySelector('[data-tab="today"]');
    const yBtn = segBox.querySelector('[data-tab="yesterday"]');
    if (tBtn) tBtn.textContent = isLive ? "今日" : (tDay || "今日");
    if (yBtn) yBtn.textContent = yDay || "昨日";
    if (tBtn) tBtn.title = tBtn.textContent === "今日" ? "今日实时" : `交易日 ${tDay} 收盘`;
  }
  const cmp = t.cmp || {};
  const totals = t.totals || {};

  const liveNow = marketOpen() || marketState() === "lunch";
  const mtext = (state.board.market && state.board.market.text) || "";
  const offLabel = marketState() === "pre"
    ? "今日集合竞价，以下为上一交易日"
    : mtext === "未开盘"
      ? "今日尚未开盘，以下为上一交易日"
      : "最近交易日（今日休市）";
  const amNote = tab === "yesterday"
    ? `昨日全天 · 右侧为今日${d.latest && d.latest.day ? "(" + d.latest.day.slice(5) + ")" : ""}家数`
    : t.day === d.today
      ? `${liveNow ? "实时" : "收盘"} ${t.at || ""} · 对比 ${d.yesterday.day.slice(5)} 全天`
      : `${offLabel} · 数据抓取 ${t.at || ""} · 对比 ${d.yesterday.day.slice(5)}`;
  const rows = (t.sectors || []).slice();
  const tierOrder = [["主线", "主线（≥6家）", ""], ["支线", "支线（3-5家）", "sub"], ["轮动", "轮动（1-2家）", "tail"]];
  const flowHtml = tab !== "yesterday" && ((d.latest.new || []).length || (d.latest.gone || []).length)
    ? `<div class="hot-flow">${(d.latest.new || []).length ? `<b class="up">新晋</b> ${esc(d.latest.new.join("、"))}` : ""}${
      (d.latest.new || []).length && (d.latest.gone || []).length ? "<br>" : ""}${
      (d.latest.gone || []).length ? `<b class="down">退潮</b> ${esc(d.latest.gone.join("、"))}` : ""}</div>`
    : "";

  let html = `<div class="hot-tot">
      <div class="cell"><div class="v up">${totals.total ?? "—"}</div><div class="k">涨停</div></div>
      <div class="cell"><div class="v">${totals.lian ?? "—"}</div><div class="k">连板</div></div>
      <div class="cell"><div class="v">${totals.max_board ?? "—"}</div><div class="k">最高板</div></div>
      <div class="cell"><div class="v">${totals.zhaban_rate != null ? totals.zhaban_rate + "%" : "—"}</div><div class="k">炸板率</div></div>
    </div>
    <div class="hot-note">${[
      esc(amNote),
      totals.max_name ? `最高板 ${esc(totals.max_name)}` : "",
      totals.zhaban != null ? `炸板 ${totals.zhaban} 家` : "",
    ].filter(Boolean).join(" · ")}</div>
    ${flowHtml}`;

  for (const [tier, label, cls] of tierOrder) {
    const arr = rows.filter((x) => (x.tier || "轮动") === tier);
    if (!arr.length) continue;
    const lim = tier === "轮动" ? (state.hotTailAll ? 99 : 2) : 99;
    const shown = arr.slice(0, lim);
    const stocks = arr.reduce((n, x) => n + (x.count || 0), 0);
    html += `<div class="hot-tier ${cls} clickable" data-tier="${tier}"><span>${label}</span>
      <span class="tiny">${arr.length} 个板块 · ${stocks} 只涨停</span></div>`;
    html += shown.map((x) => {
      const todayTab = tab !== "yesterday";
      let deltaHtml = "";
      if (todayTab) {
        const prev = hotCmp(cmp, x.name);
        const delta = prev === null ? null : x.count - prev;
        if (delta === null) deltaHtml = `<span class="hs-delta up">新晋</span>`;
        else if (delta > 0) deltaHtml = `<span class="hs-delta up">昨${prev}→${x.count} +${delta}</span>`;
        else if (delta < 0) deltaHtml = `<span class="hs-delta down">昨${prev}→${x.count} ${delta}</span>`;
        else deltaHtml = `<span class="hs-delta flat">昨${prev}→持平</span>`;
      } else {
        const todayN = hotCmp(cmp, x.name);
        if (todayN === null) deltaHtml = `<span class="hs-delta down">今日未上榜</span>`;
        else if (todayN === 0) deltaHtml = `<span class="hs-delta down">今日 0 断板</span>`;
        else {
          const dv = todayN - x.count;
          deltaHtml = `<span class="hs-delta ${dv > 0 ? "up" : dv < 0 ? "down" : "flat"}">今日 ${todayN} 家 ${dv > 0 ? "+" + dv : dv < 0 ? dv : "持平"}</span>`;
        }
      }
      const pct = (x.pct === null || x.pct === undefined) ? ""
        : `<span class="hs-pct ${x.pct > 0 ? "up" : x.pct < 0 ? "down" : "flat"}">${x.pct > 0 ? "+" : ""}${x.pct}%</span>`;
      return `<div class="hs-row" data-sec="${esc(x.name)}" data-tierrow="${tier}">
        <div class="hs-h"><b>${esc(x.name)}</b>${pct}${deltaHtml}</div>
        <div class="hs-s">${x.count} 家涨停${x.max_board > 1 ? ` · 最高 ${x.max_board} 板${x.max_name ? "(" + esc(x.max_name) + ")" : ""}` : " · 首板"}${
          x.fund ? ` · 封单 ${Number(x.fund).toFixed(1)} 亿` : ""}<span class="hs-more">看票 ›</span></div>
        ${x.stocks && x.stocks.length ? `<div class="hs-n">${esc(x.stocks.join("、"))}${x.count > x.stocks.length ? "…" : ""}</div>` : ""}
      </div>`;
    }).join("");
    if (arr.length > shown.length) {
      html += `<button class="btn ghost small more-hot" data-tail="1">展开轮动（还有 ${arr.length - shown.length} 个）</button>`;
    } else if (tier === "轮动" && state.hotTailAll && arr.length > 2) {
      html += `<button class="btn ghost small more-hot" data-tail="0">收起轮动</button>`;
    }
  }
  if (!rows.length) html += `<div class="empty">暂无涨停数据</div>`;

  box.innerHTML = html;
  $$("#hot-body .more-hot").forEach((b) => (b.onclick = () => {
    state.hotTailAll = b.dataset.tail === "1";
    renderHot();
  }));
  $$("#hot-body .hot-tier[data-tier]").forEach((b) => (b.onclick = () => openTierSheet(b.dataset.tier, t)));
  $$("#hot-body .hs-row[data-sec]").forEach((r) => (r.onclick = () => {
    const x = (t.sectors || []).find((s) => s.name === r.dataset.sec);
    if (x) openSectorSheet(x);
  }));
}

/* ---------- 报告分析：热门板块「热门分析」+ 市场行情「大盘/宏观」 ---------- */
let anaCache = { at: 0, d: null };

async function loadAnalysis(force) {
  if (!force && anaCache.d && Date.now() - anaCache.at < 60000) {
    paintAnalysis();
    return;
  }
  const d = await api("analysis").catch(() => null);
  // 抓不到 ≠ 报告里没有这一段：失败要单独给失败态和重试，别用空状态糊过去
  anaCache = d ? { at: Date.now(), d, err: false } : { ...anaCache, err: !anaCache.d };
  paintAnalysis();
}

function bindAnalysisRetry() {
  const btn = $("#ana-retry");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "重试中…";
    try { await loadAnalysis(true); } finally { btn.disabled = false; btn.textContent = "重试"; }
  };
}

/* 涨跌幅上色已由 repInline 统一处理，这里保持原样（避免二次包裹） */
/* 分析条目「前缀：正文」：前缀只作为很小的灰色类型标记内联在首行，
   不做图标、不做色块、不做左侧装饰条——尽量像一份读得进去的市场简评 */
const ANA_LI_LABELS = ["指数","成交","涨跌","情绪","题材","外盘","小结","资金","板块","政策","风险","估值","主线","轮动","北向","消息","操作","怎么看","概览"];
/* 不许被折断的统计口径（等价于 brief.py 原来的粘连规则，改由 CSS nowrap 实现） */
const ANA_NW = /(?:\d+\s?家)?[涨跌]停|沪深\s?300|纳指\s?100|标普\s?500|科创\s?50|韩国\s?KOSPI|两市成交|最高板|炸板率|涨跌比|\d+\.\d+\s?万亿|\d+\.\d+\s?亿/g;
function decorAna(html) {
  let src = String(html || "");
  // 带类型前缀的条目：小号灰字标记 + 正文
  src = src.replace(/<div class="li">([^<]{1,6})([：:])([\s\S]*?)<\/div>/g, (m, label, sep, rest) => {
    const k = label.trim();
    if (!ANA_LI_LABELS.includes(k)) return m;
    return `<div class="li li-k"><span class="li-k-l">${k}</span><span class="li-k-v">${rest}</span></div>`;
  });
  // 政策摘要这类「日期 + 标题」的条目：去掉圆点，日期当小号行首标记
  // 日期后面有没有空格都要认（`11-21　标题` 与 `11-21标题` 两种都来自不同上游），
  // 否则这类行会漏成普通条目，圆点正好压在「11」上
  src = src.replace(/<div class="li">(\d{1,2}-\d{1,2})(?:[\s\u3000]*)([\s\S]*?)<\/div>/g,
    (m, d, t) => `<div class="li li-n"><span class="li-k-l">${d}</span><span class="li-k-v">${t}</span></div>`);
  // 「4家涨停」「沪深300」「3.26亿」这类统计口径整块不许折行：以前靠往字缝里塞
  // U+2060 粘连符实现，复制/朗读会带脏字符；改成套一层 nowrap 的 span，文本保持干净
  src = src.replace(ANA_NW, (m) => `<span class="nw">${m}</span>`);
  return src;
}


/* 大盘分析整页：原来「大盘行情分析」「宏观政策分析」两张大卡各自带标题和同一行日期，
   合到一张卡里，中间用一条细分隔线分段——少一个卡框、少一份重复的「盘后 xx」，
   一屏能多看到一条内容 */
function paintAnalysis() {
  const d = anaCache.d;
  const mBox = $("#mkt-analysis");
  if (!mBox) return;
  if (!d) {
    mBox.innerHTML = anaCache.err ? `<div class="ana-card"><div class="ana-fail">
      <div class="ana-fail-t">大盘分析暂时取不到数据</div>
      <div class="ana-fail-d">接口没回内容，可能是上游行情源临时不可用</div>
      <button class="btn ghost small" id="ana-retry" type="button">重试</button></div></div>` : "";
    bindAnalysisRetry();
    return;
  }
  const mkt = (d.market || [])[0];
  const mac = (d.macro || [])[0];
  if (!mkt && !mac) {
    mBox.innerHTML = `<div class="ana-card ana-empty"><div class="ana-body">
      <div class="empty">报告里还没有这一段</div></div></div>`;
    return;
  }
  const day = (mkt && mkt.label) || (mac && mac.label) || "";
  // 日期不再单独占一行：并到第一段的小标题行右端
  const sec = (title, x, meta) => x ? `<div class="ana-sec">
      <div class="ana-sec-h"><span>${esc(title)}</span>${meta ? `<span class="ana-meta">${esc(meta)}</span>` : ""}</div>
      <div class="ana-body">${decorAna(fmtReport(x.content))}</div>
    </div>` : "";
  mBox.innerHTML = `<div class="ana-card">
    ${sec("大盘行情", mkt, day)}
    ${mac ? sec("政策面", mac, "") : ""}
  </div>`;
  bindClamp(mBox);
}


/* 点某一类标题：这一类里所有涨停的票 */
function openTierSheet(tier, t) {
  const secs = (t.sectors || []).filter((x) => (x.tier || "轮动") === tier);
  const items = [];
  secs.forEach((x) => secItems(x).forEach((m) => items.push({ ...m, sector: x.name })));
  items.sort((a, b) => (b.lbc - a.lbc) || a.sector.localeCompare(b.sector));
  const head = `<div class="tiny muted" style="margin-bottom:8px">${secs.length} 个板块 · ${items.length} 只涨停 · 按连板数</div>`;
  openSheet(`${tier} · ${items.length} 只涨停`, head + stockList(items));
}

/* 点某个板块卡片：这个板块里的涨停的票 */
function openSectorSheet(x) {
  const items = secItems(x).map((m) => ({ ...m, sector: x.name }));
  items.sort((a, b) => b.lbc - a.lbc);
  const head = `<div class="tiny muted" style="margin-bottom:8px">${esc(x.tier || "轮动")} · ${items.length} 只涨停${
    x.fund ? ` · 封单 ${Number(x.fund).toFixed(1)} 亿` : ""}${x.pct != null ? ` · 板块 ${x.pct > 0 ? "+" : ""}${x.pct}%` : ""}</div>`;
  openSheet(`${x.name} · ${items.length} 只涨停`, head + stockList(items));
}

function secItems(x) {
  return x.members && x.members.length
    ? x.members.map((m) => ({ code: m[0], name: m[1], lbc: m[2] || 1 }))
    : (x.stocks || []).map((n) => ({ code: "", name: n, lbc: 1 }));
}

function stockList(items) {
  const html = `<div class="list">${items.map((x) => `<div class="heat-row"${x.code ? ` data-code="${x.code}" data-name="${esc(x.name)}"` : ""}>
      <div class="l"><div class="nm">${esc(x.name)}${x.lbc > 1 ? ` <span class="tiny" style="color:var(--up)">${x.lbc}板</span>` : ""}</div>
      <div class="cd">${esc(x.sector || "")}${x.code ? (x.sector ? " · " : "") + x.code + mktBadge(x.code) : ""}</div></div></div>`).join("")}</div>`;
  setTimeout(() => {
    $$("#sheet .heat-row[data-code]").forEach((r) => (r.onclick = () => openHeatStock(r.dataset.code, r.dataset.name)));
  }, 0);
  return html;
}


$("#hot-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const prevTab = state.hotTab;
  state.hotTab = b.dataset.tab;
  state.hotTailAll = false;
  state.hotShowAll = false;
  $$("#hot-seg button").forEach((x) => x.classList.toggle("on", x === b));
  showHotPanel();
  // 点「今日热门」= 想看现在这一刻：超过 30 秒就现抓（后端 force=1 绕过所有缓存）
  // 再点一次选中的选项卡也强制现抓
  const stale = !state.hot || !state.hotAt || Date.now() - state.hotAt > 30000;
  if (state.hotTab === "today" && (prevTab !== "today" || stale)) {
    loadHot(true, true).catch((err) => {
      toast(`刷新失败：${err.message}`);
      if (state.hot) renderHot();
    });
    return;
  }
  if (prevTab === state.hotTab && state.hotTab === "yesterday") {
    loadHot(true).catch((err) => toast(`刷新失败：${err.message}`));
    return;
  }
  renderHot();
});

function showHotPanel() {
  // 热门分析面板已注销：它的内容源（报告里的 hot 段）随旧日报体系一起没了，永远空着
  const body = $("#hot-body");
  if (body) body.classList.remove("hidden");
  const ana = $("#hot-analysis");
  if (ana) ana.classList.add("hidden");
}



function daysUntil(day) {
  const p = (s) => String(s || "").split("-").map(Number);
  const [y, m, d] = p(day);
  const [ty, tm, td] = p(state.today || day);
  if (!y || !ty) return "";
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
  return diff === 0 ? "今天" : diff === 1 ? "明天" : diff > 1 ? `${diff}天后` : "已过";
}

/* 日程页：周条 + 按天分组。点周条筛某天（再点取消），点行编辑。 */
function addDaysStr(day, n) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  if (!y) return "";
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function renderFocusEvents(events) {
  const box = $("#focus-events");
  if (!box) return;
  const all = (events || []).filter((x) => x && x.day).slice().sort((a, b) => (
    a.day === b.day
      ? String(a.time || "99:99").localeCompare(String(b.time || "99:99"))
      : a.day < b.day ? -1 : 1));
  state.events = all;
  const today = state.today || (all[0] && all[0].day) || "";
  const sel = state.evFilterDay || "";
  const key = `${today}|${sel}|` + all.map((x) => `${x.day}:${x.time || ""}:${x.kind || ""}:${x.title}`).join("|");
  if (key === state.eventsKey) return;
  state.eventsKey = key;

  const onDay = (d) => all.filter((x) => x.day === d);
  const shown = sel ? all.filter((x) => x.day === sel) : all;

  const head = `<div class="ev-top">
      <div class="ev-month"><b>${today ? Number(today.slice(5, 7)) + " 月" : "日程"}</b><span>${today ? today.slice(0, 4) : ""}</span></div>
      <div class="ev-side"><div class="ev-count">今天 ${onDay(today).length} 场<span>·</span>共 ${all.length} 场</div>
      </div>
    </div>`;

  const week = "";
  // 只铺未来 7 天，更远的收进一行「展开」，避免一屏列表拖到十几屏
  const horizon = addDaysStr(today, 6);
  const near = shown.filter((x) => x.day <= horizon);
  const far = shown.filter((x) => x.day > horizon);
  const groups = [];
  near.forEach((x) => {
    const g = groups[groups.length - 1];
    if (g && g.day === x.day) g.items.push(x);
    else groups.push({ day: x.day, items: [x] });
  });
  const rowHtml = (x) => {
    const i = all.indexOf(x);
    const kind = x.kind || "日程";
    const tip = [x.title, x.time ? `北京时间 ${x.time}` : "", x.note || ""].filter(Boolean).join(" · ");
    return `<button type="button" class="ev-item" data-ev="${i}" title="${esc(tip)}">
      <span class="ev-time${x.time ? "" : " none"}">${x.time ? esc(x.time) : "全天"}</span>
      <span class="ev-kind k-${esc(kind)}">${esc(kind)}</span>
      <span class="ev-title">${esc(x.title)}</span>
      <span class="ev-chev" aria-hidden="true">›</span>
    </button>`;
  };
  const body = groups.length ? groups.map((g) => {
    const dl = daysUntil(g.day);
    const name = (dl === "今天" || dl === "明天") ? dl : bjWeekday(g.day);
    return `<div class="ev-group">
      <div class="ev-ghead"><span class="ev-gname${dl === "今天" ? " now" : ""}">${esc(name)}</span>
        <span class="ev-gdate">${esc(g.day.slice(5))}</span><span class="ev-gn">${g.items.length} 条</span></div>
      ${g.items.map(rowHtml).join("")}</div>`;
  }).join("") + (far.length && !sel ? `<div class="ev-more${state.evMore ? " open" : ""}">
      <button type="button" class="ev-more-btn" data-evmore>${state.evMore ? "收起" : `还有 ${far.length} 场更远的日程`}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg></button>
      <div class="ev-more-list">${far.map(rowHtml).join("")}</div>
    </div>` : "") : `<div class="ev-empty">${sel ? "这一天没有日程" : "未来还没有日程，点下面的按钮加一条"}</div>`;

  const selbar = sel ? `<div class="ev-selbar"><span>只看 ${esc(sel.slice(5))} 这天</span>
    <button type="button" data-evclear>看全部日程</button></div>` : "";

  box.classList.remove("hidden");
  box.innerHTML = head + week + selbar + body;
  $$("#focus-events [data-ev]").forEach((r) => {
    r.onclick = () => openEventEdit(state.events[Number(r.dataset.ev)]);
  });
  const clearBtn = $("#focus-events [data-evclear]");
  if (clearBtn) clearBtn.onclick = () => { state.evFilterDay = ""; state.eventsKey = ""; renderFocusEvents(state.events); };
  const moreBtn = $("#focus-events [data-evmore]");
  if (moreBtn) moreBtn.onclick = () => { state.evMore = !state.evMore; state.eventsKey = ""; renderFocusEvents(state.events); };
  $$("#focus-events .ev-wday").forEach((b) => {
    b.onclick = () => {
      state.evFilterDay = state.evFilterDay === b.dataset.day ? "" : b.dataset.day;
      state.eventsKey = "";
      renderFocusEvents(state.events);
    };
  });
}
$("#ev-add").addEventListener("click", () => openEventEdit(null));

/* 日程编辑：自己加的日程可改日期/内容/标签/删除；系统日程只提供「隐藏」 */
const EV_TAGS = ["日程", "财报", "美联储", "数据", "会议", "政策", "解禁", "期权"];
function evTagOptions(cur) {
  return EV_TAGS.map((t) => `<option value="${t}"${t === (cur || "日程") ? " selected" : ""}>${t}</option>`).join("");
}

function openEventEdit(ev) {
  const manual = !!(ev && ev.manual);
  const day = (ev && ev.day) || state.today || "";
  if (!ev) {
    openSheet("添加日程", `
      <div class="seg ev-mode" id="ev-mode">
        <button data-m="one" class="on">单条</button><button data-m="batch">批量识别</button>
      </div>
      <div id="ev-one">
        <div class="field"><label>日期</label>${datePickHtml("ev-day", day, { full: true, label: "日期" })}</div>
        <div class="field"><label>内容</label><input id="ev-title" maxlength="120" placeholder="例如：三季报披露 / 美联储议息"></div>
        <div class="field"><label>标签</label><select id="ev-tag">${evTagOptions("日程")}</select></div>
        <div class="field"><label>备注（可选）</label><input id="ev-note" maxlength="200" placeholder="时间、看点等"></div>
        <div class="sheet-actions"><button class="btn primary" id="ev-save">保存</button></div>
      </div>
      <div id="ev-batch" class="hidden">
        <div class="field"><label>粘贴一段话，按里面的日期自动拆成日程</label>
          <textarea id="ev-raw" rows="4" placeholder="例如：中际旭创（10月29日）、天孚通信（10月28日）、贵州茅台（10月30日）…"></textarea></div>
        <div class="sheet-actions"><button class="btn ghost" id="ev-parse">识别</button></div>
        <div id="ev-preview"></div>
        <div class="sheet-actions"><button class="btn primary" id="ev-batch-save" disabled>添加全部</button></div>
      </div>`);
    $$("#ev-mode button").forEach((b) => {
      b.onclick = () => {
        $$("#ev-mode button").forEach((x) => x.classList.toggle("on", x === b));
        $("#ev-one").classList.toggle("hidden", b.dataset.m !== "one");
        $("#ev-batch").classList.toggle("hidden", b.dataset.m !== "batch");
      };
    });
    $("#ev-save").onclick = async () => {
      const d = $("#ev-day").value, t = ($("#ev-title").value || "").trim();
      if (!d || !t) return toast("日期和内容都要填");
      await api("news", { method: "POST", body: {
        day: d, category: "日程", title: t, body: $("#ev-note").value.trim(),
        source: "manual", tag: $("#ev-tag").value,
      } });
      closeSheet(); toast("日程已添加");
      loadFeed(true).catch(() => {});
    };
    bindEvBatch();
    return;
  }
  if (manual) {
    openSheet("编辑日程", `
      <div class="field"><label>日期</label>${datePickHtml("ev-day", day, { full: true, label: "日期" })}</div>
      <div class="field"><label>内容</label><input id="ev-title" maxlength="120" value="${esc(ev.title || "")}"></div>
      <div class="field"><label>标签</label><select id="ev-tag">${evTagOptions(ev.tag || ev.kind || "日程")}</select></div>
      <div class="field"><label>备注（可选）</label><input id="ev-note" maxlength="200" value="${esc(ev.note && ev.note !== "手动添加" ? ev.note : "")}"></div>
      <div class="sheet-actions"><button class="btn primary" id="ev-save">保存</button>
        <button class="btn danger" id="ev-del">删除</button></div>`);
    $("#ev-save").onclick = async () => {
      const d = $("#ev-day").value, t = ($("#ev-title").value || "").trim();
      if (!d || !t) return toast("日期和内容都要填");
      await api(`news/${ev.id}`, { method: "PATCH", body: {
        day: d, title: t, body: $("#ev-note").value.trim(), category: "日程", tag: $("#ev-tag").value,
      } });
      closeSheet(); toast("日程已更新");
      loadFeed(true).catch(() => {});
    };
    $("#ev-del").onclick = async () => {
      const db = $("#ev-del");
      if (!armAsk(db, "再点一次确认删除")) return;
      db.disabled = true;
      try {
        await api(`news/${ev.id}`, { method: "DELETE" });
        closeSheet(); toast("已删除");
        loadFeed(true).catch(() => {});
      } catch (e) { toast(e.message); db.disabled = false; }
    };
    return;
  }
  openSheet(ev.auto ? "市场日历" : "系统日程", `
    <div class="field"><label>${esc(ev.day)} ${esc(ev.weekday || bjWeekday(ev.day))}${ev.time ? " · 北京时间 " + esc(ev.time) : ""}</label>
      <div class="ana-body">${esc(ev.title)}${ev.note ? `<div class="tiny muted">${esc(ev.note)}</div>` : ""}
      ${ev.auto ? `<div class="tiny muted">东方财富财经日历 · 自动更新</div>` : ""}</div></div>
    <div class="sheet-actions"><button class="btn danger" id="ev-hide">隐藏此日程</button>
      <button class="btn ghost" data-close>关闭</button></div>`);
  $("#ev-hide").onclick = async () => {
    await api("events/hide", { method: "POST", body: { day: ev.day, title: ev.title } });
    closeSheet(); toast("已隐藏");
    loadFeed(true).catch(() => {});
  };
}

/* 批量识别：粘贴一段话 → 解析成若干条 → 可改日期/标题/标签 → 一次写入 */
function bindEvBatch() {
  let drafts = [];
  const paint = () => {
    $("#ev-preview").innerHTML = drafts.map((d, i) => `
      <div class="ev-draft" data-i="${i}">
        <input class="d-day" type="date" value="${esc(d.day)}">
        <input class="d-title" value="${esc(d.title)}" maxlength="120">
        <select class="d-tag">${evTagOptions(d.tag)}</select>
        <button type="button" class="d-x" data-x="${i}" aria-label="移除">✕</button>
      </div>`).join("");
    $$("#ev-preview .ev-draft").forEach((row) => {
      const i = Number(row.dataset.i);
      const sync = () => {
        drafts[i].day = $(".d-day", row).value;
        drafts[i].title = ($(".d-title", row).value || "").trim();
        drafts[i].tag = $(".d-tag", row).value;
      };
      [".d-day", ".d-title", ".d-tag"].forEach((sel) => {
        $(sel, row).addEventListener("input", sync);
        $(sel, row).addEventListener("change", sync);
      });
      $(".d-x", row).onclick = () => { drafts.splice(i, 1); paint(); };
    });
    const btn = $("#ev-batch-save");
    btn.disabled = !drafts.length;
    btn.textContent = drafts.length ? `添加全部（${drafts.length} 条）` : "添加全部";
  };
  $("#ev-parse").onclick = async (e) => {
    const text = ($("#ev-raw").value || "").trim();
    if (!text) return toast("先粘贴一段话");
    const b = e.currentTarget;
    b.disabled = true; b.textContent = "识别中…";
    const r = await api("events/parse", { method: "POST", body: { text } }).catch((err) => {
      toast(err.message); return null;
    });
    b.disabled = false; b.textContent = "识别";
    if (!r) return;
    drafts = r.items || [];
    paint();
    toast(drafts.length ? `识别到 ${drafts.length} 个日期` : "没有识别到日期，换个写法试试");
  };
  $("#ev-batch-save").onclick = async () => {
    const ok = drafts.filter((d) => d.day && d.title);
    if (!ok.length) return toast("没有可添加的条目");
    const b = $("#ev-batch-save");
    b.disabled = true; b.textContent = "添加中…";
    let n = 0;
    for (const d of ok) {
      try {
        await api("news", { method: "POST", body: {
          day: d.day, category: "日程", title: d.title, body: d.note || "",
          source: "manual", tag: d.tag || "日程",
        } });
        n++;
      } catch (e) { /* 单条失败不影响其它 */ }
    }
    closeSheet();
    toast(`已添加 ${n} 个日程`);
    loadFeed(true).catch(() => {});
  };
}

function dayAdd(day, n) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/* 紧凑日期选择：外层只显示「月-日」，原生 date 控件透明覆盖在下面负责弹选择器。
   full=true 用在弹层表单里，保持整行输入框的高度。 */
function datePickHtml(id, value, opts = {}) {
  const v = String(value || "");
  const { min = "", max = "", label = "选择日期", full = false, weekday = false } = opts;
  return `<label class="date-pick${full ? " full" : ""}" tabindex="0" title="${esc(label)}">
    <span class="date-pick-text">${esc(v ? v.slice(5) : "选日期")}${weekday && v ? `<i class="dp-w">${bjWeekday(v)}</i>` : ""}</span>
    <svg class="date-pick-cal" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/></svg>
    <input type="date" id="${esc(id)}" class="date-pick-native" tabindex="-1"${min ? ` min="${esc(min)}"` : ""}${max ? ` max="${esc(max)}"` : ""} value="${esc(v)}" aria-label="${esc(label)}">
  </label>`;
}

/* 时间范围：今天 / 3天 / 选日期 / 全部（闭区间，空字符串＝不限） */
function rangeChips(box, st, onPick, prefix) {
  const today = state.today;
  const from = st.from || "";
  const to = st.to || "";
  const isToday = from === today && to === today;
  const is2 = from === dayAdd(today, -1) && to === today;
  const isAll = !from && !to;
  const isCustom = !!from && !isToday && !is2;
  const label = isCustom ? (from === to ? from.slice(5) : `${from.slice(5)}~${to.slice(5)}`) : "";
  // 「选日期」放最前面；默认仍停在「今天」
  box.innerHTML =
    `<button class="chip more ${isCustom ? "on" : ""}" data-range="pick" id="${prefix}-range-btn"><svg class="chip-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.8" width="18" height="16.2" rx="3"/><path d="M8 2.6v4M16 2.6v4M3 9.6h18"/></svg>${label || "选日期"}</button>` +
    `<button class="chip ${isToday ? "on" : ""}" data-range="1">今天</button>` +
    `<button class="chip ${is2 ? "on" : ""}" data-range="2">2天</button>` +
    `<button class="chip ${isAll ? "on" : ""}" data-range="0">全部</button>`;
  $$("[data-range]", box).forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.range;
      if (k === "pick") return openRangeSheet({ from, to }, onPick, null);
      if (k === "0") return onPick("", "");
      if (k === "1") return onPick(today, today);
      onPick(dayAdd(today, -1), today);
    };
  });
}

function openRangeSheet(st, onPick, onClear) {
  const today = state.today;
  const fromVal = st.from || dayAdd(today, -6);
  const toVal = st.to || today;
  openSheet("时间范围", `<div class="range-form">
      <div class="range-date"><span>开始</span>${datePickHtml("rg-from", fromVal, { max: today, label: "开始日期", full: true })}</div>
      <div class="range-date"><span>结束</span>${datePickHtml("rg-to", toVal, { max: today, label: "结束日期", full: true })}</div>
    </div>
    <div class="sheet-actions"><button class="btn primary" id="rg-ok">应用</button>
      ${onClear ? `<button class="btn ghost" id="rg-clear">全部时间</button>` : ""}</div>`);
  const clear = $("#rg-clear");
  if (clear) clear.onclick = () => { closeSheet(); onClear(); };
  $("#rg-ok").onclick = () => {
    let a = $("#rg-from").value;
    let b = $("#rg-to").value;
    if (!a || !b) { toast("先选起止日期"); return; }
    if (a > b) [a, b] = [b, a];
    closeSheet();
    onPick(a, b);
  };
}


/* 实时新闻：财联社电报全量（金十兜底） */
const LIVE_PAGE = 60;   // 实时新闻每页 60 条，点「查看更多」再翻下一页
const LIVE_CATS = ["战事", "宏观", "行业", "市场", "综合"];

/* 右侧操作图标：内联 SVG，避免 ☆/✕ 在不同字体里忽大忽小 */
const ICON_STAR = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.7 5.4 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6-4.3-4.2 6-.9L12 3.5z"/></svg>';
const ICON_STAR_ON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.7 5.4 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6-4.3-4.2 6-.9L12 3.5z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7M10 10.5v6M14 10.5v6"/></svg>';

/* 收藏按钮原地更新：不重绘列表，避免展开阅读的新闻被刷新收起 */
function paintSaveBtn(b, saved) {
  if (!b) return;
  b.dataset.busy = "0";
  b.dataset.cur = saved ? "1" : "0";
  b.disabled = false;
  b.classList.remove("busy");
  b.classList.toggle("on", !!saved);
  b.innerHTML = `${saved ? ICON_STAR_ON : ICON_STAR}<span>${saved ? "已收藏" : "收藏"}</span>`;
}

/* 当前正在展示的实时新闻列表（当天用全量，历史日期用已加载的那份） */
function currentLive() {
  return (state.liveDay === state.today && state.liveAll) ? state.liveAll : (state.liveItems || []);
}

function repaintLive() {
  renderLive(currentLive(), (state.feed && state.feed.live_at) || "");
}

/* 是否正有一条实时新闻处于展开阅读状态（展开期间暂停自动刷新） */
function newsReading() {
  // 只看当前可见的列表：切到收藏夹/搜索后，隐藏列表里的展开状态不应继续暂停刷新
  return $$("#live-list .lx.clamp.open, #live-search-list .lx.clamp.open, #live-fav .lx.clamp.open, #news-focus .txt.clamp.open")
    .some((el) => el.offsetParent !== null);
}

/* 重建列表时保留展开状态（同一条新闻重绘后仍是展开的） */
function clampOpen(n) {
  return state.liveOpen.has(String(n.id)) ? " open" : "";
}

/* ---------- 收藏夹：新闻区里的独立标签，收藏不再进「需关注」 ---------- */
function favId(n) { return String(n.id); }
function favSort(a, b) {
  const ka = String(a.published_at || a.created_at || a.day || "");
  const kb = String(b.published_at || b.created_at || b.day || "");
  return kb.localeCompare(ka) || (Number(b.id || 0) - Number(a.id || 0));
}
function syncFavCount() {
  const el = $("#fav-count");
  if (el) el.textContent = state.favCount || 0;
}
function markSavedEverywhere(id, to) {
  [state.liveSearchItems, state.liveItems, state.liveAll].forEach((arr) => {
    const it = (arr || []).find((x) => favId(x) === String(id));
    if (it) it.saved = to;
  });
}
function setFavorite(n, to) {
  const id = favId(n);
  state.favorites = (state.favorites || []).filter((x) => favId(x) !== id);
  if (to && n && state.favLoaded) state.favorites.push({ ...n, saved: 1 });
  state.favorites.sort(favSort);
  // 收藏夹列表是懒加载的：没加载过就不往数组里塞半份，只维护角标数量
  state.favCount = Math.max(0, (state.favCount || 0) + (to ? 1 : -1));
  syncFavCount();
  if (state.liveTab === "fav") renderFavorites();
}
/* 删除后把所有内存列表里的这一条同时抹掉（含按日期的缓存） */
function forgetNews(id) {
  const wasFav = (state.favorites || []).some((x) => favId(x) === String(id));
  const keep = (arr) => (arr || []).filter((x) => favId(x) !== String(id));
  state.liveSearchItems = keep(state.liveSearchItems);
  state.liveItems = keep(state.liveItems);
  state.liveAll = keep(state.liveAll);
  state.focusItems = keep(state.focusItems);
  state.favorites = keep(state.favorites);
  state.liveOpen.delete(String(id));
  Object.keys(state.focusByDay || {}).forEach((d) => { state.focusByDay[d] = keep(state.focusByDay[d]); });
  if (wasFav) state.favCount = Math.max(0, (state.favCount || 0) - 1);
  syncFavCount();
}


function favItemHtml(n) {
  const daySrc = n.published_at || n.day || n.created_at || "";
  const day = daySrc.slice(5, 10);
  const time = n.published_at ? n.published_at.slice(11, 16) : "";
  const lv = (n.level || "").toUpperCase();
  const cat = n.category || "";
  const src = n.source === "live" ? "" : (n.source === "report" ? "报告" : "人工");
  return `<div class="live-item live-search-item selable" data-id="${n.id}">
    <div class="lt" data-copy="${esc(day)}${time ? " " + esc(time) : ""}"><span class="d">${esc(day)}</span>${time ? `<span class="t">${esc(time)}</span>` : ""}</div>
    <div class="lc">${lv ? `<span class="badge lv-${lv}">${esc(lv)}</span>` : ""}${n.alert ? '<span class="badge alert">重点</span>' : ""}
      <span class="lc-line"><span class="badge ${CAT_CLASS[cat] || (cat === "宏观" ? "policy" : "")}">${esc(cat)}</span>${src ? `<span class="tag-label">${src}</span>` : ""}</span></div>
    <div class="lx clamp${clampOpen(n)}">${esc(n.title)}</div>
    <div class="lacts">
      <button class="lact star on" data-save="${n.id}" data-cur="1">${ICON_STAR_ON}<span>已收藏</span></button>
      <button class="lact drop" data-drop="${n.id}">${ICON_TRASH}<span>删除</span></button>
    </div>
  </div>`;
}

function renderFavorites() {
  const box = $("#live-fav");
  if (!box) return;
  const list = (state.favorites || []).slice().sort(favSort);
  if (!list.length) {
    box.innerHTML = `<div class="empty">收藏夹是空的</div>`;
    return;
  }
  box.innerHTML = list.map(favItemHtml).join("");
  bindClamp(box);
  bindCopy(box);
  bindFavActions(box);
}

function bindFavActions(box) {
  $$("[data-save]", box).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.dataset.busy === "1") return;
      const id = b.dataset.save;
      b.dataset.busy = "1";
      b.disabled = true;
      b.classList.add("busy");
      b.textContent = "取消中…";
      try {
        await api(`news/${id}/save`, { method: "POST", body: { saved: 0 }, idempotent: true });
        toast("已取消收藏");
        setFavorite({ id }, 0);
        markSavedEverywhere(id, 0);
        renderFavorites();
        repaintLive();
        loadFeed(true).catch(() => {});
      } catch (err) {
        toast(err.message);
        renderFavorites();
      }
    };
  });
  $$("[data-drop]", box).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.dataset.busy === "1") return;
      const id = b.dataset.drop;
      b.dataset.busy = "1";
      b.disabled = true;
      b.classList.add("busy");
      b.textContent = "删除中…";
      try {
        await api(`news/${id}`, { method: "DELETE", idempotent: true });
        toast("已删除，可在回收站找回");
        forgetNews(id);
        renderFavorites();
        repaintLive();
        loadFeed(true).catch(() => {});
      } catch (err) {
        toast(err.message);
        renderFavorites();
      }
    };
  });
}

function renderLiveDays() {
  const box = $("#live-days");
  if (!box) return;
  const from = state.liveFrom || state.liveDay || "";
  const to = state.liveTo || state.liveDay || "";
  rangeChips(box, { from, to }, selectLiveRange, "live");
}

async function selectLiveRange(from, to) {
  state.liveFrom = from || "";
  state.liveTo = to || "";
  state.liveDay = from && from === to ? from : "";
  state.liveRange = !(from && from === to);
  state.liveShown = 10;
  renderLiveDays();
  $("#live-list").innerHTML = `<div class="empty">加载中…</div>`;
  // 「全部」= 库里留的 7 天。每次只取一页，点「查看更多」再翻；
  // 总数和各分组计数由服务端全量统计，跟加载了多少条无关。
  const qFrom = from || dayAdd(state.today, -6);
  const qTo = to || state.today;
  let url;
  if (from === to && from) url = `live?day=${from}&limit=${LIVE_PAGE}`;
  else url = `live?start=${qFrom}&end=${qTo}&limit=${LIVE_PAGE}`;
  const r = await api(url).catch(() => ({ items: [] }));
  state.liveAll = r.items || [];
  state.liveFull = true;
  state.liveHasMore = !!r.has_more;
  state.liveStats = r.stats || null;
  state.liveTotal = Number((r.stats && r.stats.total) || r.total || state.liveAll.length);
  state.liveKey = `${from || ""}~${to || ""}:${state.liveAll.length}`;
  renderLive(state.liveAll, (state.feed && state.feed.live_at) || "");
}

function renderLive(items, at) {
  state.liveItems = items;
  // 新闻功能已下线：容器不在页面上，数据照收、不碰 DOM
  if (!NEWS_ON) return;
  const counts = {};
  const lcounts = { A: 0, B: 0, C: 0 };
  items.forEach((n) => {
    counts[n.category] = (counts[n.category] || 0) + 1;
    const lv = (n.level || "C").toUpperCase();
    lcounts[lv] = (lcounts[lv] || 0) + 1;
  });
  // 总数 / A、B、C 级 / 分类都用服务端全量统计（当前时间范围），不是已加载的条数
  const stats = state.liveStats || {};
  const statsLevels = (stats.levels && typeof stats.levels === "object") ? stats.levels : lcounts;
  const statsCats = (stats.cats && typeof stats.cats === "object") ? stats.cats : counts;
  const total = (stats && typeof stats.total === "number")
    ? stats.total
    : Number(state.liveTotal || items.length);
  $("#live-levels").innerHTML =
    `<button class="chip ${state.liveLevel ? "" : "on"}" data-lv="">全部 ${total}</button>` +
    ["A", "B", "C"].map((lv) =>
      `<button class="chip lv-${lv} ${state.liveLevel === lv ? "on" : ""}" data-lv="${lv}"${
        lv === "A" && !statsLevels.A ? ' title="当前范围没有 A 级；A 级只用于重大突发"' : ""}>${lv} 级 ${Number(statsLevels[lv] || 0)}</button>`).join("");
  $$("#live-levels [data-lv]").forEach((b) => {
    b.onclick = () => {
      state.liveLevel = b.dataset.lv;
      state.liveShown = 10;
      renderLive(state.liveItems, at);
    };
  });
  const catCount = (c) => Number(statsCats[c] || 0);
  const digestN = state.digestTotal || (state.digests || []).length;
  // 「总结」放在分类标签的最后（综合右边）
  $("#live-tags").innerHTML =
    `<button class="chip ${!state.liveDigest && !state.liveFilter ? "on" : ""}" data-lcat="">全部 ${total}</button>` +
    LIVE_CATS.filter((c) => catCount(c) > 0).map((c) =>
      `<button class="chip ${state.liveFilter === c ? "on" : ""}" data-lcat="${c}">${c} ${catCount(c)}</button>`).join("") +
    `<button type="button" class="chip digest-chip ${state.liveDigest ? "on" : ""}" id="live-digest">总结${digestN ? ` ${digestN}` : ""}</button>`;
  $$("#live-tags [data-lcat]").forEach((b) => {
    b.onclick = () => {
      state.liveDigest = false;
      state.liveFilter = b.dataset.lcat;
      state.liveShown = 10;
      renderLive(state.liveItems, at);
    };
  });
  const dgBtn = $("#live-digest");
  if (dgBtn) {
    dgBtn.onclick = async () => {
      state.liveDigest = !state.liveDigest;
      if (!state.liveDigest) return renderLive(state.liveItems, at);
      if (!digestN || (state.digests || []).length < digestN) await loadDigests(true, true).catch(() => {});
      renderDigests();
    };
  }
  if (state.liveDigest) {
    renderDigests();
    return;
  }

  let list = items;
  if (state.liveLevel) list = list.filter((n) => (n.level || "C").toUpperCase() === state.liveLevel);
  if (state.liveFilter) list = list.filter((n) => n.category === state.liveFilter);
  const shown = list.slice(0, state.liveShown);
  // 先展开本地已取回的，展开完再点才向服务端翻下一页
  const localMore = list.length > shown.length;
  const moreBtn = (localMore || state.liveHasMore)
    ? `<button class="btn ghost small more-live" id="more-live">${
        localMore
          ? `查看更多（还有 ${list.length - shown.length} 条）`
          : `查看更多（已显示 ${items.length}${total > items.length ? ` / 共 ${total}` : ""} 条）`
      }</button>`
    : "";
  $("#live-list").innerHTML = list.length
    ? shown
        .map((n) => `<div class="live-item selable${n.saved ? " saved" : ""}" data-id="${n.id}">
          <div class="lt">${esc((n.published_at || "").slice(11, 16))}</div>
          <div class="lc"><span class="badge lv-${(n.level || "C").toUpperCase()}">${esc((n.level || "C").toUpperCase())}</span>${n.alert ? '<span class="badge alert">重点</span>' : ""}
            <button class="badge ${CAT_CLASS[n.category] || (n.category === "宏观" ? "policy" : "")}" data-lcat="${esc(n.category)}">${esc(n.category)}</button></div>
          <div class="lx clamp${clampOpen(n)}">${esc(n.title)}</div>
          <div class="lacts">
            <button class="lact star ${n.saved ? "on" : ""}" data-save="${n.id}" data-cur="${n.saved ? 1 : 0}">${n.saved ? ICON_STAR_ON : ICON_STAR}<span>${n.saved ? "已收藏" : "收藏"}</span></button>
            <button class="lact drop" data-drop="${n.id}">${ICON_TRASH}<span>删除</span></button>
          </div>
        </div>`)
        .join("") + moreBtn
    : `<div class="empty">${
        state.liveLevel === "A"
          ? "当前范围没有 A 级电报（财联社源站未下发 A 级；B 级＝重要）"
          : "这个分类暂时没有新闻"
      }</div>` + moreBtn;
  bindClamp($("#live-list"));
  bindCopy($("#live-list"));
  $$("#live-list [data-lcat]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      state.liveFilter = b.dataset.lcat;
      state.liveShown = 10;
      renderLive(state.liveItems, at);
    };
  });
  const more = $("#more-live");
  if (more) more.onclick = async () => {
    // 本地还有没展开的先展开，不联网
    if (list.length > state.liveShown) {
      state.liveShown += 20;
      renderLive(state.liveItems, at);
      return;
    }
    // 本地看完了，向服务端要下一页（游标 = 当前最旧一条）
    more.disabled = true;
    more.textContent = "加载中…";
    const last = (state.liveAll || [])[state.liveAll.length - 1];
    let lurl;
    if (state.liveDay) {
      lurl = `live?day=${state.liveDay}&limit=${LIVE_PAGE}`;
    } else {
      const lf = state.liveFrom || dayAdd(state.today, -6);
      const lt = state.liveTo || state.today;
      lurl = `live?start=${lf}&end=${lt}&limit=${LIVE_PAGE}`;
    }
    if (last && last.published_at) {
      lurl += `&before=${encodeURIComponent(last.published_at)}&before_id=${last.id}`;
    }
    const r = await api(lurl).catch(() => null);
    if (!r) {
      more.disabled = false;
      more.textContent = "加载失败，点击重试";
      return;
    }
    const ids = new Set((state.liveAll || []).map((x) => x.id));
    state.liveAll = [...(state.liveAll || []), ...(r.items || []).filter((x) => !ids.has(x.id))];
    state.liveHasMore = !!r.has_more;
    if (r.stats) {
      state.liveStats = r.stats;
      state.liveTotal = Number(r.stats.total || state.liveTotal);
    } else if (typeof r.total === "number") {
      state.liveTotal = r.total;
    }
    state.liveFull = true;
    state.liveShown += 20;
    renderLive(state.liveAll, at);
  };
  $$("#live-list [data-save]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.dataset.busy === "1") return;
      const id = b.dataset.save;
      const to = b.dataset.cur === "1" ? 0 : 1;
      b.dataset.busy = "1";
      b.disabled = true;
      b.classList.add("busy");
      // 先给出即时反馈，不等接口
      b.textContent = to ? "收藏中…" : "取消中…";
      try {
        await api(`news/${id}/save`, { method: "POST", body: { saved: to }, idempotent: true });
        toast(to ? "已收藏到 记录 · 新闻" : "已取消收藏");
        const item = [state.liveItems, state.liveAll]
          .map((arr) => (arr || []).find((x) => String(x.id) === id)).find(Boolean);
        markSavedEverywhere(id, to);
        if (item) setFavorite(item, to);
        // 只换这个按钮的样式，不重绘整个列表：正在展开读的新闻不会被收回去
        paintSaveBtn(b, to);
        const row = b.closest(".live-item");
        if (row) row.classList.toggle("saved", !!to);
      } catch (err) {
        toast(err.message);
        paintSaveBtn(b, to ? 0 : 1);
      }
    };
  });
  $$("#live-list [data-drop]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.dataset.busy === "1") return;
      const id = b.dataset.drop;
      b.dataset.busy = "1";
      b.disabled = true;
      b.classList.add("busy");
      b.textContent = "删除中…";
      try {
        await api(`news/${id}`, { method: "DELETE", idempotent: true });
        toast("已删除，可在回收站找回");
        forgetNews(id);
        repaintLive();
        loadFeed(true).catch(() => {});
      } catch (err) {
        toast(err.message);
        repaintLive();
      }
    };
  });
}

/* 长按 = 进入多选（复制已取消）；长按后松手的那次 click 不再重复勾选 */
function bindLongPress(box, selector, selKey, skip = "button") {
  if (!box) return;
  $$(selector, box).forEach((el) => {
    let timer = null;
    const start = (ev) => {
      if (state.sel.key) return;
      if (ev && ev.target && ev.target.closest && ev.target.closest(skip)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        state._lpAt = Date.now();
        if (state.sel.key && state.sel.key !== selKey) exitSel();
        if (state.sel.key !== selKey) enterSel(selKey);
        const c = selCfg();
        if (c && el.matches(`${c.box} ${c.item}`) && !state.sel.ids.has(elId(el, c))) toggleSel(el);
        try { if (navigator.vibrate) navigator.vibrate(18); } catch (e) { /* ignore */ }
        toast("长按进入多选");
      }, 420);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchend", cancel);
    el.addEventListener("touchmove", cancel);
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", cancel);
    el.addEventListener("mouseleave", cancel);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}
const bindCopy = (box) => bindLongPress(box, ".live-item", "live", "[data-save],[data-drop]");

/* ---- 长按复制文本 ---- */
function fallbackCopy(t) {
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function copyText(text) {
  const t = String(text || "").trim();
  if (!t) return Promise.resolve(false);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(t).then(() => true).catch(() => fallbackCopy(t));
  }
  return Promise.resolve(fallbackCopy(t));
}
/* 直接复制失败时（安卓 WebView 偶尔拒绝剪贴板权限）：弹出可选中文本框，点按钮再复制一次 */
function openCopySheet(text) {
  openSheet("复制", `<div class="field"><textarea id="cp-text" rows="6" style="width:100%;resize:vertical">${esc(text)}</textarea></div>
    <div class="sheet-actions"><button class="btn primary" id="cp-do">复制</button>
      <button class="btn ghost" data-close>关闭</button></div>`);
  const ta = $("#cp-text");
  if (ta) { ta.focus(); ta.setSelectionRange(0, ta.value.length); }
  const go = $("#cp-do");
  if (go) go.onclick = () => {
    const val = ta ? ta.value : text;
    const done = () => { closeSheet(); toast("已复制"); };
    const fail = () => {
      if (ta) { ta.focus(); ta.select(); }
      toast("长按框内文字可手动复制");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(done).catch(() => (fallbackCopy(val) ? done() : fail()));
    } else {
      if (fallbackCopy(val)) done(); else fail();
    }
  };
}
/* 记录页卡片：长按复制正文（多选入口在各分类的分段按钮上） */
function bindNoteCardCopy(box) {
  if (!box) return;
  $$(".item.note", box).forEach((el) => {
    let timer = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener("touchstart", (e) => {
      if (e.target.closest("button,a,input,textarea")) return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        state._lpAt = Date.now();
        const body = el.querySelector(".body") || el;
        const text = (body.innerText || body.textContent || "").trim();
        copyText(text).then((ok) => { if (ok) toast("已复制"); else openCopySheet(text); });
        try { navigator.vibrate && navigator.vibrate(12); } catch (err) { /* 忽略 */ }
      }, 480);
    }, { passive: true });
    ["touchend", "touchmove", "touchcancel"].forEach((ev) => el.addEventListener(ev, cancel, { passive: true }));
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  });
  // 长按松手那次别再把卡片展开/收起
  if (box.dataset.lpcopy !== "1") {
    box.dataset.lpcopy = "1";
    box.addEventListener("click", (e) => {
      if (Date.now() - (state._lpAt || 0) < 700) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }
}

/* 双击收藏实时新闻：直接把这条收藏进「记录 · 新闻」，并且保持展开（不再缩回去）。
   已经收藏过的再双击只提示，不重复写接口。 */
async function favoriteLiveNews(el) {
  const item = el.closest("[data-id]");
  if (!item) return;
  const id = String(item.dataset.id || "");
  if (!id) return;
  const n = [state.liveItems, state.liveAll, state.liveSearchItems]
    .map((arr) => (arr || []).find((x) => favId(x) === id)).find(Boolean);
  if (n && n.saved) { toast("已在收藏夹"); return; }
  const btn = item.querySelector("[data-save]");
  try {
    await api(`news/${id}/save`, { method: "POST", body: { saved: 1 }, idempotent: true });
    toast("已收藏到 记录 · 新闻");
    markSavedEverywhere(id, 1);
    if (n) setFavorite(n, 1);
    else { state.favCount = Math.max(0, (state.favCount || 0) + 1); syncFavCount(); }
    if (btn) paintSaveBtn(btn, 1);
    item.classList.add("saved");
    refreshSavedNews().catch(() => {});
  } catch (e) { toast(e.message); }
}

function bindClamp(box) {
  $$(".clamp", box).forEach((el) => {
    let lastTap = 0, collapseTimer = null;
    const liveId = () => {
      const item = el.closest("[data-id]");
      return item ? String(item.dataset.id || "") : "";
    };
    const doOpen = () => {
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
      el.classList.add("open");
      const id = liveId();
      if (id) state.liveOpen.add(id);
    };
    const doClose = () => {
      el.classList.remove("open");
      const id = liveId();
      if (id) state.liveOpen.delete(id);
    };
    el.onclick = () => {
      // 实时新闻正文：展开立即生效；收起延后 240ms（双击时不会先缩一下），
      // 420ms 内的第二击 = 收藏（进「记录 · 新闻」）并保持展开。
      if (el.classList.contains("lx")) {
        const now = Date.now();
        if (lastTap && now - lastTap < 420) {
          lastTap = 0;
          doOpen();
          favoriteLiveNews(el);
          return;
        }
        lastTap = now;
        if (el.classList.contains("open")) {
          if (collapseTimer) clearTimeout(collapseTimer);
          collapseTimer = setTimeout(() => { collapseTimer = null; doClose(); }, 240);
        } else {
          doOpen();
        }
        return;
      }
      el.classList.toggle("open");
      // 需关注：记住展开状态，轮询重建列表后仍然展开；笔记的正文不走这套。
      if (!el.closest("#news-focus")) return;
      const item = el.closest("[data-id]");
      if (!item) return;
      const id = String(item.dataset.id || "");
      if (!id) return;
      if (el.classList.contains("open")) state.liveOpen.add(id);
      else state.liveOpen.delete(id);
    };
  });
}

/* 新闻刷新（按钮已删，改成点「新闻」选项卡时触发）：先向上游拉一次，再重画 */
async function pullLiveNews() {
  const r = await api("live/refresh", { method: "POST" }).catch(() => null);
  if (r) renderLive(r.items || [], r.updated_at);
  _memo.delete("feed");
  await loadFeed(true).catch(() => {});
  if (r) toast(r.added ? `已刷新 · 新增 ${r.added} 条` : "已刷新 · 已是最新");
}

/* 需关注：手动添加一条（source='manual'，与报告抽取并存，不会被收藏夹影响） */
function openFocusAdd() {
  const day = state.today || "";
  openSheet("添加到需关注", `
    <div class="field"><label>要关注的内容</label>
      <textarea id="fa-title" rows="3" maxlength="500" placeholder="例如：关注英伟达财报后的算力链反应"></textarea></div>
    <div class="field"><label>备注（可选）</label>
      <textarea id="fa-body" rows="2" maxlength="500" placeholder="为什么关注、看什么信号"></textarea></div>
    <div class="field"><label>日期</label>
      <input id="fa-day" type="date" value="${esc(day)}"></div>
    <div class="sheet-actions"><button class="btn primary" id="fa-save">加入需关注</button></div>
  `);
  const save = $("#fa-save");
  save.onclick = async () => {
    const title = ($("#fa-title").value || "").trim();
    if (!title) { toast("先写要关注的内容"); $("#fa-title").focus(); return; }
    const pickDay = $("#fa-day").value || state.today;
    save.disabled = true;
    save.textContent = "添加中…";
    try {
      await api("news", { method: "POST", body: {
        day: pickDay, category: "关注", title,
        body: $("#fa-body").value.trim(), source: "manual",
      } });
      closeSheet();
      toast("已加入需关注");
      await loadFeed(true).catch(() => {});
    } catch (e) {
      toast(e.message);
      save.disabled = false;
      save.textContent = "加入需关注";
    }
  };
}
if ($("#btn-focus-add")) $("#btn-focus-add").addEventListener("click", openFocusAdd);

/* ---------- 报告（最新 + 往期，一个入口） ---------- */
async function openReport(rid) {
  const list = await api("reports").catch(() => []);
  state.reportList = list || [];
  const latest = rid
    ? await api(`reports/${rid}`).catch(() => null)
    : (state.report && state.report.id ? state.report : (list[0] ? await api(`reports/${list[0].id}`).catch(() => null) : null));
  if (!latest) {
    openSheet("报告", `<div class="empty">暂无报告</div>`);
    return;
  }
  const unread = !rid && state.report && state.report.id === latest.id && !state.reportRead;
  const meta = `${REPORT_KIND[latest.kind] || "报告"} · ${latest.day ? latest.day.slice(5) : ""} · ${num(String(latest.content || "").length / 1000, 1)}k 字`;
  openSheet(latest.title || "报告", `
    <div class="rep-bar">
      <div class="rep-meta tiny muted">${esc(meta)}${unread ? ' · <b class="up">未读</b>' : ""}</div>
      <div class="rep-acts">
        <button class="btn ghost small" id="rep-hist-btn">往期</button>
        ${unread ? '<button class="btn primary small" id="rep-read">已读</button>' : ""}
      </div>
    </div>
    <article class="report-body rep-body">${reportCards(latest.content || "")}</article>`);
  $("#rep-hist-btn").onclick = openReportHistory;
  const rb = $("#rep-read");
  if (rb) rb.onclick = async () => {
    try {
      await api(`reports/${latest.id}/read`, { method: "POST" });
      toast("已读");
      await loadFeed(true).catch(() => {});
      openReport(latest.id);
    } catch (e) { toast(e.message); }
  };
}

/* 往期：弹层里单独一页，从「报告」页右上角「往期」进入 */
function openReportHistory() {
  const list = state.reportList || [];
  openSheet("往期报告", list.length
    ? `<div class="list">${list.map((r) => `<div class="item r-item" data-rid="${r.id}">
        <div><div class="d">${esc((r.day || "").slice(5))}</div>
        <div class="k">${r.kind === "pre" ? "盘前简报" : r.kind === "mid" ? "午间速报" : "盘后复盘"}</div></div>
        <div class="arrow">›</div></div>`).join("")}</div>`
    : `<div class="empty">暂无往期报告</div>`);
  $$("#sheet [data-rid]").forEach((el) => {
    el.onclick = () => openReport(Number(el.dataset.rid));
  });
}

/* 顶栏第一个图标：原来的「报告」已经没有内容源，改成直达「大盘分析」 */
const reportBtn = $("#btn-report");
if (reportBtn) reportBtn.addEventListener("click", () => {
  if (state.view !== "hold") setView("hold");
  activateView("hold");
  setMktTab("analysis");
  setHoldTab("market");
  refreshPane("analysis");
});

/* 顶栏「更多」：回收站 / 退出登录 收进弹层，避免顶栏挤 6 个图标 */
$("#btn-more").addEventListener("click", () => {
  openSheet("更多", `<div class="more-list">
    <button type="button" class="more-hr" id="more-hr-card">
      <span class="more-hr-l"><em class="more-hr-v" id="more-hr-bpm">—</em><i class="more-hr-z" id="more-hr-zone">未接入</i></span>
      <svg class="more-hr-wave" viewBox="0 0 320 44" preserveAspectRatio="none" aria-hidden="true"><path id="more-hr-path" d=""/></svg>
      <span class="more-hr-f" id="more-hr-foot">手表蓝牙 · 每秒一个点</span>
    </button>
    <button type="button" class="more-row" id="more-trash">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 12.2A2 2 0 0 0 9.4 21h5.2a2 2 0 0 0 2-1.8L17.5 7"/><path d="M10 11v6M14 11v6"/></svg>
      <span>回收站</span><span class="more-sub">${state.trashDays || 7} 天内删除的内容</span></button>
    <button type="button" class="more-row" id="more-alerts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.4 9.2a5.6 5.6 0 0 1 11.2 0c0 4.2 1.4 5.6 1.4 5.6H5s1.4-1.4 1.4-5.6"/><path d="M9.8 18.4a2.4 2.4 0 0 0 4.4 0"/></svg>
      <span>提醒中心</span><span class="more-sub" id="more-alerts-sub">价格 / 涨跌幅提醒</span></button>
    <button type="button" class="more-row" id="more-ring">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.4 2.1"/></svg>
      <span>到点提醒</span><span class="more-sub" id="more-ring-sub">铃声与权限</span></button>
    <button type="button" class="more-row" id="more-marks">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 19.8l.9-4L15.8 5.1a2.4 2.4 0 0 1 3.4 3.4L8.4 18.9z"/><path d="M14.4 6.6l3 3"/></svg>
      <span>批注</span><span class="more-sub" id="more-marks-sub">按天记，和数据总览连着</span></button>
    <button type="button" class="more-row" id="more-health">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h4l2.4-6 4 12 2.2-6H21"/></svg>
      <span>数据健康</span><span class="more-sub" id="more-health-sub">行情源与 K 线巡检</span></button>
    <button type="button" class="more-row" id="more-khealth">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 12h4l2.4-6 3.6 12 2.4-6h4.4"/></svg>
      <span>K线自检</span><span class="more-sub" id="more-khealth-sub">数据源与各周期可用性</span></button>
    <button type="button" class="more-row" id="more-errlog">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8 3.8 20.2h16.4z"/><path d="M12 9.4v4.2M12 17v.1"/></svg>
      <span>最近错误</span><span class="more-sub" id="more-errlog-sub">${errLogRead().length ? `${errLogRead().length} 条` : "没有异常"}</span></button>
    <button type="button" class="more-row" id="more-ai">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6l1.7 4.3L18 9.6l-4.3 1.7L12 15.6l-1.7-4.3L6 9.6l4.3-1.7z"/></svg>
      <span>AI 助手</span><span class="more-sub" id="more-ai-sub">DeepSeek · 未配置</span></button>
    <button type="button" class="more-row" id="more-awake">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 4.6v1.6M12 17.8v1.6M4.6 12h1.6M17.8 12h1.6M6.9 6.9l1.1 1.1M16 16l1.1 1.1M17.1 6.9l-1.1 1.1M8 16l-1.1 1.1"/></svg>
      <span>待机常亮</span><span class="more-sub" id="more-awake-sub">呼吸点 · 3 秒一次</span>
      <em class="wk-swd" id="more-awake-sw"></em></button>
    <button type="button" class="more-row" id="more-ver">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8 4.6 7.4v5.2c0 4.2 3.1 6.9 7.4 8 4.3-1.1 7.4-3.8 7.4-8V7.4z"/><path d="M9.4 12.2l1.9 1.9 3.5-3.6"/></svg>
      <span>版本</span><span class="more-sub" data-ver-sub>—</span></button>
    <button type="button" class="more-row" id="more-theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.7"/><path d="M12 3.4v2.3M12 18.3v2.3M3.4 12h2.3M18.3 12h2.3M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6"/></svg>
      <span>外观</span><span class="more-sub" id="more-theme-sub">${themeLabelNow()}</span></button>
    <button type="button" class="more-row" id="more-glass">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="6.8" width="11.4" height="11.4" rx="3.2"/><path d="M8.2 6.8V5.6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-1.2"/></svg>
      <span>玻璃质感</span><span class="more-sub" id="more-glass-sub">${window.GLASS ? GLASS.name[GLASS.get()] : "标准"}</span></button>
    <button type="button" class="more-row" id="more-password">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7.2" cy="12" r="3.2"/><path d="M10.4 12h9.6M17 12v3.2M20 12v2.2"/></svg>
      <span>修改密码</span><span class="more-sub">需要先验证原密码</span></button>
    <button type="button" class="more-row danger" id="more-logout">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 3.5v8"/><path d="M7.1 6.5a7.5 7.5 0 1 0 9.8 0"/></svg>
      <span>退出登录</span><span class="more-sub">需要重新输入访问密码</span></button>
  </div>`);
  paintVerTags().catch(() => {});
  $("#more-trash").onclick = () => { closeSheet(); $("#trash").click(); };
  const aiBtn = $("#more-ai");
  if (aiBtn) aiBtn.onclick = () => { closeSheet(); openAiCfg(); };
  api("ai/config", { noRetry: true }, 8000).then((d) => {
    const sub = $("#more-ai-sub");
    if (sub && d) sub.textContent = d.configured ? `DeepSeek · 已配置 ${d.hint}` : "DeepSeek · 未配置";
  }).catch(() => {});
  const awBtn = $("#more-awake");
  if (awBtn) {
    const sw = $("#more-awake-sw");
    const paint = () => {
      const on = (typeof sbAwakeOn === "function") ? sbAwakeOn() : true;
      if (sw) sw.classList.toggle("on", on);
    };
    paint();
    awBtn.onclick = () => {
      const on = !((typeof sbAwakeOn === "function") ? sbAwakeOn() : true);
      if (typeof sbAwakeSet === "function") sbAwakeSet(on);
      paint();
    };
  }
  const hrCard = $("#more-hr-card");
  if (hrCard) {
    hrCard.onclick = () => openHrSheet();
    paintMoreHr();
    const timer = setInterval(() => {
      if (!document.getElementById("more-hr-card")) { clearInterval(timer); return; }
      paintMoreHr();
    }, 1000);
  }
  const verBtn = $("#more-ver");
  if (verBtn) verBtn.onclick = () => openVerSheet();
  const thBtn = $("#more-theme");
  if (thBtn) thBtn.onclick = () => { closeSheet(); openThemeSheet(); };
  const glBtn = $("#more-glass");
  if (glBtn) glBtn.onclick = () => { closeSheet(); openGlassSheet(); };
  const pwBtn = $("#more-password");
  if (pwBtn) pwBtn.onclick = () => { closeSheet(); openPasswordSheet(); };
  $("#more-logout").onclick = () => { $("#logout").click(); };
  const ringBtn = $("#more-ring");
  if (ringBtn) ringBtn.onclick = () => { if (typeof openWkRemindSettings === "function") openWkRemindSettings(); };
  const alBtn = $("#more-alerts");
  if (alBtn) alBtn.onclick = () => openAlertCenter();
  api("price-alerts", { noRetry: true }, 10000).then((d) => {
    const sub = $("#more-alerts-sub");
    if (!sub || !d) return;
    const n = (d.active || []).length, u = d.unread || 0;
    sub.textContent = n ? `${n} 条在用${u ? ` · ${u} 条新触发` : ""}` : "还没有设置提醒";
  }).catch(() => {});
  const mkBtn = $("#more-marks");
  if (mkBtn) mkBtn.onclick = () => { closeSheet(); if (typeof openMarkList === "function") openMarkList(); };
  const hBtn = $("#more-health");
  if (hBtn) hBtn.onclick = () => openDataHealthSheet();
  const khBtn = $("#more-khealth");
  if (khBtn) khBtn.onclick = () => openKlineHealthSheet();
  const errBtn = $("#more-errlog");
  if (errBtn) errBtn.onclick = () => openErrLogSheet();
  // 顺手把最近一次巡检结论写在副标题上，免得点进去才发现还是空的
  api("kline/health", { noRetry: true }, 10000)
    .then((d) => {
      const sub = $("#more-khealth-sub");
      if (!sub || !d) return;
      sub.textContent = d.checks ? `${d.ok}/${d.checks} 项正常 · ${String(d.generated_at || "").slice(5, 16)}`
        : "最近一次巡检结果";
    })
    .catch(() => {});
});

/* ---------- 版本：本地已加载 vs 服务器最新 ---------- */
/* ---------- 正在播放：壳镜像系统「音乐」App，我们只画界面 ----------
   壳每秒推一次元数据（window.sbMusic），换歌时单独推封面（window.sbMusicArt）。
   歌名/艺人有了以后，封面缺就用 /api/v1/cover 兜底，歌词走 /api/v1/lyric（QQ 源 + 本机缓存）。 */
function muState() { return state.music || {}; }

function muFmt(sec) {
  const v = Math.max(0, Number(sec) || 0);
  const m = Math.floor(v / 60), s2 = Math.floor(v % 60);
  return `${m}:${s2 < 10 ? "0" : ""}${s2}`;
}

function muKey(o) { return String((o && (o.artKey || o.title)) || ""); }

/* 壳里只认 {cmd:"music", act}：start/stop 是开关镜像，其余是遥控 */
function muSend(act, value) {
  const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative;
  if (!h) return;
  try { h.postMessage(Object.assign({ cmd: "music", act }, value != null ? { value } : {})); } catch (e) {}
}

var MU_ICON = {
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.5 5v14"/><path d="M18.5 6.2 9.6 12l8.9 5.8z" fill="currentColor" stroke="none"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M17.5 5v14"/><path d="M5.5 6.2 14.4 12 5.5 17.8z" fill="currentColor" stroke="none"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.2 5.4 19 12 8.2 18.6z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7.6" y="5.6" width="3" height="12.8" rx="1.1"/><rect x="13.4" y="5.6" width="3" height="12.8" rx="1.1"/></svg>'
};

/* 本机播放时钟：壳每秒推一次 elapsed（MPNowPlayingInfoCenter 给的也是量化值），
   两次推送之间在本地连续外推；每次推送只做小幅校正，量化误差不会让歌词往回跳。
   误差超过 0.45s 视为换歌或拖动进度，直接对齐。
   这里必须用 Date.now()，不能用 performance.now()：iOS 切后台会把
   performance.now() 冻住，回来时歌词就会少掉后台那段时间。 */
var MU_CLK = { t: 0, wall: 0, valid: false, seekAt: 0 };

function muClockNow() {
  const m = (typeof muState === "function" ? muState() : state.music) || {};
  if (!MU_CLK.valid) return Number(m.elapsed) || 0;
  const live = m.state === "playing";
  return Math.max(0, MU_CLK.t + (live ? (Date.now() - MU_CLK.wall) / 1000 : 0));
}

function muClockSeek(t) {
  MU_CLK.t = Math.max(0, Number(t) || 0);
  MU_CLK.wall = Date.now();
  MU_CLK.valid = true;
  MU_CLK.seekAt = Date.now();
}

window.sbMusic = function (o) {
  if (!o || typeof o !== "object") return;
  const el = Number(o.elapsed) || 0;
  /* seek 后壳的 currentPlaybackTime 可能还没生效，紧接着那一拍会推回旧位置。
     1.5 秒内、和本地新位置差很多的那一推只当元数据，不用它校正时钟，
     否则歌词会被拉回 seek 前。 */
  const seekGuard = MU_CLK.valid && MU_CLK.seekAt && Date.now() - MU_CLK.seekAt < 1500;
  const staleAfterSeek = seekGuard && o.state === "playing" && Math.abs(el - muClockNow()) > 1.2;
  if (!staleAfterSeek) {
    if (MU_CLK.valid) {
      const pred = muClockNow();
      const err = el - pred;
      MU_CLK.t = (o.state === "playing" && Math.abs(err) <= 0.45) ? pred + err * 0.35 : el;
    } else {
      MU_CLK.t = el;
    }
    MU_CLK.seekAt = 0;
  }
  MU_CLK.wall = Date.now();
  MU_CLK.valid = true;
  state.music = o;
  if (typeof sbMuPaint === "function") sbMuPaint();
};

window.sbMusicArt = function (key, url) {
  state.musicArt = { key: String(key || ""), url: url || "" };
  if (typeof sbMuPaint === "function") sbMuPaint();
};

function lrcParse(text) {
  const out = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const s = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!tags.length || !s) return;
    tags.forEach((t) => out.push({ t: Number(t[1]) * 60 + Number(t[2]), s }));
  });
  // 制作名单（作词 : 某某 / 制作统筹：某某）不当歌词显示。
  // 之前只在「40 秒内 + 行首没空格」才过滤，所以 [00:00.00] 作词 : 赵英俊 这种带空格的全漏进来。
  // 冒号左边那一小段才是「角色」，不能只看行首：像「混音/母带棚：2496 Studio」这种
  // 中间带斜杠的，整串匹配永远匹配不上。先把角色串里的空格/斜杠干掉再看关键词。
  const CREDIT_WORDS = ["作词", "作曲", "编曲", "制作人", "制作统筹", "制作", "统筹", "企划", "策划",
    "监制", "总监", "出品人", "出品方", "出品", "发行公司", "发行", "母带", "混音", "录音棚", "录音",
    "和声", "和音", "吉他", "贝斯", "鼓手", "鼓", "弦乐", "键盘", "配唱", "监唱", "经纪", "宣发",
    "推广", "版权", "鸣谢", "感谢", "美术", "设计", "摄影", "视觉", "OP", "SP",
    "演唱", "歌手", "专辑", "封面", "后期", "混音师", "编配", "监棚", "策划人"];
  const isCredit = (line) => {
    const cut = line.split(/[:：]/);
    if (cut.length < 2) return false;
    const label = cut[0].replace(/[\s/／·、\-_.()（）]/g, "");
    if (!label || label.length > 14) return false;
    if (["词", "曲", "词曲", "演唱", "原唱"].indexOf(label) >= 0) return true;
    if (/[\d]/.test(label)) return false;                     // 「他说 2024：」这种不是名单
    return CREDIT_WORDS.some((w) => label.includes(w));
  };
  const sorted = out.sort((a, b) => a.t - b.t);
  const body = sorted.filter((e) => !isCredit(e.s));
  return body.length ? body : sorted;
}

function muFetchCover(m) {
  if (!m.title) return;
  const key = muKey(m);
  // 失败过也别永久放弃：隔 20 秒允许再试一次（QQ 那边偶发超时很常见）
  const now = Date.now();
  if (state.coverBusy === key && !(state.coverAt && now - state.coverAt > 20000)) return;
  state.coverBusy = key;
  state.coverAt = now;
  const q = `cover?title=${encodeURIComponent(m.title)}&artist=${encodeURIComponent(m.artist || "")}&dur=${Math.round(Number(m.dur) || 0)}`;
  api(q, { noRetry: true }, 9000).then((d) => {
    if (d && d.ok && d.url) {
      state.coverBusy = "";
      state.musicArt = { key, url: d.url };
      if (typeof sbMuPaint === "function") sbMuPaint();
    }
  }).catch(() => {});
}

function muFetchLyric(m) {
  if (!m.title) return;
  const key = muKey(m);
  if (state.lyricKey === key) return;
  state.lyricKey = key;
  const q = `lyric?title=${encodeURIComponent(m.title)}&artist=${encodeURIComponent(m.artist || "")}&dur=${Math.round(Number(m.dur) || 0)}`;
  api(q, { noRetry: true }, 12000).then((d) => {
    state.lyric = (d && d.ok && d.hit) ? { key, entries: lrcParse(d.lrc), msg: "" }
      : { key, entries: [], msg: (d && d.error) || "没匹配到歌词" };
    if (typeof sbMuPaint === "function") sbMuPaint();
  }).catch(() => {
    state.lyric = { key, entries: [], msg: "歌词接口取不到" };
    if (typeof sbMuPaint === "function") sbMuPaint();
  });
}

/* 心率接入：App 里两条来源——
   ① 蓝牙（首选）：手表跑「心率广播」这种 App 开手表模式，手表就是标准 BLE 心率外设，
      壳里的 BleHeart 启动即扫 0x180D/0x2A37，连上就 1Hz 推 window.sbHrSample；
   ② 快捷指令：没装广播 App 时，用「获取健康样本」+「获取 URL 内容」POST 上来。
   两条都不通就不画波形，只显示「未接入」。 */
/* 「更多」里的心率卡：大数字 + 区间 + 迷你曲线 + 近 15 分钟峰/均。
   没有新样本就把数字压灰，不画假波形。 */
function paintMoreHr() {
  const card = document.getElementById("more-hr-card");
  if (!card) return;
  const st = (typeof sbState === "function") ? sbState() : null;
  const now = Date.now();
  const list = (st && st.hr ? st.hr : []).filter((x) => now - x.t < 15 * 60 * 1000);
  const last = list.length ? list[list.length - 1] : null;
  const fresh = last && now - last.t < 120 * 1000;
  const bpm = document.getElementById("more-hr-bpm");
  const zone = document.getElementById("more-hr-zone");
  const path = document.getElementById("more-hr-path");
  const foot = document.getElementById("more-hr-foot");
  if (bpm) bpm.textContent = last ? String(Math.round(last.v)) : "—";
  card.classList.toggle("idle", !fresh);
  if (path) path.setAttribute("d", list.length ? sbHrPath(list.slice(-48), 320, 44, 3) : "");
  const idx = last && fresh && typeof sbHrZoneIdx === "function" ? sbHrZoneIdx(last.v) : -1;
  const z = idx >= 0 ? SB_HR_ZONES[idx] : null;
  if (zone) {
    zone.textContent = z ? z.name : (last ? "已停" : "未接入");
    zone.style.color = z ? z.color : "";
  }
  if (foot) {
    if (!list.length) foot.textContent = "手表蓝牙 · 每秒一个点";
    else {
      const peak = Math.round(Math.max(...list.map((x) => x.v)));
      const avg = Math.round(list.reduce((a, x) => a + x.v, 0) / list.length);
      foot.textContent = `${hrAgo(last.t)} · 峰 ${peak} · 均 ${avg}`;
    }
  }
}

function hrAgo(ms) {
  if (!ms) return "";
  const d = (Date.now() - ms) / 1000;
  if (d < 3) return "刚收到";
  if (d < 60) return Math.round(d) + " 秒前收到";
  if (d < 3600) return Math.round(d / 60) + " 分钟前收到";
  return "很久没收到";
}

function openHrSheet() {
  const s = (typeof sbState === "function") ? sbState() : null;
  const last = s && s.hr && s.hr.length ? s.hr[s.hr.length - 1] : null;
  const status = last
    ? `蓝牙 · ${hrAgo(last.t)} ${last.v} BPM`
    : "还没收到心率 · 手表广播打开后几秒内会自己连上";
  openSheet("心率接入", `<div class="hr-help">
    <p>待机和体能训练页的心率有两条来源，任意一条通了就实时画，全断就停在「未接入」。</p>
    <div class="hr-step"><b>1</b><span><em>蓝牙（推荐）</em>：手表上装一个会广播心率的 App（例如「心率广播」），广播方式选<em>手表</em>。本 App 启动就开始扫，连上后 1 秒一个点，不用任何捷径。</span></div>
    <div class="hr-step"><b>2</b><span><em>快捷指令（备用）</em>：手表 App 装不了时用——新建「获取健康样本」（心率，最近 1 条），接「获取 URL 内容」：方法 POST、请求体 <code>{"bpm": 心率}</code>，地址用下面这段；自动化里挂到体能训练开始时跑。</span></div>
    <div class="hr-url" id="hr-url">读取中…</div>
    <button type="button" class="hr-copy" id="hr-copy">复制地址</button>
    <p class="hr-tip">当前状态：${esc(status)}。没有数据时不画假波形。</p>
  </div>`);
  const box = $("#hr-url");
  const btn = $("#hr-copy");
  api("hr/link", { noRetry: true }, 8000).then((d) => {
    if (!d || !d.ok || !box) return;
    let url = d.url;
    try { url = new URL(d.path || d.url, location.href).href; } catch (e) {}
    box.textContent = url;
    if (btn) btn.onclick = () => {
      const t = url;
      const done = () => { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制地址"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => {});
      else {
        const ta = document.createElement("textarea");
        ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        ta.remove();
      }
    };
  }).catch(() => { if (box) box.textContent = "读取失败，稍后再试"; });
}

function openVerSheet() {
  const local = localVerTokens();
  const row = (k, a, b) => `<div class="wk-kvr"><span>${k}</span><b>${b ? b : "—"}</b></div>`;
  openSheet("版本", `<div class="wk-form">
    <div class="wk-kvs" id="ver-kvs">
      ${row("脚本 · 本地", "", verShort(local.app))}
      ${row("样式 · 本地", "", verShort(local.style))}
    </div>
    <div class="wk-tip">页面用的是本地这一版，括号外是服务器上的最新版；不一致时会自动刷新。</div>
    <div class="sheet-actions"><button class="btn primary" id="ver-reload">刷新到最新</button></div>
  </div>`);
  const kvs = $("#ver-kvs");
  serverVerTokens().then((d) => {
    if (!kvs || !d) return;
    kvs.innerHTML = row("脚本", "", verShort(local.app)) + row("脚本 · 服务器", "", verShort(d.app))
      + row("样式", "", verShort(local.style)) + row("样式 · 服务器", "", verShort(d.style));
  }).catch(() => {});
  $("#ver-reload").onclick = () => reloadFresh();
}

/* ---------- 最近错误：本机环形缓冲，最近 20 条 ---------- */
function fmtErrTime(t) {
  try {
    return new Date(Number(t) || 0).toLocaleString("zh-CN", { hour12: false }).slice(5, 16);
  } catch { return ""; }
}
function openErrLogSheet() {
  const rows = errLogRead();
  const list = rows.length
    ? `<div class="wk-typelist">${rows.map((r) => `<div class="wk-typerow">
        <span class="wk-tn">${esc(r.tag)}</span><span class="wk-tc">${esc(fmtErrTime(r.t))}${Number(r.n) > 1 ? ` · ${Number(r.n)} 次` : ""}</span>
      </div><div class="tiny muted" style="margin:-4px 2px 10px;line-height:1.5;word-break:break-all">${esc(r.msg)}</div>`).join("")}</div>`
    : `<div class="wk-tip">没有记录到错误。这里只保留最近 20 条，存在本机，不上传。</div>`;
  openSheet("最近错误", `<div class="wk-form">${list}
    <div class="sheet-actions"><button class="btn ghost" id="errlog-clear">清空记录</button><button class="btn ghost" data-close>关闭</button></div>
  </div>`);
  const c = $("#errlog-clear");
  if (c) c.onclick = () => {
    try { localStorage.removeItem(ERR_LOG_KEY); } catch { /* 清不掉也不报错 */ }
    closeSheet();
    toast("已清空");
  };
}

/* ---------- 今日看板补充：提醒 / 绩效 / 详情附加 ---------- */
const ALERT_KIND_LABEL = { up: "涨到", down: "跌到", pct: "涨跌幅超" };

function detailNotesHtml() {
  return `<div class="sq-notes-wrap">
    <div class="sq-n-head"><span>这只标的的记录</span><button type="button" class="sq-n-add" id="sq-add-note">记一条</button></div>
    <div id="sq-notes"><div class="sq-n-empty">读取中…</div></div>
  </div>`;
}

async function mountDetailExtra(code, name) {
  const kl = $("#sq-kl");
  if (kl) {
    try {
      const k = await api(`keylevels?code=${code}`, { noRetry: true }, 10000);
      if (k && k.ok) {
        const signed = (v, unit) => (v === null || v === undefined ? "—" : (Number(v) > 0 ? "+" : "") + num(v, 2) + unit);
        kl.innerHTML = [["距MA20", signed(k.dist_ma20, "%"), k.dist_ma20], ["MA20斜率", signed(k.ma20_slope, "%"), k.ma20_slope],
                        ["20日高", num(k.hi20, 3), null], ["20日低", num(k.lo20, 3), null]]
          .map(([label, val, pctv]) => `<div class="kl-cell"><span class="kl-k">${label}</span><b class="${pctv === null ? "" : cls(pctv)}">${val}</b></div>`).join("")
          + `<div class="kl-cell"><span class="kl-k">连涨</span><b>${k.streak ? k.streak + " 天" : "—"}</b></div>`;
      } else kl.remove();
    } catch (e) { /* 关键位拿不到就不占位 */ }
  }
  const nb = $("#sq-notes");
  if (nb) {
    try {
      const d = await api(`notes?code=${code}`, { noRetry: true }, 10000);
      const items = ((d && d.items) || []).slice(0, 3);
      nb.innerHTML = items.length
        ? items.map((n) => `<div class="sq-n-row"><span class="sq-n-t">${esc(String(n.created_at || "").slice(5, 10))}</span>
            <span class="sq-n-b">${esc(String(n.content || "").slice(0, 60))}</span></div>`).join("")
        : `<div class="sq-n-empty">还没有记录，写下第一条</div>`;
    } catch (e) { nb.innerHTML = `<div class="sq-n-empty">记录读取失败</div>`; }
  }
  const add = $("#sq-add-note");
  if (add) add.onclick = () => {
    state.noteStock = code;
    state.noteKind = "";
    closeSheet();
    requestAnimationFrame(() => { try { $("#btn-notes").click(); } catch (e) {} });
  };
  const al = $("#sq-alert");
  if (al) al.onclick = () => openAlertSheet(code, name);
}

function paintAlertDot(n) {
  const btn = $("#btn-more");
  if (!btn) return;
  let dot = btn.querySelector(".more-dot");
  if (!n) { if (dot) dot.remove(); return; }
  if (!dot) { dot = document.createElement("i"); dot.className = "more-dot"; btn.appendChild(dot); }
}

async function checkAlerts(silent) {
  try {
    const d = await api("price-alerts/check", { noRetry: true }, 12000);
    const evs = (d && d.events) || [];
    if (evs.length) {
      if (!silent) {
        const ev = evs[0];
        toast(`${ev.name || ev.code} ${ALERT_KIND_LABEL[ev.kind] || ""} 已触发`);
      }
      paintAlertDot(evs.length);
    }
  } catch (e) { /* 提醒检查失败不打扰 */ }
}
setInterval(() => {
  if (document.visibilityState === "visible" && state.view !== "login") checkAlerts(false);
}, 60000);

/* 三档提醒：涨到 / 跌到 / 日涨跌幅超。留空＝关掉该档。 */
async function openAlertSheet(code, name) {
  const cur = (() => { const x = (state.board.stocks || []).find((s) => s.code === code); return x ? Number(x.price) : null; })();
  const ph = (v) => (v ? String(v) : "");
  openSheet(`${esc(name) || code} · 提醒`, `<div class="al-form">
    <div class="al-row"><label>涨到（元）</label><input id="al-up" type="number" step="0.001" inputmode="decimal" placeholder="${ph(cur)}"></div>
    <div class="al-row"><label>跌到（元）</label><input id="al-down" type="number" step="0.001" inputmode="decimal" placeholder="${ph(cur)}"></div>
    <div class="al-row"><label>日涨跌幅超（%）</label><input id="al-pct" type="number" step="0.1" inputmode="decimal" placeholder="5"></div>
    <div class="al-note">触发后进「提醒中心」，只在 App 内提示，不推系统通知；条件没回落之前不重复提醒，同一条件最短 30 分钟一次。</div>
    <div class="sheet-actions"><button class="btn primary" id="al-save">保存</button><button class="btn ghost" data-close>取消</button></div>
  </div>`);
  let d = null;
  try { d = await api("price-alerts", { noRetry: true }, 10000); } catch (e) { d = null; }
  const mine = (((d && d.active) || [])).filter((a) => String(a.code) === String(code));
  mine.forEach((a) => { const el = $("#al-" + a.kind); if (el) el.value = a.value; });
  $("#al-save").onclick = async () => {
    const btn = $("#al-save");
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      for (const kind of ["up", "down", "pct"]) {
        const el = $("#al-" + kind);
        const raw = el ? String(el.value || "").trim() : "";
        const exists = mine.find((a) => a.kind === kind);
        if (!raw) {
          if (exists) await api(`price-alerts/${exists.id}`, { method: "DELETE", idempotent: true });
        } else {
          const v = Number(raw);
          if (!Number.isFinite(v) || v <= 0) throw new Error("提醒值要大于 0");
          await api("price-alerts", { method: "POST", body: { code, name, kind, value: v } });
        }
      }
      closeSheet();
      toast("提醒已保存");
      checkAlerts(true).catch(() => {});
    } catch (e) {
      toast(e.message || "保存失败");
      btn.disabled = false;
      btn.textContent = "保存";
    }
  };
}

/* 提醒中心：触发记录 + 在用的提醒，可删除 */
async function openAlertCenter() {
  openSheet("提醒中心", `<div class="empty">读取中…</div>`);
  let d = null, cal = null;
  try { d = await api("price-alerts", { noRetry: true }, 10000); } catch (e) { d = null; }
  try { cal = await api("calendar?days=60", { noRetry: true }, 10000); } catch (e) { cal = null; }
  if (!d) { openSheet("提醒中心", `<div class="empty">暂不可用，稍后再试</div>`); return; }
  const evs = d.events || [];
  const act = d.active || [];
  const row = (a) => `<div class="al-live-row">
      <div class="al-l"><b>${esc(a.name || a.code)}</b><span class="al-s">${esc(ALERT_KIND_LABEL[a.kind] || a.kind)} ${num(a.value, 3)}</span></div>
      <button type="button" class="al-del" data-del="${a.id}">删除</button></div>`;
  const evRow = (e) => `<div class="al-ev-row">
      <span class="al-ev-t">${esc(String(e.fired_at || "").slice(5, 16))}</span>
      <span class="al-ev-b">${esc(e.name || e.code)} ${esc(ALERT_KIND_LABEL[e.kind] || e.kind)} ${num(e.value, 3)}</span>
      <span class="al-ev-p">现价 ${num(e.price, 3)}</span></div>`;
  const calRows = [];
  const dcaRows = [];
  if (cal && cal.dca && (cal.dca.count || 0) > 0) {
    const days = (cal.dca.days || []).filter((x) => x.trading);
    days.forEach((x) => dcaRows.push(`<div class="al-ev-row">
        <span class="al-ev-t">${esc(String(x.date).slice(5))} ${esc(x.weekday)}</span>
        <span class="al-ev-b">定投扣款 ${x.count} 只</span>
        <span class="al-ev-p">¥${num(x.total, 2)}</span></div>`));
  }
  const evList = (cal && cal.events) || [];
  const evRowHtml = (e) => `<div class="al-ev-row">
      <span class="al-ev-t">${esc(String(e.date).slice(5))}</span>
      <span class="al-ev-b">${esc(e.name || e.code)} ${esc(e.title || (e.kind === "report" ? "财报" : "除权"))}</span>
      <span class="al-ev-p">${esc(e.kind === "report" ? "财报" : "除权")}</span></div>`;
  /* 每块先给 3 条，其余折起来点一下展开：这页是「扫一眼」，不是台账 */
  const AL_FOLD = 3;
  const fold = (items, key) => {
    if (!items.length) return "";
    const shown = items.slice(0, AL_FOLD).join("");
    const n = items.length - AL_FOLD;
    return shown + (n > 0 ? `<button type="button" class="al-more" data-almore="${key}">还有 ${n} 条</button>` : "");
  };
  const foldRest = (items, key) => {
    const rest = items.slice(AL_FOLD);
    return rest.length ? `<div class="al-rest hidden" data-alrest="${key}">${rest.join("")}</div>` : "";
  };
  const repRows = evList.filter((e) => e.kind === "report").map(evRowHtml);
  const divRows = evList.filter((e) => e.kind === "dividend").map(evRowHtml);
  calRows.push(fold(dcaRows, "dca"), foldRest(dcaRows, "dca"));
  if (repRows.length) calRows.push(`<div class="al-ev-sub">财报</div>`, fold(repRows, "rep"), foldRest(repRows, "rep"));
  if (divRows.length) calRows.push(`<div class="al-ev-sub">除权</div>`, fold(divRows, "div"), foldRest(divRows, "div"));
  const evRows = evs.map(evRow);
  const actRows = act.map(row);
  openSheet("提醒中心", `<div class="al-center">
      <div class="al-sec">即将发生</div>
      ${calRows.join("") ? calRows.join("") : `<div class="al-empty">未来两周没有定投扣款或财报/除权事件。</div>`}
      <div class="al-sec">最近触发</div>
      ${evRows.length ? fold(evRows, "ev") + foldRest(evRows, "ev") : `<div class="al-empty">还没有触发过。设了提醒就会出现在这里。</div>`}
      <div class="al-sec">在用的提醒</div>
      ${actRows.length ? fold(actRows, "act") + foldRest(actRows, "act") : `<div class="al-empty">还没有设置提醒。详情页点「提醒」即可。</div>`}
      <div class="sheet-actions"><button class="btn ghost" data-close>关闭</button></div>
    </div>`);
  $$("#sheet .al-more").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.almore;
      const rest = document.querySelector(`#sheet [data-alrest="${k}"]`);
      if (rest) rest.classList.remove("hidden");
      b.remove();
    };
  });
  $$("#sheet .al-del").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`price-alerts/${b.dataset.del}`, { method: "DELETE", idempotent: true });
        toast("已删除");
        const parent = b.closest(".al-live-row");
        if (parent) parent.remove();
      } catch (e) { toast(e.message || "删除失败"); }
    };
  });
  api("price-alerts/read", { method: "POST", idempotent: true }).then(() => paintAlertDot(0)).catch(() => {});
}

/* 绩效：等权累计收益率曲线 + 回撤 + 每只贡献
   切换 30/90/全部 时只换数据、不重建弹层——重开会让整张卡先消失再出现，看起来就是"抖动" */
function perfSheetOpen() {
  return !!(document.querySelector("#pf-tabs") && document.querySelector("#pf-chart"));
}

async function openPerfSheet(range) {
  const r = range || "90";
  if (!perfSheetOpen()) {
    openSheet("持仓绩效", `<div class="pf-tabs seg" id="pf-tabs">
        <button data-r="30">30 天</button>
        <button data-r="90">90 天</button>
        <button data-r="all">全部</button>
      </div>
      <div class="pf-wrap"><canvas id="pf-chart"></canvas></div>
      <div id="pf-stat" class="pf-stat tiny muted">读取中…</div>
      <div id="pf-contrib" class="pf-contrib"></div>
      <div class="sheet-actions"><button class="btn ghost" data-close>关闭</button></div>`);
    $$("#pf-tabs button").forEach((b) => { b.onclick = () => perfSetRange(b.dataset.r); });
  }
  perfSetRange(r);
}

let _pfSeq = 0;

async function perfSetRange(r) {
  const seq = ++_pfSeq;
  $$("#pf-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.r === r));
  const stat = $("#pf-stat");
  const box = $("#pf-contrib");
  // 保留上一次的数字，只压暗，等新数据回填——避免"读取中…"和数字来回顶
  if (stat) stat.style.opacity = ".55";
  let d = null;
  try { d = await api(`perf?range=${r}`, { noRetry: true }, 15000); } catch (e) { d = null; }
  if (!perfSheetOpen() || seq !== _pfSeq) return; /** 弹层已关掉，或用户又点了别的区间 */
  if (stat) stat.style.opacity = "1";
  if (!d || !d.ok) { if (stat) stat.textContent = "还取不到绩效数据（需要至少两只持仓有日线）"; return; }
  const pts = d.points || [];
  if (stat) {
    stat.innerHTML = `区间 <b class="${cls(d.cur)}">${d.cur === null ? "—" : (d.cur > 0 ? "+" : "") + num(d.cur, 2) + "%"}</b>
      · 最大回撤 <b class="down">${num(d.maxdd, 2)}%</b>${d.dd_at ? `（${esc(d.dd_at.slice(5))}）` : ""}
      · 成本 ${num(d.cost, 2)}`;
  }
  if (box) {
    box.innerHTML = (d.contrib || []).map((c) => `<div class="pf-c-row">
        <span class="pf-c-n">${esc(c.name)}</span><span class="pf-c-w">${num(c.w, 1)}%</span>
        <span class="pf-c-v">${num(c.mv, 0)}</span></div>`).join("");
  }
  const cv = $("#pf-chart");
  if (cv && pts.length > 1) drawPerf(cv, pts);
}

function drawPerf(cv, pts) {
  const W = Math.max(240, cv.parentElement.clientWidth - 2), H = 150;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.width = "100%"; cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const rs = pts.map((p) => Number(p.r || 0));
  const min = Math.min(0, ...rs), max = Math.max(0, ...rs);
  const pad = 8, span = max - min || 1;
  const y = (v) => pad + (H - pad * 2) * (1 - (v - min) / span);
  ctx.strokeStyle = "rgba(127,127,127,.28)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
  ctx.strokeStyle = "#12a150";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  rs.forEach((v, i) => { const x = pad + (W - pad * 2) * i / (rs.length - 1); i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v)); });
  ctx.stroke();
  ctx.fillStyle = "#86868b";
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  ctx.fillText(`${max.toFixed(1)}%`, 4, 12);
  ctx.fillText(`${min.toFixed(1)}%`, 4, H - 4);
}

/* K 线自检：把巡检结果按「范围 / 正常项 / 异常项」摆出来，异常直接给到 code+周期 */
/* 数据健康页：行情源、K 线巡检、港美延时，一屏说清「数据到底新不新」 */
async function openDataHealthSheet() {
  openSheet("数据健康", `<div class="dh-wrap"><div class="dh-row"><span>读取中…</span></div></div>`);
  let h = null, k = null;
  try { h = await api("health", { noRetry: true }, 10000); } catch (e) { h = null; }
  try { k = await api("kline/health", { noRetry: true }, 12000); } catch (e) { k = null; }
  const q = (h && h.quotes) || {};
  const row = (k1, v1, s1) => `<div class="dh-row"><span class="dh-k">${k1}</span><b>${v1}</b>${s1 ? `<span class="dh-s">${s1}</span>` : ""}</div>`;
  const err = q.last_error ? "东财单只报价偶发失败（已用腾讯/新浪兜底）" : "最近没有报错";
  const html = [
    `<div class="dh-sec">行情源</div>`,
    row("状态", (h && h.market && h.market.text) || "—", h && h.market ? h.market.server_time : ""),
    row("标的数", q.symbols ?? "—", q.newest_age ? `最新一条 ${num(q.newest_age, 0)}s 前` : ""),
    row("上游", err, q.tencent_backoff ? `腾讯退避 ${q.tencent_backoff}s` : "腾讯正常"),
    `<div class="dh-sec">K 线巡检</div>`,
    k && typeof k.checks === "number" ? row("结果", k.failed ? `${k.failed} 项异常` : "全部正常",
        `${k.checks}/${k.targets} · 用时 ${k.elapsed}s${k.generated_at ? " · " + String(k.generated_at).slice(5, 16) : ""}`)
      : `<div class="dh-row"><span class="dh-k">结果</span><b>还没有巡检结果</b><span class="dh-s">工作日 16:35 自动跑</span></div>`,
    `<div class="dh-sec">跨市场</div>`,
    row("港股 / 美股", "延时行情", "腾讯 hk / us 报价"),
    row("全球指数", "东财 + 腾讯", "60s 缓存"),
  ].join("");
  const box = $("#sheet .dh-wrap");
  if (box) box.innerHTML = html;
}

async function openKlineHealthSheet() {
  openSheet("K线自检", `<div class="empty">读取巡检结果…</div>`);
  let d = null, run = null;
  try { d = await api("kline/health", { noRetry: true }, 12000); } catch (e) { d = null; }
  try { run = await api("kline/health/run", { noRetry: true }, 8000); } catch (e) { run = null; }
  let timer = 0;
  let st0 = run;

  const paint = (data, st) => {
    const running = !!(st && st.running);
    const actions = `<div class="sheet-actions">
        <button class="btn ghost" data-close>关闭</button>
        <button class="btn primary" id="kh-run"${running ? " disabled" : ""}>${running ? "巡检中…" : "重新自检"}</button>
      </div>`;
    const tip = `<div class="kh-running${running ? "" : " hidden"}" id="kh-running"><i></i><span id="kh-running-t">${running ? "正在巡检…" : ""}</span></div>`;
    if (!data) {
      openSheet("K线自检", `<div class="empty-rich"><div class="er-t">还没有巡检结果</div>
        <div class="er-d">服务器每个交易日 16:35 自动跑一次；也可以点下方「重新自检」现跑一次</div></div>${tip}${actions}`);
    } else {
      const items = data.items || [];
      const sum = `<div class="kh-sum">
          <div class="kh-big${data.failed ? " bad" : ""}">${data.failed ? `${data.failed} 项异常` : "全部正常"}</div>
          <div class="kh-sub">${data.checks} 项检查 · ${data.targets} 只标的 · 用时 ${data.elapsed}s · 生成 ${esc(String(data.generated_at || "").slice(5, 16))}</div>
        </div>
        <div class="kh-note">覆盖分时 / 日K / 周K 三个周期；这只标的的某个周期取不到数时会单独列出来，方便判断是数据源问题还是页面问题。</div>`;
      const rows = data.failed
        ? `<div class="kh-list">${items.map((x) => `<div class="kh-row">
            <div class="kh-l"><b>${esc(x.name || x.code)}</b><span class="kh-cd">${esc(x.code)}</span></div>
            <div class="kh-r"><span class="kh-k ${x.kind === "error" ? "err" : ""}">${x.kind === "error" ? "上游报错" : "无数据"}</span><span class="kh-p">${esc({ min: "分时", day: "日K", week: "周K", month: "月K" }[x.period] || x.period)}</span></div>
          </div>`).join("")}</div>`
        : `<div class="kh-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 12.5 9.5 17.5 19.5 7"/></svg>
            <span>本次巡检没有发现取不到数据的标的</span></div>`;
      openSheet("K线自检", sum + rows + tip + actions);
    }
    const btn = $("#kh-run");
    if (btn) btn.onclick = () => begin(btn, data);
  };

  const poll = (btn) => {
    const t0 = Date.now();
    let fails = 0;
    const tick = async () => {
      if ($("#sheet").classList.contains("hidden")) return;
      let st = null, err = null;
      try { st = await api("kline/health/run", { noRetry: true }, 10000); } catch (e) { err = e; }
      if (err) {
        fails++;
        if (fails >= 3) {   // 连续读不到状态就收尾，不要一直假装「巡检中」到 15 分钟
          toast("读不到巡检状态，稍后再打开看结果");
          const box = $("#kh-running");
          if (box) box.classList.add("hidden");
          if (btn) { btn.disabled = false; btn.textContent = "重新自检"; }
          return;
        }
      } else {
        fails = 0;
      }
      if (st && !st.running) {
        let fresh = null;
        try { fresh = await api("kline/health", { noRetry: true }, 12000); } catch (e) {}
        toast(st.ok === false
          ? `自检没跑通：${st.error || "看服务器日志"}`
          : fresh && fresh.failed ? `自检完成 · ${fresh.failed} 项异常` : "自检完成 · 全部正常");
        paint(fresh, st);
        return;
      }
      const line = $("#kh-running-t");
      if (line) line.textContent = `正在巡检 · 已跑 ${Math.round((Date.now() - t0) / 1000)} 秒`;
      if (Date.now() - t0 > 15 * 60 * 1000) { toast("巡检超过 15 分钟，稍后再来看结果"); if (btn) { btn.disabled = false; btn.textContent = "重新自检"; } return; }
      timer = setTimeout(tick, 2500);
    };
    tick();
  };

  const begin = async (btn, data) => {
    btn.disabled = true; btn.textContent = "巡检中…";
    $("#kh-running").classList.remove("hidden");
    $("#kh-running-t").textContent = "正在启动…";
    try {
      await api("kline/health/run", { method: "POST", idempotent: true, body: {} }, 20000);
    } catch (e) {
      toast("启动失败：" + (e.message || "网络错误"));
      btn.disabled = false; btn.textContent = "重新自检";
      $("#kh-running").classList.add("hidden");
      return;
    }
    poll(btn);
  };

  paint(d, st0);
  if (run && run.running) poll($("#kh-run"));
}

/* ---------- 2/3. board ---------- */

/* ---------- 持仓汇总条：成本 / 市值 / 累计 / 每日定投 ---------- */
async function paintHoldSum() {
  const box = $("#hold-sum");
  if (!box || !state.board) return;
  // 汇总数字服务端已经算在 board.sum 里，手机只管渲染；只有老缓存没有这个字段才回退请求 dashboard
  const bd = state.board;
  // 兜底只做一次：board 已经带 sum，老缓存（升级前写的 localStorage 快照）才会缺；
  // 以前每次重开都会再打一遍 dashboard / dca/plan / stocks，纯重复。
  const fb = (paintHoldSum._fb = paintHoldSum._fb || { dash: 0, hold: 0, plan: 0 });
  let d = paintHoldSum._dash || null;
  if (!bd.sum && !fb.dash) {
    fb.dash = 1;
    try { d = await api("dashboard", { noRetry: true }, 12000); } catch (e) { d = null; }
    if (d) paintHoldSum._dash = d;
  }
  if (!bd.sum && !d) {
    d = paintHoldSum._dash || null;
    if (!d) { box.hidden = true; return; }
  }
  // ② 我的今日：浮动 / 今日 / 市值 / 每日定投
  const h = bd.sum || (d && d.hold) || {};
  let rows = [];
  if (bd.sum) rows = (bd.stocks || []).filter((r) => r && r.bucket === "hold" && Number(r.shares) > 0);
  else if (!fb.hold) { fb.hold = 1; try { rows = await loadHoldings(); } catch (e) { rows = []; } }
  state.holdRows = (rows || []).filter((r) => r && Number(r.shares) > 0);
  let plan = bd.dca_plan || state.dcaPlan || null;
  if (!plan && !fb.plan) {
    fb.plan = 1;
    try { plan = await api("dca/plan", { noRetry: true }, 12000); } catch (e) { plan = null; }
  }
  state.dcaPlan = plan;
  const dcaSum = state.holdRows.reduce((a, r) => a + (Number(r.dca) || 0), 0);
  const effDca = plan ? plan.effective_total : null;
  const fmtDca = (v) => (Number(v) % 1 ? num(Number(v), 2) : Math.round(Number(v)));
  const pnl = h.pnl, pnlPct = h.pct, today = h.today;
  // 一行到底：浮动 / 今日 / 市值 / 定投，不再分两行堆小字
  box.innerHTML = `<span class="hs-i"><span class="k">浮动</span><b class="${cls(pnl)}">${pnl === null || pnl === undefined ? "—" : (pnl > 0 ? "+" : "") + num(pnl, 2)}</b><span class="hs-p ${cls(pnlPct)}">${pnlPct === null || pnlPct === undefined ? "" : (pnlPct > 0 ? "+" : "") + num(pnlPct, 2) + "%"}</span></span>
    <button type="button" class="hs-i" data-perf><span class="k">今日</span><b class="${cls(today)}">${today === null || today === undefined ? "—" : (today > 0 ? "+" : "") + num(today, 2)}</b></button>
    <span class="hs-i"><span class="k">市值</span><b>${h.mv === undefined ? "—" : num(h.mv, 2)}</b></span>
    <button type="button" class="hs-i" data-dcaedit><span class="k">定投</span><b class="dca-b">${!plan ? "—" : plan.trading_day ? "¥" + fmtDca(effDca) : "休市"}</b></button>`;
  box.hidden = false;
  paintPositionBadges();
  const dcaBtn = box.querySelector("[data-dcaedit]");
  if (dcaBtn) dcaBtn.onclick = () => openDcaEditor();
  const perfBtn = box.querySelector("[data-perf]");
  if (perfBtn) perfBtn.onclick = () => openPerfSheet();
  paintAlertDot((bd.sum ? bd.alert_unread : (d && d.alert_unread)) || 0);
  const ld = bd.sum ? bd.lead : (d && d.lead);
  const leadLine = ld ? `今日 ${esc(ld.name)} ${pctText(ld.pct)} 领涨` : "";
  state.dashLead = leadLine;
}


/* 卡片上的定投小标：今天会不会真扣（交易日 / 限额 / 暂停申购都算过） */
const DCA_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 1.9"/></svg>';
function dcaLine(r) {
  const dca = Number(r.dca) || 0;
  if (dca <= 0) return { html: `<span>未设定投</span>`, cls: "off" };
  const plan = state.dcaPlan;
  const it = plan && (plan.items || []).find((x) => String(x.code) === String(r.code));
  const eff = it ? Number(it.effective) || 0 : null;
  const money = `¥${num(dca, dca % 1 ? 2 : 0)}`;
  if (eff === null) return { html: `<span>定投 ${money} · 状态未知</span>`, cls: "" };
  const hit = eff > 0;
  const limit = it && it.limit ? Number(it.limit) : null;
  const sgzt = String((it && it.sgzt) || "");
  const paused = sgzt.includes("暂停") || sgzt.includes("停止");
  const parts = [`每日 ${money}`];
  // 只有上限真的会卡住定投时才说；上限 ≥ 定投额时这半句是废话
  if (!paused && limit && limit < dca) parts.push(`单日限 ¥${num(limit, limit % 1 ? 2 : 0)}`);
  parts.push(paused ? "暂停申购" : hit ? "今日扣款" : "今日不扣");
  return { html: `<span>${parts.join(" · ")}</span>`, cls: hit ? "on" : "" };
}

/* 持仓卡三栏：市值 / 占比 / 持有盈亏。用份额×净值实时算，列头固定所以数字位数不影响对齐 */
function paintPositionBadges() {
  const rows = (state.holdRows || []).filter((r) => r && r.bucket === "hold" && Number(r.shares) > 0);
  if (!rows.length || !state.board) return;
  const stockOf = (code) => (state.board.stocks || []).find((x) => x.code === code) || null;
  const priceOf = (code) => {
    const s = stockOf(code);
    return s && s.price ? Number(s.price) : null;
  };
  let total = 0;
  rows.forEach((r) => { const p = priceOf(r.code); if (p) total += Number(r.shares) * p; });
  rows.forEach((r) => {
    const box = document.querySelector(`.row[data-code="${r.code}"] .pos-stats`);
    const dcaBox = document.querySelector(`.row[data-code="${r.code}"] .dca-line`);
    if (!box) return;
    // 定投行独立于价格：没有净值时也要画（否则这一行会空着塌下去）
    const s = stockOf(r.code);
    if (dcaBox) {
      if (s && s.source === "fund_nav") {
        const d = dcaLine(r);
        dcaBox.className = `dca-line${d.cls ? " " + d.cls : ""}`;
        dcaBox.innerHTML = `${DCA_CLOCK}${d.html}`;
        dcaBox.hidden = false;
      } else {
        dcaBox.hidden = false;
        dcaBox.className = "dca-line";
        dcaBox.innerHTML = "";
      }
    }
    const p = priceOf(r.code);
    if (!p || !total) { box.hidden = true; box.innerHTML = ""; return; }
    const mv = Number(r.shares) * p;
    const w = (mv / total) * 100;
    const cost = r.cost === null || r.cost === undefined ? null : Number(r.cost);
    const pnl = cost ? mv - cost : null;
    const pnlPct = cost ? (pnl / cost) * 100 : null;
    const pnlV = pnl === null ? "—" : `${pnl > 0 ? "+" : ""}${num(pnl, 2)}<i>${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%</i>`;
    box.hidden = false;
    box.innerHTML = `<div class="ps"><span class="ps-k">市值</span><span class="ps-v">${num(mv, 2)}</span></div>
      <div class="ps"><span class="ps-k">占比</span><span class="ps-v">${w.toFixed(2)}%</span></div>
      <div class="ps ${pnl === null ? "" : cls(pnl)}"><span class="ps-k">持有盈亏</span><span class="ps-v">${pnlV}</span></div>`;
  });
}

/* 每日定投编辑器：一次改所有基金的定投额度（不用逐只进详情页） */
async function openDcaEditor() {
  let rows;
  try { rows = await loadHoldings(); } catch (e) { return; }
  const funds = (rows || []).filter((r) => r && r.bucket === "hold" && Number(r.shares) > 0);
  if (!funds.length) { toast("当前持仓里没有基金"); return; }
  let el = $("#dcaeditor");
  if (!el) {
    el = document.createElement("div");
    el.id = "dcaeditor";
    el.className = "rowmenu hidden";
    document.body.appendChild(el);
  }
  const nameOf = (code) => {
    const s = state.board.stocks.find((x) => x.code === code) || {};
    return s.name || code;
  };
  let plan = null;
  try { plan = await api("dca/plan", { noRetry: true }, 12000); } catch (e) { plan = null; }
  const statusOf = (code) => {
    if (!plan) return { note: "", cls: "" };
    const it = (plan.items || []).find((x) => String(x.code) === String(code));
    if (!it) return { note: plan.trading_day ? "正常申购" : "今日休市", cls: it ? "" : "" };
    return { note: it.note || "", cls: it.status === "ok" ? "" : " warn" };
  };
  el.innerHTML = `<div class="rm-mask" data-dcaclose></div>
    <div class="rm-card dcacard">
      <div class="rm-head"><span class="rm-name">每日定投（元 / 交易日）</span></div>
      <div class="dca-rows">${funds.map((r) => {
        const st = statusOf(r.code);
        return `<label class="dca-row">
          <span class="dca-main"><span class="dca-name">${esc(nameOf(r.code))}</span>
            <span class="dca-note${st.cls}">${esc(st.note)}</span></span>
          <input type="number" inputmode="decimal" step="1" min="0" value="${Number(r.dca) || 0}" data-dca="${r.code}" aria-label="${esc(nameOf(r.code))}每日定投">
          <span class="dca-unit">元</span></label>`;
      }).join("")}</div>
      <div class="dca-actions">
        <button type="button" class="rm-item cancel" data-dcaclose>取消</button>
        <button type="button" class="btn primary small" data-dcasave>保存</button>
      </div>
    </div>`;
  el.classList.remove("hidden");
  document.body.classList.add("rm-open");
  el.querySelectorAll("[data-dcaclose]").forEach((b) => { b.onclick = () => closeDcaEditor(); });
  const save = el.querySelector("[data-dcasave]");
  save.onclick = async () => {
    const changes = [];
    el.querySelectorAll("[data-dca]").forEach((inp) => {
      const code = inp.dataset.dca;
      const old = funds.find((x) => String(x.code) === String(code));
      const v = parseFloat(inp.value || "0");
      if (!(v >= 0)) return;
      if (Math.abs(v - (Number(old && old.dca) || 0)) > 1e-6) changes.push([code, v]);
    });
    if (!changes.length) { closeDcaEditor(); return; }
    save.disabled = true; save.textContent = "保存中…";
    try {
      for (const [code, v] of changes) {
        await api(`stocks/${code}`, { method: "PATCH", idempotent: true, body: { dca: v } }, 20000);
      }
      _memo.delete("board"); _holdMemo.ts = 0;
      await loadBoard(true).catch(() => {});
      paintHoldSum().catch(() => {});
      refreshMarketAll().catch(() => {});
      closeDcaEditor();
      toast("定投已更新");
    } catch (e) {
      save.disabled = false; save.textContent = "保存";
      toast(e.message || "保存失败");
    }
  };
}
function closeDcaEditor() {
  const el = $("#dcaeditor");
  if (el) el.classList.add("hidden");
  document.body.classList.remove("rm-open");
}

async function loadBoard(silent) {
  const hit = !silent && memoFresh("board", liveTtl(3000));
  if (hit) {
    if (state.board !== hit) applyBoard(hit);
    paintHoldSum().catch(() => {});   // 命中缓存时也要画汇总条，否则首屏会缺这一块
    schedulePoll();
    return;
  }
  // 后台轮询不重试、8 秒就放弃，避免一次隧道抖动把后面几拍全拖住
  const d = await api("board", silent ? { noRetry: true } : {}, silent ? 8000 : 15000);
  memoSet("board", d);
  // 304 时 api() 返回的是同一个对象：数据没变就不重绘
  if (state.board !== d) applyBoard(d);
  paintHoldSum().catch(() => {});
  if (!silent) schedulePoll();
}

/* 这些字段决定行/标签/分组的结构，变了才需要整表重绘；价格和指标不在此列 */
function boardMetaSig(d) {
  return JSON.stringify({
    stocks: (d.stocks || []).map((s) => [
      s.code, s.name, s.bucket, s.sort, s.priority, s.tags, s.custom_tags,
      s.note, s.focus, s.note_count,
    ]),
    flags: d.flags || {},
    hold: d.hold_count,
    watch: d.watch_count,
    tag_order: d.tag_order || {},
  });
}

/* 场外基金没有流通/换手/量比/PE：底行换成净值日期、累计净值、规模 */
const fundMetsWanted = new Set();

/* 基金档案失败退避：接口或上游失败后 60 秒内不再重试。
   不设退避时，失败结果不进 memo，3 秒轮询会把它放大成每分钟 20 次（实测单只 1900 次/小时）。
   服务端 FUND_NEG_TTL 也是 60 秒，两边对齐。 */
const FUND_FAIL_COOL_MS = 60000;
const fundFailAt = new Map();
function fundCooling(code) {
  const t = fundFailAt.get(String(code));
  return !!t && t > Date.now();
}
function fundFail(code, err) {
  fundFailAt.set(String(code), Date.now() + FUND_FAIL_COOL_MS);
  logErr("fund:" + String(code), err);
}

function fundMetsText(code) {
  const d = fundProfileMemo.get(String(code));
  if (!d) {
    if (!fundCooling(code)) {
      fundMetsWanted.add(String(code));
      loadFundMets(String(code));
    }
    return "净值 — · 规模 —";
  }
  const scale = d.scale !== null && d.scale !== undefined ? `${num(d.scale, 2)}亿` : "—";
  // 累计净值不进底行：QDII 的 accnav 常小于单位净值，看着像算错，占的宽度却顶掉「规模/申购状态」，
  // 它在详情页净值和阶段收益里都有
  const acc = "";
  // 基金净值天然滞后一天以上（QDII 更久），带日期，别让周末看的人当实时价
  const nd = d.nav_date ? String(d.nav_date).slice(5) : "";
  // 前面的价格已经是单位净值，这里只标截止日和规模，不再重复「净值」两个字
  return `截至 ${nd || "—"} · ${acc}${scale} · ${d.sgzt || "申购状态 —"}`;
}
const FUND_MEMO_MS = 10 * 60000;
const fundMemoAt = new Map();
function fundMemoFresh(code) {
  const t = fundMemoAt.get(String(code));
  return fundProfileMemo.has(String(code)) && !!t && Date.now() - t < FUND_MEMO_MS;
}

/* 一次只飞一条：以前每次重绘（3 秒一拍）都会再发一次，同一只基金能在几秒里叠 4~6 条，
   接口再快也是白烧网络和电。 */
const FUND_MIN_GAP = 60000;
const fundNextAt = new Map();
/* 同一拍里要的几只基金合成一个请求：持仓页 5 只以前是 5 条并发，
   现在 150ms 窗口内的合并成一条 /funds?codes=…，冷启动少 4 次隧道往返。 */
const fundBatchWait = new Map();
let fundBatchTimer = 0;
function fundBatchCall(code) {
  return new Promise((resolve, reject) => {
    fundBatchWait.set(String(code), { resolve, reject });
    if (fundBatchTimer) return;
    fundBatchTimer = setTimeout(() => {
      const pend = new Map(fundBatchWait);
      fundBatchWait.clear();
      fundBatchTimer = 0;
      const codes = [...pend.keys()].slice(0, 24);
      const dropped = [...pend.keys()].slice(24);
      dropped.forEach((c) => pend.get(c).resolve({ ok: false, error: "一次最多取 24 只" }));
      if (!codes.length) return;
      api(`funds?codes=${codes.map(encodeURIComponent).join(",")}&lite=1`, { noRetry: true }, 25000)
        .then((r) => {
          const list = (r && r.funds) || {};
          pend.forEach((h, c) => { if (codes.includes(c)) h.resolve(list[c] || { ok: false, error: "空响应" }); });
        })
        .catch((e) => pend.forEach((h, c) => { if (codes.includes(c)) h.reject(e); }));
    }, 150);
  });
}
function loadFundMets(code) {
  code = String(code);
  if (fundCooling(code) || fundInflight.has(code)) return;
  if (fundMemoFresh(code)) return;
  // 硬闸：不管上面的缓存怎么失效，同一只基金 60 秒最多打一次接口
  if (Date.now() < (fundNextAt.get(code) || 0)) return;
  fundNextAt.set(code, Date.now() + FUND_MIN_GAP);
  fundMetsWanted.delete(code);
  fundInflight.add(code);
  fundBatchCall(code).then((d) => {
    if (d && d.ok) { fundProfileMemo.set(code, d); fundMemoAt.set(code, Date.now()); fundFailAt.delete(code); }
    else fundFail(code, (d && d.error) || "空响应");
  }).catch((e) => fundFail(code, e)).finally(() => {
    fundInflight.delete(code);
    if (state.board) patchBoardQuotes(state.board);
  });
}
const fundInflight = new Set();
function metsLineHtml(s) {
  const flags = [s.stale ? "延迟" : "", s.source === "sina" ? "备用源" : ""].filter(Boolean).join(" · ");
  if (s.source === "fund_nav") {
    const quote = `<span class="m-quote"><span class="m-k">净值</span><span class="m-px">${Number(s.price).toFixed(4)}</span></span>`;
    return `${quote}<span>${fundMetsText(s.code)}</span>${flags ? `<span class="muted">${flags}</span>` : ""}`;
  }
  const quote = `<span class="m-quote"><span class="m-px">${px(s.price)}</span></span>`;
  const mets = metsParts(s).map((x) => `<span>${x}</span>`).join("");
  return `${quote}${mets}${flags ? `<span class="muted">${flags}</span>` : ""}`;
}

/* 只换价格/涨幅/指标，不重建 DOM：否则每 3 秒会把「确认删除」和长按状态一起冲掉 */
function patchBoardQuotes(d) {
  const byCode = new Map((d.stocks || []).map((s) => [s.code, s]));
  $$(".row[data-code]").forEach((row) => {
    const s = byCode.get(row.dataset.code);
    if (!s) return;
    const pc = row.querySelector(".row-pct .pc");
    if (pc) {
      pc.textContent = pctText(s.pct);
      pc.className = `pc ${cls(s.pct)}`;
    }
    const mets = row.querySelector(".mets-line");
    if (mets) {
      const h = metsLineHtml(s);
      if (mets.innerHTML !== h) mets.innerHTML = h;
    }
  });
}

function applyBoard(d) {
  state.board = d;
  if (d.tag_order && typeof d.tag_order === "object") {
    state.tagOrder.hold = d.tag_order.hold || [];
    state.tagOrder.watch = d.tag_order.watch || [];
  }
  // 用服务器北京时间校准时钟：收盘后靠它算下一个开盘时刻。
  // clockSkew 是「北京墙上时间当 UTC」的偏移（原有 nextResumeAt 用）；
  // serverSkew 才是真实的服务器时钟偏移，用来校准服务端给的绝对 epoch 毫秒。
  const mt = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec((d.market && d.market.server_time) || "");
  if (mt) {
    state.clockSkew = Date.UTC(+mt[1], +mt[2] - 1, +mt[3], +mt[4], +mt[5], +mt[6]) - Date.now();
    state.serverSkew = state.clockSkew - 8 * 3600e3;
  }
  renderMarketPill(d.market);
  const hc = $("#hold-count");
  if (hc) hc.textContent = d.hold_count;
  const wc = $("#watch-count");
  if (wc) wc.textContent = d.watch_count;

  // 服务端统一算下一次开盘/午休恢复时刻（绝对 epoch ms），前端不再自己猜 9:14/9:15
  const next = Number(d.next_open_at || 0);
  state.resumeAt = next > 0 ? next - (state.serverSkew || 0) : 0;

  const sig = boardMetaSig(d);
  const rows = $$(".row[data-code]");
  if (state.boardSig && state.boardSig === sig && rows.length) {
    patchBoardQuotes(d);
  } else {
    renderBucket("hold");
    renderBucket("watch");
  }
  state.boardSig = sig;
  syncFollowButtons();
  syncHoldButtons();
  // 卡片重建后徽标是空的：持有清单已就绪就补画一次（不必等汇总条的异步流程）
  if (state.holdRows && state.holdRows.length) requestAnimationFrame(() => paintPositionBadges());
}

function allCustomTags(bucket, override) {
  const seen = new Map();
  let untagged = 0;
  state.board.stocks.filter((s) => s.bucket === bucket).forEach((s) => {
    const tags = customTagsOf(s);
    if (!tags.length) untagged++;
    tags.forEach((t) => seen.set(t, (seen.get(t) || 0) + 1));
  });
  // 手动顺序优先；没排过的标签按数量从多到少、同量按拼音排在后面
  const rank = override && override.length
    ? new Map(override.map((t, i) => [t, i]))
    : tagRankMap(bucket);
  const rows = [...seen.entries()].sort((a, b) => {
    const ra = rank.has(a[0]) ? rank.get(a[0]) : 1e6;
    const rb = rank.has(b[0]) ? rank.get(b[0]) : 1e6;
    if (ra !== rb) return ra - rb;
    return b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN");
  });
  if (untagged) rows.push([UNTAGGED, untagged]);
  return rows;
}

function tagRankMap(bucket) {
  const m = new Map();
  (state.tagOrder[bucket] || []).forEach((t, i) => { if (!m.has(t)) m.set(t, i); });
  return m;
}

/* 个股在标签条里的位置：取它第一个排过序的标签；没排过的排在已排序标签之后 */
function tagSortKey(s, rank) {
  const ts = customTagsOf(s);
  let best = 1e6;
  ts.forEach((t) => {
    if (rank.has(t) && rank.get(t) < best) best = rank.get(t);
  });
  return best;
}

function rowHtml(s) {
  // 三块信息统一成同样的小标签：有内容显示内容，空着就显示「外网 / 备注 / 关注」。
  const tagList = (s.tags || []).filter(Boolean);
  const tagsFull = tagList.join(" · ");
  const tagsText = tagList.length
    ? tagList.slice(0, 3).join(" · ") + (tagList.length > 3 ? ` +${tagList.length - 3}` : "")
    : "";
  const note = (s.note || "").trim();
  const ana = s.analysis || [];
  const oneLine = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const noteText = oneLine(note);
  // 卡片上只放一行「最新要关注的简写」：手动优先，其次报告提纯出的关注点，
  // 最后退到最新分析的前 60 字；点这一行看全部历史原文。
  const auto = (s.focus_auto || "").trim();
  const brief = ana.length
    ? oneLine(String(ana[0].content || "").replace(/\*\*/g, "")).replace(/^[^：:]{1,20}[：:]/, "").slice(0, 60)
    : "";
  const focus = s.focus_manual ? (s.focus || "").trim() : (auto || brief);
  const focusText = oneLine(focus);
  const focusLine = focusText
    ? `<button type="button" class="info-line info-focus" data-focus="${s.code}" title="${esc(`关注：${focusText}（点击看全部内容）`)}"><span class="line-txt">${esc(focusText)}</span></button>`
    : "";
  const noteN = Number(s.note_count || 0);
  const act = s.bucket === "hold" ? { label: "关注", next: "watch" } : { label: "持仓", next: "hold" };
  const flag = ((state.board && state.board.flags) || {})[s.code];
  const flagN = flag ? flag.n : 0;

  return `<div class="row row-card selable" data-code="${s.code}">
    <div class="row-top">
      <div class="nm">${s.priority ? `<span class="pri-dot pri-${esc(s.priority)}" title="优先级 ${esc(s.priority)}"></span>` : ""}<span class="nm-text${flagN ? " flagged" : ""}"${flagN ? ` title="${esc(flag.title || "")}"` : ""}>${esc(s.name)}</span>${s.bucket === "hold" ? "" : mktBadge(s.code)}${tagsText ? `<button type="button" class="info-pill info-ext nm-ext" data-ext-refresh="${s.code}" title="${esc(tagsFull || "外网标签")}"><span class="pill-txt">${esc(tagsText)}</span></button>` : ""}</div>
      <div class="row-pct"><span class="pc ${cls(s.pct)}">${pctText(s.pct)}</span></div>
    </div>
    ${s.bucket === "hold" ? '<div class="pos-stats" hidden></div><div class="dca-line" hidden></div>' : ""}
    <div class="row-lines">${note ? `<button type="button" class="info-line info-note" data-note="${s.code}" title="${esc(`备注：${note}（点击编辑）`)}"><span class="line-txt">${esc(noteText)}</span></button>` : ""}${focusLine}</div>
    <div class="row-foot">
      <div class="mets-line">${metsLineHtml(s)}</div>
      <button type="button" class="idea-btn${noteN ? " has" : ""}" data-ideas="${s.code}" title="${noteN ? `预览 ${noteN} 条关联记录 / 添加一条` : "添加关联记录"}"><svg class="ib-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 17.5h5.6M10 20.5h4"/><path d="M12 3.2a6 6 0 0 1 3.6 10.8c-.5.4-.7.9-.7 1.5h-5.8c0-.6-.2-1.1-.7-1.5A6 6 0 0 1 12 3.2z"/></svg>${noteN ? `<span>${noteN}</span>` : ""}</button>
      <button type="button" class="row-more" data-more="${s.code}" aria-label="更多操作">⋯</button>
    </div>
    <div class="row-acts" hidden><button class="act" data-move="${s.code}" data-to="${act.next}">${act.label}</button>
      <button class="act del" data-del="${s.code}">删除</button></div>
  </div>`;
}

function bindRows(box) {
  $$(".row", box).forEach((r) => {
    const code = r.dataset.code;
    let timer = null;
    let fired = false;
    $$(".ana-txt", r).forEach((el) => {
      el.onclick = (e) => { e.stopPropagation(); el.classList.toggle("open"); };
    });
    const anaMore = $("[data-ana-more]", r);
    if (anaMore) anaMore.onclick = (e) => { e.stopPropagation(); openStockAnalysis(code); };
    const start = (e) => {
      if (state.sel.key) return;
      if (e.target.closest("[data-move],[data-del],[data-note],[data-ext-refresh],[data-ideas],[data-focus],[data-ana-more],[data-more]")) return;
      fired = false;
      clearTimeout(timer);
      // 个股长按 = 编辑自定义标签（不是多选）
      timer = setTimeout(() => { fired = true; openStockTags(code); }, 520);
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    r.addEventListener("touchstart", start, { passive: true });
    r.addEventListener("touchend", cancel);
    r.addEventListener("touchmove", cancel);
    r.addEventListener("touchcancel", cancel);
    r.addEventListener("mousedown", start);
    r.addEventListener("mouseup", cancel);
    r.addEventListener("mouseleave", cancel);
    r.addEventListener("click", (e) => {
      if (e.target.closest("[data-move],[data-del]")) return;
      if (e.target.closest("[data-more]")) { openRowMenu(code); return; }
      if (fired) { fired = false; return; }
      if (state.sel.key) return;
      if (e.target.closest("[data-note]")) { openStockNote(code); return; }
      if (e.target.closest("[data-ext-refresh]")) { refreshRowTags(code, e.target.closest("[data-ext-refresh]")); return; }
      if (e.target.closest("[data-ideas]")) { openStockIdeas(code); return; }
      if (e.target.closest("[data-focus]")) { openStockFocus(code); return; }
      if (e.target.closest("[data-ana-more]")) { openStockAnalysis(code); return; }
      openStock(code);
    });
  });
}


/* ---------- 卡片「⋯」操作菜单：把关注/删除/备注收进底部小面板 ---------- */
function rowMenuEl() {
  let el = $("#rowmenu");
  if (el) return el;
  el = document.createElement("div");
  el.id = "rowmenu";
  el.className = "rowmenu hidden";
  el.innerHTML = `<div class="rm-mask"></div>
    <div class="rm-card" role="dialog" aria-modal="true">
      <div class="rm-head"><span class="rm-name"></span></div>
      <button type="button" class="rm-item" data-rm="move"></button>
      <button type="button" class="rm-item" data-rm="note">编辑备注</button>
      <button type="button" class="rm-item" data-rm="focus">编辑关注点</button>
      <button type="button" class="rm-item" data-rm="del">删除</button>
      <button type="button" class="rm-item cancel" data-rm="cancel">取消</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector(".rm-mask").onclick = closeRowMenu;
  el.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = () => {
      const code = el.dataset.code || "";
      const row = code ? document.querySelector(`.row-card[data-code="${code}"]`) : null;
      const kind = b.dataset.rm;
      if (kind === "cancel") return closeRowMenu();
      if (kind === "note") { closeRowMenu(); return openStockNote(code); }
      if (kind === "focus") { closeRowMenu(); return openStockFocus(code); }
      if (kind === "move") {
        const src = row && row.querySelector("[data-move]");
        if (src) src.click();
        return closeRowMenu();
      }
      if (kind === "del") {
        const src = row && row.querySelector("[data-del]");
        if (!src) return closeRowMenu();
        const armed = src.classList.contains("armed");
        src.click();         // 走原来的二次确认逻辑
        if (armed) return closeRowMenu();
        b.textContent = "确认删除（再点一次）";
        b.classList.add("danger");
        return;
      }
    };
  });
  return el;
}
function openRowMenu(code) {
  const el = rowMenuEl();
  const row = document.querySelector(`.row-card[data-code="${code}"]`);
  if (!row || !state.board) return;
  const s = (state.board.stocks || []).find((x) => x.code === code) || {};
  el.dataset.code = code;
  el.querySelector(".rm-name").textContent = s.name || code;
  const moveBtn = el.querySelector('[data-rm="move"]');
  moveBtn.textContent = s.bucket === "hold" ? "加入自选（移出持仓）" : "加入持仓（移出关注）";
  const delBtn = el.querySelector('[data-rm="del"]');
  delBtn.textContent = "删除";
  delBtn.classList.remove("danger");
  el.classList.remove("hidden");
  document.body.classList.add("rm-open");
}
function closeRowMenu() {
  const el = $("#rowmenu");
  if (!el) return;
  el.classList.add("hidden");
  el.dataset.code = "";
  document.body.classList.remove("rm-open");
}

/* 持仓/关注行内删除：第一次点变「确认删除」，3.2 秒内再点才真删 */
let rowDelArmed = { code: "", btn: null, timer: null };
function disarmRowDelete() {
  if (rowDelArmed.timer) clearTimeout(rowDelArmed.timer);
  const b = rowDelArmed.btn;
  if (b) {
    b.textContent = "删除";
    b.classList.remove("armed");
  }
  rowDelArmed = { code: "", btn: null, timer: null };
}

function renderBucket(bucket) {
  const box = $(`#${bucket}-list`);
  const tagBox = $(`#${bucket}-tags`);
  if (!box) return;
  const all = state.board.stocks.filter((s) => s.bucket === bucket);
  const sorting = state.tagSorting === bucket;
  // 排序过程中若被后台刷新重绘，沿用屏幕上已经拖好的顺序，别把用户的拖动结果冲掉
  const domOrder = sorting
    ? $$(".chip[data-tag]", tagBox).map((c) => c.dataset.tag).filter((t) => t && t !== UNTAGGED)
    : null;
  const tags = allCustomTags(bucket, domOrder);
  let active = state.tagFilter[bucket];
  if (active) {
    const exists = active === UNTAGGED
      ? all.some((s) => !customTagsOf(s).length)
      : all.some((s) => customTagsOf(s).includes(active));
    if (!exists) {
      active = "";
      state.tagFilter[bucket] = "";
    }
  }

  // 标签筛选条按“自定义标签”展示；没有自定义标签的个股归入「未分类」
  const rank = tagRankMap(bucket);
  tagBox.classList.toggle("tag-sorting", sorting && tags.length > 0);
  // 标签条一行横向滚动，不再按 8 个折叠：标签再多也只是滑，不会把列表顶下去
  tagBox.innerHTML = tags.length
    ? `<button class="chip ${active ? "" : "on"}" data-tag="">全部 ${all.length}</button>` +
      tags.map(([t, n]) => `<button class="chip ${active === t ? "on" : ""}" data-tag="${esc(t)}">${esc(tagLabel(t))} ${n}</button>`).join("") +
      (sorting ? `<button class="chip sortdone" data-sortdone>完成</button>` : "")
    : `<button class="chip ${active ? "" : "on"}" data-tag="">全部 ${all.length}</button>
      <button class="chip wk-new" data-tagmgr title="管理和新建标签">管理</button>`;
  // 标签条末尾的「标签」入口（虚线）：打开标签管理，可改名/删除
  if (tags.length && !sorting) {
    const mgr = document.createElement("button");
    mgr.type = "button";
    mgr.className = "chip wk-new";
    mgr.dataset.tagmgr = bucket;
    mgr.title = "管理和新建标签";
    mgr.textContent = "管理";
    tagBox.appendChild(mgr);
  }
  $$("[data-tagmgr]", tagBox).forEach((b) => {
    b.onclick = () => openTagManager(b.dataset.tagmgr || bucket);
  });
  const doneBtn = $("[data-sortdone]", tagBox);
  if (doneBtn) doneBtn.onclick = () => exitTagSort(bucket, tagBox);
  $$("button[data-tag]", tagBox).forEach((b) => {
    b.onclick = () => {
      if (Date.now() - (tagPressAt || 0) < 700) return;   // 刚长按/拖完，别再触发筛选
      onTagChipClick(bucket, b.dataset.tag);
    };
  });
  bindTagLongPress(tagBox, bucket);   // 长按进入排序模式（全部抖动）；双击标签改名

  let list = active
    ? all.filter((s) => active === UNTAGGED ? !customTagsOf(s).length : customTagsOf(s).includes(active))
    : all;
  const sumBox = bucket === "watch" ? $("#watch-sum") : null;
  if (sumBox) {
    const pcts = list.map((x) => Number(x.pct)).filter((v) => Number.isFinite(v));
    const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
    const up = pcts.filter((v) => v > 0).length, down = pcts.filter((v) => v < 0).length;
    sumBox.innerHTML = list.length
      ? `<span>${esc(active ? tagLabel(active) : "全部关注")} · ${list.length} 只</span><span class="${avg === null ? "muted" : cls(avg)}">平均 ${avg === null ? "—" : (avg > 0 ? "+" : "") + num(avg, 2) + "%"}</span><span class="muted">涨 ${up} / 跌 ${down}</span>`
      : "";
  }
  // 优先级 A→B→C→未设置最高；同一优先级里按标签条顺序分块，再保持原来的手动顺序（sort 稳定）
  list = list.slice().sort((a, b) =>
    (priRank(a.priority) - priRank(b.priority)) || (tagSortKey(a, rank) - tagSortKey(b, rank)));
  if (!list.length) {
    const t = active ? `标签「${esc(tagLabel(active))}」下暂无个股` : bucket === "watch" ? "还没有关注的个股" : "还没有持仓的个股";
    const d = active ? "换个标签看看，或给个股加上这个标签" : "搜索代码或名称后，在详情页加入";
    box.innerHTML = `<div class="empty-rich">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.6"/><path d="M15.6 15.6 21 21"/></svg>
      <div class="er-t">${t}</div><div class="er-d">${d}</div></div>`;
    return;
  }
  if (state.groupByTag[bucket]) {
    // 按自定义标签动态分组；多标签个股会同时出现在多个组里
    const groups = new Map();
    list.forEach((s) => {
      const ts = customTagsOf(s);
      (ts.length ? ts : [UNTAGGED]).forEach((t) => {
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(s);
      });
    });
    box.innerHTML = [...groups.entries()]
      .sort((a, b) => {
        const ra = a[0] === UNTAGGED ? 1e7 : (rank.has(a[0]) ? rank.get(a[0]) : 1e6);
        const rb = b[0] === UNTAGGED ? 1e7 : (rank.has(b[0]) ? rank.get(b[0]) : 1e6);
        return (ra - rb) || (b[1].length - a[1].length);
      })
      .map(([t, arr]) => `<div class="group">
        <div class="group-head"><span class="dot" style="background:#1d1d1f"></span>
          <span class="name">${esc(tagLabel(t))}</span><span class="count">${arr.length}</span></div>
        <div class="rows cards">${arr.map(rowHtml).join("")}</div></div>`)
      .join("");
  } else {
    box.innerHTML = `<div class="rows cards">${list.map(rowHtml).join("")}</div>`;
  }

  bindRows(box);
  $$("[data-more]", box).forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openRowMenu(b.dataset.more); };
  });
  $$("[data-move]", box).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const to = b.dataset.to;
      try {
        await api(`stocks/${b.dataset.move}/bucket`, { method: "POST", body: { bucket: to } });
        toast(to === "hold" ? "已加入持仓" : "已移回关注");
        await loadBoard(true);
      } catch (err) { toast(err.message); }
    };
  });
  $$("[data-del]", box).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const code = b.dataset.del;
      if (rowDelArmed.code !== code || rowDelArmed.btn !== b) {
        disarmRowDelete();
        const timer = setTimeout(disarmRowDelete, 3200);
        rowDelArmed = { code, btn: b, timer };
        b.textContent = "确认删除";
        b.classList.add("armed");
        toast("再点一次「确认删除」");
        return;
      }
      disarmRowDelete();
      b.textContent = "删除";
      deleteStockFlow(code);
    };
  });
  // 整表重绘（红标/标签变化）时保留已经点过第一次的「确认删除」状态
  if (rowDelArmed.code) {
    const btn = document.querySelector(`.row[data-code="${rowDelArmed.code}"] [data-del]`);
    if (btn) {
      btn.textContent = "确认删除";
      btn.classList.add("armed");
      rowDelArmed.btn = btn;
    }
  }
}

/* 删个股：先看它在笔记里还有没有相关内容，有就问一句要不要一起删 */
async function doDeleteStock(code, withNotes) {
  try {
    const r = await api(`stocks/${code}${withNotes ? "?with_notes=1" : ""}`, { method: "DELETE" });
    closeSheet();
    const n = (r && r.notes_removed) || 0;
    toast(n ? `个股已删除，${n} 条笔记一起进了回收站` : "已删除，可在回收站找回");
    if (state.board) {
      state.board.stocks = state.board.stocks.filter((s) => s.code !== code);
      state.board.hold_count = state.board.stocks.filter((s) => s.bucket === "hold").length;
      state.board.watch_count = state.board.stocks.filter((s) => s.bucket !== "hold").length;
      applyBoard(state.board);
    }
    loadBoard(true).catch(() => {});
  } catch (err) {
    toast(err.message);
  }
}

async function deleteStockFlow(code) {
  const s = (state.board.stocks || []).find((x) => x.code === code);
  const name = s ? s.name : code;
  let rel = { count: 0, linked_count: 0, items: [] };
  try { rel = await api(`stocks/${code}/related-notes`); } catch (e) { /* 查不到按没有处理 */ }
  const linked = rel.linked_count || 0;
  const mentioned = (rel.count || 0) - linked;
  if (!rel.count) { await doDeleteStock(code, false); return; }
  const items = (rel.items || []).filter((it) => it.linked);
  const list = items.slice(0, 3).map((it) =>
    `<div class="flag-item read"><span class="flag-time">${esc((it.created_at || "").slice(5, 10))}</span>
       <span class="flag-txt">${esc(it.title)}</span></div>`).join("");
  const head = linked
    ? `<div class="field"><label>有 ${linked} 条笔记关联了「${esc(name)}」</label>
       ${list}${linked > 3 ? `<div class="muted tiny">… 另有 ${linked - 3} 条</div>` : ""}
       ${mentioned > 0 ? `<div class="muted tiny">另有 ${mentioned} 条正文提到「${esc(name)}」，不会删除</div>` : ""}</div>`
    : `<div class="field"><label>没有关联「${esc(name)}」的笔记</label>
       ${mentioned > 0 ? `<div class="muted tiny">正文里提到它的 ${mentioned} 条笔记会保留</div>` : ""}</div>`;
  const btns = linked
    ? `<button class="btn danger" id="del-stock-notes">一起删除（含 ${linked} 条笔记）</button>
       <button class="btn primary" id="del-stock-only">只删个股</button>`
    : `<button class="btn danger" id="del-stock-only">确认删除</button>`;
  openSheet(`${esc(name)} · 删除`, `${head}<div class="sheet-actions">${btns}<button class="btn ghost" data-close>取消</button></div>`);
  $("#del-stock-only").onclick = () => doDeleteStock(code, false);
  if (linked) $("#del-stock-notes").onclick = () => doDeleteStock(code, true);
}

$$(".toggle-tag").forEach((b) => b.addEventListener("click", () => {
  const on = !state.groupByTag.hold;
  state.groupByTag.hold = on;
  state.groupByTag.watch = on;
  $$(".toggle-tag").forEach((x) => (x.textContent = on ? "平铺" : "按标签"));
  renderBucket("hold");
  renderBucket("watch");
}));

/* ---------- stock sheet ---------- */
/* 弹层报价：SSE 每 3 秒推一次；SSE 不可用时退回 3 秒轮询（收盘只抓一次） */
let sheetQuoteTimer = null;
let sheetQuoteCode = "";
let sheetEventSource = null;
let sheetSseAt = 0;

