function winOf(cv, d) {
  const n = d.items.length;
  if (d.period === "min") {
    cv._maxOff = 0;
    return { n, win: n, start: 0 };
  }
  const def = d.period === "day" ? 90 : d.period === "week" ? 60 : 48;
  let win = Math.round(cv._win || Math.min(n, def));
  win = Math.max(15, Math.min(win, n));
  cv._win = win;
  const maxOff = Math.max(0, n - win);
  const off = Math.max(0, Math.min(cv._off || 0, maxOff));
  cv._off = off;
  cv._maxOff = maxOff;
  return { n, win, start: n - win - off };
}

/* K 线说明行的当日涨跌幅：拖到历史（出现「回到最新」）时，图上只有历史数据，
   这行始终保留最新价和当日涨跌，免得看不到今天的情况。 */
function setKlinePct(pct) {
  const el = $("#k-pct");
  if (!el) return;
  const v = Number(pct);
  if (pct === null || pct === undefined || pct === "" || !Number.isFinite(v)) {
    el.textContent = "";
    delete el.dataset.pct;
    return;
  }
  el.dataset.pct = String(v);
  el.innerHTML = ` · 当日 <span class="${cls(v)}">${pctText(v)}</span>`;
}

async function loadKline(code, period, limit, label, opts = {}) {
  const cv = $("#kchart");
  if (!cv) return;
  const lim = Number(limit) > 0 ? Number(limit) : 480;
  let d = null;
  let failed = false;
  // 三次退避重试：上游偶发 429/超时不再一次就放弃、留一块黑
  for (let i = 0; i < 3; i++) {
    try { d = await api(`kline/${code}?period=${period}&limit=${lim}&ind=${period === "min" ? 0 : 1}`, { noRetry: true }, 12000); break; }
    catch (e) { failed = true; if (i < 2) await new Promise((r) => setTimeout(r, 450 * (i + 1))); }
  }
  // 分时拿不到（新上市 / 债券ETF / 当日零成交）自动退到日K，并明确告诉用户切过周期
  if ((!d || !(d.items || []).length) && period === "min" && !opts.noFallback) {
    const dayBtn = $$("#k-period button").find((b) => (b.dataset.p || "") === "day");
    if (dayBtn) {
      cv._autoNote = "无当日分时 · 已切日K";
      $$("#k-period button").forEach((b) => b.classList.toggle("on", b === dayBtn));
      await loadKline(code, "day", dayBtn.dataset.limit, dayBtn.textContent.trim(),
                      { noFallback: true, auto: true });
      return;
    }
  }
  if (!opts.auto) cv._autoNote = "";
  if (d && Array.isArray(d.items) && d.items.length) d.items = cleanSeries(d.items);
  cv._emptyMsg = d && (d.items || []).length ? "" : (failed ? "数据源暂不可用" : "该周期暂无数据");
  const sqNote = $("#sq-note");
  if (sqNote && sqNote.textContent === "加载行情…") sqNote.textContent = "";
  if (d) { d.period = period; cv._d = d; cv._off = 0; }
  drawKline(cv, d, null);
  const nm = $("#k-name");
  if (nm) {
    const pctBox = $("#k-pct");
    const prevPct = pctBox ? pctBox.dataset.pct : undefined;
    if (!d || !d.items || !d.items.length) {
      nm.textContent = failed ? "数据源暂不可用，稍后自动重试" : "";
    } else {
      const last = d.items[d.items.length - 1];
      const srcNote = d.source === "fund_nav" ? " · 单位净值" : d.source === "eastmoney" ? " · 备用源" : "";
      // 区间改用「图上真正画出来的窗口」：原来写全量会让图例说 2024-11 起、横轴却是 07-14
      const vis = cv._range || [];
      const range = d.source === "fund_nav" ? ""
        : vis[0] && vis[1] ? `${esc(vis[0])} ~ ${esc(vis[1])} · ` : "";
      nm.innerHTML = `${esc(d.name || "")} ${esc(label || K_LABEL[period] || period)} · ${range}最新 <span id="k-last">${d.source === "fund_nav" ? last.c.toFixed(4) : last.c.toFixed(2)}</span><span id="k-pct"></span>${srcNote ? esc(srcNote) : ""}`;
      // 分时对昨收、日 K 对上一根收盘算当日涨跌幅；周/月 K 用实时行情给的值，切周期时沿用
      let pct = null;
      if (period === "min" && d.prev_close) pct = (last.c / d.prev_close - 1) * 100;
      else if (period === "day" && d.items.length > 1 && d.items[d.items.length - 2].c) {
        pct = (last.c / d.items[d.items.length - 2].c - 1) * 100;
      }
      setKlinePct(pct !== null ? pct : prevPct);
    }
  }
  startKlineTimer(code, period);
}

function stopKlineTimer() {
  if (state.klineTimer) clearInterval(state.klineTimer);
  state.klineTimer = null;
  const cv = $("#kchart");
  if (cv) {
    clearTimeout(cv._selClear);
    if (cv._crossRaf) cancelAnimationFrame(cv._crossRaf);
  }
}

/* 开盘时自动刷新 K 线：分时 30 秒，日/周 60 秒，月 5 分钟（拖到历史/看十字光标/页面隐藏时暂停） */
function startKlineTimer(code, period) {
  stopKlineTimer();
  const iv = period === "min" ? 30000 : period === "month" ? 300000 : 60000;
  state.klineTimer = setInterval(async () => {
    const cv = $("#kchart");
    if (!cv || !cv._d || cv._busy) return;
    if (document.hidden) return;
    const chartTab = $("#stock-tab-chart");
    if (chartTab && chartTab.classList.contains("hidden")) return;
    const st = (state.board.market || {}).state;
    if (st === "closed" || st === "lunch") return;
    if ((cv._off || 0) > 0 || cv._sel !== null && cv._sel !== undefined) return;
    cv._busy = true;
    try {
      // ind 一律让服务端算：本机只画，不重算 480 根收盘价的 EMA/MACD
      const d = await api(`kline/${code}?period=${period}&limit=480&ind=${period === "min" ? 0 : 1}`).catch(() => null);
      if (!d || !d.items || !d.items.length) return;
      d.period = period;
      cv._d = d;
      drawKline(cv, d, null);
    } finally {
      cv._busy = false;
    }
  }, iv);
}

function fmtVol(v) {
  if (v === null || v === undefined) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + " 万";
  return v.toFixed(0);
}

function fmtYi(v) {
  if (v === null || v === undefined) return "—";
  const a = Math.abs(v);
  const sign = v > 0 ? "+" : "";
  if (a >= 1e8) return sign + (v / 1e8).toFixed(2) + " 亿";
  if (a >= 1e4) return sign + (v / 1e4).toFixed(0) + " 万";
  return sign + v.toFixed(0);
}

/* 分时横轴按交易时钟定位：09:30–11:30、13:00–15:00、盘后 15:00–15:30。
   午休压缩成 1 格，这样盘中也能预留出完整的 09:30~15:30 横轴。 */
const MIN_SLOTS = 272;
function minSlot(t) {
  const [h, m] = String(t || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  const v = h * 60 + m;
  if (v <= 11 * 60 + 30) return Math.max(0, Math.min(120, v - (9 * 60 + 30)));
  if (v < 13 * 60) return 121;
  if (v <= 15 * 60) return 121 + (v - 13 * 60);
  return Math.max(242, Math.min(271, 242 + (v - 15 * 60 - 1)));
}

function drawCross(ctx, it, i, start, X, padT, H, all, isMin, prevClose) {
  const x = X(i);
  ctx.strokeStyle = "rgba(127,127,127,.55)";
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - 14); ctx.stroke();
  ctx.setLineDash([]);
  const k = it[i];
  const g = start + i;
  // 分时涨跌幅必须对昨日收盘价算；对上一分钟算会把 +6% 的高点显示成 +0.1%
  const base = isMin ? prevClose : (g > 0 ? all[g - 1].c : k.c);
  const chg = base ? ((k.c / base - 1) * 100) : 0;
  const txt1 = `${k.t}  ${k.c.toFixed(2)}  ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
  const txt2 = isMin ? `量 ${fmtVol(k.v)}` : `开 ${k.o.toFixed(2)} 高 ${k.h.toFixed(2)} 低 ${k.l.toFixed(2)} 量 ${fmtVol(k.v)}`;
  ctx.fillStyle = "rgba(20,20,22,.82)";
  ctx.fillRect(padT, padT, Math.max(ctx.measureText(txt1).width, ctx.measureText(txt2).width) + 12, 32);
  ctx.fillStyle = "#fff";
  ctx.fillText(txt1, padT + 6, padT + 13);
  ctx.fillText(txt2, padT + 6, padT + 26);
}

/* 基金净值走势：单根折线 + 淡面积 + 首尾日期，不做蜡烛和均线 */
/* ---------- K 线横轴：全站统一 ----------
   分时只给 HH:MM；日/周/月看跨度：≤200 天用 MM-DD，更长用 YY-MM（不然跨两年时
   2024-11-27 / 2025-11-24 / 2026-11-20 会显示成「11-27 11-24 11-20」，看着像倒着走） */
function itemStamp(x) {
  return String((x && (x.t || x.date)) || "");
}
function seriesKey(x) {
  const t = itemStamp(x);
  return /^\d{1,2}:\d{2}/.test(t) ? t.slice(0, 5) : t.slice(0, 10);
}
/* 统一清洗：按时间升序、去重、丢掉跑偏的未来日期（净值前端偶发补错日期会画成右侧空白） */
function cleanSeries(items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const cutoff = Date.now() + 86400000;
  const map = new Map();
  items.forEach((x) => {
    const k = seriesKey(x);
    if (!k) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Date.parse(k) > cutoff) return;
    map.set(k, x);
  });
  const arr = Array.from(map.values());
  arr.sort((a, b) => (seriesKey(a) < seriesKey(b) ? -1 : seriesKey(a) > seriesKey(b) ? 1 : 0));
  return arr;
}
function axisSpanDays(it) {
  if (!it || it.length < 2) return 0;
  const a = Date.parse(seriesKey(it[0])), b = Date.parse(seriesKey(it[it.length - 1]));
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(b - a) / 86400000 : 0;
}
function axisLabel(x, span) {
  const t = itemStamp(x);
  if (/^\d{1,2}:\d{2}/.test(t)) return t.slice(0, 5);
  const d = seriesKey(x);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return span > 200 ? `${d.slice(2, 4)}-${d.slice(5, 7)}` : d.slice(5);
}
/* 左 / 中 / 右三个刻度，所有图共用同一套画法 */
function axisDraw(ctx, it, padL, cw, y) {
  if (!it || it.length < 2) return;
  const span = axisSpanDays(it);
  const mid = it[Math.floor((it.length - 1) / 2)];
  const items = [[it[0], padL, 0], [mid, padL + cw / 2, 1], [it[it.length - 1], padL + cw, 2]];
  ctx.fillStyle = "#86868b";
  ctx.textAlign = "left";
  items.forEach(([x, ax, side]) => {
    const txt = axisLabel(x, span);
    if (!txt) return;
    const w = ctx.measureText(txt).width;
    ctx.fillText(txt, side === 0 ? ax : side === 2 ? ax - w : ax - w / 2, y);
  });
}

function drawFundLine(cv, d) {
  const box = cv.parentElement;
  const W = Math.max(240, (box ? box.clientWidth : 320) - 34);
  const H = 240;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pxW = Math.round(W * dpr), pxH = Math.round(H * dpr);
  if (cv.width !== pxW || cv.height !== pxH) { cv.width = pxW; cv.height = pxH; }
  cv.style.width = "100%";
  cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const INK = dark ? "#f5f5f7" : "#1d1d1f";
  const MUTED = dark ? "#98989d" : "#86868b";
  const GRID = dark ? "rgba(255,255,255,.12)" : "rgba(127,127,127,.16)";
  const items = (d && d.items) || [];
  const maBox = $("#k-ma");
  if (maBox) maBox.innerHTML = "";
  if (items.length < 2) {
    ctx.fillStyle = MUTED;
    ctx.fillText("暂无净值数据", 10, 22);
    return;
  }
  const it = items;
  const n = it.length;
  const padL = 4, padR = 50, padT = 12, padB = 22;
  const cw = W - padL - padR, ph = H - padT - padB;
  const vals = it.map((x) => Number(x.c));
  let hi = Math.max(...vals), lo = Math.min(...vals);
  const pad = (hi - lo) * 0.10 || Math.max(hi * 0.002, 0.002);
  hi += pad; lo -= pad;
  // 横轴按真实日历日排布：QDII 净值隔几天才有一个点，等距排列会把「跳空」画成陡崖
  const dayNum = (t) => {
    const p = String(t || "").split("-").map(Number);
    return p.length === 3 ? Date.UTC(p[0], p[1] - 1, p[2]) / 86400000 : NaN;
  };
  const ds = it.map((x) => dayNum(x.t));
  const d0 = ds.find((v) => Number.isFinite(v));
  const d1 = [...ds].reverse().find((v) => Number.isFinite(v));
  const span = Number.isFinite(d0) && Number.isFinite(d1) && d1 > d0 ? d1 - d0 : Math.max(n - 1, 1);
  const X = (i) => {
    const v = Number.isFinite(ds[i]) && Number.isFinite(d0) ? ds[i] - d0 : i;
    return padL + (v / span) * cw;
  };
  const Y = (v) => padT + ph - ((v - lo) / (hi - lo)) * ph;

  ctx.strokeStyle = GRID; ctx.fillStyle = MUTED;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (ph * i) / 3;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
    const p = hi - ((hi - lo) * i) / 3;
    ctx.fillText(p.toFixed(4), padL + cw + 6, y + 3);
  }

  // 面积：很淡，只为让这条线有体积感，不抢主线的墨色
  ctx.beginPath();
  ctx.moveTo(X(0), Y(vals[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(vals[i]));
  ctx.lineTo(X(n - 1), padT + ph);
  ctx.lineTo(X(0), padT + ph);
  ctx.closePath();
  ctx.fillStyle = dark ? "rgba(245,245,247,.07)" : "rgba(29,29,31,.05)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i), Y(vals[i]));
  ctx.strokeStyle = INK; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();

  // 末点：一个小实心点 + 数值，省得再去右边刻度里找
  const lx = X(n - 1), ly = Y(vals[n - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = INK; ctx.fill();

  axisDraw(ctx, it, padL, cw, H - 8);
  cv._range = [itemStamp(it[0]).slice(0, 10), itemStamp(it[n - 1]).slice(0, 10)];
}
function drawKline(cv, d, sel) {
  cv._sel = sel;
  // 场外基金只有每日单位净值，没有开高低收：画净值折线，不画蜡烛/成交量/MACD
  if (d && d.source === "fund_nav") { drawFundLine(cv, d); return; }
  const box = cv.parentElement;
  const W = Math.max(240, (box ? box.clientWidth : 320) - 34);
  const H = 316;
  const AXIS_H = 16;      // 底部留给横轴刻度，之前日期直接压在最底部、和 MACD 叠在一起
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 只在尺寸变化时重设 canvas，避免十字光标每次移动都重建画布
  const pxW = Math.round(W * dpr), pxH = Math.round(H * dpr);
  if (cv.width !== pxW || cv.height !== pxH) {
    cv.width = pxW;
    cv.height = pxH;
  }
  cv.style.width = "100%";
  cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
  if (!d || !d.items || d.items.length < 2) {
    // 空态要写清楚"为什么空、下一步做什么"，不再只是一行小字
    const msg = cv._emptyMsg || "该周期暂无数据";
    ctx.textAlign = "center";
    ctx.fillStyle = "#86868b";
    ctx.font = "13px -apple-system,BlinkMacSystemFont,sans-serif";
    ctx.fillText(msg, W / 2, H / 2 - 4);
    ctx.font = "11px -apple-system,BlinkMacSystemFont,sans-serif";
    ctx.fillStyle = "rgba(134,134,139,.72)";
    ctx.fillText("点上方「分时 / 日K / 周K / 月K」换一个周期", W / 2, H / 2 + 20);
    ctx.textAlign = "left";
    ctx.font = "10px -apple-system,BlinkMacSystemFont,sans-serif";
    const maBox0 = $("#k-ma");
    if (maBox0) maBox0.innerHTML = "";
    const liveBtn0 = $("#k-live");
    if (liveBtn0) liveBtn0.classList.add("hidden");
    const liveNote0 = $("#k-live-note");
    if (liveNote0) liveNote0.textContent = "";
    return;
  }
  const all = d.items;
  const isMin = d.period === "min";
  const { start, win } = winOf(cv, d);
  const liveBtn = $("#k-live");
  if (liveBtn) liveBtn.classList.toggle("hidden", !((cv._off || 0) > 0));
  const liveNote = $("#k-live-note");
  if (liveNote) liveNote.textContent = (cv._off || 0) > 0 ? "已暂停实时" : (cv._autoNote || "");
  const it = all.slice(start, start + win);
  const n = it.length;
  const padL = 4, padR = 42, padT = 6;
  const volH = 32, macdH = isMin ? 0 : 44, gap = 6;
  const cw = W - padL - padR;
  const ph = H - padT - volH - macdH - gap * 2 - AXIS_H;
  // 分时：固定 09:30~15:30 的横轴，未走完的部分留白；日/周/月仍按条数等分
  const minPos = isMin ? it.map((x) => minSlot(x.t)) : null;
  const step = isMin ? cw / MIN_SLOTS : cw / n;
  cv._step = step;
  cv._minPos = minPos;
  cv._minStep = step;
  const X = isMin
    ? (i) => padL + (minPos[i] + 0.5) * step
    : (i) => padL + step * i + step / 2;

  const highs = isMin ? it.map((x) => x.c) : it.map((x) => x.h);
  const lows = isMin ? it.map((x) => x.c) : it.map((x) => x.l);
  if (isMin && d.prev_close) { highs.push(d.prev_close); lows.push(d.prev_close); }
  let hi = Math.max(...highs), lo = Math.min(...lows);
  const pad = (hi - lo) * 0.06 || Math.max(hi * 0.005, 0.01);
  hi += pad; lo -= pad;
  const Y = (v) => padT + ph - ((v - lo) / (hi - lo)) * ph;
  const maxV = Math.max(...it.map((x) => x.v || 0), 1);
  const bw = Math.max(1, Math.min(step * 0.66, 12));

  ctx.strokeStyle = "rgba(127,127,127,.16)";
  ctx.fillStyle = "#86868b";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ph * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
    const p = hi - ((hi - lo) * i) / 4;
    ctx.fillText(p >= 100 ? p.toFixed(1) : p.toFixed(2), padL + cw + 4, y + 3);
  }

  const UP = "#e5322d", DOWN = "#12a150";
  if (isMin) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = X(i), y = Y(it[i].c);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = "#1d1d1f"; ctx.lineWidth = 1.4; ctx.stroke();
    if (d.prev_close) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(127,127,127,.6)";
      ctx.beginPath(); ctx.moveTo(padL, Y(d.prev_close)); ctx.lineTo(padL + cw, Y(d.prev_close)); ctx.stroke();
      ctx.setLineDash([]);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = X(i), o = it[i].o, c = it[i].c;
      const col = c >= o ? UP : DOWN;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x, Y(it[i].h)); ctx.lineTo(x, Y(it[i].l)); ctx.stroke();
      const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c));
      ctx.fillRect(x - bw / 2, y1, bw, Math.max(y2 - y1, 1));
    }
    // MA5 / MA10 / MA20：服务端已随 K 线算好（d.ind），本地只做兜底
    const closes = all.map((x) => x.c);
    const indOf = (key) => (d.ind && Array.isArray(d.ind[key]) && d.ind[key].length === all.length ? d.ind[key] : null);
    const maFull = (k) => indOf("ma" + k) || closes.map((_, i) => {
      if (i < k - 1) return null;
      let s = 0;
      for (let j = i - k + 1; j <= i; j++) s += closes[j];
      return s / k;
    });
    const legend = [];
    [5, 10, 20].forEach((k) => {
      const arr = maFull(k).slice(start, start + win);
      ctx.strokeStyle = MA_COLORS[k]; ctx.lineWidth = 1.1; ctx.beginPath();
      let started = false;
      arr.forEach((v, i) => {
        if (v === null) return;
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v));
      });
      ctx.stroke();
      const lastV = arr.length ? arr[arr.length - 1] : null;
      if (lastV !== null && lastV !== undefined) legend.push([k, lastV]);
    });
    const maBox = $("#k-ma");
    if (maBox) {
      maBox.innerHTML = legend
        .map(([k, v]) => `<span style="color:${MA_COLORS[k]};margin-left:8px">MA${k} ${v.toFixed(2)}</span>`)
        .join("");
    }
  }

  if (isMin) {
    const maBox = $("#k-ma");
    if (maBox) maBox.innerHTML = "";
  }

  // 成交量
  const vy = padT + ph + gap;
  for (let i = 0; i < n; i++) {
    const h = ((it[i].v || 0) / maxV) * (volH - 2);
    ctx.fillStyle = (it[i].c >= (it[i].o ?? it[i].c) ? "rgba(229,50,45,.5)" : "rgba(18,161,80,.5)");
    ctx.fillRect(X(i) - bw / 2, vy + (volH - 2) - h, bw, h);
  }

  // MACD（分时不画）；横轴固定 09:30 / 11:30·13:00 / 15:30
  if (isMin) {
    ctx.strokeStyle = "rgba(127,127,127,.16)";
    ctx.setLineDash([2, 3]);
    [121, 242].forEach((slot) => {
      const x = padL + slot * step;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph + gap + volH); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = "#86868b";
    ctx.fillText("09:30", padL, H - 5);
    const midTxt = "11:30 / 13:00";
    ctx.fillText(midTxt, padL + cw / 2 - ctx.measureText(midTxt).width / 2, H - 5);
    const endTxt = "15:30";
    ctx.fillText(endTxt, padL + cw - ctx.measureText(endTxt).width, H - 5);
    if (sel !== null && sel !== undefined && sel >= start && sel < start + win) {
      drawCross(ctx, it, sel - start, start, X, padT, H, all, isMin, d.prev_close);
    }
    return;
  }
  const closesAll = all.map((x) => x.c);
  let difAll, deaAll, macdAll;
  if (d.ind && Array.isArray(d.ind.dif) && d.ind.dif.length === all.length
      && Array.isArray(d.ind.dea) && Array.isArray(d.ind.macd)) {
    difAll = d.ind.dif; deaAll = d.ind.dea; macdAll = d.ind.macd;
  } else {
    const ema = (arr, k) => {
      const a = 2 / (k + 1);
      let prev = arr[0];
      return arr.map((v, i) => (i === 0 ? v : (prev = a * v + (1 - a) * prev)));
    };
    const e12 = ema(closesAll, 12), e26 = ema(closesAll, 26);
    difAll = e12.map((v, i) => v - e26[i]);
    deaAll = ema(difAll, 9);
    macdAll = difAll.map((v, i) => (v - deaAll[i]) * 2);
  }
  const dif = difAll.slice(start, start + win);
  const dea = deaAll.slice(start, start + win);
  const macd = macdAll.slice(start, start + win);
  const my = vy + volH + gap;
  const mMax = Math.max(...macd.map(Math.abs), ...dif.map(Math.abs), ...dea.map(Math.abs), 1e-6);
  const MY = (v) => my + macdH / 2 - (v / mMax) * (macdH / 2 - 2);
  ctx.strokeStyle = "rgba(127,127,127,.16)";
  ctx.beginPath(); ctx.moveTo(padL, my + macdH / 2); ctx.lineTo(padL + cw, my + macdH / 2); ctx.stroke();
  for (let i = 0; i < n; i++) {
    const y = MY(macd[i]), zero = MY(0);
    ctx.fillStyle = macd[i] >= 0 ? "rgba(229,50,45,.65)" : "rgba(18,161,80,.65)";
    ctx.fillRect(X(i) - bw / 2, Math.min(y, zero), bw, Math.max(Math.abs(zero - y), 1));
  }
  [[dif, "#ff9f0a"], [dea, "var(--muted)"]].forEach(([arr, color]) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    arr.forEach((v, i) => { i ? ctx.lineTo(X(i), MY(v)) : ctx.moveTo(X(i), MY(v)); });
    ctx.stroke();
  });

  // 日期（统一三刻度：左 / 中 / 右）
  axisDraw(ctx, it, padL, cw, H - 4);
  cv._range = [itemStamp(it[0]).slice(0, 10), itemStamp(it[n - 1]).slice(0, 10)];

  // 十字光标
  if (sel !== null && sel !== undefined && sel >= start && sel < start + win) {
    drawCross(ctx, it, sel - start, start, X, padT, H, all, isMin, d.prev_close);
  }
}

/* ---------- 筹码分布（估算） ---------- */
async function loadChip(code) {
  const cv = $("#chipchart");
  if (!cv) return;
  const d = await api(`chip/${code}?days=120`).catch(() => null);
  const card = document.querySelector("#chipchart") && document.querySelector("#chipchart").closest(".chip-card");
  if (!d || !d.ok) {
    // 数据不足时直接收起整块（空画布 + 一行「数据不足」比不显示更糟，像坏了）
    if (card) card.classList.add("hidden");
    $("#chip-sum").textContent = "";
    return;
  }
  if (card) card.classList.remove("hidden");
  $("#chip-note").textContent = `${d.note} · 近${d.days}日`;
  $("#chip-sum").innerHTML =
    `<div><span class="k">获利比例</span><b class="${d.profit_ratio >= 50 ? "up" : "down"}">${d.profit_ratio}%</b></div>` +
    `<div><span class="k">平均成本</span><b>${d.avg_cost}</b></div>` +
    `<div><span class="k">90% 成本区间</span><b>${d.low90}–${d.high90}</b></div>`;
  cv._d = d;
  drawChip(cv, d);
}

function _cssVar(name, fallback) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch (e) { return fallback; }
}

function _tint(hex, a) {
  const h = String(hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(127,127,127,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function _roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawChip(cv, d) {
  const box = cv.parentElement;
  // .chip-card 左右各 12px padding；按真实内容宽度绘制，避免画布被水平拉伸
  const W = Math.max(240, (box ? box.clientWidth : 320) - 24);
  const H = 190;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = "100%";
  cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const font = '-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif';
  const bars = d.bars || [];
  if (bars.length < 2) {
    ctx.font = `11px ${font}`;
    ctx.fillStyle = _cssVar("--muted", "#86868b");
    ctx.fillText("暂无筹码数据", 6, 20);
    return;
  }

  const UP = _cssVar("--up", "#e5322d");
  const DOWN = _cssVar("--down", "#12a150");
  const BLUE = _cssVar("--blue", "#1d1d1f");
  const NOTE = _cssVar("--note", "#9a5b00");
  const MUTED = _cssVar("--muted", "#86868b");

  const padL = 6, padR = 54, padT = 10, padB = 8;
  const cw = W - padL - padR;
  const ph = H - padT - padB;
  const maxW = Math.max(...bars.map((b) => b.w), 1e-6);
  const cur = Number.isFinite(d.current) ? d.current : bars[bars.length - 1].p;
  const avg = d.avg_cost || 0;

  // 只画覆盖 98% 筹码的价格区间：远端尾部权重几乎为 0，留着只会把中间压扁
  const totalW = bars.reduce((s, b) => s + b.w, 0) || 1;
  let qLo = bars[0].p, qHi = bars[bars.length - 1].p, acc = 0;
  for (let i = 0; i < bars.length; i++) {
    acc += bars[i].w;
    if (acc / totalW >= 0.01) { qLo = bars[i].p; break; }
  }
  acc = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    acc += bars[i].w;
    if (acc / totalW >= 0.01) { qHi = bars[i].p; break; }
  }
  let lo = Math.min(qLo, cur, avg || cur);
  let hi = Math.max(qHi, cur, avg || cur);
  const span0 = Math.max(hi - lo, 1e-6);
  lo -= span0 * 0.02;
  hi += span0 * 0.02;
  const span = Math.max(hi - lo, 1e-6);
  const Y = (p) => padT + (1 - Math.max(0, Math.min(1, (p - lo) / span))) * ph;
  // 0.75 次幂：小权重的远端筹码也能看见，同时保留峰值的相对高度
  const X = (b) => padL + Math.pow(b.w / maxW, 0.75) * cw * 0.94;

  // 网格 + 右侧价格刻度
  ctx.font = `10px ${font}`;
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const p = hi - (span * i) / 4;
    const y = Math.round(Y(p)) + 0.5;
    ctx.strokeStyle = i === 0 || i === 4 ? _tint(MUTED, .28) : _tint(MUTED, .13);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cw + 2, y);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(p.toFixed(2), padL + cw + 8, y);
  }

  // 平滑筹码轮廓：从底价画到顶价，再回到左侧基线闭合
  const pts = bars.map((b) => ({ x: X(b), y: Y(b.p) }));
  const profile = () => {
    ctx.beginPath();
    ctx.moveTo(padL, Y(bars[0].p));
    for (let i = 1; i < pts.length - 1; i++) {
      const xc = (pts[i].x + pts[i + 1].x) / 2;
      const yc = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.lineTo(padL, Y(bars[bars.length - 1].p));
    ctx.closePath();
  };
  const yCur = Math.max(padT, Math.min(padT + ph, Y(cur)));

  // 获利盘（现价下方）红色渐变
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, yCur, cw, Math.max(0, padT + ph - yCur));
  ctx.clip();
  profile();
  let g = ctx.createLinearGradient(padL, 0, padL + cw, 0);
  g.addColorStop(0, _tint(UP, .05));
  g.addColorStop(.5, _tint(UP, .24));
  g.addColorStop(1, _tint(UP, .46));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // 套牢盘（现价上方）绿色渐变
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, cw, Math.max(0, yCur - padT));
  ctx.clip();
  profile();
  g = ctx.createLinearGradient(padL, 0, padL + cw, 0);
  g.addColorStop(0, _tint(DOWN, .04));
  g.addColorStop(1, _tint(DOWN, .34));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // 轮廓
  profile();
  ctx.strokeStyle = _tint(MUTED, .45);
  ctx.lineWidth = 1;
  ctx.stroke();

  // 平均成本：琥珀色点线 + 左侧小标签
  if (avg > 0) {
    const ya = Y(avg);
    ctx.strokeStyle = _tint("#ff9f0a", .9);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, ya + .5);
    ctx.lineTo(padL + cw, ya + .5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `600 10px ${font}`;
    const txt = `均 ${avg.toFixed(2)}`;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = _tint("#ff9f0a", .16);
    _roundRect(ctx, padL + 1, ya - 8.5, tw + 10, 17, 8.5);
    ctx.fill();
    ctx.fillStyle = NOTE;
    ctx.fillText(txt, padL + 6, ya + .5);
  }

  // 现价：蓝色虚线 + 右侧价格胶囊
  ctx.strokeStyle = _tint(BLUE, .9);
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padL, yCur + .5);
  ctx.lineTo(padL + cw, yCur + .5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `600 10px ${font}`;
  const curTxt = cur.toFixed(2);
  const curW = ctx.measureText(curTxt).width + 12;
  const curX = padL + cw + 4;
  const curY = Math.max(2, Math.min(H - 20, yCur - 9));
  ctx.fillStyle = BLUE;
  _roundRect(ctx, curX, curY, curW, 18, 9);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(curTxt, curX + 6, curY + 9.5);
}

/* ---------- 资金流向 ---------- */
async function loadFundflow(code) {
  const cv = $("#ffchart");
  if (!cv) return;
  const d = await api(`fundflow/${code}?days=20`).catch(() => null);
  if (!d) { $("#ff-date").textContent = "暂无数据"; return; }
  $("#ff-date").textContent = d.detail && d.detail.date ? d.detail.date : "";
  const det = d.detail;
  if (det) {
    const rows = [{ name: "主力", net: det.main, pct: det.main_pct, main: true }].concat(det.rows);
    $("#ff-detail").innerHTML = rows
      .map((r) => `<div class="ff-row ${r.main ? "main" : ""}">
        <span class="n">${r.name}</span>
        <b class="${cls(r.net)}">${fmtYi(r.net)}</b>
        <span class="${cls(r.net)}">${r.pct > 0 ? "+" : ""}${r.pct}%</span>
      </div>`)
      .join("");
  } else {
    $("#ff-detail").innerHTML = `<div class="ff-row"><span class="n">暂无明细</span></div>`;
  }
  $("#ff-sum").textContent = `近5日 ${fmtYi(d.sum["5"])} · 近10日 ${fmtYi(d.sum["10"])} · 近20日 ${fmtYi(d.sum["20"])}`;
  cv._items = d.items || [];
  drawFF(cv, cv._items);
}

function drawFF(cv, items) {
  const box = cv.parentElement;
  const W = Math.max(240, (box ? box.clientWidth : 320) - 34);
  const H = 86;      // 底部留一行给日期轴，右侧极值标签上移，别和轴挤成一团
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = "100%";
  cv.style.height = H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "9px -apple-system,sans-serif";
  if (!items.length) {
    ctx.fillStyle = "#86868b"; ctx.fillText("暂无资金流数据", 6, 16); return;
  }
  const padR = 40, cw = W - padR - 4;
  const max = Math.max(...items.map((x) => Math.abs(x.main)), 1);
  const mid = 39;
  const step = cw / items.length;
  ctx.strokeStyle = "rgba(127,127,127,.25)";
  ctx.beginPath(); ctx.moveTo(2, mid); ctx.lineTo(2 + cw, mid); ctx.stroke();
  items.forEach((x, i) => {
    const h = (Math.abs(x.main) / max) * (mid - 8);
    ctx.fillStyle = x.main >= 0 ? "rgba(229,50,45,.75)" : "rgba(18,161,80,.75)";
    const bw = Math.max(1.5, Math.min(step * 0.38, 7));
    ctx.fillRect(2 + step * i + (step - bw) / 2, x.main >= 0 ? mid - h : mid, bw, Math.max(h, 1));
  });
  ctx.fillStyle = "#86868b";
  ctx.fillText(fmtYi(max), cw + 6, 12);
  ctx.fillText(fmtYi(-max), cw + 6, mid - 6);
  axisDraw(ctx, items, 2, cw, H - 3);
}

/* ---------- 多选删除 ---------- */
const SEL_LISTS = {
  note: { box: "#notes", item: ".item", kind: "note", idAttr: "id", unit: "条记录" },
  focus: { box: "#news-focus", item: ".news-item", kind: "news", idAttr: "id", unit: "条新闻" },
  live: { box: "#live-list", item: ".live-item", kind: "news", idAttr: "id", unit: "条新闻" },
  hold: { box: "#hold-list", item: ".row", kind: "stock", idAttr: "code", unit: "只个股" },
  watch: { box: "#watch-list", item: ".row", kind: "stock", idAttr: "code", unit: "只个股" },
};
state.sel = { key: "", ids: new Set() };

function selCfg() { return SEL_LISTS[state.sel.key] || null; }
function selItems() {
  const c = selCfg();
  return c ? $$(`${c.box} ${c.item}`).filter((el) => el.dataset[c.idAttr]) : [];
}
function elId(el, c) { return el.dataset[c.idAttr]; }

function enterSel(key) {
  if (state.sel.key === key) return exitSel();
  state.sel.key = key;
  state.sel.ids = new Set();
  $$(".sel-on").forEach((el) => el.classList.remove("sel-on"));
  document.body.classList.add("selmode");
  $("#selbar").classList.remove("hidden");
  $$("[data-sel]").forEach((b) => (b.textContent = b.dataset.sel === key ? "完成" : "多选"));
  renderSel();
}
function exitSel() {
  state.sel.key = "";
  state.sel.ids = new Set();
  document.body.classList.remove("selmode");
  $("#selbar").classList.add("hidden");
  $$(".sel-on").forEach((el) => el.classList.remove("sel-on"));
  $$("[data-sel]").forEach((b) => (b.textContent = "多选"));
}
function renderSel() {
  const n = state.sel.ids.size;
  $("#sel-count").textContent = n ? `已选 ${n} 项` : "点条目多选";
  $("#sel-del").disabled = !n;
  const items = selItems();
  const allOn = items.length > 0 && items.every((el) => state.sel.ids.has(elId(el, selCfg())));
  $("#sel-all").textContent = allOn ? "取消全选" : "全选";
}
function toggleSel(el) {
  const c = selCfg();
  const id = elId(el, c);
  if (!id) return;
  if (state.sel.ids.has(id)) state.sel.ids.delete(id);
  else state.sel.ids.add(id);
  el.classList.toggle("sel-on", state.sel.ids.has(id));
  renderSel();
}

/* 选择模式下拦掉原来的点击（看详情 / 展开 / 跳转），改成勾选 */
document.addEventListener("click", (e) => {
  if (!state.sel.key) return;
  // 长按刚触发：松手这一次 click 不再重复勾选
  if (Date.now() - (state._lpAt || 0) < 600) {
    state._lpAt = 0;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.target.closest("#selbar") || e.target.closest("[data-sel]")) return;
  const c = selCfg();
  const el = e.target.closest(`${c.box} ${c.item}`);
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  toggleSel(el);
}, true);
document.addEventListener("touchstart", (e) => {
  if (state.sel.key) e.stopPropagation();
}, { capture: true, passive: true });

$$("[data-sel]").forEach((b) => {
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    enterSel(b.dataset.sel);
  });
});

/* ---- 长按分段按钮进入批量选择：持仓「我的持仓」、自选「关注」、记录「新闻/记录/分析」 ---- */
let segLpAt = 0;
function bindSegLongPress(box, getKey) {
  if (!box) return;
  if (box.dataset.seglp !== "1") {
    box.dataset.seglp = "1";
    // 长按松手那一次 click 不要再当切换 tab
    box.addEventListener("click", (e) => {
      if (Date.now() - segLpAt < 700) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }
  $$("button", box).forEach((b) => {
    let timer = null;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    b.addEventListener("touchstart", () => {
      const k = getKey(b);
      if (!k) return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        segLpAt = Date.now();
        if (k.before) k.before(b);
        enterSel(k.sel);
        if (!state.sel.key) return;
        toast("已进入多选，点条目勾选");
        try { navigator.vibrate && navigator.vibrate(18); } catch (e) { /* 忽略 */ }
      }, 480);
    }, { passive: true });
    ["touchend", "touchmove", "touchcancel"].forEach((ev) => b.addEventListener(ev, cancel, { passive: true }));
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

bindSegLongPress($("#hold-seg"), (b) =>
  b.dataset.tab === "mine" ? { sel: "hold", before: () => setHoldTab("mine") } : null);
bindSegLongPress($("#watch-seg"), (b) =>
  b.dataset.tab === "mine" ? { sel: "watch", before: () => setWatchTab("mine") } : null);

function bindNoteKindLongPress() {
  bindSegLongPress($("#note-kind-filter"), (b) => b.dataset.kind === "mark" ? null : ({
    sel: "note",
    before: () => {
      state.noteKind = b.dataset.kind;
      state.noteTag = "";
      renderNoteFilters();
      renderNotes();
    },
  }));
}

$("#sel-cancel").addEventListener("click", exitSel);
$("#sel-all").addEventListener("click", () => {
  const items = selItems();
  const c = selCfg();
  if (!c) return;
  const allOn = items.length > 0 && items.every((el) => state.sel.ids.has(elId(el, c)));
  state.sel.ids = new Set(allOn ? [] : items.map((el) => elId(el, c)));
  items.forEach((el) => el.classList.toggle("sel-on", state.sel.ids.has(elId(el, c))));
  renderSel();
});
$("#sel-del").addEventListener("click", async () => {
  const c = selCfg();
  if (!c) return;
  const ids = [...state.sel.ids];
  if (!ids.length) return;
  const keep = c.kind === "note"
    ? "删除后可在回收站找回，笔记不会自动清理"
    : `删除后可在回收站找回（${state.trashDays || 7} 天内）`;
  const b = $("#sel-del");
  // 原生 confirm 在 App 里点了没反应，改成同一按钮点两次；提示走 toast 不挡操作
  const note = c.kind === "stock" ? `${keep}；显式关联的笔记会一起进回收站` : keep;
  if (!armAsk(b, `再点一次确认删除 ${ids.length} ${c.unit}`)) return toast(note);
  b.disabled = true;
  const old = b.textContent;
  b.textContent = "删除中…";
  try {
    // 记录列表里混着 notes（记录）和 news（收藏的新闻）：按每张卡自己的 kind 分组删，
    // 否则会拿 news 的 id 去 notes 表里乱删
    const els = selItems().filter((el) => state.sel.ids.has(elId(el, c)));
    const groups = {};
    els.forEach((el) => {
      const k = el.dataset.kind === "news" ? "news" : c.kind;
      (groups[k] || (groups[k] = [])).push(elId(el, c));
    });
    let deleted = 0, notesRemoved = 0;
    for (const [kind, gids] of Object.entries(groups)) {
      const r = await api("bulk-delete", {
        method: "POST",
        body: { kind, ids: gids, ...(kind === "stock" ? { with_notes: true } : {}) },
        idempotent: true,
      });
      deleted += r.deleted ?? gids.length;
      notesRemoved += r.notes_removed || 0;
      await refreshAfterBulk(kind, gids);
    }
    exitSel();
    toast(`已删除 ${deleted} 项${notesRemoved ? `，${notesRemoved} 条关联笔记一起进了回收站` : ""}`);
  } catch (e) {
    toast(e.message);
  }
  b.disabled = false;
  b.textContent = old;
});

async function refreshAfterBulk(kind, ids) {
  const gone = new Set(ids.map(String));
  gone.forEach((id) => state.liveOpen.delete(id));
  if (kind === "stock") return loadBoard(true).catch(() => {});
  if (kind === "note") {
    await loadNotes().catch(() => {});
    return loadBoard(true).catch(() => {});
  }
  state.focusByDay = {};
  await loadFeed(true).catch(() => {});
  if (kind === "news") {
    state.savedNews = (state.savedNews || []).filter((x) => !gone.has(String(x.id)));
    renderNotes();
  }
  state.focusItems = (state.focusItems || []).filter((x) => !gone.has(String(x.id)));
  state.favorites = (state.favorites || []).filter((x) => !gone.has(String(x.id)));
  state.liveAll = (state.liveAll || []).filter((x) => !gone.has(String(x.id)));
  syncFavCount();
  renderFocus(state.focusItems);
  renderLive(state.liveAll, (state.feed && state.feed.live_at) || "");
  if (state.liveTab === "fav") renderFavorites();
}

/* ---------- boot ---------- */
// 首屏先用上次的数据秒开（隧道单次往返 1~7s，等接口回来再画就是"卡"的根源），
// 后台静默刷新；只有缓存不可用时才退回"等接口"的老路径。
const BOOT_CACHE = "astock.boot.v1";
function readBootCache() {
  try {
    const o = JSON.parse(localStorage.getItem(BOOT_CACHE) || "null");
    if (!o || !o.ts || !o.board || !o.feed) return null;
    if (Date.now() - o.ts > 36 * 3600 * 1000) return null;
    return o;
  } catch (e) {
    return null;
  }
}
function writeBootCache(d) {
  try {
    localStorage.setItem(BOOT_CACHE, JSON.stringify({ ts: Date.now(), board: d.board, feed: d.feed }));
  } catch (e) { /* 隐私模式/配额满，忽略 */ }
}
function dropBootCache() {
  try { localStorage.removeItem(BOOT_CACHE); } catch (e) {}
}

async function boot() {
  const cached = readBootCache();
  if (cached) {
    showApp();
    try { applyBoard(cached.board); applyFeed(cached.feed); } catch (e) {}
    activateView("hold");
    schedulePoll();
    // 后台刷新，失败也不打扰（下次可见/轮询还会再来）
    api("boot", { noRetry: true }, 20000)
      .then((d) => {
        if (!d.authed) { dropBootCache(); return showLogin(); }
        applyBoard(d.board);
        applyFeed(d.feed);
        writeBootCache(d);
      })
      .catch(() => {});
    return;
  }
  try {
    const d = await api("boot", { noRetry: true }, 20000);
    if (!d.authed) return showLogin();
    showApp();
    applyBoard(d.board);
    applyFeed(d.feed);
    writeBootCache(d);
    activateView("hold");
    schedulePoll();
  } catch (e) {
    // 隧道首个请求偶发卡住：先出界面（骨架屏），后台自己重试；401 会自动回登录页
    showApp();
    activateView("hold");
    setView("hold");
    startBootRetry();
  }
}

/* 首屏请求失败：指数退避重试 3 次；都失败就把骨架屏换成可点的失败卡片 */
let bootRetrying = false;
async function startBootRetry() {
  if (bootRetrying) return;
  bootRetrying = true;
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    try {
      const d = await api("boot", { noRetry: true }, 20000);
      if (!d.authed) { bootRetrying = false; return showLogin(); }
      applyBoard(d.board);
      applyFeed(d.feed);
      writeBootCache(d);
      bootRetrying = false;
      return;
    } catch (err) { /* 下一轮 */ }
  }
  bootRetrying = false;
  const box = $("#hold-list");
  if (box && !state.board) {
    box.innerHTML = `<div class="empty-rich">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5V8h-3.5"/></svg>
      <div class="er-t">数据没加载出来</div><div class="er-d">网络或服务刚重启，点下面再试一次</div>
      <button class="btn primary small" id="boot-retry">重试</button></div>`;
    const b = $("#boot-retry");
    if (b) b.onclick = () => { box.innerHTML = `<div class="list-skel" aria-hidden="true"><i></i><i></i><i></i></div>`; startBootRetry(); };
  }
}
// 从后台切回来时只刷新当前 tab：手机挂后台过夜，醒来行情可能已经开盘
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  // 从后台回来顺手核一次版本：改了样式/脚本不用手动重开也不会看到旧壳子
  if (Number(sessionStorage.getItem("assetReloads") || 0) < 3) checkAssetFreshness().catch(() => {});
  if (!["feed", "hold", "watch"].includes(state.view)) return schedulePoll();
  const sh = $("#sheet");
  if ((sh && !sh.classList.contains("hidden")) || (state.sel && state.sel.key)) {
    return schedulePoll();
  }
  refreshVisible(true).catch(() => {}).finally(() => schedulePoll());
});

/* ---- 版本自检：手机/微信 WebView 常把 index.html 缓存很久，导致改了前端也看不到。
   启动后比对服务器上 app 各分区 / style.css 的内容哈希，不一致就自动刷新（每次会话最多 3 次，防死循环）。
   拆分后 app 是一组文件，版本号统一取「各分区内容哈希拼起来再哈希」的那一个，任一分区变了都会刷新。 ---- */
function appVerToken() {
  // 第一个分区带 data-app 标记：拆分后不能再靠 app.js 这个文件名找
  const tag = document.querySelector('script[data-app], script[src*="/app-"]');
  const mm = tag && /app[-a-z0-9_]*\.js\?v=([\w.-]+)/i.exec(tag.src);
  return (mm && mm[1]) || "";
}
async function assetIsStale() {
  try {
    const m = appVerToken();
    const link = document.querySelector('link[href*="style.css"]');
    const mc = link && /style\.css\?v=([\w.-]+)/.exec(link.href);
    if (!m && !mc) return false;
    const r = await fetch("api/v1/assetver", { cache: "no-store" });
    if (!r.ok) return false;
    const d = await r.json();
    return (d.app && m && d.app !== m) || (d.style && mc && d.style !== mc[1]);
  } catch (e) { return false; }
}

function reloadFresh() {
  const u = new URL(location.href);
  u.searchParams.set("v", Date.now());       // 换成新 URL 才绕得过缓存
  location.replace(u.toString());
}

/* ---- 版本显示：页面页脚 + 「更多」里的版本行，点一下就能核对是否最新 ---- */
function localVerTokens() {
  const tag = document.querySelector('script[data-app], script[src*="/app-"]');
  const m = tag && /app[-a-z0-9_]*\.js\?v=([\w.-]+)/i.exec(tag.src);
  const link = document.querySelector('link[href*="style.css"]');
  const mc = link && /style\.css\?v=([\w.-]+)/.exec(link.href);
  return { app: (m && m[1]) || "", style: (mc && mc[1]) || "" };
}
async function serverVerTokens() {
  try {
    const r = await fetch("api/v1/assetver", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
function verShort(v) { return String(v || "").slice(0, 10); }
async function paintVerTags() {
  const els = $$("[data-ver]");
  if (!els.length) return;
  const d = await serverVerTokens();
  const t = localVerTokens();
  const sv = (d && d.app) || t.app;
  const label = sv ? `v ${verShort(sv)}` : "版本未知";
  els.forEach((el) => {
    el.textContent = label;
    el.hidden = false;
    el.dataset.verLabel = label;
    el.onclick = () => tapVerTag();
  });
  $$("[data-ver-sub]").forEach((el) => { el.textContent = label; });
}
async function tapVerTag() {
  const t = localVerTokens();
  const d = await serverVerTokens();
  if (!d) { toast("读不到服务器版本"); return; }
  if ((d.app && t.app && d.app !== t.app) || (d.style && t.style && d.style !== t.style)) {
    toast("有新版本，正在更新…");
    reloadFresh();
    return;
  }
  toast("已经是最新版本");
}
async function checkAssetFreshness(fakeVer) {
  try {
    if (Number(sessionStorage.getItem("assetReloads") || 0) >= 5) return;   // 防死循环
    const now = Date.now();
    if (now - Number(sessionStorage.getItem("assetReloadAt") || 0) < 15000) return;  // 15 秒内不重复检查
    const m = appVerToken();
    if (!m) return;
    const link = document.querySelector('link[href*="style.css"]');
    const mc = link && /style\.css\?v=([\w.-]+)/.exec(link.href);
    let ver = fakeVer;
    let cssVer = fakeVer;
    if (!ver) {
      const r = await fetch("api/v1/assetver", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      ver = d.app || "";
      cssVer = d.style || "";
    }
    const stale = (ver && ver !== m) || (cssVer && mc && cssVer !== mc[1]);
    if (!stale) { sessionStorage.removeItem("assetReloads"); return; }
    sessionStorage.setItem("assetReloads", String(Number(sessionStorage.getItem("assetReloads") || 0) + 1));
    sessionStorage.setItem("assetReloadAt", String(Date.now()));
    toast("有新版本，正在更新…");
    reloadFresh();
  } catch (e) { /* 版本检查失败就当没事 */ }
}


/* ---------- 二级吸顶：把各页的分段控件条挂到顶栏下方 ---------- */
function initStickySegs() {
  const tb = document.querySelector(".topbar");
  const tbH = tb ? Math.round(tb.getBoundingClientRect().height) : 48;
  document.documentElement.style.setProperty("--tb", tbH + "px");

  const wrap = (seg, level) => {
    if (!seg || seg.dataset.stick) return null;
    const w = document.createElement("div");
    w.className = "seg-stick";
    w.dataset.level = String(level);
    seg.parentNode.insertBefore(w, seg);
    w.appendChild(seg);
    seg.dataset.stick = "1";
    return w;
  };

  document.querySelectorAll(".view").forEach((view) => {
    // 一级：直接属于该页的分段控件
    let l1h = 0;
    Array.from(view.children).forEach((el) => {
      if (!el.classList.contains("seg")) return;
      const w = wrap(el, 1);
      if (w) l1h = Math.max(l1h, w.offsetHeight);
    });
    if (!l1h) l1h = 44;
    // 筛选条不再吸顶：透明胶囊压不住下面滑过的卡片文字，且吸顶层本身在深色页上就是一块黑蒙版
    // （需要筛选条件常驻时，用户会自己滚回顶部，这里不做牺牲可读性的贴片）
    // 二级（行情/大盘分析、昨日/今日热门、趋势排序）不再吸顶：两层一起钉住会盖掉 120px 内容
  });
}

/* 子面板隐藏时高度为 0，切页后再量一次，二级吸顶才落在正确位置 */
function refreshStickyTops() {
  const tbH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb")) || 48;
  document.querySelectorAll(".chips-stick").forEach((c) => {
    const view = c.closest(".view");
    const l1 = view && view.querySelector('.seg-stick[data-level="1"]');
    const h = l1 && l1.offsetHeight ? l1.offsetHeight : 44;
    c.style.top = `calc(var(--tb) + ${h}px)`;
  });
  const tb = document.querySelector(".topbar");
  if (tb) document.documentElement.style.setProperty("--tb", Math.round(tb.getBoundingClientRect().height) + "px");
}

/* ---------- 下拉刷新：已经在最顶部还继续往下拉才触发 ---------- */
async function pullRefresh() {
  const dg = document.querySelector("#digest");
  if (dg && !dg.classList.contains("hidden")) return loadDigests(true);   // 新闻页：重拉总结/未读/已读
  _memo.delete("board");
  if (state.view === "hold" && state.holdTab === "market" && state.mktTab === "hot") return loadHot(true, true);
  if (state.view === "hold" && state.holdTab === "market") return loadMarket(true, true);
  if (isWatchPane() && state.watchTab === "trend") return loadTrend(true, state.trendDate);
  if (state.view === "note") return loadNotes();
  return loadBoard(true);
}

/* ---------- 横向滑动护栏：iOS 上整页会被左右拖着走（露白边），这里只放行真正能横滑的子元素 ---------- */
function initPanGuard() {
  if (!("ontouchstart" in window)) return;
  let sx = 0, sy = 0, axis = null;

  const inScroller = (node) => {
    let n = node;
    while (n && n !== document.body && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      const ox = cs.overflowX;
      if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1) return true;
      n = n.parentElement;
    }
    return false;
  };

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { axis = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; axis = null;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!axis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (axis !== "x") return;
    if (inScroller(e.target)) return;          // 标签条等自带横滑的元素照旧
    if (e.cancelable) e.preventDefault();       // 其余情况不让整页横移
  }, { passive: false });
}

function initPullRefresh() {
  if (!("ontouchstart" in window)) return;
  // 按用户要求去掉屏幕上方的「下拉刷新 / 松开刷新 / 正在刷新」提示条：
  // 手势照旧生效，只是不再显示这个悬浮图标（元素建在内存里，不挂到页面上）
  const el = document.createElement("div");
  el.id = "ptr";
  el.innerHTML = '<span class="ptr-icon">↓</span><span class="ptr-text">下拉刷新</span>';

  const icon = el.querySelector(".ptr-icon");
  const label = el.querySelector(".ptr-text");
  const TH = 56;          // 触发阈值（手指位移的一半算数，约等于 112px 手感）
  let startY = null, dist = 0, ready = false, busy = false;

  const overlayOpen = () => {
    if (document.body.classList.contains("dg-open") || document.body.classList.contains("gs-open")) return true;
    return ["#sheet", "#sheet2", "#gsearch", "#digest", "#login"]
      .some((sel) => { const e = document.querySelector(sel); return e && !e.classList.contains("hidden"); });
  };
  const hide = () => { el.style.opacity = "0"; el.style.transform = "translate(-50%,-140%)"; };

  document.addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1) { startY = null; return; }
    const dg = document.querySelector("#digest");
    const dgOpen = dg && !dg.classList.contains("hidden");
    if (dgOpen) {
      const body = document.querySelector("#dg-body");
      if (body && body.scrollTop > 1) { startY = null; return; }   // 新闻列表已滚动：不当成下拉
    } else if ((window.scrollY || 0) > 0 || _pageLocks.size || overlayOpen()) {
      startY = null; return;
    }
    startY = e.touches[0].clientY;
    dist = 0; ready = false;
    placePtr();
  }, { passive: true });

  // 提示条跟着吸顶条带下沿走：下拉时页面布局会微动，每次位移都重新量一次，避免压住分段控件
  function placePtr() {
    const tbH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tb")) || 48;
    const bottoms = Array.from(document.querySelectorAll(".seg-stick,.chips-stick,.seg"))
      .filter((w) => w.offsetHeight > 0 && w.getBoundingClientRect().top < tbH + 130)
      .map((w) => w.getBoundingClientRect().bottom);
    el.style.top = Math.round(Math.max(tbH, ...bottoms)) + 18 + "px";
  }

  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if ((window.scrollY || 0) > 0 || dy <= 0) { el.style.opacity = "0"; dist = 0; ready = false; el.classList.remove("ready"); return; }
    dist = Math.min(112, dy * 0.5);
    placePtr();
    el.style.transform = `translate(-50%, ${dist}px)`;
    el.style.opacity = "1";
    const nowReady = dist >= TH;
    if (nowReady !== ready) {
      ready = nowReady;
      el.classList.toggle("ready", ready);
      label.textContent = ready ? "松开刷新" : "下拉刷新";
    }
  }, { passive: true });

  document.addEventListener("touchcancel", () => { startY = null; el.classList.remove("ready"); hide(); }, { passive: true });

  document.addEventListener("touchend", async () => {
    if (startY === null) return;
    startY = null;
    if (!ready) { el.classList.remove("ready"); hide(); return; }
    ready = false; busy = true;
    el.classList.add("loading");
    icon.textContent = "↻";
    label.textContent = "正在刷新…";
    el.style.transform = "translate(-50%, 8px)";
    el.style.opacity = "1";
    try { await pullRefresh(); } catch (e) { /* 单次失败不弹错 */ }
    if (await assetIsStale()) {                 // 下拉刷新只刷数据不换样式，这里顺手把旧资源换掉
      el.classList.remove("loading");
      toast("发现新版本，正在更新…");
      reloadFresh();
      return;
    }
    el.classList.remove("loading");
    icon.textContent = "✓";
    label.textContent = "已刷新";
    setTimeout(() => { hide(); setTimeout(() => { icon.textContent = "↓"; el.classList.remove("ready"); }, 200); }, 700);
    busy = false;
  }, { passive: true });
}


bindMarketRetry();
initStickySegs();
initPullRefresh();
initPanGuard();
refreshStickyTops();
window.addEventListener("resize", () => setTimeout(refreshStickyTops, 120));
window.addEventListener("orientationchange", () => setTimeout(refreshStickyTops, 260));

boot();
setTimeout(() => checkAssetFreshness(), 1500);
setTimeout(() => paintVerTags(), 900);

/* ---------- 版面抖动探针（仅 ?dbg=jitter 生效，正常使用不跑） ---------- */
(function jitterProbe() {
  if (!/[?&]dbg=jitter/.test(location.search)) return;
  let samples = [];
  let t0 = 0;
  let on = false;
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [Math.round(b.top * 10) / 10, Math.round(b.height * 10) / 10];
  };
  const snap = () => {
    const item = document.querySelector("#notes .item") || document.querySelector("#notes .list-skel");
    return {
      t: Date.now() - t0,
      sy: Math.round(window.scrollY),
      dh: document.documentElement.scrollHeight,
      vh: window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight,
      comp: rect(document.querySelector("#view-note .composer")),
      seg: rect(document.querySelector("#note-kind-filter")),
      item: rect(item),
      n: document.querySelectorAll("#notes .item").length,
      skel: !!document.querySelector("#notes .list-skel"),
    };
  };
  const send = () => {
    const keep = [];
    let prev = "";
    samples.forEach((s) => {
      const k = JSON.stringify([s.comp, s.seg, s.item, s.n, s.skel, s.sy, s.dh]);
      if (k !== prev) { keep.push(s); prev = k; }
    });
    api("debug/probe", {
      method: "POST", idempotent: true,
      body: { url: location.pathname + location.search, frames: samples.length, keep, css: getComputedStyle(document.documentElement).fontSize },
    }).catch(() => {});
  };
  const loop = () => {
    if (!on) return;
    samples.push(snap());
    if (Date.now() - t0 > 1600) { on = false; send(); return; }
    requestAnimationFrame(loop);
  };
  window.__jitterStart = () => {
    t0 = Date.now();
    samples = [];
    on = true;
    requestAnimationFrame(loop);
  };
})();

/* 启动就布防：不切到工作页也能到点响 */
setTimeout(() => { wkArm(); loadWork().catch(() => {}); }, 2500);

/* ================= 工作台：工作类型 → 多条带时间的日程，到点响铃 + 震动 ================= */
function wkPad(n) { return String(n).padStart(2, "0"); }
function wkNow() {
  // 站内所有工作逻辑都以北京时间为准（服务端也是 BJ）：
  // 直接按手机时区取「今天/现在」会在出差或改时区时整体错一天。
  const d = new Date();
  const bj = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${bj.getFullYear()}-${wkPad(bj.getMonth() + 1)}-${wkPad(bj.getDate())} ${wkPad(bj.getHours())}:${wkPad(bj.getMinutes())}`;
}
function wkTypeName(id) {
  const t = ((state.work && state.work.types) || []).find((x) => String(x.id) === String(id));
  return t ? t.name : "未分类";
}

async function loadWork(force) {
  state.workAt = Date.now();
  try {
    const d = await api("work", force ? { noRetry: true } : {}, 15000);
    state.work = { types: d.types || [], tasks: d.tasks || [],
      focus: d.focus || { modes: [], run: null }, shift: d.shift || { types: [], rosters: [], overrides: {} },
      daily: d.daily || [] };
    if (d.today) state.today = d.today;
  } catch (e) {
    if (!state.work) state.work = { types: [], tasks: [], focus: { modes: [], run: null }, shift: { types: [], rosters: [], overrides: {} }, daily: [] };
  }
  try { await wkSyncStepDone(); } catch (e) {}   // 服务端那份「已做过的步骤」先并进本地，提醒 / 圆点才不会错
  renderWork();
  renderFocus();
  renderShift();
  renderWkStat();
  wkPushNative();
  wkCheckDue();
  wkFlushPendingAlarm();
  wkCheckExtra(true);   // 冷启动点到通知进来：数据一到就把这条弹出来并接着响
}

function renderWork() {
  const listBox = $("#wk-list");
  const chipBox = $("#wk-types");
  if (!listBox || !chipBox) return;
  const { types, tasks } = state.work || { types: [], tasks: [] };
  const sel = state.wkType || "";
  // 默认只看今天：日程多的时候（尤其是重复日程）不再一屏拉到月底；
  // 点日历任意一天就切到那天，「全部日期」才铺开
  if (state.wkDay === undefined) state.wkDay = wkToday();
  const day = state.wkDay;
  const dayTasks = day ? tasks.filter((t) => String(t.due_at || "").slice(0, 10) === day) : tasks;
  const shown = dayTasks.filter((t) => !sel || String(t.type_id) === String(sel))
    .slice().sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0));
  renderWkStat();
  // 日历下面那条：现在是哪一天、几项，以及切回全部/今天的开关
  const bar = $("#wk-daybar");
  if (bar) {
    const n = shown.length;
    const label = day
      ? `${esc(day.slice(5).replace("-", "/"))} ${esc(bjWeekday(day))}${day === wkNow().slice(0, 10) ? " · 今天" : ""}`
      : "全部日期";
    bar.innerHTML = `<span class="wk-dbl">${label}${day ? ` · <b>${n} 项</b>` : ""}</span>
      <button type="button" class="wk-dbt" data-daytoggle>${day ? "全部日期" : "只看今天"}</button>`;
    const tg = bar.querySelector("[data-daytoggle]");
    if (tg) tg.onclick = () => { state.wkDay = day ? "" : wkToday(); renderWork(); };
  }

  // 计数跟当前显示范围走：选中某一天就是那天的条数（否则「今天 0 项」旁边挂个「全部 131」很别扭），
  // 只有铺开「全部日期」时才用全量
  const base = day ? dayTasks : tasks;
  const cntOf = (id) => base.filter((t) => String(t.type_id) === String(id)).length;
  chipBox.innerHTML = `<button type="button" class="chip${!sel ? " on" : ""}" data-wktype="">全部 ${base.length}</button>`
    + types.map((t) => `<button type="button" class="chip${String(sel) === String(t.id) ? " on" : ""}" data-wktype="${t.id}" data-wktlong="${t.id}">${esc(t.name)}<i class="wk-n">${cntOf(t.id)}</i></button>`).join("")
    + `<button type="button" class="chip wk-new" data-wknewtype title="管理和新建类型">类型</button>`;

  const groups = [];
  shown.forEach((t) => {
    const d = String(t.due_at || "").slice(0, 10);
    const g = groups[groups.length - 1];
    if (g && g.d === d) g.items.push(t);
    else groups.push({ d, items: [t] });
  });
  const now = wkNow();
  const tOrder = (a, b) => (String(a.due_at || "") < String(b.due_at || "") ? -1
    : String(a.due_at || "") > String(b.due_at || "") ? 1 : 0);
  // 行模板：没做完的正常两行；做完的压成一行小字（和专注步骤的 .mini 同一套口径）
  const rowHtml = (t, mini) => {
    const hm = esc(String(t.due_at || "").slice(11));
    if (mini) return `<div class="wk-row mini done" data-wkt="${t.id}">
      <button type="button" class="wk-ck on" data-wkck="${t.id}" aria-label="标记未完成"><svg viewBox="0 0 24 24"><path d="M5.5 12.6l4.2 4.2L18.5 7.6"/></svg></button>
      <span class="mini-t">${esc(t.title)}</span><span class="mini-hm">${hm}</span>
    </div>`;
    return `<div class="wk-row" data-wkt="${t.id}">
      <button type="button" class="wk-ck" data-wkck="${t.id}" aria-label="完成"><svg viewBox="0 0 24 24"><path d="M5.5 12.6l4.2 4.2L18.5 7.6"/></svg></button>
      <div class="wk-mid">
        <span class="wk-t">${esc(t.title)}</span>
        <span class="wk-m">${hm} · ${esc(wkTypeName(t.type_id))}${t.note ? ` · ${esc(t.note)}` : ""}${wkRepeatLabel(wkRuleDays(t)) ? " · " + esc(wkRepeatLabel(wkRuleDays(t))) : ""}${t.due_at && t.due_at < now ? ' <i class="wk-late">已过</i>' : ""}</span>
      </div>
      <span class="wk-chev" aria-hidden="true">›</span>
    </div>`;
  };
  listBox.innerHTML = groups.length ? groups.map((g) => {
    const dl = daysUntil(g.d);
    const name = dl === "今天" || dl === "明天" ? dl : bjWeekday(g.d);
    // 先看还有哪些没做，做完的沉到最后、压成一行；一天超过 5 项就收进一段可滑动区
    // （滚动条沿用全局的无色透明款，只占位置不画条）
    const pend = g.items.filter((t) => !t.done).sort(tOrder);
    const done = g.items.filter((t) => t.done).sort(tOrder);
    const rows = pend.map((t) => rowHtml(t, false)).join("") + done.map((t) => rowHtml(t, true)).join("");
    const cls = g.items.length > 5 ? " wk-glist wk-gscroll" : " wk-glist";
    return `<div class="wk-group">
      <div class="wk-ghead"><span class="${dl === "今天" ? "now" : ""}">${esc(name)}</span>
        <span>${esc(g.d.slice(5))}</span><b class="wk-gn">${g.items.length} 项</b></div>
      <div class="${cls.trim()}">${rows}</div>
    </div>`;
  }).join("") : `<div class="wk-empty">${!types.length ? "先建一个工作类型（比如「开发」「运营」），再往里加日程"
    : day ? `${day.slice(5).replace("-", "/")} 这天没有日程，点「全部日期」看别的日子` : "还没有日程，点下面的「新建日程」"}</div>`;

  // 超过 5 项的那一段：把窗口高度卡在「正好 5 行」上，不要在行中间切断；
  // 行高会随标题是否折行变化，所以渲染完按真实行数一次量准
  requestAnimationFrame(() => {
    $$(".wk-glist.wk-gscroll", listBox).forEach((g) => {
      const rows = g.querySelectorAll(".wk-row");
      if (rows.length < 6) return;
      const first = rows[0].getBoundingClientRect();
      const fifth = rows[4].getBoundingClientRect();
      const h = Math.round(fifth.bottom - first.top);
      if (h > 40) g.style.maxHeight = h + "px";
    });
  });

  // 左滑删除：日程行、每日提醒行都在这一块里
  wkSwipeRows(listBox, ".wk-row[data-wkt]", async (row) => {
    const id = Number(row.dataset.wkt);
    const t = (tasks || []).find((x) => Number(x.id) === id);
    try {
      await api(`work/tasks/${id}`, { method: "DELETE", idempotent: true }, 20000);
      toast((t && (t.days || []).length) ? "已删除整组重复日程" : "已删除");
      await loadWork(true);
    } catch (e) { toast(e.message || "删除失败"); throw e; }
  });

  chipBox.querySelectorAll("[data-wktype]").forEach((b) => {
    let press = null;
    const start = () => {
      if (!b.dataset.wktlong) return;
      press = setTimeout(() => {
        press = null;
        state.wkPressFired = true;
        openWorkTypeEditor(Number(b.dataset.wktlong));
      }, 520);
    };
    const stop = () => { if (press) { clearTimeout(press); press = null; } };
    b.addEventListener("touchstart", start, { passive: true });
    b.addEventListener("mousedown", start);
    ["touchend", "touchmove", "touchcancel", "mouseup", "mouseleave"].forEach((ev) => b.addEventListener(ev, stop));
    b.onclick = () => {
      if (press === null && b.dataset.wktlong !== undefined && state.wkPressFired) { state.wkPressFired = false; return; }
      state.wkType = b.dataset.wktype || "";
      renderWork();
    };
  });
  const newType = chipBox.querySelector("[data-wknewtype]");
  if (newType) newType.onclick = () => openWorkTypeManager();

  listBox.querySelectorAll("[data-wkck]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.wkck;
      const t = (state.work.tasks || []).find((x) => String(x.id) === id);
      if (!t) return;
      toggleWorkTask(t);
    };
  });
  listBox.querySelectorAll("[data-wkt]").forEach((r) => {
    r.onclick = () => {
      const t = (state.work.tasks || []).find((x) => String(x.id) === r.dataset.wkt);
      if (t) openWorkTaskEditor(t);
    };
  });
}

async function toggleWorkTask(t) {
  const done = t.done ? 0 : 1;
  t.done = done;
  renderWork();
  // 勾完立刻刷新锁屏卡：卡上钉的要是这一条，就换成下一条或直接撤卡
  if (typeof dndLockSync === "function") dndLockSync();
  try {
    await api(`work/tasks/${t.id}`, { method: "PATCH", body: { done } }, 15000);
  } catch (e) {
    t.done = done ? 0 : 1;
    renderWork();
    toast("保存失败");
    return;
  }
  loadWork(true).catch(() => {});
}

/* 统一时间控件：原生 time input，42 高，等宽数字，整块可点（与添加班次同一版） */
function wkTimeField(id, value, cls) {
  const v = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value).slice(0, 5) : "09:00";
  return `<input class="wk-tf${cls ? " " + cls : ""}" type="time"${id ? ` id="${id}"` : ""} value="${v}" step="60">`;
}

function wkNextSlot() {
  // 下一个整点按北京时间算，别用手机本地时区
  const one = new Date(Date.now() + 60 * 60 * 1000);
  const bj = new Date(one.getTime() + (one.getTimezoneOffset() + 480) * 60000);
  return { day: `${bj.getFullYear()}-${wkPad(bj.getMonth() + 1)}-${wkPad(bj.getDate())}`, time: `${wkPad(bj.getHours())}:00` };
}

function openWorkTaskEditor(t) {
  const types = (state.work && state.work.types) || [];
  if (!types.length) { toast("先建一个工作类型"); openWorkTypeEditor(null); return; }
  const slot = wkNextSlot();
  const dftDay = (state.wkDay || "").slice(0, 10) || slot.day;
  const dftTime = dftDay === slot.day ? slot.time : "09:00";
  const cur = t || { type_id: state.wkType || types[0].id, title: "", note: "", due_at: `${dftDay} ${dftTime}` };
  const day = String(cur.due_at || "").slice(0, 10) || slot.day;
  const time = String(cur.due_at || "").slice(11, 16) || slot.time;
  const hh0 = time.slice(0, 2), mm0 = time.slice(3, 5);
  const opts = (n, curV) => Array.from({ length: n }, (_, i) => wkPad(i))
    .map((v) => `<option value="${v}"${v === curV ? " selected" : ""}>${v}</option>`).join("");
  openSheet(t ? "编辑日程" : "新建日程", `
    <div class="wk-form">
    <div class="field"><label>工作类型</label>
      <div class="chips chips-row wk-pick" id="wk-pick">${types.map((x) => `<button type="button" class="chip${String(cur.type_id) === String(x.id) ? " on" : ""}" data-pick="${x.id}">${esc(x.name)}</button>`).join("")}
        <button type="button" class="chip wk-new" data-picknew>＋ 新类型</button></div></div>
    <div class="field"><label for="wk-e-title">内容</label><input id="wk-e-title" maxlength="120" placeholder="例如：写周报 / 需求评审" value="${esc(t ? cur.title : "")}"></div>
    <div class="wk-when">
      <div class="field"><label>日期</label>${datePickHtml("wk-e-day", day, { full: true, label: "日期", weekday: true })}</div>
      <div class="field"><label>时间</label>${wkTimeField("wk-e-time", time)}</div>
    </div>
    <div class="field"><label>重复<i class="wk-opt">可选 · 按周几重复，省得一天天加</i></label>
      <div class="chips chips-row wk-pick" id="wk-e-rep">
        <button type="button" class="chip" data-rep="every">每天</button>
        <button type="button" class="chip" data-rep="work">工作日</button>
        <button type="button" class="chip" data-rep="off">休息日</button>
        <button type="button" class="chip" data-rep="custom">自定义</button>
      </div>
      <div class="chips chips-row wk-pick" id="wk-e-week" style="display:none"></div>
    </div>
    <div class="field"><label for="wk-e-note">备注<i class="wk-opt">可选</i></label><input id="wk-e-note" maxlength="200" placeholder="地点、准备事项…" value="${esc(t ? cur.note || "" : "")}"></div>
    <div class="wk-tip">到点会响铃并震动</div>
    <div class="sheet-actions"><button class="btn primary" id="wk-e-save">保存</button>${t ? '<button class="btn danger" id="wk-e-del">删除</button>' : ""}</div>
    </div>`);
  let typeId = cur.type_id;
  $$("#wk-pick [data-pick]").forEach((b) => {
    b.onclick = () => {
      typeId = Number(b.dataset.pick);
      $$("#wk-pick [data-pick]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });
  const pickNew = $("#wk-pick [data-picknew]");
  if (pickNew) pickNew.onclick = () => { closeSheet(); openWorkTypeEditor(null); };

  // 重复：空数组 = 不重复；[1,2,3,4,5] = 工作日；[6,7] = 休息日；其余 = 自定义
  // 重复日程的子条目 days 是空的，规则在 head 指向的规则行上——从那里读，否则会显示成「每天」，
  // 一保存就把整组重复关掉（用户看到「改了工作日却还是每天」就是这个）
  let days = ((t && wkRuleDays(t)) || []).map(Number).filter((x) => x >= 1 && x <= 7);
  // 「自定义」要单独记，否则选了自定义但周几恰好等于「工作日」时又被打回工作日
  let repMode = !days.length ? "every" : (days.length === 5 && days.join("") === "12345") ? "work"
    : (days.length === 2 && days.join("") === "67") ? "off" : "custom";
  const paintRep = () => {
    const preset = repMode;
    $$("#wk-e-rep [data-rep]").forEach((b) => b.classList.toggle("on", b.dataset.rep === preset));
    const wk = $("#wk-e-week");
    if (preset !== "custom") { wk.style.display = "none"; wk.innerHTML = ""; return; }
    wk.style.display = "";
    wk.innerHTML = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      `<button type="button" class="chip${days.includes(n) ? " on" : ""}" data-week="${n}">${wkWeekName(n)}</button>`).join("");
    $$("#wk-e-week [data-week]").forEach((b) => {
      b.onclick = () => {
        const n = Number(b.dataset.week);
        repMode = "custom";
        days = days.includes(n) ? days.filter((x) => x !== n) : days.concat([n]).sort((a, b) => a - b);
        if (!days.length) days = [1];
        paintRep();
      };
    });
    const delBtn = $("#wk-e-del");
    if (delBtn && !delBtn.dataset.arm) delBtn.textContent = days.length ? "删除整组" : "删除";
  };
  $$("#wk-e-rep [data-rep]").forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.rep;
      repMode = v;
      days = v === "every" ? [] : v === "work" ? [1, 2, 3, 4, 5] : v === "off" ? [6, 7] : (days.length ? days : [1, 2, 3, 4, 5]);
      paintRep();
    };
  });
  paintRep();
  const save = $("#wk-e-save");
  save.onclick = async () => {
    const title = ($("#wk-e-title").value || "").trim();
    const d = $("#wk-e-day").value;
    const hm = String($("#wk-e-time").value || "").slice(0, 5) || "09:00";
    if (!title) return toast("内容不能为空");
    if (!d) return toast("选个日期");
    const due_at = `${d} ${hm}`;
    save.disabled = true; save.textContent = "保存中…";
    try {
      if (t) {
        await api(`work/tasks/${t.id}`, { method: "PATCH", idempotent: true, body: { title, note: $("#wk-e-note").value.trim(), due_at, type_id: typeId, notified_at: null, days } }, 20000);
      } else {
        await api("work/tasks", { method: "POST", idempotent: true, body: { type_id: typeId, title, note: $("#wk-e-note").value.trim(), due_at, days } }, 20000);
      }
      closeSheet();
      toast(t ? "日程已更新" : "日程已添加");
      loadWork(true).catch(() => {});
    } catch (e) {
      save.disabled = false; save.textContent = "保存";
      toast(e.message || "保存失败");
    }
  };
  const del = $("#wk-e-del");
  if (del) del.onclick = async () => {
    // 壳里 confirm 会被吞掉（之前点删除没反应就是这个），改成按钮二次确认，不依赖系统弹框
    if (del.dataset.arm !== "1") {
      del.dataset.arm = "1";
      del.textContent = "确认删除？";
      setTimeout(() => { if (del.dataset.arm === "1") { del.dataset.arm = ""; del.textContent = "删除"; } }, 3000);
      return;
    }
    del.disabled = true; del.textContent = "删除中…";
    try {
      await api(`work/tasks/${t.id}`, { method: "DELETE" });
      closeSheet(); toast("已删除");
      loadWork(true).catch(() => {});
    } catch (e) {
      del.disabled = false; del.dataset.arm = ""; del.textContent = "删除";
      toast(e.message || "删除失败");
    }
  };
}

/* 类型管理：把「＋ 类型」从"只能加"变成"能改能删"的入口 */
