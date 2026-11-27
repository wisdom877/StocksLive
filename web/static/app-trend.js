const TREND_SORT_LABEL = { streak: "连涨", amount: "成交额", pe: "市盈率", total: "累计", pct: "涨幅", float_cap: "流通值" };
const TREND_SORT_DIR = { streak: "desc", amount: "desc", pe: "asc", total: "desc", pct: "desc", float_cap: "asc" };

function sortedTrendItems(items) {
  const arr = [...(items || [])];
  const dir = state.trendDir === "asc" ? 1 : -1;
  const tie = (a, b) => (b.streak - a.streak) || (b.pct - a.pct)
    || String(a.code).localeCompare(String(b.code));
  const peVal = (x) => (typeof x.pe === "number" && x.pe > 0 ? x.pe : null);
  const capVal = (x) => (typeof x.float_cap === "number" && x.float_cap > 0 ? x.float_cap : null);
  const amountVal = (x) => (typeof x.amount === "number" && x.amount > 0 ? x.amount : null);
  const totalVal = (x) => (typeof x.streak_total === "number" ? x.streak_total : null);
  // PE/流通值/累计的空值（含亏损 PE）无论正逆序都排最后。
  const cmpNullable = (av, bv) => {
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * dir;
  };
  switch (state.trendSort) {
    case "pe":
      arr.sort((a, b) => cmpNullable(peVal(a), peVal(b)) || tie(a, b));
      break;
    case "amount":
      arr.sort((a, b) => cmpNullable(amountVal(a), amountVal(b)) || tie(a, b));
      break;
    case "pct":
      arr.sort((a, b) => (a.pct - b.pct) * dir || tie(a, b));
      break;
    case "total":
      arr.sort((a, b) => cmpNullable(totalVal(a), totalVal(b)) || tie(a, b));
      break;
    case "float_cap":
      arr.sort((a, b) => cmpNullable(capVal(a), capVal(b)) || tie(a, b));
      break;
    default:
      arr.sort((a, b) => (a.streak - b.streak) * dir || tie(a, b));
  }
  return arr;
}

/* ETF 同名标的合并：银行ETF华夏/南方/华宝… 跟踪同一个指数，榜单里只留成交额最大的一只，
   其余放进「同类N只」，点开可以对比。名字里「ETF」之前的部分作为分组键。 */
function etfTrendGroupKey(name) {
  const s = String(name || "").trim();
  const i = s.indexOf("ETF");
  return i > 0 ? s.slice(0, i) : s;
}

function groupEtfTrendItems(items) {
  const pos = new Map((items || []).map((x, i) => [x.code, i]));
  const groups = new Map();
  (items || []).forEach((x) => {
    const k = etfTrendGroupKey(x.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  });
  const reps = [];
  groups.forEach((arr, key) => {
    const repPos = Math.min(...arr.map((x) => pos.get(x.code) ?? 0));
    arr.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)
      || (Number(b.float_cap) || 0) - (Number(a.float_cap) || 0));
    const rep = Object.assign({}, arr[0]);
    rep.same_index_count = arr.length;
    rep.same_key = key;
    rep._pos = repPos;
    reps.push(rep);
  });
  reps.sort((a, b) => a._pos - b._pos);
  state.trendGroupMap = groups;
  return reps;
}

function openTrendGroup(key) {
  const arr = (state.trendGroupMap && state.trendGroupMap.get(key)) || [];
  if (!arr.length) return;
  openSheet(`${key} · 同类 ETF`,
    arr.map((x) => `<div class="item grp-row" data-group-code="${x.code}" data-group-name="${esc(x.name)}">
        <div class="meta"><span class="badge digest">ETF</span><span>${esc(x.name)}</span><span class="tiny muted">${x.code}</span></div>
        <div class="grp-line">连涨 ${x.streak} 天 · 涨幅 ${pctText(x.pct)} · 成交额 ${trendAmountText(x.amount)} · 规模 ${capText(x.float_cap)}</div>
      </div>`).join(""));
  $$("#sheet .grp-row").forEach((row) => {
    row.onclick = () => {
      closeSheet();
      openHeatStock(row.dataset.groupCode, row.dataset.groupName);
    };
  });
}

function renderTrendDates(d) {
  const box = $("#trend-days");
  if (!box) return;
  const dates = (Array.isArray(d.dates) ? d.dates : []).slice(0, 5);
  state.trendDates = dates;
  if (!dates.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const cur = d.date;
  box.innerHTML = dates.map((dt, i) =>
    `<button class="chip ${dt === cur ? "on" : ""}" data-trend-day="${esc(dt)}" title="${esc(dt)}">${i === 0 ? "最新" : esc(dt.slice(5))}</button>`).join("");
}

/* 分片渲染：先画一屏，滑到底部自动追加下一片。417 张卡片一次全塞进 DOM 是手机端卡顿的主因 */
const _chunkCtl = new WeakMap();
function chunkPaint(container, rows, opts = {}) {
  if (!container) return;
  const size = Math.max(8, opts.size || 24);
  const bind = opts.bind || null;
  const st = { idx: 0, done: false, io: null };
  const old = _chunkCtl.get(container);
  if (old && old.io) old.io.disconnect();
  _chunkCtl.set(container, st);
  container.innerHTML = "";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn ghost small chunk-more";
  more.style.marginTop = "10px";
  const append = (first) => {
    if (st.done) return;
    const next = rows.slice(st.idx, st.idx + size);
    if (!next.length) { st.done = true; more.style.display = "none"; return; }
    st.idx += next.length;
    if (more.isConnected) more.remove();
    const tmp = document.createElement("div");
    tmp.innerHTML = next.join("");
    const added = [];
    while (tmp.firstElementChild) {
      const node = tmp.firstElementChild;
      tmp.removeChild(node);
      added.push(node);
      container.appendChild(node);
    }
    container.appendChild(more);
    if (bind) bind(container, added);
    st.done = st.idx >= rows.length;
    more.style.display = st.done ? "none" : "";
    more.textContent = st.done ? "" : `显示更多（还有 ${rows.length - st.idx} 条）`;
    if (first && !st.done) {
      st.io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { st.io.disconnect(); st.io = null; append(false); }
      }, { rootMargin: "300px 0px" });
      st.io.observe(more);
      // 兜底：页面有内层滚动容器，IO 偶发不触发时靠 scroll 兜一把
      const onScroll = () => {
        if (!more.isConnected) { document.removeEventListener("scroll", onScroll, true); return; }
        if (st.done) { document.removeEventListener("scroll", onScroll, true); return; }
        const r = more.getBoundingClientRect();
        if (r.top < (window.innerHeight || 800) + 260) {
          document.removeEventListener("scroll", onScroll, true);
          if (st.io) { st.io.disconnect(); st.io = null; }
          append(false);
        }
      };
      document.addEventListener("scroll", onScroll, true);
    }
  };
  more.onclick = () => append(false);
  append(true);
}

function bindTrendRows(list) {
  $$(".heat-row", list).forEach((r) => {
    r.onclick = (e) => {
      if (e.target.closest("[data-follow],[data-same]")) return;
      openHeatStock(r.dataset.code, r.dataset.name);
    };
  });
  $$("[data-same]", list).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openTrendGroup(decodeURIComponent(b.dataset.same || ""));
    };
  });
}

function renderTrend(d) {
  const note = $("#trend-note"), list = $("#trend-list");
  if (!note || !list) return;
  if (!d || d.available === false || d.ok === false) {
    state.trendData = null;
    const dayBox = $("#trend-days");
    if (dayBox) { dayBox.innerHTML = ""; dayBox.classList.add("hidden"); }
    note.textContent = (d && d.error) || "暂无扫描结果";
    list.innerHTML = `<div class="empty">${esc((d && d.hint) || "每天 15:30 收盘后自动扫描")}</div>`;
    return;
  }
  state.trendData = d;
  renderTrendDates(d);

  const isEtfResult = d.asset === "etf" || (d.items || []).some((x) => x && x.is_etf);
  if (isEtfResult && state.trendSort === "pe") state.trendSort = "streak";
  const rawItems = sortedTrendItems(d.items || []);
  const items = isEtfResult ? groupEtfTrendItems(rawItems) : rawItems;
  const when = String(d.generated_at || "").slice(5, 16);
  const badCodes = (d.failed_codes || []).slice(0, 5).map((x) => x.code).join(",");
  const fail = d.failed ? ` · 失败 ${d.failed}${badCodes ? `（${badCodes}${d.failed > 5 ? "…" : ""}）` : ""}` : "";
  const intra = d.intraday ? " · 盘中数据" : "";
  const stale = d.stale ? " · 今日扫描未完成" : "";
  const back = d.backfilled ? " · 历史回算" : "";
  const total = d.universe ? ` ${d.universe} 只` : "";
  const cover = d.universe
    ? ` · 已核对 ${d.covered ?? d.universe}/${d.universe}${d.coverage_ok === false ? "（异常）" : ""}`
    : "";
  const marketLabel = isEtfResult ? "沪深ETF" : "沪深主板";
  // 状态行只留看得懂的三个数：哪天、命中几只、什么时候扫的；池子/失败/覆盖率收进 title
  note.textContent = `${d.date ? d.date.slice(5) : ""} 收盘 · 命中 ${d.passed || 0} / 逐只核算 ${d.evaluated || 0} · ${when}${intra}${stale}`;
  const full = `${marketLabel}${total}${cover}${fail}`;
  note.title = d.backfilled
    ? `历史回算：连涨/MA/前复权 K 线为当时口径；成交额/量比/换手未回溯 · ${full}`
    : full;

  if (!items.length) {
    const what = isEtfResult ? "ETF" : "股票";
    const day = String(d.date || "").slice(5);
    // 空白页要能自己解释：哪天的、为什么空、下一步看哪里
    const prevDay = (state.trendDates || []).find((x) => x && x !== d.date) || "";
    // 空结果要把漏斗摊开：从全池到 0 是一步步筛掉的，不是没扫
    const fn = d.funnel || null;
    const funnelTxt = fn && fn.universe
      ? `${fn.universe} 只 → 连涨≥2 ${fn.evaluated} → 站上MA20 ${fn.above_ma20} → MA20向上 ${fn.ma20_up} → 多头排列 ${fn.bull} → 命中 ${fn.passed}`
      : "";
    list.innerHTML = `<div class="empty">${day || (d.is_history ? "该日期" : "今天")} 没有符合条件的${what}
      ${funnelTxt ? `<div class="tiny muted" style="margin-top:6px;line-height:1.6">${esc(funnelTxt)}</div>` : ""}
      <div class="tiny muted" style="margin-top:6px;line-height:1.6">当日普跌时「连涨≥2」这一条就会把绝大多数筛掉${prevDay ? "；下面是当天唯一有结果的近几日" : ""}</div>
      ${prevDay ? `<button type="button" class="btn ghost small" id="trend-jump" style="margin-top:10px">看 ${esc(prevDay.slice(5))} 的结果</button>` : ""}</div>`;
    const jb = $("#trend-jump");
    if (jb) jb.onclick = () => { state.trendDate = prevDay; loadTrend(false, prevDay); };
    return;
  }
  const isEtf = isEtfResult;
  // ETF 分两段：跨境/全球（513 开头）单独成组，方便按「全球」视角看；其余归 A 股
  const crossItems = isEtf ? items.filter((x) => /^513/.test(String(x.code || ""))) : [];
  const domItems = isEtf ? items.filter((x) => !/^513/.test(String(x.code || ""))) : items;
  const buildRow = (x) => {
    const isEtf = !!x.is_etf || isEtfResult;
    const src = (x.source === "sina_unadj" || x.source === "tx_unadj")
      ? '<span class="trend-new warn">不复权</span>' : "";
    const fresh = x.new_stock ? `<span class="trend-new">${isEtf ? "新ETF" : "次新"}</span>` : "";
    const listBadge = x.is_new
      ? '<span class="trend-badge new" title="首次进入趋势榜">今日新进</span>'
      : (Number(x.on_list_days) > 1
        ? `<span class="trend-badge repeat" title="连续在榜 ${Number(x.on_list_days)} 天">在榜${Number(x.on_list_days)}天</span>`
        : "");
    const sameBadge = isEtf && Number(x.same_index_count) > 1
      ? `<button type="button" class="trend-badge same" data-same="${encodeURIComponent(x.same_key || etfTrendGroupKey(x.name))}" title="同标的 ETF 已合并，点开对比">同类${Number(x.same_index_count)}只</button>`
      : "";
    const ovBadge = `<span class="trend-ov-slot" data-ov-code="${x.code}">${trendOverlapBadgeHtml(state.etfOverlap[x.code])}</span>`;
    const flags = trendFlags(x);
    const flagsHtml = flags.length
      ? `<div class="trend-flags">${flags.map(([t, c]) => `<span class="tflag ${c}">${t}</span>`).join("")}</div>`
      : "";
    const tag = trendTagHtml(x);
    const tagTitle = tag.title ? ` title="${esc(tag.title)}"` : "";
    const pe = trendPeText(x.pe);
    const vr = x.vol_ratio === null || x.vol_ratio === undefined
      ? "—" : Number(x.vol_ratio).toFixed(2);
    const turnover = x.turnover_rate === null || x.turnover_rate === undefined
      ? "—" : `${Number(x.turnover_rate).toFixed(2)}%`;
    const pb = x.pb === null || x.pb === undefined ? "—" : Number(x.pb).toFixed(2);
    const spark = trendSpark(x.spark, x.pct);
    const sparkHtml = spark
      ? `<span class="trend-spark-wrap" title="最近20个交易日走势">${spark}</span>`
      : "";
    const metsHtml = isEtf
      ? `<span><i>规模</i><b>${capText(x.float_cap)}</b></span>
         <span><i>成交额</i><b>${trendAmountText(x.amount)}</b></span>
         <span><i>量比</i><b>${vr}</b></span>
         <span><i>换手</i><b>${turnover}</b></span>`
      : `<span><i>PE</i><b>${pe}</b></span>
         <span><i>流通</i><b>${capText(x.float_cap)}</b></span>
         <span><i>量比</i><b>${vr}</b></span>
         <span><i>换手</i><b>${turnover}</b></span>`;
    const footHtml = isEtf
      ? `距MA20 ${trendPct(x.dist_ma20)} · MA20五日 ${trendPct(x.ma20_slope)}`
      : `距MA20 ${trendPct(x.dist_ma20)} · MA20五日 ${trendPct(x.ma20_slope)} · PB ${pb}`;
    return `<div class="heat-row trend-row" data-code="${x.code}" data-name="${esc(x.name)}">
      <div class="trend-top">
        <div class="rk"><b>${x.streak}</b><span>连涨</span></div>
        <div class="l">
          <div class="nm">${esc(x.name) || x.code}${listBadge}${fresh}${src}${sameBadge}${ovBadge}</div>
          <div class="cd"${tagTitle}>${x.code}${mktBadge(x.code)}${tag.html ? " · " + tag.html : ""}</div>
        </div>
        <div class="mid">
          <div class="${cls(x.pct)}">${pctText(x.pct)}</div>
          <div class="sub">${px(x.price)}</div>
        </div>
      </div>
      <div class="trend-mets">${metsHtml}</div>
      <div class="trend-days">${trendDaysHtml(x)}</div>
      ${flagsHtml}
      <div class="trend-foot">
        <span class="trend-sub-txt">${footHtml}</span>
        ${sparkHtml}
        ${followBtn(x.code)}
      </div>
    </div>`;
  };
  const groupHead = (t, em) => `<div class="trend-group-h"><span>${esc(t)}</span><em>${esc(em)}</em></div>`;
  const trendRows = (isEtf
    ? [crossItems.length ? groupHead("跨境 · 全球", `${crossItems.length} 只`) : "",
       ...crossItems.map(buildRow),
       domItems.length ? groupHead("A 股", `${domItems.length} 只`) : "",
       ...domItems.map(buildRow)]
    : items.map(buildRow)
  ).filter(Boolean);
  chunkPaint(list, trendRows, { size: isEtfResult ? 18 : 30, bind: bindTrendRows });

  $$("#trend-sort button").forEach((b) => {
    const on = b.dataset.sort === state.trendSort;
    b.classList.toggle("on", on);
    const label = b.dataset.label || TREND_SORT_LABEL[b.dataset.sort] || b.dataset.sort;
    // 用不换行空格，箭头不会掉到第二行（窄屏下 5 个按钮很挤）
    b.textContent = label + (on ? (state.trendDir === "asc" ? "\u00A0↑" : "\u00A0↓") : "");
  });
  bindTrendRows(list);
  if (isEtfResult) loadTrendOverlaps(items);
}

const _trendDaysBox = $("#trend-days");
if (_trendDaysBox) {
  _trendDaysBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-trend-day]");
    if (!b) return;
    const day = b.dataset.trendDay || "";
    const latest = state.trendDates[0] || "";
    state.trendDate = day === latest ? "" : day;
    loadTrend(false, state.trendDate);
  });
}

/* 板块标签筛选已下线（卡片内标签仅展示，取消注释可恢复）：
const _trendTagsBox = $("#trend-tags");
if (_trendTagsBox) {
  _trendTagsBox.addEventListener("click", (e) => {
    const b = e.target.closest("[data-trend-tag]");
    if (!b) return;
    setTrendFilter(b.dataset.trendTag);
  });
}
*/

const _trendSortBox = $("#trend-sort");
if (_trendSortBox) {
  _trendSortBox.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const sort = b.dataset.sort || "streak";
    if (sort === state.trendSort) {
      state.trendDir = state.trendDir === "asc" ? "desc" : "asc";
    } else {
      state.trendSort = sort;
      state.trendDir = TREND_SORT_DIR[sort] || "desc";
    }
    if (state.trendData) renderTrend(state.trendData);
  });
}

function openHeatStock(code, name) {
  const tracked = trackedOf(code);
  if (tracked) return openStock(code);
  if (isFundCode(code)) return openFundSheet(code, name);
  const etf = isEtfCode(code);
  const glb = !etf && isGlobalCode(code);
  const mode = etf ? "etf" : glb ? "global" : "";
  openSheet(
    `${esc(name) || code} · ${code}`,
    `${stockTabsHtml(etf)}
     <div id="stock-tab-chart">
       <div class="sheet-quote"><span class="q" id="sq-price">—</span>
         <span id="sq-pct" class="flat">—</span></div>
       ${qDetailHtml(mode)}
       <div class="kl-row" id="sq-kl"></div>
       ${kbarHtml(!glb, defaultKPeriod(), glb ? GLOBAL_K_PERIODS : null)}
     </div>
     <div id="stock-tab-company" class="hidden">
       <!-- 公司介绍已按用户要求去掉（代码保留，取消注释并恢复 loadProfile 调用即可）
       <div id="sq-profile" class="pf-card"><div class="empty">加载公司介绍…</div></div>
       -->
       ${etf ? '<div id="sq-etf-holdings"><div class="empty">加载持仓…</div></div><div id="sq-etf-overlap"><div class="tiny muted" style="margin:2px 0 8px">计算持仓重合…</div></div>' : '<div id="sq-flags"></div>'}
     </div>
     ${etf ? '<div id="stock-tab-news" class="hidden"><div id="sq-flags"></div></div>' : ""}
     <div id="h-ov-warn" class="etf-ov-warn hidden"></div>
     ${detailNotesHtml()}
     <div class="sheet-actions">
       <button class="btn ghost" id="sq-alert">提醒</button>
       <button class="btn primary" id="h-add">加入关注</button></div>`
  );
  bindStockTabs();
  mountDetailExtra(code, name || code);
  const note = $("#sq-note");
  if (note) note.textContent = "加载行情…";
  // loadProfile(code);   // 公司介绍已下线
  if (etf) {
    loadEtfHoldings(code, name).then(() => loadEtfOverlap(code, name));
    loadStockFlags(code, name);
  }
  bindKline(code, !glb, defaultKPeriod());
  if (glb) loadStockFlags(code, name || code);   // 港美的「最新新闻」也走同一个入口
  startSheetQuote(code);
  $("#h-add").onclick = async () => {
    const btn = $("#h-add");
    if (!btn || btn.disabled) return;
    const now = trackedOf(code);
    if (now) { toast(now.bucket === "hold" ? "已在持仓" : "已在关注"); return; }
    const ov = state.etfOverlap[code];
    if (ov && ov.level === "high" && btn.dataset.warned !== "1") {
      btn.dataset.warned = "1";
      btn.textContent = `重合约${Math.round(Number(ov.score) || 0)}%，再点确认`;
      clearTimeout(Number(btn.dataset.timer || 0));
      const timer = setTimeout(() => {
        if (!btn.isConnected) return;
        btn.dataset.warned = "0";
        btn.textContent = "加入关注";
      }, 3500);
      btn.dataset.timer = String(timer);
      return;
    }
    btn.disabled = true;
    btn.textContent = "添加中…";
    try {
      await createWatch(code, name);
      btn.textContent = "已关注";
      toast("已关注");
      closeSheet();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "加入关注";
      toast(e.message);
    }
  };
}

/* ---------- 全局搜索：个股 → 新闻 → 笔记 ---------- */
let gsTimer = null;
let gsSeq = 0;

function gsEl() { return $("#gsearch"); }
function gsOpen() { const b = gsEl(); return b && !b.classList.contains("hidden"); }

function openGlobalSearch(prefill) {
  const box = gsEl();
  if (!box) return;
  // 新闻页现在能点到顶栏搜索：搜索层必须压在新闻面板之上
  const dg = $("#digest");
  box.classList.toggle("above", !!(dg && !dg.classList.contains("hidden")));
  box.classList.remove("hidden");
  document.body.classList.add("gs-open");
  lockPageScroll(true, "gsearch");
  const inp = $("#gs-input");
  if (prefill != null) inp.value = prefill;
  setTimeout(() => { try { inp.focus(); } catch (e) {} }, 80);
  const q = inp.value.trim();
  if (q) doGlobalSearch(q);
  else paintGsEmpty();
}
/* 最近搜过的词：存在本地，最多 6 条；空态直接能点回去，比让人背代码实用 */
const GS_RECENT_KEY = "gs.recent.v1";
function gsRecent() {
  try { return (JSON.parse(localStorage.getItem(GS_RECENT_KEY) || "[]") || []).slice(0, 6); } catch (e) { return []; }
}
function gsRemember(q) {
  const t = String(q || "").trim();
  if (!t || t.length > 20) return;
  try {
    const list = gsRecent().filter((x) => x !== t);
    list.unshift(t);
    localStorage.setItem(GS_RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  } catch (e) { /* 本地存储被禁用就算了 */ }
}
function paintGsEmpty() {
  $("#gs-info").textContent = "";
  // 空态直接给「最近搜索 + 我的持仓/关注」两排入口，省得每次靠记代码
  const rows = ((state.board && state.board.stocks) || []).filter((x) => x && (x.bucket === "hold" || x.bucket === "watch"));
  const chips = rows.slice(0, 8).map((x) =>
    `<button type="button" class="chip gs-sug" data-gs-code="${esc(x.code)}">${esc(x.name || x.code)}</button>`).join("");
  const recent = gsRecent();
  const rChips = recent.map((q) =>
    `<button type="button" class="chip gs-sug gs-recent" data-gs-q="${esc(q)}">${esc(q)}</button>`).join("");
  $("#gs-body").innerHTML = `<div class="gs-empty">
      <div class="gs-empty-t">搜代码、搜基金，也能搜新闻</div>
      <div class="gs-empty-d">161725 · 贵州茅台 · 美联储</div>
      ${recent.length ? `<div class="gs-empty-h">最近搜索<button type="button" class="gs-clear" id="gs-clear">清除</button></div><div class="chips gs-sugs">${rChips}</div>` : ""}
      ${rows.length ? `<div class="gs-empty-h">我的持仓与关注</div><div class="chips gs-sugs">${chips}</div>` : ""}
      <div class="gs-empty-h">按条件找</div>
      <div class="chips gs-sugs">
        <button type="button" class="chip" data-gs-rule="pct3">涨幅 ≥3%</button>
        <button type="button" class="chip" data-gs-rule="amt1">成交额 ≥1亿</button>
        <button type="button" class="chip" data-gs-rule="pe20">PE ≤20</button>
      </div>
    </div>`;
  $$("[data-gs-rule]").forEach((b) => {
    b.onclick = () => {
      closeGlobalSearch();
      state.rankBy = "pct";
      state.rankFilters = state.rankFilters || {};
      state.rankFilters[b.dataset.gsRule] = true;
      activateView("hold");
      setHoldTab("market");
      $$("#rank-filter button").forEach((x) => x.classList.toggle("on", !!state.rankFilters[x.dataset.f]));
      setTimeout(() => { loadRank(); const el = $("#rank-seg"); if (el) el.scrollIntoView({ block: "start" }); }, 300);
    };
  });
  const clearBtn = $("#gs-clear");
  if (clearBtn) clearBtn.onclick = () => { try { localStorage.removeItem(GS_RECENT_KEY); } catch (e) {} paintGsEmpty(); };
  $$("[data-gs-q]").forEach((b) => {
    b.onclick = () => {
      const q = b.dataset.gsQ;
      $("#gs-input").value = q;
      doGlobalSearch(q);
    };
  });
  $$("[data-gs-code]").forEach((b) => {
    b.onclick = () => {
      const code = b.dataset.gsCode;
      closeGlobalSearch();
      openStock(code);
    };
  });
}
function closeGlobalSearch({ keepInput = false } = {}) {
  const box = gsEl();
  if (!box || box.classList.contains("hidden")) return;
  box.classList.add("hidden");
  box.classList.remove("above");
  // 搜索层收起后底栏恢复；新闻面板本身现在也保留底栏
  document.body.classList.remove("gs-open");
  lockPageScroll(false, "gsearch");
  clearTimeout(gsTimer);
  gsSeq++;
  const inp = $("#gs-input");
  if (inp) { if (!keepInput) inp.value = ""; inp.blur(); }
}
async function doGlobalSearch(q) {
  const seq = ++gsSeq;
  const body = $("#gs-body");
  body.innerHTML = `<div class="empty">搜索中…</div>`;
  const d = await api(`global-search?q=${encodeURIComponent(q)}`).catch(() => ({ stocks: [], news: [], notes: [], marks: [] }));
  if (seq !== gsSeq) return;
  renderGlobalSearch(d, q);
}

function gsTime(n) {
  const src = n.published_at || n.day || n.created_at || "";
  return String(src).slice(5, 16);
}
/* 搜索行内动作只用图标，不带文字（用户 2026-10-31 要求） */
const GS_ICO = {
  star: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8l2.6 5.2 5.8.85-4.2 4.08 1 5.77L12 16.98l-5.2 2.72 1-5.77L3.6 9.85l5.8-.85z"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M12 3.8l2.6 5.2 5.8.85-4.2 4.08 1 5.77L12 16.98l-5.2 2.72 1-5.77L3.6 9.85l5.8-.85z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.6 2.6 0 0 0-3.7-3.7L4 16.4V20z"/><path d="M13.6 7.1l3.3 3.3"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.8 7l.8 12.2h8.8L17.2 7"/><path d="M10.2 10.8v5.2M13.8 10.8v5.2"/></svg>',
};
function renderGlobalSearch(d, q) {
  // 后端个股是逐字模糊匹配：搜「美联储」会带出「美联新材」「联美控股」。
  // 名称或代码不完整包含关键词的，降级为「可能相关」放在后面，别混在正命中里。
  const raw = d.stocks || [];
  const hit = raw.filter((x) => String(x.name || "").includes(q) || String(x.code || "").includes(q));
  const soft = raw.filter((x) => !hit.includes(x));
  const newsN = (d.news || []).length;
  // 一个名称/代码都不完整命中时：只有连新闻也没有，才把模糊结果兜底列出来并标明
  const stocks = hit.length ? hit : (newsN ? [] : raw.slice(0, 3));
  const fuzzyOnly = !hit.length && stocks.length;
  const news = d.news || [];
  const notes = d.notes || [];
  const marks = d.marks || [];
  $("#gs-info").textContent = stocks.length || news.length || notes.length || marks.length
    ? `搜索「${q}」 · 个股 ${stocks.length} · 新闻 ${news.length} · 记录 ${notes.length} · 批注 ${marks.length}`
    : "";
  const sec = (title, n, html, extraClass = "") =>
    `<div class="gs-sec ${extraClass}"><div class="gs-h">${title}<span class="tiny muted">${n}</span></div>${html}</div>`;
  let out = "";
  if (stocks.length) {
    out += sec(fuzzyOnly ? "个股<span class=\"tiny muted\">（名称未命中，可能相关）</span>" : "个股", stocks.length, stocks.map((x) => {
      const pxTxt = x.price ? px(x.price) : "";
      const mid = x.price
        ? `<div class="mid"><div class="${cls(x.pct)}">${pctText(x.pct)}</div></div>`
        : `<div class="mid"><div class="tiny muted">—</div></div>`;
      const mark = x.tracked === "hold" ? '<span class="gs-mark hold">持仓</span>'
        : x.tracked === "watch" ? '<span class="gs-mark watch">关注</span>' : "";
      return `<div class="heat-row" data-code="${x.code}" data-name="${esc(x.name)}">
        <div class="rk">${x.market === "fund" || String(x.type || "").includes("基金") ? "基" : (x.type || "").includes("ETF") ? "ETF" : "股"}</div>
        <div class="l"><div class="nm">${esc(x.name)}${mark}</div><div class="cd">${x.code}${x.market === "fund" ? '<span class="mkt-badge mk-fund">基金</span>' : mktBadge(x.code)}${pxTxt ? " · " + pxTxt : ""}</div></div>
        ${mid}
        <div class="gs-acts">${followBtn(x.code)}${holdBtn(x.code)}</div>
      </div>`;
    }).join(""));
  }
  if (news.length) {
    out += sec("新闻", news.length, news.map((n) => {
      const cat = n.category || "";
      const lv = (n.level || "").toUpperCase();
      return `<div class="gs-item" data-gs-news="${n.id}">
        <div class="gs-note-head">
          <div class="gs-meta">${gsTime(n)}${cat ? ` · ${esc(cat)}` : ""}${lv ? ` · <b class="lv-${lv}">${lv}</b>` : ""}</div>
          <div class="gs-acts">
            <button class="ico${n.saved ? " on" : ""}" data-gs-save="${n.id}" aria-label="${n.saved ? "取消收藏" : "收藏"}">${n.saved ? GS_ICO.starOn : GS_ICO.star}</button>
          </div>
        </div>
        <div class="gs-txt clamp gs-clamp">${esc(n.title || "")}</div>
        <div class="gs-more">点击展开</div>
      </div>`;
    }).join(""));
  }
  if (notes.length) {
    out += sec("记录", notes.length, notes.map((n) => {
      const kind = n.kind === "analysis" ? "分析" : n.kind === "news" ? "新闻" : "记录";
      const ans = n.kind === "analysis" ? (String(n.answer || "").trim() ? '<span class="gs-mark done">已回答</span>' : '<span class="gs-mark todo">待回答</span>') : "";
      return `<div class="gs-item" data-gs-note="${n.id}">
        <div class="gs-note-head">
          <div class="gs-meta">${esc(String(n.created_at || "").slice(5, 16))} · ${kind}${ans}</div>
          <div class="gs-acts">
            <button class="ico" data-gs-edit="${n.id}" aria-label="编辑">${GS_ICO.edit}</button>
            <button class="ico del" data-gs-del="${n.id}" aria-label="删除">${GS_ICO.del}</button>
          </div>
        </div>
        <div class="gs-txt clamp">${esc(n.content || "")}</div>
      </div>`;
    }).join(""));
  }
  if (marks.length) {
    out += sec("批注", marks.length, marks.map((m) => {
      const note = String(m.note || "").trim();
      return `<div class="gs-item" data-gs-mark="${m.id}">
        <div class="gs-note-head">
          <div class="gs-meta">${esc(String(m.day || "").slice(5))} ${esc(m.slot === "pm" ? "晚" : "早")} · ${m.style === "red" ? "标红" : m.style === "underline" ? "下划线" : "批注"}</div>
        </div>
        <div class="gs-txt mk-gs-quote">“${esc(digestQuoteLabel(m.quote))}”</div>
        ${note ? `<div class="gs-txt mk-gs-note">${esc(note)}</div>` : ""}
      </div>`;
    }).join(""));
  }
  stocks.forEach((x) => { if (x.market === "fund") markFund(x.code); });
  if (out) gsRemember(q);
  $("#gs-body").innerHTML = out || `<div class="empty">没有找到「${esc(q)}」，换个关键词试试</div>`;
  bindClamp($("#gs-body"));
  $$("#gs-body .heat-row").forEach((r) => {
    r.onclick = (e) => {
      if (e.target.closest("[data-follow],[data-hold]")) return;
      closeGlobalSearch();
      openHeatStock(r.dataset.code, r.dataset.name);
    };
  });
  $$("#gs-body [data-gs-news]").forEach((el) => {
    const txt = $(".gs-txt", el);
    const more = $(".gs-more", el);
    // 两行装得下就不显示「点击展开」
    if (txt && more && txt.scrollHeight <= txt.clientHeight + 2) more.classList.add("hidden");
    el.onclick = (e) => {
      if (e.target.closest("[data-gs-save]")) return;
      if (!txt) return;
      txt.classList.toggle("open");
      if (more) more.textContent = txt.classList.contains("open") ? "收起" : "点击展开";
    };
  });
  $$("#gs-body [data-gs-note]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("[data-gs-edit],[data-gs-del]")) return;
      const n = notes.find((x) => String(x.id) === el.dataset.gsNote);
      if (!n) return;
      const ans = String(n.answer || "").trim();
      openSheet(KIND_LABEL[n.kind] || "记录", `<div class="tiny muted" style="margin-bottom:8px">${esc(String(n.created_at || "").slice(0, 16))}</div>
        <div class="ana-body" style="white-space:pre-wrap">${esc(n.content || "")}</div>
        ${n.kind === "analysis" ? `<div class="ana-ans ${ans ? "answered" : "pending"}" style="margin-top:10px"><div class="aa-t">${ans ? "✅ 已回答" : "⏳ 待回答"}</div>${ans ? `<div class="aa-b">${esc(ans).replace(/\n/g, "<br>")}</div>` : ""}</div>` : ""}`);
    };
  });
  $$("#gs-body [data-gs-mark]").forEach((el) => {
    el.onclick = () => openDigestAtMark(el.dataset.gsMark);
  });
  const research = () => { const q = ($("#gs-input").value || "").trim(); if (q) doGlobalSearch(q); };
  // 未收藏新闻：★ 一键收藏（收藏后会作为「新闻记录」出现在记录块，新闻块里不再重复）
  $$("#gs-body [data-gs-save]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.dataset.busy === "1") return;
      const id = b.dataset.gsSave;
      const n = news.find((x) => String(x.id) === id);
      const want = !(n && n.saved);
      b.dataset.busy = "1";
      b.disabled = true;
      try {
        await api(`news/${id}/save`, { method: "POST", body: { saved: want ? 1 : 0 } });
        toast(want ? "已收藏" : "已取消收藏");
        if (n) n.saved = want ? 1 : 0;
        loadFeed(true).catch(() => {});
        loadNotes().catch(() => {});
        loadBoard(true).catch(() => {});
        research();
      } catch (err) {
        toast(err.message);
        b.dataset.busy = "0";
        b.disabled = false;
      }
    };
  });
  $$("#gs-body [data-gs-edit]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const n = notes.find((x) => String(x.id) === b.dataset.gsEdit);
      if (n) editNote(n, research);
    };
  });
  // 删除＝两下：第一次只变红待确认，3.2 秒内再点才真删（与记录页一致）
  $$("#gs-body [data-gs-del]").forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      if (b.dataset.busy === "1") return;
      const id = b.dataset.gsDel;
      if (b.dataset.armed !== "1") {
        b.dataset.armed = "1";
        b.classList.add("armed");
        clearTimeout(Number(b.dataset.timer || 0));
        const timer = setTimeout(() => {
          if (!b.isConnected) return;
          b.dataset.armed = "0";
          b.classList.remove("armed");
        }, 3200);
        b.dataset.timer = String(timer);
        toast("再点一次删除");
        return;
      }
      b.dataset.armed = "0";
      clearTimeout(Number(b.dataset.timer || 0));
      b.classList.remove("armed");
      b.dataset.busy = "1";
      b.disabled = true;
      b.classList.add("busy");
      try {
        await api(`notes/${id}`, { method: "DELETE" });
        toast("已删除，可在回收站找回");
        await loadNotes().catch(() => {});
        loadBoard(true).catch(() => {});
        research();
      } catch (err) {
        toast(err.message);
        b.dataset.busy = "0";
        b.disabled = false;
        b.classList.remove("busy");
      }
    };
  });
}

$("#btn-gsearch").addEventListener("click", () => openGlobalSearch());
$("#gs-cancel").addEventListener("click", () => closeGlobalSearch());
$("#gs-input").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(gsTimer);
  if (!q) { gsSeq++; paintGsEmpty(); return; }
  gsTimer = setTimeout(() => doGlobalSearch(q), 280);
});
$("#gs-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeGlobalSearch();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && gsOpen()) closeGlobalSearch();
});
// 系统返回键：优先关掉搜索层
window.addEventListener("popstate", () => {
  if (gsOpen()) closeGlobalSearch();
});

/* ---------- 市场行情 ---------- */
function setMktTab(mtab) {
  state.mktTab = mtab === "analysis" ? "analysis" : mtab === "hot" ? "hot" : "quote";
  $$("#mkt-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mtab === state.mktTab));
  $("#mkt-quote").classList.toggle("hidden", state.mktTab !== "quote");
  $("#mkt-analysis-panel").classList.toggle("hidden", state.mktTab !== "analysis");
  const hot = $("#mkt-hot");
  if (hot) hot.classList.toggle("hidden", state.mktTab !== "hot");
  if (state.mktTab === "analysis") loadAnalysis().catch(() => {});
  else if (state.mktTab === "hot") {
    loadAnalysis().catch(() => {});
    if (marketOpen() && (!state.hotAt || Date.now() - state.hotAt > 60000)) loadHot(true, true).catch(() => loadHot().catch(() => {}));
    else loadHot().catch(() => {});
  } else loadMarket();
}
$("#mkt-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const same = state.mktTab === b.dataset.mtab;
  setMktTab(b.dataset.mtab);
  if (same) refreshPane(b.dataset.mtab === "analysis" ? "analysis" : "market");
});

function setHoldTab(tab) {
  const prev = state.holdTab;
  // 记住每一段落到了哪里，切回来不跳回顶部
  if (state.view === "hold" && prev && prev !== tab) {
    state.holdScroll = state.holdScroll || {};
    state.holdScroll[prev] = window.scrollY;
  }
  state.holdTab = tab;
  $$("#hold-seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#hold-mine").classList.toggle("hidden", tab !== "mine");
  $("#hold-watch").classList.toggle("hidden", tab !== "watch");
  $("#hold-market").classList.toggle("hidden", tab !== "market");
  if (tab === "market") { setMktTab(state.mktTab); setTimeout(() => loadRank(), 200); }
  else if (tab === "watch") {
    if (state.watchTab === "trend") loadTrend(false, state.trendDate);
    else loadBoard().catch(() => {});
  } else loadBoard().catch(() => {});
  const y = (state.holdScroll || {})[tab] || 0;
  requestAnimationFrame(() => { try { window.scrollTo(0, y); } catch (e) {} });
  schedulePoll();
}
// 排行跟着「跨市场」的市场走：港美没有换手与 PE，切过去就退回涨幅榜并收起筛选项
function syncRankMarket() {
  const nonA = (state.xmktTab || "a") !== "a";
  const flt = $("#rank-filter"); if (flt) flt.classList.toggle("hidden", nonA);
  const to = $('#rank-seg button[data-by="turnover"]'); if (to) to.classList.toggle("hidden", nonA);
  if (nonA) {
    state.rankBy = "pct";
    $$("#rank-seg button").forEach((x) => x.classList.toggle("on", x.dataset.by === state.rankBy));
    state.rankFilters = {};
    if (flt) $$("#rank-filter button").forEach((x) => x.classList.remove("on"));
  }
}
$("#rank-seg") && $("#rank-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-by]");
  if (!b) return;
  state.rankBy = b.dataset.by;
  $$("#rank-seg button").forEach((x) => x.classList.toggle("on", x.dataset.by === state.rankBy));
  loadRank();
});
$("#rank-filter") && $("#rank-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  state.rankFilters = state.rankFilters || {};
  state.rankFilters[b.dataset.f] = !state.rankFilters[b.dataset.f];
  b.classList.toggle("on", !!state.rankFilters[b.dataset.f]);
  loadRank();
});
$("#xmkt-seg") && $("#xmkt-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mk]");
  if (!b) return;
  state.xmktTab = b.dataset.mk;
  renderXmkt();
  syncRankMarket();
  if (state.holdTab === "market") loadRank();
});
$("#hold-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const same = state.holdTab === b.dataset.tab;
  setHoldTab(b.dataset.tab);
  if (same) refreshPane(b.dataset.tab === "market" ? "market" : b.dataset.tab === "watch" ? "watch" : "hold");
});

// 手动刷新：行情四块一起打穿后端缓存，个股涨幅也顺手刷新，切回持仓不用等轮询
async function refreshMarketAll() {
  _memo.delete("board");
  await Promise.all([loadMarket(true, true), loadBoard(true).catch(() => {})]);
}


async function loadMarket(force, forceServer, quiet) {
  // 3s 内（收盘 24s）来回切页直接用上次结果，不再走隧道
  const hit = !force && memoFresh("market", liveTtl(3000));
  if (hit) {
    if (state.mkt !== hit) { state.mkt = hit; renderMarket(hit); }
    return;
  }
  const at = $("#mkt-at");
  const skel = $("#mkt-skel"), errBox = $("#mkt-err");
  if (errBox) errBox.classList.add("hidden");
  // 刷新期间只留骨架屏：旧数据留在页面上会和骨架屏混在一起，看起来像「没刷好」
  // 但轮询（quiet）千万别这么干：每 3 秒把整块换成骨架再换回来，就是用户说的"页面一直抖"
  const quote = $("#mkt-quote");
  const firstLoad = !state.mkt;
  const showSkel = !quiet && (firstLoad || !!forceServer);
  if (quote && showSkel) quote.classList.add("busy");
  if (skel && showSkel) skel.classList.remove("hidden");
  if (showSkel && (!at.textContent || at.textContent === "加载失败")) at.textContent = "刷新中…";
  const keepY = quiet ? window.scrollY : 0;
  // 自动轮询只绕前端缓存；手动 ↻ 才带 force 真正打穿后端的涨跌家数/外盘缓存
  // 手动刷新要重抓 50+ 页涨跌家数，给足超时（nginx 30s 内）；不重试，避免连等两轮
  const autoPoll = force && !forceServer;
  const d = await api(
    forceServer ? "market?force=1" : "market",
    forceServer || autoPoll ? { noRetry: true } : {},
    forceServer ? 25000 : 15000,
  ).catch(() => null);
  if (skel) skel.classList.add("hidden");
  if (quote) quote.classList.remove("busy");
  if (!d) {
    if (!showSkel) return;   // 轮询失败就静默保持旧数据，别把页面改成"加载失败"
    at.textContent = "加载失败";
    // 首次就失败：给出明确的失败态和重试入口，而不是永远停在「刷新中…」
    if (errBox && !state.mkt) errBox.classList.remove("hidden");
    return;
  }
  if (errBox) errBox.classList.add("hidden");
  memoSet("market", d);
  state.mkt = d;
  renderMarket(d);
  // 轮询时把滚动位置还回去：内容高度偶有变化，不还原就会在用户眼前上下窜
  if (quiet && keepY) window.scrollTo(0, keepY);
}

/* 行情页失败态的重试按钮 */
function bindMarketRetry() {
  const btn = $("#mkt-retry");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.onclick = async () => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "重试中…";
    try { await loadMarket(true, true); } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
}


function fitTurnoverNote() {
  // 成交额大字 + 放量/昨日小字必须在同一行：放不下就缩字号（最小 9px），绝不换行
  const row = $("#mkt-turnover .tk-bigrow");
  const note = row && row.querySelector(".tk-note");
  if (!note) return;
  let fs = 11;
  note.style.fontSize = fs + "px";
  const limit = () => row.getBoundingClientRect().right - 0.5;
  while (fs > 9 && note.getBoundingClientRect().right > limit()) {
    fs -= 0.5;
    note.style.fontSize = fs + "px";
  }
}
window.addEventListener("resize", fitTurnoverNote);

/* ---------- 全市场排行（A 股 ETF 全场，market.db 夜批固化） ---------- */
const RANK_FILTERS = { pct3: { min_pct: 3 }, amt1: { min_amount: 1e8 }, pe20: { max_pe: 20 } };

async function loadRank() {
  const box = $("#rank-list");
  if (!box) return;
  const by = state.rankBy || "pct";
  const on = state.rankFilters || {};
  // 排行跟着上面「跨市场」选的市场走，不再单独一排 chip
  const mk = ["a", "hk", "us"].indexOf(state.xmktTab) >= 0 ? state.xmktTab : "a";
  const qs = new URLSearchParams({ market: mk, by, limit: "25" });
  Object.entries(RANK_FILTERS).forEach(([k, v]) => {
    if (on[k]) Object.entries(v).forEach(([kk, vv]) => qs.set(kk, String(vv)));
  });
  if (state.xmktTab === "global") {
    box.innerHTML = `<div class="rank-row"><span class="rk-n muted">全球只有指数快照，没有个股榜单</span></div>`;
    return;
  }
  box.innerHTML = `<div class="rank-row"><span class="rk-n muted">读取中…</span></div>`;
  let d = null;
  try { d = await api(`rank?${qs.toString()}`, { noRetry: true }, 12000); } catch (e) { d = null; }
  if (!d || !(d.items || []).length) {
    box.innerHTML = `<div class="rank-row"><span class="rk-n muted">${d ? "这一组条件下没有标的" : "排行数据还没有生成"}</span></div>`;
    return;
  }
  const at = $("#rank-at");
  if (at) at.textContent = `${mk === "a" ? "A股 ETF" : mk === "hk" ? "港股" : "美股"} · ${d.date ? String(d.date).slice(5) : ""} 收盘 · ${d.total} 只`;
  const cur = mk === "hk" ? "HK$" : mk === "us" ? "$" : "¥";
  const val = (x) => by === "amount" ? `${num((x.amount || 0) / 1e8, 2)} 亿`
    : by === "turnover" ? (x.turnover ? `${num(x.turnover, 2)}%` : "—")
    : (x.price ? (mk === "a" ? num(x.price, 3) : cur + num(x.price, 2)) : "—");
  box.innerHTML = d.items.map((x, i) => `<button type="button" class="rank-row" data-code="${esc(x.code)}" data-name="${esc(x.name)}">
      <span class="rk-i">${i + 1}</span>
      <span class="rk-n">${esc(x.name)}<span class="rk-c">${esc(x.code)}</span></span>
      <span class="rk-v ${cls(x.pct)}">${pctText(x.pct)}</span>
      <span class="rk-x">${val(x)}</span>
    </button>`).join("");
  $$("#rank-list [data-code]").forEach((b) => {
    b.onclick = () => { try { openHeatStock(b.dataset.code, b.dataset.name); } catch (e) { toast("打不开这只"); } };
  });
}

/* 跨市场四段：数据都来自本次 market 响应与 global-markets（港股/美股指数） */
function renderXmkt() {
  const d = state.mktData || {};
  const tab = state.xmktTab || "a";
  let items = [];
  if (tab === "a") items = (d.a || []).map((x) => ({ name: String(x.name || "").replace("指数", ""), price: x.price, pct: x.pct }));
  else if (tab === "hk") items = ((state.xmkt && state.xmkt.hk) || []);
  else if (tab === "us") items = ((state.xmkt && state.xmkt.us) || []);
  else items = (d.global || []).map((x) => ({ name: x.name, price: x.price, pct: x.pct }));
  const box = $("#mkt-global");
  if (!box) return;
  box.innerHTML = items.length
    ? items.map((x) => `<div class="idx-cell">
        <div class="i-nm">${esc(x.name)}</div>
        ${x.price ? `<div class="i-px ${cls(x.pct)}">${num(x.price, 2)}</div>` : ""}
        <div class="i-pc ${cls(x.pct)}">${pctText(x.pct)}</div>
      </div>`).join("")
    : `<div class="empty">这段暂时没有数据</div>`;
  const atBox = $("#mkt-global-at");
  if (atBox) {
    if (tab === "a") atBox.textContent = d.quotes_at ? `最新 ${d.quotes_at}` : "";
    else if (tab === "global") atBox.textContent = d.global_at ? `最新 ${d.global_at}` : "";
    else {
      const hhmm = items[0] && items[0].time ? String(items[0].time).slice(-8, -3) : "";
      atBox.textContent = hhmm ? `延时 · ${hhmm}` : "延时行情";
    }
  }
  $$("#xmkt-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mk === tab));
}

function renderMarket(d) {
  if (d.market) renderMarketPill(d.market);  // 收盘后自动把轮询降回 60s
  const b = d.breadth || {};
  const qStale = !!d.quotes_stale || (d.a || []).some((x) => x.stale);
  // 延迟统一在顶部提示一次，下面的全球指数/期货不再各自重复「延迟」
  const anyStale = qStale || !!d.global_stale || !!d.commodity_stale || (d.global || []).some((x) => x.stale);
  $("#mkt-at").textContent =
    `最新 ${d.quotes_at || "—"}${b.at ? ` · 涨跌家数 ${b.at}` : ""}${b.stale ? " · 沿用上次" : ""}${anyStale ? " · 部分数据延迟" : ""}`;
  const gAt = $("#mkt-global-at");
  if (gAt) gAt.textContent = d.global_at ? `最新 ${d.global_at}` : "";
  const cAt = $("#mkt-commodity-at");
  if (cAt) cAt.textContent = d.commodity_at ? ` · 最新 ${d.commodity_at}` : "";
  const t = d.turnover || {};
  const idxCells = (d.a || []).map((x) => `<div class="idx-cell">
      <div class="i-nm">${esc(String(x.name || "").replace("指数", ""))}</div>
      <div class="i-px ${cls(x.pct)}">${num(x.price, 2)}</div>
      <div class="i-pc ${cls(x.pct)}">${pctText(x.pct)}</div>
    </div>`).join("");
  // 涨跌家数：成交额下面一行三组
  const bd = b.total
    ? `<div class="tk-bd-row">
        <span>涨<b class="up">${b.up || 0}</b></span>
        <span>平<b class="flat">${b.flat || 0}</b></span>
        <span>跌<b class="down">${b.down || 0}</b></span>
      </div>`
    : "";
  // 休市日当天成交额为 0：不要显示「缩量 -100%」，直接标休市并给出昨日成交额
  const note = !t.total
    ? (t.prev ? `<b class="muted">休市</b> · 昨日 ${t.prev_text}` : `<b class="muted">休市</b>`)
    : t.prev
    ? `<b class="${t.diff >= 0 ? "up" : "down"}">${t.tag} ${t.diff_text}${
        t.pct !== null ? `（${t.pct > 0 ? "+" : ""}${t.pct}%）` : ""
      }</b> · 昨日 ${t.prev_text}`
    : "";
  $("#mkt-turnover").innerHTML = `<div class="card turnover">
      <div class="tk-label">两市成交额${t.intraday ? "（盘中）" : ""}</div>
      <div class="tk-bigrow">
        <span class="tk-big">${t.total ? t.text : "—"}</span>
        <span class="tk-note">${note}</span>
      </div>
      ${bd}
      <div id="mkt-a" class="idx-strip">${idxCells}</div>
    </div>`;
  // 成交额 + 放量/昨日：必须在同一行，窄屏自动缩字号（最小 9px，不换行）
  fitTurnoverNote();
  // 跨市场：A股 / 港股 / 美股 / 全球 四段切换，同一套小格子
  state.mktData = d;
  if (!state.xmktAt || Date.now() - state.xmktAt > 120000) {
    state.xmktAt = Date.now();
    api("global-markets", { noRetry: true }, 9000)
      .then((x) => { state.xmkt = x; renderXmkt(); })
      .catch(() => {});
  }
  renderXmkt();
  const groups = d.commodity_groups || [];
  $("#mkt-commodity").innerHTML = groups.length
    ? groups.map((g) => `<div class="cmd-card">
        <div class="cmd-h">${esc(g.name)}</div>
        ${(g.items || []).map((x) => `<div class="cmd-row${x.stale ? " stale" : ""}">
          <span class="cn">${esc(x.name)}</span>
          <span class="cp">${num(x.price, x.price >= 1000 ? 0 : 2)}</span>
          <span class="cpc ${cls(x.pct)}">${pctText(x.pct)}</span>
        </div>`).join("")}
      </div>`).join("")
    : `<div class="card"><div class="tiny muted">商品行情暂时获取失败</div></div>`;
  // 商品卡片没有 K 线，不挂点击
  $$("#hold-market .mkt-card").forEach((r) => {
    r.onclick = () => openIndexSheet(r.dataset.name, r.dataset.code, Number(r.dataset.price), Number(r.dataset.pct), r.dataset.k === "1");
  });
}

function openIndexSheet(name, code, price, pct, canKline) {
  if (!canKline) {
    openSheet(name, `<div class="sheet-quote"><span class="q">${num(price, 2)}</span>
      <span class="${cls(pct)}">${pctText(pct)}</span></div>
      <p class="tiny muted">该指数暂无 K 线数据（外盘/商品只提供最新报价）</p>`);
    return;
  }
  openSheet(name, `<div class="sheet-quote"><span class="q">${num(price, 2)}</span>
      <span class="${cls(pct)}">${pctText(pct)}</span></div>${kbarHtml(false, "day")}`);
  bindKline(code, false, "day");
}

/* ---------- 标签选股 ---------- */
const TAG_SORTS = [
  ["purity", "纯度", "asc"],
  ["pct", "涨幅", "desc"],
  ["float_cap", "流通市值", "desc"],
  ["pe", "市盈率", "asc"],
];
const TAG_PURITY = { all: "全部", clean: "核心+相关", core: "只看核心", hidden: "已隐藏" };

function renderTagPurityButtons() {
  const hidden = (state.tagItems || []).filter((x) => x.hidden).length;
  $$("#tag-purity button").forEach((b) => {
    const key = b.dataset.purity || "all";
    b.classList.toggle("on", key === state.tagPurity);
    b.textContent = key === "hidden" && hidden ? `已隐藏 ${hidden}` : (TAG_PURITY[key] || b.textContent);
  });
}

function tagSortLabel() {
  const row = TAG_SORTS.find(([k]) => k === state.tagSort) || TAG_SORTS[0];
  return row[1] + (state.tagDir === "asc" ? "↑" : "↓");
}

function renderTagSortButtons() {
  $$("#tag-sort button").forEach((b) => {
    const row = TAG_SORTS.find(([k]) => k === b.dataset.sort);
    const active = row && row[0] === state.tagSort;
    b.classList.toggle("on", !!active);
    b.textContent = row ? row[1] + (active ? (state.tagDir === "asc" ? "↑" : "↓") : "") : b.textContent;
  });
}

async function loadTagPick() {
  const box = $("#tag-chips");
  if (!box) return;
  if (!box.dataset.ready) {
    const d = await api("tags").catch(() => ({ hot: [], mine: [] }));
    const list = [];
    const seen = new Set();
    (d.hot || []).forEach((x) => {
      if (x.name && !seen.has(x.name)) { seen.add(x.name); list.push({ name: x.name, pct: x.pct }); }
    });
    (d.mine || []).forEach((n) => {
      if (n && !seen.has(n)) { seen.add(n); list.push({ name: n, pct: null }); }
    });
    state.tagAll = list;
    box.dataset.ready = "1";
  }
  renderTagChips();
  renderTagSortButtons();
  renderTagPurityButtons();
  if (!state.tagSortBound) {
    state.tagSortBound = true;
    $$("#tag-sort button").forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.sort;
        if (state.tagSort === key) {
          state.tagDir = state.tagDir === "asc" ? "desc" : "asc";
        } else {
          const row = TAG_SORTS.find(([k]) => k === key);
          state.tagSort = key;
          state.tagDir = row ? row[2] : "desc";
        }
        state.tagShown = 100;
        renderTagSortButtons();
        if (state.tagName) renderTagList();
      };
    });
  }
  if (!state.tagPurityBound) {
    state.tagPurityBound = true;
    $$("#tag-purity button").forEach((b) => {
      b.onclick = () => {
        state.tagPurity = b.dataset.purity || "all";
        state.tagShown = 100;
        try {
          if (state.tagPurity === "clean" || state.tagPurity === "core") {
            localStorage.setItem("tagPurity", state.tagPurity);
          } else {
            localStorage.removeItem("tagPurity");
          }
        } catch {}
        renderTagPurityButtons();
        if (state.tagName) renderTagList();
      };
    });
  }
  const inp = $("#tag-search");
  if (inp && !inp.dataset.bound) {
    inp.dataset.bound = "1";
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && inp.value.trim()) loadTagMembers(inp.value.trim());
    });
  }
}

function renderTagChips() {
  const box = $("#tag-chips");
  const all = state.tagAll || [];
  box.innerHTML = all
    .map((x) => `<button class="chip ${state.tagName === x.name ? "on" : ""}" data-tag="${esc(x.name)}">${esc(x.name)}${
      x.pct !== null && x.pct !== undefined ? `<span class="tiny" style="opacity:.6"> ${x.pct > 0 ? "+" : ""}${x.pct}%</span>` : ""
    }</button>`)
    .join("");
  $$("button[data-tag]", box).forEach((c) => {
    c.onclick = () => loadTagMembers(c.dataset.tag);
  });
}

async function loadTagMembers(tag) {
  state.tagName = tag;
  renderTagChips();
  state.tagShown = 100;
  state.tagData = null;
  state.tagResolved = "";
  $("#tag-result-note").textContent = `「${tag}」加载中…`;
  $("#tag-list").innerHTML = "";
  const qs = `limit=1000&sort=${encodeURIComponent(state.tagSort)}&dir=${encodeURIComponent(state.tagDir)}&include_hidden=1`;
  const d = await api(`tags/${encodeURIComponent(tag)}?${qs}`).catch(() => null);
  if (!d) { $("#tag-result-note").textContent = "加载失败"; return; }
  state.tagData = d;
  state.tagResolved = d.tag || tag;
  if (d.error) {
    state.tagItems = [];
    state.tagTotal = 0;
    const sug = (d.suggestions || [])
      .map((n) => `<button class="chip" data-suggest="${esc(n)}">${esc(n)}</button>`)
      .join("");
    $("#tag-result-note").innerHTML = `${esc(d.error)}${sug ? ` · 试试：${sug}` : ""}`;
    $$("#tag-result-note [data-suggest]").forEach((b) => {
      b.onclick = () => loadTagMembers(b.dataset.suggest);
    });
    renderTagPurityButtons();
    return;
  }
  state.tagItems = d.items || [];
  state.tagTotal = d.total || state.tagItems.length;
  renderTagPurityButtons();
  renderTagList();
}

function tagFilteredItems() {
  const all = state.tagItems || [];
  if (state.tagPurity === "hidden") return all.filter((x) => x.hidden);
  let items = all.filter((x) => !x.hidden);
  if (state.tagPurity === "core") items = items.filter((x) => x.pinned || x.purity_key === "core");
  else if (state.tagPurity === "clean") items = items.filter((x) => x.pinned || x.purity_key !== "peripheral");
  return items;
}

function purityBadge(x) {
  if (x.hidden) return `<span class="purity grey">已隐藏</span>`;
  if (x.pinned) return `<span class="purity pin">置顶</span>`;
  const cls = { core: "core", related: "related", peripheral: "peri" }[x.purity_key] || "grey";
  return x.purity ? `<span class="purity ${cls}">${esc(x.purity)}</span>` : "";
}

function tagReasonActions(x) {
  if (x.hidden) return `<button class="btn ghost small" data-restore>恢复显示</button>`;
  return `<button class="btn ghost small" data-pin>${x.pinned ? "取消置顶" : "置顶"}</button>
    <button class="btn ghost small danger" data-hide>不看这只</button>`;
}

async function markTagStock(code, mark) {
  const tag = state.tagResolved || state.tagName;
  const it = (state.tagItems || []).find((x) => x.code === code);
  try {
    await api(`tags/${encodeURIComponent(tag)}/mark`, { method: "POST", body: { code, mark }, idempotent: true });
    if (it) {
      if (mark === "hide") {
        it.hidden = true;
        it.pinned = false;
      } else if (mark === "pin") {
        it.hidden = false;
        it.pinned = true;
        it.purity_rank = 0;
      } else {
        it.hidden = false;
        it.pinned = false;
        it.purity_rank = it.purity_key === "core" ? 1 : it.purity_key === "related" ? 2 : 3;
      }
    }
    renderTagList();
    toast(mark === "pin" ? "已置顶" : mark === "hide" ? "已隐藏，可在「已隐藏」里恢复" : "已恢复");
  } catch (e) { toast(e.message); }
}

function renderTagList() {
  const all = state.tagItems || [];
  const items = tagFilteredItems().slice();
  const k = state.tagSort;
  const dir = state.tagDir === "asc" ? 1 : -1;
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (k === "purity") {
      const A = a.purity_rank ?? 9;
      const B = b.purity_rank ?? 9;
      return ((A - B) * dir) || ((b.pct || 0) - (a.pct || 0));
    }
    if (k === "float_cap") return ((a.float_cap || 0) - (b.float_cap || 0)) * dir;
    if (k === "pe") {
      const A = a.pe > 0 ? a.pe : Infinity;
      const B = b.pe > 0 ? b.pe : Infinity;
      return (A - B) * dir;
    }
    return ((a.pct || 0) - (b.pct || 0)) * dir;
  });

  const total = state.tagTotal || all.length;
  const hidden = all.filter((x) => x.hidden).length;
  const counts = { core: 0, related: 0, peripheral: 0 };
  all.filter((x) => !x.hidden).forEach((x) => {
    if (counts[x.purity_key] != null) counts[x.purity_key]++;
  });
  const filterLabel = TAG_PURITY[state.tagPurity] || "全部";
  const alias = state.tagResolved && state.tagResolved !== state.tagName
    ? ` · 已按「${state.tagResolved}」查找` : "";
  const hiddenPart = hidden && state.tagPurity !== "hidden" ? ` · 已隐藏 ${hidden}` : "";
  const filterPart = state.tagPurity === "all" ? "全部"
    : state.tagPurity === "hidden" ? "已隐藏" : `${filterLabel}${items.length}只`;
  $("#tag-result-note").textContent =
    `${state.tagName} · ${total}只 · 核心${counts.core}/相关${counts.related}/沾边${counts.peripheral}` +
    `${hiddenPart}${alias} · ${filterPart} · ${tagSortLabel()}`;

  if (!items.length) {
    $("#tag-list").innerHTML = `<div class="empty">${esc(state.tagName)} 在「${filterLabel}」下暂无个股</div>`;
    renderTagPurityButtons();
    return;
  }

  const shown = Math.min(state.tagShown, items.length);
  const html = items.slice(0, shown).map((x) => {
    const met = [];
    if (x.float_cap) met.push(`流通 ${x.float_cap}亿`);
    if (x.turnover_rate) met.push(`换手 ${x.turnover_rate}%`);
    if (x.pe) met.push(`PE ${Number(x.pe).toFixed(1)}`);
    return `<div class="tag-item" data-code="${x.code}" data-name="${esc(x.name)}">
      <div class="heat-row" data-code="${x.code}" data-name="${esc(x.name)}">
        <div class="l"><div class="nm">${esc(x.name)}${purityBadge(x)}</div>
          <div class="cd">${x.code}${mktBadge(x.code)}${met.length ? " · " + met.join(" · ") : ""}<span class="why-wrap"> · <button class="why-btn" data-why>入选理由</button></span></div></div>
        <div class="mid"><div class="${cls(x.pct)}">${pctText(x.pct)}</div>
          <div class="tiny muted">${x.price ? x.price.toFixed(2) : ""}</div></div>
        ${followBtn(x.code)}
      </div>
      <div class="tag-why hidden"><div>${esc(x.reason || "东财没有给出入选理由。")}</div>
        <div class="tag-why-actions">${tagReasonActions(x)}</div></div>
    </div>`;
  }).join("");
  const more = items.length > shown
    ? `<button class="btn ghost tag-more" data-more>显示更多（还有 ${items.length - shown} 只）</button>` : "";
  $("#tag-list").innerHTML = html + more;

  $$("#tag-list .tag-item").forEach((box) => {
    const row = $(".heat-row", box);
    const why = $(".tag-why", box);
    row.onclick = (e) => {
      if (e.target.closest("[data-follow],[data-why],[data-pin],[data-hide],[data-restore]")) return;
      openHeatStock(box.dataset.code, box.dataset.name);
    };
    const whyBtn = $("[data-why]", row);
    if (whyBtn) whyBtn.onclick = (e) => {
      e.stopPropagation();
      why.classList.toggle("hidden");
      whyBtn.textContent = why.classList.contains("hidden") ? "入选理由" : "收起理由";
    };
    const pin = $("[data-pin]", box);
    if (pin) pin.onclick = (e) => {
      e.stopPropagation();
      markTagStock(box.dataset.code, pin.textContent.includes("取消") ? "none" : "pin");
    };
    const hide = $("[data-hide]", box);
    if (hide) hide.onclick = (e) => { e.stopPropagation(); markTagStock(box.dataset.code, "hide"); };
    const restore = $("[data-restore]", box);
    if (restore) restore.onclick = (e) => { e.stopPropagation(); markTagStock(box.dataset.code, "none"); };
  });
  const moreBtn = $("[data-more]", $("#tag-list"));
  if (moreBtn) moreBtn.onclick = () => { state.tagShown += 100; renderTagList(); };
  renderTagPurityButtons();
}

/* ---------- K 线（分时 / 周K / 月K，可左右拖动看更早） ---------- */
const K_PERIODS = [["min", "分时"], ["day", "日K"], ["week", "周K"], ["month", "月K"]];
/* 港美股：没有分时（源只回一条收盘记录），只给日/周/月 */
const GLOBAL_K_PERIODS = [["day", "日K", "day", ""], ["week", "周K", "week", ""], ["month", "月K", "month", ""]];
const K_LABEL = Object.fromEntries(K_PERIODS);
const MA_COLORS = { 5: "#ff9f0a", 10: "var(--muted)", 20: "#12a150" };

function defaultKPeriod() {
  return marketActive() ? "min" : "day";
}

function kbarHtml(withExtra = true, def = "day", periods = null) {
  const list = periods || K_PERIODS.map(([p, l]) => [p, l, p, ""]);
  return `<div class="kbar">
    <div class="seg k-periods" id="k-period">
      ${list.map(([k, l, p, lim]) => `<button data-k="${k}" data-p="${p}"${lim ? ` data-limit="${lim}"` : ""} class="${k === def ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <canvas id="kchart"></canvas>
    <div class="k-legend"><span id="k-name" class="tiny muted"></span><span id="k-ma" class="tiny"></span>
      <button class="btn ghost small hidden" id="k-live">回到最新</button><span id="k-live-note" class="tiny muted"></span></div>
  </div>
  ${withExtra ? `<div class="ff">
    <div class="ff-head"><span>资金流向</span><span id="ff-date" class="tiny muted"></span></div>
    <div id="ff-detail" class="ff-detail"></div>
    <div class="ff-sum tiny muted" id="ff-sum"></div>
    <canvas id="ffchart"></canvas>
    <div class="ff-note tiny muted">近 20 个交易日 · 超大单净额</div>
  </div>
  <div class="chip-card">
    <div class="ff-head"><span>筹码分布 <span class="tiny muted">估算</span></span><span id="chip-note" class="tiny muted"></span></div>
    <div id="chip-sum" class="chip-stats"></div>
    <canvas id="chipchart"></canvas>
    <div class="chip-legend tiny muted">
      <span><i class="cdot profit"></i>获利盘</span>
      <span><i class="cdot loss"></i>套牢盘</span>
      <span><i class="cline avg"></i>平均成本</span>
      <span><i class="cline cur"></i>现价</span>
    </div>
  </div>` : ""}`;
}

function bindKline(code, withExtra = true, def = "") {
  if (!$("#k-period")) return;
  const btns = $$("#k-period button");
  const keyOf = (b) => b.dataset.k || b.dataset.p;
  const firstBtn = btns.find((b) => keyOf(b) === def) || btns[0];
  const fire = (b) => loadKline(code, b.dataset.p || "day", b.dataset.limit, b.textContent.trim());
  btns.forEach((b) => {
    b.classList.toggle("on", b === firstBtn);
    b.onclick = () => {
      btns.forEach((x) => x.classList.toggle("on", x === b));
      const cv = $("#kchart");
      if (cv) { cv._off = 0; cv._win = 0; cv._minPos = null; }
      fire(b);
    };
  });
  if (firstBtn) fire(firstBtn);
  // 净值折线不做拖动/缩放/十字光标（数据是每天一个点，拖着看意义不大）
  if (isFundCode(code)) return;
  if (withExtra) {
    loadFundflow(code);
    loadChip(code);
  }

  const cv = $("#kchart");
  if (!cv) return;
  let pinch = null;
  let mouseDown = false;
  let crossRaf = 0;

  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const midX = (t) => (t[0].clientX + t[1].clientX) / 2;
  const clampWin = (w, d) => Math.max(15, Math.min(d.items.length, Math.round(w)));

  const cross = (clientX) => {
    const d = cv._d;
    if (!d || !d.items) return;
    clearTimeout(cv._selClear);
    cancelAnimationFrame(crossRaf);
    crossRaf = requestAnimationFrame(() => {
      const cur = cv._d;
      if (!cur || !cur.items) return;
      const rect = cv.getBoundingClientRect();
      drawKline(cv, cur, relIndex(cv, clientX - rect.left));
    });
    cv._crossRaf = crossRaf;
  };
  const scheduleSelClear = () => {
    clearTimeout(cv._selClear);
    cv._selClear = setTimeout(() => {
      cv._sel = null;
      const d = cv._d;
      if (d) drawKline(cv, d, null);
    }, 1800);
  };

  const live = $("#k-live");
  if (live) live.onclick = () => {
    const d = cv._d;
    if (!d) return;
    cv._off = 0;
    drawKline(cv, d, null);
  };

  cv.addEventListener("touchstart", (e) => {
    const d = cv._d;
    if (!d) return;
    clearTimeout(cv._selClear);
    if (e.touches.length === 2) {
      pinch = { d: dist(e.touches), win: cv._win || 60, off: cv._off || 0, mid: midX(e.touches) };
    } else if (e.touches.length === 1) {
      cross(e.touches[0].clientX);
    }
  }, { passive: true });

  cv.addEventListener("touchmove", (e) => {
    const d = cv._d;
    if (!d || !d.items) return;
    if (e.touches.length === 2 && pinch) {
      clearTimeout(cv._selClear);
      const scale = dist(e.touches) / (pinch.d || 1);
      cv._win = clampWin(pinch.win / scale, d);
      const step = (cv.getBoundingClientRect().width - 46) / cv._win;
      const dx = midX(e.touches) - pinch.mid;
      cv._off = Math.max(0, Math.min((pinch.off || 0) + dx / step, d.items.length - cv._win));
      drawKline(cv, d, null);
    } else if (e.touches.length === 1) {
      cross(e.touches[0].clientX);
    }
  }, { passive: true });

  cv.addEventListener("touchend", (e) => {
    if (e.touches.length === 0) {
      pinch = null;
      scheduleSelClear();
    }
  });

  cv.addEventListener("mousedown", () => { mouseDown = true; });
  cv.addEventListener("mouseup", () => { mouseDown = false; });
  cv.addEventListener("mousemove", (e) => {
    const d = cv._d;
    if (!d || !d.items) return;
    if (mouseDown || e.buttons === 0) cross(e.clientX);
  });
  cv.addEventListener("mouseleave", () => {
    const d = cv._d;
    if (d) drawKline(cv, d, null);
  });
  cv.addEventListener("wheel", (e) => {
    const d = cv._d;
    if (!d || !d.items || d.period === "min") return;
    e.preventDefault();
    cv._win = clampWin((cv._win || 60) * (e.deltaY > 0 ? 1.15 : 0.87), d);
    drawKline(cv, d, null);
  }, { passive: false });
}

function relIndex(cv, x) {
  const d = cv._d;
  const rect = cv.getBoundingClientRect();
  const cw = rect.width - 4 - 42;
  if (d.period === "min") {
    const pos = cv._minPos || [];
    if (!pos.length) return 0;
    const step = cv._minStep || 1;
    const slot = (x - 4) / step - 0.5;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pos.length; i++) {
      const dd = Math.abs(pos[i] - slot);
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }
  const { win, start } = winOf(cv, d);
  const step = cw / win;
  const i = Math.floor((x - 4) / step);
  return start + Math.max(0, Math.min(win - 1, i));
}

