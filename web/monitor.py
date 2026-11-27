"""异动监控 v2：盘中盯着大盘与持仓/自选，按「幅度分级 + 组合影响」自动写记录。

落点：
- 大盘异动 → notes kind='analysis'（分析页），附对照指数与幅度分级
- 单只标的异动 → notes kind='note'（记录页），附这只对组合的影响金额
- 每条大盘异动 → notes kind='mark'（批注页）一句话系统批注

算法要点：
1. 阈值按当日振幅自适应：振幅越大（波动越剧烈）的标的，触发线越高，避免高波动品种天天刷屏；
2. 幅度分三档（异动 / 显著异动 / 剧烈异动），跨档升级时会立即改写当天那条记录，而不是再刷一条；
3. 同一标的同一天只留一条自动记录，内容随行情更新（最新幅度、时间、对照）；
4. 只在北京时间 A 股「交易中」工作；场外基金（盘中只有昨日净值）不参与；抓不到行情就不写。
"""
from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timedelta

import quotes
import store

log = logging.getLogger("monitor")

INTERVAL = 120          # 每 2 分钟看一轮
COOLDOWN = 900          # 同一标的 15 分钟内不重复改写，避免抖动刷屏
IDX_BASE = 1.5          # 指数基础阈值（%）
STK_BASE = 2.5          # 个股 / ETF 基础阈值（%）
LEVELS = [(2.5, "剧烈异动"), (1.6, "显著异动"), (1.0, "异动")]
# quotes.fetch 返回裸代码（sh000001 → 000001）
A_INDEX = ["000001", "399001", "399006", "000300"]
IDX_NAME = {"000001": "上证指数", "399001": "深证成指", "399006": "创业板指", "000300": "沪深300"}
_last: dict[str, float] = {}
_last_level: dict[str, int] = {}
_started = False
_lock = threading.Lock()


def _hm(d: dict, fallback: bool = True) -> str:
    """行情自带的时间（腾讯 time=20261123161427 → 11-23 16:14），拿不到才退回当前时间。

    盘前/盘后整理记录时，用行情时间才不会把昨天的收盘异动写成今天早上。
    """
    t = str(d.get("time") or "")
    if len(t) >= 12 and t.isdigit():
        return f"{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}"
    return f"{datetime.now(store.BJ):%m-%d %H:%M}" if fallback else ""


def _when(d: dict) -> str | None:
    """行情时间 → 记录时间（YYYY-MM-DD HH:MM），拿不到返回 None 用当前时间。"""
    t = str(d.get("time") or "")
    if len(t) >= 16 and t[4] == "-" and ":" in t:      # 2026-11-23 16:00:01
        return f"{t[:10]} {t[11:16]}"
    if len(t) >= 12 and t.isdigit():                   # 20261123161427
        return f"{t[0:4]}-{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}"
    if len(t) == 10 and t[4] == "-":
        return f"{t} 20:00"
    return None


def _amp_pct(d: dict) -> float | None:
    """当日振幅（%），用来判断这只标的平时波动大不大。"""
    try:
        hi, lo, prev = float(d.get("high") or 0), float(d.get("low") or 0), float(d.get("prev_close") or 0)
        if hi > 0 and lo > 0 and prev > 0:
            return (hi - lo) / prev * 100
    except Exception:
        return None
    return None


def _threshold(base: float, d: dict) -> float:
    """波动越大，触发线越高：阈值 = base × (1 + 振幅/12)，封顶 2.2 倍。"""
    amp = _amp_pct(d)
    if not amp or amp <= 0:
        return base
    k = min(2.2, 1 + amp / 12.0)
    return round(base * k, 2)


def _level(pct: float, thr: float) -> tuple[int, str]:
    for i, (mult, label) in enumerate(LEVELS):
        if abs(pct) >= thr * mult:
            return len(LEVELS) - i, label
    return 0, ""


def _cool(key: str, level: int) -> bool:
    """同档位 15 分钟内不重复；跨档升级立即放行。"""
    now = time.time()
    if level <= _last_level.get(key, 0) and now - _last.get(key, 0) < COOLDOWN:
        return False
    _last[key] = now
    _last_level[key] = max(level, _last_level.get(key, 0))
    return True


def _upsert(kind: str, code: str | None, text: str, tag: str, when: str | None = None,
            extra: str | None = None) -> None:
    """同一天同一标的只留一条自动记录，内容随行情更新。"""
    day = (when or store.today_bj())[:10]
    try:
        rows = store.list_notes(kind=kind, day=day, code=code or None, limit=30)
        for r in rows:
            if tag in (r.get("tags") or []):
                store.update_note(int(r["id"]), content=text)
                return
    except Exception:
        pass
    tags = [tag] + ([extra] if extra else [])
    store.add_note(text, tags, code, kind=kind, when=when)


def _short(n: str) -> str:
    """记录里用的短名：去掉括号定语和"指数/联接"，太长截断。"""
    n = str(n or "")
    for a, b in (("（", "）"), ("(", ")")):
        while a in n and b in n and n.index(b) > n.index(a):
            n = n[:n.index(a)] + n[n.index(b) + 1:]
    for junk, rep in (("纳斯达克生物科技", "生科"), ("纳斯达克", "纳指"), ("生物科技", "生科"),
                      ("标普500", "标普"), ("指数", ""), ("ETF联接", ""), ("联接", ""),
                      ("基金", ""), ("人民币", "")):
        n = n.replace(junk, rep)
    # 聚合一条里会有同名不同品牌的基金，品牌要留着消歧；份额类别（100A / A / C）去掉
    n = n.strip() or "持仓"
    import re as _re
    n = _re.sub(r"\d{0,3}[A-C]$", "", n).strip() or n
    return n if len(n) <= 10 else n[:9] + "…"


def _money(pct: float, mv: float) -> float:
    """由涨跌幅推这只标的当日变动金额（近似）。"""
    if not mv:
        return 0.0
    return mv - mv / (1 + pct / 100.0) if abs(pct) < 100 else 0.0


def check(force: bool = False) -> list[dict]:
    hits: list[dict] = []
    try:
        if not force:
            st = quotes.market_status() or {}
            state = st.get("state", "") if isinstance(st, dict) else (st[0] if st else "")
            if not quotes.is_trading_day() or state != "open":
                return hits

        idx = quotes.fetch(A_INDEX) or {}
        fired = []
        for code in A_INDEX:
            d = idx.get(code) or {}
            pct = d.get("pct")
            if pct is None:
                continue
            p = float(pct)
            thr = _threshold(IDX_BASE, d)
            level, label = _level(p, thr)
            if not level or not _cool(f"idx:{code}", level):
                continue
            fired.append({"code": code, "name": IDX_NAME.get(code) or d.get("name") or code,
                          "pct": p, "thr": thr, "level": level, "label": label,
                          "when": _when(d), "d": d})
        # 同一天几个指数一起异动只写一条：分成三四条会把记录页刷满
        if fired:
            hit_txt = "、".join(f"{x['name']} {x['pct']:+.2f}%" for x in fired)
            rest = [f"{IDX_NAME.get(c, (idx[c].get('name') or c)).replace('指数', '')} {float(idx[c]['pct']):+.2f}%"
                    for c in A_INDEX if c not in {x['code'] for x in fired}
                    and idx.get(c) and idx[c].get("pct") is not None]
            text = f"{hit_txt}（触发线 {min(x['thr'] for x in fired):.1f}%）"
            if rest:
                text += "｜对照 " + "、".join(rest)
            top = max(fired, key=lambda x: x["level"])
            _upsert("analysis", top["code"], text, "自动异动", top["when"])
            _upsert("mark", top["code"], f"{hit_txt}，已记入分析", "自动批注", top["when"])
            hits.extend({"scope": "index", "code": x["code"], "name": x["name"], "pct": x["pct"],
                         "level": x["label"]} for x in fired)

        rows = [r for r in store.list_stocks() if float(r.get("shares") or 0) > 0 or r.get("bucket") == "watch"]
        codes = [r["code"] for r in rows if r.get("code")]
        q = {}
        for i in range(0, len(codes), 60):
            q.update(quotes.fetch(codes[i:i + 60]) or {})
        for r in rows:
            code = r["code"]
            d = q.get(code) or {}
            pct = d.get("pct")
            if pct is None or d.get("source") == "fund_nav" or code in quotes.fund_codes():
                continue
            p = float(pct)
            thr = _threshold(STK_BASE, d)
            level, label = _level(p, thr)
            if not level or not _cool(f"stk:{code}", level):
                continue
            name = r.get("name") or d.get("name") or code
            sh = float(r.get("shares") or 0)
            px = float(d.get("price") or 0) or float(r.get("price") or 0)
            mv = sh * px
            held = sh > 0
            impact = _money(p, mv)
            tail = f"约影响组合 {impact:+,.0f} 元" if held and impact else "自选"
            text = f"{p:+.2f}%（触发线 {thr:.1f}%）｜{tail}"
            _upsert("note", code, text, "自动异动", _when(d))
            hits.append({"scope": "holding" if held else "watch", "code": code, "name": name, "pct": p,
                         "level": label, "impact": round(impact, 2)})
    except Exception:
        return hits
    return hits


def fund_moves(force: bool = False) -> list[dict]:
    """场外基金持仓只在净值更新后才动，所以单独在收盘后（20 点以后）跑一遍。

    阈值同样按当日波动放大：净值型没有振幅数据，用基础 3%。
    """
    hits: list[dict] = []
    try:
        now = datetime.now(store.BJ)
        if not force:
            st = quotes.market_status() or {}
            state = st.get("state", "") if isinstance(st, dict) else ""
            if state != "closed" or now.hour < 20:
                return hits
        rows = [r for r in store.list_stocks() if float(r.get("shares") or 0) > 0]
        codes = [r["code"] for r in rows if r.get("code")]
        q = quotes.fetch(codes) or {}
        for r in rows:
            d = q.get(r["code"]) or {}
            if d.get("source") != "fund_nav":
                continue
            pct = d.get("pct")
            if pct is None:
                continue
            p = float(pct)
            if abs(p) < 3.0:
                continue
            name = r.get("name") or d.get("name") or r["code"]
            sh = float(r.get("shares") or 0)
            px = float(d.get("price") or 0)
            impact = _money(p, sh * px)
            hits.append({"scope": "fund", "code": r["code"], "name": name, "pct": p,
                         "impact": round(impact, 2), "when": _when(d)})
        # 同一天多只净值异动不拆成好几条：并成一条组合级记录
        if len(hits) >= 2:
            total = sum(h["impact"] or 0 for h in hits)
            body = "、".join(f"{_short(h['name'])} {h['pct']:+.2f}%" for h in hits[:4])
            text = f"{len(hits)} 只净值异动：{body}｜合计 {total:+,.0f} 元"
            _upsert("note", None, text, "自动异动", hits[0].get("when"))
        elif hits:
            h = hits[0]
            text = f"{_short(h['name'])} 净值 {h['pct']:+.2f}%｜约影响组合 {h['impact']:+,.0f} 元"
            _upsert("note", h["code"], text, "自动异动", h.get("when"))
    except Exception:
        return hits
    return hits


def _loop() -> None:
    while True:
        try:
            check()
        except Exception as e:
            log.warning("盘中异动失败：%s", e)
        try:
            fund_moves()
        except Exception as e:
            log.warning("净值异动失败：%s", e)
        try:
            global_check()
        except Exception as e:
            log.warning("海外异动失败：%s", e)
        try:
            news_check()
        except Exception as e:
            log.warning("要闻记录失败：%s", e)
        time.sleep(INTERVAL)


# ---------------- 海外行情：隔夜/盘中同样要记 ----------------
GLOBAL_INTERVAL = 600            # 10 分钟看一次，避免反复打行情源
GLOBAL_IDX = ["usIXIC", "usDJI", "usINX", "hkHSI", "hkHSTECH"]
GIDX_NAME = {"IXIC": "纳指", "DJI": "道指", "INX": "标普500",
             "HSI": "恒指", "HSTECH": "恒生科技"}
# 关注度高的美股：个人持仓/自选之外的「市场温度计」，不追求全覆盖
GLOBAL_STOCKS = ["usNVDA", "usAAPL", "usTSLA", "usMSFT", "usGOOGL", "usAMZN",
                 "usMETA", "usAVGO", "usTSM", "usAMD", "usINTC", "usMU", "usPLTR", "usNFLX"]
G_IDX_BASE = 2.0
G_STK_BASE = 4.0
GLOBAL_TAG = "海外异动"
_last_global = 0.0


def _global_upsert(day: str, text: str, when: str) -> None:
    """同一天只留一条「海外异动」，多只标的一起写进去，不按只刷屏。"""
    try:
        rows = store.list_notes(kind="note", day=day, limit=50)
        for r in rows:
            if GLOBAL_TAG in (r.get("tags") or []):
                store.update_note(int(r["id"]), content=text)
                return
    except Exception:
        pass
    try:
        store.add_note(text, [GLOBAL_TAG], None, kind="note", when=when)
    except Exception as e:
        log.warning("海外异动记录失败：%s", e)


def global_check(force: bool = False) -> list[dict]:
    """港美股指数与关注度高的美股：指数 ±2%、个股 ±4%（按振幅自适应抬高）。"""
    global _last_global
    now = time.time()
    if not force and now - _last_global < GLOBAL_INTERVAL:
        return []
    _last_global = now
    hits: list[dict] = []
    # 指数和个股一次问完：连发两个请求时上游失败退避，第二拍会直接拿到空
    try:
        q = quotes.fetch(GLOBAL_IDX + GLOBAL_STOCKS) or {}
    except Exception as e:
        log.warning("海外行情失败：%s", e)
        return hits
    if not q:
        log.warning("海外行情为空（上游可能限流），本轮跳过")
    fired: list[tuple[str, float, float, int, dict]] = []
    for code in GLOBAL_IDX:
        bare = code[2:]
        d = q.get(bare) or {}
        pct = d.get("pct")
        if pct is None:
            continue
        p = float(pct)
        thr = _threshold(G_IDX_BASE, d)
        level, label = _level(p, thr)
        if not level:
            continue
        fired.append((bare, p, thr, level, d))
    sq = q
    stocks: list[tuple[str, str, float, float, int, dict]] = []
    for code in GLOBAL_STOCKS:
        bare = code[2:]
        d = sq.get(bare) or {}
        pct = d.get("pct")
        if pct is None:
            continue
        p = float(pct)
        thr = _threshold(G_STK_BASE, d)
        level, label = _level(p, thr)
        if not level:
            continue
        stocks.append((bare, d.get("name") or bare, p, thr, level, d))
    if not fired and not stocks:
        return hits
    when = ""
    for (_b, _p, _t, _l, d) in fired:
        if _when(d):
            when = _when(d)
            break
    for (_c, _n, _p, _t, _l, d) in stocks:
        if _when(d):
            when = when or _when(d)
            break
    day = (when or store.today_bj())[:10]
    idx_txt = "、".join(f"{GIDX_NAME.get(b, b)} {p:+.2f}%" for (b, p, _t, _l, _d) in fired)
    stk_txt = "、".join(f"{n} {p:+.2f}%" for (_c, n, p, _t, _l, _d) in stocks[:6])
    label = "隔夜美股" if any(b in ("IXIC", "DJI", "INX") for (b, *_rest) in fired) else "港美股"
    text = "｜".join(x for x in [f"{label}：{idx_txt}" if idx_txt else "",
                               f"个股 {stk_txt}" if stk_txt else ""] if x)
    if fired or stocks:
        _global_upsert(day, text, when or store.today_bj())
    hits.append({"scope": "global", "code": f"global:{day}", "name": text[:60],
                 "pct": max([p for (_b, p, *_x) in fired] + [p for (*_y, p, _t, _l, _d) in stocks] or [0])})
    return hits


# ---------------- 要闻：重大快讯第一时间落成记录 ----------------
NEWS_TAG = "自动要闻"
NEWS_WINDOW = 30                 # 只看最近 30 分钟，避免启动时把历史新闻全灌进来
NEWS_PER_DAY = 20                # 一天最多 20 条，暴跌暴涨日也不会刷屏
NEWS_HOT = re.compile(
    r"暴涨|暴跌|大涨|大跌|飙升|闪崩|熔断|涨停潮|跌停潮|创新高|创新低|"
    r"突发|宣布|停牌|冻结|制裁|出口管制|禁售|召回|爆雷|违约|破产|"
    r"财报|业绩|营收|指引|超预期|不及预期|上调|下调|裁员|罢工|辞职|去世|坠机|爆炸|地震"
)
NEWS_MUTE = re.compile(r"新闻联播|早间新闻精选|晚间新闻精选|投资日历|隔夜全球要闻|"
                       r"美股盘前要闻|美股收盘|你需要知道的|要闻一览|午间收评|机构策略")


def _news_prefix(text: str) -> str:
    """同一条快讯可能被多次转载，用标题前 14 字判重。"""
    body = re.sub(r"^【|】$", "", str(text or "")).strip()
    body = re.sub(r"\s+", "", body)
    return body[:14]


def _news_seen_today() -> set[str]:
    try:
        rows = store.list_notes(tag=NEWS_TAG, limit=200) or []
    except Exception:
        return set()
    return {_news_prefix(r.get("content") or "") for r in rows
            if str(r.get("created_at") or "").startswith(store.today_bj()[:10])}


def news_check(force: bool = False, window: int = NEWS_WINDOW) -> list[dict]:
    """A 级、财联社重点、或命中「暴涨暴跌/突发/财报」的 B 级，落一条记录。"""
    hits: list[dict] = []
    try:
        rows = store.list_live(limit=100) or []
    except Exception as e:
        log.warning("要闻读取失败：%s", e)
        return hits
    now_bj = datetime.now(quotes.BJ)
    cutoff = (now_bj - timedelta(minutes=window)).strftime("%Y-%m-%d %H:%M")
    # 服务重启 / 上游抖动期间可能漏掉几分钟，用游标续上（最多回溯 6 小时，防止一次灌满）
    try:
        last = str(store.get_meta("news_check_ts", "") or "")
        floor = (now_bj - timedelta(hours=6)).strftime("%Y-%m-%d %H:%M")
        if last and last > cutoff:
            cutoff = max(last, floor)
    except Exception:
        pass
    try:
        store.set_meta("news_check_ts", now_bj.strftime("%Y-%m-%d %H:%M"))
    except Exception:
        pass
    today = store.today_bj()[:10]
    seen = _news_seen_today()
    try:
        got = sum(1 for r in store.list_notes(tag=NEWS_TAG, day=today, limit=200))
    except Exception:
        got = 0
    for r in rows:
        if got >= NEWS_PER_DAY:
            break
        when = str(r.get("published_at") or "")
        if not when or when < cutoff:
            continue
        title = str(r.get("title") or "").strip()
        if len(title) < 12 or NEWS_MUTE.search(title):
            continue
        lvl = str(r.get("level") or "C").upper()
        hot = bool(NEWS_HOT.search(title))
        if not (lvl == "A" or int(r.get("alert") or 0) or (lvl == "B" and hot)):
            continue
        pfx = _news_prefix(title)
        if pfx in seen:
            continue
        tag2 = ""
        # 财联社 title 往往是整段电报，记录里只留标题句 + 一句，避免一行压倒整个记录页
        body = title if len(title) <= 150 else title[:148].rstrip("，。、 ") + "…"
        tags = [NEWS_TAG] + ([tag2] if tag2 else [])
        try:
            store.add_note(body, tags, r.get("stock_code") or None,
                           kind="note", when=when)
        except Exception as e:
            log.warning("要闻记录失败：%s", e)
            continue
        seen.add(pfx)
        got += 1
        hits.append({"scope": "news", "code": r.get("stock_code") or "", "name": title[:40], "pct": 0})
    return hits


def start() -> None:
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="auto-monitor", daemon=True).start()


if __name__ == "__main__":
    print(check(force=True))
    print(fund_moves(force=True))
