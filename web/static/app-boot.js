/* 启动每秒心跳（页面不可见时自动跳过） */
if (!window.__wkTickStarted) {
  window.__wkTickStarted = true;
  setInterval(wkTickAll, 1000);
  setTimeout(() => { wkRenderNext(); }, 800);
  state.wkNowPlay = !!window.wkNowPlayReady;
}
