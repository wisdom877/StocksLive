function openWorkTypeManager() {
  const types = (state.work && state.work.types) || [];
  openSheet("工作类型", types.length
    ? `<div class="wk-typelist">${types.map((t) => `<div class="wk-typerow" data-wktyperow="${t.id}">
        <span class="wk-tn">${esc(t.name)}</span><span class="wk-tc">${t.count || 0} 条</span><span class="wk-chev" aria-hidden="true">›</span>
      </div>`).join("")}</div>
      <div class="sheet-actions"><button class="btn ghost" id="wk-type-new">＋ 新建类型</button></div>`
    : `<div class="wk-tip">还没有类型，先建一个，比如「开发」「运营」。</div>
      <div class="sheet-actions"><button class="btn primary" id="wk-type-new">＋ 新建类型</button></div>`);
  $$("#sheet [data-wktyperow]").forEach((r) => {
    r.onclick = () => openWorkTypeEditor(Number(r.dataset.wktyperow));
  });
  const nb = $("#wk-type-new");
  if (nb) nb.onclick = () => openWorkTypeEditor(null);
}

function openWorkTypeEditor(tid) {
  const ty = tid ? ((state.work && state.work.types) || []).find((x) => Number(x.id) === Number(tid)) : null;
  // 已经有一层弹层（类型管理）时，编辑器开在它上面，关掉只退回管理列表
  const asSub = anySheetOpen();
  const open = asSub ? openSubSheet : openSheet;
  const close = asSub ? closeSubSheet : closeSheet;
  open(ty ? "编辑工作类型" : "新建工作类型", `
    <div class="wk-form">
    <div class="field"><label for="wk-t-name">名称</label><input id="wk-t-name" maxlength="24" placeholder="例如：开发 / 运营 / 写作" value="${esc(ty ? ty.name : "")}"></div>
    ${ty ? `<div class="wk-tip">这个类型下有 ${ty.count || 0} 条日程，删除会一并删掉</div>` : ""}
    <div class="sheet-actions"><button class="btn primary" id="wk-t-save">保存</button>${ty ? '<button class="btn danger" id="wk-t-del">删除类型</button>' : ""}</div>
    </div>`);
  const save = $("#wk-t-save");
  save.onclick = async () => {
    const name = ($("#wk-t-name").value || "").trim();
    if (!name) return toast("请填名称");
    save.disabled = true;
    try {
      if (ty) await api(`work/types/${ty.id}`, { method: "PATCH", idempotent: true, body: { name } }, 20000);
      else await api("work/types", { method: "POST", idempotent: true, body: { name } }, 20000);
      close();
      if (asSub) openWorkTypeManager();
      toast(ty ? "已更新" : "已创建");
      loadWork(true).catch(() => {});
    } catch (e) { save.disabled = false; toast(e.message || "保存失败"); }
  };
  const del = $("#wk-t-del");
  if (del) del.onclick = async () => {
    if (del.dataset.arm !== "1") {
      del.dataset.arm = "1";
      del.textContent = `确认删除（含 ${ty.count || 0} 条日程）？`;
      setTimeout(() => { if (del.dataset.arm === "1") { del.dataset.arm = ""; del.textContent = "删除类型"; } }, 3000);
      return;
    }
    del.disabled = true; del.textContent = "删除中…";
    try {
      await api(`work/types/${ty.id}`, { method: "DELETE" });
      state.wkType = "";
      close();
      if (asSub) openWorkTypeManager();
      toast("已删除");
      loadWork(true).catch(() => {});
    } catch (e) {
      del.disabled = false; del.dataset.arm = ""; del.textContent = "删除类型";
      toast(e.message || "删除失败");
    }
  };
}

/* ---- 到点提醒：声音 + 震动 + 系统通知 + 全屏卡 ---- */
function wkAudio() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!state.wkAC) state.wkAC = new C();
  if (state.wkAC.state === "suspended") state.wkAC.resume().catch(() => {});
  return state.wkAC;
}
function wkTone() {
  // 壳里改由原生播放（Web Audio 在 WKWebView 里会被挂起/静音，经常一点声都没有）
  const h = wkNativeHandler();
  if (h) {
    try { h.postMessage({ cmd: "tone", loop: !!state.wkRing }); return; } catch (e) {}
  }
  try {
    const ac = wkAudio();
    if (!ac) return;
    const t0 = ac.currentTime;
    [0, 0.42].forEach((off) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(988, t0 + off);
      o.frequency.setValueAtTime(1318, t0 + off + 0.16);
      g.gain.setValueAtTime(0.0001, t0 + off);
      g.gain.exponentialRampToValueAtTime(0.42, t0 + off + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.34);
      o.connect(g).connect(ac.destination);
      o.start(t0 + off); o.stop(t0 + off + 0.38);
    });
  } catch (e) {}
}
function wkVibe() {
  const h = wkNativeHandler();
  if (h) { try { h.postMessage({ cmd: "vibe" }); return; } catch (e) {} }
  try { if (navigator.vibrate) navigator.vibrate([320, 130, 320, 130, 520]); } catch (e) {}
}
function wkStartRing() {
  if (state.wkRing) return;
  state.wkRing = true;
  // 壳里一条 ring 消息同时「震 + 响」；没有壳（纯浏览器）才退回网页自己发声
  const beat = () => {
    const h = wkNativeHandler();
    // 只有认 ring 的新壳才走一条消息；老壳仍然退回 tone+vibe，不会变成哑巴
    if (h && window.wkNativeCap && window.wkNativeCap.ring) {
      try { h.postMessage({ cmd: "ring", loop: !!state.wkRing }); return; } catch (e) {}
    }
    wkTone(); wkVibe();
  };
  beat();
  state.wkRingTimer = setInterval(beat, 2400);
}
function wkStopRing(task) {
  const h = wkNativeHandler();
  if (h) {
    // 壳里的循环铃声是靠「tone + loop:false」停的；只发 stop/ringStop 有些壳不认，会一直响下去
    // 只发一条停铃：每条桥消息在壳里都是一次音频会话切换，连着发 4 条会把主线程顶住几秒
    try { h.postMessage({ cmd: "ringStop" }); } catch (e) {}
    // 撤通知、停震动这些不着急，等面板收完再发
    setTimeout(() => {
      try { h.postMessage({ cmd: "vibe", stop: true }); } catch (e) {}
      try { h.postMessage({ cmd: "stop", id: task ? String(task.id) : "" }); } catch (e) {}
    }, 320);
  }
  state.wkRing = false;
  if (state.wkRingTimer) { clearInterval(state.wkRingTimer); state.wkRingTimer = null; }
  try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
}
function wkNotify(t) {
  try {
    if (window.Notification && Notification.permission === "granted") {
      new Notification("日程到点：" + t.title, {
        body: `${String(t.due_at).slice(11)} · ${wkTypeName(t.type_id)}`,
        tag: "wk-" + t.id, renotify: true,
      });
    }
  } catch (e) {}
}
/* ---- 原生桥（iOS 壳 1.2+）：日程交给系统通知，后台/锁屏也能响 ---- */
function wkNativeHandler() {
  return (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wkNative) || null;
}
function wkPushNative() {
  const h = wkNativeHandler();
  if (!h) return;
  const tasks = wkAlarms().map((a) => ({
    id: String(a.id), title: a.title, when: a.when, meta: a.meta || "", note: a.note || "",
  }));
  try { h.postMessage({ cmd: "sync", tasks }); } catch (e) {}
}
window.wkPushNative = wkPushNative;
window.wkToneResult = (msg) => {
  state.wkToneMsg = String(msg || "");
  if (state.wkToneMsg && state.wkToneMsg !== "ok") toast("铃声失败：" + state.wkToneMsg);
};
// 第 4 个参数是壳回传的真实状态：{auth: yes|no|ask, pending: 已排进系统的条数, err: 最近一次错误}
window.wkNativeState = (ok, hasSound, standby, info) => {
  state.wkNative = !!ok;
  state.wkStandby = (standby === undefined) ? false : !!standby;   // 默认不保活，省电优先
  state.wkNpInfo = (info && typeof info === "object") ? info : null;
  wkRenderNpInfo();
  if (state.wkNative && state.work) { try { wkPushNative(); } catch (e) {} }
};
/* 「到点提醒」面板里那一行系统通知状态：权限、排了几条、有没有出错。拍完图就不再变，所以每次回传都重画 */
function wkRenderNpInfo() {
  const el = $("#wk-np-info");
  if (!el) return;
  const i = state.wkNpInfo;
  const perm = i && i.auth === "no" ? "权限被拒 —— 到点不会发系统通知"
    : i && i.auth === "ask" ? "权限还没选 —— 重新打开 App 时会再问一次"
    : i ? "权限已授权" : (state.wkNative ? "权限已授权" : "未授权");
  const n = i ? i.pending : null;
  el.innerHTML = `<span class="wk-perm">${perm}${n === null ? "" : ` · 已排进系统 ${n} 条`}</span>` +
    (i && i.err ? `<em class="wk-np-err">${esc(i.err)}</em>` : "") +
    (i && i.auth === "no" ? `<button type="button" class="chip" id="wk-np-set">去设置</button>` : "");
  const b = $("#wk-np-set");
  if (b) b.onclick = () => { try { wkNativeHandler().postMessage({ cmd: "openSettings" }); } catch (e) {} }
};
/* 通知 id 的前缀就是提醒类型：t日程 / m专注 / s值班 / d每日 */
function wkAlarmKindOf(id) {
  const s = String(id || "");
  if (s[0] === "t") return "task";
  if (s[0] === "m") return "focus";
  if (s[0] === "s") return "shift";
  if (s[0] === "d") return "daily";
  return "";
}
/* 点通知进来先把 App 切到这条提醒所在的那一屏（专注→专注、值班→班表、日程/每日→安排），
   否则卡片弹在行情页上，用户还得自己找过去；顺带把工作数据拉起来，卡片才有内容可显示 */
function wkAlarmRoute(kind) {
  // 待机开着的时候绝不切页面：待机是横屏、应用是竖屏，一切过去整屏就翻了
  if (typeof sbIsOn === "function" && sbIsOn()) return;
  const pane = kind === "focus" ? "focus" : kind === "shift" ? "shift" : "sch";
  try {
    if (state.view !== "work") setView("work");
    wkSetPane(pane);
  } catch (e) {}
  if (!state.work) { try { loadWork(true).catch(() => {}); } catch (e) {} }
}

/* 冷启动点通知时页面可能还在登录 / 加载：App 外壳没露出来之前先等，别把这次通知吃掉 */
let _wkNativeAid = null, _wkNativeT0 = 0;
function wkNativeReady() {
  const a = $("#app");
  return !!(a && !a.classList.contains("hidden"));
}
function wkNativeRetry(aid) {
  if (_wkNativeAid === aid) return;
  _wkNativeAid = aid; _wkNativeT0 = Date.now();
  const tick = () => {
    if (!_wkNativeAid) return;
    if (wkNativeReady()) { const a = _wkNativeAid; _wkNativeAid = null; window.wkNativeAlarm(a); return; }
    if (Date.now() - _wkNativeT0 > 120000) { _wkNativeAid = null; return; }
    setTimeout(tick, 400);
  };
  setTimeout(tick, 200);
}

window.wkNativeAlarm = (id) => {
  const aid = String(id);
  if (!wkNativeReady() && !(typeof sbIsOn === "function" && sbIsOn())) { wkNativeRetry(aid); return; }
  // 正在待机：数据拉起来就行，卡片交给待机自己上滑显示
  if (typeof sbIsOn === "function" && sbIsOn() && !state.work) {
    try { loadWork(true).catch(() => {}); } catch (e) {}
  }
  // 先跳页面：这一步同时会把工作数据拉起来（冷启动点通知也能落在那条提醒的屏幕上）
  wkAlarmRoute(wkAlarmKindOf(aid));
  // 刚点过「知道了」的同一只通知（2 分钟内）不再弹第二遍；再点一次确实想看，还是给卡
  if (aid === state.wkAlarmDismissed && Date.now() - (state.wkAlarmDismissedAt || 0) < 120000) return;
  // 工作数据还没到（冷启动点开、或页面刚刷新）：先弹一张按 id 类型认脸的卡把铃声关掉的路留出来，
  // 同时记下这次通知，loadWork 回来后再换成真实标题和下一步
  if (!state.work) {
    state.wkPendingAlarm = aid;
    const kind = wkAlarmKindOf(aid);
    const known = wkAlarmById(aid);
    wkAlarmShow(known ? { ...known, meta: "正在读取提醒内容…" } : { id: aid, kind: kind || "task",
      title: kind === "focus" ? "专注提醒" : kind === "shift" ? "上班提醒" : kind === "daily" ? "每日提醒" : "到点提醒",
      meta: "正在读取提醒内容…" });
    return;
  }
  const a = wkAlarms().find((x) => x.id === aid);
  if (a && a.kind !== "task") { wkAlarmShow(a); return; }   // 专注 / 值班：进应用后继续响，直到按「知道了」
  const rawId = aid.replace(/^t/, "");
  const t = ((state.work && state.work.tasks) || []).find((x) => String(x.id) === rawId);
  if (t) {
    if (!t.notified_at) {
      t.notified_at = wkNow();
      api(`work/tasks/${t.id}`, { method: "PATCH", body: { notified_at: t.notified_at } }).catch(() => {});
    }
    wkRing(t, false);   // 进应用后接着响 / 震，和日程一致
    return;
  }
  // 找不到对应提醒（已删、已改期、或 id 和本地数据对不上）也要给一张能关掉铃声的卡，
  // 而且类型跟着 id 前缀走，别把专注提醒写成「日程到点」
  const kind = wkAlarmKindOf(aid);
  const known = wkAlarmById(aid);
  if (known) { wkAlarmShow(known, false); return; }
  const fallback = kind === "focus" ? { kind, title: "专注提醒", meta: "这条专注提醒已经到点，铃声还在响" }
    : kind === "shift" ? { kind, title: "上班提醒", meta: "这条上班提醒已经到点，铃声还在响" }
    : kind === "daily" ? { kind, title: "每日提醒", meta: "这条每日提醒已经到点，铃声还在响" }
    : { kind: "task", task: null, title: "日程到点", meta: "这条日程已经到点，铃声还在响" };
  wkAlarmShow({ id: aid, ...fallback }, true);
};
// app-base.js 在首个脚本里就摆了一个「先攒着」的同名占位函数：
// 壳在 didFinish 那一刻调 wkNativeAlarm 时哪怕本文件还没执行完，id 也不会丢，在这里倒出来补一遍
(function wkDrainEarlyAlarm() {
  const q = window.__wkAlarmQ;
  if (!q || !q.length) return;
  window.__wkAlarmQ = [];
  q.forEach((id) => { try { window.wkNativeAlarm(id); } catch (e) {} });
  setTimeout(wkDrainEarlyAlarm, 500);   // 本文件之后才到的一次性补
})();

// 数据回来后把攒着的那次补弹
function wkFlushPendingAlarm() {
  const id = state.wkPendingAlarm;
  if (!id) return;
  state.wkPendingAlarm = null;
  // 冷启动那张临时卡已经被点掉（同一只通知），数据回来就别再弹第二遍
  if (id === state.wkAlarmDismissed) return;
  try { window.wkNativeAlarm(id); } catch (e) {}
}

/* 只凭提醒 id（m<模式>_<步>_<日期>[_end]）复原一张专注卡：数据还没拉到时也能显示真标题，
   而且这条 id 的「知道了」照样能把这一步勾掉 */
function wkAlarmById(aid) {
  const m = /^m(\d+)_(\d+)_(\d{4}-\d{2}-\d{2})(_end)?$/.exec(String(aid || ""));
  if (!m) return null;
  const mode = ((wkFocusData().modes) || []).find((x) => Number(x.id) === Number(m[1]));
  if (!mode) return null;
  const st = ((mode.steps) || [])[Number(m[2])] || {};
  const total = ((mode.steps) || []).filter((x) => x && x.anchor).length;
  const tail = `${mode.name} · 第 ${Number(m[2]) + 1}/${total} 步 · ${Number(st.minutes) || 0} 分钟`;
  return m[4]
    ? { id: String(aid), kind: "focus", title: `专注 · ${st.title} 结束`, meta: tail }
    : { id: String(aid), kind: "focus", title: `专注 · ${st.title}`, meta: tail };
}

function wkAlarmShow(a, silent) {
  // 正在编辑弹层时先不糊卡，等弹层关掉再弹
  if (anySheetOpen()) { state.wkAlarmPending = a; return; }
  state.wkAlarmPending = null;
  state.wkAlarm = a;
  // 待机里：不弹全屏卡、不退出待机，改成在待机底部上滑一条待处理面板。
  // 全屏那张卡带 backdrop-filter，盖在待机的玻璃面板上，点一下要整屏重绘，就是「卡一会」的来源。
  if (typeof sbIsOn === "function" && sbIsOn() && typeof sbDueShow === "function") {
    sbDueShow(a);
    if (!silent) { wkStartRing(); if (a.kind === "task" && a.task) wkNotify(a.task); }
    return;
  }
  const box = $("#wk-alarm");
  const tt = $("#wka-title"), mm = $("#wka-meta");
  if (tt) tt.textContent = a.title || "";
  if (mm) mm.textContent = a.meta || "";
  const snooze = $("[data-wka-snooze]"), off = $("[data-wka-off]");
  const noTask = a.kind === "task" && !a.task;
  const kindLabel = $("#wka-kind");
  if (kindLabel) kindLabel.textContent = a.kind === "focus" ? "专注提醒" : a.kind === "shift" ? "上班提醒" : a.kind === "daily" ? "每日提醒" : "日程到点";
  // 只有「某步结束」且这场正在跑，点掉才有「进入下一步 / 跳过这一步」的语义；
  // 「某步开始」点掉只是别响了，绝不能顺手把场次往前推
  const focusEnd = a.kind === "focus" && /_end$/.test(String(a.id || "")) && !!a.runId;
  if (snooze) {
    snooze.textContent = focusEnd ? "跳过这一步" : a.kind === "shift" ? "知道了" : "10 分钟后再提醒";
    snooze.dataset.hide = a.kind === "shift" ? "1" : "";
    snooze.style.display = (a.kind === "shift" || noTask || (a.kind === "focus" && !focusEnd)) ? "none" : "";
  }
  if (off) off.textContent = focusEnd ? "进入下一步" : "知道了";
  if (box) box.classList.remove("hidden");
  document.body.classList.add("wk-ringing");
  if (!silent) { wkStartRing(); if (a.kind === "task" && a.task) wkNotify(a.task); }
}

// 这一次该几点响：snooze_at 只对「今天这一条」有效，跨天自动作废，due_at 永远不动
function wkDue(t) {
  const s = String((t && t.snooze_at) || "");
  const due = String((t && t.due_at) || "");
  if (!s) return due;
  if (s.slice(0, 10) !== wkNow().slice(0, 10)) return due;
  return s > due ? s : due;
}
function wkRing(task, silent) {
  wkAlarmShow({ kind: "task", id: "t" + task.id, task,
    title: task.title,
    meta: `${String(wkDue(task)).slice(11)} · ${wkTypeName(task.type_id)}${task.note ? " · " + task.note : ""}` }, silent);
}

function wkCheckTasks(windowMin = 30) {
  const tasks = (state.work && state.work.tasks) || [];
  if (!tasks.length) return;
  // 系统通知只负责「锁屏/后台」那一声；回到 App 里仍然要弹「知道了 / 10 分钟后再提醒」这张卡，
  // 否则用户没法把这条日程关掉。重复弹的保护交给下面的 state.wkAlarm 判断。
  const now = wkNow();
  // 回到 App 时窗口放宽到今天 0 点：早上错过的日程也能弹出卡片关掉；
  // 平时每 15 秒的轮询只看 30 分钟内的，避免一直弹旧账。
  // 截止线按北京时间算（原来用设备本地 Date 取，非 +8 时区会把该弹的判成过期）
  const cut = windowMin > 0 ? wkFmtMin(wkNowMs() - windowMin * 60000) : `${now.slice(0, 10)} 00:00`;
  // 30 分钟以前就过点的
  tasks.filter((t) => !t.done && !t.notified_at && t.due_at && wkDue(t) < cut)
    .forEach((t) => { t.notified_at = now; api(`work/tasks/${t.id}`, { method: "PATCH", body: { notified_at: now } }).catch(() => {}); });
  if (state.wkAlarm) return;
  const due = tasks.filter((t) => !t.done && !t.notified_at && t.due_at && wkDue(t) <= now && wkDue(t) >= cut);
  if (!due.length) return;
  const t = due.sort((a, b) => (wkDue(a) < wkDue(b) ? 1 : -1))[0];
  // 只弹最近的一条；更早到点的留着不动，等这张关掉后下一轮轮询再弹
  // （以前这里把其他几条直接标成已通知，等于静默吞掉了它们）
  t.notified_at = now;
  api(`work/tasks/${t.id}`, { method: "PATCH", body: { notified_at: now } }).catch(() => {});
  wkRing(t);
}

function wkCheckDue() {
  wkCheckTasks();
  wkCheckExtra();
}

function wkArm() {
  if (state.wkArmed) return;
  state.wkArmed = true;
  setInterval(wkCheckDue, 15000);
  // 提醒都落在整分上：再补一个「每到整分后 1 秒」的检查，别让卡片最多晚 15 秒才弹
  const wkArmMinute = () => {
    setTimeout(() => { if (!document.hidden) wkCheckDue(); wkArmMinute(); },
      60000 - (Date.now() % 60000) + 1000);
  };
  wkArmMinute();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { try { if (state.wkNative) wkPushNative(); } catch (e) {} return; }
    wkCheckTasks(0);        // 从后台回来：把今天错过的最近一条补弹出来
    wkCheckExtra(true);     // 壳里也要补弹（比如点了通知才进的 App）
    // 卡片还在但铃声停了（壳把系统铃声收走了）→ 接着响，直到按「知道了」
    if (state.wkAlarm && !state.wkRing) wkStartRing();
  });
  ["pointerdown", "touchstart", "keydown"].forEach((ev) => {
    document.addEventListener(ev, () => { if (!state.wkRing) wkAudio(); }, { once: true, passive: true });
  });
}

$("#wk-add").addEventListener("click", () => openWorkTaskEditor(null));

function openWkRemindSettings() {
  const native = !!wkNativeHandler();
  const perm = window.Notification ? Notification.permission : "unsupported";
  if (native) {
    openSheet("到点提醒", `
      <div class="wk-form">
      <div class="wk-tip">到点由 App 自己放铃声（媒体音量，<b>静音拨片也照响</b>），一直响到点「知道了」；同时每 1.6 秒震动一次。</div>
      <div class="field"><label>系统通知（后台 / 锁屏到点靠它）</label>
        <div class="wk-standby-row" id="wk-np-info"><span class="wk-perm">${state.wkNative ? "权限已授权" : "未授权"}</span></div></div>
      <div class="field"><label>后台常驻</label>
        <div class="wk-standby-row">
          <span class="wk-perm">${state.wkStandby === false
            ? "已关闭：只发通知，静音下不响，最省电"
            : "已开启：后台留一条静音音频，锁屏到点也会响"}</span>
          <button class="chip" id="wk-standby">${state.wkStandby === false ? "开启" : "关闭"}</button>
        </div></div>
      <div class="sheet-actions">
        <button class="btn ghost" id="wk-test">8 秒后测试通知</button>
        <button class="btn primary" id="wk-sync">重新同步</button>
      </div></div>`);
    const sb = $("#wk-standby");
    if (sb) sb.onclick = () => {
      state.wkStandby = state.wkStandby === false;
      try { wkNativeHandler().postMessage({ cmd: "standby", on: state.wkStandby }); } catch (e) {}
      closeSheet();
      toast(state.wkStandby ? "已开启后台常驻" : "已关闭，只在通知里提示");
    };
    const test = $("#wk-test");
    if (test) test.onclick = () => {
      wkNativeHandler().postMessage({ cmd: "test" });
      toast("8 秒后一条系统通知，现在锁屏等着看");
    };
    const sync = $("#wk-sync");
    if (sync) sync.onclick = () => { wkPushNative(); toast("已重新同步"); };
    return;
  }
  openSheet("到点提醒", `
    <div class="wk-form">
    <div class="wk-tip">到点会响铃 + 震动，并在屏幕上弹一张提醒卡。网页的定时器在 App 退到后台或锁屏时会被系统挂起，所以<b>保持 App 在前台</b>才一定响；打开通知权限可以多一层兜底。</div>
    <div class="field"><label>通知权限</label>
      <div class="wk-perm">${perm === "granted" ? "已开启" : perm === "unsupported" ? "当前环境不支持通知" : "未开启"}</div></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="wk-test">试听铃声 / 震动</button>
      ${perm === "default" ? '<button class="btn primary" id="wk-allow">开启通知</button>' : ""}
    </div></div>`);
  const test = $("#wk-test");
  if (test) test.onclick = () => { wkTone(); wkVibe(); toast("这就是到点的铃声"); };
  const allow = $("#wk-allow");
  if (allow) allow.onclick = async () => {
    try { await Notification.requestPermission(); } catch (e) {}
    closeSheet();
    toast(Notification.permission === "granted" ? "通知已开启" : "没有拿到通知权限");
  };
}

/* 卡片的收尾重绘一律推迟：以前点「知道了」当场 loadWork(true)，
   整页三栏一起重渲染 + 全屏 blur 撤掉，手指按下去要等一两秒才有反应 */
function wkSettle() {
  if (typeof sbIsOn === "function" && sbIsOn()) return;   // 待机里工作页本来就是 visibility:hidden，白重绘
  clearTimeout(state._wkSettleT);
  state._wkSettleT = setTimeout(() => {
    state._wkSettleT = null;
    if (document.hidden) return;
    try { loadWork(true).catch(() => {}); } catch (e) {}
  }, 320);
}

/* 通知同步（一次要重算几十条到点时间再走一遍桥）合并成一拍 */
function wkPushNativeSoon() {
  clearTimeout(state._wkPushT);
  state._wkPushT = setTimeout(() => { state._wkPushT = null; wkPushNative(); }, 400);
}

/* 长按不该弹系统的「拷贝/粘贴」小菜单：整站只允许在输入框里长按选中 */
document.addEventListener("contextmenu", (e) => {
  const t = e.target;
  if (t && t.closest && t.closest("input,textarea,select,[contenteditable='true']")) return;
  e.preventDefault();
}, { capture: true });

/* 提醒卡 / 待机待处理面板共用的动作入口：
   off = 知道了（专注「这步结束」时是「进入下一步」），snooze = 10 分钟后再提醒 / 跳过这一步 */

/* 卡顿探针：点掉提醒后盯 6 秒，主线程出现超过 800ms 的空档就在左下角写出来。
   出现红色小字说明是网页/桥接把主线程堵住了，没有小字说明卡在壳里。 */
function wkLagWatch(windowMs) {
  const end = performance.now() + (windowMs || 6000);
  let last = performance.now(), worst = 0, hid = document.hidden;
  const onVis = () => { if (document.hidden) hid = true; };
  document.addEventListener("visibilitychange", onVis);
  const step = () => {
    const t = performance.now(), gap = t - last;
    last = t;
    if (gap > worst) worst = gap;
    if (t < end) { requestAnimationFrame(step); return; }
    document.removeEventListener("visibilitychange", onVis);
    // 页面被遮住（锁屏/切后台/来电）时 rAF 本来就会停，别把这个当卡顿
    if (worst > 800) wkLagShow(worst, hid);
  };
  requestAnimationFrame(step);
}
function wkLagShow(ms, hidden) {
  let el = document.getElementById("wk-lag");
  if (!el) {
    el = document.createElement("div");
    el.id = "wk-lag";
    el.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9999;font:12px -apple-system,sans-serif;"
      + "color:#ff453a;background:rgba(0,0,0,.62);padding:4px 9px;border-radius:9px;pointer-events:none";
    document.body.appendChild(el);
  }
  el.textContent = (hidden ? "页面被遮挡 " : "主线程卡 ") + (ms / 1000).toFixed(1) + "s";
  setTimeout(() => { try { el.remove(); } catch (e) {} }, 9000);
}
window.wkLagWatch = wkLagWatch;

function wkAlarmAction(act) {
  {
    const alarm = state.wkAlarm;
    if (!alarm) return false;
    try { wkLagWatch(6000); } catch (e) {}
    const task = alarm.kind === "task" ? alarm.task : null;
    const box = $("#wk-alarm");
    // 专注提醒按 id 拆：m<模式>_<步>_<日期>[_end]。真正的推进只看「这场是不是正好停在这一步」
    const fm = alarm.kind === "focus" ? /^m(\d+)_(\d+)_(\d{4}-\d{2}-\d{2})(_end)?$/.exec(String(alarm.id || "")) : null;
    if (fm) {
      const mid = Number(fm[1]), idx = Number(fm[2]), isEnd = !!fm[4];
      const run = wkLiveRun();
      const cur = !!(run && Number(run.mode_id) === mid && Number(run.step_idx) === idx);
      const hideCard = () => {
        if (box) box.classList.add("hidden");
        document.body.classList.remove("wk-ringing");
      };
      if (!isEnd) {
        // 开工提醒：点掉只是别响了，场次原地不动（以前这里会顺手推进，等于把这一步跳过）
        wkKillAlarm();
        return true;
      }
      if (act === "snooze") {              // 跳过这一步：不算完成，场次往前推
        wkStopRing(null); state.wkAlarm = null;
        hideCard();
        if (cur) wkRunAdvance("skip");
        wkAlarmNextInQueue();
        return true;
      }
      // 「进入下一步 / 知道了」：这步算完成，场次停在它上面才推进
      wkKillAlarm();
      if (cur) wkRunAdvance("done");
      wkSettle();
      return true;
    }
    if (act === "off") {
      wkKillAlarm();
      wkSettle();
      return true;
    }
    if (act === "snooze" && task) {
      wkStopRing(task);
      state.wkAlarm = null;
      if (box) box.classList.add("hidden");
      document.body.classList.remove("wk-ringing");
      // 从「现在」算 10 分钟，不是从原定时间算：
      // 以前按 due_at +10，晚点几分钟才点的人会算出「一分钟后又响」，看着就像点了没用、马上又弹回来
      const at = wkFmtMin(wkNowMs() + 10 * 60000);
      toast("10 分钟后提醒");
      wkAlarmNextInQueue();
      // 改期这一步可以慢一点：先把卡收掉、界面还给用户，后台再落库
      setTimeout(() => {
        task.snooze_at = at;   // 只推迟这一次；due_at 不动，重复规则也就不会被改
        api(`work/tasks/${task.id}`, { method: "PATCH", body: { snooze_at: at, notified_at: null } })
          .then(() => wkSettle()).catch(() => {});
      }, 60);
      return true;
    }
    return false;
}
}
window.wkAlarmAction = wkAlarmAction;

$("#wk-alarm").addEventListener("click", (e) => {
  const off = e.target.closest("[data-wka-off]");
  const snooze = e.target.closest("[data-wka-snooze]");
  if (!off && !snooze) return;
  wkAlarmAction(off ? "off" : "snooze");
});

/* ===================== v26：工作页三段（日程 / 专注 / 值班） ===================== */
state.wkPane = state.wkPane || "sch";
state.wkCal = state.wkCal || "";

function wkNowSec() {
  // 全站统一走北京时间（wkParse 把这段墙钟当 UTC 用），不能取手机本地时间
  const d = new Date();
  const bj = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  return `${bj.getFullYear()}-${wkPad(bj.getMonth() + 1)}-${wkPad(bj.getDate())} `
    + `${wkPad(bj.getHours())}:${wkPad(bj.getMinutes())}:${wkPad(bj.getSeconds())}`;
}
function wkParse(s) {
  const [day, tm] = String(s || "").split(" ");
  if (!day) return NaN;
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm, ss] = String(tm || "00:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
}
function wkNowMs() { return wkParse(wkNowSec()); }
function wkFmtMin(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${wkPad(d.getUTCMonth() + 1)}-${wkPad(d.getUTCDate())} `
    + `${wkPad(d.getUTCHours())}:${wkPad(d.getUTCMinutes())}`;
}
function wkHM(ms) {
  const d = new Date(ms);
  return `${wkPad(d.getUTCHours())}:${wkPad(d.getUTCMinutes())}`;
}
function wkDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? `${h} 小时 ${mm} 分` : `${mm} 分钟`;
}
function wkLeftFmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  // 一小时以上别写成「138:59」：分钟位超过 60 读不出是分还是秒
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m}:${wkPad(s % 60)}`;
}
function wkDayMs(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function wkDayAdd(day, n) {
  return new Date(wkDayMs(day) + n * 86400000).toISOString().slice(0, 10);
}
function wkToday() { return state.today || wkNow().slice(0, 10); }
function wkDayLabel(day) {
  return `${Number(String(day).slice(5, 7))} 月 ${Number(String(day).slice(8, 10))} 日 ${bjWeekday(day)}`;
}

/* ---- 顶部统计：跟着当前面板走 ---- */
function wkSetPane(p) {
  state.wkPane = p;
  $$("#wk-seg [data-wkseg]").forEach((b) => b.classList.toggle("on", b.dataset.wkseg === p));
  ["sch", "focus", "shift"].forEach((k) => {
    const el = $("#wk-pane-" + k);
    if (el) el.classList.toggle("hidden", k !== p);
  });
  renderWkStat();
  if (p === "focus") renderFocus();
  if (p === "shift" || p === "sch") renderShift();
}

/* ---- 日程页顶部的今日上下文条 ---- */
/* ===================== 专注模式 ===================== */
function wkFocusData() {
  return (state.work && state.work.focus) || { modes: [], run: null };
}
/* 进行中的那一场：只认 status=running，不再按 run.day===today 过滤。
   后端 _run_expired 已经允许跨午夜续跑，页面若还按「今天的 run」筛，零点后专注页会显示「没有场次」，
   而顶部「下一件」、铃铛、锁屏卡还在倒计时——三处口径打架。 */
function wkLiveRun() {
  const f = wkFocusData();
  const run = f && f.run;
  return run && run.status === "running" ? run : null;
}
/* 某一步在真实时间轴上的开始时刻（毫秒）：锚点按 run.day 起、逐步顺延跨日。
   快照里的 anchor 只是 HH:MM，跨过午夜的步骤不能直接拼在 run.day 上。 */
function wkStepStartMs(run, idx) {
  const steps = (run && run.snapshot) || [];
  if (!steps[idx]) return NaN;
  let d = run.day;
  for (let i = 0; i <= idx; i += 1) {
    const a = String(steps[i].anchor || "").slice(0, 5);
    if (i === idx) return wkParse(`${d} ${a}:00`);
    const nx = String(steps[i + 1].anchor || "").slice(0, 5);
    // 下一步的钟点不晚于这一步 = 绕过了午夜（22:00 → 00:30 间隔只有 150 分钟，不能拿间隔判跨日）
    d = wkHM2Min(nx) <= wkHM2Min(a) ? wkDayAdd(d, 1) : d;
  }
  return NaN;
}
function focusStepInfo(run) {
  const steps = (run && run.snapshot) || [];
  if (!steps.length) return null;
  const idx = Math.min(Math.max(Number(run.step_idx) || 0, 0), steps.length - 1);
  const step = steps[idx];
  // 起止按设置里的时刻算（和步骤列表、提醒同一条时间轴），晚开始不顺延
  const startMs = wkStepStartMs(run, idx);
  const endMs = startMs + (Number(step.minutes) || 0) * 60000;
  return { idx, step, startMs, endMs, total: steps.length };
}
function focusPct(info, run) {
  const steps = run.snapshot || [];
  const total = steps.reduce((a, s) => a + (Number(s.minutes) || 0), 0) || 1;
  let done = 0;
  for (let i = 0; i < info.idx; i++) done += Number(steps[i].minutes) || 0;
  const elapsed = Math.min(Math.max(wkNowMs() - info.startMs, 0), (Number(info.step.minutes) || 0) * 60000);
  return Math.max(0, Math.min(100, ((done * 60000 + elapsed) / (total * 60000)) * 100));
}
function focusLeftText(info) {
  const d = info.endMs - wkNowMs();
  return d >= 0 ? `还剩 ${wkLeftFmt(d)}` : `已超时 ${wkLeftFmt(-d)}`;
}
/* 运行中的每秒刷新：只改文字与进度条，不重建卡片（不然点按钮会被打断） */
/* 到了计划里的结束点，场次自己往前走一步；最后一步不自动收工，等你点「结束」 */
function wkAutoStepAdvance() {
  const run = wkLiveRun();
  const steps = (run && run.snapshot) || [];
  if (!run || !steps.length) return;
  const idx = Math.min(Math.max(Number(run.step_idx) || 0, 0), steps.length - 1);
  if (idx + 1 >= steps.length) return;
  const startMs = wkStepStartMs(run, idx);
  if (isNaN(startMs)) return;
  const endMs = startMs + (Number(steps[idx].minutes) || 0) * 60000;
  if (wkNowMs() < endMs) return;
  state.wkAutoAdv = state.wkAutoAdv || {};
  const key = `${run.id}:${idx}`;
  if (state.wkAutoAdv[key]) return;
  state.wkAutoAdv[key] = 1;
  wkRunAdvance("auto").catch(() => { delete state.wkAutoAdv[key]; });
}

function wkTickFocus() {
  const run = (wkFocusData().run) || null;
  if (!run || state.wkPane !== "focus" || document.hidden) return;
  const info = focusStepInfo(run);
  if (!info) return;
  const left = $(".wk-frun [data-left]");
  if (left) left.textContent = focusLeftText(info);
  const bar = $(".wk-frun .wk-frun-bar i");
  if (bar) bar.style.width = `${focusPct(info, run).toFixed(1)}%`;
}

/* ---- 专注模式编辑器 ---- */
/* ===================== 值班模式 ===================== */
function wkShiftData() {
  return (state.work && state.work.shift) || { types: [], rosters: [], overrides: {} };
}
function wkRosterOn(day) {
  const rs = (wkShiftData().rosters || [])
    .filter((r) => String(r.effective_from).slice(0, 10) <= day
      && (!r.end_date || String(r.end_date).slice(0, 10) >= day))
    .sort((a, b) => (String(a.effective_from) < String(b.effective_from) ? 1 : -1));
  return rs[0] || null;
}
/* 轮转表这一天“轮到”的班次 id（不含任何过滤，用来解释为什么某天变成休） */
function wkRosterRawId(day) {
  const r = wkRosterOn(day);
  if (!r || !r.pattern || !r.pattern.length) return 0;
  const len = r.pattern.length;
  const off = Math.round((wkDayMs(day) - wkDayMs(r.start_date)) / 86400000);
  return Number(r.pattern[((off % len) + len) % len]) || 0;
}
/* 绑定了专注模式的班次：那天绑定的模式都不跑，这个班就不该出现在日历上（例如司法日常只在工作日跑，
   周末的「标」自动变休）。这里只看模式自己的重复（周几 / 日类型），不看班次条件，避免循环判断。 */
function wkModeDaysOk(m, calDay) {
  const days = (m.days || []).map(Number);
  if (days.length && !days.includes(wkDowNo(calDay))) return false;
  if (m.dkind && wkDayKind(calDay) !== m.dkind) return false;
  return true;
}
function wkShiftRunsOn(id, day) {
  const t = (wkShiftData().types || []).find((x) => Number(x.id) === Number(id));
  if (!t || !(t.modes || []).length) return true;
  const mids = (t.modes || []).map(Number);
  const bound = (wkFocusData().modes || []).filter((m) => mids.includes(Number(m.id)));
  if (!bound.length) return true;
  return bound.some((m) => wkModeDaysOk(m, day));
}
function shiftTypeIdOf(day) {
  const s = wkShiftData();
  const ov = s.overrides || {};
  if (Object.prototype.hasOwnProperty.call(ov, day)) return Number(ov[day]) || 0;   // 手调过就按手调
  const r = wkRosterOn(day);
  if (!r) return 0;
  const id = wkRosterRawId(day);
  if (!id) return 0;
  return wkShiftRunsOn(id, day) ? id : 0;
}
function shiftInfo(day) {
  const s = wkShiftData();
  const id = shiftTypeIdOf(day);
  const roster = wkRosterOn(day);
  const type = (s.types || []).find((t) => Number(t.id) === id) || null;
  // 轮转表跑着、这一天排的是「休」（pattern 里是 0）：镜像成不值班班次，
  // 日历/详情/卡片都当「休息」显示。以前返回 type=null，就被画成空白，看着像轮转表没生效。
  // 手调成「休」但那段没有轮转覆盖时也要显示成休，否则格子会一片空白
  const rest = !type && (!!roster || Object.prototype.hasOwnProperty.call(s.overrides || {}, day));
  const offType = rest ? (s.types || []).find((t) => t.kind === "off") || null : null;
  return { id, type: type || offType, roster, rest,
    overridden: Object.prototype.hasOwnProperty.call(s.overrides || {}, day) };
}
function shiftSeq(day, id) {
  let n = 1, d = day;
  for (let i = 0; i < 60; i++) {
    d = wkDayAdd(d, -1);
    if (shiftTypeIdOf(d) === Number(id)) n++; else break;
  }
  return n;
}
/* 此刻人实际在哪个班里：先看昨天的跨天班是否还没到下班，再看今天的班。
   凌晨 03:00 还在昨晚的夜班里，这时「今天的班次」还没开始，不能拿它去判模式匹配 / 锁屏下班。 */
function wkActiveShift(day) {
  const d = day || wkToday();
  const y = shiftInfo(wkDayAdd(d, -1));
  if (y.type && y.type.cross_day && wkNowSec() < `${d} ${y.type.end}:00` && wkNowSec() >= `${wkDayAdd(d, -1)} ${y.type.start}:00`) {
    return { day: wkDayAdd(d, -1), type: y.type, roster: y.roster, continued: true };
  }
  const t = shiftInfo(d);
  return { day: d, type: t.type, roster: t.roster, continued: false,
    started: !!(t.type && t.type.kind !== "off" && wkNowSec() >= `${d} ${t.type.start}:00`) };
}
/* 班次剩余休息分钟（从此刻到下班之间还会休多久）；休息中则含当前这段的剩余部分 */
function wkBreakLeftMin(day, type, nowMs) {
  if (!type || type.kind === "off" || !(type.breaks || []).length) return 0;
  const sMs = shiftStartMs(day, type), eMs = shiftEndMs(day, type);
  const now = nowMs === undefined ? wkNowMs() : nowMs;
  if (!sMs || now >= eMs) return 0;
  const from = Math.max(now, sMs);
  let left = 0;
  for (const [a, b] of type.breaks) {
    const off = ((wkHM2Min(a) - wkHM2Min(type.start)) + 1440) % 1440;
    const len = ((wkHM2Min(b) - wkHM2Min(a)) + 1440) % 1440;
    const bs = sMs + off * 60000, be = bs + len * 60000;
    if (be > from) left += (be - Math.max(from, bs)) / 60000;
  }
  return Math.round(left);
}
function openShiftRosterEditor(rid) {
  const s = wkShiftData();
  const r = rid ? (s.rosters || []).find((x) => Number(x.id) === Number(rid)) : null;
  const types = s.types || [];
  // 「休」只有一种写法：有「不值班」班次时，序列里一律存那个班次的 id（0 是旧数据，读进来就换算过去），
  // 下拉里不再同时出现「休」和「休息」两个几乎一样的选项
  const offType = types.find((t) => t.kind === "off") || null;
  let pat = ((r && r.pattern) || [1, 2, 0, 0]).map((v) => Number(v) || (offType ? Number(offType.id) : 0));
  openSubSheet(r ? "编辑轮转表" : "新建轮转表", `<div class="wk-form">
    <div class="field"><label>名称</label><input id="sr-name" maxlength="16" placeholder="例如：四班两倒" value="${esc(r ? r.name : "")}"></div>
    <div class="field"><label>一轮的顺序</label><div id="sr-pat"></div>
      <button type="button" class="wk-step-add" id="sr-pat-add">＋ 加一天</button></div>
    <div class="wk-when">
      <div class="field"><label>从哪天开始</label>${datePickHtml("sr-start", r ? r.start_date : wkToday(), { full: true, weekday: true })}</div>
      <div class="field"><label>哪天起生效</label>${datePickHtml("sr-eff", r ? r.effective_from : wkToday(), { full: true, weekday: true })}</div>
    </div>
    <div class="field"><label>到哪天为止<i class="wk-opt">不选 = 一直沿用</i></label>
      <div class="wk-endrow">${datePickHtml("sr-end-date", r && r.end_date ? String(r.end_date).slice(0, 10) : "")}
        <button type="button" class="btn ghost small" id="sr-end-clear"${r && r.end_date ? "" : ' hidden'}>清除</button>
      </div>
    </div>
    <div class="wk-tip">「开始」决定第 1 天是哪一天；「生效」之前沿用上一套轮转表；「到哪天为止」不填就一直沿用。新建更晚生效的轮转表，会自动把上一套截到它前一天。</div>
    <div class="sheet-actions"><button class="btn primary" id="sr-save">保存</button>${r ? '<button class="btn danger" id="sr-del">删除</button>' : ""}</div>
  </div>`);
  const box = $("#sr-pat");
  const paint = () => {
    box.innerHTML = pat.map((v, i) => `<div class="wk-pat-row">
        <span class="no">第 ${i + 1} 天</span>
        <select data-pv="${i}">${offType ? "" : `<option value="0"${!v ? " selected" : ""}>休</option>`}
          ${types.map((t) => `<option value="${t.id}"${Number(v) === Number(t.id) ? " selected" : ""}>${esc(t.name)}</option>`).join("")}
        </select>
        <button type="button" class="x" data-px="${i}">×</button>
      </div>`).join("");
    $$("[data-pv]", box).forEach((sel) => {
      sel.onchange = () => { pat[Number(sel.dataset.pv)] = Number(sel.value) || 0; };
    });
    $$("[data-px]", box).forEach((b) => {
      b.onclick = () => {
        if (pat.length <= 1) return toast("至少一天");
        pat.splice(Number(b.dataset.px), 1); paint();
      };
    });
  };
  paint();
  $("#sr-pat-add").onclick = () => { pat.push(offType ? Number(offType.id) : 0); paint(); };
  const endClear = $("#sr-end-clear");
  if (endClear) endClear.onclick = () => {
    const inp = $("#sr-end-date");
    if (inp) inp.value = "";
    const lbl = endClear.parentElement && endClear.parentElement.querySelector(".date-pick-text");
    if (lbl) lbl.textContent = "选日期";
    endClear.hidden = true;
  };
  const endInp = $("#sr-end-date");
  if (endInp) endInp.onchange = () => { const c = $("#sr-end-clear"); if (c) c.hidden = !endInp.value; };
  // 开始日是这一轮的第 1 天，生效日不能比它早；改晚开始日时把生效日一起推过去
  const startInp = $("#sr-start"), effInp = $("#sr-eff");
  if (startInp) startInp.onchange = () => {
    if (effInp && (!effInp.value || effInp.value < startInp.value)) {
      effInp.value = startInp.value;
      const t = effInp.closest(".date-pick") && effInp.closest(".date-pick").querySelector(".date-pick-text");
      if (t) t.textContent = startInp.value.slice(5);
    }
  };
  $("#sr-save").onclick = async () => {
    const name = ($("#sr-name").value || "").trim();
    if (!name) return toast("名称不能为空");
    const sV = $("#sr-start") ? $("#sr-start").value : "";
    const eV = $("#sr-eff") ? $("#sr-eff").value : "";
    if (sV && eV && eV < sV) return toast("生效日不能早于开始日");
    const endV0 = $("#sr-end-date") ? $("#sr-end-date").value : "";
    if (eV && endV0 && endV0 < eV) return toast("结束日不能早于生效日");
    if (r) {
      const same = String(r.name) === name && JSON.stringify((r.pattern || []).map(Number)) === JSON.stringify(pat.map(Number))
        && r.start_date === $("#sr-start").value && String(r.effective_from).slice(0, 10) === $("#sr-eff").value;
      if (!same) {
        const ok = await wkConfirm("重算历史班表？",
          "改顺序或开始日后，从开始那天到今天的班次会按新顺序重算；单独调过的日期不动。",
          "确认重算");
        if (!ok) return;
      }
    }
    const btn = $("#sr-save"); btn.disabled = true; btn.textContent = "保存中…";
    try {
      const body = { name, pattern: pat, start_date: $("#sr-start").value,
        effective_from: $("#sr-eff").value, end_date: $("#sr-end-date") ? $("#sr-end-date").value || null : null };
      if (r) await api(`work/shift/rosters/${r.id}`, { method: "PATCH", idempotent: true, body }, 20000);
      else await api("work/shift/rosters", { method: "POST", idempotent: true, body }, 20000);
      const eff = String($("#sr-eff") ? $("#sr-eff").value || "" : "");
      const endV = $("#sr-end-date") ? String($("#sr-end-date").value || "") : "";
      closeSubSheet();
      if (eff && eff > wkToday()) toast(`已保存，${eff.slice(5).replace("-", "/")} 起生效`);
      else if (endV) toast(`已保存，${endV.slice(5).replace("-", "/")} 为止`);
      else toast("已保存");
      await loadWork(true); openShiftSettings(); wkSetPane("shift");
    } catch (e) {
      btn.disabled = false; btn.textContent = "保存";
      toast(e.message || "保存失败");
    }
  };
  const del = $("#sr-del");
  if (del) del.onclick = async () => {
    if (del.dataset.arm !== "1") {
      del.dataset.arm = "1"; del.textContent = "确认删除？";
      setTimeout(() => { if (del.dataset.arm === "1") { del.dataset.arm = ""; del.textContent = "删除"; } }, 3000);
      return;
    }
    del.disabled = true; del.textContent = "删除中…";
    try {
      await api(`work/shift/rosters/${r.id}`, { method: "DELETE" });
      closeSubSheet(); toast("已删除");
      await loadWork(true); openShiftSettings(); wkSetPane("shift");
    } catch (e) {
      del.disabled = false; del.dataset.arm = ""; del.textContent = "删除";
      toast(e.message || "删除失败");
    }
  };
}

/* 「这一步点过了」只存在本地：一天一清，跨天自动失效，不往服务端写脏数据 */
function wkStepDoneMap() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem("wkStepDone") || "{}") || {}; } catch (e) { o = {}; }
  return o;
}
function wkStepDoneKey(day, mid, idx) { return `${day}|${mid}|${idx}`; }
function wkStepDone(day, mid, idx) { return !!wkStepDoneMap()[wkStepDoneKey(day, mid, idx)]; }
function wkSetStepDone(day, mid, idx, on) {
  const o = wkStepDoneMap();
  const k = wkStepDoneKey(day, mid, idx);
  if (on) o[k] = 1; else delete o[k];
  const keep = `${day}|`;
  Object.keys(o).forEach((x) => { if (x.slice(0, 10) !== day) delete o[x]; });
  try { localStorage.setItem("wkStepDone", JSON.stringify(o)); } catch (e) {}
  wkPushStepDone(day, mid, idx, on);      // 同时写服务端：换手机 / 重装都不会把这一步当没做
}
/* 勾掉 / 撤销某一步 → 写服务端（失败就只留本地，下次同步再补） */
function wkPushStepDone(day, mid, idx, on) {
  try {
    api("work/focus/done", { method: "POST", body: { day, mode_id: mid, step_idx: idx, done: !!on, by: "app" } })
      .catch(() => {});
  } catch (e) {}
}
/* 进页面时把服务端那份「哪几步做完了」和本地合在一起：
   本地有、服务端没有的推上去（离线勾的）；服务端有、本地没有的补进来（换设备 / 清缓存）。 */
async function wkSyncStepDone() {
  const day = wkToday();
  try {
    const d = await api(`work/focus/done?day=${day}`, { noRetry: true }, 8000);
    const srv = new Set(((d.items) || []).map((x) => `${x.day}|${x.mode_id}|${x.step_idx}`));
    // 上一次看到的服务端账单：用来分清「本地新勾的（要推上去）」和「服务端刚被取消的（AI / 另一台设备撤了，要跟着撤）」
    let prev = {};
    try { prev = JSON.parse(localStorage.getItem("wkStepDoneSrv") || "{}") || {}; } catch (e) { prev = {}; }
    const o = wkStepDoneMap();
    Object.keys(o).forEach((k) => {
      if (k.slice(0, 10) !== day || srv.has(k)) return;
      if (prev[k]) { delete o[k]; return; }          // 服务端有过、现在没了 = 有人撤销，本地跟着撤，不要推回去
      const p = k.split("|");
      wkPushStepDone(p[0], Number(p[1]), Number(p[2]), true);
    });
    srv.forEach((k) => { if (k.slice(0, 10) === day) o[k] = 1; });
    Object.keys(o).forEach((k) => { if (k.slice(0, 10) !== day) delete o[k]; });
    const srvMap = {};
    srv.forEach((k) => { if (k.slice(0, 10) === day) srvMap[k] = 1; });
    try {
      localStorage.setItem("wkStepDone", JSON.stringify(o));
      localStorage.setItem("wkStepDoneSrv", JSON.stringify(srvMap));
    } catch (e) {}
  } catch (e) {}
}
window.wkSyncStepDone = wkSyncStepDone;

/* 专注：按模式自己的「重复」把某一天的每一步排出来，不依赖 run 有没有在跑。
   wkAlarms() 用它排提醒，wkUpcoming() 用它排「接下来」，两边口径永远一致。 */
function wkFocusSchedule(day) {
  const f = wkFocusData();
  const d0 = day || wkToday();
  const out = [];
  (f.modes || []).forEach((m) => {
    // 班次 / 周几 / 日类型三个条件都要满足：只绑了「白班」的模式，排到别的班那天不排任何一步
    if (!wkModeMatchDay(m, d0, d0)) return;
    const all = (m.steps || []);
    const total = all.filter((x) => x && x.anchor).length;
    all.forEach((st, i) => {
      if (!st || !st.anchor) return;
      const ms = wkParse(`${d0} ${String(st.anchor).slice(0, 5)}`);
      if (!ms || Number.isNaN(ms)) return;
      out.push({ modeId: m.id, modeName: m.name, idx: i, total, step: st, ms });
    });
  });
  return out;
}

/* ===================== 提醒：日程 / 专注 / 值班 合成一张表 ===================== */
function wkAlarms() {
  const out = [];
  // 只排「今天起」的日程：昨天以前没勾完成的旧账永远响不了，白占 iOS 的 60 条待发名额，
  // 会把今天专注每一步的提醒挤出队尾（真的踩过：专注到点一条通知都没排进去）
  const t0 = wkToday();
  ((state.work && state.work.tasks) || []).forEach((t) => {
    if (t.done || !t.due_at) return;
    if (String(t.due_at).slice(0, 10) < t0) return;
    const w = String(wkDue(t)).slice(0, 16);
    out.push({ id: "t" + t.id, kind: "task", task: t, title: t.title, when: w,
      meta: `${w.slice(11)} · ${wkTypeName(t.type_id)}`, note: t.note || "" });
  });
  // 专注：直接按模式的「重复」把今天的每一步排进提醒表，不再依赖 run 是否在跑。
  // 以前只从 running 的 run 里取「下一步结束」，App 没在 09:00 开着（run 起不来）就一条专注提醒都没有，
  // 而日程只要 due_at 在表里，到点就响——这就是两者体感不一致的原因。
  const todayF = wkToday();
  const modes = (wkFocusData().modes || []);
  const runNow = wkLiveRun();
  // 每一步排「开始」和「结束」两条，时间都走同一个实际时间轴（见 wkFocusTimeline）。
  // 首尾相接的两步（第 1 步 11:30 结束、第 2 步 11:30 开始）会在同一分钟各响一条，这是要的：
  // 「X 结束 · 下一步 Y」说明收工，「Y 开始」说明开工，两条文案不重复。
  modes.forEach((m) => {
    if (Number(m.ring_each_step) === 0) return;                       // 「每步提醒」关掉的模式不响
    if (!(m.steps || []).length) return;
    const sameRun = runNow && Number(runNow.mode_id) === Number(m.id) ? runNow : null;
    // 提醒和自动开跑用同一套「今天该不该跑」的判断：班次没对上（只绑白班、今天排的是标）就一条都不排。
    // 例外是这场已经在跑（跨午夜续班）：跑着的那场该有的收工提醒不能因为过了零点就丢掉。
    if (!wkModeMatchDay(m, todayF, todayF) && !sameRun) return;
    const tl = wkFocusTimeline(m, sameRun, todayF);
    const total = (m.steps || []).filter((x) => x && x.anchor).length;
    const now = wkNowMs();
    const items = [];
    (m.steps || []).forEach((st, i) => {
      if (!st || !st.anchor) return;
      const t = tl[i] || {};
      if (!isFinite(t.startMs)) return;
      if (wkStepDone(todayF, m.id, i)) return;                        // 卡片上点过圆点的不再响
      items.push({ i, st, startMs: t.startMs, endMs: t.endMs, mins: Number(st.minutes) || 0 });
    });
    items.forEach((it, k) => {
      if (it.startMs >= now - 30 * 60000) {
        out.push({ id: `m${m.id}_${it.i}_${todayF}`, kind: "focus",
          runId: sameRun ? sameRun.id : null,
          title: `专注 · ${it.st.title}`, when: wkFmtMin(it.startMs),
          meta: `${m.name} · 第 ${it.i + 1}/${total} 步 · ${it.mins || 1} 分钟`, note: "" });
      }
      if (it.mins > 0 && it.endMs >= now - 30 * 60000) {
        const nx = items[k + 1];
        out.push({ id: `m${m.id}_${it.i}_${todayF}_end`, kind: "focus",
          runId: sameRun ? sameRun.id : null,
          title: `专注 · ${it.st.title} 结束`, when: wkFmtMin(it.endMs),
          meta: nx ? `下一步：${nx.st.title}（${nx.mins || 0} 分钟）` : "这是最后一步，做完这场就结束",
          note: "" });
      }
    });
  });
  const nx = shiftNextStart();
  if (nx) {
    out.push({ id: `s${nx.day}`, kind: "shift", title: `上班提醒 · ${nx.type.name}`,
      when: wkFmtMin(wkParse(nx.at) - 60 * 60000),
      meta: `${nx.type.start}${nx.type.cross_day ? ` → 次日 ${nx.type.end}` : ` → ${nx.type.end}`}`, note: "" });
  }
  return out.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0)).slice(0, 60);
}

/* 关掉当前这张提醒卡：停铃、清状态、收卡片。圆点和「知道了」共用 */
function wkKillAlarm() {
  const a = state.wkAlarm;
  if (a && a.id) state.wkAlarmDismissed = String(a.id);
  // 只有「这步结束」的提醒被点掉，才等于这步做完了，自动替用户勾上圆点；
  // 「这步开始」的提醒点掉只是别响了，不能把刚开工的这步当成做完。
  const fm = a && a.kind === "focus" ? /^m(\d+)_(\d+)_(\d{4}-\d{2}-\d{2})_end$/.exec(a.id) : null;
  if (fm) wkSetStepDone(fm[3], Number(fm[1]), Number(fm[2]), true);
  state.wkAlarmDismissedAt = Date.now();
  wkStopRing(a && a.task ? a.task : null);
  state.wkAlarm = null;
  const box = $("#wk-alarm");
  if (box) box.classList.add("hidden");
  document.body.classList.remove("wk-ringing");
  if (fm) { try { renderFocus(); } catch (e) {} }
  wkPushNativeSoon();      // 勾掉的这步从系统通知里撤走，别在通知中心留着
  wkAlarmNextInQueue();
}
function wkQueuePush(q, items) {
  const cur = q || [];
  (items || []).forEach((a) => {
    if (cur.some((x) => x.id === a.id && x.when === a.when)) return;
    cur.push(a);
  });
  return cur.slice(-20);
}
window.wkQueuePush = wkQueuePush;
/* 关掉一张后，把同时到点、还在排队的那张接着弹出来 */
function wkAlarmNextInQueue() {
  const q = state.wkAlarmQueue || [];
  if (!q.length) return;
  let next = q.shift();
  state.wkAlarmQueue = q;
  if (next && state.wkAlarmDismissed && String(next.id) === String(state.wkAlarmDismissed)) {
    next = q.shift();                       // 刚点掉的那条不再弹回来
    state.wkAlarmQueue = q;
  }
  if (!next) return;
  setTimeout(() => {
    if (state.wkAlarm) return;
    state.wkAlarmDismissed = null;
    wkMarkSeen(next);
    wkAlarmShow(next);
  }, 200);
}
function wkMarkSeen(a) {
  if (!a) return;
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem("wkSeen") || "{}") || {}; } catch (e) { seen = {}; }
  seen[a.id] = a.when;
  try { localStorage.setItem("wkSeen", JSON.stringify(seen)); } catch (e) {}
}

/* 同时到点时按 专注 > 值班 > 日程 挑一条弹出来（专注被打断代价最大） */
const WK_ALARM_RANK = { focus: 0, shift: 1, daily: 2, task: 3 };
function wkAlarmPick(list) {
  // 「某步结束」比「下一步开始」更该先弹：前者的「知道了」会把这一步勾掉
  const endBoost = (a) => (a.kind === "focus" && /_end$/.test(String(a.id || "")) ? -1 : 0);
  return (list || []).slice().sort((a, b) =>
    ((WK_ALARM_RANK[a.kind] ?? 3) - (WK_ALARM_RANK[b.kind] ?? 3)) ||
    (endBoost(a) - endBoost(b)) ||
    (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))[0] || null;
}

/* 到点补弹：网页模式在前台自己响；装了壳时点通知进来 / 从后台回来也要弹，并且接着响。
   只看最近 30 分钟内到点的，别把上午的旧提醒翻出来。 */
function wkCheckExtra(force) {
  if (!state.work) { try { loadWork(true); } catch (e) {} return; }   // 工作数据没到就补一把，下次轮询再判
  // 装了壳时：锁屏/后台靠系统通知，前台那一瞬间壳会把横幅吞掉（willPresent 返回空），
  // 所以前台必须由网页自己弹卡，否则专注某一步结束时屏幕上什么也没有
  if (state.wkNative && !force && document.hidden) return;
  const now = wkNowSec();
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem("wkSeen") || "{}") || {}; } catch (e) { seen = {}; }
  const extra = wkAlarms().filter((a) => a.kind !== "task");
  const due = extra.filter((a) => a.when + ":00" <= now && wkParse(a.when + ":00") >= wkNowMs() - 30 * 60000 && seen[a.id] !== a.when);
  if (!due.length) return;
  const pick = wkAlarmPick(due);
  // 已经有一张卡在屏幕上：这一批全进队列（不标已看），等这张关掉再依次弹
  if (state.wkAlarm) { state.wkAlarmQueue = wkQueuePush(state.wkAlarmQueue, due); return; }
  state.wkAlarmQueue = wkQueuePush(state.wkAlarmQueue, due.filter((a) => a.id !== pick.id));
  // 只有真的弹出来的那张才记「已看」：排队的没弹成、或被系统杀掉，下次开 App 还能补弹
  seen[pick.id] = pick.when;
  Object.keys(seen).forEach((k) => { if (!/^(f|s|m|d)/.test(k)) delete seen[k]; });
  try { localStorage.setItem("wkSeen", JSON.stringify(seen)); } catch (e) {}
  wkAlarmShow(pick);
}

/* ---- 绑定 ---- */
$("#wk-seg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-wkseg]");
  if (b) wkSetPane(b.dataset.wkseg);
});
$("#wk-add-focus").addEventListener("click", () => openFocusEditor(null));
const aiEntry = $("#wk-ai");
if (aiEntry) aiEntry.addEventListener("click", () => openWorkAi());
$("#wk-shift-set").addEventListener("click", () => openShiftSettings());
setInterval(() => {
  if (document.hidden) return;
  if (state.view === "work") {
    if (state.wkPane === "focus") wkTickFocus();
    if (state.wkPane === "shift") wkTickShift();
  }
  wkAutoFocusTick();   // 在哪个页面都看一眼，到点自动开
  wkAutoStepAdvance(); // 到点进下一步，见上面的说明
}, 1000);
// 提醒表每分钟重推一次给壳（改了专注步骤时间、加了每日提醒都能在下一次同步里生效）
setInterval(() => { if (!document.hidden && state.wkNative) wkPushNative(); }, 60000);
renderWkStat();

/* ============================ v27：专注按开始时间 ============================ */

/* 通用选择卡：返回 Promise<key|null>（三个选项以内，最后一个可标 primary） */
function wkChoose(title, body, opts) {
  return new Promise((res) => {
    const el = document.createElement("div");
    el.className = "wk-alarm wk-cf";
    el.innerHTML = `<div class="wka-card">
        <div class="wka-t">${esc(title)}</div>
        <div class="wka-m">${esc(body)}</div>
        <div class="wkc-opts">${(opts || []).map((o) =>
          `<button type="button" class="wkc-opt${o.primary ? " primary" : ""}" data-k="${esc(o.key)}">
            <b>${esc(o.label)}</b>${o.desc ? `<i>${esc(o.desc)}</i>` : ""}</button>`).join("")}</div>
      </div>`;
    document.body.appendChild(el);
    layerOn(el);
    const done = (v) => { layerOff(el); el.remove(); res(v); };
    el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => done(b.dataset.k)));
    el.addEventListener("click", (e) => { if (e.target === el) done(null); });
  });
}

/* 分钟数 -> 时钟时刻（可跨天，返回 HH:MM 与跨天标记） */
function wkShiftHM(hm, min) {
  const base = Number(String(hm).slice(0, 2)) * 60 + Number(String(hm).slice(3, 5));
  const m = base + (Number(min) || 0);
  return { at: `${wkPad((Math.floor(m / 60) % 24 + 24) % 24)}:${wkPad(((m % 60) + 60) % 60)}`, cross: m >= 1440 };
}
function wkHM2Min(hm) {
  return Number(String(hm).slice(0, 2)) * 60 + Number(String(hm).slice(3, 5));
}
/* 结束时间不晚于开始时间＝跨到次日，文案统一带「次日」 */
function wkCrossHM(start, end) {
  const s0 = String(start || "").slice(0, 5), e0 = String(end || "").slice(0, 5);
  if (!/^\d\d:\d\d$/.test(s0) || !/^\d\d:\d\d$/.test(e0)) return e0;
  return wkHM2Min(e0) > wkHM2Min(s0) ? e0 : `次日 ${e0}`;
}
/* 两步之间隔多少分钟，允许跨午夜 */
function wkGapMin(a, b) {
  const d = wkHM2Min(b) - wkHM2Min(a);
  return d > 0 ? d : (d === 0 ? 0 : d + 1440);
}

function wkWeekName(n) { return ["一", "二", "三", "四", "五", "六", "日"][Number(n) - 1] || ""; }
function wkShiftShort(id) {
  if (!Number(id)) return "休";
  const t = (wkShiftData().types || []).find((x) => Number(x.id) === Number(id));
  return t ? t.short : "?";
}
/* 周几编号：1=周一 … 7=周日（专注模式的 days、轮转表的在岗日都用这套） */
function wkDowNo(day) {
  const d = new Date(Date.UTC(+String(day).slice(0, 4), +String(day).slice(5, 7) - 1, +String(day).slice(8, 10))).getUTCDay();
  return d === 0 ? 7 : d;
}
/* 这一天算工作日还是休息日：节假日表优先，其次周一~五/周末 */
function wkDayKind(day) {
  const hol = wkHolidayOf(day);
  if (hol && hol.off) return "off";
  if (hol && hol.work) return "work";
  const d = new Date(Date.UTC(+String(day).slice(0, 4), +String(day).slice(5, 7) - 1, +String(day).slice(8, 10))).getUTCDay();
  return d === 0 || d === 6 ? "off" : "work";
}
/* 模式在这天适不适合跑：班次 / 周几 / 日类型 三个条件都要满足（空 = 不限） */
function wkModeMatchDay(m, day, calDay) {
  // day = 用哪一天的班次去匹配（续班时是昨天）；calDay = 按哪一天判周几/日类型（默认同一天）
  const cd = calDay || day;
  const days = (m.days || []).map(Number);
  if (days.length) {
    const d = new Date(Date.UTC(+String(cd).slice(0, 4), +String(cd).slice(5, 7) - 1, +String(cd).slice(8, 10))).getUTCDay();
    const n = d === 0 ? 7 : d;
    if (!days.includes(n)) return false;
  }
  const shifts = (m.shifts || []).map(Number);
  if (shifts.length && !shifts.includes(Number(shiftTypeIdOf(day)))) return false;
  if (m.dkind && wkDayKind(cd) !== m.dkind) return false;
  return true;
}
/* 重复预设：每天 / 工作日 / 休息日 / 自定义周几 */
function wkPresetOf(days, dkind) {
  const ds = (days || []).map(Number).sort((a, b) => a - b);
  if (!ds.length && !dkind) return "every";
  if (!ds.length && dkind === "off") return "off";
  if (dkind === "work" && ds.length === 5 && ds.join("") === "12345") return "work";
  return "custom";
}
function wkRuleText(m) {
  const out = [];
  const shifts = (m.shifts || []).map(Number);
  if (shifts.length) out.push(shifts.map(wkShiftShort).join("/"));
  const ds = (m.days || []).map(Number);
  const preset = wkPresetOf(m.days, m.dkind);
  if (preset === "work") out.push("工作日");
  else if (preset === "off") out.push("休息日");
  else if (preset === "every") out.push("每天");
  else if (ds.length === 7) out.push(m.dkind === "work" ? "工作日" : m.dkind === "off" ? "休息日" : "每天");
  else if (preset === "custom") out.push(ds.map((n) => "周" + wkWeekName(n)).join(" "));
  return out.join(" · ");
}
/* 整份模式的保存 body（PATCH 会重写步骤，必须带全） */
function wkModeBody(m, extra) {
  return Object.assign({
    name: m.name,
    note: m.note || "",
    ring_each_step: Number(m.ring_each_step) ? 1 : 0,
    steps: (m.steps || []).map((x) => ({ title: x.title, anchor: x.anchor, minutes: Number(x.minutes) || 1 })),
    auto: Number(m.auto) ? 1 : 0,
    days: (m.days || []).map(Number),
    shifts: (m.shifts || []).map(Number),
    dkind: m.dkind || "",
  }, extra || {});
}

function openFocusEditor(mid) {
  const m = mid ? (wkFocusData().modes || []).find((x) => Number(x.id) === Number(mid)) : null;
  let st = ((m && m.steps) || []).map((s) => ({ title: s.title, at: s.anchor || "09:00" }));
  if (!st.length) st = [{ title: "选题", at: "09:00" }, { title: "大纲", at: "09:15" }, { title: "初稿", at: "09:40" }];
  let end = m && m.end ? m.end : wkShiftHM(st[st.length - 1].at, 30).at;
  let ring = m ? !!Number(m.ring_each_step) : true;
  let days = ((m && m.days) || []).map(Number).filter((x) => x >= 1 && x <= 7);
  let shifts = ((m && m.shifts) || []).map(Number);
  let dkind = (m && m.dkind) || "";
  let auto = m ? !!Number(m.auto) : false;

  openSheet(m ? "编辑专注模式" : "新建专注模式", `<div class="wk-form">
    <div class="field"><label>名称</label><input id="f-name" maxlength="20" placeholder="例如：深度写作" value="${esc(m ? m.name : "")}"></div>
    <div class="field"><label>步骤<i class="wk-opt">每步填开始时间 · 长按左侧把手可拖动排序</i></label>
      <div class="wk-fs" id="f-steps"></div>
      <button type="button" class="wk-step-add" id="f-add">＋ 添加步骤</button>
      <div class="wk-fs" id="f-endrow"></div>
      <div class="wk-total" id="f-total"></div></div>
    <div class="field"><label>每步提醒</label><div class="chips wk-pick"><button type="button" class="chip" id="f-ring"></button></div></div>
    <div class="field"><label>什么时候跑</label>
      <div class="wk-kvs" id="f-kv"></div>
      <div class="wk-tip">${(m && m.shifts || []).length ? `只在这些班次下跑：${(m.shifts || []).map(wkShiftShort).join(" / ")}（在「值班 · 班次」里改）` : "还没绑定班次：每天都能跑；想只在某个班次跑，去「值班 · 班次」里勾上它"}</div></div>
    <div class="field"><label>备注<i class="wk-opt">可选</i></label><input id="f-note" maxlength="60" placeholder="这套流程是干嘛的" value="${esc(m ? m.note || "" : "")}"></div>
    <div class="sheet-actions"><button class="btn primary" id="f-save">保存</button>${m ? '<button class="btn danger" id="f-del">删除模式</button>' : ""}</div>
  </div>`);

  const box = $("#f-steps");
  const read = () => $$(".wk-fsr", box).filter((r) => $(".t", r)).map((r) => ({
    title: ($(".t", r).value || "").trim(),
    at: String($(".at", r).value || "09:00").slice(0, 5),
  }));
  const rowsOf = () => $$(".wk-fsr:not(.wk-fend)", box);
  /* 按顺序累加，晚于上一步就顺延到次日；同一时刻按次日算（不再报「比上一步早」） */
  const absOf = (list) => {
    const out = [];
    if (!list.length) return out;
    let cur = wkHM2Min(list[0].at);
    out.push(cur);
    for (let i = 1; i < list.length; i++) {
      let g = wkGapMin(list[i - 1].at, list[i].at);
      if (g <= 0) g = 1440;
      cur += g;
      out.push(cur);
    }
    return out;
  };
  const hmOf = (abs) => `${wkPad((Math.floor(abs / 60) % 24 + 24) % 24)}:${wkPad(((abs % 60) + 60) % 60)}`;
  const durOf = (list) => {
    const abs = absOf(list);
    const endV = (($("#f-end") || {}).value || "").slice(0, 5);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (i + 1 < list.length) { out.push(abs[i + 1] - abs[i]); continue; }
      if (!endV) { out.push(0); continue; }
      const g = wkHM2Min(endV) - wkHM2Min(list[i].at);
      out.push(g > 0 ? g : g + 1440);
    }
    return out;
  };
  const paintTotal = () => {
    const list = read();
    const abs = absOf(list);
    const durs = durOf(list);
    const rows = rowsOf();
    // 绑定班次的休息段：哪一步整个落在休息里，就标一下（两处定义同一件事时让人看见）
    const brkSpans = [];
    (wkShiftData().types || []).forEach((t) => {
      if (!shifts.includes(Number(t.id)) || !(t.breaks || []).length) return;
      t.breaks.forEach(([a, b]) => {
        const so = wkHM2Min(t.start), off = ((wkHM2Min(a) - so) + 1440) % 1440;
        const len = ((wkHM2Min(b) - wkHM2Min(a)) + 1440) % 1440;
        brkSpans.push([so + off, so + off + len]);
      });
    });
    const inBreak = (i) => {
      if (!brkSpans.length || !list.length) return false;
      const from = abs[i], to = abs[i] + (durs[i] || 0);
      // abs 与休息段都是「当天 0 点起的分钟数」，直接比；abs 已按跨日顺延
      return brkSpans.some(([x, y]) => from >= x && to <= y + 1);
    };
    rows.forEach((r, i) => {
      const em = $(".d", r);
      const hb = inBreak(i);
      if (em) em.textContent = durs[i] ? `${durs[i]} 分` : "待定";
      // 「在班次休息内」单独一行小字，别挤在输入框里跟标题重叠
      const db = $(".dbrk", r);
      if (db) db.textContent = hb ? "在班次休息内" : "";
      r.classList.toggle("inbrk", hb);
      r.classList.toggle("cross", !!(abs[i] && abs[i] >= 1440));
      const cd = $(".no .cd", r);
      if (cd) cd.textContent = abs[i] && abs[i] >= 2880 ? "第3天" : abs[i] && abs[i] >= 1440 ? "次日" : "";
    });
    const total = durs.reduce((a, b) => a + b, 0);
    const endV = (($("#f-end") || {}).value || "").slice(0, 5);
    const startAbs = abs[0] || 0;
    const endAbs = list.length && endV ? startAbs + total : startAbs;
    const endRow = $(".wk-fend", box);
    if (endRow) {
      endRow.classList.toggle("cross", !!(list.length && endV && endAbs >= 1440));
      const cd = $(".no .cd", endRow);
      if (cd) cd.textContent = list.length && endV && endAbs >= 2880 ? "第3天" : list.length && endV && endAbs >= 1440 ? "次日" : "";
    }
    let bad = "";
    for (let i = 1; i < list.length; i++) if (durs[i - 1] < 1) bad = `第 ${i} 步和上一步同一时刻`;
    if (list.length && !endV) bad = "填最后一步的结束时间";
    if (list.length && endV && total < 1 && !bad) bad = "结束时间要晚于最后一步";
    if (total > 48 * 60) bad = bad || "总时长超过 48 小时";
    const crossTag = list.length && endV && endAbs >= 1440 ? `${Math.floor(endAbs / 1440) > 1 ? "第" + (Math.floor(endAbs / 1440) + 1) + "天 " : "次日 "}${hmOf(endAbs)}` : (endV || "");
    $("#f-total").innerHTML = bad
      ? `<em class="wk-fs-bad">${esc(bad)}</em>`
      : `共 ${list.length} 步 · ${esc(list[0] ? list[0].at : "")}–${esc(crossTag)} · 合计 ${wkDur(total * 60000)}`;
  };
  const rebaseTimes = (base, durs, newRows) => {
    const first = base.length ? base[0].at : "09:00";
    let curAbs = wkHM2Min(first);
    let prevK = -1;
    const next = [];
    newRows.forEach((r, pos) => {
      const k = Number(r.dataset.i);
      const item = base[k] || { title: "", at: first };
      if (pos === 0) next.push({ title: item.title, at: first });
      else { curAbs += durs[prevK] || 0; next.push({ title: item.title, at: hmOf(curAbs) }); }
      prevK = k;
    });
    return next;
  };
  const EASE = "cubic-bezier(.22,.68,.24,1)";
  const scrollHostOf = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
      p = p.parentElement;
    }
    return null;
  };
  let dragBusy = false;
  const bindDrag = (row) => {
    row.onpointerdown = (ev) => {
      if (dragBusy || ev.target.closest("input,button")) return;
      const startY = ev.clientY, startX = ev.clientX;
      const startIdx = rowsOf().indexOf(row);
      const base = read();
      const durs = durOf(base);
      const host = scrollHostOf(box);
      let active = false, height = row.offsetHeight, grab = 0, timer = 0, rafId = 0, autoDir = 0;
      let lastY = startY;

      const block = (e) => { if (active && e.cancelable) e.preventDefault(); };
      const snapshot = () => new Map($$(".wk-fsr", box).map((r) => [r, r.getBoundingClientRect().top]));
      /* FLIP：只补别的行的位移差，让重排看起来是滑过去的，不是跳过去的 */
      const glide = (tops) => {
        $$(".wk-fsr", box).forEach((r) => {
          if (r === row) return;
          const dy = (tops.get(r) || 0) - r.getBoundingClientRect().top;
          if (Math.abs(dy) < 1) return;
          r.style.transition = "none";
          r.style.transform = `translateY(${dy}px)`;
          void r.offsetHeight;
          r.style.transition = `transform .2s ${EASE}`;
          r.style.transform = "";
        });
      };
      const lift = () => {
        active = true; dragBusy = true;
        const rc = row.getBoundingClientRect();
        grab = startY - rc.top; height = rc.height;
        const tops = snapshot();
        rowsOf().forEach((r, i) => (r.dataset.i = String(i)));
        row.classList.add("dragging");
        Object.assign(row.style, {
          position: "fixed", left: `${rc.left}px`, top: `${rc.top}px`,
          width: `${rc.width}px`, height: `${rc.height}px`, margin: "0",
          zIndex: "40", transformOrigin: "50% 50%",
          transform: "translateY(0) scale(1.012)",
        });
        glide(tops);
        document.addEventListener("touchmove", block, { passive: false });
        if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
        const loop = () => {
          if (!active) return;
          if (autoDir && host) { host.scrollTop += autoDir * 8; place(lastY); }
          rafId = requestAnimationFrame(loop);
        };
        loop();
      };
      const place = (y) => {
        const center = y - grab + height / 2;
        const endRow = $(".wk-fend", box);
        let target = null;
        for (const r of rowsOf()) {
          if (r === row) continue;
          const rc = r.getBoundingClientRect();
          if (center < rc.top + rc.height / 2) { target = r; break; }
        }
        const anchor = target || endRow;
        if (!anchor || anchor === row || row.nextElementSibling === anchor) return;
        const tops = snapshot();
        box.insertBefore(row, anchor);
        glide(tops);
      };
      const onMove = (e) => {
        if (!active) {
          if (Math.abs(e.clientY - startY) > 9 || Math.abs(e.clientX - startX) > 12) { clearTimeout(timer); off(); }
          return;
        }
        e.preventDefault();
        lastY = e.clientY;
        row.style.transform = `translateY(${e.clientY - startY}px) scale(1.012)`;
        if (host) {
          const hr = host.getBoundingClientRect();
          autoDir = e.clientY < hr.top + 60 ? -1 : e.clientY > hr.bottom - 60 ? 1 : 0;
        }
        place(e.clientY);
      };
      const off = () => {
        clearTimeout(timer);
        cancelAnimationFrame(rafId);
        active = false;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("touchmove", block);
      };
      const settle = (commit) => {
        const was = active;
        off();
        if (!was) return;
        if (!commit) {  // 取消：把行放回原来的位置
          const sibs = $$(".wk-fsr", box).filter((r) => r !== row);
          const prev = sibs.filter((r) => Number(r.dataset.i) === startIdx - 1)[0];
          if (startIdx <= 0) box.insertBefore(row, box.firstElementChild);
          else if (prev) box.insertBefore(row, prev.nextElementSibling);
        }
        const rc = row.getBoundingClientRect();
        const tops = snapshot();          // 去掉 fixed 后别的行会瞬间下移，用 FLIP 补上
        row.classList.remove("dragging");
        ["position", "left", "top", "width", "height", "margin", "zIndex", "transformOrigin"].forEach((k) => (row.style[k] = ""));
        row.style.transition = "none";
        row.style.transform = `translateY(${rc.top - row.getBoundingClientRect().top}px) scale(1.012)`;
        row.style.zIndex = "40";
        void row.offsetHeight;
        row.style.transition = `transform .26s ${EASE}, box-shadow .26s ${EASE}`;
        row.style.transform = "";
        row.style.zIndex = "";
        glide(tops);
        if (commit) {
          st = rebaseTimes(base, durs, rowsOf());
          const total = durs.reduce((a, b) => a + b, 0);
          if (base.length && durs.length) end = hmOf(wkHM2Min(base[0].at) + total);
        }
        setTimeout(() => {
          row.style.transition = "";
          dragBusy = false;
          if (commit) paint(); else paintTotal();
        }, 270);
      };
      const onUp = () => settle(true);
      const onCancel = () => settle(false);
      timer = setTimeout(lift, 200);
      document.addEventListener("pointermove", onMove, { passive: false });
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    };
  };
  const paint = () => {
    box.innerHTML = st.map((s, i) => `<div class="wk-fsr" data-i="${i}">
        <span class="grip" aria-hidden="true"></span>
        <span class="no">${i + 1}<em class="cd"></em></span>
        <div class="cell"><div class="inw"><input class="t" maxlength="40" placeholder="这一步做什么" value="${esc(s.title)}"><em class="d"></em></div><em class="dbrk"></em></div>
        ${wkTimeField("", s.at, "at")}
        <button type="button" class="x" data-x>×</button>
      </div>`).join("")
      + `<div class="wk-fsr wk-fend"><span class="grip"></span><span class="no">末<em class="cd"></em></span><div class="cell"><span class="lb">最后一步结束</span></div>${wkTimeField("f-end", end)}<span></span></div>`;
    $("#f-end").oninput = paintTotal;
    $$("[data-x]", box).forEach((b) => {
      b.onclick = () => {
        st = read();
        if (st.length <= 1) return toast("至少留一步");
        st.splice($$(".wk-fsr", box).indexOf(b.closest(".wk-fsr")), 1);
        paint();
      };
    });
    $$(".wk-fsr .at", box).forEach((inp) => (inp.oninput = paintTotal));
    $$(".wk-fsr .t", box).forEach((inp) => (inp.oninput = () => {}));
    rowsOf().forEach(bindDrag);
    paintTotal();
  };
  const paintRing = () => {
    const b = $("#f-ring");
    b.textContent = ring ? "开 · 每步响一次" : "关 · 不逐步骤响";
    b.classList.toggle("on", ring);
  };
  $("#f-ring").onclick = () => { ring = !ring; paintRing(); };

  let openK = "";
  const chip = (k, v, label, on) => `<button type="button" class="wk-kvo${on ? " on" : ""}" data-kvo="${k}" data-v="${esc(v)}">${esc(label)}</button>`;
  const paintKV = () => {
    const preset = wkPresetOf(days, dkind);
    const rows = [
      ["repeat", "重复", preset === "every" ? "每天" : preset === "work" ? "工作日" : preset === "off" ? "休息日" : (days.length ? days.map((n) => wkWeekName(n)).join(" ") : "自定义"), preset === "every"],
      ["auto", "到点自动", auto ? "开" : "关", false],
    ];
    const titles = { repeat: "什么时候跑", shifts: "哪几种班次" };
    $("#f-kv").innerHTML = rows.map(([k, label, val, dim]) => {
      const row = `<button type="button" class="wk-kvr${openK === k ? " open" : ""}" data-kv="${k}">
          <span>${label}</span><b class="${dim ? "dim" : ""}${k === "auto" && auto ? " on" : ""}">${esc(val)}</b>
          ${k === "auto" ? `<em class="wk-swd${auto ? " on" : ""}"></em>` : `<i>›</i>`}</button>`;
      if (openK !== k) return row;
      if (k === "shifts") {
        const chips = (wkShiftData().types || []).map((t) => chip(k, Number(t.id), t.short, shifts.includes(Number(t.id)))).join("")
          + chip(k, 0, "休", shifts.includes(0));
        return row + `<div class="wk-kvex">
            <div class="wk-kvex-l">${titles[k]}</div>
            <div class="wk-kvos chips-row">${chips}</div>
            ${shifts.length ? '<div class="wk-kvex-f"><button type="button" data-kvclear>清空</button></div>' : ""}
          </div>`;
      }
      const presetChips = [["every", "每天"], ["work", "工作日"], ["off", "休息日"], ["custom", "自定义"]]
        .map(([v, l]) => chip(k, v, l, preset === v)).join("");
      const weekChips = preset === "custom"
        ? `<div class="wk-kvos seven wk-kv-week">${[1, 2, 3, 4, 5, 6, 7].map((n) => chip(k, n, wkWeekName(n), days.includes(n))).join("")}</div>`
        : "";
      return row + `<div class="wk-kvex">
          <div class="wk-kvex-l">${preset === "work" ? "周一到周五，法定假日跳过" : preset === "off" ? "周末和法定假日都算" : titles[k]}</div>
          <div class="wk-kvos four">${presetChips}</div>
          ${weekChips}
        </div>`;
    }).join("");
  };
  paintKV();
  $("#f-kv").onclick = (e) => {
    const o = e.target.closest("[data-kvo]");
    if (o) {
      const k = o.dataset.kvo;
      const val = o.dataset.v;
      if (k === "shifts") {
        const v = Number(val);
        shifts = shifts.includes(v) ? shifts.filter((x) => x !== v) : shifts.concat([v]).sort((a, b) => a - b);
      } else if (/^\d$/.test(val)) {
        // 自定义里的周几：单选星期，改完就算自定义
        const n = Number(val);
        dkind = "";
        days = days.includes(n) ? days.filter((x) => x !== n) : days.concat([n]).sort((a, b) => a - b);
      } else if (val === "every") { days = []; dkind = ""; }
      else if (val === "work") { days = [1, 2, 3, 4, 5]; dkind = "work"; }
      else if (val === "off") { days = []; dkind = "off"; }
      else if (val === "custom") { dkind = ""; if (!days.length) days = [1, 2, 3, 4, 5]; }
      paintKV(); return;
    }
    if (e.target.closest("[data-kvclear]")) {
      if (openK === "shifts") shifts = [];
      paintKV(); return;
    }
    const b = e.target.closest("[data-kv]");
    if (!b) return;
    const k = b.dataset.kv;
    if (k === "auto") { auto = !auto; paintKV(); return; }
    openK = openK === k ? "" : k;
    paintKV();
  };
  $("#f-add").onclick = () => {
    st = read();
    const last = st[st.length - 1];
    const lastDur = wkGapMin(last.at, (($("#f-end") || {}).value || last.at).slice(0, 5)) || 30;
    const nx = wkShiftHM(last.at, lastDur);
    st.push({ title: "", at: nx.at });
    // 同步到 end 变量，否则 paint() 会拿旧值把用户改过的「最后一步结束」重绘回去
    if (($("#f-end") || {}).value) {
      end = wkShiftHM(nx.at, 30).at;
      $("#f-end").value = end;
    }
    paint();
  };
  paint(); paintRing();

  $("#f-save").onclick = async () => {
    const name = ($("#f-name").value || "").trim();
    if (!name) return toast("名称不能为空");
    const list = read().filter((x) => x.title);
    if (!list.length) return toast("至少填一步");
    const endV = String($("#f-end").value || "").slice(0, 5);
    if (!endV) return toast("填最后一步的结束时间");
    const abs = absOf(list);
    for (let i = 1; i < list.length; i++) {
      if (abs[i] - abs[i - 1] < 1) return toast(`第 ${i + 1} 步和上一步同一时刻`);
    }
    if (abs.length && wkGapMin(list[list.length - 1].at, endV) < 1) return toast("结束时间要晚于最后一步");
    let total = 0;
    const steps = list.map((s, i) => {
      const next = i + 1 < list.length ? list[i + 1].at : endV;
      const dur = wkGapMin(s.at, next);
      if (dur < 1) throw new Error("每步至少 1 分钟");
      total += dur;
      return { title: s.title, anchor: s.at, minutes: dur };
    });
    if (total > 48 * 60) return toast("总时长超过 48 小时");
    const btn = $("#f-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const body = { name, note: ($("#f-note").value || "").trim(), ring_each_step: ring ? 1 : 0, steps,
        auto: auto ? 1 : 0, days, dkind };
      const wasAuto = m ? !!Number(m.auto) : false;
      if (m) await api(`work/focus/modes/${m.id}`, { method: "PATCH", idempotent: true, body }, 20000);
      else await api("work/focus/modes", { method: "POST", idempotent: true, body }, 20000);
      closeSheet();
      await loadWork(true);
      const fresh = (wkFocusData().modes || []).find((x) => Number(x.id) === Number((m || {}).id) || x.name === name);
      const caught = auto && !wasAuto && fresh ? await wkAutoCatchUp(fresh) : false;
      if (!caught) toast(m ? "已更新" : "已创建");
      wkSetPane("focus");
    } catch (e) {
      btn.disabled = false; btn.textContent = "保存";
      toast(e.message || "保存失败");
    }
  };

  const del = $("#f-del");
  if (del) del.onclick = async () => {
    if (del.dataset.arm !== "1") {
      del.dataset.arm = "1"; del.textContent = "确认删除？";
      setTimeout(() => { if (del.dataset.arm === "1") { del.dataset.arm = ""; del.textContent = "删除模式"; } }, 3000);
      return;
    }
    del.disabled = true; del.textContent = "删除中…";
    try {
      await api(`work/focus/modes/${m.id}`, { method: "DELETE" });
      closeSheet(); toast("已删除");
      await loadWork(true); wkSetPane("focus");
    } catch (e) { del.disabled = false; del.textContent = "删除模式"; toast(e.message || "删除失败"); }
  };
}

/* 开始一场：晚了超过 5 分钟就让人选「按原时间 / 从现在顺延」 */
async function wkFocusStart(modeId, btn) {
  const m = (wkFocusData().modes || []).find((x) => Number(x.id) === Number(modeId));
  if (!m || !(m.steps || []).length) return toast("这套模板还没有步骤");
  const first = m.steps[0].anchor || "09:00";
  const late = wkHM2Min(wkNow().slice(11, 16)) - wkHM2Min(first);
  let plan = "auto";
  if (late > 5) {
    const pick = await wkChoose(`现在 ${wkNow().slice(11, 16)}，模板是 ${first} 开始`,
      "已经过了第一步的时间点，怎么走？",
      [{ key: "shift", label: "从现在顺延", desc: "各步时长不变，整体往后挪，默认", primary: true },
       { key: "plan", label: "按原时间", desc: "已过的步骤直接跳过" },
       { key: "arm", label: "到点自动开始", desc: "先不计时，下次到这个点自己开跑" }]);
    if (!pick) return;
    if (pick === "arm") { await wkArmMode(m); return; }
    plan = pick;
  } else if (late < -2) {
    // 还没到第一步的时间：问一句是现在就开工，还是挂在那儿等到点
    const pick = await wkChoose(`现在 ${wkNow().slice(11, 16)}，模板第 1 步是 ${first}（还没到）`,
      "要么现在就开始计时，要么先挂上、到点再走。",
      [{ key: "shift", label: "从现在开始", desc: "第 1 步立刻计时，后面各步顺延", primary: true },
       { key: "auto", label: `等 ${first} 开始`, desc: "先挂上，到点才计时" },
       { key: "arm", label: "到点自动开始", desc: "以后都按这个点自动开跑" }]);
    if (!pick) return;
    if (pick === "arm") { await wkArmMode(m); return; }
    plan = pick;
  }
  if (btn) { btn.disabled = true; }
  try {
    await api("work/focus/runs", { method: "POST", idempotent: true, body: { mode_id: Number(modeId), plan } }, 20000);
    toast("开始了");
    await loadWork(true);
    wkSetPane("focus");
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message || "开始失败");
  }
}

/* 把这套模式改成「到点自动开始」，不改它的时间与步骤 */
async function wkArmMode(m) {
  try {
    await api(`work/focus/modes/${m.id}`, { method: "PATCH", idempotent: true, body: wkModeBody(m, { auto: 1 }) }, 20000);
    await loadWork(true);
    const ran = await wkAutoCatchUp(Object.assign({}, m, { auto: 1 }));
    if (!ran) {
      toast(`已记住：${(m.steps[0] || {}).anchor || ""} 到点自动开始`);
      wkSetPane("focus");
    }
  } catch (e) { toast(e.message || "设置失败"); }
}

/* 今天这套模式开过没有（开过就不再重复补跑） */
async function wkModeRanToday(modeId) {
  try {
    const d = await api(`work/day?day=${wkToday()}`, {}, 15000);
    // 只有「真的跑过」才算：进行中 / 跑完 / 至少推进过一步。
    // 点开 5 秒就误关的那种 quit 不算，否则之后到点不会再自动补跑。
    return ((d && d.focus) || []).some((r) => Number(r.mode_id) === Number(modeId)
      && (r.status === "running" || r.status === "done" || Number(r.step_idx) >= 1));
  } catch (e) { return false; }
}

/* 刚打开「到点自动」时，如果今天的时间点已经过了，就地从现在开始跑一场（顺延，不跳步） */
async function wkAutoCatchUp(m) {
  if (!Number(m.auto) || !(m.steps || []).length) return false;
  const today = wkToday();
  const act = wkActiveShift(today);
  if (!wkModeMatchDay(m, act.type ? act.day : today, today)) return false;
  const first = String((m.steps[0] || {}).anchor || "").slice(0, 5);
  if (!first) return false;
  if (wkHM2Min(wkNow().slice(11, 16)) < wkHM2Min(first)) return false;
  if (await wkModeRanToday(m.id)) return false;
  wkAutoMark(`${today}:${m.id}:${first}`);
  await api("work/focus/runs", { method: "POST", idempotent: true,
    body: { mode_id: Number(m.id), plan: "shift" } }, 20000);
  toast(`${m.name} 今天已过 ${first}，从现在开始跑`);
  await loadWork(true);
  wkSetPane("focus");
  return true;
}

/* 自动触发记录：按「日期:模式:首步锚点」存成集合，同一天多套模式各自独立；
   原来是单值 today:modeId，两套模式同一时刻只能跑一套，且接口失败也不回滚，之后永远不再试。 */
function wkAutoKeys() {
  try { return JSON.parse(localStorage.getItem("wkAutoRun") || "{}") || {}; } catch (e) { return {}; }
}
function wkAutoMark(key) {
  const o = wkAutoKeys();
  o[key] = Date.now();
  // 只保留最近 400 条，足够覆盖几周内的多套模式
  const ks = Object.keys(o);
  if (ks.length > 400) ks.sort((a, b) => o[a] - o[b]).slice(0, ks.length - 400).forEach((k) => delete o[k]);
  try { localStorage.setItem("wkAutoRun", JSON.stringify(o)); } catch (e) {}
}
function wkAutoUnmark(key) {
  const o = wkAutoKeys();
  if (!(key in o)) return;
  delete o[key];
  try { localStorage.setItem("wkAutoRun", JSON.stringify(o)); } catch (e) {}
}

/* 每分钟看一眼：到点且条件满足就自动开跑（每套模式每天只开一次）
   休息段的唯一作用：休息中不**新开**场次；已经在跑的场次不受影响（那是专注自己的步骤）。 */
function wkAutoFocusTick() {
  const f = wkFocusData();
  if (!f.modes || !f.modes.length) return;
  if (wkLiveRun()) return;
  const today = wkToday();
  const hm = wkNow().slice(11, 16);
  if (state.wkAutoMin === `${today} ${hm}`) return;
  state.wkAutoMin = `${today} ${hm}`;
  const act = wkActiveShift(today);                       // 凌晨续夜班时按夜班算，不按今天的班
  const brkNow = act.type ? wkBreakNow(act.day, act.type) : null;
  const keys = wkAutoKeys();
  for (const m of f.modes) {
    if (!Number(m.auto) || !(m.steps || []).length) continue;
    // 模式的班次条件对着「此刻在岗的班」判：续班时 day 是昨天的班次日
    if (!wkModeMatchDay(m, act.type ? act.day : today, today)) continue;
    const first = String((m.steps[0] || {}).anchor || "").slice(0, 5);
    if (!first) continue;
    const late = wkHM2Min(hm) - wkHM2Min(first);
    if (late < 0 || late > 10) continue;      // 只在正好到点那 10 分钟里自动开
    if (brkNow) continue;   // 休息中不新开；休息结束后若仍在 10 分钟窗口内，下一分钟会再判一次
    const key = `${today}:${m.id}:${first}`;
    if (key in keys) continue;
    wkAutoMark(key);
    api("work/focus/runs", { method: "POST", idempotent: true,
      body: { mode_id: Number(m.id), plan: "auto" } }, 20000)
      .then(() => { toast(`${m.name} 到点自动开始`); return loadWork(true); })
      .then(() => wkSetPane("focus"))
      .catch((e) => { wkAutoUnmark(key); logErr(`autofocus:${m.id}`, e); });
    break;
  }
}

function wkStepsPreview(steps) {
  const all = steps || [];
  if (!all.length) return "";
  // 卡上一行只放得下三步，再多就收成「+N」，避免换行把卡片撑乱
  const show = all.slice(0, 3);
  const rest = all.length - show.length;
  return show.map((s) => `${esc(s.title)} <b>${esc(s.anchor || "")}</b>`).join('<i class="sep">·</i>')
    + (rest > 0 ? ` <i class="sep">…</i>+${rest}` : "");
}

/* 这套模式此刻是否正在进行：有场次在跑，或者今天的步骤时间窗还没走完 */
function wkModeActiveNow(m) {
  const run = wkLiveRun();
  if (run && Number(run.mode_id) === Number(m.id)) return true;
  if (!m || !wkModeDaysOk(m, wkToday())) return false;
  // 班次/周几/日类型不满足的模式（比如只绑了「白班」而今天排的是「标」）不算此刻该跑，
  // 不然它会挤到上面「进行中」那一块去，看着像在跑
  if (!wkModeMatchDay(m, wkToday(), wkToday())) return false;
  const all = (m.steps || []).filter((x) => x && x.anchor);
  if (!all.length) return false;
  const first = wkParse(`${wkToday()} ${String(all[0].anchor).slice(0, 5)}`);
  const last = all[all.length - 1];
  const lastEnd = wkParse(`${wkToday()} ${String(last.anchor).slice(0, 5)}`) + (Number(last.minutes) || 0) * 60000;
  const now = wkNowMs();
  return now >= first - 5 * 60000 && now <= lastEnd;
}

/* 一个模式今天的实际时间轴：有场次在跑时，从「当前这一步的实际开始」顺推（晚 10 分钟开始，
   后面每一步就整体晚 10 分钟）；没在跑就按计划里的 anchor。返回与 steps 等长的
   [{startMs, endMs}]，算不出时间的项是 NaN。
   —— 卡片上显示的钟点、判断「已过」、排提醒，三处都走这一条时间轴，口径才不会再打架。 */
function wkFocusTimeline(m, run, day) {
  // 一律按设置里的时刻走：晚 10 分钟开始也还是 09:00–11:30，
  // 显示、已过判断、开始/结束提醒三处都用这张表，才不会再出现「时间被顺延、到点不提醒」
  // 已经在跑的那场，时间以场次的快照为准：选「从现在顺延」时后端把锚点整体挪过，
  // 再看模板里的 18:45 就会显示成「已过」，和真实进度对不上
  const snap = (run && Array.isArray(run.snapshot) && run.snapshot.length) ? run.snapshot : null;
  const steps = snap || ((m && m.steps) || []);
  const d0 = day || (run && run.day) || wkToday();
  const out = [];
  let prev = NaN;
  steps.forEach((st) => {
    const a = String((st && st.anchor) || "").slice(0, 5);
    let startMs = a ? wkParse(`${d0} ${a}:00`) : NaN;
    if (!isNaN(startMs) && !isNaN(prev) && startMs < prev) startMs += 86400000;   // 跨零点顺延一天
    const mins = Number(st && st.minutes) || 0;
    out.push({ startMs: startMs || NaN, endMs: (startMs || NaN) + mins * 60000, mins });
    prev = startMs;
  });
  return out;
}
/* 专注卡片里的步骤清单：每步前面一个圆点，点一下=这步做过了，这一分钟的提醒也就不再响 */
function wkStepRowsHtml(m, run) {
  const today = wkToday();
  const snap = (run && Array.isArray(run.snapshot) && run.snapshot.length) ? run.snapshot : null;
  const all = snap || (m.steps || []);
  if (!all.length) return "";
  const tl = wkFocusTimeline(m, run, today);
  // 勾过的沉到最后、压成一行小字，没做的排前面 —— 先看到还有哪些没做
  const order = all.map((st, i) => {
    const t = tl[i] || {};
    const at = isFinite(t.startMs) ? wkHM(t.startMs) : String((st && st.anchor) || "").slice(0, 5);
    return { st, i, at, done: wkStepDone(today, m.id, i), t };
  }).sort((x, y) => (x.done === y.done ? (x.at < y.at ? -1 : x.at > y.at ? 1 : x.i - y.i) : x.done ? 1 : -1));
  return order.map(({ st, i, at, done, t }) => {
    const mi = Number(st && st.minutes) || 0;
    // 「已过」只认区间结束：09:00 开始 · 150 分的步骤，11:30 才算过期；区间内属于正在做
    const late = !done && isFinite(t.endMs) && wkNowMs() >= t.endMs;
    if (done) return `<div class="wk-srow mini" data-fstep="${i}">
      <button type="button" class="wk-ck on" data-fck="${i}" aria-label="标记未做"><svg viewBox="0 0 24 24"><path d="M5.5 12.6l4.2 4.2L18.5 7.6"/></svg></button>
      <span class="mini-t">${esc(st.title || "未命名")}</span><span class="mini-hm">${esc(at)}</span>
    </div>`;
    return `<div class="wk-srow" data-fstep="${i}">
      <button type="button" class="wk-ck" data-fck="${i}" aria-label="标记已做"><svg viewBox="0 0 24 24"><path d="M5.5 12.6l4.2 4.2L18.5 7.6"/></svg></button>
      <div class="wk-mid"><span class="wk-t">${esc(st.title || "未命名")}</span>
        <span class="wk-m">${esc(at)}${mi ? ` · ${mi} 分` : ""}${late ? '<i class="wk-late">已过</i>' : ""}</span></div>
    </div>`;
  }).join("");
}

/* 进行中的模式：按第一步时间排序，全部收进同一张卡，步骤圆点直接勾掉，不再占一行按钮 */
function wkActFirst(m) {
  const st = (m.steps || []).find((x) => x && x.anchor);
  return String((st && st.anchor) || "").slice(0, 5);
}
function wkActSectionHtml(m, run) {
  const isRun = !!(run && Number(run.mode_id) === Number(m.id));
  const info = isRun ? focusStepInfo(run) : null;
  const crossDay = !!(isRun && run.day !== wkToday());
  const acts = isRun
    ? `<button type="button" class="wk-fact" data-run="skip">跳过</button>
       <button type="button" class="wk-fact" data-run="end">结束</button>`
    : `<button type="button" class="wk-fact on" data-fstart="${m.id}"${run ? " disabled" : ""}>开始</button>`;
  const runBits = info ? `
      <div class="wk-frun-bar"><i style="width:${focusPct(info, run).toFixed(1)}%"></i></div>
      <div class="wk-frun-m"><span>${wkHM(info.startMs)}</span><span class="left" data-left>${focusLeftText(info)}</span><span>${wkHM(info.endMs)}</span></div>
      ${info.idx + 1 < info.total
        ? `<div class="wk-frun-next">下一步 ${esc(run.snapshot[info.idx + 1].title)} ${Number(run.snapshot[info.idx + 1].minutes) || 0} 分钟 · ${wkHM(info.endMs)} 开始</div>`
        : `<div class="wk-frun-next">这是最后一步，完成后这场就结束了</div>`}` : "";
  return `<div class="wk-fsec" data-fmode="${m.id}"${isRun ? ` data-frun="${run.id}"` : ""}>
      <div class="wk-frun-k"><span class="dot${isRun ? "" : " idle"}"></span>${esc(m.name)}${isRun ? " · 进行中" : ""}${crossDay ? '<i class="wk-frun-xday">跨日</i>' : ""}${isRun ? `<b>${info.idx + 1} / ${info.total}</b>` : ""}
        <span class="wk-factrow">${acts}</span></div>
      <div class="wk-ssteps">${wkStepRowsHtml(m, isRun ? run : null)}</div>
      ${runBits}
    </div>`;
}

function renderFocus() {
  const runBox = $("#wk-focus-run");
  const listBox = $("#wk-focus-list");
  if (!runBox || !listBox) return;
  const f = wkFocusData();
  const run = wkLiveRun();
  const modes = (f.modes || []);
  // 今天正在进行中的模式（有场次在跑，或时间窗还没走完）按开始时间排在一起
  const active = modes.filter((m) => wkModeActiveNow(m) && (m.steps || []).length)
    .sort((a, b) => (wkActFirst(a) < wkActFirst(b) ? -1 : wkActFirst(a) > wkActFirst(b) ? 1 : 0));
  // 超过 4 套就收成可滑动的一段，免得整页被撑长（滚动条沿用全局的透明款）
  runBox.innerHTML = active.length
    ? `<div class="wk-frun wk-fhub">${active.map((m) => wkActSectionHtml(m, run)).join("")}</div>`
    : "";
  wkBindRunBox(runBox);

  listBox.innerHTML = modes.length ? modes.map((m) => {
    if (wkModeActiveNow(m)) return "";      // 已经在上面那张进行中的卡里
    return `<div class="wk-fmode" data-fmode="${m.id}">
      <div class="wk-fhead"><span class="wk-ft">${esc(m.name)}</span>
        <button type="button" class="wk-fstart" data-fstart="${m.id}"${run ? " disabled" : ""}>开始</button></div>
      <div class="wk-fsteps">${wkStepsPreview(m.steps)}</div>
      <div class="wk-fmeta">${esc(m.start || (m.steps[0] && m.steps[0].anchor) || "")}–${esc(wkCrossHM(m.start || (m.steps[0] && m.steps[0].anchor) || "", m.end || ""))} · ${(m.steps || []).length} 步 · ${wkDur((m.total || 0) * 60000)}</div>
      ${(Number(m.auto) || wkRuleText(m)) ? `<div class="wk-frule">${Number(m.auto) ? '<b>到点自动</b>' : ""}${Number(m.auto) && wkRuleText(m) ? '<i class="sep">·</i>' : ""}${esc(wkRuleText(m) || (Number(m.auto) ? "每天 · 到点" : ""))}</div>` : ""}
    </div>`;
  }).join("")
    : `<div class="wk-empty">${run ? "今天只跑这一场，跑完再加新模式" : "把一天的流程拆成几步存成模板<br>明天点一下，按顺序往下走"}</div>`;

  // 专注模式卡也支持左滑删除
  wkSwipeRows(listBox, ".wk-fmode", async (card) => {
    const mid = Number(card.dataset.fmode);
    try {
      await api(`work/focus/modes/${mid}`, { method: "DELETE", idempotent: true }, 20000);
      toast("已删除这个专注模式");
      await loadWork(true);
    } catch (e) { toast(e.message || "删除失败"); throw e; }
  });
  $$("[data-fmode]", listBox).forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest("[data-fstart]")) return;
      openFocusEditor(card.dataset.fmode);
    };
  });
  $$("[data-fstart]", listBox).forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); if (run) return toast("先结束进行中的场次"); wkFocusStart(b.dataset.fstart, b); };
  });
  wkBindStepDots(listBox);
}

/* 勾掉某一步：点圆点就是「这步做过了」；有场次在跑且点的正是当前步，顺手推进到下一步 */
function wkBindStepDots(root) {
  $$("[data-fck]", root).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const card = b.closest("[data-fmode]");
      const mid = Number(card && card.dataset.fmode);
      const m0 = ((wkFocusData().modes || []).find((x) => Number(x.id) === mid));
      if (!m0) return;
      const idx = Number(b.dataset.fck);
      const today = wkToday();
      const done = !wkStepDone(today, mid, idx);
      wkSetStepDone(today, mid, idx, done);
      const a = state.wkAlarm;
      const aid = `m${mid}_${idx}_${today}`;
      if (done && a && a.kind === "focus" && a.id === aid) {
        wkKillAlarm();
        wkMarkSeen(a);
      } else if (done) {
        // 没弹卡但还在响（系统通知那边在循环）：这一步时间已经过了就先把铃声停掉
        const anchor = String(((m0.steps || [])[idx] || {}).anchor || "").slice(0, 5);
        if (anchor && wkParse(`${today} ${anchor}:00`) <= wkNowMs() + 60000) wkStopRing(null);
      }
      wkPushNative();                 // 立刻重推：这一条从系统通知里撤掉
      if (done) wkStepAdvanceIfCurrent(mid, idx);
      renderFocus();
    };
  });
}

function wkStepAdvanceIfCurrent(mid, idx) {
  const run = wkLiveRun();
  if (!run || Number(run.mode_id) !== mid || Number(run.step_idx) !== idx) return;
  wkRunAdvance("done");
}

/* 进行中的卡里还有自己的按钮（跳过/结束/开始）和点卡片进编辑器 */
function wkBindRunBox(runBox) {
  $$("[data-run]", runBox).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); wkRunAdvance(b.dataset.run); }; });
  $$("[data-fstart]", runBox).forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); if (wkLiveRun()) return toast("先结束进行中的场次"); wkFocusStart(b.dataset.fstart, b); };
  });
  $$("[data-fmode]", runBox).forEach((sec) => {
    sec.onclick = (e) => { if (e.target.closest("button")) return; openFocusEditor(sec.dataset.fmode); };
  });
  wkBindStepDots(runBox);
}

async function wkRunAdvance(kind) {
  const run = (wkFocusData().run) || null;
  if (!run) return;
  const steps = run.snapshot || [];
  let body;
  if (kind === "end") body = { status: "quit" };
  else if (Number(run.step_idx) + 1 >= steps.length) body = { status: "done" };
  else {
    const nx = steps[Number(run.step_idx) + 1];
    let cur = wkNowSec();
    const nxMs = wkStepStartMs(run, Number(run.step_idx) + 1);
    if (nx.anchor && nxMs > wkNowMs()) cur = wkFmtMin(nxMs);
    body = { step_idx: Number(run.step_idx) + 1, cur_start: cur };
  }
  try {
    await api(`work/focus/runs/${run.id}`, { method: "PATCH", idempotent: true, body }, 20000);
    if (kind !== "auto") toast(kind === "end" ? "这一场结束了" : "下一步");
    await loadWork(true);
  } catch (e) { toast(e.message || "操作失败"); }
}

function wkDurText(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h${r}` : `${h}h`;
}
function wkDurCN(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
/* 小时数显示：8.5 不写成 9（原来 Math.round 会把用户填的 8.5 吞成 9） */
function wkDurH(min) {
  const m = Math.round(Number(min) || 0);
  const h = m / 60;
  return Number.isInteger(h) ? String(h) : String(Math.round(h * 100) / 100);
}
function shiftEndText(t) {
  if (!t) return "";
  if (t.kind === "off") return "不值班";
  const brk = wkBreakText(t) ? ` · 休 ${wkBreakText(t)}` : "";
  if (t.kind === "long") return `${t.start} + ${wkDurText(t.dur_min)}（${t.end}${t.cross_day ? " 次日" : ""}）${brk}`;
  return `${t.start}–${t.cross_day ? "次日 " : ""}${t.end}${brk}`;
}
function wkBreakText(t) {
  const b = (t && t.breaks) || [];
  if (!b.length) return "";
  return b.map((x) => `${String(x[0]).slice(0, 5)}–${String(x[1]).slice(0, 5)}`).join("、");
}
/* 现在是否正处在这个班次的某段休息里，返回休息结束时刻（HH:MM） */
function wkBreakNow(day, type) {
  if (!type || type.kind === "off" || !(type.breaks || []).length) return null;
  const sMs = shiftStartMs(day, type), eMs = shiftEndMs(day, type), now = wkNowMs();
  if (!sMs || now < sMs || now >= eMs) return null;
  const spent = Math.floor((now - sMs) / 60000);
  for (const [a, b] of type.breaks) {
    const off = ((wkHM2Min(a) - wkHM2Min(type.start)) + 1440) % 1440;
    const len = ((wkHM2Min(b) - wkHM2Min(a)) + 1440) % 1440;
    if (spent >= off && spent < off + len) return String(b).slice(0, 5);
  }
  return null;
}
function shiftStartMs(day, type) {
  if (!type || type.kind === "off") return 0;
  return wkParse(`${day} ${type.start}:00`);
}
function shiftEndMs(day, type) {
  if (!type || type.kind === "off") return 0;
  return wkParse(`${type.cross_day ? wkDayAdd(day, 1) : day} ${type.end}:00`);
}
function shiftNextStart() {
  const nowMs = wkNowMs();
  let d = wkToday();
  for (let i = 0; i < 60; i++) {
    const info = shiftInfo(d);
    if (info.type && info.type.kind !== "off" && shiftStartMs(d, info.type) > nowMs) {
      return { day: d, type: info.type, at: `${d} ${info.type.start}` };
    }
    d = wkDayAdd(d, 1);
  }
  return null;
}
function shiftNextText() {
  const nx = shiftNextStart();
  if (!nx) return "";
  const dd = nx.at.slice(5, 10).replace("-", "/");
  const same = nx.day === wkDayAdd(wkToday(), 1);
  return `${same ? "明天" : dd} ${nx.type.name}`;
}
function shiftCountText(day, type) {
  if (!type || type.kind === "off") return "今天不值班";
  const end = shiftEndMs(day, type), now = wkNowMs();
  const start = shiftStartMs(day, type);
  if (start && now < start) return `距上班 ${wkDur(start - now)}`;   // 今天排了班但还没到点：别拿下班时间去减
  const brk = wkBreakNow(day, type);
  if (brk) return `休息中 · ${brk} 回来`;
  if (end <= now) return `已下班 ${wkDur(now - end)}`;
  const leftBreak = wkBreakLeftMin(day, type, now);
  // 「距下班」= 还要干多久（扣掉后面还会休的时间），和卡片上的「工作 X 小时」同一口径
  return leftBreak ? `还需工作 ${wkDur(end - now - leftBreak * 60000)} · 含休 ${wkDur(leftBreak * 60000)}`
    : `距下班 ${wkDur(end - now)}`;
}
function wkTickShift() {
  const el = $("#wk-sh-count");
  if (!el || document.hidden) return;
  const today = wkToday();
  const act = wkActiveShift(today);
  if (act.type) el.textContent = shiftCountText(act.day, act.type);
}

function shiftCardHtml() {
  const today = wkToday();
  const s = wkShiftData();
  if (!(s.rosters || []).length) {
    return `<div class="wk-shift-card">
      <div class="wk-sh-k"><b>今天</b>· 还没排班</div>
      <div class="wk-sh-t off">先加一套轮转表</div>
      <div class="wk-sh-m">定义班次（白 08-20、夜 20-次日 08），再写“白、夜、休、休”这样的顺序</div>
    </div>`;
  }
  const act = wkActiveShift(today);
  if (act.continued) {
    return `<div class="wk-shift-card">
      <div class="wk-sh-k"><b>今天</b>· ${esc(act.type.name)} 续</div>
      <div class="wk-sh-t">${esc(act.type.end)} 下班</div>
      <div class="wk-sh-s" id="wk-sh-count"></div>
      <div class="wk-sh-m">${act.roster ? esc(act.roster.name) : ""}</div>
    </div>`;
  }
  const info = shiftInfo(today);
  const nxTxt = shiftNextText();
  if (info.type && info.type.kind === "off") {
    return `<div class="wk-shift-card">
      <div class="wk-sh-k"><b>今天</b>· ${esc(info.type.name)}</div>
      <div class="wk-sh-t">不用到岗</div>
      <div class="wk-sh-m">轮到了但今天不值班${nxTxt ? ` · 下次 ${esc(nxTxt)}` : ""}</div>
    </div>`;
  }
  if (info.type) {
    const bk = (info.type.breaks || []).length;
    const dm = bk ? (info.type.work_min || info.type.dur_min) : info.type.dur_min;
    const dur = bk ? `在岗 ${wkDurCN(info.type.dur_min)} · 工作 ${wkDurCN(dm)} · 休 ${wkDurCN(info.type.break_min || (info.type.dur_min - dm))}`
      : info.type.kind === "long" ? wkDurCN(dm) : "";
    // 「连续第几天」只在轮转多于一种班次时才有意义（常白这种单班次轮转天天都是第 1 天，不显示）
    const kinds = (info.roster && info.roster.pattern || []).filter((x, i, a) => a.indexOf(x) === i).length;
    const seqTxt = info.roster && kinds > 1 ? `第 ${shiftSeq(today, info.type.id)} 天` : "";
    return `<div class="wk-shift-card">
      <div class="wk-sh-k"><b>今天</b>· ${esc(info.type.name)}${seqTxt ? `<i class="wk-sh-seq">${seqTxt}</i>` : ""}</div>
      <div class="wk-sh-t">${esc(info.type.start)} → ${info.type.cross_day ? "次日 " : ""}${esc(info.type.end)}</div>
      <div class="wk-sh-s" id="wk-sh-count"></div>
      <div class="wk-sh-m">${[dur, info.roster && !info.overridden ? esc(info.roster.name) : ""].filter(Boolean).join(" · ")}</div>
    </div>`;
  }
  return `<div class="wk-shift-card">
    <div class="wk-sh-k"><b>今天</b>· 休息</div>
    <div class="wk-sh-t off">${nxTxt ? `下次 ${esc(nxTxt)}` : "近期没有排班"}</div>
    <div class="wk-sh-m">${info.roster && !info.overridden ? esc(info.roster.name) : ""}</div>
  </div>`;
}

/* ---- 农历与节假日（内置 JSON，不联网） ---- */
function wkCalData() {
  state.cal = state.cal || { lunar: null, holiday: null, failed: false };
  return state.cal;
}
async function wkLoadCalData() {
  const cd = wkCalData();
  if (cd.lunar || cd.failed) return;
  try {
    const [l, h] = await Promise.all([
      fetch("static/data/lunar.json", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("static/data/holidays.json", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({})),
    ]);
    cd.lunar = l; cd.holiday = h || {};
    if (!document.getElementById("view-work").classList.contains("hidden")) renderShift();
  } catch (e) { cd.failed = true; }
}
function wkLunarOn() {
  try { return localStorage.getItem("wkCalLunar") !== "off"; } catch (e) { return true; }
}
function wkLunarText(day) { const cd = wkCalData(); return (cd.lunar && cd.lunar[day]) || ""; }
function wkHolidayOf(day) { const cd = wkCalData(); return (cd.holiday && cd.holiday[day]) || null; }

function wkCalHtml() {
  const today = wkToday();
  const month = state.wkCal || today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const on = wkLunarOn();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<span class="wk-cal-cell out"></span>');
  for (let d = 1; d <= days; d++) {
    const day = `${y}-${wkPad(m)}-${wkPad(d)}`;
    const info = shiftInfo(day);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const hol = on ? wkHolidayOf(day) : null;
    const lunar = on ? wkLunarText(day) : "";
    const t = info.type;
    const long = t && t.kind === "long";
    const off = (t && t.kind === "off") || info.rest;
    const hasPlan = !!t || info.rest;
    const top = on ? (hol && hol.off && hol.name ? esc(hol.name) : esc(lunar)) : "";
    const durTxt = long ? `${wkDurText(t.dur_min)}` : "";
    let bottom = "";
    if (on && hol) {
      if (hol.work) bottom = '<em class="wk-cal-h w">班</em>';
      else if (!hol.name || hol.name !== top) bottom = `<em class="wk-cal-h">${esc(hol.name || "")}</em>`;
    }
    cells.push(`<button type="button" class="wk-cal-cell${t && t.cross_day ? " night" : ""}${off ? " duty-off" : ""}${day === today ? " today" : ""}${day === state.wkDay ? " sel" : ""}${!on ? " compact" : ""}${dow === 0 || dow === 6 ? " we" : ""}" data-showday="${day}">
        <span class="d">${d}</span>${top ? `<em class="wk-cal-l">${top}</em>` : ""}
        ${hasPlan ? `<b class="s">${esc(t ? t.short || "休" : "休")}</b>${durTxt ? `<em class="wk-cal-dur">${durTxt}</em>` : ""}` : ""}
        ${bottom}
        ${t && t.cross_day ? '<em class="x">→</em>' : ""}${info.overridden ? '<i class="ov"></i>' : ""}
      </button>`);
  }
  const s = wkShiftData();
  return `<div class="wk-cal-h">
      <button type="button" class="wk-cal-nav" data-calprev aria-label="上个月">‹</button>
      <b>${y} 年 ${m} 月</b>
      <button type="button" class="wk-cal-nav" data-calnext aria-label="下个月">›</button>
      <button type="button" class="wk-cal-today" data-caltoday>今天</button>
    </div>
    <div class="wk-cal-dow">${["一", "二", "三", "四", "五", "六", "日"].map((x) => `<span>${x}</span>`).join("")}</div>
    <div class="wk-cal-grid">${cells.join("")}</div>
    ${(function () {
      const today = wkToday();
      const dstr = (x) => String(x || "").slice(0, 10);
      const future = (s.rosters || []).filter((r) => dstr(r.effective_from) > today)
        .sort((a, b) => (dstr(a.effective_from) < dstr(b.effective_from) ? -1 : 1))[0];
      const anyLive = (s.rosters || []).some((r) => dstr(r.effective_from) <= today
        && (!r.end_date || dstr(r.end_date) >= today));
      if (future && !anyLive) {
        return `<div class="wk-cal-tip">「${esc(future.name)}」${esc(dstr(future.effective_from).slice(5).replace("-", "/"))} 起生效，之前没有排班</div>`;
      }
      const mStart = `${month}-01`;
      // 当月完全没被任何轮转覆盖、但之前有轮转在这个月之前就结束了 → 说明是「到期了」
      const covered = (s.rosters || []).some((r) => dstr(r.effective_from) <= `${month}-31`
        && (!r.end_date || dstr(r.end_date) >= mStart));
      const ended = (s.rosters || []).filter((r) => r.end_date && dstr(r.end_date) < mStart)
        .sort((a, b) => (dstr(a.end_date) < dstr(b.end_date) ? 1 : -1))[0];
      if (ended && !covered) {
        return `<div class="wk-cal-tip">「${esc(ended.name)}」${esc(dstr(ended.end_date).slice(5).replace("-", "/"))} 已结束，之后没有排班</div>`;
      }
      // 月中有轮转覆盖不到的日子：把日期点出来。以前这些格子就是空白，看着像「轮转表没生效」
      const gaps = [];
      let gapRun = null;
      if ((s.rosters || []).length) {
        for (let d = 1; d <= days; d++) {
          const day = `${month}-${wkPad(d)}`;
          const hasOv = Object.prototype.hasOwnProperty.call(wkShiftData().overrides || {}, day);
          if (wkRosterOn(day) || hasOv) { if (gapRun) { gaps.push(gapRun); gapRun = null; } }
          else if (gapRun) gapRun[1] = d; else gapRun = [d, d];
        }
        if (gapRun) gaps.push(gapRun);
      }
      if (gaps.length) {
        const txt = gaps.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join("、");
        return `<div class="wk-cal-tip">${txt} 号没有排班：轮转表没覆盖到这些日子</div>`;
      }
      return "";
    })()}`;
}

function wkPickDay(day) {
  state.wkDay = String(day || "").slice(0, 10);
  renderWork();
}

function renderShift() {
  const card = $("#wk-shift-card");
  const cal = $("#wk-cal");
  if (!card || !cal) return;
  card.innerHTML = shiftCardHtml();
  cal.innerHTML = wkCalHtml();
  wkLoadCalData();
  const month = () => state.wkCal || wkToday().slice(0, 7);
  const shiftMonth = (n) => {
    const [y, m] = month().split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    state.wkCal = `${d.getUTCFullYear()}-${wkPad(d.getUTCMonth() + 1)}`;
    renderShift();
  };
  const prev = $("[data-calprev]", cal), next = $("[data-calnext]", cal), now = $("[data-caltoday]", cal);
  if (prev) prev.onclick = () => shiftMonth(-1);
  if (next) next.onclick = () => shiftMonth(1);
  if (now) now.onclick = () => {
    state.wkCal = wkToday().slice(0, 7);
    wkPickDay(wkToday());
    renderShift();
  };
  // 轻点：下方只显示这一天的日程；长按 480ms：看/改这天的班次（原来轻点就弹班次，和「只看今天」抢同一个手势）
  $$("[data-showday]", cal).forEach((c) => {
    let timer = null;
    const day = c.dataset.showday;
    const down = () => {
      timer = setTimeout(() => {
        timer = null;
        c.dataset.held = "1";
        openShiftDay(day);
      }, 480);
    };
    const up = () => { if (timer) { clearTimeout(timer); timer = null; } };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", up);
    c.onclick = () => {
      if (c.dataset.held === "1") { c.dataset.held = ""; return; }
      wkPickDay(day);
      $$("[data-showday]", cal).forEach((x) => x.classList.toggle("sel", x.dataset.showday === day));
    };
  });
  wkTickShift();
  wkOvRenderEntry();
  wkOvEnsure().then(() => wkOvRenderEntry());
}

function renderWkStat() {
  const stat = $("#wk-stat");
  if (!stat) return;
  const pane = state.wkPane || "sch";
  if (pane === "focus") {
    const f = (state.work && state.work.focus) || { modes: [], run: null };
    const run = wkLiveRun();
    stat.textContent = run ? `进行中 · 第 ${Number(run.step_idx) + 1}/${(run.snapshot || []).length} 步`
      : (f.modes || []).length ? "今天未开始" : "还没有专注模式";
  } else if (pane === "shift") {
    const today = wkToday();
    const act = wkActiveShift(today);
    if (act.continued) {
      stat.textContent = `${act.type.name} 续 · ${shiftCountText(act.day, act.type)}`;
      return;
    }
    const t = shiftInfo(today);
    const nx = shiftNextText();
    if (t.type && t.type.kind === "off") stat.textContent = (t.rest ? "今天休息" : "今天不值班") + (nx ? ` · 下次 ${nx}` : "");
    else if (t.type) stat.textContent = `${t.type.name} · ${shiftCountText(today, t.type)}`;
    else stat.textContent = nx ? `今天休息 · 下次 ${nx}` : "今天休息";
  } else {
    const { tasks } = state.work || { tasks: [] };
    const today = wkNow().slice(0, 10);
    const pend = (tasks || []).filter((t) => !t.done);
    const todayAll = (tasks || []).filter((t) => String(t.due_at || "").slice(0, 10) === today).length;
    const todayPend = pend.filter((t) => String(t.due_at || "").slice(0, 10) === today).length;
    stat.textContent = todayAll ? `今天 ${todayAll} 项 · 其中待办 ${todayPend} 项` : `待办 ${pend.length} 项`;
  }
}

/* 顶部那条「现在」的信息：班次 + 正在进行的事，统一放在标签栏上面，不再在页内重复 */
function wkCtxShift() {
  const s = wkActiveShift(wkToday());
  if (!s.type) return null;
  const t = s.type;
  const text = t.kind === "off" ? `${t.name} · 不用到岗`
    : `${t.short} ${t.start} → ${t.cross_day ? "次日 " : ""}${t.end}`;
  const sub = s.roster ? `本班第 ${shiftSeq(s.day, t.id)} 天 · ${s.roster.name}${s.continued ? " · 续班" : ""}` : "";
  return { text, sub };
}

function openShiftDay(day) {
  const info = shiftInfo(day);
  const s = wkShiftData();
  const t = info.type;
  const isRest = !t;
  // 轮转本来排了班，但这天绑定的专注不跑（例如只在工作日跑）→ 显示成休，并把原因写出来
  const rawId = wkRosterRawId(day);
  const modeRest = isRest && !!info.roster && !!rawId && !wkShiftRunsOn(rawId, day);
  const timeLine = t ? (t.kind === "off" ? "不值班 · 不用到岗"
    : `${esc(t.start)} → ${t.cross_day ? "次日 " : ""}${esc(t.end)}${t.kind === "long" ? ` · ${wkDurCN(t.dur_min)}` : ""}${wkBreakText(t) ? ` · 休 ${wkBreakText(t)}` : ""}`) : "";
  const lunar = wkLunarOn() ? wkLunarText(day) : "";
  const hol = wkLunarOn() ? wkHolidayOf(day) : null;
  const sub = [lunar, hol && hol.off ? esc(hol.name) : hol && hol.work ? "调休补班" : ""].filter(Boolean).join(" · ");
  openSheet(wkDayLabel(day), `<div class="wk-form">
    <div>
      <div class="wk-ds-main">${isRest ? "休息" : esc(t.name)}${sub ? `<span class="wk-ds-sub">${sub}</span>` : ""}</div>
      ${timeLine ? `<div class="wk-ds-time">${timeLine}</div>` : ""}
      <div class="wk-ds-meta">${info.roster && !info.overridden ? `${esc(info.roster.name)}${isRest || t.kind === "off" ? "" : ` · 本班第 ${shiftSeq(day, t.id)} 天`}${modeRest ? " · 绑定的专注今天不跑，按休" : ""}` : (info.overridden ? "手调过这一天" : "这一天没有排班")}</div>
    </div>
    <div class="field"><label>调整这天</label>
      <div class="chips chips-row wk-pick" id="wk-ov">
        ${(s.types || []).map((x) => `<button type="button" class="chip${info.overridden && t && t.id === x.id ? " on" : ""}" data-ov="${x.id}">${esc(x.short)}</button>`).join("")}
        <button type="button" class="chip${info.overridden && isRest ? " on" : ""}" data-ov="0">休</button>
        ${info.overridden ? '<button type="button" class="chip" data-ov="-1">恢复轮转</button>' : ""}
      </div></div>
    <div class="wk-sec">这一天的工作 <span class="wk-day-at" id="wk-day-at"></span></div>
    <div id="wk-day-work" class="wk-day-work"><div class="wk-tip">读取中…</div></div>
    <div class="wk-tip">调班只影响这一天，不改轮转表；改过的日子在日历上带一个小点。</div>
  </div>`);
  wkLoadDayWork(day);
  $$("#wk-ov [data-ov]").forEach((b) => {
    b.onclick = async () => {
      const v = Number(b.dataset.ov);
      $$("#wk-ov .chip").forEach((x) => x.disabled = true);
      try {
        await api(`work/shift/overrides/${day}`, { method: "PUT", idempotent: true,
          body: { shift_id: v < 0 ? null : v } }, 20000);
        closeSheet(); toast(v < 0 ? "已恢复轮转" : "已调整");
        await loadWork(true); wkSetPane("shift");
      } catch (e) {
        $$("#wk-ov .chip").forEach((x) => x.disabled = false);
        toast(e.message || "调整失败");
      }
    };
  });
}

/* 点日历某天：把那天真实做过的日程与专注拉出来（历史也能看） */
async function wkLoadDayWork(day) {
  const box = $("#wk-day-work");
  if (!box) return;
  let d = null;
  try { d = await api(`work/day?day=${day}`, {}, 15000); } catch (e) { d = null; }
  if (!$("#wk-day-work")) return;   // 弹层已经关掉
  if (!d) { box.innerHTML = '<div class="wk-tip">没读到这一天的记录</div>'; return; }

  try {
  const typeName = (id) => wkTypeName(id);
  const tasks = (d.tasks || []);
  const runs = (d.focus || []);
  const taskHtml = tasks.length ? tasks.map((t) => `
      <div class="wk-day-row${t.done ? " done" : ""}"${t.id ? ` data-daytask="${t.id}"` : ""}>
        <span class="wk-day-time">${String(t.due_at).slice(11, 16)}</span>
        <span class="wk-day-tx">${esc(t.title)}</span>
        <span class="wk-day-meta">${esc(typeName(t.type_id))}${(t.days || []).length ? " · 重复" : ""}${t.done ? " · 已完成" : ""}</span>
      </div>`).join("") : '<div class="wk-tip">这天没有日程</div>';

  // 同一天同一个模式可能被反复「开始/结束」，只留一条：首次开始 → 最后结束，重启次数折进备注
  const groups = [];
  const byMode = new Map();
  runs.forEach((r) => {
    const key = String(r.mode_name || "专注");
    const g = byMode.get(key);
    if (!g) {
      byMode.set(key, { key, first: r.started_at, last: r.ended_at || "", status: r.status,
        cont: String(r.started_at).slice(0, 10) !== day,
        idx: Number(r.step_idx) || 0, steps: (r.snapshot || []).map((x) => x.title).filter(Boolean), count: 1 });
      return;
    }
    g.count += 1;
    if (String(r.started_at) < String(g.first)) g.first = r.started_at;
    if (r.ended_at && String(r.ended_at) > String(g.last)) g.last = r.ended_at;
    if (r.status === "running") g.status = "running";
    else if (g.status !== "running" && r.status === "done") g.status = "done";
    if (String(r.started_at) >= String(g.first)) g.idx = Number(r.step_idx) || 0;
    if ((r.snapshot || []).length) g.steps = (r.snapshot || []).map((x) => x.title).filter(Boolean);
  });
  byMode.forEach((g) => groups.push(g));
  groups.sort((a, b) => (String(a.first) < String(b.first) ? -1 : 1));
  const at = $("#wk-day-at");
  if (at) at.textContent = `${tasks.length} 项日程 · ${groups.length} 次专注`;

  const runHtml = groups.length ? groups.map((g) => {
    const total = g.steps.length || 1;
    const idx = Math.min(Math.max(g.idx, 0), total - 1);
    const st = g.status === "running" ? "进行中" : g.status === "done" ? "已完成" : "已结束";
    const end = g.status === "running" ? "现在" : (g.last ? String(g.last).slice(11, 16) : "—");
    return `<div class="wk-day-run">
        <div class="wk-day-row">
          <span class="wk-day-time">${g.cont ? "昨 " : ""}${String(g.first).slice(11, 16)}</span>
          <span class="wk-day-tx">${esc(g.key)}</span>
          <span class="wk-day-meta">${st} · 第 ${idx + 1}/${total} 步${g.count > 1 ? ` · 分 ${g.count} 段` : ""}</span>
        </div>
        <div class="wk-day-sub">${g.steps.length ? esc(g.steps.join(" › ")) : ""}${g.steps.length ? " · " : ""}${g.status === "running" ? "进行中" : "到 " + end}${g.count > 1 ? ` · 开了 ${g.count} 次` : ""}</div>
      </div>`;
  }).join("") : '<div class="wk-tip">这天没有专注记录</div>';

  box.innerHTML = `<div class="wk-day-list">${taskHtml}</div>
    <div class="wk-day-cap">专注</div><div class="wk-day-list">${runHtml}</div>`;
  } catch (e) {
    if (box) box.innerHTML = `<div class="wk-tip">这一天的记录没渲染出来：${esc(e && e.message || e)}</div>`;
  }
}
function openShiftSettings() {
  const s = wkShiftData();
  const types = s.types || [], rosters = s.rosters || [];
  const names = (pat) => (pat || []).map((id) => {
    const t = types.find((x) => Number(x.id) === Number(id));
    return t ? t.short : "休";
  }).join("·");
  const rangeTxt = (r) => {
    const from = String(r.effective_from || "").slice(5).replace("-", "/");
    const to = String(r.end_date || "").slice(5).replace("-", "/");
    return to ? `${from}–${to}` : `${from} 起`;
  };
  // 轮转表按生效日倒序，列表只放最近 3 套；更早的收起来（历史日期仍按它们算，不做删除）
  const allR = rosters.slice().sort((a, b) => {
    const x = String(a.effective_from || "").slice(0, 10), y = String(b.effective_from || "").slice(0, 10);
    if (x !== y) return x < y ? 1 : -1;
    return Number(b.id) - Number(a.id);
  });
  const SR_LIMIT = 3;
  const shownR = state.srAll ? allR : allR.slice(0, SR_LIMIT);
  const hiddenN = allR.length - shownR.length;          // 收起时：还有几套没显示
  const moreN = state.srAll ? Math.max(0, allR.length - SR_LIMIT) : 0;
  const lunarOn = wkLunarOn();
  openSheet("班次与轮转", `<div class="wk-form">
    <div class="wk-sec">班次</div>
    ${types.map((t) => `<button type="button" class="wk-set-row" data-st="${t.id}">
        <span class="n">${esc(t.name)}</span><em>${esc(shiftEndText(t))}</em><span class="wk-chev">›</span></button>`).join("")
      || '<div class="wk-tip">还没有班次</div>'}
    <button type="button" class="wk-step-add" id="st-add">＋ 添加班次</button>
    <div class="wk-sec">轮转表<i class="wk-opt">最近 3 套</i></div>
    ${shownR.map((r) => `<button type="button" class="wk-set-row" data-sr="${r.id}">
        <span class="n">${esc(r.name)}</span><em>${names(r.pattern)} · ${rangeTxt(r)}</em><span class="wk-chev">›</span></button>`).join("")
      || '<div class="wk-tip">还没有轮转表</div>'}
    ${hiddenN ? `<button type="button" class="wk-set-row" id="sr-more">
        <span class="n">更早的 ${hiddenN} 套</span><em>查看</em><span class="wk-chev">›</span></button>` : ""}
    ${!hiddenN && moreN ? `<button type="button" class="wk-set-row" id="sr-less">
        <span class="n">收起更早的 ${moreN} 套</span><em>只看最近 3 套</em><span class="wk-chev">›</span></button>` : ""}
    <button type="button" class="wk-step-add" id="sr-add">＋ 新建轮转表</button>
    <div class="wk-sec">显示</div>
    <button type="button" class="wk-set-row" id="cal-lunar">
      <span class="n">日历显示农历与节假日</span><em id="cal-lunar-v">${lunarOn ? "开" : "关"}</em>
    </button>
    <div class="wk-tip">修改轮转表会重算所有历史日期的显示，改之前先想清楚。</div>
  </div>`);
  $$("#sheet-content [data-st]").forEach((b) => { b.onclick = () => openShiftTypeEditor(b.dataset.st); });
  $$("#sheet-content [data-sr]").forEach((b) => { b.onclick = () => openShiftRosterEditor(b.dataset.sr); });
  $("#st-add").onclick = () => openShiftTypeEditor(""); 
  $("#sr-add").onclick = () => openShiftRosterEditor("");
  const srMore = $("#sr-more");
  if (srMore) srMore.onclick = () => { state.srAll = true; openShiftSettings(); };
  const srLess = $("#sr-less");
  if (srLess) srLess.onclick = () => { state.srAll = false; openShiftSettings(); };
  $("#cal-lunar").onclick = () => {
    let on = wkLunarOn();
    try { localStorage.setItem("wkCalLunar", on ? "off" : "on"); } catch (e) {}
    $("#cal-lunar-v").textContent = on ? "关" : "开";
    renderShift();
  };
}

function openShiftTypeEditor(tid) {
  const t = tid ? (wkShiftData().types || []).find((x) => Number(x.id) === Number(tid)) : null;
  let kind = t ? (t.kind || "shift") : "shift";
  let dur = t && t.dur_min ? Math.round(Number(t.dur_min)) / 60 : 12;  // 保留 8.5 这种非整点
  let bound = ((t && t.modes) || []).map(Number);
  openSubSheet(t ? "编辑班次" : "添加班次", `<div class="wk-form">
    <div class="field"><label>类型</label>
      <div class="chips wk-pick" id="st-kind">
        <button type="button" class="chip" data-kind="shift">常规班</button>
        <button type="button" class="chip" data-kind="long">长日班</button>
        <button type="button" class="chip" data-kind="off">不值班</button>
      </div></div>
    <div class="field"><label>名称</label><input id="st-name" maxlength="12" placeholder="例如：白班 / 长白 / 值班" value="${esc(t ? t.name : "")}"></div>
    <div class="field"><label>简称<i class="wk-opt">日历上显示 1–2 字</i></label><input id="st-short" maxlength="2" placeholder="白 / 夜 / 不" value="${esc(t ? t.short : "")}"></div>
    <div id="st-time-wrap"></div>
    <div class="field"><div class="wk-kvs" id="st-modes"></div></div>
    <div class="sheet-actions"><button class="btn primary" id="st-save">保存</button>${t ? '<button class="btn danger" id="st-del">删除</button>' : ""}</div>
  </div>`);
  const wrap = $("#st-time-wrap");
  let breaks = ((t && t.breaks) || []).map((x) => [String(x[0] || "").slice(0, 5), String(x[1] || "").slice(0, 5)]);
  const brkLen = (a, b) => ((wkHM2Min(b) - wkHM2Min(a)) + 1440) % 1440;
  const brkOff = (a, s) => ((wkHM2Min(a) - wkHM2Min(s)) + 1440) % 1440;
  const hmAt = (s, off) => {
    const m = wkHM2Min(s) + off;
    return `${wkPad((Math.floor(m / 60) % 24 + 24) % 24)}:${wkPad(((m % 60) + 60) % 60)}`;
  };
  const spanInfo = () => {
    if (kind === "off") return null;
    const s = (($("#st-start") && $("#st-start").value) || (t && t.start) || "08:00").slice(0, 5);
    let d;
    if (kind === "long") d = Math.round((Number(($("#st-dur") && $("#st-dur").value) || 0) * 60));
    else d = ((wkHM2Min((($("#st-end") && $("#st-end").value) || "20:00").slice(0, 5)) - wkHM2Min(s)) + 1440) % 1440 || 1440;
    return { s, dur: d };
  };
  const breaksFit = (sp) => {
    if (!sp) return true;
    const segs = breaks.map(([a, b]) => [brkOff(a, sp.s), brkLen(a, b)]);
    for (const [off, n] of segs) if (n < 5 || off + n > sp.dur) return false;
    segs.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < segs.length; i += 1) {
      if (segs[i][0] < segs[i - 1][0] + segs[i - 1][1]) return false;
    }
    return true;
  };
  const breaksTotal = (sp) => (sp ? breaks.reduce((acc, [a, b]) => acc + brkLen(a, b), 0) : 0);

  const brkRows = () => (breaks.length
    ? breaks.map(([a, b], i) => `<div class="wk-brk-row">
        <input class="wk-tf" type="time" step="60" data-brk="${i}" data-k="s" value="${a}">
        <span class="wk-brk-dash">–</span>
        <input class="wk-tf" type="time" step="60" data-brk="${i}" data-k="e" value="${b}">
        <button type="button" class="wk-brk-x" data-brk-del="${i}" aria-label="删除这段休息">✕</button>
      </div>`).join("")
    : `<div class="wk-brk-empty">没有休息段</div>`);

  const paintBreaks = () => {
    const box = $("#st-breaks");
    if (!box) return;
    box.innerHTML = brkRows();
    $$("#st-breaks [data-brk]").forEach((inp) => {
      inp.oninput = () => {
        const i = Number(inp.dataset.brk);
        if (!breaks[i]) return;
        const v = String(inp.value || "").slice(0, 5);
        if (/^\d\d:\d\d$/.test(v)) breaks[i][inp.dataset.k === "s" ? 0 : 1] = v;
        paintSum();
      };
    });
    $$("#st-breaks [data-brk-del]").forEach((b) => {
      b.onclick = () => { breaks.splice(Number(b.dataset.brkDel), 1); paintBreaks(); paintSum(); };
    });
  };

  const suggestBreak = () => {
    const sp = spanInfo();
    if (!sp) return ["12:00", "13:00"];
    for (const [a, b] of [["12:00", "13:00"], ["12:30", "13:30"], ["18:00", "18:30"], ["23:00", "23:30"]]) {
      const off = brkOff(a, sp.s);
      if (off >= 30 && off + brkLen(a, b) <= sp.dur) return [a, b];
    }
    const off = Math.max(30, Math.min(sp.dur - 60, Math.round(sp.dur / 2 / 60) * 60));
    return [hmAt(sp.s, off), hmAt(sp.s, off + 60)];
  };

  const paintSum = () => {
    const hint = $("#st-end-hint");
    if (!hint) return;
    const sp = spanInfo();
    const durOk = sp && sp.dur >= 60 && sp.dur <= 1440;
    if (!durOk) {
      hint.className = "wk-sum bad";
      hint.innerHTML = kind === "long"
        ? `<b>时长填 1–24 小时，可带小数</b><span class="wk-sum-r">如 8.5</span>`
        : `<b>上下班时间不合理</b>`;
      return;
    }
    const fit = breaksFit(sp), total = fit ? breaksTotal(sp) : 0;
    const endM = wkHM2Min(sp.s) + sp.dur;
    const end = `${wkPad((Math.floor(endM / 60) % 24 + 24) % 24)}:${wkPad(((endM % 60) + 60) % 60)}`;
    hint.className = fit ? "wk-sum" : "wk-sum bad";
    const head = !fit ? `<b>休息段超出了班次</b>` : `<b>${total ? `工作 ${wkDurCN(sp.dur - total)}` : `时长 ${wkDurCN(sp.dur)}`}</b>`;
    hint.innerHTML = head + `<span class="wk-sum-r">${total ? `休 ${wkDurCN(total)} · ` : ""}下班 <i>${endM >= 1440 ? "次日 " : ""}${end}</i></span>`;
  };
  const breaksField = () => `<div class="field wk-brkf">
      <div class="field-head"><label>休息<i class="wk-opt">这段时间不排专注</i></label>
        <button type="button" class="wk-brk-add" id="st-brk-add">＋ 添加</button></div>
      <div id="st-breaks"></div>
    </div>`;
  const bindBreaks = () => {
    paintBreaks();
    const add = $("#st-brk-add");
    if (add) add.onclick = () => {
      const [a, b] = suggestBreak();
      breaks.push([a, b]); paintBreaks(); paintSum();
    };
  };
  const paintKind = () => {
    $$("#st-kind [data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
    if (kind === "off") {
      wrap.innerHTML = `<div class="wk-tip">「不值班」不算休息：轮到了但今天不用去。日历上显示简称，不推上班提醒、不计工时。</div>`;
    } else if (kind === "long") {
      wrap.innerHTML = `<div class="wk-when">
          <div class="field"><label>上班</label>${wkTimeField("st-start", t && t.start ? t.start : "08:00")}</div>
          <div class="field"><label>时长（小时）</label><input id="st-dur" type="number" min="1" max="24" step="0.5" inputmode="decimal" value="${wkDurH(dur * 60)}"></div>
        </div>
        <div class="wk-sum" id="st-end-hint"></div>
        <div class="chips wk-chips-line" id="st-dur-chips">
          ${[8, 12, 16, 24].map((h) => `<button type="button" class="chip${Math.abs(dur - h) < 0.01 ? " on" : ""}" data-dur="${h}">${h} 小时</button>`).join("")}
        </div>
        ${breaksField()}
        <div class="wk-tip wk-hintline">只填上班和时长，跨天自动算；休息时段不排专注。</div>`;
      $$("#st-dur-chips [data-dur]").forEach((b) => {
        b.onclick = () => {
          dur = Number(b.dataset.dur);
          $("#st-dur").value = dur;
          $$("#st-dur-chips .chip").forEach((x) => x.classList.toggle("on", x === b));
          paintSum();
        };
      });
      $("#st-dur").oninput = () => {
        dur = Number($("#st-dur").value) || 0;
        $$("#st-dur-chips .chip").forEach((x) => x.classList.toggle("on", Math.abs(Number(x.dataset.dur) - dur) < 0.01));
        paintSum();
      };
      const startInp = $("#st-start");
      if (startInp) startInp.oninput = paintSum;
      bindBreaks();
      paintSum();
    } else {
      wrap.innerHTML = `<div class="wk-when">
          <div class="field"><label>上班</label>${wkTimeField("st-start", t && t.start ? t.start : "08:00")}</div>
          <div class="field"><label>下班</label>${wkTimeField("st-end", t && t.end ? t.end : "20:00")}</div>
        </div>
        <div class="wk-sum" id="st-end-hint"></div>
        ${breaksField()}
        <div class="wk-tip wk-hintline">下班早于上班按跨天算；休息时段不排专注。</div>`;
      ["#st-start", "#st-end"].forEach((sel) => { const el = $(sel); if (el) el.oninput = paintSum; });
      bindBreaks();
      paintSum();
    }
  };
  $$("#st-kind [data-kind]").forEach((b) => { b.onclick = () => { kind = b.dataset.kind; paintKind(); }; });
  paintKind();

  let stOpen = false;
  const paintModes = () => {
    const modes = (wkFocusData().modes || []).slice().sort((a, b) =>
      String((a.steps[0] || {}).anchor || "") < String((b.steps[0] || {}).anchor || "") ? -1 : 1);
    const names = modes.filter((m) => bound.includes(Number(m.id))).map((m) => m.name);
    const row = `<button type="button" class="wk-kvr${stOpen ? " open" : ""}" data-strow>
        <span>专注</span><b class="${names.length ? "" : "dim"}">${names.length ? esc(names.join(" · ")) : "未绑定"}</b><i>›</i></button>`;
    if (!stOpen) { $("#st-modes").innerHTML = row; return; }
    const sel = modes.filter((m) => bound.includes(Number(m.id)))
      .map((m) => `<button type="button" class="pick-chip" data-mode="${m.id}">${esc(m.name)}<b>×</b></button>`).join("");
    const rows = modes.length ? modes.map((m) => {
      const on = bound.includes(Number(m.id));
      const n = (m.steps || []).length;
      const at = String((m.steps[0] || {}).anchor || "").slice(0, 5);
      return `<button type="button" class="pick-row${on ? " on" : ""}" data-mode="${m.id}">
        <span class="t">${esc(m.name)}</span><em>${n} 步${at ? ` · ${at} 起` : ""}</em><i>${on ? "✓" : ""}</i></button>`;
    }).join("") : '<div class="wk-tip">还没有专注模式</div>';
    $("#st-modes").innerHTML = row + `<div class="pick">
        <div class="pick-sel">${sel || '<em class="pick-empty">还没绑定，下面点一下加入</em>'}${bound.length ? '<button type="button" class="pick-clr" data-stclear>清空</button>' : ""}</div>
        <div class="pick-list">${rows}</div>
      </div>`;
  };
  $("#st-modes").onclick = (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) {
      const id = Number(m.dataset.mode);
      bound = bound.includes(id) ? bound.filter((x) => x !== id) : bound.concat([id]);
      paintModes(); return;
    }
    if (e.target.closest("[data-stclear]")) { bound = []; paintModes(); return; }
    if (e.target.closest("[data-strow]")) { stOpen = !stOpen; paintModes(); }
  };
  paintModes();

  $("#st-save").onclick = async () => {
    const name = ($("#st-name").value || "").trim();
    if (!name) return toast("名称不能为空");
    const body = { name, short: ($("#st-short").value || "").trim(), kind, modes: bound };
    if (kind === "long") {
      const hours = Number($("#st-dur").value);
      const mins = Math.round(hours * 60);
      if (!(mins >= 60 && mins <= 1440)) return toast("时长填 1–24 小时，可以带小数（如 8.5）");
      body.start = $("#st-start").value;
      body.dur_min = mins;
    } else if (kind === "shift") {
      body.start = $("#st-start").value;
      body.end = $("#st-end").value;
    }
    body.breaks = kind === "off" ? [] : breaks;
    const btn = $("#st-save"); btn.disabled = true; btn.textContent = "保存中…";
    try {
      if (t) await api(`work/shift/types/${t.id}`, { method: "PATCH", idempotent: true, body }, 20000);
      else await api("work/shift/types", { method: "POST", idempotent: true, body }, 20000);
      closeSubSheet();
      await loadWork(true); openShiftSettings(); wkSetPane("shift");
    } catch (e) {
      btn.disabled = false; btn.textContent = "保存";
      toast(e.message || "保存失败");
    }
  };
  const del = $("#st-del");
  if (del) del.onclick = async () => {
    if (del.dataset.arm !== "1") {
      del.dataset.arm = "1"; del.textContent = "确认删除？";
      setTimeout(() => { if (del.dataset.arm === "1") { del.dataset.arm = ""; del.textContent = "删除"; } }, 3000);
      return;
    }
    del.disabled = true; del.textContent = "删除中…";
    try {
      const r = await api(`work/shift/types/${t.id}`, { method: "DELETE" });
      closeSubSheet(); toast(r && r.used ? `已删除（${r.used} 套轮转里换成了休息）` : "已删除");
      await loadWork(true); openShiftSettings(); wkSetPane("shift");
    } catch (e) {
      del.disabled = false; del.dataset.arm = ""; del.textContent = "删除";
      toast(e.message || "删除失败");
    }
  };
}

/* ============================ v27：下一件实时倒计时 ============================ */
function wkParseAt(dayTime) { return wkParse(`${String(dayTime).slice(0, 10)} ${String(dayTime).slice(11, 16)}:00`); }

function wkUpcoming() {
  const items = [];
  ((state.work && state.work.tasks) || []).forEach((t) => {
    if (!t.done && t.due_at) {
      items.push({ kind: "task", at: wkParseAt(t.due_at), title: t.title, task: t,
        sub: `${String(t.due_at).slice(11, 16)} · ${wkTypeName(t.type_id)}`, pane: "sch",
        right: String(t.due_at).slice(11, 16) });
    }
  });
  const f = wkFocusData();
  const run = f.run && f.run.status === "running" ? f.run : null;
  const nowMs0 = wkNowMs();
  // 未开始/没在跑时，也把今天剩下要做的步骤排进「接下来」，和提醒表同源
  wkFocusSchedule(wkToday()).forEach((it) => {
    if (wkStepDone(wkToday(), it.modeId, it.idx)) return;            // 点过圆点的从「接下来」里消失
    if (it.ms < nowMs0 - 5 * 60000) return;                          // 已经过去的步骤不再列
    if (it.ms > nowMs0 + 24 * 3600000) return;
    if (run && Number(run.mode_id) === Number(it.modeId)) return;     // 正在跑的那个模式由下面接管
    items.push({ kind: "focus", at: it.ms, pane: "focus",
      title: it.step.title, sub: `专注 · ${it.modeName}`,
      ring: `${it.idx + 1}/${it.total}`,
      left: String(it.step.anchor || "").slice(0, 5), right: wkFmtMin(it.ms).slice(11, 16) });
  });
  if (run) {
    const info = focusStepInfo(run);
    const m = (f.modes || []).find((x) => Number(x.id) === Number(run.mode_id)) || { steps: run.snapshot || [] };
    const tl = wkFocusTimeline(m, run, wkToday());
    const total = (run.snapshot || []).length || tl.length;
    tl.forEach((t, i) => {
      if (info && i < info.idx) return;                               // 已经走完的步骤不再列
      if (!isFinite(t.startMs)) return;
      if (wkStepDone(wkToday(), run.mode_id, i)) return;
      const st = (run.snapshot && run.snapshot[i]) || (m.steps || [])[i] || {};
      const cur = !!(info && i === info.idx);
      const row = { kind: "focus", at: cur ? info.endMs : t.startMs, pane: "focus",
        title: st.title, sub: `专注 · ${run.mode_name || m.name}`,
        ring: `${i + 1}/${total}`, left: wkFmtMin(t.startMs).slice(11, 16),
        right: wkFmtMin(cur ? info.endMs : t.startMs).slice(11, 16) };
      if (cur) {
        const pct = Math.max(0, Math.min(100, focusPct(info, run)));
        row.prog = pct / 100;
        row.badge = `还剩 ${Math.round(100 - pct)}%`;
      }
      items.push(row);
    });
  }
  const nx = shiftNextStart();
  if (nx) items.push({ kind: "shift", at: wkParseAt(nx.at), title: `上班 · ${nx.type.name}`,
    sub: `${nx.at.slice(5, 10).replace("-", "/")} ${nx.type.start}`, pane: "shift" });
  return items.sort((a, b) => a.at - b.at);
}
/* 只算 60 分钟内要来的、以及刚到点 5 分钟内的 */
function wkNextNow() {
  const list = wkUpcoming();
  const now = wkNowMs();
  // 专注只要还在运行就钉住：已开始、还没到结束时间的一律不能被「到点 5 分钟」那条规则跳掉；
  // 即便已经超时也继续显示（文案改成「超时 N 分」），直到用户结束它。
  return list.find((x) => {
    if (x.kind === "focus") return true;
    const ahead = x.kind === "task" ? 4 * 3600000 : 12 * 3600000;
    return x.at - now <= ahead && now - x.at <= 30 * 60000;
  }) || null;
}
function wkCdText(ms) {
  const d = ms;
  if (d >= 0) {
    const m = Math.floor(d / 60000), s = Math.floor((d % 60000) / 1000);
    return d >= 3600000 ? `还有 ${Math.floor(m / 60)}:${wkPad(m % 60)}:${wkPad(s)}` : `还有 ${wkPad(m)}:${wkPad(s)}`;
  }
  const m = Math.floor(-d / 60000);
  return m < 1 ? "刚到点" : `已到点 ${m} 分钟`;
}
function wkRenderNext() {
  const strip = $("#wk-next");
  if (!strip) return;
  const it = wkNextNow();
  const sh = wkCtxShift();
  const key = `${it ? `${it.kind}|${it.title}|${it.sub || ""}` : "-"}|${sh ? `${sh.text}|${sh.sub}` : "-"}`;
  if (strip.dataset.key !== key) {
    strip.dataset.key = key;
    const top = it ? `<span class="wn-top"><span class="cd" data-cd></span>
        <span class="tx"><b>${esc(it.title)}</b><em>${esc(it.sub || "")}</em></span>
        <span class="wk-chev">›</span></span>` : "";
    const sub = sh ? `<span class="wn-sub">${esc(sh.text)}${sh.sub ? `<em>${esc(sh.sub)}</em>` : ""}</span>` : "";
    strip.innerHTML = top + sub;
    strip.className = `wk-next${it ? "" : " only-sub"}${it && sh ? " two" : ""}${(it || sh) ? "" : " hidden"}`;
    strip.dataset.pane = it ? it.pane : "shift";
  }
  const cd = strip.querySelector("[data-cd]");
  if (cd && it) cd.textContent = wkCdText(it.at - wkNowMs());

}

/* 点「下一件」：日程直接开它的编辑/详情，专注、值班跳到对应段 */
function wkOpenItem(it) {
  if (!it) return;
  if (it.kind === "task" && it.task) { openWorkTaskEditor(it.task); return; }
  wkSetPane(it.pane);
}
$("#wk-next")?.addEventListener("click", (e) => {
  if (e.target.closest(".wn-sub")) { wkSetPane("shift"); return; }
  const it = wkNextNow();
  if (it) wkOpenItem(it); else wkSetPane("shift");
});

/* 锁屏 Live Activity：只在原生壳里生效（window.Capacitor.Plugins.DndLive），浏览器里 no-op */
/* 页面内部时间都是「墙钟当 UTC」的假 epoch，交给原生前必须换成真实时间戳 */
function wkRealEpoch(fakeMs) {
  // 假 epoch 是「BJ 墙钟按 UTC 编码」，固定减 8 小时就是真实时间戳；
  // 原来按手机时区偏移换算，非 UTC+8 的机器会整体偏 8 小时。
  return Number(fakeMs) - 8 * 3600 * 1000;
}

function dndMktSnap() {
  if (state.view !== "hold" || state.holdTab !== "market") return null;  // 只在看行情时钉
  const d = state.mkt;
  const m = d && d.market;
  if (!m || !(m.state === "open" || m.state === "pre" || m.state === "lunch")) return null;
  const list = d.a || [];
  const main = list.find((x) => /上证/.test(String(x.name || ""))) || list[0];
  if (!main || !main.price) return null;
  const pct = Number(main.pct) || 0;
  return {
    sig: `market|${m.state}|${String(main.name || "")}`,
    title: `行情 · ${m.text || "实时"}`,
    subtitle: "",
    kind: "market",
    big: Number(main.price).toFixed(2),
    small: `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%${d.quotes_at ? " · " + d.quotes_at : ""}`,
    tone: pct > 0 ? 1 : pct < 0 ? -1 : 0,
    badge: String(main.name || "大盘").replace("指数", ""),
    progress: -1, ring: "", left: "", right: "",
  };
}

/* 锁屏 / 灵动岛 / 手表：只钉一件——此刻最该被看见的那件，不轮播。
   原来 15 秒轮一屏，但页面退到后台就停了，锁屏上留下的是熄屏那一刻恰好转到的任意一屏，
   所以「经常不是想要的那张」。现在按命中即停，取第一件：
     ① 正在进行的专注步骤
     ② 60 分钟内要到、或到点 15 分钟内的待办
     ③ 90 分钟内下班的值班（快到点了才值得钉，「距下班 8 小时」不再占屏）
     ④ 正在看的行情（只在页面可见时）
   都没有就撤卡，锁屏保持干净。 */
const DND_TASK_SOON_MS = 60 * 60000;
const DND_TASK_LATE_MS = 15 * 60000;
const DND_SHIFT_SOON_MS = 90 * 60000;
const DND_OVER_KEEP_MS = 30 * 60000;   // 到点后卡片最多再挂这么久，期间 App 没回来就由系统收走

/* 壳里注入的桥返回 void，不是 Promise：统一包一层，避免 xx.catch 报错 */
function dndCall(fn, arg) {
  try { const r = fn(arg); if (r && typeof r.then === "function") r.catch(() => {}); } catch (e) {}
}

/* 心率快照：取最近 10 分钟、最多 24 个采样点，给锁屏卡的曲线用。
   待机页的蓝牙采样（sbHrSample）是唯一真数据源；没有样本就返回空，卡片不画波形。 */
function dndHrSnap() {
  try {
    if (typeof sbState !== "function") return { bpm: 0, hr: [], hrAvg: 0, hrPeak: 0, hrZone: "", hrMins: 0 };
    const now = Date.now();
    const list = ((sbState() || {}).hr || []).filter((x) => now - x.t <= 10 * 60000);
    if (list.length < 3) return { bpm: 0, hr: [], hrAvg: 0, hrPeak: 0, hrZone: "", hrMins: 0 };
    const n = Math.min(24, list.length);
    const step = Math.max(1, Math.floor(list.length / n));
    const hr = [];
    for (let i = 0; i < list.length && hr.length < n; i += step) hr.push(Math.round(list[i].v));
    const bpm = Math.round(list[list.length - 1].v);
    const hrAvg = Math.round(list.reduce((a, x) => a + x.v, 0) / list.length);
    const hrPeak = Math.round(Math.max.apply(null, list.map((x) => x.v)));
    const hrZone = (typeof SB_HR_ZONES !== "undefined" && typeof sbHrZoneIdx === "function")
      ? (SB_HR_ZONES[sbHrZoneIdx(bpm)] || {}).name || "" : "";
    const hrMins = Math.max(1, Math.round((now - list[0].t) / 60000));
    return { bpm, hr, hrAvg, hrPeak, hrZone, hrMins };
  } catch (e) { return { bpm: 0, hr: [], hrAvg: 0, hrPeak: 0, hrZone: "", hrMins: 0 }; }
}

function dndBestSlide() {
  const now = wkNowMs();
  const today = wkToday();
  const f = wkFocusData();
  const run = f.run && f.run.status === "running" ? f.run : null;
  const info = run ? focusStepInfo(run) : null;
  if (info) {
    const pct = Math.max(0, Math.min(100, focusPct(info, run)));
    const over = info.endMs < now;
    return {
      sig: `focus|${run.id}|${info.idx}`,
      kind: "focus",
      title: info.step.title,
      subtitle: `专注 · ${run.mode_name}`,
      endAt: over ? 0 : wkRealEpoch(info.endMs),
      big: over ? `已超时 ${Math.floor((now - info.endMs) / 60000)} 分` : "",
      tone: over ? 2 : 0,
      progress: over ? 1 : pct / 100,
      ring: `${info.idx + 1}/${info.total}`,
      badge: over ? "该结束了" : `还剩 ${Math.round(100 - pct)}%`,
      left: String(info.step.anchor || "").slice(0, 5),
      right: wkFmtMin(info.endMs).slice(11, 16),
    };
  }
  const t1 = ((state.work && state.work.tasks) || [])
    .filter((t) => !t.done && t.due_at)
    .map((t) => ({ t, at: wkParseAt(t.due_at) }))
    .filter((x) => x.at > now - DND_TASK_LATE_MS)
    .sort((a, b) => a.at - b.at)[0];
  if (t1 && t1.at - now <= DND_TASK_SOON_MS) {
    const due = t1.t.due_at;
    const soon = t1.at > now;
    return {
      sig: `task|${t1.t.id}|${due}`,
      kind: "task",
      title: t1.t.title,
      subtitle: `${String(due).slice(11, 16)} · ${wkTypeName(t1.t.type_id)}`,
      // 已到点的给一个固定的收走时刻（到点 + 30 分钟），不会在锁屏上挂一整天
      endAt: wkRealEpoch(soon ? t1.at : t1.at + DND_OVER_KEEP_MS),
      big: soon ? "" : "该做了",
      tone: soon ? 0 : 2,
      progress: -1,
      ring: "",
      badge: soon ? String(due).slice(11, 16) : "已到点",
      left: soon ? wkNow().slice(11, 16) : String(due).slice(11, 16),
      right: String(due).slice(11, 16),
    };
  }
  const act = wkActiveShift(today);
  const type = act.type;
  const shDay = act.day || today;
  if (type && type.kind !== "off" && type.end) {
    const startMs = wkParseAt(`${shDay} ${type.start}:00`);
    const endMs = wkParseAt(`${shDay} ${type.end}:00`);
    const realEnd = type.cross_day ? endMs + 86400000 : endMs;
    if (realEnd > now && realEnd - now <= DND_SHIFT_SOON_MS) {
      return {
        sig: `shift|${shDay}|${type.id}`,
        kind: "shift",
        title: `下班 · ${type.name}`,
        subtitle: `${type.start} → ${type.end}`,
        endAt: wkRealEpoch(realEnd),
        big: "",
        tone: 0,
        progress: Math.max(0, Math.min(1, (now - startMs) / Math.max(1, realEnd - startMs))),
        ring: "",
        badge: "距下班",
        left: type.start,
        right: type.end,
      };
    }
  }
  const m = dndMktSnap();
  if (m) return {
    sig: m.sig, kind: "market", title: m.title, subtitle: "",
    endAt: 0, big: m.big, tone: m.tone, progress: -1, ring: "",
    badge: m.badge, left: "", right: "",
  };
  return null;
}

function dndLockSync() {
  const cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DndLive;
  if (!cap) return;
  const s = dndBestSlide();
  if (!s) {
    if (dndLockSync.on) { dndLockSync.on = false; dndLockSync.sig = ""; dndLockSync.kind = ""; dndCall(cap.end.bind(cap)); }
    return;
  }
  const hr = dndHrSnap();
  const sig = `${s.kind}|${s.sig}|${s.endAt}|${s.big}|${s.badge}|${Math.round(s.progress * 100)}`
    + `|${s.title}|${s.subtitle}|${hr.bpm}`;
  if (sig === dndLockSync.sig) return;
  const wasOn = dndLockSync.on;
  const kindChanged = wasOn && dndLockSync.kind !== s.kind;
  // 卡的「到点后自动收走」是开卡那一刻按 endAt 排的，之后只改内容不会重排；
  // 所以截止时刻往后挪了（专注换步、换成下一条待办）要重开一张，顺带把图标换成新类型
  const later = wasOn && s.endAt > (dndLockSync.endAt || 0);
  dndLockSync.sig = sig;
  dndLockSync.on = true;
  dndLockSync.kind = s.kind;
  dndLockSync.endAt = s.endAt;
  const push = { title: s.title, subtitle: s.subtitle, kind: s.kind, endAt: s.endAt || 0,
    big: s.big || "", small: "", tone: s.tone || 0, progress: s.progress,
    ringText: s.ring || "", badge: s.badge || "", leftText: s.left || "", rightText: s.right || "",
    line1: s.title, line2: s.subtitle || "",
    bpm: hr.bpm, hr: hr.hr, hrAvg: hr.hrAvg, hrPeak: hr.hrPeak, hrZone: hr.hrZone, hrMins: hr.hrMins };
  if (!wasOn || kindChanged || later || typeof cap.update !== "function") { dndCall(cap.start.bind(cap), push); return; }
  dndCall(cap.update.bind(cap), push);
}

/* 每秒一次：下一件 / 铃铛列表 / 专注 / 值班 */
function wkTickAll() {
  if (document.hidden) return;
  wkRenderNext();
  dndLockSync();
  // 每分钟把提醒清单重新同步给系统：专注换步、日程改动都能及时排上
  if (!wkTickAll.npAt || Date.now() - wkTickAll.npAt > 60000) { wkTickAll.npAt = Date.now(); wkPushNative(); }
  if (state.view === "work") { wkTickFocus(); wkTickShift(); }
  wkPushNowPlaying();
}

/* ============================ AI 助手（DeepSeek） ============================ */

function openAiCfg() {
  openSheet("AI · DeepSeek", `<div class="ai-cfg">
    <div class="ai-row">
      <label for="ai-key">Key</label>
      <input id="ai-key" autocomplete="off" spellcheck="false" placeholder="sk-…" value="">
      <a class="ai-mini" id="ai-gen" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">生成</a>
    </div>
    <div class="ai-row">
      <label>模型</label>
      <div class="chips chips-row" id="ai-model">
        <button type="button" class="chip" data-model="deepseek-chat">V3</button>
        <button type="button" class="chip" data-model="deepseek-reasoner">R1</button>
      </div>
      <span class="ai-note" id="ai-model-note"></span>
    </div>
    <div class="ai-stat">
      <div class="ai-balrow"><span>余额</span><b id="ai-bal">—</b>
        <button type="button" class="ai-mini" id="ai-bal-ref">刷新</button>
        <a class="ai-mini low" id="ai-rech" href="https://platform.deepseek.com/top_up" target="_blank" rel="noopener">充值</a></div>
      <div class="ai-prow"><span>单价<i id="ai-peak">空闲 · 半价</i></span>
        <span class="ai-nums"><b data-p="in">1</b>/<b data-p="hit">0.02</b>/<b data-p="out">4</b><em>元 · 百万 tokens</em></span></div>
    </div>
  </div>
    <div class="sheet-actions"><button class="btn primary" id="ai-key-save">保存</button></div>
  </div>`);
  let model = "deepseek-chat";
  const modelName = (m) => (m === "deepseek-reasoner" ? "R1" : "V3");
  // 模型差异只用三个字说清，不再铺一段解释
  const modelNote = (m) => (m === "deepseek-reasoner" ? "更聪明 · 慢 · 贵" : "快 · 便宜");
  const paintModel = () => {
    $$("#ai-model .chip").forEach((b) => b.classList.toggle("on", b.dataset.model === model));
    const note = $("#ai-model-note");
    if (note) note.textContent = modelNote(model);
  };
  paintModel();
  api("ai/config", { noRetry: true }, 10000).then((d) => {
    model = d.model === "deepseek-reasoner" ? "deepseek-reasoner" : "deepseek-chat";
    paintModel();
    applyPrice();
    const kb = $("#ai-key");
    if (kb) kb.placeholder = d.configured ? `留空 = 保持 ${d.hint}` : "sk-…";
  }).catch(() => {});
  $$("#ai-model [data-model]").forEach((b) => {
    b.onclick = () => { model = b.dataset.model; paintModel(); applyPrice(); };
  });
  const fillBal = () => {
    const el = $("#ai-bal");
    if (!el) return;
    el.textContent = "读取中…";
    api("ai/balance", { noRetry: true }, 20000).then((d) => {
      const b = (d && d.balance_infos || [])[0];
      if (b) {
        el.textContent = `${Number(b.total_balance).toFixed(2)} 元`;
        const rech = $("#ai-rech");
        if (rech) { rech.classList.toggle("low", Number(b.total_balance) < 1); rech.title = Number(b.total_balance) < 1 ? "余额不足" : "充值"; }
        
      } else {
        el.textContent = d && d.is_available === false ? "不可用" : "没读到";
      }
    }).catch((e) => {
      el.textContent = "查询失败";
    });
  };
  fillBal();
  const ref = $("#ai-bal-ref");
  if (ref) ref.onclick = fillBal;
  // 壳（v19+）里 target="_blank" 原生就支持；老壳里走 wkNative 的 open 指令也通，两边都兜一下
  const rech = $("#ai-rech");
  if (rech) rech.onclick = (e) => {
    const h = wkNativeHandler();
    if (h) { e.preventDefault(); try { h.postMessage({ cmd: "open", url: rech.href }); } catch (err) {} }
  };

  // 现在算高峰还是空闲：周末/法定假日整天算空闲
  const hmMin = Number(wkNow().slice(11, 13)) * 60 + Number(wkNow().slice(14, 16));
  const isWk = wkDayKind(wkToday()) === "work";
  const peak = isWk && ((hmMin >= 540 && hmMin < 720) || (hmMin >= 840 && hmMin < 1080));
  const tag = $("#ai-peak");
  if (tag) {
    tag.textContent = peak ? "高峰 · 全价" : "空闲 · 半价";
    tag.classList.toggle("peak", peak);
  }
  const applyPrice = () => {
    const r1 = model === "deepseek-reasoner";
    const prices = r1
      ? (peak ? { in: "4", hit: "1", out: "16" } : { in: "2", hit: "0.5", out: "8" })
      : (peak ? { in: "2", hit: "0.04", out: "8" } : { in: "1", hit: "0.02", out: "4" });
    $$("#sheet-content [data-p]").forEach((el) => { el.textContent = prices[el.dataset.p] || ""; });
  };
  applyPrice();

  $("#ai-key-save").onclick = async () => {
    const key = ($("#ai-key").value || "").trim();
    const mdl = model;
    const btn = $("#ai-key-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      const body = { model: mdl };
      if (key) body.key = key;              // 留空就只改模型，不碰已存的 Key
      const d = await api("ai/config", { method: "POST", idempotent: true, body }, 15000);
      toast(d.configured ? `已保存 ${d.hint} · ${modelName(d.model || mdl)}` : "还没配置 Key");
      closeSheet();
    } catch (e) {
      btn.disabled = false; btn.textContent = "保存";
      toast(e.message || "保存失败");
    }
  };
}


function openWorkAi(prefill, opts) {
  // 对话整段留着（只用来当上下文），屏幕上默认只显示最近两轮，更早的折叠起来
  // opts.filter：同一个面板的只读版——只用它筛「数据总览」看什么，不给它改库的入口
  const flt = !!(opts && opts.filter);
  let turns = [];
  let expanded = false;
  const SHOW = 4;                 // 最近两轮 = 4 条消息
  openSheet("", `<div class="ai-float">
    <button type="button" class="ai-fold" id="ai-fold" hidden></button>
    <div id="ai-out"></div>
    <div class="ai-bar">
      ${flt ? "" : `<button type="button" class="ai-his-b" id="ai-his">历史</button>`}
      <!-- 提示语单独画一层：iOS 对 textarea 的 placeholder 不认 text-align，会偏到左边 -->
      <span class="ai-ph" id="ai-ph">${flt ? "说一句想怎么看，回车就筛" : "说一句要安排的事，回车就改"}</span>
      <textarea id="ai-in" rows="1" enterkeyhint="send" placeholder="${flt ? "说一句想怎么看，回车就筛" : "说一句要安排的事，回车就改"}"></textarea>
      <button class="btn primary" id="ai-run" hidden>发送</button>
    </div>
  </div>`);
  $("#sheet").classList.add("ai-float-sheet");
  const inp = $("#ai-in"), foldBtn = $("#ai-fold");
  const grow = () => {
    inp.style.height = "auto";
    inp.style.height = Math.min(120, Math.max(40, inp.scrollHeight)) + "px";
  };
  const ph = $("#ai-ph");
  const paintPh = () => { if (ph) ph.classList.toggle("hidden", !!inp.value.trim()); };
  inp.addEventListener("input", () => { grow(); paintPh(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ai-run").click(); }
  });
  if (prefill) inp.value = String(prefill).slice(0, 600);
  paintPh();
  setTimeout(() => { try { inp.focus(); } catch (e) {} grow(); }, 260);

  // 只把「还用的上」的几句带上：太多轮反而让模型忘了当前这句
  const hist = () => turns.slice(0, turns.length - 1).filter((t) => t.content)
    .slice(-8).map((t) => ({ role: t.role, content: String(t.content).slice(0, 600) }));

  const paint = () => {
    const box = $("#ai-out");
    if (!box) return;
    const keep = expanded ? turns : turns.slice(-SHOW);
    const hidden = turns.length - keep.length;
    foldBtn.hidden = hidden <= 0;
    foldBtn.textContent = expanded ? "收起更早的对话" : `展开更早的 ${Math.ceil(hidden / 2)} 轮`;
    document.querySelector(".ai-float").classList.toggle("expanded", expanded);
    const rows = keep.map((t) => {
      if (t.role === "user") return `<div class="ai-msg me">${esc(t.content)}</div>`;
      const m = t.meta;
      if (m && m.scope && m.scope.length) {
        const label = m.undone ? "已回滚" : `已改 ${esc(m.scope.join(" / "))}${m.n ? ` · ${m.n} 项` : ""}`;
        return `<div class="ai-msg ai">${esc(t.content)}</div>
          <div class="ai-did"><span>${label}</span>
          ${m.snapshot && !m.undone ? `<button type="button" class="ai-undo-in" data-sk="${esc(m.snapshot)}">回滚</button>` : ""}</div>`;
      }
      return `<div class="ai-msg ai">${esc(t.content)}</div>`;
    }).join("");
    box.innerHTML = `<div id="ai-chat">${rows}</div>`;
    $$("[data-sk]", box).forEach((b) => (b.onclick = () => doUndo(b.dataset.sk)));
    try { box.scrollTop = box.scrollHeight; } catch (e) {}
  };

  // 回滚：AI 自己也能发 {"op":"undo"}，这里是手动那一份，两边落的是同一批快照
  const doUndo = async (id) => {
    try {
      const d = await api("ai/undo", { method: "POST", idempotent: true, body: id ? { id } : {} }, 30000);
      turns.forEach((t) => { if (t.meta && t.meta.snapshot) { t.meta.snapshot = null; t.meta.undone = true; } });
      turns.push({ role: "assistant", content: d.reply || "已回滚到改动之前。" });
      paint();
      toast("已回滚");
      await loadWork(true);
    } catch (e) {
      toast(e.message || "回滚失败");
    }
  };
  foldBtn.onclick = () => { expanded = !expanded; paint(); };
  if (flt) {
    turns.push({ role: "assistant", content: "只说想看什么，我就照着筛：比如「司法预审最近半年跑了多久」「最近上班上了多少小时」。" });
    paint();
  }
  const hisBtn = $("#ai-his");
  if (hisBtn) hisBtn.onclick = () => openAiHistory();

  $("#ai-run").onclick = async () => {
    const text = (inp.value || "").trim();
    if (!text) return toast(flt ? "先说想怎么看" : "先说一句要做什么");
    // 只读分支：翻成筛选参数就落回总览页，不改任何数据
    if (flt) {
      const btn0 = $("#ai-run");
      btn0.disabled = true; btn0.textContent = "筛选中…";
      turns.push({ role: "user", content: text });
      inp.value = ""; grow(); paintPh(); paintPh(); paint();
      try {
        const d = await api("work/ai-filter", { method: "POST", idempotent: true,
          body: { text, history: hist(), mode_id: Number(state.wkOvMode) || 0,
                  weeks: Number(state.wkOvRange) || 4, metric: state.wkOvMetric || "focus" } }, 60000);
        state.wkOvRange = Number(d.weeks) || 4;
        state.wkOvMetric = d.metric || "focus";
        state.wkOvMode = Number(d.mode_id) || 0;
        state.wkOvModeName = d.mode_id ? (d.mode_name || "") : "";
        turns.push({ role: "assistant", content: d.reply || "筛好了" });
        paint();
        wkOvRender();
        wkOvEnsure(true).then(() => wkOvRender());
      } catch (e) {
        turns.push({ role: "assistant", content: e.message || "AI 没响应" });
        paint();
      } finally {
        btn0.disabled = false; btn0.textContent = "发送";
      }
      return;
    }
    const btn = $("#ai-run");
    btn.disabled = true; btn.textContent = "改库中…";
    turns.push({ role: "user", content: text });
    inp.value = ""; grow();
    paint();
    try {
      const d = await api("ai/exec", { method: "POST", idempotent: true,
        body: { text, history: hist() } }, 60000);
      turns.push({ role: "assistant", content: d.reply || "（没有回复）",
        meta: { scope: d.scope || [], n: (d.applied || []).length, snapshot: d.snapshot || null } });
      inp.setAttribute("placeholder", d.snapshot ? "接着说下一件事，回车就改"
        : "接着回它一句，回车就发");
      paint();
      if (d.snapshot || (d.applied || []).length) await loadWork(true);
      try { inp.focus(); } catch (e) {}
    } catch (e) {
      turns.push({ role: "assistant", content: e.message || "AI 没响应" });
      paint();
    } finally {
      btn.disabled = false; btn.textContent = "发送";
    }
  };
}

/* ===================== 弹层列表的细滚动条 ===================== */
/* iOS 的 WKWebView 里原生滚动条是 overlay，滚动时又粗又明显、平时完全看不见。
   这里自绘一条：轨道透明、滑块很淡很细，滚动时出现，停手 1.3 秒淡出。 */
function wkScrollBar(el) {
  if (!el || el.__wksb) return;
  el.__wksb = 1;
  try { if (getComputedStyle(el).position === "static") el.style.position = "relative"; } catch (e) {}
  const bar = document.createElement("div");
  bar.className = "wk-sb";
  const th = document.createElement("i");
  bar.appendChild(th);
  el.appendChild(bar);
  let timer = null;
  const upd = () => {
    const sh = el.clientHeight, ch = el.scrollHeight;
    if (sh < 40 || ch - sh < 8) { bar.style.opacity = "0"; return; }
    const h = Math.max(30, Math.round((sh * sh) / ch));
    const top = Math.round((el.scrollTop / (ch - sh)) * (sh - h));
    th.style.height = h + "px";
    th.style.transform = `translateY(${top}px)`;
    bar.style.opacity = "1";
    clearTimeout(timer);
    timer = setTimeout(() => { bar.style.opacity = "0"; }, 1300);
  };
  el.addEventListener("scroll", upd, { passive: true });
  try { new ResizeObserver(upd).observe(el); } catch (e) {}
  upd();
}

/* openSheet 之后调一次：把弹层里所有能滚的列表都挂上 */
window.wkScrollBars = function () {
  const box = document.querySelector("#sheet");
  if (!box || box.classList.contains("hidden")) return;
  const els = [];
  box.querySelectorAll(".sheet-body, #ai-out, #ai-his-list, .ai-his").forEach((e) => els.push(e));
  els.forEach(wkScrollBar);
};

/* ===================== AI 历史 ===================== */
/* 每次改库都记在后端（data/ai_chats.json）：什么时候、说了什么、它回了什么、SQL、改了几行、有没有回滚。
   关掉面板就丢对话的日子到此为止——排查「它说删了没删」直接翻这里。 */
function openAiHistory() {
  openSheet("AI 历史", `<div class="ai-his" id="ai-his-list"><div class="ai-his-empty">读取中…</div></div>
    <div class="sheet-actions"><button class="btn" id="ai-his-clear">清空记录</button></div>`);
  const list = $("#ai-his-list");
  const render = (items) => {
    if (!items || !items.length) {
      list.innerHTML = `<div class="ai-his-empty">还没有记录。<br>用 AI 改过东西之后，每次都会留在这里。</div>`;
      return;
    }
    list.innerHTML = items.map((it) => {
      const bad = it.undone ? "已回滚" : (it.ok ? "" : "没改成");
      const tag = it.undone ? `<b class="ai-his-tag undo">已回滚</b>`
        : it.ok && it.rows ? `<b class="ai-his-tag ok">已改 ${it.rows} 行</b>`
        : it.ok ? `<b class="ai-his-tag">仅回复</b>` : `<b class="ai-his-tag bad">没改成</b>`;
      const when = String(it.at || "").slice(5, 16).replace("T", " ");
      return `<div class="ai-his-item${it.ok || it.undone ? "" : " failed"}" data-hid="${it.id}">
        <div class="ai-his-top"><span>${esc(when)}</span>${tag}</div>
        <div class="ai-his-say">${esc(it.text || "")}</div>
        <div class="ai-his-rep">${esc(it.reply || "")}</div>
        ${it.sql ? `<div class="ai-his-sql">${esc(String(it.sql).slice(0, 300))}</div>` : ""}
        <div class="ai-his-act">
          <button type="button" data-again="${it.id}">继续这条</button>
          ${it.snapshot && !it.undone ? `<button type="button" class="undo" data-hundo="${esc(it.snapshot)}">回滚</button>` : ""}
        </div>
      </div>`;
    }).join("");
    $$("[data-hundo]", list).forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        await api("ai/undo", { method: "POST", idempotent: true, body: { id: b.dataset.hundo } }, 30000);
        toast("已回滚");
        await loadWork(true);
        load();
      } catch (e) { b.disabled = false; toast(e.message || "回滚失败"); }
    }));
    $$("[data-again]", list).forEach((b) => (b.onclick = () => {
      const it = items.find((x) => String(x.id) === b.dataset.again);
      closeSheet();
      openWorkAi(it ? it.text : "");
    }));
  };
  const load = () => api("ai/history", { noRetry: true }, 15000)
    .then((d) => render(d.items || []))
    .catch((e) => { list.innerHTML = `<div class="ai-his-empty">读取失败：${esc(e.message || "")}</div>`; });
  load();
  const clr = $("#ai-his-clear");
  if (clr) clr.onclick = async () => {
    if (!clr.dataset.arm) { clr.dataset.arm = "1"; clr.textContent = "再点一次确认清空"; return; }
    try {
      await api("ai/history", { method: "DELETE", idempotent: true }, 15000);
      toast("已清空"); load();
    } catch (e) { toast(e.message || "清空失败"); }
    clr.dataset.arm = ""; clr.textContent = "清空记录";
  };
}

/* ===================== 左滑删除 ===================== */
/* 一条日程所属的重复规则（子条目 days 为空，要顺着 head 找规则行） */
function wkRuleDays(t) {
  if (!t) return [];
  const h = Number(t.head || 0);
  if (!h) return t.days || [];
  const r = ((state.work && state.work.tasks) || []).find((x) => Number(x.id) === h);
  return (r && r.days) || t.days || [];
}

/* 重复规则的短标签：每天 / 工作日 / 周末 / 周一、周三 */
function wkRepeatLabel(days) {
  const ds = (days || []).map(Number).filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
  if (!ds.length) return "";
  if (ds.length === 7) return "每天";
  if (ds.join("") === "12345") return "工作日";
  if (ds.join("") === "67") return "周末";
  return "周" + ds.map((n) => wkWeekName(n)).join("、");
}

/* 日程行 / 每日提醒 / 专注模式卡共用一套：指针左滑把内容推开一条，露出后面的删除块。
   竖向滑动一律放行给页面滚动（touch-action: pan-y），所以不会把列表滚不动。 */
const WK_SW_W = 56;

let WK_SW_OPEN = null;   // 当前展开的那一行（同时只允许一行展开）
let WK_SW_SWALLOW = false;  // 收起后吞掉紧随的那次 click，防止顺手打开别的行

function wkSwipeOnce() {
  if (wkSwipeOnce.done) return;
  wkSwipeOnce.done = true;
  // 手点别处 → 先收起；点到另一行时连那一下的 click 一起吞掉，免得打开编辑器
  document.addEventListener("pointerdown", (e) => {
    const cur = WK_SW_OPEN;
    if (!cur) return;
    if (cur.wrap.contains(e.target)) return;
    cur.shut();
    WK_SW_SWALLOW = !!(e.target.closest && e.target.closest(".wk-row, .wk-fmode, .wk-rem-row"));
  }, true);
  document.addEventListener("click", (e) => {
    if (!WK_SW_SWALLOW) return;
    WK_SW_SWALLOW = false;
    if (e.target.closest && e.target.closest(".wk-row, .wk-fmode, .wk-rem-row")) {
      e.stopPropagation(); e.preventDefault();
    }
  }, true);
  // 滚动时自动收起（跟 iOS 列表一致）
  document.addEventListener("scroll", () => { if (WK_SW_OPEN) WK_SW_OPEN.shut(); }, true);
}

function wkSwipeRows(root, sel, onDelete) {
  wkSwipeOnce();
  $$(sel, root).forEach((row) => {
    if (row.dataset.swipeReady) return;
    row.dataset.swipeReady = "1";
    const wrap = document.createElement("div");
    wrap.className = "wk-sw";
    row.parentNode.insertBefore(wrap, row);
    wrap.appendChild(row);
    row.classList.add("wk-sbody");
    // 分隔线搬到外层容器上：行左滑收窄时线不跟着缩、也不跟着移动
    const cs = getComputedStyle(row);
    if (parseFloat(cs.borderTopWidth) > 0) {
      wrap.style.borderTop = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
      row.style.borderTop = "0";
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "wk-sdel";
    del.textContent = "删除";
    wrap.appendChild(del);

    let x0 = 0, y0 = 0, base = 0, dragging = false, moved = false, open = false;
    // 用「收窄宽度」而不是整体平移：平移会把左边的字裁掉半截，
    // 收窄是 iOS 那种效果——内容右端让出 78px，字还在原位，只是右边被压住
    const setX = (v, anim) => {
      row.style.transition = anim ? "width .18s ease" : "none";
      const n = Math.min(WK_SW_W, Math.max(0, -Math.round(v)));
      row.style.width = n ? `calc(100% - ${n}px)` : "";
    };
    const self = {
      wrap,
      shut() { open = false; setX(0, true); if (WK_SW_OPEN === self) WK_SW_OPEN = null; },
    };

    row.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button > 0) return;
      x0 = e.clientX; y0 = e.clientY; base = open ? -WK_SW_W : 0;
      dragging = true; moved = false;
      row.style.transition = "none";
      if (!open && WK_SW_OPEN) WK_SW_OPEN.shut();     // 摸到别的行：先把已展开的收起
    });
    row.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (!moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (!moved && Math.abs(dy) >= Math.abs(dx)) { dragging = false; return; }  // 竖向 = 滚动
      moved = true;
      let v = base + dx;
      if (v > 0) v = 0;
      if (v < -WK_SW_W) v = -WK_SW_W + (v + WK_SW_W) / 4;   // 到底再加一点阻尼
      setX(v, false);
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      const m = row.style.width.match(/-\s*(\d+(?:\.\d+)?)px/);
      const cur = m ? Math.min(WK_SW_W, Math.max(0, Number(m[1]) || 0)) : 0;
      open = cur > WK_SW_W / 2;
      setX(open ? -WK_SW_W : 0, true);
      if (open) {
        if (WK_SW_OPEN && WK_SW_OPEN !== self) WK_SW_OPEN.shut();
        WK_SW_OPEN = self;
      } else if (WK_SW_OPEN === self) WK_SW_OPEN = null;
      if (moved) {
        // 滑完这一下别顺手打开编辑：拦住随后那次 click
        wrap.dataset.hold = "1";
        setTimeout(() => { delete wrap.dataset.hold; }, 400);
      }
    };
    row.addEventListener("pointerup", finish);
    row.addEventListener("pointercancel", finish);
    row.addEventListener("pointerleave", () => { if (dragging && !moved) dragging = false; });
    wrap.addEventListener("click", (e) => {
      if (e.target.closest(".wk-sdel")) return;          // 删除块自己的点击别被拦
      if (wrap.dataset.hold) { e.stopPropagation(); e.preventDefault(); }
      else if (open) { e.stopPropagation(); self.shut(); }
    }, true);
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      del.disabled = true;
      try { await onDelete(row); } finally { del.disabled = false; self.shut(); }
    });
  });
}

/* 锁屏媒体卡：把下一条的倒计时写进系统"正在播放"，每秒更新 */
function wkPushNowPlaying() {
  const h = wkNativeHandler();
  if (!h || !state.wkNowPlay) return;
  const it = wkNextNow();
  let text = "";
  if (it) {
    const total = 60 * 60000;
    const left = Math.max(0, Math.min(total, it.at - wkNowMs()));
    text = `${it.title}|${it.sub || ""}|${left}|${total}`;
  } else text = "idle";
  if (state.wkNpLast === text) return;
  state.wkNpLast = text;
  try { h.postMessage({ cmd: "nowplay", payload: text }); } catch (e) {}
}


/* ===================== 数据总览：班表入口行 + 全屏页 =====================
   为什么放「班表」段：班表是唯一在讲「我什么时候在岗」的地方，数据总览是它的长周期回声；
   安排段堆的是清单，专注段堆的是当前这一场，都不适合再塞一张总览。
   历史只有「专注 + 任务完成」两项要问后端（focus_runs 历史前端拿不到），
   值班工时前端用自己那套轮转表 + 手调覆盖本地算，两处不各写一套排班解析。 */
state.wkOvRange = Number(state.wkOvRange) || 4;
state.wkOvMetric = state.wkOvMetric || "focus";
state.wkOvAt = 0;

const WK_OV_METRICS = [
  ["focus", "专注时长"], ["task", "任务完成"], ["shift", "值班工时"], ["runs", "专注场次"],
];

function wkOvData() {
  // 选了某个专注模式时，页面用那一份（后端按 mode 算过）；没选就用全年全模式那份
  const mid = Number(state.wkOvMode) || 0;
  if (mid && state.wkOvMD) return state.wkOvMD;
  return state.wkOv || { days: {}, since: "" };
}
function wkOvDays(from, to) {
  const out = [];
  for (let d = from; d <= to; d = wkDayAdd(d, 1)) {
    out.push(d);
    if (out.length > 200) break;
  }
  return out;
}
function wkOvMins(v) {
  const m = Math.max(0, Math.round(Number(v) || 0));
  if (!m) return "0";
  return m >= 60 ? `${Math.floor(m / 60)}h${wkPad(m % 60)}` : `${m} 分`;
}
function wkOvSum(v) {
  const m = Math.max(0, Math.round(Number(v) || 0));
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}`;
}
function wkOvFmt(v, metric) {
  if (metric === "task") return `${Math.max(0, Math.round(v))} 件`;
  if (metric === "runs") return `${Math.max(0, Math.round(v))} 场`;
  return wkOvMins(v);
}
function wkOvSumFmt(v, metric) {
  if (metric === "task") return `${Math.max(0, Math.round(v))} 件`;
  if (metric === "runs") return `${Math.max(0, Math.round(v))} 场`;
  return wkOvSum(v);
}
/* 值班工时：这天在岗多少分钟（班次在岗时长 = 总时长 − 休息段）
   口径在后端算好（轮转 + 手调覆盖 + 跨日班归开始日），前端不再自己推一遍排班 */
function wkOvShiftMin(day, cache) {
  if (cache && cache.has(day)) return cache.get(day);
  const it = wkOvData().days[day] || null;
  let out = { v: 0, has: false };
  if (it) out = { v: Number(it.shift_min) || 0, has: Number(it.shift_min) > 0 };
  else {
    try {
      const si = shiftInfo(day);
      const t = si && si.type && si.type.kind !== "off" ? si.type : null;
      if (t) out = { v: Number(t.work_min || t.dur_min) || 0, has: true };
    } catch (e) { /* 排班没配好：这天当没有记录，不画 0 */ }
  }
  if (cache) cache.set(day, out);
  return out;
}
function wkOvValue(day, metric, cache) {
  if (metric === "shift") return wkOvShiftMin(day, cache);
  const it = wkOvData().days[day] || null;
  if (metric === "focus") return { v: it ? Number(it.focus_min) || 0 : 0, has: !!(it && it.focus_runs) };
  if (metric === "task") return { v: it ? Number(it.task_done) || 0 : 0, has: !!(it && it.task_all) };
  return { v: it ? Number(it.focus_runs) || 0 : 0, has: !!(it && it.focus_runs) };
}
/* 近 n 周：从 (n-1) 周前的周一到今天 */
function wkOvWin(n) {
  const today = wkToday();
  const thisMon = wkDayAdd(today, -(wkDowNo(today) - 1));
  return { from: wkDayAdd(thisMon, -(n - 1) * 7), to: today };
}
async function wkOvEnsure(force, midArg) {
  // 50 周一次取满：总览页分档、班表下的全年热力图共用；带 mode 时另存一份，不覆盖全模式那份
  const mid = midArg === undefined ? (Number(state.wkOvMode) || 0) : (Number(midArg) || 0);
  const data = mid ? state.wkOvMD : state.wkOv;
  const at = mid ? state.wkOvMDAt : state.wkOvAt;
  if (state.wkOvLoading) return data;
  if (!force && data && Date.now() - at < 120000) return data;
  const w = wkOvWin(53);
  state.wkOvLoading = true;
  try {
    const d = await api(`work/overview?start=${w.from}&end=${w.to}${mid ? `&mode=${mid}` : ""}`, { noRetry: true });
    if (d && d.days) {
      if (mid) { state.wkOvMD = d; state.wkOvMDAt = Date.now(); }
      else { state.wkOv = d; state.wkOvAt = Date.now(); }
    }
  } catch (e) { /* 读不到就按空表画，入口保持原样，不弹错 */ }
  state.wkOvLoading = false;
  return mid ? state.wkOvMD : state.wkOv;
}

/* ---- 班表段里的入口行：右边 14 根迷你柱 ---- */
function wkOvRenderEntry() {
  const box = $("#wk-ov-entry");
  if (!box) return;
  const d = state.wkOv || { days: {} };   // 入口永远是「全部模式」，不跟着总览页的筛选变
  const w = wkOvWin(4);
  const days = wkOvDays(w.from, w.to);
  let total = 0, hasDays = 0;
  days.forEach((day) => {
    const it = d.days[day];
    if (it && it.focus_runs) { total += Number(it.focus_min) || 0; hasDays += 1; }
  });
  const last14 = wkOvDays(wkDayAdd(wkToday(), -13), wkToday());
  const vals = last14.map((day) => {
    const it = d.days[day];
    return { day, v: it ? Number(it.focus_min) || 0 : 0, has: !!(it && it.focus_runs) };
  });
  const max = Math.max(1, ...vals.map((x) => x.v));
  const bars = vals.map((x) => `<i class="wk-ov-bar${x.has ? "" : " off"}${x.day === wkToday() ? " td" : ""}"
    style="height:${x.has ? Math.max(4, Math.round((x.v / max) * 16)) : 4}px"></i>`).join("");
  const sub = hasDays ? `近 4 周 · 专注 ${wkOvSum(total)}` : "近 4 周 · 还没有专注记录";
  box.innerHTML = `<div class="wk-ov-row"><span class="wk-ov-et"><b>数据总览</b><em>${esc(sub)}</em></span>
      <span class="wk-ov-bars" aria-hidden="true">${bars}</span>
      <span class="wk-chev">›</span></div>
    <div class="wk-yheat" id="wk-yheat" aria-hidden="true"></div>`;
  box.onclick = () => wkOvOpen();
  box.dataset.has = hasDays ? "1" : "0";
  wkYHeatRender();
}

/* 全年热力图（GitHub 那种）：53 列 = 每周一列，7 行 = 周一~周日，只有图形没有字 */
function wkYHeatRender() {
  const box = $("#wk-yheat");
  if (!box) return;
  const days = (state.wkOv && state.wkOv.days) || {};
  const today = wkToday();
  const from = wkDayAdd(wkDayAdd(today, -(wkDowNo(today) - 1)), -52 * 7);
  const vals = Object.keys(days).map((k) => Number(days[k].focus_min) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))] : 0;
  const lvOf = (v) => (!v || !p90 ? 0 : v <= p90 * 0.25 ? 1 : v <= p90 * 0.55 ? 2 : v <= p90 * 0.85 ? 3 : 4);
  let out = "";
  for (let c = 0; c < 53; c += 1) {
    for (let r = 0; r < 7; r += 1) {
      const day = wkDayAdd(from, c * 7 + r);
      const it = days[day];
      const cls = day > today ? "f" : (it ? `l${lvOf(Number(it.focus_min) || 0)}` : "l0");
      out += `<rect class="${cls}" x="${c * 7}" y="${r * 7}" width="6.2" height="6.2" rx="2"/>`;
    }
  }
  // 用固定 viewBox 画出 53×7 的格子，宽度交给 CSS 铺满，任何屏宽都等分且不会横向溢出
  box.innerHTML = `<svg viewBox="0 0 369 47" role="img" aria-label="这一年的专注热力图">${out}</svg>`;
}

/* ---- 打开 / 关闭全屏页 ---- */
function wkOvOpen() {
  const p = $("#wk-ov");
  if (!p) return;
  p.classList.remove("hidden");
  lockPageScroll(true, "wk-ov");
  const back = $("#wk-ov-back");
  if (back) back.onclick = () => wkOvClose();
  const aiBtn = $("#wk-ov-ai");
  if (aiBtn) aiBtn.onclick = () => wkOvAiOpen();
  wkOvRender();
  wkOvEnsure().then(() => wkOvRender());
}
function wkOvClose() {
  const p = $("#wk-ov");
  if (!p || p.classList.contains("hidden")) return;
  p.classList.add("hidden");
  lockPageScroll(false, "wk-ov");
}

/* 选模式：专注模式只影响「专注」相关的指标，选完自动把指标拨回时长 */
function wkOvModeSet(id, name) {
  const mid = Number(id) || 0;
  state.wkOvMode = mid;
  state.wkOvModeName = mid ? (name || state.wkOvModeName || "") : "";
  if (mid && !(state.wkOvMetric === "focus" || state.wkOvMetric === "runs")) state.wkOvMetric = "focus";
  wkOvRender();
  wkOvEnsure(true).then(() => wkOvRender());
}

/* 「全部模式」的筛选弹层：所有模式都在这儿，带场次/分钟，单选，不出现勾选编辑那套 */
function wkOvModeSheet() {
  const stats = (state.wkOv && state.wkOv.mode_stats) || [];
  const mid = Number(state.wkOvMode) || 0;
  const row = (id, name, sub) => `<button type="button" class="wk-ov-mrow${id === mid ? " on" : ""}" data-pick="${id}">
      <b>${esc(name)}</b><span>${esc(sub)}</span>${id === mid ? '<i class="wk-ov-mtick">✓</i>' : ""}</button>`;
  const body = stats.length
    ? `<div class="wk-ov-mlist">${row(0, "全部模式", "不挑模式，看全部")}`
      + stats.map((x) => row(Number(x.id), x.name,
          x.runs ? `${x.runs} 场 · ${x.min} 分钟 · ${x.days} 天` : "还没跑过")).join("") + "</div>"
    : `<div class="wk-ov-dempty">还没有专注模式</div>`;
  openSheet("筛选专注模式", body);
  $("#sheet-content").querySelectorAll("[data-pick]").forEach((b) => {
    b.onclick = () => {
      const id = Number(b.dataset.pick);
      const nm = id ? (b.querySelector("b").textContent || "") : "";
      closeSheet();
      wkOvModeSet(id, nm);
    };
  });
}

/* AI：「数据总览」页右上那颗星。只做筛选，后端只回筛选参数、不碰任何表 */
function wkOvAiOpen(prefill) {
  // 和工作页那颗星是同一个面板（openWorkAi + 只读模式），不另做一套
  openWorkAi(prefill, { filter: true });
}

function wkOvRender() {
  const p = $("#wk-ov");
  if (!p || p.classList.contains("hidden")) return;
  const metric = state.wkOvMetric;
  const n = Number(state.wkOvRange) || 4;
  const metricName = (WK_OV_METRICS.find((x) => x[0] === metric) || WK_OV_METRICS[0])[1];
  const rangeName = n === 13 ? "近 13 周" : n === 26 ? "近半年" : "近 4 周";
  const w = wkOvWin(n);
  const today = wkToday();
  const cache = new Map();

  const since = String(wkOvData().since || "");
  const rows = [];
  for (let i = 0; i < n; i++) {
    const start = wkDayAdd(w.from, i * 7);
    const cells = [];
    for (let j = 0; j < 7; j++) {
      const day = wkDayAdd(start, j);
      const val = day > today ? { v: 0, has: false } : wkOvValue(day, metric, cache);
      cells.push({ day, v: val.v, has: val.has, fut: day > today });
    }
    rows.push({ start, cells });
  }
  const flat = rows.filter((r) => r.cells[0].day <= today).flatMap((r) => r.cells).filter((c) => !c.fut);
  const vals = flat.filter((c) => c.has).map((c) => c.v).sort((a, b) => a - b);
  const p90 = vals.length ? Math.max(1, vals[Math.floor((vals.length - 1) * 0.9)] || 0) : 1;
  const lv = (c) => {
    if (!c.has) return 0;                       // 空心 = 那天没有记录
    if (!c.v) return 1;                         // 有记录但为 0：最浅一档
    if (c.v <= p90 * 0.25) return 1;
    if (c.v <= p90 * 0.55) return 2;
    if (c.v <= p90 * 0.85) return 3;
    return 4;
  };

  const dow = ["一", "二", "三", "四", "五", "六", "日"]
    .map((x) => `<span>${x}</span>`).join("");
  const grid = `<div class="wk-hrow wk-hdow"><span class="wk-hlab"></span>${dow}</div>`
    + rows.map((r) => `<div class="wk-hrow"><span class="wk-hlab">${Number(r.start.slice(5, 7))}/${Number(r.start.slice(8, 10))}</span>`
      + r.cells.map((c) => {
        // 没有记录 = 空心描边（只有细边、不填充），和「有记录但为 0」的最浅一档区分开；
        // 开始记录之前的日子也画空心，只是描边更淡一点，别让半年前看着像「全是你偷懒」
        const nod = !!since && !c.fut && c.day < since;
        const cls = nod ? `lv${lv(c)} old` : `lv${lv(c)}`;
        return `<i class="wk-hc ${cls}${c.fut ? " fut" : ""}${c.day === today ? " td" : ""}"
          data-day="${c.day}"></i>`;
      }).join("") + "</div>").join("");

  const total = flat.filter((c) => c.has).reduce((s, c) => s + c.v, 0);
  const hasDays = vals.length;
  const doneDays = vals.filter((v) => v > 0).length;
  const avg = hasDays ? Math.round(total / hasDays) : 0;
  const top = flat.filter((c) => c.has && c.v > 0).sort((a, b) => b.v - a.v)[0] || null;
  let third = "";
  if (metric === "focus" || metric === "runs") {
    let streak = 0;
    let d = today;
    while (true) {
      const val = wkOvValue(d, metric, cache);
      if (!(val.has && val.v > 0)) break;
      streak += 1;
      d = wkDayAdd(d, -1);
      if (streak > 400) break;
    }
    third = `连续 ${streak} 天`;
  } else if (metric === "task") third = `${doneDays} 天有完成`;
  else third = `出勤 ${doneDays} 天`;

  // 抬头只给「哪一档 · 哪个指标」，数字放下面那行合计里，省得同一句话读两遍
  // 抬头：范围 · (模式) · 指标，只在这里说一遍
  const mid = Number(state.wkOvMode) || 0;
  const modeName = mid ? (state.wkOvModeName
    || ((state.wkOv && state.wkOv.mode_stats) || []).find((x) => Number(x.id) === mid)?.name
    || "这个模式") : "";
  const tag = `${rangeName}${modeName ? ` · ${modeName}` : ""}`;
  const head = hasDays ? `${tag} · ${metricName}`
    : (since ? `${tag} · 还没有记录（专注记录从 ${Number(since.slice(5, 7))} 月 ${Number(since.slice(8, 10))} 日开始）`
             : `${tag} · 还没有记录`);
  const segs = hasDays ? [
    `${rangeName}合计 ${wkOvSumFmt(total, metric)}`,
    `日均 ${wkOvAvgFmt(avg, metric)}`,
    top && metric !== "runs" ? `最多的一天 ${Number(top.day.slice(5, 7))}/${Number(top.day.slice(8, 10))} ${wkOvFmt(top.v, metric)}` : "",
    `共 ${hasDays} 天有记录`, third,
  ].filter(Boolean) : [];
  // 每段各自不断行，分隔点挂在上一段尾巴上：换行只会发生在「·」后面，不会有一行拿「·」开头
  const statHtml = segs.map((x, k) => `<span>${esc(x)}${k < segs.length - 1 ? " ·" : ""}</span>`).join(" ");

  const s = $("#wk-ov-sum"); if (s) s.textContent = head;
  const rs = $("#wk-ov-range");
  if (rs) {
    rs.innerHTML = [[4, "近 4 周"], [13, "近 13 周"], [26, "近半年"]]
      .map(([v, t]) => `<button type="button" class="chip${v === n ? " on" : ""}" data-ovrange="${v}">${t}</button>`).join("");
    rs.querySelectorAll("[data-ovrange]").forEach((b) => {
      b.onclick = () => { state.wkOvRange = Number(b.dataset.ovrange); wkOvRender(); };
    });
  }
  // 专注模式：先在行里放「全部 + 最常用的 3 个」，再多就交给「全部模式」的筛选弹层，
  // 不把每个模式都摊到顶栏——模式一多顶栏会变成一面墙
  const mm = $("#wk-ov-modes");
  if (mm) {
    const stats = (state.wkOv && state.wkOv.mode_stats) || [];
    const used = stats.filter((x) => x.runs > 0);
    const top = used.slice(0, 2);   // 只放最常用的两个：行里再多一颗就得换行，换成「全部模式」兜住
    if (mid && !top.some((x) => Number(x.id) === mid)) {
      const self = stats.find((x) => Number(x.id) === mid);
      if (self) top.push(self);
    }
    mm.innerHTML = `<button type="button" class="chip${mid ? "" : " on"}" data-ovmode="0">全部</button>`
      + top.map((x) => `<button type="button" class="chip${mid === Number(x.id) ? " on" : ""}"
          data-ovmode="${Number(x.id)}">${esc(x.name)}</button>`).join("")
      + `<button type="button" class="chip wk-ov-more" id="wk-ov-more">全部模式<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.6 6.2 5 3 8.4"/></svg></button>`;
    mm.querySelectorAll("[data-ovmode]").forEach((b) => {
      b.onclick = () => wkOvModeSet(Number(b.dataset.ovmode));
    });
    const more = $("#wk-ov-more");
    if (more) more.onclick = () => wkOvModeSheet();
  }
  const ms = $("#wk-ov-metric");
  if (ms) {
    ms.innerHTML = WK_OV_METRICS.map(([k, t]) => `<button type="button" class="chip${k === metric ? " on" : ""}" data-ovmetric="${k}">${t}</button>`).join("");
    ms.querySelectorAll("[data-ovmetric]").forEach((b) => {
      b.onclick = () => {
        state.wkOvMetric = b.dataset.ovmetric;
        // 换成任务/值班这两项时，模式筛选没有意义，回到「全部」再画
        if (state.wkOvMetric === "shift" || state.wkOvMetric === "task") {
          if (Number(state.wkOvMode)) { state.wkOvMode = 0; state.wkOvModeName = ""; wkOvEnsure(true).then(() => wkOvRender()); }
        }
        wkOvRender();
      };
    });
  }
  const heat = $("#wk-ov-heat"); if (heat) heat.innerHTML = grid;
  const legend = $("#wk-ov-legend");
  if (legend) {
    legend.innerHTML = `<span>少</span><i class="wk-hc lv1"></i><i class="wk-hc lv2"></i>`
      + `<i class="wk-hc lv3"></i><i class="wk-hc lv4"></i><span>多</span>`
      + `<i class="wk-hc lv0 wk-lgsplit"></i><em>空心 = 那天没有记录</em>`;
  }
  const st = $("#wk-ov-stat"); if (st) st.innerHTML = statHtml;
  const hint = $("#wk-ov-hint");
  if (hint) {
    const sinceTxt = since && w.from < since
      ? `专注和任务记录从 ${Number(since.slice(5, 7))} 月 ${Number(since.slice(8, 10))} 日开始，之前的日子没有数据。`
      : "";
    hint.textContent = `${sinceTxt}点一天看当天明细 · 长按一天跳到那天的安排`;
  }

  wkOvSyncFilh();
  if (heat) {
    heat.querySelectorAll("[data-day]").forEach((c) => {
      const day = c.dataset.day;
      let timer = null;
      c.addEventListener("pointerdown", () => {
        timer = setTimeout(() => { timer = null; c.dataset.held = "1"; wkOvGoDay(day); }, 480);
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
        c.addEventListener(ev, () => { if (timer) { clearTimeout(timer); timer = null; } }));
      c.onclick = () => {
        if (c.dataset.held === "1") { c.dataset.held = ""; return; }
        wkOvDaySheet(day);
      };
    });
  }
}
/* 悬浮筛选条的真实高度交给 CSS 去算列表的顶部留白：模式多到换行也不会把格子压到条下面 */
function wkOvSyncFilh() {
  const f = $("#wk-ov-fil");
  const b = document.querySelector(".wk-ov-body");
  if (!f || !b) return;
  b.style.setProperty("--wk-filh", `${Math.ceil(f.getBoundingClientRect().height)}px`);
}
function wkOvAvgFmt(v, metric) {
  if (metric === "task") return `${Math.max(0, Math.round(v))} 件`;
  if (metric === "runs") return `${Math.max(0, Math.round(v))} 场`;
  const m = Math.max(0, Math.round(v));
  return m >= 60 ? `${Math.floor(m / 60)}h${wkPad(m % 60)}` : `${m} 分`;
}

/* 给某一天写批注：弹一层写，存进 notes(kind=mark, created_at=那天)，写完回到当天明细 */
function wkOvMarkAdd(day) {
  const title = `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日 · 批注`;
  openSheet(title, `<div class="wk-mk"><textarea id="wk-mk-text" rows="4" placeholder="这天要记的事、要复盘的判断…"></textarea>
    <div class="sheet-actions"><button class="btn primary" id="wk-mk-save">保存批注</button></div></div>`);
  $("#sheet").classList.add("above-gs");
  setTimeout(() => { try { $("#wk-mk-text").focus(); } catch (e) {} }, 240);
  $("#wk-mk-save").onclick = async () => {
    const text = ($("#wk-mk-text").value || "").trim();
    if (!text) return toast("先写点什么");
    const btn = $("#wk-mk-save");
    btn.disabled = true; btn.textContent = "保存中…";
    try {
      await api("notes", { method: "POST", idempotent: true,
        body: { content: text, kind: "mark", tags: ["批注"], day } }, 30000);
      toast("已存成这天的批注");
      closeSheet();
      setTimeout(() => wkOvDaySheet(day), 120);
    } catch (e) {
      btn.disabled = false; btn.textContent = "保存批注";
      toast(e.message || "存不上");
    }
  };
}

/* 「更多」里的批注入口：按天倒序列出全部批注，点一天就打开那天明细 */
async function openMarkList() {
  openSheet("批注", `<div class="wk-mk-list" id="wk-mk-list"><div class="wk-ov-dloading">读取中…</div></div>`);
  const box = $("#wk-mk-list");
  let d = null;
  try { d = await api("notes?kind=mark", { noRetry: true }, 20000); } catch (e) { d = null; }
  if (!box) return;
  const items = (d && d.items) || [];
  if (!items.length) {
    box.innerHTML = `<div class="wk-ov-dempty">还没有批注。数据总览点开某一天，就能给那天写一条。</div>`;
    return;
  }
  const groups = [];
  items.forEach((m) => {
    const day = String(m.created_at || "").slice(0, 10);
    const g = groups.find((x) => x.day === day);
    if (g) g.items.push(m); else groups.push({ day, items: [m] });
  });
  groups.sort((a, b) => (a.day < b.day ? 1 : -1));
  box.innerHTML = groups.map((g) => `<div class="wk-mk-g">
      <div class="wk-ov-dk">${Number(g.day.slice(5, 7))} 月 ${Number(g.day.slice(8, 10))} 日 · 周${wkWeekName(wkDowNo(g.day))}</div>
      <div class="wk-ov-dbox">${g.items.map((m) => `<div class="wk-ov-drow wk-mkrow" data-mkday="${g.day}">
        <b>${esc(String(m.content || "").slice(0, 160))}</b><em>${esc(String(m.created_at || "").slice(11, 16))}</em></div>`).join("")}</div>
    </div>`).join("");
  box.querySelectorAll("[data-mkday]").forEach((r) => {
    r.onclick = () => { const day = r.dataset.mkday; closeSheet(); setTimeout(() => wkOvDaySheet(day), 120); };
  });
}

/* 长按：跳到「安排」里的这一天 */
function wkOvGoDay(day) {
  wkOvClose();
  state.wkCal = day.slice(0, 7);
  wkSetPane("sch");
  wkPickDay(day);
  renderShift();
  try {
    const el = document.querySelector(`[data-showday="${day}"]`);
    if (el) { el.classList.add("sel"); el.scrollIntoView({ block: "center" }); }
  } catch (e) { /* 那天不在当前月历里就只切日期 */ }
}

/* 点一格：当天明细。专注 / 任务 / 班次 三行，不画图。 */
async function wkOvDaySheet(day) {
  const title = `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日 · 周${wkWeekName(wkDowNo(day))}`;
  openSheet(title, `<div class="wk-ov-d"><div class="wk-ov-dloading">正在读取…</div></div>`);
  try { $("#sheet").classList.add("above-gs"); } catch (e) {}
  let d = null;
  try { d = await api(`work/day?day=${day}`, { noRetry: true }); } catch (e) { d = null; }
  const box = $("#sheet-content");
  if (!box) return;
  if (!d) { box.innerHTML = `<div class="wk-ov-d"><div class="wk-ov-dloading">这一天读不出来</div></div>`; return; }

  const runs = (d.focus || []).map((r) => {
    const st = wkParse(r.started_at);
    const ended = !!r.ended_at;
    const en = ended ? wkParse(r.ended_at) : wkNowMs();
    let mins = Math.max(0, Math.round((en - st) / 60000));
    const plan = (r.snapshot || []).reduce((x, st2) => x + (Number(st2.minutes) || 0), 0);
    // 和热力图同一口径：没做完/放弃的场次封顶在计划时长，别把「开着不管」算成十几小时
    if (r.status !== "done" && plan) mins = Math.min(mins, plan);
    const steps = (r.snapshot || []).length;
    const done = r.status === "done" ? steps : Math.max(0, Number(r.step_idx) || 0);
    return { name: r.mode_name || "专注", st, en, mins, done, steps, status: r.status, ended };
  }).sort((a, b) => a.st - b.st);
  const tasks = (d.tasks || []).slice().sort((a, b) => (a.done === b.done ? String(a.due_at) < String(b.due_at) ? -1 : 1 : a.done ? 1 : -1));
  const doneN = tasks.filter((t) => t.done).length;
  const si = shiftInfo(day);
  const st2 = si && si.type ? si.type : null;

  const sec = (k, body) => `<div class="wk-ov-dk">${k}</div><div class="wk-ov-dbox">${body}</div>`;
  const focusBody = runs.length
    ? runs.map((r) => `<div class="wk-ov-drow"><b>${esc(r.name)}</b>
        <span>${wkHM(r.st)}–${r.ended ? wkHM(r.en) : "进行中"}</span><em>${r.mins} 分钟</em></div>`).join("")
    : `<div class="wk-ov-dempty">这一天没有专注记录</div>`;
  const taskBody = tasks.length
    ? tasks.map((t) => `<div class="wk-ov-drow wk-task${t.done ? " done" : ""}">
        <i class="wk-ov-dot${t.done ? " on" : ""}"></i><b>${esc(t.title)}</b>
        <em>${String(t.due_at).slice(11, 16)} · ${esc(wkTypeName(t.type_id))}</em></div>`).join("")
    : `<div class="wk-ov-dempty">这一天没有日程</div>`;
  const shiftBody = st2
    ? `<div class="wk-ov-drow"><b>${esc(st2.name)}</b>
        <span>${esc(st2.start)} → ${st2.cross_day ? "次日 " : ""}${esc(st2.end)}</span>
        <em>${st2.kind === "off" ? "不值班" : `在岗 ${wkOvMins(st2.work_min || st2.dur_min)}`}</em></div>`
    : `<div class="wk-ov-dempty">这一天没有班次</div>`;
  const focusMin2 = runs.reduce((x, r) => x + r.mins, 0);
  const focusTitle = runs.length ? `专注 · ${runs.length} 场 · ${focusMin2} 分钟` : "专注";
  const taskTitle = tasks.length ? `任务 · 完成 ${doneN} / ${tasks.length}` : "任务";
  // 批注：和「记录 · 批注」同一份数据（notes kind=mark），这儿写的就是那儿看到的
  const marks = d.marks || [];
  const markBody = marks.length
    ? marks.map((m) => `<div class="wk-ov-drow wk-mkrow"><b>${esc(String(m.content || "").slice(0, 120))}</b>
        <em>${esc(String(m.created_at || "").slice(11, 16) || "")}</em></div>`).join("")
    : `<div class="wk-ov-dempty">这一天还没有批注</div>`;
  box.innerHTML = `<div class="wk-ov-d">${sec(focusTitle, focusBody)}${sec(taskTitle, taskBody)}${sec("班次", shiftBody)}`
    + `${sec(marks.length ? `批注 · ${marks.length} 条` : "批注", markBody)}`
    + `<button type="button" class="wk-ov-mkadd" id="wk-ov-mkadd">写一条批注</button></div>`;
  const mk = $("#wk-ov-mkadd");
  if (mk) mk.onclick = () => wkOvMarkAdd(day);
}

/* ---------- 一处改动，全端同步 ----------
   以前每处保存各自刷自己那一屏，别的页面（待机、班表、总览）还拿着旧的一份，
   非要重启应用才对齐。现在任何 work 写操作成功都走同一个节流刷新，
   顺带把待机页那份也重拉一次。 */
let wkSyncTimer = null;
let wkSyncSeq = 0;

function wkSyncWork() {
  clearTimeout(wkSyncTimer);
  wkSyncTimer = setTimeout(() => {
    // 保存处自己刚拉过一次（400ms 内）就不再重复打后端
    if (state.workAt && Date.now() - state.workAt < 400) return;
    wkSyncSeq += 1;
    try { loadWork(true); } catch (e) {}
    try { if (typeof sbIsOn === "function" && sbIsOn() && typeof sbLoadWork === "function") sbLoadWork(); } catch (e) {}
    try { dndLockSync(); } catch (e) {}
  }, 240);
}

window.addEventListener("api:write", (e) => {
  const path = String((e && e.detail && e.detail.path) || "");
  if (!/^work/.test(path)) return;
  wkSyncWork();
});

/* 从后台切回来：静默补一次，别让用户面对一份几分钟前的数据 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (state.workAt && Date.now() - state.workAt < 3000) return;
  wkSyncWork();
});
