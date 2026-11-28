/* ======== Liquid Glass 档位：读 / 写 / 应用，只此一份（GLASS:BEGIN） ========
   - 档位只改 html[data-glass]，样式全在 glass.css，别在这里写任何颜色。
   - 用户手选过的档位写 sbGlassLock=1，低帧率自动降档就不再覆盖他的选择。
   - 「更多 → 玻璃质感」的弹层内容由 GLASS.html() 生成，别处不要再拼一遍。 */
(function () {
  "use strict";
  var KEY = "sbGlass", LOCK = "sbGlassLock";
  var ORDER = ["clear", "standard", "deep", "solid"];
  var NAME = { clear: "通透", standard: "标准", deep: "厚实", solid: "实心" };
  var NOTE = {
    clear: "几乎只留一层雾，封面很亮时最干净。模糊最少，最省电。",
    standard: "默认。日常看着像一块磨砂玻璃，字和描边都清楚。",
    deep: "底更实、边更亮，夜里或花封面下压得住噪点。最费一点性能。",
    solid: "不跑实时模糊，纯色 + 顶面高光。车机掉帧时选它。"
  };

  function norm(k) { return ORDER.indexOf(k) >= 0 ? k : "standard"; }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式写不进，当次照常生效 */ } }

  function get() { return norm(read(KEY)); }
  function locked() { return read(LOCK) === "1"; }

  /* 把档位落到 <html> 上，并顺手更新「更多」里那行说明 */
  function paint(k) {
    k = norm(k);
    document.documentElement.setAttribute("data-glass", k);
    var sub = document.getElementById("more-glass-sub");
    if (sub) sub.textContent = NAME[k] + (locked() ? "" : " · 自动");
    return k;
  }

  function set(k, manual) {
    k = norm(k);
    if (manual !== false) write(LOCK, "1");
    write(KEY, k);
    paint(k);
    try { document.dispatchEvent(new CustomEvent("glasschange", { detail: { name: k } })); } catch (e) {}
    return k;
  }

  /* 弹层内容：四档单选，套用主站现成的 .seg 样式，不再新造一套控件 */
  function html() {
    var cur = get();
    var segs = ORDER.map(function (k) {
      return '<button type="button" data-glass-opt="' + k + '" class="' + (cur === k ? "on" : "") + '">' + NAME[k] + "</button>";
    }).join("");
    var n = NOTE[cur];
    return '<div class="seg" id="glass-seg">' + segs + "</div>" +
      '<p class="tiny muted" id="glass-note" style="margin:12px 2px 0;line-height:1.6">' + n + "</p>" +
      '<p class="tiny muted" style="margin:8px 2px 0;line-height:1.6">整站的胶囊、卡片、弹层头、标签栏都跟着这一个档位走；改完立刻生效，不用重启。</p>';
  }

  /* 绑定：点一下即切换，勾选与说明同步刷新 */
  function bind(root) {
    if (!root) root = document;
    var seg = root.getElementById ? root.getElementById("glass-seg") : null;
    if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll("[data-glass-opt]"), function (b) {
      b.onclick = function () {
        var k = set(b.dataset.glassOpt, true);
        Array.prototype.forEach.call(seg.querySelectorAll("[data-glass-opt]"), function (x) {
          x.classList.toggle("on", x === b);
        });
        var note = root.getElementById("glass-note");
        if (note) note.textContent = NOTE[k];
      };
    });
  }

  paint(get());

  /* 低帧率兜底：只在前 3 秒采样一次；用户手选过（locked）就不动他的选择 */
  function autoDowngrade() {
    if (locked() || get() === "solid") return;
    if (document.visibilityState !== "visible") return;
    var frames = 0, t0 = 0;
    function step(t) {
      if (!t0) t0 = t;
      frames++;
      if (t - t0 < 1400) { requestAnimationFrame(step); return; }
      var fps = frames / ((t - t0) / 1000);
      if (fps < 38) { write(KEY, "solid"); paint("solid"); }
    }
    requestAnimationFrame(step);
  }
  setTimeout(autoDowngrade, 1500);

  window.GLASS = {
    get: get, set: set, paint: paint, html: html, bind: bind,
    order: ORDER, name: NAME, note: NOTE
  };
})();
/* GLASS:END */
