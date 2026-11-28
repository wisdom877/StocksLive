function paintProfile(box, d) {
  const main = d.main_business || [];
  const bg = d.industry_background || [];
  const adv = d.advantages || [];
  const tags = (arr, n) => arr.slice(0, n).map((x) => `<span class="tag">${esc(x.title)}</span>`).join(" ");
  const block = (x) => `<div class="pf-item"><b>${esc(x.title)}</b><div class="pf-text">${esc(x.content)}</div></div>`;
  const meta = [d.org_name, d.list_date ? `上市 ${esc(d.list_date)}` : "",
    d.employees ? `员工 ${num(d.employees, 0)} 人` : "", d.website].filter(Boolean).join(" · ");
  const full = [
    main.length ? `<div class="pf-sec"><div class="pf-t">主营业务</div>${main.map(block).join("")}</div>` : "",
    bg.length ? `<div class="pf-sec"><div class="pf-t">行业背景</div>${bg.map(block).join("")}</div>` : "",
    adv.length ? `<div class="pf-sec"><div class="pf-t">核心竞争力 / 行业地位</div>${adv.map(block).join("")}</div>` : "",
    d.scope ? `<div class="pf-sec"><div class="pf-t">经营范围</div><div class="pf-text">${esc(d.scope)}</div></div>` : "",
  ].filter(Boolean).join("");
  box.innerHTML = `<div class="pf-head"><span>公司介绍</span><span class="tiny muted">${esc(d.industry || d.industry_csrc || "")}</span></div>
    ${meta ? `<div class="pf-meta">${esc(meta)}</div>` : ""}
    <div class="pf-intro clamp">${esc(d.intro || "暂无公司简介")}</div>
    ${main.length ? `<div class="pf-line"><b>主营</b>${tags(main, 6)}</div>` : ""}
    ${adv.length ? `<div class="pf-line"><b>行业地位</b>${tags(adv, 4)}</div>` : ""}
    ${full ? `<button type="button" class="btn ghost small pf-more" id="pf-more">展开全文</button>
      <div class="pf-full hidden">${full}</div>` : ""}`;
  bindClamp(box);
  const more = $("#pf-more", box);
  if (more) more.onclick = () => {
    const body = $(".pf-full", box);
    if (!body) return;
    const on = body.classList.toggle("hidden");
    more.textContent = on ? "展开全文" : "收起全文";
  };
}
async function loadProfile(code) {
  const seq = ++profileSeq;
  const box = $("#sq-profile");
  if (!box) return;
  const cached = profileMemo.get(code);
  if (cached) { paintProfile(box, cached); return; }
  let d;
  try {
    d = await api(`profile/${code}`, {}, 20000);
  } catch (e) {
    if (seq === profileSeq && document.contains(box)) {
      box.innerHTML = `<div class="pf-head"><span>公司介绍</span></div>
        <div class="tiny muted">${esc(e.message || "暂时取不到公司资料")}</div>`;
    }
    return;
  }
  if (seq !== profileSeq || !document.contains(box)) return;
  profileMemo.set(code, d);
  paintProfile(box, d);
}

$$("[data-add]").forEach((b) => {
  b.onclick = () => {
    const bucket = b.dataset.add;
    const hint = '<span class="muted tiny">输入 6 位代码后自动获取；点标签可填入自定义标签</span>';
    openSheet(
      bucket === "hold" ? "添加持仓" : "添加关注",
      `<div class="field"><label>代码（6 位）</label><input id="n-code" inputmode="numeric" placeholder="如 600519"></div>
       <div class="field"><label>自定义标签（可多个，逗号分隔）</label><input id="n-custom-tags" placeholder="如：机器人,防守"></div>
       <div class="field">
         <div class="field-head"><label>外网标签（点选可填入自定义标签）</label><button class="ghost-txt" id="n-fetch-tags" type="button">获取</button></div>
         <div id="n-ext-tags" class="tags-line">${hint}</div></div>
       <div class="sheet-actions"><button class="btn primary" id="n-save">添加</button></div>`
    );

    let fetchedCode = "";
    let seq = 0;
    let autoTimer = null;
    const fetchTags = async () => {
      const codeEl = $("#n-code");
      const box = $("#n-ext-tags");
      const btn = $("#n-fetch-tags");
      if (!codeEl || !box || !btn) return;
      const code = codeEl.value.trim();
      if (!/^\d{6}$/.test(code)) {
        toast("先输入 6 位代码");
        return;
      }
      const my = ++seq;
      btn.disabled = true;
      btn.textContent = "获取中…";
      box.innerHTML = '<span class="muted tiny">获取中…</span>';
      try {
        const r = await api(`stocks/${code}/external-tags`);
        if (my !== seq || !document.contains(box)) return;
        fetchedCode = code;
        box.innerHTML = externalTagsHtml(r.tags);
        bindApiTagChips(box, $("#n-custom-tags"));
      } catch (e) {
        if (my !== seq || !document.contains(box)) return;
        box.innerHTML = `<span class="muted tiny">${esc(e.message || "获取失败")}</span>`;
      } finally {
        if (my === seq && document.contains(btn)) {
          btn.disabled = false;
          btn.textContent = "获取";
        }
      }
    };
    $("#n-fetch-tags").onclick = fetchTags;
    $("#n-code").addEventListener("input", (e) => {
      clearTimeout(autoTimer);
      seq++;  // 作废还在路上的请求
      const code = e.target.value.trim();
      const box = $("#n-ext-tags");
      if (!/^\d{6}$/.test(code)) {
        fetchedCode = "";
        if (box) box.innerHTML = hint;
        return;
      }
      if (code !== fetchedCode) autoTimer = setTimeout(fetchTags, 350);
    });
    $("#n-save").onclick = async () => {
      try {
        await api("stocks", {
          method: "POST",
          body: {
            code: $("#n-code").value.trim(),
            custom_tags: $("#n-custom-tags").value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
            bucket,
          },
        });
        closeSheet();
        toast("已添加");
        await loadBoard(true);
      } catch (e) { toast(e.message); }
    };
  };
});

/* ---------- 4. notes ---------- */
async function loadNotes() {
  refreshSavedNews().catch(() => {});
  loadDigests().catch(() => {});
  loadDigestMarks().catch(() => {});
  if (memoFresh("notes", 60000)) return;
  const d = await api("notes");
  memoSet("notes", d);
  state.notes = d.items;
  state.notesLoaded = true;
  state.noteTags = d.tags;
  state.noteDays = d.days || [];
  state.noteToday = d.today || state.today || "";
  if (state.noteFrom === null) {
    state.noteFrom = "";
    state.noteTo = "";
  }
  if (!state.board.stocks.length) await loadBoard(true).catch(() => {});
  renderNoteDays();
  renderNoteFilters();
  renderNotes();
}

function renderNoteDays() {
  const box = $("#note-days");
  if (!box) return;
  const from = state.noteFrom || "";
  const to = state.noteTo || "";
  const label = from ? `${from.slice(5)}${to && to !== from ? "~" + to.slice(5) : ""}` : "选日期";
  box.innerHTML = `<button class="chip more ${from ? "on" : ""}" id="note-range-btn"><svg class="chip-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.8" width="18" height="16.2" rx="3"/><path d="M8 2.6v4M16 2.6v4M3 9.6h18"/></svg>${esc(label)}</button>`;
  $("#note-range-btn").onclick = () => openRangeSheet(
    { from, to },
    (a, b) => {
      state.noteFrom = a;
      state.noteTo = b;
      state.noteShown = 0;
      renderNoteDays();
      renderNotes();
    },
    () => {
      state.noteFrom = "";
      state.noteTo = "";
      state.noteShown = 0;
      renderNoteDays();
      renderNotes();
    },
  );
}
function renderNoteFilters() {
  // 批注是从新闻总结里划词生成的，跟「写一条记录」的输入区无关，那一块整块收起来
  const vn = $("#view-note");
  if (vn) vn.classList.toggle("mark-mode", state.noteKind === "mark");
  // 「新闻」已由底部导航承担，这里不再重复一个入口
  const kinds = [["note", "记录"], ["analysis", "分析"], ["mark", "批注"]];
  $("#note-kind-filter").innerHTML = kinds
    .map(([k, label]) => `<button class="${state.noteKind === k ? "on" : ""}" data-kind="${k}">${label}</button>`)
    .join("");
  $$("#note-kind-filter button").forEach((c) => {
    c.onclick = () => {
      state.noteKind = c.dataset.kind;
      state.noteTag = "";
      renderNoteFilters();
      renderNotes();
    };
  });
  // 标签只显示当前选项卡里真实存在的（记录 / 新闻 / 分析 各看各的）
  const inTab = (n) => {
    if (state.noteKind === "mark") return false;   // 批注没有标签，单独一栏
    if (state.noteKind === "note") return ["idea", "note", "theme"].includes(n.kind);
    return n.kind === state.noteKind;
  };
  const seen = new Map();
  state.notes.filter(inTab).forEach((n) => {
    (n.tags || []).forEach((t) => seen.set(t, (seen.get(t) || 0) + 1));
  });
  const tags = [...seen.keys()].sort((a, b) => seen.get(b) - seen.get(a) || a.localeCompare(b, "zh-CN"));
  if (state.noteTag && !tags.includes(state.noteTag)) state.noteTag = "";
  $("#note-tags-filter").innerHTML =
    `<button class="chip ${state.noteTag ? "" : "on"}" data-tag="">全部</button>` +
    tags.map((t) => `<button class="chip ${state.noteTag === t ? "on" : ""}" data-tag="${esc(t)}">${esc(t)} ${seen.get(t)}</button>`).join("") +
    `<button class="chip wk-new" data-tagmgr="notes" title="管理和新建标签">管理</button>`;
  $$("#note-tags-filter .chip").forEach((c) => {
    if (c.dataset.tagmgr) return;          // 「管理」入口由下面单独绑，别被这里覆盖
    c.onclick = () => {
      if (Date.now() - (tagPressAt || 0) < 700) return;   // 长按改名后别再触发筛选
      state.noteTag = c.dataset.tag;
      renderNoteFilters();
      renderNotes();
    };
  });
  const noteMgr = $("#note-tags-filter [data-tagmgr]");
  if (noteMgr) noteMgr.onclick = () => openTagManager("notes");
  bindTagLongPress($("#note-tags-filter"));
  bindNoteKindLongPress();     // 长按「新闻/记录/分析」进入批量选择
}

/* ---------- 新闻总结（记录 · 新闻）：每天早/晚各一张卡片 ---------- */
// 内容由 Hermes 每天 08:00 / 20:00 写入（上一张卡以来的新闻分领域统计），一天两张，越详细越好
async function loadDigests(force, full) {
  // 首屏只取最近 10 张，避免一次拉 30 天；打开总结面板/点「总结」时再取全量（最多 60 张）
  // 总结一天才更新两次：10 分钟内重开都不该重拉 500KB 正文
  const cached = memoFresh("digest", 600000);
  const cachedTotal = Number((cached && cached.total) || ((cached && cached.items) || []).length);
  const cachedFull = cached && ((cached.items || []).length >= cachedTotal);
  let d = null;
  if (!force) {
    if (full ? cachedFull : cached) d = cached;
  }
  if (!d) {
    // 面板不要一次拉满 60 张正文：按当前展开数取，点「查看更多」再取更多
    const limit = full ? Math.min(60, Math.max(10, state.digestShown || 10)) : 10;
    d = await api(`digest?limit=${limit}`).catch(() => api(`digest?limit=${limit}`));   // 首屏偶发 401/超时，重试一次
    memoSet("digest", d);
  }
  const fetched = (d && d.items) || [];
  // 首屏的 10 张请求不要覆盖已经展开的全量列表（例如面板打开后轮询又拉了 10 张）
  if (full || !(state.digests || []).length || (state.digests || []).length <= fetched.length) {
    state.digests = fetched;
  }
  state.digestTotal = Number((d && d.total) || fetched.length);
  state.digestToday = (d && d.today) || state.digestToday || state.today || "";
  const dgBtn = $("#live-digest");
  if (dgBtn && state.liveDigest) renderDigests();
}

// 正文格式：首行总览，然后 "## 领域 · N 条" 分段，段内 "- " 开头是条目
function parseDigest(content) {
  const lead = [];
  const secs = [];
  String(content || "").split("\n").forEach((line) => {
    const s = line.trim();
    if (!s) return;
    if (s.startsWith("#")) {
      const t = s.replace(/^#+\s*/, "");
      const m = t.match(/^(.*?)\s*[·:：]\s*(\d+)\s*条\s*$/);
      secs.push({ title: m ? m[1].trim() : t, count: m ? Number(m[2]) : null, items: [] });
    } else if (secs.length) {
      secs[secs.length - 1].items.push(s.replace(/^[-•]\s*/, ""));
    } else {
      lead.push(s.replace(/^[-•]\s*/, ""));
    }
  });
  return { lead: lead.join(" "), secs };
}

function digestSlotLabel(slot) { return slot === "pm" ? "晚" : "早"; }
function digestWhen(d) {
  const t = String(d.window_end || d.updated_at || "").slice(11, 16);
  return t ? `截至 ${t}` : "";
}
// 新闻总结里的 {{n123}} 是脚本给的新闻 ID。连续多个合并成一个「来源N」，
// 点开一次性预览这一组原文，避免一条总结后面挂一排「来源」。
const DIGEST_TIME_RE = /(?:(?:\d{2}-\d{2}\s+)?(?:\d{1,2}:\d{2}|\d{1,2}点(?:\d{1,2}分)?|\d{1,2}时(?:\d{1,2}分)?))(?:\s*[—–~至/、,，-]\s*(?:(?:\d{2}-\d{2}\s+)?(?:\d{1,2}:\d{2}|\d{1,2}点(?:\d{1,2}分)?|\d{1,2}时(?:\d{1,2}分)?)))*/g;
const DIGEST_SRC_RE = /\{\{n(\d+)\}\}(?:[、,，\s]*\{\{n\d+\}\})*/g;

/* 每个可标注区块的原始文本（key = 日期|时段|block）。选中文字时按它换算字符位置。 */
const dgRawBlocks = new Map();
function dgRawKey(day, slot, block) { return `${day}|${slot || "am"}|${block}`; }
function registerDigestRaw(d, parsed) {
  dgRawBlocks.set(dgRawKey(d.day, d.slot, "lead"), parsed.lead || "");
  parsed.secs.forEach((s, i) => s.items.forEach((x, j) => {
    dgRawBlocks.set(dgRawKey(d.day, d.slot, `s${i}i${j}`), x);
  }));
}

/* 这张卡上每个区块的标注 + 批注编号（按正文阅读顺序 1、2、3…）。 */
function digestCardMarkState(d, parsed) {
  const blocks = [{ key: "lead", text: parsed.lead || "" }];
  parsed.secs.forEach((s, i) => s.items.forEach((x, j) => blocks.push({ key: `s${i}i${j}`, text: x })));
  const textByBlock = new Map(blocks.map((b) => [b.key, b.text]));
  const byBlock = new Map(blocks.map((b) => [b.key, []]));
  (state.digestMarks || []).forEach((m) => {
    if (m.day !== d.day || (m.slot || "am") !== (d.slot || "am")) return;
    const arr = byBlock.get(m.block);
    if (!arr) return;
    // 总结重新生成后位置可能对不上：原文还在才画，找不到的标注不占编号
    const text = textByBlock.get(m.block) || "";
    const quote = String(m.quote || "");
    const s = Number(m.start_off), e = Number(m.end_off);
    const ok = quote && ((s >= 0 && e > s && e <= text.length && text.slice(s, e) === quote)
      || text.indexOf(quote) >= 0);
    if (ok) arr.push(m);
  });
  byBlock.forEach((arr) => arr.sort((a, b) => Number(a.start_off) - Number(b.start_off) || Number(a.id) - Number(b.id)));
  const nums = new Map();
  let n = 0;
  blocks.forEach((b) => (byBlock.get(b.key) || []).forEach((m) => {
    if (String(m.note || "").trim()) nums.set(Number(m.id), ++n);
  }));
  return { byBlock, nums };
}

/* 把正文切成 普通文字 / 时间 / 来源链接 三种片段，保留每段在原始文本里的位置。 */
function dgTokenize(text) {
  const out = [];
  const pushText = (a, b) => {
    if (b > a) out.push({ start: a, end: b, type: "text", raw: text.slice(a, b), html: esc(text.slice(a, b)) });
  };
  let pos = 0;
  while (pos < text.length) {
    DIGEST_TIME_RE.lastIndex = pos;
    DIGEST_SRC_RE.lastIndex = pos;
    const tm = DIGEST_TIME_RE.exec(text);
    const sm = DIGEST_SRC_RE.exec(text);
    let m = null, type = "";
    if (tm && sm) {
      if (tm.index <= sm.index) { m = tm; type = "time"; } else { m = sm; type = "src"; }
    } else if (tm) { m = tm; type = "time"; }
    else if (sm) { m = sm; type = "src"; }
    if (!m) { pushText(pos, text.length); break; }
    pushText(pos, m.index);
    const raw = m[0];
    if (type === "time") {
      out.push({ start: m.index, end: m.index + raw.length, type: "time", raw,
                 html: `<span class="dg-time">${esc(raw)}</span>` });
    } else {
      const ids = [...raw.matchAll(/\{\{n(\d+)\}\}/g)].map((x) => x[1]);
      const uniq = [...new Set(ids)];
      const label = uniq.length > 1 ? `原文${uniq.length}` : "原文";
      // 摘要在半句上截断（自动摘要只保留前面一段），补个省略号，否则读起来像正文写错了
      const prev = text.slice(Math.max(0, m.index - 1), m.index);
      const cut = prev && !/[。！？．\.!?：:；;」』”’）)]/.test(prev)
        ? '<span class="dg-cut">…</span>' : "";
      out.push({ start: m.index, end: m.index + raw.length, type: "src", raw,
                 html: `${cut}<a href="#" class="dg-src" data-news="${uniq.join(",")}" data-raw="${esc(raw)}" title="查看原文">${label}</a>` });
    }
    pos = m.index + raw.length;
  }
  return out;
}

/* 渲染一条总结正文：时间标红、来源可点，再把标红 / 下划线 / 批注套上去。
   marks 是这一块的标注，noteNums 是批注编号。标注位置对不上时按 quote 重新找。 */
function digestTextHtml(text, marks, noteNums) {
  const srcText = String(text || "");
  const ms = (marks || []).map((m) => {
    const quote = String(m.quote || "");
    let s = Number(m.start_off);
    let e = Number(m.end_off);
    if (!(s >= 0 && e > s && e <= srcText.length) || srcText.slice(s, e) !== quote) {
      s = quote ? srcText.indexOf(quote) : -1;
      e = s >= 0 ? s + quote.length : -1;
    }
    if (s < 0 || e <= s) return null;
    return { ...m, _s: s, _e: e };
  }).filter(Boolean).sort((a, b) => a._s - b._s || a._e - b._e);
  if (!ms.length) return dgTokenize(srcText).map((t) => t.html).join("");

  const emitted = new Set();
  const annoHtml = (m) => {
    const num = noteNums && noteNums.get(Number(m.id));
    if (!num || emitted.has(Number(m.id))) return "";
    emitted.add(Number(m.id));
    return `<sup class="dg-anno" data-mark-id="${m.id}" title="查看批注">${num}</sup>`;
  };
  const wrap = (html, active) => {
    let out = html;
    active.forEach((m) => {
      out = `<span class="dg-mark dg-mark-${esc(m.style)}" data-mark-id="${m.id}">${out}</span>`;
    });
    return out;
  };

  let out = "";
  dgTokenize(srcText).forEach((t) => {
    const hits = ms.filter((m) => m._s < t.end && m._e > t.start);
    if (!hits.length) { out += t.html; return; }
    if (t.type !== "text") {
      // 时间 / 来源是整体元素，被标到就整块包住
      const active = hits.slice().sort((a, b) => a._s - b._s || a._e - b._e);
      out += wrap(t.html, active);
      active.forEach((m) => { if (m._e <= t.end) out += annoHtml(m); });
      return;
    }
    const cuts = new Set([t.start, t.end]);
    hits.forEach((m) => {
      if (m._s > t.start && m._s < t.end) cuts.add(m._s);
      if (m._e > t.start && m._e < t.end) cuts.add(m._e);
    });
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (b <= a) continue;
      const active = ms.filter((m) => m._s <= a && m._e >= b).sort((x, y) => x._s - y._s || x._e - y._e);
      out += wrap(esc(srcText.slice(a, b)), active);
      active.forEach((m) => { if (m._e === b) out += annoHtml(m); });
    }
  });
  return out;
}

/* 展示用：把标注原文里的 {{nID}} 来源 token 收成「来源」，别让用户看到内部标记。 */
function digestQuoteLabel(quote) {
  return String(quote || "").replace(/\{\{n\d+\}\}(?:[、,，\s]*\{\{n\d+\}\})*/g, "原文");
}

/* 标注列表：总结面板和记录页共用；打开面板时强制拉一次。 */
async function loadDigestMarks(force) {
  if (!force) {
    const cached = memoFresh("digestMarks", 30000);
    if (cached) {
      state.digestMarks = cached.items || [];
      if (state.view === "note" && state.noteKind === "mark") renderNotes();
      return state.digestMarks;
    }
  }
  const d = await api("digest/marks?limit=500");
  memoSet("digestMarks", d);
  state.digestMarks = d.items || [];
  if (state.view === "note" && state.noteKind === "mark") renderNotes();
  return state.digestMarks;
}

function findDigestMark(id) {
  return (state.digestMarks || []).find((m) => String(m.id) === String(id)) || null;
}
function patchLocalDigestMark(id, patch) {
  const m = findDigestMark(id);
  if (m) Object.assign(m, patch);
  return m;
}
function putDigestMark(row) {
  if (!row) return;
  const list = state.digestMarks || [];
  const i = list.findIndex((m) => String(m.id) === String(row.id));
  if (i >= 0) list[i] = row; else list.push(row);
  state.digestMarks = list;
}
function dropDigestMark(id) {
  state.digestMarks = (state.digestMarks || []).filter((m) => String(m.id) !== String(id));
}

/* 保存标注后，总结面板和记录页「批注」同时刷新 */
/* 只重画总结卡片里的正文块，不重建整个面板：标红/下划线/批注后不会跳回顶部 */
function refreshDigestCardMarks(onlyBlock = "") {
  const body = $("#dg-body");
  if (!body) return false;
  const card = body.querySelector(".digest-card");
  if (!card) return false;
  const day = card.dataset.day;
  const slot = card.dataset.slot || "am";
  const d = (state.digests || []).find((x) => x.day === day && (x.slot || "am") === slot);
  if (!d) return false;
  const parsed = parseDigest(d.content);
  registerDigestRaw(d, parsed);
  const mk = digestCardMarkState(d, parsed);
  const rawMap = new Map([["lead", parsed.lead || ""]]);
  parsed.secs.forEach((s, i) => s.items.forEach((x, j) => rawMap.set(`s${i}i${j}`, x)));
  let n = 0;
  card.querySelectorAll(".dg-block").forEach((el) => {
    const key = el.dataset.block;
    if (!rawMap.has(key) || (onlyBlock && key !== onlyBlock)) return;
    el.innerHTML = digestTextHtml(rawMap.get(key), mk.byBlock.get(key), mk.nums);
    n++;
  });
  return n > 0;
}

function repaintDigestMarks(onlyBlock = "") {
  const panel = $("#digest");
  const panelOpen = !!(panel && !panel.classList.contains("hidden"));
  if (panelOpen && inbox.tab === "digest") {
    if (!refreshDigestCardMarks(onlyBlock)) renderDigestPanel();
  }
  // 面板开着时先别动背后的记录页，关闭时再统一刷新，避免背景滚动/闪烁
  if (!panelOpen && state.view === "note" && state.noteKind === "mark") renderNotes();
}

function focusDigestMark(markId, tries = 0) {
  const el = document.querySelector(`.digest-card [data-mark-id="${Number(markId)}"]`);
  if (!el) {
    if (tries < 20) setTimeout(() => focusDigestMark(markId, tries + 1), 200);
    return;
  }
  const sec = el.closest(".dg-sec");
  if (sec) sec.classList.add("open");
  try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { el.scrollIntoView(); }
  el.classList.add("dg-mark-flash");
  setTimeout(() => el.classList.remove("dg-mark-flash"), 1800);
}

/* ---------- 选中总结文字 → 标红 / 下划线 / 批注 ---------- */
let markPick = null;       // 当前选区换算出来的标注位置
let markBarDown = false;   // 正在点浮条，别让 selectionchange 把选区清掉

function dgBlockOf(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  const block = el && el.closest ? el.closest(".dg-block") : null;
  return block && block.closest(".digest-card") ? block : null;
}

/* 把选区端点换算成区块原始文本里的字符位置。来源链接是一整块，选到里面就贴到它的边界。 */
function dgRawOffset(block, node, offset, isEnd) {
  let n = node;
  let off = offset;
  const holder = n && (n.nodeType === 1 ? n : n.parentElement);
  if (holder && holder.closest && holder.closest(".dg-anno")) return null;
  const src = holder && holder.closest ? holder.closest(".dg-src") : null;
  if (src) { n = src; off = isEnd ? 1 : 0; }
  let acc = 0;
  let done = false;
  const walk = (el) => {
    if (!el || done) return;
    if (el === n) {
      if (el.nodeType === 3) { acc += off; done = true; return; }
      if (el.nodeType === 1) {
        if (el.hasAttribute && el.hasAttribute("data-raw")) {
          acc += off === 0 ? 0 : el.dataset.raw.length;
          done = true;
          return;
        }
        const kids = el.childNodes;
        for (let i = 0; i < off && i < kids.length; i++) {
          walk(kids[i]);
          if (done) return;
        }
        done = true;
        return;
      }
    }
    if (el.nodeType === 3) { acc += el.nodeValue.length; return; }
    if (el.nodeType === 1) {
      if (el.classList && el.classList.contains("dg-anno")) return;
      if (el.hasAttribute && el.hasAttribute("data-raw")) { acc += el.dataset.raw.length; return; }
      for (const ch of el.childNodes) {
        walk(ch);
        if (done) return;
      }
    }
  };
  walk(block);
  return done ? acc : null;
}

function captureDigestSelection() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startBlock = dgBlockOf(range.startContainer);
  const endBlock = dgBlockOf(range.endContainer);
  if (!startBlock || startBlock !== endBlock) return null;   // 一次只标同一条，跨条不标
  const card = startBlock.closest(".digest-card");
  if (!card) return null;
  const raw = dgRawBlocks.get(dgRawKey(card.dataset.day, card.dataset.slot, startBlock.dataset.block));
  if (raw == null) return null;
  const a = dgRawOffset(startBlock, range.startContainer, range.startOffset, false);
  const b = dgRawOffset(startBlock, range.endContainer, range.endOffset, true);
  if (a == null || b == null) return null;
  let s = Math.min(a, b), e = Math.max(a, b);
  while (s < e && /\s/.test(raw[s])) s++;
  while (e > s && /\s/.test(raw[e - 1])) e--;
  if (e <= s) return null;
  const quote = raw.slice(s, e);
  if (!quote.trim() || quote.length > 500) return null;   // 太长的话前端锚定和阅读体验都不好
  let rect = range.getBoundingClientRect();
  const rects = range.getClientRects();
  if ((!rect || (!rect.width && !rect.height)) && rects.length) rect = rects[rects.length - 1];
  return { day: card.dataset.day, slot: card.dataset.slot || "am", block: startBlock.dataset.block,
           start: s, end: e, quote, rect };
}

function showMarkbar(p) {
  const bar = $("#dg-markbar");
  if (!bar) return;
  bar.classList.remove("hidden");
  const bw = bar.offsetWidth || 190;
  const bh = bar.offsetHeight || 40;
  const r = p.rect || { left: 0, top: 0, width: 0, bottom: 0 };
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
  let top = r.top - bh - 8;
  if (top < 8) top = Math.min(window.innerHeight - bh - 8, r.bottom + 8);
  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
}
function hideMarkbar(clearPick = true) {
  const bar = $("#dg-markbar");
  if (bar) bar.classList.add("hidden");
  if (clearPick) markPick = null;
}

let dgSelTimer = null;
document.addEventListener("selectionchange", () => {
  if (markBarDown) return;
  clearTimeout(dgSelTimer);
  dgSelTimer = setTimeout(() => {
    // 手指已经按在浮条上：别在 click 之前把浮条藏掉（安卓点选时 selection 可能先塌缩）
    if (markBarDown) return;
    const p = captureDigestSelection();
    if (p) { markPick = p; showMarkbar(p); }
    else hideMarkbar(false);   // 保留最近一次有效选区，给还在路上的 click 用
  }, 160);
});
window.addEventListener("scroll", hideMarkbar, true);
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest && e.target.closest("#dg-markbar")) {
    markBarDown = true;   // capture 阶段先标记，避免 selectionchange 把浮条提前收起
    return;
  }
  hideMarkbar();
}, true);

const dgMarkbar = $("#dg-markbar");
if (dgMarkbar) {
  dgMarkbar.addEventListener("pointerdown", () => { markBarDown = true; });
  dgMarkbar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-mk]");
    const p = markPick;
    if (!b || !p) return;
    const style = b.dataset.mk;
    hideMarkbar();
    createDigestMark(p, style);
  });
}
document.addEventListener("pointerup", () => {
  if (!markBarDown) return;
  // 留足 click 派发时间；期间 selectionchange 不抢着收浮条
  setTimeout(() => { markBarDown = false; }, 200);
}, true);
document.addEventListener("pointercancel", () => { markBarDown = false; }, true);
// 尽力压住长按选词的系统菜单；Android/iOS 的选择工具条仍可能由系统弹出（网页无权关闭）
document.addEventListener("contextmenu", (e) => {
  if (e.target.closest && e.target.closest(".dg-block")) e.preventDefault();
});

let markCreating = false;
async function createDigestMark(p, style) {
  if (markCreating) return;
  markCreating = true;
  try {
    const row = await api("digest/marks", {
      method: "POST",
      body: { day: p.day, slot: p.slot, block: p.block, start_off: p.start,
              end_off: p.end, quote: p.quote, style, note: "" },
    });
    putDigestMark(row);
    if (style === "note") {
      repaintDigestMarks();
      openDigestMarkEditor(row.id, true);
    } else {
      // 只重画被标的这一条，尽量不打断用户接着选中下一段文字
      repaintDigestMarks(p.block);
      toast(style === "red" ? "已标红" : "已加下划线");
    }
  } catch (e) {
    toast(e.message || "标注失败");
  } finally {
    markCreating = false;
  }
}

/* 点已有标注 / 批注角标：编辑样式和想法。批注边写边自动保存。
   fresh=true 表示刚从浮条新建：关掉时如果一个字都没写就删掉空标注。 */
function openDigestMarkEditor(markId, fresh = false) {
  const m = findDigestMark(markId);
  if (!m) { toast("标注不存在"); return; }
  hideMarkbar();
  let curStyle = m.style;
  openSheet("批注", `
    <div class="mk-quote-box">“${esc(digestQuoteLabel(m.quote))}”</div>
    <div class="field"><label>我的批注 <span id="mk-save-state" class="tiny muted"></span></label>
      <textarea id="mk-note" rows="4" maxlength="2000" placeholder="写想法，边写边自动保存…">${esc(m.note || "")}</textarea></div>
    <div class="mk-style-row">
      <button type="button" class="chip ${curStyle === "red" ? "on" : ""}" data-mk-style="red">标红</button>
      <button type="button" class="chip ${curStyle === "underline" ? "on" : ""}" data-mk-style="underline">下划线</button>
      <button type="button" class="chip ${curStyle === "note" ? "on" : ""}" data-mk-style="note">批注</button>
    </div>
    <div class="sheet-actions">
      <button type="button" class="btn ghost" id="mk-del">删除标注</button>
      <button type="button" class="btn ghost" data-close>关闭</button>
    </div>`);
  const ta = $("#mk-note");
  const stateEl = $("#mk-save-state");
  let timer = null;
  let dirty = false;
  let saveSeq = 0;
  const saveNote = async (silent) => {
    clearTimeout(timer);
    timer = null;
    dirty = false;
    if (!ta) return null;
    const note = ta.value.trim();
    const seq = ++saveSeq;
    try {
      if (stateEl) stateEl.textContent = "保存中…";
      const row = await api(`digest/marks/${m.id}`, { method: "PATCH", body: { note } });
      if (seq !== saveSeq) return row;   // 已有更新的自动保存，别拿旧响应覆盖
      patchLocalDigestMark(m.id, { note, updated_at: row.updated_at });
      if (stateEl) stateEl.textContent = "已保存";
      repaintDigestMarks();
      return row;
    } catch (e) {
      if (seq !== saveSeq) return null;
      if (stateEl) stateEl.textContent = "保存失败";
      if (!silent) toast("自动保存失败，请重试");
      return null;
    }
  };
  if (ta) {
    ta.addEventListener("input", () => {
      dirty = true;
      if (stateEl) stateEl.textContent = "未保存…";
      clearTimeout(timer);
      timer = setTimeout(() => saveNote(true), 600);
    });
    ta.addEventListener("blur", () => { if (dirty) saveNote(true); });
  }
  $$("#sheet [data-mk-style]").forEach((b) => {
    b.onclick = async () => {
      const style = b.dataset.mkStyle;
      if (style === curStyle) return;
      try {
        await api(`digest/marks/${m.id}`, { method: "PATCH", body: { style } });
        curStyle = style;
        patchLocalDigestMark(m.id, { style });
        $$("#sheet [data-mk-style]").forEach((x) => x.classList.toggle("on", x.dataset.mkStyle === style));
        repaintDigestMarks();
      } catch (e) { toast(e.message); }
    };
  });
  const del = $("#mk-del");
  if (del) del.onclick = async () => {
    try {
      await api(`digest/marks/${m.id}`, { method: "DELETE", idempotent: true });
      sheetCloseHook = null;
      dropDigestMark(m.id);
      closeSheet();
      repaintDigestMarks();
      toast("已删除标注");
    } catch (e) { toast(e.message); }
  };
  // 关闭前把没来得及自动保存的内容落库；「批注」样式但一个字没写，就删掉这条标注
  sheetCloseHook = () => {
    const note = ta ? ta.value.trim() : "";
    if (dirty) saveNote(true);
    if (fresh && !note && curStyle === "note") {
      api(`digest/marks/${m.id}`, { method: "DELETE", idempotent: true }).then(() => {
        dropDigestMark(m.id);
        repaintDigestMarks();
      }).catch(() => {});
    }
  };
}

document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest(".dg-src")) return;
  const el = e.target.closest && e.target.closest(".dg-anno, .dg-mark");
  if (!el || !el.dataset.markId) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed) return;   // 正在拖选，不打断
  e.preventDefault();
  e.stopPropagation();
  openDigestMarkEditor(el.dataset.markId);
});

/* 从记录页 / 全局搜索跳到某条总结上的标注 */
async function openDigestAtMark(markId) {
  let m = findDigestMark(markId);
  if (!m) {
    await loadDigestMarks(true).catch(() => {});
    m = findDigestMark(markId);
  }
  if (!m) { toast("标注不存在"); return; }
  closeGlobalSearch({ keepInput: true });
  await openDigestPanel({ day: m.day, slot: m.slot || "am", markId: m.id });
}
async function openNewsSource(raw) {
  const ids = String(raw || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return;
  try {
    const items = await Promise.all(ids.map((id) => api(`news/${id}`).catch(() => null)));
    const found = items.filter(Boolean);
    if (!found.length) { toast("原文已删除"); return; }
    const missing = ids.length - found.length;
    const html = found.map((n, i) => {
      const when = String(n.published_at || n.created_at || "").slice(0, 16);
      const meta = [when, n.source, n.level ? `${n.level} 级` : ""].filter(Boolean).map(esc).join(" · ");
      const body = String(n.body || "").trim();
      const showBody = body && body !== n.title && body !== n.source;
      return `<div class="np-item">
        <div class="np-meta">${i + 1}. ${meta}</div>
        <div class="np-title">${esc(n.title || "")}</div>
        ${showBody ? `<div class="np-body">${esc(body)}</div>` : `<div class="tiny muted" style="margin-top:6px">实时电报，站点只保存标题与发布时间。</div>`}
      </div>`;
    }).join("") + (missing ? `<div class="tiny muted" style="margin-top:10px">另有 ${missing} 条原文已删除</div>` : "");
    openSubSheet(found.length > 1 ? `来源 · ${found.length} 条` : "新闻原文", html);
  } catch (e) {
    toast(e.message || "原文已删除");
  }
}
document.addEventListener("click", (e) => {
  const a = e.target.closest(".dg-src");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  openNewsSource(a.dataset.news);
});

function renderDigests() {
  const box = $("#live-list");
  if (!box) return;
  const from = state.liveFrom || state.liveDay || "";
  const to = state.liveTo || state.liveDay || "";
  const all = (state.digests || []).filter((d) => (!from || d.day >= from) && (!to || d.day <= to));
  const items = all.slice(0, state.digestShown || 10);
  if (!items.length) {
    box.innerHTML = `<div class="empty-rich">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.6" y="4.6" width="16.8" height="15" rx="3"/><path d="M7 9.6h10M7 13h10M7 16.4h6"/></svg>
      <div class="er-t">这一天还没有总结</div><div class="er-d">早 08:00、晚 20:00 各生成一张</div></div>`;
    return;
  }
  const more = all.length > items.length
    ? `<button class="btn ghost small more-live" id="more-digest">查看更多（还有 ${all.length - items.length} 张）</button>`
    : "";
  box.innerHTML = items
    .map((d) => {
      const { lead, secs } = parseDigest(d.content);
      registerDigestRaw(d, { lead, secs });
      const mk = digestCardMarkState(d, { lead, secs });
      const secsHtml = secs
        .map((s, i) => `
          <div class="dg-sec${i < 4 ? " open" : ""}" data-sec="${i}">
            <button type="button" class="dg-h">
              <span class="dg-name">${esc(s.title)}</span>
              ${s.count != null ? `<span class="dg-n">${s.count} 条</span>` : ""}
              <span class="dg-x">⌄</span>
            </button>
            <ul class="dg-list">${s.items.map((x, j) => {
              const block = `s${i}i${j}`;
              return `<li class="dg-block" data-block="${block}">${digestTextHtml(x, mk.byBlock.get(block), mk.nums)}</li>`;
            }).join("")}</ul>
          </div>`)
        .join("");
      return `<div class="item digest-card" data-day="${esc(d.day)}" data-slot="${esc(d.slot || "am")}">
        <div class="meta"><span class="badge digest">新闻总结</span><span>${esc(String(d.day).slice(5))} ${esc(digestSlotLabel(d.slot))}</span>${d.total ? `<span class="dg-total">重点 ${d.total} 条</span>` : ""}${digestWhen(d) ? `<span class="dg-total">${esc(digestWhen(d))}</span>` : ""}</div>
        ${lead ? `<div class="dg-lead dg-block" data-block="lead">${digestTextHtml(lead, mk.byBlock.get("lead"), mk.nums)}</div>` : ""}
        ${secsHtml}
      </div>`;
    })
    .join("") + more;
  $$("#live-list .digest-card .dg-h").forEach((h) => {
    h.onclick = () => h.parentElement.classList.toggle("open");
  });
  const moreBtn = $("#more-digest");
  if (moreBtn) moreBtn.onclick = () => {
    state.digestShown = (state.digestShown || 10) + 10;
    renderDigests();
    // 本地还没拿到新展开的几张时才回服务端取：10 → 20 → 30，不一次背 60 张
    const need = Math.min(state.digestShown, state.digestTotal || 0);
    if ((state.digests || []).length < need) loadDigests(true, true).catch(() => {});
  };
}

/* ---------- 顶栏「新闻」：未读收件箱 / 已读 / 总结 ---------- */
const inbox = { tab: "unread", page: 1, size: 50, maxId: 0, pages: 1, total: 0, items: [], poll: null,
                level: "", levels: { A: 0, B: 0, C: 0 } };

function ibTime(n) { return String(n.published_at || n.created_at || "").slice(5, 16); }
function ibLevelHtml(n) {
  const lv = String(n.level || "").toUpperCase();
  return lv ? `<span class="badge lv-${lv}">${lv}</span>` : "";
}
function paintUnreadCount(n) {
  const el = $("#dg-unread-n");
  if (typeof n === "number") state.unreadTotal = n;
  if (el && typeof n === "number") el.textContent = String(n);
}
function renderNewBar(n) {
  const bar = $("#dg-newbar");
  if (!bar) return;
  if (!n || inbox.tab !== "unread") { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = `<button type="button" id="dg-join">有 ${n} 条新消息 · 点击并入</button>`;
  $("#dg-join").onclick = () => loadInbox(1, { joinNew: true });
}
function renderPager() {
  const pager = $("#dg-pager");
  if (!pager) return;
  const dg = $("#digest");
  if (inbox.tab !== "unread" || !inbox.total) {
    pager.classList.add("hidden");
    pager.innerHTML = "";
    if (dg) dg.classList.remove("dg-paging");
    return;
  }
  const pages = inbox.pages || 1;
  pager.classList.remove("hidden");
  if (dg) dg.classList.add("dg-paging");   // 列表底部留出浮动按钮的高度
  const arrow = (dir, d) => `<button class="pg-arrow" data-pg="${dir}"${d ? " disabled" : ""}
      aria-label="${dir === "next" ? "下一页" : "上一页"}"><svg viewBox="0 0 24 24" width="14" height="14"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="${dir === "next" ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7"}"/></svg></button>`;
  // 浮在列表右下角的竖排两个胶囊：翻页（上一页 / 页码 / 下一页）在上，本页已读在下。
  // 只有一页时不摆翻页胶囊，只留「本页已读」。
  const pagePill = pages > 1 ? `<div class="pg-pill">
    ${arrow("prev", inbox.page <= 1)}
    <span class="pg-meta" title="共 ${inbox.total} 条">${inbox.page}/${pages}</span>
    ${arrow("next", inbox.page >= pages)}
  </div>` : "";
  const check = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor"
      stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 6.5"/></svg>`;
  pager.innerHTML = `<div class="dg-pg-nav">
    ${pagePill}
    <button type="button" class="chip pg-read" id="dg-readpage">${check}<span>本页已读</span></button>
  </div>`;
  pager.querySelectorAll("[data-pg]").forEach((b) => {
    b.onclick = () => {
      const p = b.dataset.pg === "next" ? inbox.page + 1 : inbox.page - 1;
      if (p >= 1 && p <= pages) loadInbox(p);
    };
  });
  const rp = $("#dg-readpage");
  if (rp) rp.onclick = () => markPageRead();
}
/* 本页标已读：整页 id 交给服务端按同一快照取（页序与分页完全一致） */
async function markPageRead() {
  const page = inbox.page || 1;
  const btn = $("#dg-readpage");
  if (btn && btn.dataset.busy === "1") return;
  if (btn) { btn.dataset.busy = "1"; btn.disabled = true; }
  try {
    const r = await api("news/read-pages", {
      method: "POST",
      body: { pages: [page], size: inbox.size, max_id: inbox.maxId || null, level: inbox.level || null },
    });
    if (r && typeof r.unread_total === "number") paintUnreadCount(r.unread_total);
    toast(r && r.read ? `已标 ${r.read} 条已读` : "这页已经读过了");
  } catch (e) { toast(e.message); }
  // 读掉本页后同页号就是后面接着的未读：原地续读
  loadInbox(page);
}
function renderLevels() {
  const bar = $("#dg-levels");
  if (!bar) return;
  if (inbox.tab !== "unread") { bar.classList.add("hidden"); return; }
  const lv = inbox.levels || {};
  const nAll = (lv.A || 0) + (lv.B || 0) + (lv.C || 0);
  const mk = (k, label, n) =>
    `<button type="button" class="chip lv-chip${inbox.level === k ? " on" : ""}" data-dglv="${k}">${label}<span class="lv-n">${n}</span></button>`;
  bar.classList.remove("hidden");
  bar.innerHTML = mk("", "全部", nAll) + mk("A", "A", lv.A || 0)
    + mk("B", "B", lv.B || 0) + mk("C", "C", lv.C || 0);
}
function ibRowHtml(n, seq, extra = "") {
  return `<div class="ib-item${extra}" data-iid="${n.id}" data-seq="${seq}">
    <div class="ib-head"><span class="ib-seq">${seq}</span><span class="ib-time">${esc(ibTime(n))}</span>${ibLevelHtml(n)}<span class="ib-cat">${esc(n.category || "")}</span></div>
    <div class="ib-title">${esc(n.title || "")}</div>
  </div>`;
}
async function loadInbox(page = 1, { joinNew = false } = {}) {
  const body = $("#dg-body");
  if (!body) return;
  inbox.tab = "unread";
  if (joinNew) inbox.maxId = 0;
  body.innerHTML = `<div class="empty">加载中…</div>`;
  const q = `news/inbox?page=${page}&size=${inbox.size}&only=${inbox.only || "unread"}`
    + (inbox.maxId ? `&max_id=${inbox.maxId}` : "")
    + (inbox.level ? `&level=${inbox.level}` : "");
  const d = await api(q).catch(() => null);
  if (!d) { body.innerHTML = `<div class="empty">加载失败，稍后再试</div>`; return; }
  // 请求返回时用户可能已切到「已读 / 总结」：别用未读列表覆盖当前页
  if (inbox.tab !== "unread") return;
  if (!inbox.maxId) inbox.maxId = Number(d.max_id || 0);   // 本次阅读会话的边界
  inbox.page = Number(d.page || 1);
  inbox.pages = Number(d.pages || 1);
  inbox.total = Number(d.total || 0);
  inbox.items = d.items || [];
  if (d.levels) inbox.levels = d.levels;
  paintUnreadCount(Number(d.unread_total || 0));
  renderNewBar(Number(d.newer || 0));
  renderInbox();
}
function renderInbox() {
  const body = $("#dg-body");
  if (!body) return;
  const items = inbox.items || [];
  if (!items.length) {
    const what = inbox.level
      ? `没有 ${inbox.level} 级${inbox.only === "all" ? "新闻" : "未读新闻"}`
      : (inbox.only === "all" ? "还没有新闻" : "没有未读新闻");
    body.innerHTML = `<div class="empty">${inbox.page > 1 ? "这一页已读完" : what}</div>`;
    renderLevels();
    renderPager();
    return;
  }
  const base = (inbox.page - 1) * inbox.size;
  const all = inbox.only === "all";
  body.innerHTML = items.map((n, i) =>
    ibRowHtml(n, n.seq != null ? n.seq : base + i + 1, all && n.read_at ? " read" : "")).join("");
  bindInboxRows();
  renderLevels();
  renderPager();
}
/* 单击=展开/收起，双击=收藏（进「记录 · 新闻」，并从收件箱移除），长按=复制（原地不动）。
   单个条目的「已读」手势已取消：清未读走上面的「本页已读」。
   展开时收起要延后 240ms：否则双击的第一击会立刻把长正文缩回去，
   第二击落在下面的条目上，收藏就「失效」了（实时新闻那边同样处理）。 */
function bindInboxRows() {
  $$("#dg-body .ib-item").forEach((row) => {
    const id = Number(row.dataset.iid);
    let lastTap = 0, longTimer = null, collapseTimer = null;
    const clearLong = () => { if (longTimer) { clearTimeout(longTimer); longTimer = null; } };
    const clearCollapse = () => {
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    };
    row.addEventListener("pointerdown", () => {
      clearLong();
      clearCollapse();          // 第二击按下时别让上一条的收起定时器先缩回去
      longTimer = setTimeout(() => {
        longTimer = null;
        row.dataset.suppress = "1";
        state._lpAt = Date.now();
        if (navigator.vibrate) { try { navigator.vibrate(14); } catch (e) {} }
        copyInboxText(id, row);
      }, 520);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => row.addEventListener(ev, clearLong));
    row.addEventListener("contextmenu", (e) => e.preventDefault());   // 安卓 WebView 长按别弹系统菜单
    row.addEventListener("click", () => {
      if (row.dataset.suppress === "1") { delete row.dataset.suppress; return; }
      const now = Date.now();
      // 双击 → 收藏：窗口 420ms（手机双击常落在 300~400ms，原来的 320ms 会漏判）。
      if (now - lastTap < 420) {
        lastTap = 0;
        clearCollapse();
        favoriteFromInbox(id, row);
        return;
      }
      lastTap = now;
      // 展开立即生效；收起延后 240ms（给双击留时间，也避免第二击换行）
      if (row.classList.contains("open")) {
        clearCollapse();
        collapseTimer = setTimeout(() => {
          collapseTimer = null;
          row.classList.remove("open");
        }, 240);
      } else {
        clearCollapse();
        row.classList.add("open");
      }
    });
  });
}
/* 长按复制：时间 + 标题（正文比标题更全时一起带上） */
function copyInboxText(id, row) {
  const it = (inbox.items || []).find((x) => Number(x.id) === Number(id));
  const title = String((it && it.title) || (row.querySelector(".ib-title") || {}).textContent || "").trim();
  const bodyText = String((it && it.body) || "").trim();
  const when = String((it && (it.published_at || it.created_at)) || "").slice(5, 16);
  const main = bodyText && bodyText !== title ? `${title}\n${bodyText}` : title;
  const text = [when, main].filter(Boolean).join(" ");
  if (!text) return;
  copyText(text).then((ok) => { if (ok) toast("已复制"); else openCopySheet(text); });
}
function dropInboxRow(row) {
  row.classList.add("gone");
  setTimeout(() => {
    row.remove();
    if (!$$("#dg-body .ib-item").length && inbox.total > 0) loadInbox(inbox.page);
  }, 170);
}
/* 从本地收件箱状态里摘掉一条（同时扣掉它的级别计数，chip 上的数不用等下次加载） */
function dropFromInbox(id) {
  const it = (inbox.items || []).find((x) => Number(x.id) === Number(id));
  inbox.items = (inbox.items || []).filter((x) => Number(x.id) !== Number(id));
  inbox.total = Math.max(0, inbox.total - 1);
  const el = $("#dg-unread-n");
  if (el) paintUnreadCount(Math.max(0, Number(el.textContent || 0) - 1));
  if (it) {
    const lv = String(it.level || "").toUpperCase();
    const key = lv === "A" || lv === "B" ? lv : "C";
    if (inbox.levels) inbox.levels[key] = Math.max(0, Number(inbox.levels[key] || 0) - 1);
    renderLevels();
  }
}
async function favoriteFromInbox(id, row) {
  try {
    await api(`news/${id}/save`, { method: "POST", body: { saved: 1 } });
    toast("已收藏到记录 · 新闻");
    refreshSavedNews().catch(() => {});
    dropFromInbox(id);
    if (inbox.only === "all") {
      // 全量时间流里这条新闻不该整个消失，只是变成「已读」的样子
      row.classList.add("read");
      row.classList.remove("open");
    } else {
      dropInboxRow(row);
    }
  } catch (e) { toast(e.message); }
}

/* ---------- 新闻总结卡片（同一个面板的「总结」页） ---------- */
function digestCardHtml(d, idx) {
  const { lead, secs } = parseDigest(d.content);
  registerDigestRaw(d, { lead, secs });
  const mk = digestCardMarkState(d, { lead, secs });
  const secsHtml = secs
    .map((s, i) => `
      <div class="dg-sec${idx === 0 && i < 4 ? " open" : ""}" data-sec="${i}">
        <button type="button" class="dg-h">
          <span class="dg-name">${esc(s.title)}</span>
          ${s.count != null ? `<span class="dg-n">${s.count} 条</span>` : ""}
          <span class="dg-x">⌄</span>
        </button>
        <ul class="dg-list">${s.items.map((x, j) => {
          const block = `s${i}i${j}`;
          return `<li class="dg-block" data-block="${block}">${digestTextHtml(x, mk.byBlock.get(block), mk.nums)}</li>`;
        }).join("")}</ul>
      </div>`)
    .join("");
  return `<div class="item digest-card" data-day="${esc(d.day)}" data-slot="${esc(d.slot || "am")}">
    <div class="meta"><span class="badge digest">新闻总结</span><span>${esc(String(d.day).slice(5))} ${esc(digestSlotLabel(d.slot))}</span>${d.total ? `<span class="dg-total">重点 ${d.total} 条</span>` : ""}${digestWhen(d) ? `<span class="dg-total">${esc(digestWhen(d))}</span>` : ""}<button type="button" class="dg-read" id="dg-read" aria-label="朗读这张总结"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 9.5v5h3l4 3.5V6l-4 3.5z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.5 7.5 0 0 1 0 10.4"/></svg>朗读</button></div>
    ${lead ? `<div class="dg-lead dg-block" data-block="lead">${digestTextHtml(lead, mk.byBlock.get("lead"), mk.nums)}</div>` : ""}
    ${secsHtml || `<div class="empty">这个时段还没有内容</div>`}
  </div>`;
}
/* 总结页：早 / 晚 / 日期同一行，只显示选中日期的选中时段（一天两张卡）。
   默认看最新一张：出了晚报就在「晚」，只出了早报就在「早」；
   手动选日期后默认看该日「晚」，用户可再点「早」切换。 */
function bjTodayStr() {
  return new Date(Date.now() + (state.clockSkew || 8 * 3600e3)).toISOString().slice(0, 10);
}
function bjHourNow() {
  return new Date(Date.now() + (state.clockSkew || 8 * 3600e3)).getUTCHours();
}
function ensureDigestPick() {
  const latest = (state.digests || [])[0];
  if (!state.digestDay) {
    state.digestDay = (latest && latest.day) || state.digestToday || state.today || bjTodayStr();
  }
  if (state.digestSlot !== "am" && state.digestSlot !== "pm") {
    // 最新一张是晚报就默认「晚」，是早报就默认「早」；一张都没有时按当前时间猜一档
    state.digestSlot = latest ? (latest.slot === "pm" ? "pm" : "am")
      : (bjHourNow() < 12 ? "am" : "pm");
  }
}
function renderDigestSlots() {
  const bar = $("#dg-slots");
  if (!bar) return;
  if (inbox.tab !== "digest") { bar.classList.add("hidden"); return; }
  ensureDigestPick();
  bar.classList.remove("hidden");
  $$("#dg-slots .chip").forEach((b) => b.classList.toggle("on", b.dataset.dgslot === state.digestSlot));
  const inp = $("#dg-date");
  if (!inp) return;
  const today = state.digestToday || state.today || bjTodayStr();
  inp.max = today;
  inp.min = dayAdd(today, -(30 - 1));   // 库里只保留最近 30 天
  if (inp.value !== state.digestDay) inp.value = state.digestDay || "";
  const label = $("#dg-date-label");
  if (label) label.textContent = state.digestDay ? state.digestDay.slice(5) : "";
}
function renderDigestPanel() {
  const body = $("#dg-body");
  if (!body) return;
  $("#dg-newbar").classList.add("hidden");
  $("#dg-pager").classList.add("hidden");
  const dg = $("#digest");
  if (dg) dg.classList.remove("dg-paging");
  renderDigestSlots();
  ensureDigestPick();
  const day = state.digestDay;
  const slot = state.digestSlot;
  const all = state.digests || [];
  // day + slot 联合唯一：选中日期和时段最多只有一张卡
  const d = all.find((x) => x.day === day && (x.slot || "am") === slot);
  if (!d) {
    // 总结空着但还有未读资讯时，给一个直达「未读」的出口，别让人以为整个新闻是空的
    const un = Number(($("#dg-unread-n") || {}).textContent || 0) || Number(state.unreadTotal || 0);
    const unBtn = un ? `<button class="btn small" id="dg-go-unread">看 ${un} 条未读资讯</button>` : "";
    if (!all.length) {
      body.innerHTML = `<div class="empty-rich">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.6" y="4.6" width="16.8" height="15" rx="3"/><path d="M7 9.6h10M7 13h10M7 16.4h6"/></svg>
        <div class="er-t">还没有新闻总结</div><div class="er-d">早 08:00、晚 20:00 各生成一张</div>${unBtn}</div>`;
    } else {
      const other = all.find((x) => x.day === day && (x.slot || "am") !== slot);
      if (other) {
        const ol = other.slot === "pm" ? "晚" : "早";
        body.innerHTML = `<div class="empty-rich">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.6" y="4.6" width="16.8" height="15" rx="3"/><path d="M7 9.6h10M7 13h10M7 16.4h6"/></svg>
          <div class="er-t">这天只有${ol}报</div><div class="er-d">点上面的「${ol}」切换过去</div>${unBtn}</div>`;
      } else {
        body.innerHTML = `<div class="empty-rich">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3.6" y="4.6" width="16.8" height="15" rx="3"/><path d="M7 9.6h10M7 13h10M7 16.4h6"/></svg>
          <div class="er-t">${esc(dayLabel(day, state.digestToday || state.today))}暂无${slot === "pm" ? "晚报" : "早报"}</div>
          <div class="er-d">可能还没生成，或已超过 30 天保留期</div>${unBtn}</div>`;
      }
    }
    const b = $("#dg-go-unread");
    if (b) b.onclick = () => setDgTab("inbox");
    return;
  }
  // 换到别的日期/时段就停掉上一张的朗读；同一张卡加标注重绘时继续播
  if (dgTts.day && (dgTts.day !== d.day || dgTts.slot !== (d.slot || "am"))) ttsStop();
  // 加标注会重绘卡片：保留已经展开的分段和滚动位置，别把用户正在看的内容收起来
  const hadCard = !!body.querySelector(".digest-card");
  const openSecs = hadCard ? [...body.querySelectorAll(".dg-sec.open")].map((el) => el.dataset.sec) : null;
  const scrollTop = body.scrollTop;
  body.innerHTML = digestCardHtml(d, 0);
  if (openSecs) {
    body.querySelectorAll(".dg-sec").forEach((el) => {
      if (openSecs.includes(el.dataset.sec)) el.classList.add("open");
    });
  }
  body.scrollTop = scrollTop;
  requestAnimationFrame(() => { if (body.isConnected) body.scrollTop = scrollTop; });
  body.querySelectorAll(".digest-card .dg-h").forEach((h) => {
    h.onclick = () => h.parentElement.classList.toggle("open");
  });
  const readBtn = body.querySelector(".dg-read");
  if (readBtn) readBtn.onclick = () => startDigestTts(d);
  // 停留 1.5 秒就悄悄预热「重点」语音，等会儿点朗读不用干等
  scheduleTtsPrewarm(d);
}
/* ---------- 新闻总结朗读：服务端生成 MP3，播放条在总结面板底部 ---------- */
const TTS_RATES = [0.75, 1, 1.25, 1.5, 2];
const dgTts = {
  audio: null,
  seq: 0,
  timer: null,
  prewarmTimer: null,
  prewarmed: new Set(),
  day: "",
  slot: "",
  scope: "",
  ready: false,
  loading: false,
  duration: 0,
  rate: 1,
  dragging: false,
  ensureSeq: 0,
  idlePolls: 0,
  netFails: 0,
};
try {
  const saved = Number(localStorage.getItem("ttsRate"));
  if (TTS_RATES.includes(saved)) dgTts.rate = saved;
} catch (e) { /* localStorage 不可用就用默认 1x */ }

function ttsFmtTime(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
           : `${m}:${String(s).padStart(2, "0")}`;
}
function ttsScopePref() {
  try { return localStorage.getItem("ttsScope") === "full" ? "full" : "key"; }
  catch (e) { return "key"; }
}
function ttsPaintScope(scope) {
  $$("#dg-player [data-dgscope]").forEach((b) =>
    b.classList.toggle("on", b.dataset.dgscope === scope));
}
function ttsPaintRate() {
  const b = $("#dgp-rate");
  if (!b) return;
  b.textContent = (Number.isInteger(dgTts.rate) ? Number(dgTts.rate).toFixed(1) : String(dgTts.rate)) + "x";
}
function ttsSetState(txt) {
  const el = $("#dgp-state");
  if (el) el.textContent = txt || "";
}
function ttsSetPlayIcon(playing) {
  const b = $("#dgp-play");
  if (b) b.textContent = playing ? "❚❚" : "▶";
}
function ttsPaintTime() {
  const a = dgTts.audio;
  const cur = a ? Number(a.currentTime) || 0 : 0;
  let dur = Number(dgTts.duration) || 0;
  if (a && isFinite(a.duration) && a.duration > 0) dur = a.duration;
  const seek = $("#dgp-seek");
  if (seek && !dgTts.dragging) {
    seek.max = dur ? String(dur) : "0";
    seek.value = String(Math.min(cur, dur || 0));
  }
  const time = $("#dgp-time");
  if (time) time.textContent = `${ttsFmtTime(cur)} / ${ttsFmtTime(dur)}`;
}
function ttsFileUrl(day, slot, scope, key) {
  let url = `${API}/digest/tts/file?day=${encodeURIComponent(day)}&slot=${encodeURIComponent(slot)}&scope=${encodeURIComponent(scope)}`;
  if (key) url += `&v=${encodeURIComponent(key)}`;
  return url;
}
function ttsStatusPath(day, slot, scope) {
  return `digest/tts/status?day=${encodeURIComponent(day)}&slot=${encodeURIComponent(slot)}&scope=${encodeURIComponent(scope)}`;
}

function ttsAudio() {
  if (dgTts.audio) return dgTts.audio;
  const a = new Audio();
  a.preload = "auto";
  a.playbackRate = dgTts.rate;
  a.addEventListener("loadedmetadata", () => {
    // 切换音源时旧请求的 metadata 可能晚到：当前源已经不可用就别理它
    if (a.networkState === 3) return;
    dgTts.ready = true;
    dgTts.loading = false;
    if (isFinite(a.duration) && a.duration > 0) dgTts.duration = a.duration;
    ttsPaintTime();
  });
  a.addEventListener("timeupdate", ttsPaintTime);
  a.addEventListener("play", () => {
    dgTts.ready = true;
    dgTts.loading = false;
    ttsSetPlayIcon(true);
    ttsSetState("正在播放");
  });
  a.addEventListener("pause", () => {
    ttsSetPlayIcon(false);
    if (!dgTts.loading && !a.ended && dgTts.day) ttsSetState("已暂停");
  });
  a.addEventListener("ended", () => {
    ttsSetPlayIcon(false);
    ttsSetState("播放完毕");
    ttsPaintTime();
  });
  a.addEventListener("error", () => {
    if (!a.getAttribute("src") || !dgTts.day) return;
    if (dgTts.loading) {
      // 文件还没生成（409）时 play() 会转去生成；这里兜底，别先闪一下「播放失败」
      const seq = dgTts.seq;
      setTimeout(() => {
        if (seq === dgTts.seq && dgTts.loading && !dgTts.ready) ttsMaybeEnsure(seq);
      }, 400);
      return;
    }
    if (dgTts.ready) {
      ttsSetPlayIcon(false);
      ttsSetState("播放失败，点 ▶ 重试");
      return;
    }
    ttsMaybeEnsure(dgTts.seq);
  });
  dgTts.audio = a;
  return a;
}

/* 关闭 / 换卡时彻底收掉播放条 */
function ttsStop() {
  dgTts.seq++;
  if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
  dgTts.ready = false;
  dgTts.loading = false;
  dgTts.duration = 0;
  dgTts.ensureSeq = 0;
  dgTts.idlePolls = 0;
  dgTts.netFails = 0;
  dgTts.day = dgTts.slot = dgTts.scope = "";
  const a = dgTts.audio;
  if (a) {
    try { a.pause(); a.removeAttribute("src"); a.load(); } catch (e) { /* 忽略 */ }
  }
  ttsSetPlayIcon(false);
  ttsSetState("");
  const seek = $("#dgp-seek");
  if (seek) { seek.max = "0"; seek.value = "0"; }
  const time = $("#dgp-time");
  if (time) time.textContent = "0:00 / 0:00";
  const player = $("#dg-player");
  if (player) player.classList.add("hidden");
}

function startDigestTts(d) {
  if (!d || !d.day) return;
  const slot = d.slot || "am";
  const scope = ttsScopePref();
  ttsPlayerShow();
  ttsPaintScope(scope);
  ttsPaintRate();
  if (dgTts.day === d.day && dgTts.slot === slot && dgTts.scope === scope) {
    if (dgTts.ready || dgTts.loading) { ttsTogglePlay(); return; }
  }
  ttsLoad(d, scope, true);
}
function ttsPlayerShow() {
  const p = $("#dg-player");
  if (p) p.classList.remove("hidden");
}

/* 直接给 audio 挂上文件地址：缓存已生成就能同步播；没生成时 409 会自动转去轮询 */
function ttsLoad(d, scope, autoplay) {
  const seq = ++dgTts.seq;
  if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
  dgTts.day = d.day;
  dgTts.slot = d.slot || "am";
  dgTts.scope = scope;
  dgTts.ready = false;
  dgTts.loading = true;
  dgTts.duration = 0;
  dgTts.ensureSeq = 0;
  dgTts.idlePolls = 0;
  dgTts.netFails = 0;
  ttsPlayerShow();
  ttsPaintScope(scope);
  ttsPaintRate();
  ttsSetPlayIcon(false);
  ttsSetState("加载中…");
  const seek = $("#dgp-seek");
  if (seek) { seek.max = "0"; seek.value = "0"; }
  const a = ttsAudio();
  try { a.pause(); } catch (e) { /* 忽略 */ }
  a.playbackRate = dgTts.rate;
  a.src = ttsFileUrl(dgTts.day, dgTts.slot, scope);
  ttsPaintTime();
  if (!autoplay) return;
  const p = a.play();
  if (p && p.catch) p.catch((err) => {
    if (seq !== dgTts.seq || (err && err.name === "AbortError")) return;
    if (err && err.name === "NotAllowedError") {
      dgTts.loading = false;
      ttsSetState("点 ▶ 播放");
    } else {
      ttsMaybeEnsure(seq);
    }
  });
}

function ttsTogglePlay() {
  const a = ttsAudio();
  if (!dgTts.day) { toast("先打开一张总结"); return; }
  if (!dgTts.ready && a.getAttribute("src") && a.readyState >= 2) dgTts.ready = true;
  if (dgTts.ready && a.error) {
    // 播放过程中网络断了：重新拉一次文件，别只按一下 play
    const d = currentDigestCard();
    if (d) ttsLoad(d, dgTts.scope || ttsScopePref(), true);
    return;
  }
  if (dgTts.loading && a.readyState < 2) { toast("语音还在准备，稍等一下"); return; }
  if (!dgTts.ready) {
    const d = currentDigestCard();
    if (d) ttsLoad(d, dgTts.scope || ttsScopePref(), true);
    return;
  }
  if (a.paused) {
    if (a.ended) a.currentTime = 0;
    a.play().catch((err) => {
      if (!err || err.name !== "AbortError") ttsSetState("点 ▶ 播放");
    });
  } else {
    a.pause();
  }
}

function ttsMaybeEnsure(seq) {
  if (seq !== dgTts.seq || dgTts.ensureSeq === seq) return;
  dgTts.ensureSeq = seq;
  ttsEnsure(seq);
}

async function ttsEnsure(seq) {
  if (seq !== dgTts.seq) return;
  const day = dgTts.day, slot = dgTts.slot, scope = dgTts.scope;
  if (!day) return;
  dgTts.loading = true;
  ttsSetState("正在准备语音…");
  let r = null;
  try {
    r = await api("digest/tts", { method: "POST", body: { day, slot, scope }, idempotent: true });
  } catch (e) {
    if (seq !== dgTts.seq) return;
    dgTts.loading = false;
    dgTts.ensureSeq = 0;
    ttsSetState("准备失败，点 ▶ 重试");
    toast(`语音准备失败：${e.message}`);
    return;
  }
  if (seq !== dgTts.seq) return;
  if (r && r.error) {
    dgTts.loading = false;
    dgTts.ensureSeq = 0;
    ttsSetState("生成失败，点 ▶ 重试");
    toast(`语音生成失败：${r.error}`);
    return;
  }
  if (r && r.ready) { ttsUseReady(seq, r); return; }
  ttsPoll(seq);
}

function ttsPoll(seq) {
  if (seq !== dgTts.seq) return;
  if (dgTts.timer) clearInterval(dgTts.timer);
  const tick = async () => {
    if (seq !== dgTts.seq) return;
    const day = dgTts.day, slot = dgTts.slot, scope = dgTts.scope;
    if (!day) return;
    let r = null;
    try {
      r = await api(ttsStatusPath(day, slot, scope));
      dgTts.netFails = 0;
    } catch (e) {
      if (seq !== dgTts.seq) return;
      if (e && e.message === "未登录") {
        if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
        dgTts.loading = false;
        ttsSetState("登录已过期");
        return;
      }
      // 隧道偶尔抖一下：继续轮询，别马上判失败
      dgTts.netFails = (dgTts.netFails || 0) + 1;
      if (dgTts.netFails > 5) {
        if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
        dgTts.loading = false;
        dgTts.ensureSeq = 0;
        ttsSetState("网络不稳定，点 ▶ 重试");
      } else {
        ttsSetState("网络不稳定，重试中…");
      }
      return;
    }
    if (seq !== dgTts.seq || !r) return;
    if (r.ready) {
      if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
      ttsUseReady(seq, r);
      return;
    }
    if (r.error) {
      if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
      dgTts.loading = false;
      ttsSetState("生成失败，点 ▶ 重试");
      toast(`语音生成失败：${r.error}`);
      return;
    }
    if (r.generating) {
      dgTts.loading = true;
      dgTts.idlePolls = 0;
      const p = r.progress || {};
      ttsSetState(p.total ? `生成中 ${p.done}/${p.total}…` : "生成中…");
      return;
    }
    // 刚 POST 还没拿到锁：再等几拍；一直不开始就提示重试
    dgTts.idlePolls = (dgTts.idlePolls || 0) + 1;
    if (dgTts.idlePolls > 8) {
      if (dgTts.timer) { clearInterval(dgTts.timer); dgTts.timer = null; }
      dgTts.loading = false;
      dgTts.ensureSeq = 0;
      ttsSetState("还没开始，点 ▶ 重试");
    } else {
      ttsSetState("准备中…");
    }
  };
  tick();
  dgTts.timer = setInterval(tick, 2500);
}

