function stopSheetQuote() {
  if (sheetQuoteTimer) clearInterval(sheetQuoteTimer);
  sheetQuoteTimer = null;
  if (sheetEventSource) {
    try { sheetEventSource.close(); } catch (e) { /* ignore */ }
  }
  sheetEventSource = null;
  sheetQuoteCode = "";
  sheetSseAt = 0;
}
function paintSheetQuote(q) {
  if (!q || q.price === undefined || q.price === null) return;
  const p = $("#sq-price");
  // 场外基金净值是 4 位小数，别的品种按 2 位显示
  if (p) p.textContent = q.source === "fund_nav" ? Number(q.price).toFixed(4) : px(q.price);
  const pc = $("#sq-pct");
  if (pc) { pc.textContent = pctText(q.pct); pc.className = cls(q.pct); }
  // 拖到历史后 K 线停止刷新，说明行的最新价和当日涨跌幅仍跟着实时行情走
  const kLast = $("#k-last");
  const kPrice = Number(q.price);
  if (kLast && Number.isFinite(kPrice)) kLast.textContent = q.source === "fund_nav" ? kPrice.toFixed(4) : kPrice.toFixed(2);
  if (q.pct !== null && q.pct !== undefined) setKlinePct(q.pct);
  paintQuoteDetail(q);
  const note = $("#sq-note");
  if (note) {
    note.textContent = [q.stale ? "延迟" : "", q.source === "sina" ? "备用源" : ""]
      .filter(Boolean).join(" · ");
  }
}
async function sheetQuoteTick(code, force) {
  if (sheetQuoteCode !== code || document.hidden) return false;
  // SSE 刚推过就跳过轮询；但弹层刚打开的第一次必须自己拉，免得只剩「—」
  if (!force && Date.now() - sheetSseAt < 12000) return false;
  const q = await api(`quote/${code}`).catch(() => null);
  if (sheetQuoteCode !== code || !q) return false;
  paintSheetQuote(q);
  return true;
}
function startSheetQuote(code) {
  stopSheetQuote();
  sheetQuoteCode = code;
  // 上游偶发抖动（腾讯/新浪/东财同时抽一下）时补两次，避免详情页一直停在「—」
  let tries = 0;
  const tickOnce = async () => {
    if (sheetQuoteCode !== code) return;
    const ok = await sheetQuoteTick(code, !tries);
    if (!ok && ++tries < 3) setTimeout(tickOnce, 1200);
  };
  tickOnce();
  if (isFundCode(code)) return;
  // 报价只走 SSE（服务端本来就 3 秒推一条）；不支持 SSE 或流断了才退回轮询。
  // 以前两路同时跑，同一标的每 3 秒白拿两份数据。
  const pollFallback = () => {
    if (sheetQuoteCode !== code || sheetQuoteTimer) return;
    if (marketOpen()) sheetQuoteTimer = setInterval(() => sheetQuoteTick(code), 3000);
  };
  if (typeof EventSource === "undefined") { pollFallback(); return; }
  try {
    const es = new EventSource(`api/v1/stream/quote/${code}`);
    sheetEventSource = es;
    es.onmessage = (e) => {
      if (sheetQuoteCode !== code) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg && msg.quote) {
          sheetSseAt = Date.now();
          paintSheetQuote(msg.quote);
        }
      } catch (err) { /* ignore */ }
    };
    es.onerror = () => {
      try { es.close(); } catch (err) { /* ignore */ }
      if (sheetEventSource === es) sheetEventSource = null;
      sheetSseAt = 0;
      pollFallback();
      sheetQuoteTick(code);
    };
  } catch (err) {
    sheetEventSource = null;
  }
}

/* 弹层关闭前的一次性钩子（批注编辑用：关掉前把没来得及自动保存的内容落库） */
let sheetCloseHook = null;
let sheetBack = null;   // 从 ETF 持仓点进个股后，关掉个股弹层回到 ETF 详情
/* 弹层层栈：同一时间只让最上面那一层可见，下面的整层隐藏（不然两层弹窗叠着看，
   就是截图里「班次与轮转」还敞在「添加班次」后面那种脏画面） */
const _layerStack = [];
function layerOn(el) {
  if (!el || _layerStack.indexOf(el) >= 0) return;
  _layerStack.push(el);
  layerSync();
}
function layerOff(el) {
  const i = _layerStack.indexOf(el);
  if (i >= 0) _layerStack.splice(i, 1);
  layerSync();
}
function layerSync() {
  _layerStack.forEach((el, i) => el.classList.toggle("layer-under", i < _layerStack.length - 1));
}

/* 有弹层在开的时候，到点提醒卡（也是盖满屏的一层）先让位：
   开弹层时把已有的提醒卡收起来，弹层全关掉后再放出来，不在编辑到一半时糊一屏 */
function anySheetOpen() {
  const a = $("#sheet"), b = $("#sheet2");
  return !!((a && !a.classList.contains("hidden")) || (b && !b.classList.contains("hidden")));
}
function wkAlarmHold() {
  const box = $("#wk-alarm");
  if (!box || box.classList.contains("hidden")) return;
  box.classList.add("hidden");
  document.body.classList.remove("wk-ringing");
  try { wkStopRing(null); } catch (e) { /* 铃声停不掉也不挡收卡 */ }
  state.wkAlarmHeld = true;
}
function wkAlarmFlush() {
  if (anySheetOpen()) return;
  if (state.wkAlarmHeld && state.wkAlarm) { state.wkAlarmHeld = false; wkAlarmShow(state.wkAlarm, true); return; }
  state.wkAlarmHeld = false;
  if (state.wkAlarmPending) { const a = state.wkAlarmPending; state.wkAlarmPending = null; wkAlarmShow(a); }
}

// 弹层头部高度会随标题行数变（长名字折两行）：把实际高度写给分栏条，
// 分栏才能紧贴头部下沿吸住，既不留大空当也不压到标题
function syncSheetHeadH(sh) {
  const body = sh && sh.querySelector(".sheet-body");
  const head = sh && sh.querySelector(".sheet-head");
  if (!body || !head) return;
  const h = Math.round(head.getBoundingClientRect().height);
  if (h > 0) body.style.setProperty("--sh-h", h + "px");
}
function openSheet(title, html) {
  // 待机层在最上面：弹层/提醒要出现时先把待机收掉，否则会开在看不见的下面
  if (typeof sbIsOn === "function" && sbIsOn()) sbClose(true);
  stopSheetQuote();
  sheetCloseHook = null;
  const sh = $("#sheet");
  // 从全局搜索或新闻面板里打开（编辑记录/个股详情）时，弹层要压在上层全屏面板之上，
  // 否则看着就是「点了没反应」（新闻面板点搜索→点个股时，#gsearch 已先关掉，只剩 #digest）
  const gsLayer = $("#gsearch");
  const dgLayer = $("#digest");
  // 数据总览（#wk-ov，z-index 60）是全屏页：在它上面弹层也得抬到 90，否则点不到
  const ovLayer = $("#wk-ov");
  sh.classList.toggle("above-gs",
    !!(gsLayer && !gsLayer.classList.contains("hidden")) ||
    !!(dgLayer && !dgLayer.classList.contains("hidden")) ||
    !!(ovLayer && !ovLayer.classList.contains("hidden")));
  $("#sheet-title").textContent = title;
  $("#sheet-content").innerHTML = html;
  // AI 对话那种「浮在页面上的小面板」会把 sheet-body 的滚动关掉；
  // 从它点开别的弹层（比如历史）时必须清掉，否则新列表滑不动（openWorkAi 自己会再加回来）
  sh.classList.remove("ai-float-sheet");
  sh.classList.remove("hidden");
  layerOn(sh);
  wkAlarmHold();
  lockPageScroll(true, "sheet");
  $$("#sheet [data-close]").forEach((b) => (b.onclick = closeSheet));
  requestAnimationFrame(() => syncSheetHeadH(sh));
  setTimeout(() => { syncSheetHeadH(sh); try { window.wkScrollBars && window.wkScrollBars(); } catch (e) {} }, 30);
}
function closeSheet() {
  const hook = sheetCloseHook;
  const back = sheetBack;
  sheetCloseHook = null;
  sheetBack = null;
  if (hook) { try { hook(); } catch (e) { /* 自动保存失败不挡关闭 */ } }
  closeSubSheet();
  $("#sheet").classList.add("hidden");
  $("#sheet").classList.remove("ai-float-sheet");
  layerOff($("#sheet"));
  lockPageScroll(false, "sheet");
  wkAlarmFlush();
  stopSheetQuote();
  stopKlineTimer();
  // 弹层打开期间主列表暂停轮询；关掉后立即补一次，不用再等下一拍
  if (isQuoteView()) {
    refreshVisible(true).catch(() => {}).finally(() => schedulePoll());
  } else {
    schedulePoll();
  }
  // 个股是从 ETF 持仓点进来的：关掉后回到上一级 ETF 详情
  if (back) { try { back(); } catch (e) { /* 回退失败就留在原页 */ } }
}

/* 二级弹层：在已打开的弹层（个股详情等）之上再开一层，收起时只回上一层。
   个股详情里的「消息预览」原来复用 #sheet，会把个股页内容直接换掉、一关就退回列表。 */
/* 通用二次确认卡（居中弹层，返回 Promise<boolean>） */
function wkConfirm(title, body, okText, cancelText) {
  return new Promise((res) => {
    const el = document.createElement("div");
    el.className = "wk-alarm wk-cf";
    el.innerHTML = `<div class="wka-card">
        <div class="wka-t">${esc(title)}</div>
        <div class="wka-m">${esc(body)}</div>
        <div class="wka-acts">
          <button type="button" class="btn ghost" data-no>${esc(cancelText || "取消")}</button>
          <button type="button" class="btn primary" data-yes>${esc(okText || "确定")}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    layerOn(el);
    const done = (v) => { layerOff(el); el.remove(); res(v); };
    el.querySelector("[data-no]").onclick = () => done(false);
    el.querySelector("[data-yes]").onclick = () => done(true);
  });
}

function openSubSheet(title, html) {
  const sh = $("#sheet2");
  if (!sh) return openSheet(title, html);
  const t = $("#sheet2-title");
  if (t) t.textContent = title;
  const c = $("#sheet2-content");
  if (c) c.innerHTML = html;
  sh.classList.remove("hidden");
  layerOn(sh);
  wkAlarmHold();
  lockPageScroll(true, "sheet2");
  // 弹层内的报价/K线轮询属于下层，不动它
  $$("#sheet2 [data-close]").forEach((b) => (b.onclick = closeSubSheet));
  requestAnimationFrame(() => syncSheetHeadH(sh));
  setTimeout(() => syncSheetHeadH(sh), 30);
}
function closeSubSheet() {
  const sh = $("#sheet2");
  if (!sh || sh.classList.contains("hidden")) return;
  sh.classList.add("hidden");
  layerOff(sh);
  lockPageScroll(false, "sheet2");
  wkAlarmFlush();
  const c = $("#sheet2-content");
  if (c) c.innerHTML = "";
}
function customTagsInput(s) {
  return `<input id="f-custom-tags" placeholder="逗号分隔，如：机器人,防守" value="${esc(customTagsOf(s).join(","))}">`;
}

/* 列表行点「外网」：按代码重抓外网标签，成功后原地更新这一行 */
async function refreshRowTags(code, btn) {
  const s = state.board.stocks.find((x) => x.code === code);
  if (!s || !btn || btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "刷新中";
  try {
    const r = await api(`stocks/${code}/autotag`, { method: "POST", idempotent: true });
    const got = (r.tags || []).slice(0, 4);
    // 请求期间可能刚轮询过 board，重新取当前对象再写
    const cur = state.board.stocks.find((x) => x.code === code) || s;
    cur.tags = got;
    renderBucket(cur.bucket);
    toast(got.length ? "已刷新外网标签" : "未获取到外网标签");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = old;
    toast(e.message);
  }
}

/* 列表行点备注：不做预览，直接编辑；布局与自定义标签一致 */
function openStockNote(code) {
  const s = state.board.stocks.find((x) => x.code === code);
  if (!s) return;
  openSheet(
    `${esc(s.name)} · ${s.code}`,
    `<div class="field"><label>备注（留空可清除）</label><textarea id="note-input" rows="6" placeholder="买入理由、盯盘要点、止损位…">${esc(s.note || "")}</textarea></div>
     <div class="sheet-actions">
       <button class="btn primary" id="note-save">保存</button>
       <button class="btn ghost" data-close>取消</button>
     </div>`
  );
  const ta = $("#note-input");
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  $("#note-save").onclick = async () => {
    const b = $("#note-save");
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = "保存中…";
    try {
      const note = ta.value.trim();
      await api(`stocks/${s.code}`, { method: "PATCH", body: { note } });
      s.note = note;
      closeSheet();
      toast(note ? "备注已保存" : "备注已清除");
      renderBucket(s.bucket);
    } catch (e) {
      toast(e.message);
      b.disabled = false;
      b.textContent = "保存";
    }
  };
}

/* 点「关注」：自动提取的内容可看可改，保存后以手动为准 */
/* 个股卡片「全部 N 条分析」：最新在上，历史往下，原文完整显示 */
function openStockAnalysis(code) {
  const s = state.board.stocks.find((x) => x.code === code);
  if (!s) return;
  const list = s.analysis || [];
  openSheet(`${esc(s.name)} · 个股分析`,
    list.length ? list.map((a, i) => `<div class="ana-sheet-item${i ? " old" : ""}">
        <div class="ana-head"><b>${esc(a.label || "")}</b><span class="tiny muted">${i ? "历史" : "最新"}</span></div>
        <div class="ana-body">${fmtReport(a.content)}</div>
      </div>`).join("")
      : `<div class="empty">这只股还没有报告分析（只分析持仓 + 优先级 A/B 的关注股）</div>`);
}

function openStockFocus(code) {
  const s = state.board.stocks.find((x) => x.code === code);
  if (!s) return;
  const cur = (s.focus || "").trim();
  const manual = !!s.focus_manual;
  const auto = (s.focus_auto || (manual ? "" : s.focus) || "").trim();
  const list = s.analysis || [];
  const hint = manual
    ? "当前是手动内容，保存后不会再自动更新；点「恢复自动」回到报告提取。"
    : auto
      ? "当前显示的是报告里提炼出的关注点；要改就写在上面，保存后以手动为准。"
      : "报告里还没有这只股的关注内容，可以直接写。";
  const hist = list.length
    ? `<div class="focus-hist"><div class="focus-hist-head">报告分析 · ${list.length} 条（最新在上）</div>
        ${list.map((a, i) => `<div class="ana-sheet-item${i ? " old" : ""}">
          <div class="ana-head"><b>${esc(a.label || "")}</b><span class="tiny muted">${i ? "历史" : "最新"}</span></div>
          <div class="ana-body">${fmtReport(a.content)}</div>
        </div>`).join("")}</div>`
    : (s.analysis === undefined ? "" : `<div class="tiny muted" style="margin:6px 2px 10px">这只股还没有报告分析（只分析持仓 + 优先级 A/B 的关注股）</div>`);
  openSheet(`${esc(s.name)} · 关注`,
    `<div class="field"><label>关注（点保存后以手动为准）</label>
       <textarea id="focus-input" rows="4" maxlength="500" placeholder="例如：若冲高回落跌破 10.16 元，说明是分歧转一致失败">${esc(cur)}</textarea></div>
     <div class="tiny muted" style="margin:-4px 2px 8px;line-height:1.5">${hint}</div>
     ${hist}
     <div class="sheet-actions">
       <button class="btn primary" id="focus-save">保存</button>
       ${manual ? `<button class="btn ghost" id="focus-reset">恢复自动</button>` : ""}
       <button class="btn ghost" data-close>关闭</button>
     </div>`);
  const save = async (val, okMsg) => {
    const b = $("#focus-save");
    if (b) { b.disabled = true; b.textContent = "保存中…"; }
    try {
      await api(`stocks/${code}`, { method: "PATCH", body: { focus: val } });
      s.focus = val || auto;
      s.focus_manual = !!val;
      closeSheet();
      renderBucket(s.bucket);
      toast(okMsg);
      loadBoard(true).catch(() => {});
    } catch (e) {
      toast(e.message);
      if (b) { b.disabled = false; b.textContent = "保存"; }
    }
  };
  $("#focus-save").onclick = () => {
    const val = ($("#focus-input").value || "").trim();
    save(val, val ? "关注已保存" : "已恢复自动提取");
  };
  const reset = $("#focus-reset");
  if (reset) reset.onclick = () => save("", "已恢复自动提取");
}

/* 点 💡：预览这只股显式关联的全部记录，并可直接补一条（想法 / 笔记 / 新闻） */
function ideaPreviewHtml(items, code, name) {
  if (!items.length) return `<div class="empty">还没有关联记录，在上面写一条吧。</div>`;
  const tagHtml = (n) => (n.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join(" ");
  return `<div class="tiny muted" style="margin-bottom:8px">${items.length} 条 · 只有显式关联才算，正文提到名字的不算</div>` +
    items.map((n) => `<div class="idea-prev">
      <div class="meta"><span class="badge ${n.kind}">${KIND_LABEL[n.kind] || "想法"}</span>
        <span>${esc((n.created_at || "").slice(5, 16))}</span>${n.pinned ? '<span class="pin-glyph">置顶</span>' : ""}${tagHtml(n)}</div>
      <div class="idea-body">${esc(n.content)}</div>
      <div class="idea-foot"><button type="button" class="chip stock-chip" data-open-stock="${esc(code)}">🔗 ${esc(name)} ${mktBadge(code)}</button>
</div>
    </div>`).join("");
}

let ideaSheetSeq = 0;
async function openStockIdeas(code) {
  const seq = ++ideaSheetSeq;
  const current = () => seq === ideaSheetSeq;
  const s = state.board.stocks.find((x) => x.code === code);
  const name = s ? s.name : (stockNameOf(code) || code);
  openSheet(`${name} · 关联记录`,
    `<div class="idea-compose">
       <textarea id="idea-text" rows="2" placeholder="记下关于 ${esc(name)} 的想法、笔记或新闻…"></textarea>
       <div class="idea-compose-foot">
         <div id="idea-kinds" class="idea-kinds">
           <button type="button" class="chip on" data-kind="idea">想法</button>
           <button type="button" class="chip" data-kind="note">记录</button>
           <button type="button" class="chip" data-kind="news">新闻</button>
         </div>
         <button type="button" class="btn primary small" id="idea-submit">记录</button>
       </div>
     </div>
     <div id="idea-preview"><div class="empty">加载中…</div></div>
     <div class="sheet-actions"><button class="btn ghost" id="idea-go-notes">去记录页</button><button class="btn ghost" data-close>关闭</button></div>`);
  $("#idea-go-notes").onclick = () => {
    closeSheet();
    // 从个股详情跳去记录页：记住当前页，记录页再点 ✎ 关闭时回来
    if (state.view !== "note") state.pageBack.note = state.view;
    setView("note");
  };

  const ta = $("#idea-text");
  const submit = $("#idea-submit");
  const kindBox = $("#idea-kinds");
  let kind = "idea";
  $$(".chip", kindBox).forEach((c) => {
    c.onclick = () => {
      kind = c.dataset.kind || "idea";
      $$(".chip", kindBox).forEach((x) => x.classList.toggle("on", x === c));
    };
  });
  const grow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight || 44, 140)}px`;
  };
  ta.addEventListener("input", grow);
  grow();

  let items = [];
  const paint = () => {
    if (!current()) return;
    const box = $("#idea-preview");
    if (!box || !document.contains(box)) return;
    box.innerHTML = ideaPreviewHtml(items, code, name);
    bindOpenStock(box);
  };

  const save = async () => {
    if (submit.disabled) return;
    const content = ta.value.trim();
    if (!content) { toast("先写点什么"); ta.focus(); return; }
    submit.disabled = true;
    submit.textContent = "记录中…";
    try {
      const created = await api("notes", {
        method: "POST",
        body: { content, kind, tags: [], stock_code: code },
      });
      ta.value = "";
      grow();
      // 先本地插到顶部，不等隧道再往返一次；后续拉取按 id 去重
      items = [created, ...items.filter((n) => n.id !== created.id)];
      paint();
      const cur = state.board.stocks.find((x) => x.code === code);
      if (cur) {
        cur.note_count = Number(cur.note_count || 0) + 1;
        renderBucket(cur.bucket);
      }
      loadBoard(true).catch(() => {});
      toast("已记录");
    } catch (e) {
      toast(e.message);
    } finally {
      submit.disabled = false;
      submit.textContent = "记录";
    }
  };
  submit.onclick = save;
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); }
  });

  // 已有记录先拉；保存期间拉回来的旧数据不能把刚写的这条冲掉，按 id 合并
  try {
    const d = await api(`notes?code=${encodeURIComponent(code)}`);
    const fresh = (d.items || []).filter((n) => String(n.stock_code) === String(code));
    const ids = new Set(fresh.map((n) => n.id));
    items = [...items.filter((n) => !ids.has(n.id)), ...fresh];
    paint();
  } catch (e) {
    if (!current()) return;
    const box = $("#idea-preview");
    if (box && document.contains(box)) box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

function bindOpenStock(box) {
  $$("[data-open-stock]", box).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openAnyStock(b.dataset.openStock);
    };
  });
}

function openAnyStock(code) {
  if (trackedOf(code)) openStock(code);
  else openHeatStock(code, stockNameOf(code) || code);
}

/* 长按个股：只改自定义标签 */
function openStockTags(code) {
  const s = state.board.stocks.find((x) => x.code === code);
  if (!s) return;
  openSheet(
    `${esc(s.name)} · ${s.code}`,
    `<div class="field"><label>自定义标签（可多个，逗号分隔）</label>${customTagsInput(s)}</div>
     <div class="sheet-actions">
       <button class="btn primary" id="ct-save">保存</button>
       <button class="btn ghost" data-close>取消</button>
     </div>`
  );
  const input = $("#f-custom-tags");
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  $("#ct-save").onclick = async () => {
    const b = $("#ct-save");
    if (b.disabled) return;
    const tags = input.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    b.disabled = true;
    b.textContent = "保存中…";
    try {
      await api(`stocks/${code}`, { method: "PATCH", body: { custom_tags: tags } });
      s.custom_tags = tags;
      closeSheet();
      toast("标签已保存");
      renderBucket(s.bucket);
    } catch (e) {
      toast(e.message);
      b.disabled = false;
      b.textContent = "保存";
    }
  };
}


/* 个股「公司 · 消息」：只放近 2 小时的实时新闻（后台每小时刷新一次），
   不再回查笔记 / 日报 / 更早的历史记录 */
function wnum(v, d = 2) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n.toFixed(d) : null;
}
async function loadWindFundamentals(code) {
  /* 个股详情只显示 Wind「财务」：营收/净利/ROE 多期走势。
     数据来自预取缓存，打开弹层不发新请求；最新一期常显，其余点按钮展开。 */
  const box = $("#sq-wind");
  if (!box) return;
  box.innerHTML = "";
  try {
    const r = await fetch(`${API}/wind/fundamentals?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    const d = await r.json();
    if (!d || !d.ok) return;
    const seriesRaw = (d.trend && d.trend.series) || [];
    // 缓存里可能还是旧顺序（旧 → 新）：按报告期倒序，最新一期必须在最前
    const wKey = (p) => {
      const m = String(p || "").match(/^Q([1-4])\s*FY(\d{4})$/) || String(p || "").match(/^(\d{4})Q([1-4])$/);
      if (!m) return 0;
      return String(p).startsWith("Q") ? Number(m[2]) * 10 + Number(m[1]) : Number(m[1]) * 10 + Number(m[2]);
    };
    const series = seriesRaw.slice().sort((a, b) => wKey(b.period) - wKey(a.period));
    if (!series.length) return;
    const wMoney = (v) => {
      if (!v) return "";
      const s2 = String(v).replace(/元$/, "");
      const m = s2.match(/^(-?[\d.]+)(.*)$/);
      if (!m) return s2;
      const num = Number(m[1]);
      return Number.isFinite(num) ? `${num.toFixed(1)}${m[2]}` : s2;
    };
    const wPeriod = (v) => {
      const m = String(v || "").match(/^Q(\d)\s*FY(\d{4})$/);
      return m ? `${m[2]}Q${m[1]}` : String(v || "");
    };
    const wPct1 = (v) => {
      const n = wnum(v, 1);
      return n === null ? "" : `(${Number(n) >= 0 ? "+" : ""}${n}%)`;
    };
    const one = (it) => {
      const bits = [wPeriod(it.period)];
      if (it.rev) bits.push(`营收 ${wMoney(it.rev)}${wPct1(it.rev_yoy)}`);
      if (it.np) bits.push(`净利 ${wMoney(it.np)}${wPct1(it.np_yoy)}`);
      const roe = wnum(it.roe, 1);
      if (roe !== null) bits.push(`ROE ${roe}%`);
      return esc(bits.filter(Boolean).join("　"));
    };
    const restItems = series.slice(1, 4).map(one);
    const n = Math.min(series.length, 4);
    const restHtml = restItems.map((t) => `<div>${t}</div>`).join("");
    box.innerHTML = `<div class="wf-row"><b>财务</b>${one(series[0])}${
      restHtml ? ` <button type="button" class="wf-more" id="wf-trend-btn">近${n}期</button>` : ""
    }${restHtml ? `<div class="wf-sub hidden" id="wf-trend-more">${restHtml}</div>` : ""}</div>`;
    const btn = $("#wf-trend-btn", box);
    if (btn) btn.onclick = () => {
      const body = $("#wf-trend-more", box);
      if (!body) return;
      const on = body.classList.toggle("hidden");
      btn.textContent = on ? `近${n}期` : "收起";
    };
  } catch (e) {
    box.innerHTML = "";
  }
}

async function loadStockFlags(code, name = "") {
  const box = $("#sq-flags");
  if (!box) return;
  const etf = isEtfCode(code);
  const noun = etf ? "ETF" : "股";
  const hasUnread = !!((state.board && state.board.flags) || {})[code];
  box.innerHTML = `<div class="flag-head">最新新闻</div><div class="tiny muted" style="padding:6px 0">加载中…</div>`;
  let items = [];
  try {
    const nm = name || (state.board.stocks.find((x) => x.code === code) || {}).name || "";
    const r = etf
      ? await api(`etf/news/${code}?hours=72${name ? `&name=${encodeURIComponent(name)}` : ""}`)
      : isGlobalCode(code)
        ? await api(`stocks/${code}/live-news?hours=24&name=${encodeURIComponent(nm)}`)
        : await api(`stocks/${code}/live-news?hours=24`);
    items = r.items || [];
  } catch (e) { /* 拉不到就不显示 */ }
  if (!document.contains(box)) return;
  let expanded = false;
  const itemHtml = (it, i) => `<div class="flag-item">
      <div class="flag-meta">
        <span class="flag-time">${esc((it.published_at || "").slice(5, 16))}</span>
        <span class="flag-kind">${esc(it.match || "实时")}</span>
        <span class="flag-src">${esc(it.source || "实时新闻")}</span>
      </div>
      <button type="button" class="flag-open" data-live-idx="${i}" title="点击预览全文">${esc(it.title)}</button>
    </div>`;
  const paint = () => {
    if (!items.length) {
      box.innerHTML = `<div class="flag-head">最新新闻</div>
        <div class="empty">${etf ? "近 3 天没有相关新闻" : `近 24 小时没有这只${noun}的相关新闻`}</div>`;
      return;
    }
    // 默认只露 3 条，多的点展开看，免得弹层被消息撑满
    const shown = expanded ? items : items.slice(0, 3);
    box.innerHTML = `<div class="flag-head">最新新闻 ${items.length} 条</div>` +
      shown.map(itemHtml).join("") +
      (items.length > 3
        ? `<button type="button" class="flag-more" id="flag-more">${expanded ? "收起" : `展开全部 ${items.length} 条`}</button>`
        : "");
    const more = box.querySelector("#flag-more");
    if (more) more.onclick = () => { expanded = !expanded; paint(); };
    box.querySelectorAll("[data-live-idx]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        openLiveNewsPreview(items[Number(b.dataset.liveIdx)]);
      };
    });
  };
  paint();
  if (!hasUnread) return;
  try {
    const r = await api("flags/read", { method: "POST", body: { codes: [code] } });
    if (r && r.summary) state.board.flags = r.summary;
    else if (state.board.flags) delete state.board.flags[code];
    renderBucket("hold");
    renderBucket("watch");
  } catch (e) { /* 失败就下次再标 */ }
}

/* 点实时新闻：站内预览全文（标题本身就是正文），不跳转外站 */
function openLiveNewsPreview(it) {
  if (!it) return;
  const when = String(it.published_at || "").replace(" 00:00", "");
  openSubSheet("消息预览",
    `<div class="flag-preview-meta">${esc(["实时新闻", when].filter(Boolean).join(" · "))}</div>
     <article class="flag-preview-body">${esc(it.title || "")}</article>
     <div class="sheet-actions"><button class="btn primary" data-close>关闭</button></div>`);
}



/* 个股详情分两页：行情 / K线（交易情况），公司 / 消息（公司资料） */
const STOCK_TABS = [["chart", "行情 · K线"], ["company", "最新新闻"]];
const ETF_TABS = [["chart", "行情 · K线"], ["company", "持仓 · 权重"], ["news", "最新新闻"]];
function isEtfCode(code) {
  return /^(?:15|16|51|56|58)\d{4}$/.test(String(code || ""));
}
const FUND_KNOWN = new Set();
function markFund(code) { if (code) FUND_KNOWN.add(String(code)); }
/* 场外基金没有盘中行情：靠行情源标记（source=fund_nav）+ 本次会话已知代码判断 */
/* 非 A 股：美股（纯字母，NVDA / BRK.B）、港股（5 位以内数字，00700 / 700） */
function isGlobalCode(code) {
  const c = String(code || "").trim();
  if (!c) return false;
  if (/^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(c)) return true;
  if (/^\d{1,5}$/.test(c)) return true;
  return false;
}
function isFundCode(code) {
  const c = String(code || "");
  if (FUND_KNOWN.has(c)) return true;
  const s = state.board.stocks.find((x) => x.code === c);
  if (s && (s.source === "fund_nav" || s.market === "fund")) { FUND_KNOWN.add(c); return true; }
  return false;
}
const FUND_TABS = [["chart", "净值 · 走势"], ["company", "档案 · 涨幅"], ["news", "最新新闻"]];
/* 基金专属字段：净值、日期、累计、阶段收益，交易类字段一律不显示 */
// 单位净值已经是标题下方的大字，字段表里不再重复一遍
const FUND_Q_DETAIL = [
  ["nav_date", "净值日期"], ["accnav", "累计净值"], ["pct_d", "日增长率"],
  ["sgzt", "申购状态"], ["endnav", "基金规模"],
];
/* 基金没有分时/日K，改成净值区间走势（都是日净值序列，只是取多少天） */
const FUND_K_PERIODS = [["f1m", "近1月", "day", "22"], ["f3m", "近3月", "day", "66"],
                        ["f1y", "近1年", "day", "250"], ["fall", "全部", "day", "480"]];
const Q_DETAIL = [
  ["open", "今开"], ["high", "最高"], ["low", "最低"],
  ["prev_close", "昨收"], ["volume", "成交量"], ["amount", "成交额"],
  ["turnover_rate", "换手率"], ["vol_ratio", "量比"], ["pe", "市盈率"],
  ["pb", "市净率"], ["float_cap", "流通值"], ["total_cap", "总市值"],
];
/* 港美股：换手率、量比、市净率源里没有，不摆「—」占位；成交量按股、成交额按原币种 */
const GLOBAL_Q_DETAIL = [
  ["open", "今开"], ["high", "最高"], ["low", "最低"],
  ["prev_close", "昨收"], ["volume", "成交量"], ["amount", "成交额"],
  ["pe", "市盈率"], ["float_cap", "流通市值"], ["total_cap", "总市值"],
];
/* ETF 没有 PE/PB，换成「规模」；其余交易字段保留 */
const ETF_Q_DETAIL = [
  ["open", "今开"], ["high", "最高"], ["low", "最低"],
  ["prev_close", "昨收"], ["volume", "成交量"], ["amount", "成交额"],
  ["turnover_rate", "换手率"], ["vol_ratio", "量比"],
  ["float_cap", "规模"], ["total_cap", "总市值"],
];
function stockTabsHtml(mode = "") {
  const tabs = mode === "fund" ? FUND_TABS : (mode === "etf" || mode === true) ? ETF_TABS : STOCK_TABS;
  return `<div class="stock-tabs-wrap">
    <div class="seg stock-tabs" id="stock-tabs">
      ${tabs.map(([k, l], i) =>
        `<button type="button" data-tab="${k}" class="${i ? "" : "on"}">${l}</button>`).join("")}
    </div>
  </div>`;
}
function qDetailHtml(mode = "") {
  const list = mode === "fund" ? FUND_Q_DETAIL
    : (mode === "etf" || mode === true) ? ETF_Q_DETAIL
    : mode === "global" ? GLOBAL_Q_DETAIL : Q_DETAIL;
  return `<div class="q-detail${mode === "fund" ? " q2" : ""}" id="sq-detail">${list.map(([k, l]) =>
    `<div><span class="k">${l}</span><b data-q="${k}">—</b></div>`).join("")}</div>
    <div class="q-note tiny muted" id="sq-note"></div>`;
}
function fmtAmountWan(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return "—";
  return n >= 100 ? `${num(n / 1e4, 2)}亿` : `${num(n, 0)}万`;
}
function fmtHands(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return "—";
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿手`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万手`;
  return `${num(n, 0)}手`;
}
/* 市值：A 股按亿元；港美股带币种符号，上万亿美元/港元换成「万亿」更短 */
function fmtCap(v, cur) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const sign = cur === "USD" ? "$" : cur === "HKD" ? "HK$" : "";
  if (n >= 10000) return `${sign}${(n / 10000).toFixed(2)}万亿`;
  if (n >= 1) return `${sign}${n.toFixed(n >= 100 ? 0 : 1)}亿`;
  return `${sign}${num(n * 1e4, 0)}万`;
}
/* 成交量：A 股是「手」，港美股是「股」 */
function fmtVolText(v, unit) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return "—";
  if (unit === "share") {
    if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿股`;
    if (n >= 1e4) return `${(n / 1e4).toFixed(0)}万股`;
    return `${num(n, 0)}股`;
  }
  return fmtHands(n);
}
/* 成交额：A 股快照按万元，港美股按原币种「元」 */
function fmtMoney(v, unit, cur) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return "—";
  if (unit === "yuan") {
    // 三列格子只有一百多像素，金额用币种符号打头、亿位取整，别让「亿美元」把数字挤成省略号
    const c = cur === "USD" ? "$" : cur === "HKD" ? "HK$" : "";
    if (n >= 1e12) return `${c}${(n / 1e12).toFixed(2)}万亿`;
    if (n >= 1e8) return `${c}${(n / 1e8).toFixed(n >= 1e10 ? 0 : 1)}亿`;
    if (n >= 1e4) return `${c}${(n / 1e4).toFixed(0)}万`;
    return `${c}${num(n, 0)}`;
  }
  return fmtAmountWan(n);
}
function paintQuoteDetail(q) {
  const box = $("#sq-detail");
  if (!box) return;
  const has = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  const set = (k, txt, colorBy) => {
    const el = box.querySelector(`[data-q="${k}"]`);
    if (!el) return;
    el.textContent = txt;
    el.className = colorBy === undefined ? "" : cls(colorBy);
  };
  const pc = has(q.prev_close) ? Number(q.prev_close) : 0;
  ["open", "high", "low"].forEach((k) => {
    if (!has(q[k])) { set(k, "—"); return; }
    const v = Number(q[k]);
    set(k, px(v), pc && v ? v - pc : undefined);
  });
  set("prev_close", has(q.prev_close) ? px(Number(q.prev_close)) : "—");
  const g = q.market === "us" || q.market === "hk";
  set("volume", fmtVolText(q.volume, q.vol_unit));
  set("amount", fmtMoney(q.amount, q.money_unit, q.currency));
  set("turnover_rate", has(q.turnover_rate) && !g ? `${num(q.turnover_rate, 2)}%` : "—");
  set("vol_ratio", has(q.vol_ratio) && !g ? num(q.vol_ratio, 2) : "—");
  set("pe", has(q.pe) ? num(q.pe, 1) : "—");
  set("pb", has(q.pb) && !g ? num(q.pb, 2) : "—");
  set("float_cap", has(q.float_cap) ? fmtCap(q.float_cap, g ? q.currency : "") : "—");
  set("total_cap", has(q.total_cap) ? fmtCap(q.total_cap, g ? q.currency : "") : "—");
}
function bindStockTabs() {
  $$("#stock-tabs button").forEach((b) => {
    b.onclick = () => setStockTab(b.dataset.tab);
  });
}
function setStockTab(tab) {
  const chart = $("#stock-tab-chart");
  const company = $("#stock-tab-company");
  const news = $("#stock-tab-news");
  if (!chart) return;
  chart.classList.toggle("hidden", tab !== "chart");
  if (company) company.classList.toggle("hidden", tab !== "company");
  if (news) news.classList.toggle("hidden", tab !== "news");
  $$("#stock-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const body = $("#sheet .sheet-body");
  if (body) body.scrollTop = 0;
  // 切回行情页时按当前宽度重画，避免隐藏期间画布被按 0 宽缩掉
  if (tab === "chart") {
    const cv = $("#kchart");
    if (cv && cv._d) drawKline(cv, cv._d, null);
    const ff = $("#ffchart");
    if (ff && ff._items) drawFF(ff, ff._items);
    const chipcv = $("#chipchart");
    if (chipcv && chipcv._d) drawChip(chipcv, chipcv._d);
  }
}

/* ETF 持仓：前十大股票/债券权重（天天基金季报，服务端缓存 7 天） */
function etfHoldingsHtml(d, qmap = {}) {
  if (!d || d.ok === false) {
    return `<div class="etf-hold"><div class="empty">${esc((d && d.error) || "暂时取不到持仓")}</div></div>`;
  }
  const stocks = d.stocks || [];
  const bonds = d.bonds || [];
  const rows = stocks.length ? stocks : bonds;
  const isStock = stocks.length > 0;
  if (!rows.length) {
    return `<div class="etf-hold">
      <div class="etf-hold-head"><b>持仓 · 权重</b><span class="tiny muted">${esc(d.report_date || "最新季报")}</span></div>
      <div class="empty">暂无持仓披露</div>
    </div>`;
  }
  const total = rows.reduce((s, x) => s + Number(x.weight || 0), 0);
  const rowsHtml = rows.map((x, i) => {
    const chg = isStock && x.change_type
      ? `<span class="eh-chg ${x.change_type === "增持" ? "up" : x.change_type === "减持" ? "down" : "new"}">${esc(x.change_type)}${x.change !== null && x.change !== undefined ? ` ${Number(x.change) > 0 ? "+" : ""}${Number(x.change).toFixed(2)}` : ""}</span>`
      : "";
    const ind = x.industry ? `<span class="eh-ind">${esc(x.industry)}</span>` : "";
    const q = qmap[x.code] || {};
    const hasPct = q.pct !== null && q.pct !== undefined && q.pct !== "";
    const pctHtml = hasPct ? `<span class="eh-pct ${cls(q.pct)}">${pctText(q.pct)}</span>` : `<span class="eh-pct flat">—</span>`;
    const clickable = isStock && /^\d{6}$/.test(String(x.code || ""));
    return `<div class="eh-row${clickable ? " clickable" : ""}"${clickable ? ` data-hold-stock="${x.code}" data-hold-name="${esc(x.name)}"` : ""}>
      <span class="eh-rank">${i + 1}</span>
      <span class="eh-name"><b>${esc(x.name)}</b><i>${esc(x.code)}</i>${ind}</span>
      ${chg}
      ${pctHtml}
      <span class="eh-w">${Number(x.weight).toFixed(2)}%</span>
      ${clickable ? '<span class="eh-go">›</span>' : ""}
    </div>`;
  }).join("");
  const title = isStock ? "前十大股票持仓" : `前${rows.length}大债券持仓`;
  const stale = d.stale ? ` · 缓存${d.error ? "（刷新失败）" : ""}` : "";
  return `<div class="etf-hold">
    <div class="etf-hold-head"><b>${title}</b><span class="tiny muted">报告期 ${esc(d.report_date || "最新")}${stale}</span></div>
    <div class="eh-sum">前${rows.length}大合计 ${total.toFixed(2)}%</div>
    ${rowsHtml}
  </div>`;
}

function bindEtfHoldingRows(box, etfCode, etfName) {
  if (!box) return;
  $$("[data-hold-stock]", box).forEach((row) => {
    row.onclick = () => {
      const c = row.dataset.holdStock;
      const n = row.dataset.holdName;
      if (!c) return;
      const sheetBody = $("#sheet .sheet-body");
      const restoreTop = sheetBody ? sheetBody.scrollTop : 0;
      sheetBack = null;
      closeSheet();
      openHeatStock(c, n);
      // 关闭个股详情时回到上一级 ETF 详情，并恢复「持仓 · 权重」页签和滚动位置
      sheetBack = () => {
        if (trackedOf(etfCode)) openStock(etfCode);
        else openHeatStock(etfCode, etfName || etfCode);
        const restore = () => {
          const sh = $("#sheet");
          const title = $("#sheet-title").textContent || "";
          if (!sh || sh.classList.contains("hidden") || !title.includes(etfCode)) return;
          setStockTab("company");
          const body = $("#sheet .sheet-body");
          if (body) body.scrollTop = restoreTop;
        };
        requestAnimationFrame(restore);
        setTimeout(restore, 80);
        setTimeout(restore, 260);
        setTimeout(restore, 700);
      };
    };
  });
}

async function loadEtfHoldings(code, etfName = "") {
  const box = $("#sq-etf-holdings");
  if (!box) return null;
  try {
    const d = await api(`etf/holdings/${code}`, {}, 20000);
    const rows = d.stocks || [];   // 债券 ETF 不补股票涨跌幅
    const codes = [...new Set(rows.map((x) => String(x.code || "")).filter((c) => /^\d{6}$/.test(c)))];
    let qmap = {};
    if (codes.length) {
      const qr = await api(`quotes?codes=${encodeURIComponent(codes.join(","))}`, {}, 15000).catch(() => null);
      qmap = (qr && qr.quotes) || {};
    }
    if (document.contains(box)) {
      box.innerHTML = etfHoldingsHtml(d, qmap);
      bindEtfHoldingRows(box, code, etfName);
    }
    return d;
  } catch (e) {
    if (document.contains(box)) {
      box.innerHTML = `<div class="etf-hold"><div class="empty">${esc(e.message || "持仓加载失败")}</div></div>`;
    }
    return null;
  }
}

/* ---------- 持仓重合度：前十大估算 ---------- */
function etfOverlapLevelText(level) {
  return level === "high" ? "重合高" : level === "mid" ? "重合中" : "重合低";
}

function etfOverlapBadgeHtml(ov) {
  if (!ov || !ov.ok) return "";
  const score = Number(ov.score || 0);
  if (!(score >= 10)) return "";
  const cls = score >= 50 ? "high" : score >= 25 ? "mid" : "low";
  return `<span class="etf-ov-lv ${cls}">${etfOverlapLevelText(ov.level)} ${Math.round(score)}%</span>`;
}

function etfOverlapRowHtml(e) {
  if (e.ok === false) {
    return `<div class="etf-ov-row bad"><span class="nm">${esc(e.name || e.code)}</span><span class="tiny muted">${esc(e.error || "持仓获取失败")}</span></div>`;
  }
  const pct = Number(e.overlap || 0);
  const cls = pct >= 50 ? "high" : pct >= 25 ? "mid" : "";
  const common = (e.common || []).slice(0, 5)
    .map((c) => `${esc(c.name)} ${Number(c.overlap).toFixed(1)}%`).join(" · ");
  return `<div class="etf-ov-row">
      <span class="nm">${esc(e.name || e.code)}</span>
      <span class="pct ${cls}">${pct.toFixed(1)}%</span>
      <span class="tiny muted">共同${e.common_count || 0}只</span>
    </div>
    ${common ? `<div class="etf-ov-common">${common}</div>` : ""}`;
}

function etfOverlapHtml(ov, code, name) {
  const pick = `<button type="button" class="etf-ov-pick" data-ov-pick="${code}" data-ov-name="${esc(name || (ov && ov.name) || "")}">＋ 选择 ETF 对比</button>`;
  if (!ov || ov.ok === false) {
    return `<div class="etf-ov"><div class="etf-ov-head"><b>与你持仓的重合</b></div>
      <div class="tiny muted" style="margin:4px 0 8px">${esc((ov && ov.error) || "暂时取不到重合数据")}</div>
      ${pick}</div>`;
  }
  if (ov.no_holdings) {
    return `<div class="etf-ov"><div class="etf-ov-head"><b>与你持仓的重合</b></div>
      <div class="tiny muted" style="margin:4px 0 8px">暂无持仓数据</div>
      ${pick}</div>`;
  }
  const direct = ov.direct || {};
  const dHold = direct.items || [];
  const dWatch = direct.watch_items || [];
  const holdEtfs = (ov.etfs || []).filter((x) => x.source === "hold");
  const watchEtfs = (ov.etfs || []).filter((x) => x.source === "watch");
  const holdTotal = Number(direct.total || 0);
  const watchTotal = Number(direct.watch_total || 0);
  const tagsHtml = (arr, cls) => arr.length
    ? `<div class="etf-ov-tags">${arr.map((x) => `<span class="etf-ov-tag ${cls}">${esc(x.tracked_name || x.name)} ${Number(x.weight).toFixed(2)}%</span>`).join("")}</div>`
    : `<div class="tiny muted">没有重合</div>`;
  const holdEtfHtml = holdEtfs.length
    ? holdEtfs.map(etfOverlapRowHtml).join("")
    : `<div class="tiny muted">没有持仓 ETF 重合</div>`;
  const watchEtfHtml = watchEtfs.length
    ? watchEtfs.map(etfOverlapRowHtml).join("")
    : `<div class="tiny muted">没有关注的 ETF 重合</div>`;
  const maxHoldEtf = Math.max(0, ...holdEtfs.map((x) => Number(x.overlap) || 0));
  const maxWatchEtf = Math.max(0, ...watchEtfs.map((x) => Number(x.overlap) || 0));
  const section = (title, sum, body) => `<details class="etf-ov-sec">
      <summary><span class="etf-ov-t">${title}</span><span class="etf-ov-sum">${sum}</span><span class="etf-ov-arrow">⌄</span></summary>
      <div class="etf-ov-body">${body}</div>
    </details>`;
  return `<div class="etf-ov">
    <div class="etf-ov-head"><b>与你持仓的重合</b>${etfOverlapBadgeHtml(ov)}</div>
    ${section("直接持仓的股票", `<b>${holdTotal.toFixed(2)}%</b> · ${dHold.length ? `${dHold.length}只` : "无"}`, tagsHtml(dHold, "hold"))}
    ${dWatch.length ? section("关注中的股票", `<b>${watchTotal.toFixed(2)}%</b> · ${dWatch.length}只`, tagsHtml(dWatch, "watch")) : ""}
    ${section("已持有的 ETF", holdEtfs.length ? `${holdEtfs.length}只 · 最高 ${maxHoldEtf.toFixed(1)}%` : "无", holdEtfHtml)}
    ${watchEtfs.length ? section("关注的 ETF", `${watchEtfs.length}只 · 最高 ${maxWatchEtf.toFixed(1)}%`, watchEtfHtml) : ""}
    ${pick}
  </div>`;
}

function paintEtfOverlap(ov, code, name) {
  const box = $("#sq-etf-overlap");
  if (!box) return;
  box.innerHTML = etfOverlapHtml(ov, code, name);
  const pick = box.querySelector("[data-ov-pick]");
  if (pick) pick.onclick = () => openEtfComparePicker(code, pick.dataset.ovName || name);
  const warn = $("#h-ov-warn");
  if (warn) {
    const score = ov && ov.ok ? Number(ov.score || 0) : 0;
    if (score >= 25) {
      warn.textContent = `⚠ 与你现有持仓重合约 ${Math.round(score)}%`;
      warn.classList.toggle("high", score >= 50);
      warn.classList.remove("hidden");
    } else {
      warn.classList.add("hidden");
      warn.textContent = "";
    }
  }
}

let etfOverlapReq = 0;
async function loadEtfOverlap(code, name) {
  const box = $("#sq-etf-overlap");
  if (!box) return;
  const cached = state.etfOverlap[code];
  if (cached) paintEtfOverlap(cached, code, name);
  else box.innerHTML = `<div class="etf-ov"><div class="tiny muted">计算持仓重合…</div></div>`;
  const seq = ++etfOverlapReq;
  try {
    const d = await api("etf/overlap", { method: "POST", body: {
      codes: [{ code, name: name || code }],
    } }, 30000);
    if (seq !== etfOverlapReq) return;
    const ov = (d.items || []).find((x) => x.code === code);
    if (!ov) throw new Error("没有返回重合数据");
    state.etfOverlap[code] = ov;
    if (document.contains(box)) paintEtfOverlap(ov, code, name);
    const slot = document.querySelector(`#trend-list .trend-ov-slot[data-ov-code="${code}"]`);
    if (slot) slot.innerHTML = trendOverlapBadgeHtml(ov);
  } catch (e) {
    if (seq !== etfOverlapReq || !document.contains(box)) return;
    if (!cached) box.innerHTML = `<div class="etf-ov"><div class="tiny muted">${esc(e.message || "重合计算失败")}</div></div>`;
  }
}

/* 自定义对比 ETF：跟踪的 ETF 自动参与，这里只加额外代码 */
function etfCompareRows(ha, hb) {
  const okA = ha && ha.ok !== false;
  const okB = hb && hb.ok !== false;
  const aStocks = okA ? (ha.stocks || []) : [];
  const bStocks = okB ? (hb.stocks || []) : [];
  const aBonds = okA ? (ha.bonds || []) : [];
  const bBonds = okB ? (hb.bonds || []) : [];
  const aList = aStocks.length ? aStocks : aBonds;
  const bList = bStocks.length ? bStocks : bBonds;
  const key = (x) => String(x.code || "") || `n:${x.name || ""}`;
  const aRows = aList.map((x, i) => ({
    rank: i + 1, key: key(x), name: x.name || x.code || "", code: x.code || "",
    weight: Number(x.weight) || 0, common: false,
  }));
  const bRows = bList.map((x, i) => ({
    rank: i + 1, key: key(x), name: x.name || x.code || "", code: x.code || "",
    weight: Number(x.weight) || 0, common: false,
  }));
  const aMap = new Map(aRows.map((x) => [x.key, x]));
  const bMap = new Map(bRows.map((x) => [x.key, x]));
  const common = [];
  aRows.forEach((x) => {
    const y = bMap.get(x.key);
    if (!y) return;
    x.common = true;
    y.common = true;
    common.push({ name: x.name || y.name, code: x.code || y.code,
      a: x.weight, b: y.weight, overlap: Math.min(x.weight, y.weight) });
  });
  common.sort((u, v) => v.overlap - u.overlap);
  return {
    aRows, bRows, common,
    commonSum: common.reduce((s, x) => s + x.overlap, 0),
    isBondA: !aStocks.length && aBonds.length > 0,
    isBondB: !bStocks.length && bBonds.length > 0,
  };
}

function etfCompareHtml(ha, hb, qa, qb, pa, pb, aCode, aName, bCode, bName) {
  const qA = qa || {};
  const qB = qb || {};
  const pA = pa && pa.ok !== false ? pa : null;
  const pB = pb && pb.ok !== false ? pb : null;
  const nameA = aName || (ha && ha.name) || aCode;
  const nameB = bName || (hb && hb.name) || bCode;
  const head = `<div class="cmp-funds">
    <div class="cmp-fund"><b>${esc(nameA)}</b><span>${aCode}</span>
      <div class="cmp-pct ${cls(qA.pct)}">${pctText(qA.pct)}</div><div class="cmp-sub">${px(qA.price)}</div></div>
    <div class="cmp-vs">VS</div>
    <div class="cmp-fund"><b>${esc(nameB)}</b><span>${bCode}</span>
      <div class="cmp-pct ${cls(qB.pct)}">${pctText(qB.pct)}</div><div class="cmp-sub">${px(qB.price)}</div></div>
  </div>`;
  const met = (label, av, bv) => `<div class="cmp-mrow"><span>${label}</span><b>${av}</b><b>${bv}</b></div>`;
  const metrics = `<div class="cmp-mets">
    ${met("规模", capText(qA.float_cap), capText(qB.float_cap))}
    ${met("成交额", fmtAmountWan(qA.amount), fmtAmountWan(qB.amount))}
    ${met("换手", qA.turnover_rate !== null && qA.turnover_rate !== undefined ? `${Number(qA.turnover_rate).toFixed(2)}%` : "—",
          qB.turnover_rate !== null && qB.turnover_rate !== undefined ? `${Number(qB.turnover_rate).toFixed(2)}%` : "—")}
    ${met("量比", qA.vol_ratio !== null && qA.vol_ratio !== undefined ? Number(qA.vol_ratio).toFixed(2) : "—",
          qB.vol_ratio !== null && qB.vol_ratio !== undefined ? Number(qB.vol_ratio).toFixed(2) : "—")}
    ${met("报告期", esc((ha && ha.report_date) || "—"), esc((hb && hb.report_date) || "—"))}
  </div>`;
  const perfCells = (s) => {
    if (!s) return `<span class="cell">—</span><span class="cell">—</span><span class="cell">—</span>`;
    const dd = s.max_drawdown === null || s.max_drawdown === undefined
      ? "—" : `${Number(s.max_drawdown).toFixed(2)}%`;
    const vol = s.volatility === null || s.volatility === undefined
      ? "—" : `${Number(s.volatility).toFixed(1)}%`;
    return `<span class="cell ${cls(s.return)}">${pctText(s.return)}</span>` +
      `<span class="cell dd">${dd}</span><span class="cell vol">${vol}</span>`;
  };
  const perfRow = (label, k) => `<div class="cmp-perf-row"><span class="lab">${label}</span>` +
    `${perfCells(pA && pA[k])}${perfCells(pB && pB[k])}</div>`;
  const perf = (pA || pB)
    ? `<div class="cmp-perf">
        <div class="cmp-perf-head"><span class="lab">区间</span><span class="grp g3">本基金</span><span class="grp g3">对比</span></div>
        <div class="cmp-perf-sub"><span></span><span>收益</span><span>回撤</span><span>波动</span><span>收益</span><span>回撤</span><span>波动</span></div>
        ${perfRow("今年以来", "ytd")}
        ${perfRow("本季度", "qtd")}
        ${perfRow("成立以来", "since")}
      </div>`
    : `<div class="tiny muted" style="margin:4px 0 8px">收益 / 回撤数据暂时取不到</div>`;
  const cmp = etfCompareRows(ha, hb);
  const col = (label, rows, isBond) => `<div class="cmp-hold-col">
      <div class="cmp-col-head">${label}<span>${isBond ? "债券" : "股票"}持仓</span></div>
      ${rows.length ? rows.map((r) => `<div class="cmp-hrow${r.common ? " common" : ""}">
        <span class="rk">${r.rank}</span>
        <span class="nm">${esc(r.name)}<i>${esc(r.code)}</i></span>
        <span class="w">${r.weight.toFixed(2)}%</span>
      </div>`).join("") : `<div class="tiny muted cmp-no-hold">无持仓披露</div>`}
    </div>`;
  const holdings = (cmp.aRows.length || cmp.bRows.length)
    ? `<div class="cmp-section-head">前十大持仓 <span class="tiny muted">共同 ${cmp.common.length} 只${cmp.common.length ? ` · 合计 ${cmp.commonSum.toFixed(2)}%` : ""}</span></div>
      <div class="cmp-hold-cols">${col("本基金", cmp.aRows, cmp.isBondA)}${col("对比", cmp.bRows, cmp.isBondB)}</div>`
    : `<div class="empty">暂无持仓数据</div>`;
  return `<div class="cmp-body">
    ${head}
    ${metrics}
    ${perf}
    ${holdings}
    <div class="sheet-actions">
      <button type="button" class="btn ghost" id="cmp-back">返回搜索</button>
      <button type="button" class="btn primary" data-close>关闭</button>
    </div>
  </div>`;
}

async function showEtfCompare(aCode, aName, bCode, bName) {
  openSubSheet("ETF 对比", `<div class="cmp-loading">正在加载两只基金的持仓、行情和收益回撤…</div>`);
  const [ha, hb, qa, qb, pa, pb] = await Promise.all([
    api(`etf/holdings/${aCode}`, {}, 20000).catch(() => null),
    api(`etf/holdings/${bCode}`, {}, 20000).catch(() => null),
    api(`quote/${aCode}`, {}, 12000).catch(() => null),
    api(`quote/${bCode}`, {}, 12000).catch(() => null),
    api(`etf/perf/${aCode}`, {}, 15000).catch(() => null),
    api(`etf/perf/${bCode}`, {}, 15000).catch(() => null),
  ]);
  const sh = $("#sheet2");
  if (!sh || sh.classList.contains("hidden")) return;
  $("#sheet2-title").textContent = "ETF 对比";
  const c = $("#sheet2-content");
  if (c) c.innerHTML = etfCompareHtml(ha, hb, qa, qb, pa, pb, aCode, aName, bCode, bName);
  const back = $("#cmp-back");
  if (back) back.onclick = () => openEtfComparePicker(aCode, aName);
  $$("#sheet2 [data-close]").forEach((b) => (b.onclick = closeSubSheet));
}

/* 搜索任意 ETF 与当前基金做对比：结果点一下直接打开两基金对比弹层 */
function openEtfComparePicker(code, name) {
  let searchTimer = null;
  let searchSeq = 0;
  openSubSheet("选择对比 ETF", `
    <div class="field">
      <input id="ov-code" type="search" placeholder="搜索 ETF 名称 / 代码" autocomplete="off" enterkeyhint="search">
      <div id="ov-results" class="ov-results"></div>
    </div>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-close>取消</button></div>`);
  const input = $("#ov-code");
  const resultsBox = $("#ov-results");
  const isEtfSearchItem = (x) => {
    if (!x || !x.code || !isEtfCode(x.code) || x.code === code) return false;
    return !x.type || /ETF/i.test(String(x.type));
  };
  const paintResults = (items) => {
    if (!resultsBox) return;
    const q = (input && input.value || "").trim();
    if (q.length < 2) {
      resultsBox.innerHTML = "";
      return;
    }
    const uniq = [];
    const seen = new Set();
    for (const x of (items || [])) {
      if (!isEtfSearchItem(x) || seen.has(x.code)) continue;
      seen.add(x.code);
      uniq.push(x);
    }
    const list = uniq.slice(0, 12);
    if (!list.length) {
      resultsBox.innerHTML = `<div class="tiny muted">没有找到 ETF</div>`;
      return;
    }
    resultsBox.innerHTML = list.map((x) => `<div class="ov-result" data-ov-add-code="${x.code}" data-ov-add-name="${esc(x.name)}">
        <div class="nm"><b>${esc(x.name)}</b><span>${x.code}${x.type ? ` · ${esc(x.type)}` : ""}</span></div>
        <span class="add">对比 ›</span>
      </div>`).join("");
    $$("#ov-results [data-ov-add-code]").forEach((row) => {
      row.onclick = () => {
        if (input) input.blur();
        showEtfCompare(code, name, row.dataset.ovAddCode, row.dataset.ovAddName);
      };
    });
  };
  const doSearch = async () => {
    if (!input || !resultsBox) return;
    const q = input.value.trim();
    if (q.length < 2) { paintResults([]); return; }
    const seq = ++searchSeq;
    resultsBox.innerHTML = `<div class="tiny muted">搜索中…</div>`;
    try {
      const d = await api(`search?q=${encodeURIComponent(q)}`, {}, 12000);
      if (seq !== searchSeq || !document.contains(resultsBox)) return;
      paintResults((d && d.items) || []);
    } catch (e) {
      if (seq === searchSeq && document.contains(resultsBox)) {
        resultsBox.innerHTML = `<div class="tiny muted">${esc(e.message || "搜索失败")}</div>`;
      }
    }
  };
  paintResults([]);
  if (input) {
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(doSearch, 280);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const first = resultsBox && resultsBox.querySelector("[data-ov-add-code]");
      if (first) first.click();
      else doSearch();
    });
    setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 80);
  }
}

/* 趋势榜卡片上的重合角标 */
function trendOverlapBadgeHtml(ov) {
  if (!ov || !ov.ok) return "";
  const score = Number(ov.score || 0);
  if (!(score >= 10)) return "";
  const cls = score >= 50 ? "high" : score >= 25 ? "mid" : "low";
  return `<span class="trend-ov ${cls}">重合${Math.round(score)}%</span>`;
}

async function loadTrendOverlaps(items) {
  const etfMode = !!(state.trendData && state.trendData.asset === "etf");
  const codes = (items || []).filter((x) => x && (x.is_etf || etfMode))
    .map((x) => ({ code: x.code, name: x.name }));
  if (!codes.length) return;
  const paint = () => {
    $$("#trend-list .trend-ov-slot").forEach((slot) => {
      slot.innerHTML = trendOverlapBadgeHtml(state.etfOverlap[slot.dataset.ovCode]);
    });
  };
  const missing = codes.filter((x) => !state.etfOverlap[x.code]);
  if (!missing.length) { paint(); return; }
  const seq = ++state.trendOverlapSeq;
  try {
    const d = await api("etf/overlap", { method: "POST", body: { codes: missing } }, 30000);
    if (seq !== state.trendOverlapSeq) return;
    (d.items || []).forEach((x) => { if (x && x.ok) state.etfOverlap[x.code] = x; });
    paint();
  } catch (e) { /* 静默：榜单没有角标也不影响使用 */ }
}

/* 点个股只看行情、K 线、资金流向和筹码；备注走列表行，自定义标签走长按 */
/* ---------- 场外基金详情：净值 + 阶段收益 + 档案（交易类字段全部隐藏） ---------- */
const fundProfileMemo = new Map();

function fundPctText(v) {
  if (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function paintFundGrid(d) {
  const box = $("#sq-detail");
  if (!box || !d) return;
  const set = (k, txt, colorBy) => {
    const el = box.querySelector(`[data-q="${k}"]`);
    if (!el) return;
    el.textContent = txt;
    el.className = colorBy === undefined ? "" : cls(colorBy);
  };
  const hasV = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  set("nav", hasV(d.nav) ? Number(d.nav).toFixed(4) : "—");
  set("nav_date", d.nav_date || "—");
  // 累计净值等于单位净值（没有分红拆分）时，这一格和上一格重复，直接收起来
  const accSame = hasV(d.accnav) && hasV(d.nav) && Math.abs(Number(d.accnav) - Number(d.nav)) < 1e-6;
  set("accnav", hasV(d.accnav) ? Number(d.accnav).toFixed(4) : "—");
  const accEl = box.querySelector('[data-q="accnav"]');
  if (accEl && accEl.parentElement) accEl.parentElement.style.display = accSame ? "none" : "";
  set("pct_d", fundPctText(d.pct), hasV(d.pct) ? Number(d.pct) : undefined);
  [["m1", d.m1], ["m3", d.m3], ["m6", d.m6], ["y1", d.y1], ["ytd", d.ytd], ["since", d.since]]
    .forEach(([k, v]) => set(k, fundPctText(v), hasV(v) ? Number(v) : undefined));
  set("sgzt", d.sgzt || "—");
  set("endnav", hasV(d.scale) ? `${num(d.scale, 2)} 亿` : hasV(d.endnav) ? capText(d.endnav) : "—");
}

function paintFundPerf(d) {
  const box = $("#fund-perf");
  if (!box) return;
  const rows = (d.periods || []).filter((x) => x.syl !== null && x.syl !== undefined);
  box.innerHTML = rows.length ? rows.map((x) =>
    `<span class="fp-chip"><i>${esc(x.label)}</i><b class="${cls(x.syl)}">${fundPctText(x.syl)}</b></span>`).join("")
    : "";
}

function fundArchHtml(d) {
  const hasV = (v) => v !== null && v !== undefined && v !== "";
  const row = (k, v, wide) => `<div${wide ? ' style="grid-column:1/-1"' : ""}><span class="k">${esc(k)}</span><b${wide ? ' class="wide"' : ""}>${esc(v)}</b></div>`;
  const rate = hasV(d.rate) ? `${d.rate}%` : hasV(d.source_rate) ? `${d.source_rate}%` : "—";
  const head = `<div class="q-detail">${[
    row("基金类型", d.ftype || "—", true),
    row("基金公司", d.company || "—"),
    row("基金经理", d.manager || "—"),
    row("成立日期", d.found || "—"),
    row("最新规模", hasV(d.scale) ? `${num(d.scale, 2)} 亿` : hasV(d.endnav) ? capText(d.endnav) : "—"),
    row("风险等级", d.risk ? `${["", "低", "中低", "中", "中高", "高"][Number(d.risk)] || d.risk}风险` : "—"),
    row("申购费率", rate),
    row("起购金额", hasV(d.minsg) ? `${d.minsg} 元` : "—"),
    row("申购状态", d.sgzt || "—"),
    row("赎回状态", d.shzt || "—"),
    row("净值日期", d.nav_date || "—"),
    row("数据源", "天天基金"),
  ].join("")}</div>`;
  const per = (d.periods || []).filter((x) => x.syl !== null && x.syl !== undefined);
  const perfRows = per.map((x) => `<div class="fa-row">
      <span class="fa-l">${esc(x.label)}</span>
      <span class="fa-v ${cls(x.syl)}">${fundPctText(x.syl)}</span>
      <span class="fa-r tiny muted">${x.rank && x.sc ? `同类 ${Math.round(x.rank)}/${Math.round(x.sc)}` : ""}</span>
    </div>`).join("");
  const mark = d.sgzt_mark ? `<div class="tiny muted">${esc(d.sgzt_mark)}</div>` : "";
  return `${head}${mark}
    <div class="fund-arch-perf"><div class="ff-head"><span>阶段涨幅 · 同类排名</span><span class="tiny muted">天天基金</span></div>${perfRows}</div>`;
}

async function loadFundProfile(code) {
  const box = $("#sq-detail");
  if (!box) return;
  let d = fundProfileMemo.get(code);
  // 列表页批量取的是 lite（没有净值历史），详情页要完整版，这里主动丢缓存重取一次
  if (d && d.lite) d = null;
  if (!d && fundCooling(code)) {
    // 退避期内不再打接口，直接把「取不到」写在原位，避免 3 秒一次的详情轮询反复重拉
    const note = $("#sq-note");
    if (note) note.textContent = "基金档案暂时取不到（稍后自动重试）";
    return;
  }
  if (!d) {
    try { d = await api(`fund/${code}`, {}, 25000); } catch (e) { d = null; }
    if (d && d.ok) { fundProfileMemo.set(code, d); fundFailAt.delete(code); }
    else fundFail(code, (d && d.error) || "空响应");
  }
  if (!document.contains(box)) return;
  if (!d || !d.ok) {
    const note = $("#sq-note");
    if (note) note.textContent = (d && d.error) || "基金档案暂时取不到";
    return;
  }
  markFund(code);
  paintFundGrid(d);
  paintFundPerf(d);
  const arch = $("#fund-arch");
  if (arch) arch.innerHTML = fundArchHtml(d);
  const price = $("#sq-price");
  if (price && (price.textContent === "—" || !price.textContent) && d.nav) {
    price.textContent = Number(d.nav).toFixed(4);
    const pc = $("#sq-pct");
    if (pc) { pc.textContent = fundPctText(d.pct); pc.className = cls(d.pct); }
  }
  const note = $("#sq-note");
  if (note) note.textContent = "";
}

async function loadFundNews(code) {
  const box = $("#fund-news");
  if (!box) return;
  let d = null;
  try { d = await api(`fund/${code}/news?limit=24`, {}, 25000); } catch (e) { d = null; }
  if (!document.contains(box)) return;
  if (!d || !d.items || !d.items.length) {
    box.innerHTML = `<div class="empty">暂时取不到相关新闻</div>`;
    return;
  }
  const names = (d.based_on || []).map((x) => x.name).filter(Boolean).slice(0, 4).join("、");
  const head = `<div class="fn-sum">相关标的：${esc(names || "—")}${d.report ? ` · 持仓 ${esc(d.report)}` : ""}</div>`;
  const srcs = new Set(d.items.map((it) => it.name || it.code).filter(Boolean));
  const showSrc = srcs.size > 1;  // 同源新闻（如全是同一只 ETF）不再逐条重复来源
  const rows = d.items.map((it) => `<div class="fn-item">
      <div class="fn-meta">${showSrc ? `<span class="fn-src">${esc(it.name || it.code)}</span><i>·</i>` : ""}<span>${esc(String(it.time || "").slice(5, 16))}</span></div>
      <div class="fn-title">${esc(it.title)}</div>
    </div>`).join("");
  box.innerHTML = head + rows;
}

/* 我的持仓：份额/成本都由用户自己录入，纯本地库，不做任何推断 */
const _holdMemo = { ts: 0, rows: [] };
async function loadHoldings() {
  if (Date.now() - _holdMemo.ts < 5000 && _holdMemo.rows.length) return _holdMemo.rows;
  const d = await api("stocks", { noRetry: true }, 15000).catch(() => null);
  const rows = (d && (d.stocks || d)) || [];
  _holdMemo.ts = Date.now();
  _holdMemo.rows = Array.isArray(rows) ? rows : [];
  return _holdMemo.rows;
}
function fundHoldHtml(code) {
  return `<div class="fp-hold" id="fp-hold" data-code="${code}"><div class="fp-hold-row"><span class="muted">读取持仓…</span></div></div>`;
}
function paintFundHold(code, row) {
  const box = $("#fp-hold");
  if (!box || box.dataset.code !== code) return;
  const sh = row && row.shares ? Number(row.shares) : 0;
  const cost = row && row.cost !== null && row.cost !== undefined ? Number(row.cost) : null;
  const s = state.board.stocks.find((x) => x.code === code) || {};
  const nav = s.price ? Number(s.price) : null;
  const mv = sh && nav ? sh * nav : null;
  const pnl = mv !== null && cost !== null ? mv - cost : null;
  const dca = row && row.dca ? Number(row.dca) : 0;
  const cells = sh
    ? `<div><span class="k">份额</span><b>${num(sh, 2)}</b></div>
       <div><span class="k">成本</span><b>${cost === null ? "—" : num(cost, 2)}</b></div>
       <div><span class="k">市值</span><b>${mv === null ? "—" : num(mv, 2)}</b></div>
       <div><span class="k">累计</span><b class="${cls(pnl)}">${pnl === null ? "—" : (pnl > 0 ? "+" : "") + num(pnl, 2)}</b></div>
       <button type="button" class="fp-hold-dca" id="fp-hold-dca"><span class="k">每日定投</span><b>${dca ? num(dca, 0) + " 元" : "未设"}</b><i>统一修改 ›</i></button>`
    : `<div class="fp-hold-empty">还没录份额，填一下才能算市值和收益</div>`;
  box.innerHTML = `<div class="fp-hold-hd"><span class="fp-hold-t">我的持仓</span>
      <button type="button" class="btn ghost mini" id="fp-hold-edit">${sh ? "修改" : "录入"}</button></div>
    <div class="fp-hold-grid">${cells}</div>`;
  bindFundHold(code, row || {});
}
function bindFundHold(code, row) {
  const btn = $("#fp-hold-edit");
  const box = $("#fp-hold");
  if (!btn || !box) return;
  const dcaBtn = $("#fp-hold-dca");
  if (dcaBtn) dcaBtn.onclick = () => { closeSheet(); openDcaEditor(); };   // 定投统一到新编辑器，这里不再单独改
  btn.onclick = () => {
    box.innerHTML = `<div class="fp-hold-tip">份额 · 成本（元）· 定投额度到持仓页「每日定投」统一改</div>
      <div class="fp-hold-form">
        <label><input id="fp-sh" type="number" step="0.01" inputmode="decimal" value="${row.shares || ""}" placeholder="份额" aria-label="份额"></label>
        <label><input id="fp-cost" type="number" step="0.01" inputmode="decimal" value="${row.cost ?? ""}" placeholder="成本" aria-label="成本"></label>
        <button type="button" class="btn primary mini" id="fp-hold-save">保存</button>
        <button type="button" class="btn ghost mini" id="fp-hold-cancel">取消</button>
      </div>`;
    $("#fp-hold-cancel").onclick = () => paintFundHold(code, row);
    $("#fp-hold-save").onclick = async () => {
      const sh = parseFloat($("#fp-sh").value);
      const cost = parseFloat($("#fp-cost").value);
      if (!(sh >= 0) || !(cost >= 0)) { toast("份额和成本要填数字"); return; }
      const saveBtn = $("#fp-hold-save");
      saveBtn.disabled = true; saveBtn.textContent = "保存中…";
      try {
        const body = { shares: sh, cost };
        if (sh > 0) body.bucket = "hold";
        await api(`stocks/${code}`, { method: "PATCH", idempotent: true, body }, 20000);
        _memo.delete("board");
        _holdMemo.ts = 0;
        await loadBoard(true).catch(() => {});
        toast("持仓已更新");
        closeSheet();
        refreshMarketAll();
      } catch (e) { saveBtn.disabled = false; saveBtn.textContent = "保存"; toast(e.message || "保存失败"); }
    };
  };
}
function bindFundHoldBlock(code) {
  loadHoldings().then((rows) => {
    const row = rows.find((x) => String(x.code) === String(code));
    paintFundHold(code, row);
  });
}

function openFundSheet(code, name, opts = {}) {
  markFund(code);
  const tracked = trackedOf(code);
  const s = state.board.stocks.find((x) => x.code === code);
  const nm = name || (s && s.name) || code;
  openSheet(
    `${esc(nm)} · ${code}`,
    `${stockTabsHtml("fund")}
     <div id="stock-tab-chart">
       <div class="sheet-quote"><span class="q" id="sq-price">${s && s.price ? Number(s.price).toFixed(4) : "—"}</span>
         <span id="sq-pct" class="${s ? cls(s.pct) : "flat"}">${s ? pctText(s.pct) : "—"}</span></div>
       ${qDetailHtml("fund")}
       <div class="kl-row" id="sq-kl"></div>
       ${fundHoldHtml(code)}
       ${tracked ? `<div class="pri-line" id="sq-pri"><span class="pri-label">优先级</span>${priChips(code, (s && s.priority) || "")}</div>` : ""}
       <div class="fund-perf" id="fund-perf"></div>
       ${kbarHtml(false, "f1y", FUND_K_PERIODS)}
     </div>
     <div id="stock-tab-company" class="hidden"><div id="fund-arch"><div class="empty">加载基金档案…</div></div></div>
     <div id="stock-tab-news" class="hidden"><div id="fund-news"><div class="empty">加载相关新闻…</div></div></div>
     ${detailNotesHtml()}
     <div class="sheet-actions">
       ${tracked ? `<button class="btn ghost" data-sheet-tags="${code}">标签</button>` : ""}
       <button class="btn ghost" id="sq-alert">提醒</button>
       ${tracked ? "" : `<button class="btn primary" id="h-add">加入关注</button>`}
       <button class="btn ${tracked ? "primary" : "ghost"}" data-close>关闭</button>
     </div>`
  );
  bindStockTabs();
  const tagBtn = $("#sheet [data-sheet-tags]");
  if (tagBtn) tagBtn.onclick = () => openStockTags(code);
  mountDetailExtra(code, nm);
  const priBox = $("#sq-pri");
  if (priBox) bindPriChips(priBox, code);
  bindFundHoldBlock(code);
  loadFundProfile(code);
  loadFundNews(code);
  bindKline(code, false, "f1y");
  startSheetQuote(code);
  const addBtn = $("#h-add");
  if (addBtn) addBtn.onclick = async () => {
    if (addBtn.disabled) return;
    const now = trackedOf(code);
    if (now) { toast(now.bucket === "hold" ? "已在持仓" : "已在关注"); return; }
    addBtn.disabled = true;
    addBtn.textContent = "添加中…";
    try {
      await createWatch(code, nm);
      toast("已关注");
      closeSheet();
    } catch (e) {
      addBtn.disabled = false;
      addBtn.textContent = "加入关注";
      toast(e.message);
    }
  };
}

function openStock(code) {
  const s = state.board.stocks.find((x) => x.code === code);
  if (!s) return;
  if (isFundCode(code) || s.source === "fund_nav") return openFundSheet(code, s.name);
  const etf = isEtfCode(code);
  const glb = !etf && isGlobalCode(code);
  const mode = etf ? "etf" : glb ? "global" : "";
  openSheet(
    `${esc(s.name)} · ${s.code}`,
    `${stockTabsHtml(etf)}
     <div id="stock-tab-chart">
       <div class="sheet-quote"><span class="q" id="sq-price">${px(s.price)}</span>
         <span id="sq-pct" class="${cls(s.pct)}">${pctText(s.pct)}</span></div>
       ${qDetailHtml(mode)}
       <div class="kl-row" id="sq-kl"></div>
       ${glb ? "" : `<div class="wf-box" id="sq-wind"></div>
       <div class="pri-line" id="sq-pri"><span class="pri-label">优先级</span>${priChips(code, s.priority || "")}</div>`}
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
       <button class="btn ghost" data-sheet-tags="${code}">标签</button>
       <button class="btn ghost" id="sq-alert">提醒</button>
       <button class="btn primary" data-close>关闭</button>
     </div>`
  );
  bindStockTabs();
  mountDetailExtra(code, s.name || code);
  const tagBtn = $("#sheet [data-sheet-tags]");
  if (tagBtn) tagBtn.onclick = () => openStockTags(code);
  if ($("#sq-pri")) bindPriChips($("#sq-pri"), code);
  paintSheetQuote(s);
  if (!etf && !glb) loadWindFundamentals(code);
  loadStockFlags(code, s.name);
  if (etf) loadEtfHoldings(code, s.name).then(() => loadEtfOverlap(code, s.name));
  // loadProfile(code);   // 公司介绍已下线
  bindKline(code, !glb, defaultKPeriod());
  startSheetQuote(code);
}

/* ---------- 公司介绍（东财 F10：简介 / 主营业务 / 行业背景 / 核心竞争力） ---------- */
let profileSeq = 0;
const profileMemo = new Map();
