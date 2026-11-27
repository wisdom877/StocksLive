#!/usr/bin/env python3
"""页面全量走查：登录后把每个分区 / 分段 / 弹层都点一遍，收集
① 空节点查询（前端把 `querySelector` 没查到的情况记在 window.__nullQ 里）
② 页面 JS 异常与控制台 error  ③ 4xx/5xx 请求  ④ 横向溢出的元素
最后按「视图」逐项打印，有问题的才列出来。

用法（在项目根目录）：
    python3 tools/page_sweep.py                      # 走查 http://127.0.0.1:8102/
    python3 tools/page_sweep.py http://106.53.132.252/stocks/ --shots
密码读环境变量 SK_PW。--shots 时每个视图截一张图到 shots/。
改前端、清 CSS 之后部署前后各跑一次，对照结果。
"""
import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else os.environ.get("SK_BASE", "http://127.0.0.1:8099/")
SHOTS = "--shots" in sys.argv
OUT = Path(__file__).resolve().parent.parent / "web" / "static" / "shots"
PW = os.environ.get("SK_PW", "")
KEY = os.environ.get("SK_KEY", "")   # 免密：直接 ?k=<appkey> 换 cookie（验收不用问密码）

VIEWS = ["hold", "work", "news", "info", "note"]
STEPS = [  # (名字, 执行的 js, 等待毫秒)
    *[(f"setView({v})", f"setView('{v}')", 1500) for v in VIEWS],
    *[("hold-seg " + t, f"setView('hold'); document.querySelector('#hold-seg [data-tab={t}]')?.click()", 1500)
      for t in ("mine", "watch", "market")],
    *[("mkt-seg " + t, f"document.querySelector('#mkt-seg [data-mtab={t}]')?.click()", 1500)
      for t in ("quote", "hot", "analysis")],
    *[("xmkt " + t, f"document.querySelector('#xmkt-seg [data-mk={t}]')?.click()", 1200)
      for t in ("hk", "us", "global", "a")],
    *[("rank " + t, f"document.querySelector('#rank-seg [data-by={t}]')?.click()", 900)
      for t in ("amount", "turnover", "pct")],
    *[("hot-tab " + t, f"document.querySelector('#hot-seg [data-tab={t}]')?.click()", 900)
      for t in ("yesterday", "today")],
    *[("watch-seg " + t, f"document.querySelector('#watch-seg [data-tab={t}]')?.click()", 1200)
      for t in ("mine", "trend")],
    *[("wk pane " + t, f"setView('work'); wkSetPane('{t}')", 1200) for t in ("task", "focus", "shift")],
    ("openWkRemindSettings", "setView('work'); openWkRemindSettings()", 900),
    ("closeRS", "closeSubSheet(); closeSheet()", 500),
    ("newTask", "setView('work'); wkSetPane('task'); openWorkTaskEditor(null)", 900),
    ("closeTask", "closeSheet()", 400),
    ("openFocusEditor", "wkSetPane('focus'); openFocusEditor(state.work.focus.modes[0]?.id)", 900),
    ("closeFocusEdit", "closeSubSheet()", 400),
    ("openShiftSettings", "wkSetPane('shift'); openShiftSettings()", 900),
    ("stAdd", "document.querySelector('#st-add').click()", 800),
    ("stKindLong", "setTimeout(()=>document.querySelector('#st-kind-long')?.click(),100)", 900),
    ("closeSt", "closeSubSheet()", 400),
    ("srAdd", "openShiftSettings(); document.querySelector('#sr-add').click()", 900),
    ("srAddDay", "document.querySelector('#sr-pat-add')?.click()", 700),
    ("closeSr", "closeSubSheet(); closeSheet()", 400),
    ("openShiftDay", "wkSetPane('shift'); document.querySelectorAll('.wk-cal-c')[10]?.click()", 900),
    ("closeDay", "closeSubSheet()", 400),
    ("openMore", "document.querySelector('#btn-more').click()", 900),
    ("openErrLog", "document.querySelector('#more-errlog').click()", 900),
    ("closeMore", "closeSubSheet(); closeSheet()", 400),
    ("openSearch", "document.querySelector('[aria-label*=搜索]')?.click()", 1200),
    ("searchType", "const i=document.querySelector('#search-input'); i&&(i.value='茅台',i.dispatchEvent(new Event('input')))", 1500),
    ("closeSearch", "closeSheet()", 600),
]

OVERFLOW = """() => {
  const vw = document.documentElement.clientWidth, bad = [];
  // 标签条本来就是横向滚动的（用户明确允许这批横滑），祖先里有 overflow-x:auto/scroll
  // 的元素越界不算问题；真正要抓的是「把整页撑出横向滚动」。
  const scrollable = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  const pageScrolls = document.documentElement.scrollWidth > vw + 2;
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > vw + 2 || r.left < -2)) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.display === 'none' || scrollable(el)) continue;
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ').join('.')) +
               ` right=${Math.round(r.right)}/${vw}`);
      if (bad.length >= 5) break;
    }
  }
  if (pageScrolls) bad.unshift('整页横向滚动 sw=' + document.documentElement.scrollWidth);
  return bad;
}"""

SETTLE = """() => {
  document.querySelector('#splash')?.remove();
  if (window.state) { state.wkNative = true; state.wkAlarm = null; }
  document.querySelector('#wk-alarm')?.classList.add('hidden');
  document.body.classList.remove('wk-ringing');
  if (!window.__nullQ) window.__nullQ = [];
}"""


async def main() -> None:
    if not PW and not KEY:
        sys.exit("请先设置环境变量 SK_PW（登录密码）或 SK_KEY（appkey）")
    if SHOTS:
        OUT.mkdir(exist_ok=True)
    report: dict = {"nulls": {}, "errors": [], "bad": [], "overflow": {}}
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/local/bin/chromium",
                                    args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = await b.new_context(viewport={"width": 393, "height": 852}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True, locale="zh-CN", color_scheme="dark")
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: report["errors"].append(str(e)[:200]))
        pg.on("console", lambda m: report["errors"].append("console: " + m.text[:200]) if m.type == "error" else None)
        pg.on("response", lambda r: report["bad"].append(f"{r.status} {r.url[-70:]}") if r.status >= 400 else None)
        if KEY:
            await pg.goto(BASE + "?k=" + KEY, wait_until="domcontentloaded")
        else:
            r = await pg.request.post(BASE + "api/v1/login", headers={"Content-Type": "application/json"}, data=json.dumps({"password": PW}))
            if r.status != 200:
                sys.exit(f"登录失败 {r.status}")
            sk = r.headers["set-cookie"].split("sk=")[1].split(";")[0]
            host = BASE.split("//")[1].split(":")[0].split("/")[0]
            await ctx.add_cookies([{"name": "sk", "value": sk, "path": "/", "domain": host}])
            await pg.goto(BASE, wait_until="domcontentloaded")
        await pg.wait_for_timeout(6000)
        await pg.evaluate(SETTLE)

        for name, code, wait in STEPS:
            try:
                await pg.evaluate(code)
                await pg.wait_for_timeout(wait)
                hits = await pg.evaluate("window.__nullQ.splice(0)")
                if hits:
                    report["nulls"][name] = hits
                of = await pg.evaluate(OVERFLOW)
                if of:
                    report["overflow"][name] = of
                if SHOTS and (name.startswith("setView") or name.startswith("wk pane")):
                    await pg.screenshot(path=str(OUT / f"sweep-{name.replace('(', '-').replace(')', '').replace(' ', '_')}.png"))
            except Exception as e:  # 某一步点不到不应该中断整轮走查
                report["errors"].append(f"[{name}] {str(e)[:160]}")
        await b.close()
    report["errors"], report["bad"] = report["errors"][:40], report["bad"][:20]
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"空查询 {sum(len(v) for v in report['nulls'].values())} 处 / 异常 {len(report['errors'])} 条 / "
          f"坏请求 {len(report['bad'])} 个 / 溢出 {sum(len(v) for v in report['overflow'].values())} 处")


asyncio.run(main())
