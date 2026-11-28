/* 启动每秒心跳（页面不可见时自动跳过） */
if (!window.__wkTickStarted) {
  window.__wkTickStarted = true;
  // 只有倒计时或工作台页需要 1 秒级刷新；其余时间 4 秒一次，别让 1Hz 定时器一直把进程叫醒
  const tickLoop = () => {
    try { wkTickAll(); } catch (e) {}
    const strip = document.getElementById("wk-next");
    const cd = !!(strip && strip.querySelector("[data-cd]"));
    const fast = (typeof state !== "undefined" && (state.view === "work" || state.wkRing || cd));
    setTimeout(tickLoop, fast ? 1000 : 4000);
  };
  setTimeout(tickLoop, 1000);
  setTimeout(() => { wkRenderNext(); }, 800);
  state.wkNowPlay = !!window.wkNowPlayReady;
}
