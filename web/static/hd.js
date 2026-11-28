/* iPad HD 专用：待机舞台不再套 852×393 的手机画布，也不按某一台 iPad 写死尺寸。
   这里的唯一输入是当前窗口的可用宽高：
   - 舞台永远铺满窗口，背景（氛围图/渐变）自然盖住整块屏幕，不再出现上下或左右黑边；
   - --sb-u 只跟宽度线性缩放，页面内部的卡片/字号/间距按同一比例流式放大；
   - 页面用 flex 填满剩余高度，所以 4:3、3:2、16:10 以及分屏窄窗都走同一套规则。
   与 Apple HIG 的 Size Class 思路一致：面向“可用空间”，不面向具体机型/方向。
   iPhone 不加载这个文件。 */
(function () {
  if (!window.wkHD) return;

  function fitStage() {
    var box = document.getElementById("sb");
    if (!box) return;
    var stage = box.querySelector(".sb-stage");
    if (!stage) return;
    var vw = window.innerWidth || 1024;
    var vh = window.innerHeight || 768;
    var u = vw / 852;

    stage.style.left = "0px";
    stage.style.top = "0px";
    stage.style.width = vw + "px";
    stage.style.height = vh + "px";
    stage.style.transform = box.classList.contains("sb-flip") ? "rotate(180deg)" : "none";
    stage.style.transformOrigin = "50% 50%";
    box.style.setProperty("--sb-u", String(u));
    box.style.setProperty("--sb-vw", String(vw));
    box.style.setProperty("--sb-vh", String(vh));
  }

  var orig = window.sbLayout;
  if (typeof orig === "function") {
    window.sbLayout = function () {
      orig.apply(this, arguments);
      fitStage();
    };
  }
  fitStage();

  var t = 0;
  function later() {
    clearTimeout(t);
    t = setTimeout(fitStage, 120);
  }
  window.addEventListener("resize", later);
  window.addEventListener("orientationchange", later);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) later();
  });
})();
