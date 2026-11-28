function ttsUseReady(seq, r) {
  if (seq !== dgTts.seq) return;
  if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
  const a = ttsAudio();
  dgTts.ready = true;
  dgTts.loading = false;
  dgTts.duration = Number(r.duration) || 0;
  ttsSetState("语音已准备好");
  a.playbackRate = dgTts.rate;
  a.src = ttsFileUrl(dgTts.day, dgTts.slot, dgTts.scope, r.key || "");
  a.load();
  ttsPaintTime();
  const p = a.play();
  if (p && p.catch) p.catch((err) => {
    if (seq !== dgTts.seq || (err && err.name === "AbortError")) return;
    if (err && err.name === "NotAllowedError") ttsSetState("点 ▶ 播放");
    else ttsSetState("播放失败，点 ▶ 重试");
  });
}

function currentDigestCard() {
  const day = dgTts.day || state.digestDay;
  const slot = dgTts.slot || state.digestSlot || "am";
  const d = (state.digests || []).find((x) => x.day === day && (x.slot || "am") === slot);
  return d || (day ? { day, slot } : null);
}

/* 打开总结后停 1.5 秒再预生成「重点」语音，避免翻日期时盲目起任务 */
function scheduleTtsPrewarm(d) {
  if (!d || !d.day) return;
  clearTimeout(dgTts.prewarmTimer);
  dgTts.prewarmTimer = setTimeout(() => ttsPrewarm(d), 1500);
}
async function ttsPrewarm(d) {
  if (!d || !d.day) return;
  const slot = d.slot || "am";
  const scope = ttsScopePref();
  const key = `${d.day}|${slot}|${scope}`;
  if (dgTts.prewarmed.has(key)) return;
  dgTts.prewarmed.add(key);
  const r = await api(ttsStatusPath(d.day, slot, scope)).catch(() => null);
  if (!r || r.ready || r.generating || r.error) return;
  await api("digest/tts", { method: "POST", body: { day: d.day, slot, scope }, idempotent: true })
    .catch(() => {});
}

function bindTtsPlayer() {
  const play = $("#dgp-play");
  if (play) play.onclick = () => ttsTogglePlay();
  const close = $("#dgp-close");
  if (close) close.onclick = () => ttsStop();
  const rate = $("#dgp-rate");
  if (rate) rate.onclick = () => {
    const i = TTS_RATES.indexOf(dgTts.rate);
    dgTts.rate = TTS_RATES[(i + 1) % TTS_RATES.length];
    try { localStorage.setItem("ttsRate", String(dgTts.rate)); } catch (e) { /* 忽略 */ }
    if (dgTts.audio) dgTts.audio.playbackRate = dgTts.rate;
    ttsPaintRate();
  };
  const seek = $("#dgp-seek");
  if (seek) {
    seek.addEventListener("pointerdown", () => { dgTts.dragging = true; });
    const end = () => { dgTts.dragging = false; ttsPaintTime(); };
    seek.addEventListener("pointerup", end);
    seek.addEventListener("pointercancel", end);
    seek.addEventListener("input", () => {
      const a = dgTts.audio;
      if (!a || !isFinite(a.duration)) return;
      a.currentTime = Math.max(0, Math.min(Number(seek.value) || 0, a.duration));
      ttsPaintTime();
    });
    seek.addEventListener("change", end);
  }
  $$("#dg-player [data-dgscope]").forEach((b) => {
    b.onclick = () => {
      const scope = b.dataset.dgscope === "full" ? "full" : "key";
      try { localStorage.setItem("ttsScope", scope); } catch (e) { /* 忽略 */ }
      ttsPaintScope(scope);
      if (dgTts.day && dgTts.scope === scope && (dgTts.ready || dgTts.loading)) return;
      const d = currentDigestCard();
      if (d) ttsLoad(d, scope, true);
    };
  });
  ttsPaintRate();
}
bindTtsPlayer();

/* 新闻页头部改成悬浮玻璃条后，列表要给出让位高度；头部随 tab/档位变化高度也会变 */
function fitDgHead() {
  const head = $("#dg-head"), box = $("#digest");
  if (!head || !box) return;
  const h = Math.round(head.getBoundingClientRect().height) || 0;
  box.style.setProperty("--dg-head-h", `${h + 16}px`);
}
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => fitDgHead());
  const head = $("#dg-head");
  if (head) ro.observe(head);
}

window.addEventListener("resize", fitDgHead);
window.addEventListener("orientationchange", () => setTimeout(fitDgHead, 120));
setTimeout(fitDgHead, 0);

function setDgTab(tab) {
  $$("#dg-tabs .chip").forEach((b) => b.classList.toggle("on", b.dataset.dgtab === tab));
  const slotBar = $("#dg-slots");
  if (slotBar && tab !== "digest") slotBar.classList.add("hidden");
  if (tab === "inbox") {
    inbox.tab = "unread";
    inbox.only = "all";          // 资讯 = 全量时间流（已读的就地淡化，不另开一页）
    inbox.page = 1;
    inbox.maxId = 0;
    renderLevels();
    loadInbox(1);
    return;
  }
  if (tab === "digest") {
    inbox.tab = "digest";
    renderPager();          // 总结页不要留着未读页的浮动分页
    renderLevels();
    const body = $("#dg-body");
    body.innerHTML = `<div class="empty">加载中…</div>`;
    loadDigests(true, true).then(renderDigestPanel).catch(renderDigestPanel);
    return;
  }
  loadInbox(inbox.page || 1);
}
function startInboxPoll() {
  stopInboxPoll();
  inbox.poll = setInterval(async () => {
    if ($("#digest").classList.contains("hidden") || document.hidden) return;
    const d = await api(`news/unread-count?max_id=${inbox.maxId || 0}`).catch(() => null);
    if (!d) return;
    paintUnreadCount(Number(d.unread_total || 0));
    if (inbox.tab === "unread") renderNewBar(Number(d.newer || 0));
  }, 45000);
}
function stopInboxPoll() {
  if (inbox.poll) { clearInterval(inbox.poll); inbox.poll = null; }
}
/* 新闻页和普通页签一样从顶栏下方开始：面板顶部对齐实际顶栏高度 */
function syncDigestTop() {
  const tb = document.querySelector(".topbar");
  if (tb) document.documentElement.style.setProperty("--topbar-h", `${tb.offsetHeight}px`);
}
/* 顶栏是 fixed 的：高度一变（旋屏、状态栏/地址栏收起、字号变化）就重写 --topbar-h，
   #main 的让位高度和新闻面板的起点都吃这个变量，顶栏图标才不会跳 */
function syncChrome() {
  syncDigestTop();
}
window.addEventListener("resize", () => {
  syncChrome();
  requestAnimationFrame(syncChrome);
});
window.addEventListener("orientationchange", () => setTimeout(syncChrome, 300));
if (window.visualViewport) window.visualViewport.addEventListener("resize", () => syncChrome());
if (document.readyState !== "complete") window.addEventListener("load", syncChrome);
/* 冷启动/登录慢时，上面那次 sync 读到的顶栏高度还是 0（#app 尚未显示），
   之后也没人再写，--topbar-h 就一直是 0，正文会顶到 fixed 顶栏底下。
   盯住顶栏自身尺寸，显示出来那一刻立刻补写。 */
if (window.ResizeObserver) {
  const tb = document.querySelector(".topbar");
  if (tb) new ResizeObserver(() => syncDigestTop()).observe(tb);
}
syncChrome();
setTimeout(syncChrome, 300);

/* 新闻面板和普通页面一样保留底部导航：打开时「新闻」选中，关掉后恢复原页签 */
function paintDigestNav(open) {
  $$(".tabbar button").forEach((b) => {
    b.classList.toggle("on", open ? b.id === "tab-news" : b.dataset.view === state.view);
  });
  if (typeof updateTabThumb === "function") updateTabThumb(true);
  // 新闻面板打开时日程/记录图标不高亮，标题也恢复成「打开」而不是「关闭」
  paintTopPageButtons();
}

/* 覆盖层（新闻/搜索/详情弹层）打开时锁住底层页面滚动：iOS 上必须用 body 固定 + 记录偏移，
   否则手势会把背后的列表滚走，而覆盖层里的内容不动。
   用 owner 集合计数，嵌套打开（新闻里再开个股详情）不会互相解锁。 */
const _pageLocks = new Set();
let _pageLockY = 0;
function lockPageScroll(on, owner = "page") {
  const b = document.body;
  const de = document.documentElement;
  if (on) {
    if (_pageLocks.size === 0) {
      _pageLockY = window.scrollY || window.pageYOffset || 0;
      b.style.top = `-${_pageLockY}px`;
      // body 一变成 fixed，html 的滚动高度就塌成视口高，window.scrollY 被夹回 0；
      // 如果这里不把滚动位置也归零，页面会被「再往上顶 scrollY 那么多」——
      // 顶栏胶囊被挤、分段条和筛选行叠在一起就是这么来的。
      try { window.scrollTo(0, 0); } catch (e) {}
    }
    _pageLocks.add(owner);
  } else {
    _pageLocks.delete(owner);
    if (_pageLocks.size === 0) {
      b.style.top = "";
      const y = _pageLockY;
      window.scrollTo(0, y);
      // 弹层关闭后会重绘列表，位置可能被重置：下一帧再补一次
      requestAnimationFrame(() => window.scrollTo(0, y));
      setTimeout(() => { if (_pageLocks.size === 0) window.scrollTo(0, y); }, 120);
    }
  }
  const locked = _pageLocks.size > 0;
  b.classList.toggle("scroll-lock", locked);
  de.classList.toggle("scroll-lock", locked);
}

async function openDigestPanel(at) {
  const box = $("#digest");
  if (!box) return;
  ttsStop();            // 每次打开总结都从干净状态开始
  syncDigestTop();
  box.classList.remove("hidden");
  document.body.classList.add("dg-open");
  lockPageScroll(true, "digest");
  paintDigestNav(true);
  inbox.maxId = 0;      // 每次打开都开一次新会话：边界取当前最新
  inbox.page = 1;
  inbox.level = "";     // 分类默认「全部」
  // 不指定日期时回到默认：最新一张（出了晚报在「晚」，只出了早报在「早」）
  state.digestDay = at && at.day ? at.day : "";
  state.digestSlot = at && (at.slot === "am" || at.slot === "pm") ? at.slot : "";
  setDgTab("digest");   // 用户要求：先显示总结，再是未读/已读
  // 标注单独拉一次：总结正文渲染时要用；从搜索/记录页跳过来时再把目标标注滚到眼前
  loadDigestMarks(true).then(() => {
    if (inbox.tab === "digest") renderDigestPanel();
    if (at && at.markId) focusDigestMark(at.markId);
  }).catch(() => {});
  // 总结页也先把未读角标刷新一次；轮询随后每 45 秒更新
  api("news/unread-count?max_id=0").then((d) => {
    if (d && typeof d.unread_total === "number") paintUnreadCount(d.unread_total);
  }).catch(() => {});
  startInboxPoll();
}
function closeDigestPanel() {
  const box = $("#digest");
  if (!box || box.classList.contains("hidden")) return;
  ttsStop();
  clearTimeout(dgTts.prewarmTimer);
  box.classList.add("hidden");
  document.body.classList.remove("dg-open");
  lockPageScroll(false, "digest");
  hideMarkbar();
  stopInboxPoll();
  paintDigestNav(false);
  if (state.view === "note" && state.noteKind === "mark") renderNotes();
}
$("#dg-close").addEventListener("click", () => closeDigestPanel());
$("#dg-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-dgtab]");
  if (b) setDgTab(b.dataset.dgtab);
});
$("#dg-levels").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-dglv]");
  if (!b) return;
  const lv = b.dataset.dglv || "";
  if (lv === inbox.level) return;
  inbox.level = lv;
  inbox.page = 1;
  $$("#dg-levels .chip").forEach((x) => x.classList.toggle("on", (x.dataset.dglv || "") === lv));
  loadInbox(1);
});
$("#dg-slots").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-dgslot]");
  if (!b || b.dataset.dgslot === state.digestSlot) return;
  state.digestSlot = b.dataset.dgslot;
  renderDigestPanel();
});
$("#dg-date").addEventListener("change", (e) => {
  const day = e.target.value;
  if (!day) return;
  state.digestDay = day;
  state.digestSlot = "pm";   // 用户要求：选了日期默认先看这一天「晚」
  renderDigestPanel();
});
/* 所有 .date-pick 共用：点外层标签弹原生选择器；原生 value 变化后同步「月-日」文字 */
document.addEventListener("click", (e) => {
  const pick = e.target.closest && e.target.closest(".date-pick");
  if (!pick) return;
  const inp = pick.querySelector(".date-pick-native");
  if (!inp) return;
  if (e.target === inp) return;   // 直接点到原生控件：交给系统自己弹，不要拦
  // 点到「月-日」文字或日历图标时主动唤起（iOS 上透明输入框已铺满整块，正常点也能触发）
  if (typeof inp.showPicker === "function") {
    try { inp.showPicker(); } catch (err) { inp.focus(); inp.click(); }
  }
});
document.addEventListener("change", (e) => {
  const inp = e.target;
  if (!inp || !inp.classList || !inp.classList.contains("date-pick-native")) return;
  const pick = inp.closest(".date-pick");
  const txt = pick && pick.querySelector(".date-pick-text");
  if (txt) txt.textContent = inp.value ? inp.value.slice(5) : "选日期";
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const pick = e.target.closest && e.target.closest(".date-pick");
  if (!pick || e.target !== pick) return;
  e.preventDefault();
  pick.click();
});
/* 面板里原来还有一个放大镜，和顶栏的搜索完全重复，已删；顶栏搜索在新闻面板上方时
   由 #app 的层级决定，压在新层面板上靠 openGlobalSearch() 的 above 逻辑 */

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !gsOpen() && !$("#digest").classList.contains("hidden")) closeDigestPanel();
});

/* ---- 标签条手势（持仓/自选顶部）：
   单击 = 筛选；双击 = 改标签名；长按 0.6 秒 = 进入排序模式（所有标签抖动，随便拖），
   拖完松手就存；点「完成」退出 ---- */
let tagPressAt = 0;
let tagTap = { bucket: "", tag: "", at: 0, timer: null };

function onTagChipClick(bucket, tag) {
  const now = Date.now();
  if (tag && tagTap.bucket === bucket && tagTap.tag === tag && now - tagTap.at < 320) {
    clearTimeout(tagTap.timer);
    tagTap = { bucket: "", tag: "", at: 0, timer: null };
    openTagRename(tag);                       // 双击 = 改名
    return;
  }
  tagTap = { bucket, tag, at: now, timer: null };
  if (state.tagSorting === bucket) return;     // 排序模式里单击不筛选
  // 等 200ms 再筛选：给第二击留识别时间，双击时列表不会先闪一下
  tagTap.timer = setTimeout(() => {
    if (tagTap.timer) tagTap.timer = null;
    state.tagFilter[bucket] = tag;
    renderBucket(bucket);
  }, 200);
}

function tagOrderFromDom(box) {
  // 只取标签本体（「全部」「更多」「完成」不算）；「未分类」固定最后
  return $$(".chip[data-tag]", box)
    .map((c) => c.dataset.tag)
    .filter((t) => t && t !== UNTAGGED);
}

function saveTagOrder(bucket, order, quiet) {
  const prev = state.tagOrder[bucket] || [];
  state.tagOrder[bucket] = order;
  return api("tags/order", { method: "POST", body: { bucket, order }, idempotent: true })
    .then(() => { if (!quiet) toast("标签顺序已保存"); })
    .catch((e) => { state.tagOrder[bucket] = prev; toast(e.message); });
}

function enterTagSort(bucket, box) {
  if (bucket !== "hold" && bucket !== "watch") return;
  if (state.tagSorting === bucket) return;
  if (state.tagSorting) exitTagSort(state.tagSorting, "", true);
  state.tagSorting = bucket;
  tagPressAt = Date.now();
  renderBucket(bucket);
  try { navigator.vibrate && navigator.vibrate(12); } catch (e) { /* 忽略 */ }
}

function exitTagSort(bucket, box, silent) {
  if (state.tagSorting !== bucket) return;
  const el = box || $(`#${bucket}-tags`);
  const order = el ? tagOrderFromDom(el) : state.tagOrder[bucket] || [];
  state.tagSorting = "";
  state.tagOrder[bucket] = order;
  tagPressAt = Date.now();
  renderBucket(bucket);
  saveTagOrder(bucket, order, silent);
}

function bindTagLongPress(box, bucket) {
  if (!box) return;
  const b = bucket || String(box.id || "").replace(/-tags$/, "");
  if (box.dataset.lpBound === "1") return;
  box.dataset.lpBound = "1";
  let timer = null;
  let start = null;
  let drag = null;
  const clearHold = () => { if (timer) { clearTimeout(timer); timer = null; } };

  box.addEventListener("touchstart", (e) => {
    const c = e.target.closest(".chip[data-tag]");
    if (!c) return;
    const t = e.touches[0];
    clearHold();
    start = { el: c, x: t.clientX, y: t.clientY, tag: c.dataset.tag || "" };
    if (!start.tag) return;                   // 「全部」「更多」不参与拖动/改名
    if (b !== "hold" && b !== "watch") {      // 记录页的标签条：长按仍然是改名
      timer = setTimeout(() => {
        timer = null;
        tagPressAt = Date.now();
        openTagRename(start.tag);
      }, 500);
      return;
    }
    if (state.tagSorting === b) {
      // 已经在排序模式：按下去就能拖任意一个标签
      drag = { el: c, x: start.x, y: start.y, moved: false };
      c.classList.add("dragging");
      tagPressAt = Date.now();
      return;
    }
    // 长按 0.6 秒进入排序模式：全部标签抖动，之后随便拖
    timer = setTimeout(() => {
      timer = null;
      enterTagSort(b, box);
    }, 600);
  }, { passive: true });

  // 非 passive：拖动时要挡掉页面滚动
  box.addEventListener("touchmove", (e) => {
    if (!drag) { clearHold(); return; }       // 长按前先划走 = 正常滚动
    const t = e.touches[0];
    if (e.cancelable) e.preventDefault();
    if (!drag.moved && Math.abs(t.clientX - drag.x) + Math.abs(t.clientY - drag.y) > 6) drag.moved = true;
    if (!drag.moved) return;
    const under = document.elementFromPoint(t.clientX, t.clientY);
    const over = under && under.closest ? under.closest(".chip[data-tag]") : null;
    if (over && over !== drag.el && over.dataset.tag && over.parentNode === drag.el.parentNode) {
      const rc = over.getBoundingClientRect();
      const after = t.clientX > rc.left + rc.width / 2;
      over.parentNode.insertBefore(drag.el, after ? over.nextSibling : over);
    }
  }, { passive: false });

  const end = () => {
    clearHold();
    if (!drag) return;
    const { el, moved } = drag;
    drag = null;
    el.classList.remove("dragging");
    if (moved) tagPressAt = Date.now();       // 拖完别让这一次点击再去筛选/改名
    if (b !== "hold" && b !== "watch") return;
    if (!moved) return;                       // 没拖动：什么都不存
    saveTagOrder(b, tagOrderFromDom(box), true);   // 每次松手都写后端，点「完成」再提示
  };
  box.addEventListener("touchend", end);
  box.addEventListener("touchcancel", end);
  box.addEventListener("contextmenu", (e) => {
    const c = e.target.closest(".chip[data-tag]");
    if (!c || !c.dataset.tag) return;
    e.preventDefault();
    // 安卓 WebView 长按会发 contextmenu：持仓/自选这条是「长按排序」，
    // 不能再借 contextmenu 弹改名框（改名已改为双击）。记录页标签条仍是长按改名。
    if (b === "hold" || b === "watch") return;
    tagPressAt = Date.now();
    openTagRename(c.dataset.tag);
  });
}

/* 标签管理：把标签从"只能新增/只能筛选"变成"能改名、能删除"的入口
   kind: "hold" / "watch"（个股自定义标签） 或 "notes"（记录里的标签） */
function tagCounts(kind) {
  const m = new Map();
  if (kind === "notes") {
    (state.notes || []).forEach((n) => (n.tags || []).forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return m;
  }
  const bucket = kind === "watch" ? "watch" : "hold";
  (state.board.stocks || []).filter((s) => s.bucket === bucket).forEach((s) => {
    customTagsOf(s).forEach((t) => m.set(t, (m.get(t) || 0) + 1));
  });
  return m;
}
function openTagManager(kind) {
  const isNote = kind === "notes";
  const counts = tagCounts(kind);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  const unit = isNote ? "条" : "只";
  const body = rows.length
    ? `<div class="wk-typelist">${rows.map(([t, n]) => `<div class="wk-typerow" data-tagrow="${esc(t)}">
        <span class="wk-tn">${esc(t)}</span><span class="wk-tc">${n} ${unit}</span><span class="wk-chev" aria-hidden="true">›</span>
      </div>`).join("")}</div>`
    : `<div class="wk-tip">还没有标签。标签在编辑${isNote ? "记录" : "个股"}时填，填过之后这里能改名和删除。</div>`;
  openSheet("标签", body);
  $$("#sheet [data-tagrow]").forEach((r) => {
    r.onclick = () => openTagRename(r.dataset.tagrow, kind);
  });
}

function openTagRename(old, kind) {
  kind = kind || (state.noteTag ? "notes" : "hold");
  const isNote = kind === "notes";
  const stockN = state.board.stocks.filter((s) => customTagsOf(s).includes(old)).length;
  const noteN = (state.notes || []).filter((n) => (n.tags || []).includes(old)).length;
  const asSub = anySheetOpen();
  const open = asSub ? openSubSheet : openSheet;
  const close = asSub ? closeSubSheet : closeSheet;
  const refresh = () => { if (asSub) openTagManager(kind); };
  open("编辑标签", `
    <div class="wk-form">
    <div class="field"><label for="tg-name">标签名</label><input id="tg-name" value="${esc(old)}" maxlength="20" placeholder="最多 20 个字"></div>
    <div class="wk-tip">改名会同步到所有${isNote ? "记录" : "个股"}。删除后，${isNote ? `${noteN} 条记录` : `${stockN} 只个股`}就不再带这个标签${isNote ? "" : "（会归到「未分类」）"}。</div>
    <div class="sheet-actions"><button class="btn primary" id="tg-save">保存</button><button class="btn danger" id="tg-del">删除标签</button></div>
    </div>`);
  const input = $("#tg-name");
  input.focus();
  input.setSelectionRange(String(input.value).length, String(input.value).length);
  $("#tg-save").onclick = async () => {
    const name = (input.value || "").trim();
    if (!name) return toast("标签名不能为空");
    if (name === old) { close(); refresh(); return; }
    try {
      const r = await api("tags/rename", { method: "POST", body: { old, new: name }, idempotent: true });
      close();
      toast(`已改名，${r.notes || 0} 条记录、${r.stocks || 0} 只个股`);
      if (state.noteTag === old) state.noteTag = name;
      // 改名后保留它在标签条里的位置（后端存的是名字）
      ["hold", "watch"].forEach((bk) => {
        const cur = state.tagOrder[bk] || [];
        const next = cur.map((x) => (x === old ? name : x));
        if (next.some((x, i) => x !== cur[i])) {
          state.tagOrder[bk] = next;
          api("tags/order", { method: "POST", body: { bucket: bk, order: next }, idempotent: true }).catch(() => {});
        }
      });
      await loadNotes();
      await loadBoard(true).catch(() => {});
      refresh();
    } catch (e) { toast(e.message || "改名失败"); }
  };
  const del = $("#tg-del");
  del.onclick = async () => {
    if (del.dataset.arm !== "1") {
      del.dataset.arm = "1";
      del.textContent = isNote ? `确认删除（${noteN} 条记录）？` : `确认删除（${stockN} 只个股）？`;
      setTimeout(() => { if (del.dataset.arm === "1") { del.dataset.arm = ""; del.textContent = "删除标签"; } }, 3000);
      return;
    }
    del.disabled = true; del.textContent = "删除中…";
    try {
      const r = await api("tags/rename", { method: "POST", body: { old, new: "" }, idempotent: true });
      close();
      toast(`已删除标签${r.stocks ? `，${r.stocks} 只个股归到「未分类」` : ""}${r.notes ? `，${r.notes} 条记录同步移除` : ""}`);
      ["hold", "watch"].forEach((bk) => {
        if (state.tagFilter[bk] === old) state.tagFilter[bk] = "";
        const cur = state.tagOrder[bk] || [];
        const next = cur.filter((x) => x !== old);
        if (next.length !== cur.length) {
          state.tagOrder[bk] = next;
          api("tags/order", { method: "POST", body: { bucket: bk, order: next }, idempotent: true }).catch(() => {});
        }
      });
      if (state.noteTag === old) state.noteTag = "";
      await loadNotes();
      await loadBoard(true).catch(() => {});
      refresh();
    } catch (e) {
      del.disabled = false; del.dataset.arm = ""; del.textContent = "删除标签";
      toast(e.message || "删除失败");
    }
  };
}

const STAGE_LABEL = { idea: "想法", plan: "计划", done: "已执行", review: "复盘" };
const STAGE_ORDER = ["idea", "plan", "done", "review"];

/* 记录四段：想法 → 计划 → 已执行 → 复盘。点卡片上的小胶囊选一段，直接落库 */
function openStagePicker(nid, cur) {
  const rows = STAGE_ORDER.map((k) => `<button type="button" class="more-row stage-opt" data-st="${k}">
      <span>${STAGE_LABEL[k]}</span>${k === cur ? '<span class="more-sub">当前</span>' : ""}</button>`).join("");
  openSheet("记录状态", `<div class="stage-pick">${rows}</div>`);
  $$("#sheet .stage-opt").forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.busy === "1") return;
      b.dataset.busy = "1";
      const st = b.dataset.st;
      try {
        await api(`notes/${nid}`, { method: "PATCH", body: { stage: st }, idempotent: true });
        const n = state.notes.find((x) => Number(x.id) === Number(nid));
        if (n) n.stage = st;
        closeSheet();
        renderNotes();
        toast(`已标为「${STAGE_LABEL[st]}」`);
      } catch (e) {
        b.dataset.busy = "";
        toast(e.message);
      }
    };
  });
}

const AUTO_TAGS = ["自动复盘", "自动异动", "自动批注", "自动要闻", "海外异动"];
const NEWS_CATS = ["市场", "行业", "综合", "战事", "宏观"];

function renderNotes() {
  renderNoteStockPicker();
  const _box = $("#notes");
  if (_box && !state.notesLoaded) {
    _box.innerHTML = `<div class="list-skel" aria-hidden="true"><i></i><i></i></div>`;
    return;
  }
  if (state.noteKind === "mark") { renderMarkNotes(); return; }
  const q = "";
  const from = state.noteFrom || "";
  const to = state.noteTo || "";
  const notes = state.notes.filter((n) => {
    const d = (n.created_at || "").slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (state.noteKind === "note" && !["idea", "note", "theme"].includes(n.kind)) return false;
    if (state.noteKind === "analysis" && n.kind !== "analysis") return false;
    if (state.noteKind === "news" && n.kind !== "news") return false;
    if (state.noteStage && (n.stage || "idea") !== state.noteStage) return false;
    if (state.noteTag && !(n.tags || []).includes(state.noteTag)) return false;
    if (q && !n.content.toLowerCase().includes(q)) return false;
    return true;
  });
  // 收藏的新闻进「笔记 · 新闻」：和新闻区的收藏夹合并到这里，可给每条写一段高亮笔记
  // 置顶的排最前；同为置顶按最近置顶/修改时间排（刚点的置顶在最上面）。
  // 注意：这里重排会覆盖 /notes 的 pinned DESC，别再把置顶冲掉。
  const items = notes.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) {
      const ua = a.updated_at || a.created_at || "";
      const ub = b.updated_at || b.created_at || "";
      return String(ub).localeCompare(String(ua)) || (Number(b.id || 0) - Number(a.id || 0));
    }
    const ta = a.created_at || "";
    const tb = b.created_at || "";
    return String(tb).localeCompare(String(ta)) || (Number(b.id || 0) - Number(a.id || 0));
  });
  const noteRows = items.map((n) => {
          const isAna = n.kind === "analysis";
          // 收盘后自动生成的复盘：本身就是分析结果，不要再套「未分析」的待办样式
          const autoTag = (n.tags || []).find((t) => AUTO_TAGS.includes(t));
          const isAuto = isAna && !!autoTag;
          const ans = (n.answer || "").trim();
          const done = !!ans || (n.tags || []).includes("已分析");
          const ansHtml = isAuto ? "" : isAna
            ? `<div class="ana-ans ${done ? "answered" : "pending"}">
                <div class="aa-t">${done ? `已分析${ans ? " · " + esc(String(n.answered_at || "").slice(5, 16)) : ""}` : "未分析 · 每晚复盘后自动分析"}</div>
                ${ans ? `<div class="aa-b">${esc(ans).replace(/\n/g, "<br>")}</div>` : ""}
              </div>`
            : "";
          const t = (n.tags || []).filter((x) => x !== "已分析" && x !== "自动复盘"
            && x !== autoTag && !NEWS_CATS.includes(x)).map((x) => `<span class="tag">${esc(x)}</span>`).join(" ");
          const stock = n.stock_code
            ? `<button type="button" class="chip stock-chip" data-open-stock="${esc(n.stock_code)}" title="${esc(stockNameOf(n.stock_code) || n.stock_code)}"><span class="sc-i">${esc(autoTag ? shortName(stockNameOf(n.stock_code) || n.stock_code) : (stockNameOf(n.stock_code) || n.stock_code))}</span></button>`
            : "";
          const memo = (n.memo || "").trim();
          return `<div class="item note selable ${n.pinned ? "pinned" : ""}${isAuto || autoTag ? " auto-note" : isAna ? (done ? " ana-done" : " ana-todo") : ""}" data-id="${n.id}">
            <div class="meta"><span class="badge ${n.kind}${isAuto || autoTag ? " done" : isAna ? (done ? " done" : " todo") : ""}">${isAuto || autoTag ? (autoTag === "自动要闻" ? "要闻" : autoTag === "海外异动" ? "海外" : "自动") : isAna ? (done ? "已分析" : "未分析") : (KIND_LABEL[n.kind] || "想法")}</span>
              <span>${esc(n.created_at.slice(5, 16))}</span>
              ${isAna || autoTag ? "" : `<button type="button" class="chip stage-chip" data-stage="${n.id}" data-cur="${esc(n.stage || "idea")}">${STAGE_LABEL[n.stage] || "想法"}</button>`}
              ${stock}${n.pinned ? '<span class="pin-glyph">置顶</span>' : ""}</div>
            <div class="body${isAuto || autoTag ? " auto-body" : " clamp"}">${esc(n.content)}</div>
            ${memo ? `<div class="news-memo">${esc(memo)}</div>` : ""}
            ${ansHtml}
            <div class="acts"><span>${t}</span>
              ${isAuto || autoTag ? "" : `<button data-act="pin" data-id="${n.id}" style="margin-left:auto">${n.pinned ? "取消置顶" : "置顶"}</button>`}
              <button data-act="edit" data-id="${n.id}" style="margin-left:auto">编辑</button>
              <button data-act="del" data-id="${n.id}">删除</button>
            </div>
          </div>`;
  });
  if (noteRows.length) chunkPaint($("#notes"), noteRows, { size: 20, bind: bindNoteCards });
  else {
    // 空白页要说清是「没触发」还是「坏了」：自动记录是异动触发的，不是定时刷的
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
    const autoToday = (state.notes || []).filter((n) => (n.tags || []).some((t) => String(t).startsWith("自动"))
      && String(n.created_at || "").slice(0, 10) === today);
    const pages = ["分析", "批注"].filter((p) => autoToday.some((n) => (p === "批注" ? n.kind === "mark" : n.kind === "analysis")));
    const autoHint = autoToday.length
      ? `今天已有 ${autoToday.length} 条自动记录${pages.length ? `（${pages.join("、")}页）` : ""}；同一标的同一天只留一条，行情再走也只会更新不会新刷`
      : "今天还没触发自动记录：盘中大盘与持仓没到异动线（指数 1.5%、个股/ETF 2.5%）；收盘 15:10 会写当日复盘";
    $("#notes").innerHTML = `<div class="empty-rich">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.6 2.6 0 0 0-3.7-3.7L4 16.4V20z"/><path d="M13.6 7.1l3.3 3.3"/></svg>
        <div class="er-t">${from ? `${from.slice(5)}${to && to !== from ? "~" + to.slice(5) : ""} 没有记录` : "还没有记录"}</div>
        <div class="er-d">在上面输入框写下想法，点「记录」即可</div>
        <div class="er-d" style="margin-top:6px">${esc(autoHint)}</div></div>`;
  }
  // 卡片绑定交给 chunkPaint 的分片回调（bindNoteCards），避免首屏+追加重复绑
}

$("#note-stage-filter") && $("#note-stage-filter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-st]");
  if (!b) return;
  state.noteStage = b.dataset.st || "";
  $$("#note-stage-filter button").forEach((x) => x.classList.toggle("on", (x.dataset.st || "") === state.noteStage));
  renderNotes();
});

function bindNoteCards(root, nodes) {
  const work = root || $("#notes");
  const scopes = nodes && nodes.length ? nodes : [work];
  scopes.forEach((sc) => {
    bindClamp(sc);
    bindNoteCardCopy(sc);
    bindOpenStock(sc);
     // 长按卡片 = 复制正文（批量选择改成长按上面的分段按钮）
  
    $$("[data-stage]", sc).forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        openStagePicker(Number(b.dataset.stage), b.dataset.cur || "idea");
      };
    });
    $$("[data-edit-saved]", sc).forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const n = (state.savedNews || []).find((x) => String(x.id) === b.dataset.editSaved);
        if (n) editSavedNews(n);
      };
    });
    $$("[data-drop-saved]", sc).forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.busy === "1") return;
        const id = b.dataset.dropSaved;
        b.dataset.busy = "1";
        b.disabled = true;
        b.textContent = "删除中…";
        try {
          await api(`news/${id}`, { method: "DELETE", idempotent: true });
          toast("已删除，可在回收站找回");
          forgetNews(id);
          state.savedNews = (state.savedNews || []).filter((x) => String(x.id) !== String(id));
          renderNotes();
          repaintLive();
          loadFeed(true).catch(() => {});
        } catch (err) {
          toast(err.message);
          b.dataset.busy = "0";
          b.disabled = false;
          b.textContent = "删除";
        }
      };
    });
    $$(".item:not(.saved-news) .acts button", sc).forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.dataset.id);
        const n = state.notes.find((x) => x.id === id);
        if (b.dataset.act === "del") {
          // 和个股一样：第一次点变「确认删除」，3.2 秒内再点才真删
          if (b.dataset.armed !== "1") {
            b.dataset.armed = "1";
            b.classList.add("armed");
            b.textContent = "确认删除";
            clearTimeout(Number(b.dataset.timer || 0));
            const timer = setTimeout(() => {
              if (!b.isConnected) return;
              b.dataset.armed = "0";
              b.classList.remove("armed");
              b.textContent = "删除";
            }, 3200);
            b.dataset.timer = String(timer);
            toast("再点一次「确认删除」");
            return;
          }
          b.dataset.armed = "0";
          clearTimeout(Number(b.dataset.timer || 0));
          b.classList.remove("armed");
          b.textContent = "删除中…";
          b.disabled = true;
          try {
            await api(`notes/${id}`, { method: "DELETE" });
            await loadNotes();
            loadBoard(true).catch(() => {});
            toast("已删除，可在回收站找回");
          } catch (err) {
            toast(err.message);
            b.textContent = "删除";
            b.disabled = false;
          }
        } else if (b.dataset.act === "pin") {
          await api(`notes/${id}`, { method: "PATCH", body: { pinned: n.pinned ? 0 : 1 } });
          await loadNotes();
        } else if (b.dataset.act === "link") {
          linkNoteStock(n);
        } else {
          editNote(n);
        }
      };
    });
  });
}

/* 记录页「批注」栏：把总结上的标红 / 下划线 / 批注汇总过来，可跳回原文 */
function digestBlockOrder(block) {
  if (block === "lead") return -1;
  const m = /^s(\d+)i(\d+)$/.exec(String(block || ""));
  return m ? Number(m[1]) * 1000 + Number(m[2]) : 999999;
}

function renderMarkNotes() {
  const from = state.noteFrom || "";
  const to = state.noteTo || "";
  const marks = (state.digestMarks || []).filter((m) => {
    const d = String(m.day || "");
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  const box = $("#notes");
  if (!box) return;
  const isAutoMark = (n) => (n.tags || []).some((t) => AUTO_TAGS.includes(t) || String(t).startsWith("自动"));
  // 系统自动写的批注（异动监控）也在这里露脸；只认带「自动」标签的，
  // 手写批注即使 kind=mark 也不能被套上「自动批注」的帽子
  const autoMarks = (state.notes || []).filter((n) => n.kind === "mark" && isAutoMark(n)).slice(0, 20);
  // 手动批注是「按天写的那条」，和总览/当天明细里的「批注」是同一批数据。
  // 以前这一栏只认总结里的标红/下划线，于是同一天的批注在明细里有、在记录页没有。
  const manualMarks = (state.notes || []).filter((n) => {
    if (n.kind !== "mark" || isAutoMark(n)) return false;
    const d = String(n.created_at || "").slice(0, 10) || String(n.day || "");
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 60);
  const manualHtml = manualMarks.map((n) => `<div class="item mark-card manual-mark" data-manual-id="${n.id}">
      <div class="meta"><span class="badge mk">批注</span>
        <span>${esc(String(n.created_at || "").slice(5, 16))}</span>
        <span class="mk-at">记于 ${esc(String(n.created_at || "").slice(5, 10))}</span></div>
      <div class="mk-entries"><div class="mk-entry"><div class="mk-note">${esc(n.content || "").replace(/\n/g, "<br>")}</div></div></div>
      <div class="mk-actions">
        <button type="button" class="mk-act edit" data-manual-edit="${n.id}">编辑</button>
      </div>
    </div>`).join("");
  const autoHtml = autoMarks.map((n) => `<div class="item mark-card auto-mark" data-auto-id="${n.id}">
      <div class="meta"><span class="badge mk">自动批注</span>
        <span>${esc(String(n.created_at || "").slice(5, 16))}</span></div>
      <div class="mk-entries"><div class="mk-entry"><div class="mk-note">${esc(n.content)}</div></div></div>
    </div>`).join("");
  if (!marks.length && !autoMarks.length && !manualMarks.length) {
    box.innerHTML = `<div class="empty-rich">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.6 2.6 0 0 0-3.7-3.7L4 16.4V20z"/><path d="M13.6 7.1l3.3 3.3"/></svg>
        <div class="er-t">还没有批注</div><div class="er-d">在新闻总结里选中文字，点「标红 / 下划线 / 批注」</div></div>`;
    return;
  }
  const label = (style) => style === "red" ? "标红" : style === "underline" ? "下划线" : "批注";
  // 同一个正文块里的多条标注合并成一张记录卡；库里仍保留每条的样式和位置，
  // 这样总结正文能分别渲染，记录页又不会一条一句地刷屏。
  const groups = new Map();
  marks.forEach((m) => {
    const key = `${m.day}|${m.slot || "am"}|${m.block}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  const cards = [...groups.values()].map((arr) => {
    arr.sort((a, b) => Number(a.start_off) - Number(b.start_off) || Number(a.id) - Number(b.id));
    const created = arr.reduce((s, m) => String(m.created_at || "") > s ? String(m.created_at || "") : s, "");
    return { arr, day: arr[0].day, slot: arr[0].slot || "am", block: arr[0].block, created };
  }).sort((a, b) => String(b.day).localeCompare(String(a.day))
    || String(b.slot).localeCompare(String(a.slot))
    || digestBlockOrder(a.block) - digestBlockOrder(b.block));
  box.innerHTML = manualHtml + autoHtml + cards.map(({ arr, day, slot, block, created }) => {
    const isGroup = arr.length > 1;
    const entries = arr.map((m) => {
      const note = String(m.note || "").trim();
      const st = m.style || "red";
      return `<div class="mk-entry" data-mark-id="${m.id}">
        <div class="mk-quote-row">
          <span class="mk-kind ${st}">${label(st)}</span>
          <span class="mk-qtext ${st}">“${esc(digestQuoteLabel(m.quote))}”</span>
          ${isGroup ? `<button type="button" class="mk-edit-one" data-edit-mark="${m.id}">编辑</button>` : ""}
        </div>
        ${note ? `<div class="mk-note">${esc(note)}</div>` : ""}
      </div>`;
    }).join("");
    return `<div class="item mark-card" data-mark-id="${arr[0].id}" data-block="${esc(block)}">
      <div class="meta"><span class="badge mk">${isGroup ? `同一段 · ${arr.length} 处` : label(arr[0].style)}</span>
        <span>${esc(String(day).slice(5))} ${esc(digestSlotLabel(slot))}</span>
        <span class="mk-at">记于 ${esc(String(created || "").slice(5, 16))}</span></div>
      <div class="mk-entries">${entries}</div>
      <div class="mk-actions">
        <button type="button" class="mk-act ghost" data-act="open-mark" data-id="${arr[0].id}">看原文</button>
        ${isGroup ? "" : `<button type="button" class="mk-act edit" data-act="edit-mark" data-id="${arr[0].id}">编辑</button>`}
      </div>
    </div>`;
  }).join("");
  $$("#notes .mark-card [data-act]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      if (b.dataset.act === "open-mark") openDigestAtMark(b.dataset.id);
      else openDigestMarkEditor(b.dataset.id);
    };
  });
  $$("#notes .mark-card [data-edit-mark]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      openDigestMarkEditor(b.dataset.editMark);
    };
  });
  // 手动批注直接复用「编辑记录」：改完 loadNotes 会重新渲染这一栏，不会和当天明细分叉
  $$("#notes .manual-mark [data-manual-edit]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const n = (state.notes || []).find((x) => Number(x.id) === Number(b.dataset.manualEdit));
      if (n) editNote(n);
    };
  });
}
/* 记录标题里的标的：括号定语去掉、超长截断，避免一行里名称换行把版式撑乱 */
function shortName(n) {
  let t = String(n || "");
  for (const [a, b] of [["（", "）"], ["(", ")"]]) {
    while (t.includes(a) && t.includes(b) && t.indexOf(b) > t.indexOf(a)) t = t.slice(0, t.indexOf(a)) + t.slice(t.indexOf(b) + 1);
  }
  for (const [junk, rep] of [["纳斯达克生物科技", "生科"], ["纳斯达克", "纳指"], ["生物科技", "生科"], ["标普500", "标普"], ["指数", ""], ["ETF联接", ""], ["联接", ""], ["基金", ""], ["人民币", ""], ["汇添富", ""], ["华安", ""], ["摩根", ""], ["南方", ""]]) t = t.split(junk).join(rep);
  t = t.trim().replace(/\d{0,3}[A-C]$/, "") || t.trim();   // 份额类别（100A / A / C）
  return t.length > 11 ? t.slice(0, 10) + "…" : t;
}

function stockNameOf(code) {
  const s = ((state.board && state.board.stocks) || []).find((x) => String(x.code) === String(code));
  return s ? s.name : "";
}

/* 收藏新闻：从 /news/saved 拉到笔记页的「新闻」；笔记就是 news.memo，用高亮色显示 */
async function refreshSavedNews() {
  const d = await api("news/saved?limit=500").catch(() => null);
  if (!d) return;
  state.savedNews = d.items || [];
  if (typeof d.count === "number") state.favCount = d.count;
  renderNotes();
}

/* 编辑收藏的新闻：和手动添加的新闻同一套字段（内容 / 备注 / 日期），
   外加收藏特有的「我的笔记」和「关联个股」；卡片上只保留「编辑 / 删除」两个按钮 */
function editSavedNews(n) {
  let picked = String(n.stock_code || "");
  const daySrc = String(n.published_at || n.day || n.created_at || "").slice(0, 10);
  openSheet("编辑新闻", `
    <div class="field"><label>内容</label>
      <textarea id="sn-title" rows="4" maxlength="2000">${esc(n.title || "")}</textarea></div>
    <div class="field"><label>我的笔记</label>
      <textarea id="sn-memo" rows="3" maxlength="2000" placeholder="写这段新闻对你的意义、对应哪只票、下一步看什么…">${esc(n.memo || "")}</textarea></div>
    <div class="field"><label>日期</label>
      ${datePickHtml("sn-day", daySrc, { full: true, label: "日期" })}</div>
    <div class="field"><label>关联个股（搜名称 / 代码）</label>${stockPickerHtml()}</div>
    <div class="sheet-actions"><button class="btn primary" id="sn-save">保存</button>
      <button class="btn ghost" data-close>取消</button></div>`);
  bindStockPicker($("#sheet-content"), picked, (code) => { picked = code; });
  $("#sn-save").onclick = async () => {
    const title = ($("#sn-title").value || "").trim();
    if (!title) return toast("内容不能为空");
    try {
      await api(`news/${n.id}`, { method: "PATCH", body: {
        title,
        memo: $("#sn-memo").value.trim(),
        day: $("#sn-day").value || n.day,
        stock_code: picked,
      } });
      closeSheet();
      toast("已保存");
      await refreshSavedNews().catch(() => {});
      renderNotes();
      repaintLive();
    } catch (e) { toast(e.message); }
  };
}

/* 关联个股的候选：只有持仓 + 关注（stocks 表就是唯一真相） */
function trackedStocks() {
  const all = (state.board && state.board.stocks) || [];
  return all.slice().sort((a, b) => (a.bucket === b.bucket ? 0 : a.bucket === "hold" ? -1 : 1));
}


function stockPickerHtml() {
  // 只有搜索框：不打标签墙、不预加载股票列表，输入才出结果
  return `<div class="sp-panel">
    <div class="sp-search"><input type="search" data-sp-search placeholder="搜索名称 / 代码" autocomplete="off" enterkeyhint="search"></div>
    <div class="sp-list" data-sp-list></div>
  </div>`;
}

function bindStockPicker(root, cur, onPick) {
  if (!root) return;
  const listBox = $("[data-sp-list]", root);
  const input = $("[data-sp-search]", root);
  if (!listBox || !input) return;
  let selected = String(cur || "");
  let q = "";
  let rows = [];
  let seq = 0;
  let timer = null;
  const tracked = () => {
    const m = new Map();
    (trackedStocks() || []).forEach((s) => m.set(String(s.code), s.bucket));
    return m;
  };

  const paint = () => {
    const known = tracked();
    // 「清除关联」是一条动作行，不是选中项：不标 ✓、不加 .on，否则会和已选个股同时高亮
    const clearRow = selected
      ? `<div class="sp-row clear" data-sp-code=""><div class="l"><div class="nm">清除关联</div>
           <div class="cd">当前：${esc(stockNameOf(selected) || selected)}</div></div><span class="sp-clear">✕</span></div>`
      : "";
    if (!q) {
      listBox.innerHTML = clearRow + `<div class="empty">${selected ? "搜索可更换关联个股" : "输入名称或代码搜索"}</div>`;
    } else {
      listBox.innerHTML = clearRow + (rows.length
        ? rows.map((s) => {
            const b = s.tracked || known.get(String(s.code));
            return `<div class="sp-row ${String(selected) === String(s.code) ? "on" : ""}" data-sp-code="${esc(s.code)}">
              <div class="l"><div class="nm">${esc(s.name)}${mktBadge(s.code)}</div>
                <div class="cd">${esc(s.code)}${b ? (b === "hold" ? " · 持仓" : " · 关注") : ""}${s.price ? " · " + s.price : ""}${s.pct != null ? " " + (s.pct > 0 ? "+" : "") + s.pct + "%" : ""}</div></div>
              <span class="sp-check">✓</span></div>`;
          }).join("")
        : `<div class="empty">没搜到</div>`);
    }
    $$("[data-sp-code]", listBox).forEach((row) => {
      row.onclick = () => {
        selected = row.dataset.spCode || "";
        paint();
        if (onPick) onPick(selected);
      };
    });
  };

  const run = async () => {
    const my = ++seq;
    if (!q) { rows = []; paint(); return; }
    try {
      const d = await api(`global-search?q=${encodeURIComponent(q)}&limit=10`, { idempotent: true });
      if (my !== seq) return;
      rows = (d.stocks || []).map((s) => ({ code: s.code, name: s.name, price: s.price, pct: s.pct, tracked: s.tracked }));
      paint();
    } catch (e) { /* 网络抖动就保持上一次结果 */ }
  };

  input.addEventListener("input", () => {
    q = input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(run, 260);
  });
  paint();
}

/* 笔记卡片上的「关联个股」：改完立刻同步个股消息（note flag，已读不标红） */
function linkNoteStock(n) {
  let picked = String(n.stock_code || "");
  openSheet("关联个股",
    `<div class="tiny muted" style="margin:-4px 2px 8px">当前关联：${picked ? esc(stockNameOf(picked) || picked) : "不关联"}</div>
     ${stockPickerHtml()}
     <div class="tiny muted" style="margin:8px 2px">关联后这只股的「相关消息」里会出现这条笔记，但不标红、不计入未读数。</div>
     <div class="sheet-actions"><button class="btn primary" id="link-save">保存</button>
       <button class="btn ghost" data-close>取消</button></div>`);
  bindStockPicker($("#sheet-content"), picked, (code) => {
    picked = code;
    const tip = $("#sheet-content .tiny.muted");
    if (tip) tip.textContent = `当前关联：${code ? (stockNameOf(code) || code) : "不关联"} · 按个股自定义标签筛选`;
  });
  $("#link-save").onclick = async () => {
    try {
      await api(`notes/${n.id}`, { method: "PATCH", body: { stock_code: picked } });
      closeSheet();
      await loadNotes();
      loadBoard(true).catch(() => {});
      toast(picked ? `已关联 ${stockNameOf(picked) || picked}` : "已取消关联");
    } catch (e) { toast(e.message); }
  };
}

/* 输入框上方的关联选择条：显示当前选择，点开按标签筛股 */
function renderNoteStockPicker() {
  const box = $("#note-stock-picker");
  if (!box) return;
  const list = trackedStocks();
  if (!list.length) {
    box.innerHTML = `<button type="button" class="pick-box stock-pick-btn" id="note-stock-btn" title="持仓/关注为空"><span class="pick-txt muted">＋ 个股</span></button>`;
    $("#note-stock-btn").onclick = () => toast("持仓 / 关注为空，先去加股票");
    return;
  }
  if (state.noteStock && !list.some((s) => String(s.code) === String(state.noteStock))) state.noteStock = "";
  const cur = list.find((s) => String(s.code) === String(state.noteStock));
  box.innerHTML = `<button type="button" class="pick-box stock-pick-btn" id="note-stock-btn" title="关联个股（搜名称 / 代码）">
    <span class="pick-txt">${cur ? `🔗 ${esc(cur.name)}${mktBadge(cur.code)}` : "＋ 个股"}</span></button>`;
  $("#note-stock-btn").onclick = () => {
    openSheet("选择关联个股",
      `${stockPickerHtml()}
       <div class="sheet-actions"><button class="btn ghost" data-close>取消</button></div>`);
    bindStockPicker($("#sheet-content"), state.noteStock, (code) => {
      state.noteStock = code;
      renderNoteStockPicker();
      closeSheet();
      toast(code ? `已选择 ${stockNameOf(code) || code}` : "已清除关联");
    });
  };
}

/* 编辑里的「类型」：只做新闻 / 记录两个标签；老数据里的分析等类型保留一个自身的标签，
   不点就不改，避免编辑一次就把分析条目变成记录 */
const NOTE_KIND_TAGS = [["news", "新闻"], ["note", "记录"]];
function noteKindChipHtml(cur) {
  const extra = NOTE_KIND_TAGS.some(([k]) => k === cur) || !cur
    ? []
    : [[cur, KIND_LABEL[cur] || "记录"]];
  return [...NOTE_KIND_TAGS, ...extra]
    .map(([k, v]) => `<button type="button" class="chip${k === cur ? " on" : ""}" data-k="${k}">${v}</button>`)
    .join("");
}

function editNote(n, onDone) {
  let picked = String(n.stock_code || "");
  let kind = n.kind || "note";
  openSheet(
    "编辑记录",
    `<div class="field"><label>内容</label><textarea id="e-text" rows="6">${esc(n.content)}</textarea></div>
     <div class="field"><label>我的笔记（卡片上橙色高亮）</label><textarea id="e-memo" rows="2" maxlength="2000">${esc(n.memo || "")}</textarea></div>
     <div class="field"><label>类型</label>
       <div id="e-kinds" class="chips kind-picks">${noteKindChipHtml(n.kind)}</div></div>
     <div class="field"><label>关联个股（搜名称 / 代码）</label>${stockPickerHtml()}</div>
     <div class="field"><label>标签（逗号分隔）</label><input id="e-tags" value="${esc((n.tags || []).join(","))}"></div>
     <div class="sheet-actions"><button class="btn primary" id="e-save">保存</button></div>`
  );
  bindStockPicker($("#sheet-content"), picked, (code) => { picked = code; });
  $$("#e-kinds .chip").forEach((c) => {
    c.onclick = () => {
      kind = c.dataset.k || "note";
      $$("#e-kinds .chip").forEach((x) => x.classList.toggle("on", x === c));
    };
  });
  $("#e-save").onclick = async () => {
    await api(`notes/${n.id}`, {
      method: "PATCH",
      body: {
        content: $("#e-text").value,
        memo: $("#e-memo").value.trim(),
        kind,
        stock_code: picked,
        tags: $("#e-tags").value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
      },
    });
    closeSheet();
    await loadNotes();
    loadBoard(true).catch(() => {});
    if (typeof onDone === "function") onDone();
  };
}
/* 输入框默认一行高，随输入自动长高（最多约 5 行），提交/清空后收回 */
function autoGrowNote() {
  const el = $("#note-text");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
}

/* ---------- 记录输入区：边写边认 ----------
   类型 / 个股 / 标签以前三处都要手动选。现在在输入框下面挂一行识别结果（复用 .chips + .chip），
   写着写着就把 #标签、提到的个股、能一眼看出的类型标出来，点一下就取消；
   「整理」再交给后端 AI 把口语理顺（内容写回输入框，仍可改）。 */
const NOTE_STAGES = ["idea", "plan", "done", "review"];
const NOTE_STAGE_LABEL = { idea: "想法", plan: "计划", done: "已执行", review: "复盘" };
const noteDraft = { stage: "idea", stageTouched: false, tags: [], autoStock: false };
let noteScanTimer = 0;

function renderNoteChips() {
  const box = $("#note-chips");
  if (!box) return;
  const code = String(state.noteStock || "");
  const out = [];
  if (code) out.push(`<button type="button" class="chip" data-nc="stock">${esc(stockNameOf(code) || code)} ×</button>`);
  noteDraft.tags.forEach((t) =>
    out.push(`<button type="button" class="chip" data-nc="tag" data-v="${esc(t)}">#${esc(t)} ×</button>`));
  if (noteDraft.stage !== "idea" || noteDraft.stageTouched)
    out.unshift(`<button type="button" class="chip st" data-nc="stage">${NOTE_STAGE_LABEL[noteDraft.stage]}</button>`);
  box.innerHTML = out.join("");
  box.hidden = !out.length;
  $$("#note-chips [data-nc]").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.nc;
      if (k === "stage") {
        noteDraft.stageTouched = true;
        noteDraft.stage = NOTE_STAGES[(NOTE_STAGES.indexOf(noteDraft.stage) + 1) % NOTE_STAGES.length];
      } else if (k === "stock") {
        state.noteStock = "";
        noteDraft.autoStock = false;
        renderNoteStockPicker();
      } else {
        noteDraft.tags = noteDraft.tags.filter((x) => x !== b.dataset.v);
      }
      renderNoteChips();
    };
  });
}

/* 本地识别：只认确定的信号——手写 #标签、持仓/关注里出现的名字或代码、一眼能看出的类型词；判不了就不猜 */
function noteScan(text) {
  const out = { tags: [], stock: "", stage: "" };
  (text.match(/#[\u4e00-\u9fa5A-Za-z0-9_]+/g) || []).forEach((m) => {
    const t = m.slice(1);
    if (t && !out.tags.includes(t)) out.tags.push(t);
  });
  const list = (typeof trackedStocks === "function" ? trackedStocks() : []) || [];
  let hit = null;
  list.forEach((st) => {
    const n = String(st.name || "").replace(/\s/g, "");
    if (n.length >= 2 && text.includes(n) && (!hit || n.length > String(hit.name || "").length)) hit = st;
  });
  if (!hit) {
    const m = text.match(/\b(\d{6})\b/);
    if (m) hit = list.find((x) => String(x.code) === m[1]) || { code: m[1], name: m[1] };
  }
  if (hit) out.stock = String(hit.code);
  if (/复盘|总结|事后|回顾/.test(text)) out.stage = "review";
  else if (/已完成|做完了|做完|搞定了|已执行|交了|发出|提交了/.test(text)) out.stage = "done";
  else if (/计划|打算|明天|下周|本周|要做|待办|准备|安排|跟进|记得/.test(text)) out.stage = "plan";
  return out;
}

function noteScanApply() {
  const text = ($("#note-text").value || "").trim();
  if (!text) {
    Object.assign(noteDraft, { stage: "idea", stageTouched: false, tags: [], autoStock: false });
    state.noteStock = "";
    renderNoteStockPicker();
    renderNoteChips();
    return;
  }
  const sc = noteScan(text);
  sc.tags.forEach((t) => {
    if (!noteDraft.tags.includes(t)) noteDraft.tags.push(t);
  });
  if (!noteDraft.stageTouched && sc.stage) noteDraft.stage = sc.stage;
  if (sc.stock) {
    if (!state.noteStock || noteDraft.autoStock) {
      state.noteStock = sc.stock;
      noteDraft.autoStock = true;
      renderNoteStockPicker();
    }
  } else if (noteDraft.autoStock) {
    state.noteStock = "";
    noteDraft.autoStock = false;
    renderNoteStockPicker();
  }
  renderNoteChips();
}

$("#note-text").addEventListener("input", () => {
  autoGrowNote();
  clearTimeout(noteScanTimer);
  noteScanTimer = setTimeout(noteScanApply, 350);
});

/* 整理：把口语理顺、给出类型与标签，正文写回输入框（可继续改） */
$("#note-ai-btn").addEventListener("click", async () => {
  const el = $("#note-text");
  const btn = $("#note-ai-btn");
  const text = (el.value || "").trim();
  if (!text) return toast("先写点什么");
  if (btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";
  btn.classList.add("busy");
  const old = btn.innerHTML;
  btn.textContent = "…";
  try {
    const d = await api("ai/note", { method: "POST", noRetry: true, body: { text } }, 30000);
    el.value = d.content || text;
    autoGrowNote();
    noteDraft.stage = d.stage || "idea";
    noteDraft.stageTouched = true;
    noteDraft.tags = (d.tags || []).slice(0, 5);
    if (d.stock_code) {
      state.noteStock = d.stock_code;
      noteDraft.autoStock = false;
      renderNoteStockPicker();
    }
    renderNoteChips();
    toast("已整理，可以再改");
  } catch (e) {
    toast(e.message || "整理失败");
  } finally {
    btn.dataset.busy = "0";
    btn.classList.remove("busy");
    btn.innerHTML = old;
  }
});

/* ＋：标签与个股都收进这一个入口，复用既有的 stockPickerHtml + bindStockPicker */
$("#note-more-btn").addEventListener("click", () => {
  openSheet("标签与个股", `
    <div class="field"><label>标签（逗号分隔）</label>
      <input id="nt-tags" value="${esc(noteDraft.tags.join("，"))}" placeholder="港股，半导体"></div>
    <div class="field"><label>关联个股（搜名称 / 代码）</label>${stockPickerHtml()}</div>
    <div class="sheet-actions"><button class="btn primary" id="nt-ok">确定</button></div>`);
  let code = String(state.noteStock || "");
  bindStockPicker($("#sheet-content"), code, (c) => { code = c; });
  $("#nt-ok").onclick = () => {
    noteDraft.tags = ($("#nt-tags").value || "").split(/[,，]/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean).slice(0, 6);
    state.noteStock = code || "";
    noteDraft.autoStock = false;
    renderNoteChips();
    closeSheet();
  };
});

$("#note-submit").addEventListener("click", async () => {
  const content = $("#note-text").value.trim();
  if (!content) return toast("先写点什么");
  const tags = noteDraft.tags.slice(0, 6);
  try {
    await api("notes", {
      method: "POST",
      body: { content, kind: "note", stage: noteDraft.stage, stock_code: String(state.noteStock || ""), tags },
    });
    $("#note-text").value = "";
    autoGrowNote();
    Object.assign(noteDraft, { stage: "idea", stageTouched: false, tags: [], autoStock: false });
    state.noteStock = "";
    renderNoteStockPicker();
    renderNoteChips();
    toast("已记录");
    await loadNotes();
    loadBoard(true).catch(() => {});
  } catch (e) { toast(e.message); }
});

/* ---------- 关注按钮（趋势选股 / 标签选股 / 搜索共用） ---------- */
/* 关注按钮：趋势选股 / 标签选股 / 搜索 共用同一套渲染与点击逻辑
   未关注 → +关注；已关注 → 点一下变「确认取关」，再点一下才真正取关；
   已持仓 → 只显示状态（取关要去持仓页先移出）。 */
function trackedOf(code) {
  return ((state.board && state.board.stocks) || []).find((s) => s.code === code) || null;
}
/* 已加载重合度且重合高：第一次点只提醒，再点才真正加入 */
function overlapNeedsConfirm(btn, code) {
  const ov = state.etfOverlap && state.etfOverlap[code];
  if (!ov || ov.ok === false || ov.level !== "high" || btn.dataset.ovWarned === "1") return false;
  btn.dataset.ovWarned = "1";
  const old = btn.textContent;
  btn.textContent = `重合约${Math.round(Number(ov.score) || 0)}%，再点确认`;
  clearTimeout(Number(btn.dataset.ovTimer || 0));
  const timer = setTimeout(() => {
    if (!btn.isConnected) return;
    btn.dataset.ovWarned = "0";
    btn.textContent = old;
  }, 3500);
  btn.dataset.ovTimer = String(timer);
  return true;
}
function followLabel(t) {
  return t ? (t.bucket === "hold" ? "已持仓" : "已关注") : "+关注";
}
function followBtn(code) {
  const t = trackedOf(code);
  const hold = t && t.bucket === "hold";
  const cls = t ? (hold ? " done" : " done off") : "";
  return `<button class="act${cls}" data-follow="${code}"${hold ? " disabled" : ""}>${followLabel(t)}</button>`;
}
let followArmed = "";
let followArmedTimer = null;
function clearFollowArmed() {
  if (followArmedTimer) clearTimeout(followArmedTimer);
  followArmed = "";
  followArmedTimer = null;
}
function applyFollowBtn(b) {
  const t = trackedOf(b.dataset.follow);
  const hold = t && t.bucket === "hold";
  const armed = !!t && !hold && followArmed === b.dataset.follow;
  b.textContent = armed ? "确认取关" : followLabel(t);
  b.disabled = !!hold;
  b.classList.toggle("done", !!t);
  b.classList.toggle("off", !!t && !hold);
  b.classList.toggle("armed", armed);
}
/* 已关注状态在所有列表里同步（板块刷新、切换标签后都不丢） */
function syncFollowButtons() {
  $$("[data-follow]").forEach((b) => {
    if (b.dataset.busy === "1") return;
    applyFollowBtn(b);
  });
}
/* 搜索/趋势选股/标签选股共用的加关注：带名称走 fast 路径，接口先返回、标签后台补 */
async function createWatch(code, name) {
  await api("stocks", {
    method: "POST",
    body: { code, name: (name || "").trim() || code, bucket: "watch", tags: [], fast: true },
    idempotent: true,
  });
  // 先在本地落地，界面立刻变「已关注」，不等行情接口
  if (state.board) {
    state.board.stocks.push({ code, name: (name || "").trim() || code, bucket: "watch", tags: [], custom_tags: [], price: null, pct: null });
    state.board.watch_count = (state.board.watch_count || 0) + 1;
    const wc = $("#watch-count");
    if (wc) wc.textContent = state.board.watch_count;
  }
  syncFollowButtons();
  loadBoard(true).catch(() => {});
}
async function followStock(btn, name) {
  const code = btn.dataset.follow;
  const t = trackedOf(code);
  if (btn.dataset.busy === "1") return;
  if (t) {
    if (t.bucket === "hold") { toast("已在持仓，请到持仓页移出"); return; }
    // 第一次点「已关注」= 待确认，3 秒内再点才是真取关
    if (followArmed !== code) {
      clearFollowArmed();
      followArmed = code;
      followArmedTimer = setTimeout(() => {
        clearFollowArmed();
        syncFollowButtons();
      }, 3200);
      syncFollowButtons();
      toast("再点一次「确认取关」");
      return;
    }
    clearFollowArmed();
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add("busy");
    btn.textContent = "取消中…";
    try {
      await api(`stocks/${code}`, { method: "DELETE" });
      if (state.board) {
        state.board.stocks = state.board.stocks.filter((s) => s.code !== code);
        state.board.watch_count = Math.max(0, (state.board.watch_count || 0) - 1);
        const wc = $("#watch-count");
        if (wc) wc.textContent = state.board.watch_count;
      }
      delete btn.dataset.busy;
      btn.classList.remove("busy");
      syncFollowButtons();
      toast("已取消关注，可在回收站找回");
      loadBoard(true).catch(() => {});
    } catch (e) {
      delete btn.dataset.busy;
      btn.classList.remove("busy");
      syncFollowButtons();
      toast(e.message);
    }
    return;
  }
  if (overlapNeedsConfirm(btn, code)) return;
  clearFollowArmed();
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.classList.add("busy");
  btn.textContent = "添加中…";
  try {
    await createWatch(code, name);
    delete btn.dataset.busy;
    btn.classList.remove("busy");
    syncFollowButtons();
    toast("已关注");
  } catch (e) {
    delete btn.dataset.busy;
    btn.classList.remove("busy");
    syncFollowButtons();
    toast(e.message);
  }
}
/* 统一委托：任何列表里的关注按钮都走这里 */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-follow]");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const row = b.closest(".heat-row");
  followStock(b, row ? row.dataset.name : "");
});

/* ---------- 持仓按钮（全局搜索用）：逻辑照抄关注按钮 ---------- */
function holdLabel(t) {
  return t ? (t.bucket === "hold" ? "已持仓" : "转持仓") : "+持仓";
}
function holdBtn(code) {
  const t = trackedOf(code);
  const cls = t ? (t.bucket === "hold" ? " done" : "") : "";
  return `<button class="act${cls}" data-hold="${code}"${t && t.bucket === "hold" ? " disabled" : ""}>${holdLabel(t)}</button>`;
}
function applyHoldBtn(b) {
  const t = trackedOf(b.dataset.hold);
  const hold = t && t.bucket === "hold";
  b.textContent = holdLabel(t);
  b.disabled = !!hold;
  b.classList.toggle("done", !!t);
}
function syncHoldButtons() {
  $$("[data-hold]").forEach((b) => {
    if (b.dataset.busy === "1") return;
    applyHoldBtn(b);
  });
}
async function holdStock(btn, name) {
  const code = btn.dataset.hold;
  const t = trackedOf(code);
  if (btn.dataset.busy === "1") return;
  if (t && t.bucket === "hold") { toast("已在持仓"); return; }
  if (overlapNeedsConfirm(btn, code)) return;
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = "添加中…";
  try {
    if (t) {
      await api(`stocks/${code}/bucket`, { method: "POST", body: { bucket: "hold" }, idempotent: true });
      t.bucket = "hold";
      if (state.board) {
        state.board.hold_count = (state.board.hold_count || 0) + 1;
        state.board.watch_count = Math.max(0, (state.board.watch_count || 0) - 1);
      }
      toast("已转入持仓");
    } else {
      await api("stocks", {
        method: "POST",
        body: { code, name: (name || "").trim() || code, bucket: "hold", tags: [], fast: true },
        idempotent: true,
      });
      if (state.board) {
        state.board.stocks.push({ code, name: (name || "").trim() || code, bucket: "hold", tags: [], custom_tags: [], price: null, pct: null });
        state.board.hold_count = (state.board.hold_count || 0) + 1;
      }
      toast("已加入持仓");
    }
    delete btn.dataset.busy;
    btn.classList.remove("busy");
    syncFollowButtons();
    syncHoldButtons();
    loadBoard(true).catch(() => {});
  } catch (e) {
    delete btn.dataset.busy;
    btn.classList.remove("busy");
    syncHoldButtons();
    toast(e.message);
  }
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-hold]");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const row = b.closest(".heat-row");
  holdStock(b, row ? row.dataset.name : "");
});

function setWatchTab(tab) {
  state.watchTab = tab;
  $$("#watch-seg button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#watch-mine").classList.toggle("hidden", tab !== "mine");
  const heat = $("#watch-heat");   // 热度榜已下线，节点不在页面上
  if (heat) heat.classList.toggle("hidden", tab !== "heat");
  const trend = $("#watch-trend");
  if (trend) trend.classList.toggle("hidden", tab !== "trend");
  const tp = $("#watch-tagpick");
  if (tp) tp.classList.toggle("hidden", tab !== "tag");   // 标签选股已注销，节点不在页面上
  if (tab === "trend") loadTrend(false, state.trendDate);
  // else if (tab === "heat") loadHeat();   // 热度榜已下线
  else if (tab === "tag") loadTagPick();
  else loadBoard().catch(() => {});
}

$("#watch-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const same = state.watchTab === b.dataset.tab;
  setWatchTab(b.dataset.tab);
  if (same) refreshPane(b.dataset.tab === "trend" ? "trend"
    : b.dataset.tab === "heat" ? "heat" : b.dataset.tab === "tag" ? "tag" : "watch");
});

/* 热度榜已下线（代码保留，取消注释即可恢复）：
$("#heat-src").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.src === state.heatSrc) return refreshPane("heat");
  $$("#heat-src button").forEach((x) => x.classList.toggle("on", x === b));
  loadHeat(b.dataset.src);
});

async function loadHeat(src = state.heatSrc, force) {
  const prevSrc = state._heatSrcRendered;
  state.heatSrc = src;
  const hit = !force && memoFresh("heat:" + src, liveTtl(60000));
  const note = $("#heat-note"), list = $("#heat-list");
  if (hit) {
    // 这份数据已经画在页面上就原样留着；换过源或被清空才重画，绝不重新请求
    if (state.heat !== hit || prevSrc !== src || !list.children.length) renderHeat(hit);
    return;
  }
  // 已经有当前源的榜单就保留旧内容，只提示"刷新中"，不清空
  const sameSrcData = !!(state.heat && prevSrc === src && list.children.length);
  if (sameSrcData) note.textContent = "刷新中…";
  else { note.textContent = "加载中…"; list.innerHTML = ""; }
  try {
    const d = await api(`heat?src=${src}&limit=50`, {}, 20000);
    memoSet("heat:" + src, d);
    renderHeat(d);
  } catch (e) {
    if (sameSrcData) note.textContent = "刷新失败，仍是上次的数据";
    else {
      note.textContent = "";
      list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }
}

function renderHeat(d) {
  state.heat = d;
  state._heatSrcRendered = state.heatSrc;
  const prevNote = (d.items || []).some((x) => x.pct_note) ? " · 盘前：涨幅为上一交易日" : "";
  $("#heat-note").textContent = `${d.name} · 更新 ${d.updated_at || ""}${d.note && d.items && d.items.length ? " · " + d.note : ""}${prevNote}`;
  if (!d.items || !d.items.length) {
    $("#heat-list").innerHTML = `<div class="empty">${esc(d.note || d.error || "暂无数据")}</div>`;
    return;
  }
  $("#heat-list").innerHTML = d.items
    .map((x) => `<div class="heat-row" data-code="${x.code}" data-name="${esc(x.name)}">
      <div class="rk">${x.rank}</div>
      <div class="l"><div class="nm">${esc(x.name) || x.code}</div>
        <div class="cd">${x.code}${mktBadge(x.code)}${x.tag ? " · " + esc(x.tag) : ""}</div></div>
      <div class="mid"><div class="${cls(x.pct)}">${x.pct_note ? `<span class="pct-note">${esc(x.pct_note)}</span>` : ""}${pctText(x.pct)}</div></div>
      ${followBtn(x.code)}
    </div>`)
    .join("");
  $$("#heat-list .heat-row").forEach((r) => {
    r.onclick = (e) => {
      if (e.target.closest("[data-follow]")) return;
      openHeatStock(r.dataset.code, r.dataset.name);
    };
  });
}
  热度榜已下线（代码保留，到此结束） */

/* ---------- 趋势选股 ---------- */
function trendPct(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
}

async function loadTrend(force, date) {
  const sel = date === undefined ? state.trendDate : (date || "");
  state.trendDate = sel;
  const note = $("#trend-note"), list = $("#trend-list");
  if (!note || !list) return;
  const key = sel ? `trend:${sel}` : "trend";
  const hit = !force && memoFresh(key, 60000);
  if (hit) { renderTrend(hit); return; }
  const empty = !list.children.length;
  note.textContent = empty ? "加载中…" : "刷新中…";
  try {
    const d = await api(sel ? `trend?date=${encodeURIComponent(sel)}` : "trend", {}, 20000);
    memoSet(key, d);
    renderTrend(d);
  } catch (e) {
    note.textContent = "加载失败";
    if (empty) list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function trendPeText(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return Number(v) > 0 ? Number(v).toFixed(1) : "亏损";
}
/* ETF 成交额：后端统一存万元 */
function trendAmountText(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return fmtAmountWan(v);
}

function trendSpark(vals, pct) {
  if (!Array.isArray(vals) || vals.length < 2) return "";
  const w = 64, h = 22;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1) * w).toFixed(1);
    const y = (h - 2 - ((v - min) / span) * (h - 4)).toFixed(1);
    return `${x},${y}`;
  }).join(" ");
  const color = pct >= 0 ? "var(--up)" : "var(--down)";
  return `<svg class="trend-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="color:${color}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function trendTagHtml(x) {
  const tags = Array.isArray(x.tags) ? x.tags.filter(Boolean) : [];
  if (!tags.length) return { html: "", title: "" };
  return {
    html: tags.map((t, i) =>
      `<span class="${i === 0 ? "trend-sector" : "trend-tag"}">${esc(t)}</span>`).join(""),
    title: tags.join(" · "),
  };
}

function trendDaysHtml(x) {
  const all = Array.isArray(x.streak_pcts) ? x.streak_pcts : [];
  if (!all.length) return "";
  const days = all.slice(-8);
  const more = all.length > days.length ? '<span class="lab">…</span>' : "";
  const chips = days.map((v) =>
    `<span class="d">${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%</span>`).join("");
  const total = x.streak_total === null || x.streak_total === undefined
    ? "" : `<span class="lab">累计</span><span class="tot">${trendPct(x.streak_total)}</span>`;
  return `<span class="lab">连涨节奏</span>${more}${chips}${total}`;
}

/* 板块标签筛选已下线（卡片内标签仅展示，取消注释可恢复）：
function renderTrendTagChips(items) {
  const box = $("#trend-tags");
  if (!box) return;
  const firstCounts = new Map();
  const allCounts = new Map();
  for (const x of items || []) {
    const tags = Array.isArray(x.tags) ? x.tags : [];
    if (tags[0]) firstCounts.set(tags[0], (firstCounts.get(tags[0]) || 0) + 1);
    for (const t of tags) {
      if (!t) continue;
      allCounts.set(t, (allCounts.get(t) || 0) + 1);
    }
  }
  if (!allCounts.size) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  // 行业最多 16 个 + 概念最多 12 个；选中的标签如果没进前列，临时提到最前。
  const industryTags = [...firstCounts.keys()]
    .sort((a, b) => (firstCounts.get(b) - firstCounts.get(a))
      || (allCounts.get(b) - allCounts.get(a)) || a.localeCompare(b))
    .slice(0, 16);
  const conceptTags = [...allCounts.keys()]
    .filter((t) => !firstCounts.has(t))
    .sort((a, b) => (allCounts.get(b) - allCounts.get(a)) || a.localeCompare(b))
    .slice(0, 12);
  let tags = [...industryTags, ...conceptTags];
  if (state.trendFilter && !allCounts.has(state.trendFilter)) state.trendFilter = "";
  if (state.trendFilter && !tags.includes(state.trendFilter)) tags.unshift(state.trendFilter);
  box.innerHTML = `<button class="chip ${state.trendFilter ? "" : "on"}" data-trend-tag="">全部</button>`
    + tags.map((t) => `<button class="chip ${state.trendFilter === t ? "on" : ""}" data-trend-tag="${esc(t)}">${esc(t)}</button>`).join("");
}

function setTrendFilter(tag) {
  state.trendFilter = tag || "";
  if (state.trendData) renderTrend(state.trendData);
}

*/

function trendFlags(x) {
  const flags = [];
  if (Number(x.dist_ma20) >= 20) flags.push(["乖离大", "risk"]);
  if (Number(x.turnover_rate) >= 10) flags.push(["高换手", "risk"]);
  if (Number(x.vol_ratio) >= 2) flags.push(["放量", "hot"]);
  const days = Array.isArray(x.streak_pcts) ? x.streak_pcts : [];
  if (days.length >= 2) {
    const prev = days.slice(0, -1);
    const avg = prev.reduce((a, b) => a + Number(b), 0) / prev.length;
    if (Number(x.pct) > avg * 1.2) flags.push(["加速", "hot"]);
  }
  return flags.slice(0, 3);
}

