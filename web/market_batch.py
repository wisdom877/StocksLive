"""夜批：把当日能稳定拿到的行情固化进 market.db。

跑什么：
1. A 股 ETF 全场（417 只，来自趋势页 universe.json）→ snap，用于涨幅/成交额/换手排行；
2. A 股五大指数 + 全球/港美指数 → idx_snap 与 bars；
3. 持仓与自选标的的日线（给关键位/绩效兜底）；
4. 财报 / 除权日历（东财数据中心，能取到才写，取不到不编）。

用法：
  venv/bin/python market_batch.py --once          # 立即跑一次（收盘后）
  venv/bin/python market_batch.py --once --fast   # 跳过日线，只更新快照
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import marketdb
import quotes

BJ = ZoneInfo("Asia/Shanghai")
ROOT = Path(__file__).resolve().parent
UNIVERSE = ROOT / "data" / "trend_etf" / "universe.json"
A_INDEX = [("sh000001", "上证"), ("sz399001", "深证"), ("sz399006", "创业板"),
           ("sh000688", "科创50"), ("sh000300", "沪深300")]

# 港美没有「全市场名单」的稳定来源（东财 clist 在服务器侧常被断），
# 所以榜单用一份固定的头部名单：腾讯行情按代码直接取，名单里新增几只不用改代码。
HK_UNIVERSE = [
    ("00700", "腾讯控股"), ("09988", "阿里巴巴-W"), ("03690", "美团-W"), ("01810", "小米集团-W"),
    ("09618", "京东集团-SW"), ("01024", "快手-W"), ("09999", "网易-S"), ("09888", "百度集团-SW"),
    ("09961", "携程集团-S"), ("02318", "中国平安"), ("00939", "建设银行"), ("01398", "工商银行"),
    ("01299", "友邦保险"), ("00005", "汇丰控股"), ("00388", "香港交易所"), ("00941", "中国移动"),
    ("00883", "中国海洋石油"), ("01211", "比亚迪股份"), ("02020", "安踏体育"), ("02331", "李宁"),
]
US_UNIVERSE = [
    ("AAPL", "苹果"), ("MSFT", "微软"), ("NVDA", "英伟达"), ("GOOGL", "谷歌-A"), ("AMZN", "亚马逊"),
    ("META", "Meta"), ("TSLA", "特斯拉"), ("AVGO", "博通"), ("AMD", "超威半导体"), ("NFLX", "奈飞"),
    ("TSM", "台积电"), ("BABA", "阿里巴巴"), ("JPM", "摩根大通"), ("XOM", "埃克森美孚"),
    ("COST", "好市多"), ("V", "Visa"), ("MA", "万事达"), ("JNJ", "强生"), ("WMT", "沃尔玛"), ("DIS", "迪士尼"),
]
# 美股指数的日线要带交易所后缀（us.DJI / us.IXIC / us.INX），带后缀的报价接口反而取不到
HK_US_INDEX = [("hkHSI", "恒生指数", "hkHSI"), ("hkHSCEI", "国企指数", "hkHSCEI"),
               ("hkHSTECH", "恒生科技", "hkHSTECH"), ("usDJI", "道指", "us.DJI"),
               ("usIXIC", "纳指", "us.IXIC"), ("usINX", "标普500", "us.INX")]


def log(msg: str) -> None:
    print(f"[{datetime.now(BJ).strftime('%H:%M:%S')}] {msg}", flush=True)


def load_universe() -> list[dict]:
    try:
        d = json.loads(UNIVERSE.read_text(encoding="utf-8"))
        return d.get("items") or []
    except Exception as e:
        log(f"universe 读取失败：{e}")
        return []


def batch_a(rid: int, fast: bool) -> int:
    rows = load_universe()
    if not rows:
        return 0
    codes = [r["code"] for r in rows if r.get("code")]
    log(f"A 股 ETF 名单 {len(codes)} 只，取实时报价…")
    q = {}
    t0 = time.time()
    for i in range(0, len(codes), 60):
        try:
            q.update(quotes.fetch(codes[i:i + 60]))
        except Exception as e:
            log(f"报价批次 {i} 失败：{e}")
    log(f"报价 {len(q)} 只，用时 {time.time() - t0:.1f}s")

    snap = []
    for r in rows:
        code = str(r.get("code") or "")
        d = q.get(code) or {}
        price = d.get("price") or r.get("trade") or r.get("price")
        pct = d.get("pct") if d.get("pct") is not None else r.get("pct")
        amount = d.get("amount") or r.get("amount")
        # 腾讯的 amount 是万元，universe 里是元：统一成元，榜单按亿元展示
        if amount and amount < 1e7:
            amount = float(amount) * 10000
        snap.append({
            "code": code, "name": d.get("name") or r.get("name") or "",
            "price": price, "pct": pct, "amount": amount,
            "turnover": r.get("turnover"), "pe": r.get("pe"),
            "cap": r.get("total_cap") or r.get("float_cap"),
        })
    n = marketdb.save_snap("a", snap)
    log(f"A 股快照写入 {n} 行")

    if not fast:
        try:
            import kline
        except Exception as e:
            log(f"kline 不可用：{e}")
            return n
        for code, label in A_INDEX:
            try:
                items = (kline.fetch(code, "day", 250) or {}).get("items") or []
                marketdb.save_bars("a", code, items)
                log(f"  {label} 日线 {len(items)} 根")
            except Exception as e:
                log(f"  {label} 日线失败：{e}")
    return n


def _tencent(codes: list[str]) -> dict:
    """腾讯批量报价。hk/us 代码直接带前缀（hk00700 / usAAPL）。"""
    import requests
    out = {}
    for i in range(0, len(codes), 30):
        chunk = codes[i:i + 30]
        try:
            r = requests.get("https://qt.gtimg.cn/q=" + ",".join(chunk),
                             headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com"},
                             timeout=10)
            r.encoding = "gbk"
            for line in r.text.strip().split(";"):
                if "=" not in line or '"' not in line:
                    continue
                key = line.split("=")[0].strip().replace("v_", "")
                parts = line.split('"')[1].split("~")
                if len(parts) < 38:
                    continue
                def f(j):
                    try:
                        v = float(parts[j])
                        return v
                    except Exception:
                        return None
                out[key] = {"name": parts[1], "code": parts[2], "price": f(3),
                            "pct": f(32), "amount": f(37), "pe": f(39)}
        except Exception as e:
            log(f"腾讯报价失败（{chunk[0]}…）：{e}")
    return out


def batch_hk_us(fast: bool = False) -> None:
    """港股 / 美股头部名单 → snap（榜单用），并补指数与头部个股日线。"""
    for market, uni, prefix in (("hk", HK_UNIVERSE, "hk"), ("us", US_UNIVERSE, "us")):
        codes = [prefix + c for c, _ in uni]
        q = _tencent(codes)
        snap = []
        for c, nm in uni:
            d = q.get(prefix + c) or q.get(c) or {}
            snap.append({"code": c, "name": d.get("name") or nm, "price": d.get("price"),
                         "pct": d.get("pct"), "amount": d.get("amount"),
                         "turnover": None, "pe": d.get("pe"), "cap": None})
        n = marketdb.save_snap(market, [x for x in snap if x["price"]])
        log(f"{'港股' if market == 'hk' else '美股'}快照写入 {n} 行")
    if fast:
        return
    import requests
    q2 = _tencent(["us" + c for c, _ in US_UNIVERSE])
    for code, label, kc in HK_US_INDEX:
        try:
            r = requests.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                             params={"param": f"{kc},day,,,250,qfq"},
                             headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com"}, timeout=15)
            d = (r.json().get("data") or {}).get(kc) or {}
            rows = d.get("qfqday") or d.get("day") or []
            if len(rows) < 5:
                log(f"  {label} 日线只有 {len(rows)} 根，跳过")
                continue
            marketdb.save_bars("hk" if code.startswith("hk") else "us", code,
                               [{"t": x[0], "o": float(x[1]), "c": float(x[2]), "h": float(x[3]),
                                 "l": float(x[4]), "v": float(x[5])} for x in rows if len(x) >= 6])
            log(f"  {label} 日线 {len(rows)} 根")
        except Exception as e:
            log(f"  {label} 日线失败：{e}")
    # 美股日线的代码要带交易所后缀（AAPL.OQ / MSFT.OQ），从报价里取规范代码
    canon = {c: ((q2.get("us" + c) or {}).get("code") or c) for c, _ in US_UNIVERSE}
    for market, uni, prefix in (("hk", HK_UNIVERSE[:6], "hk"), ("us", US_UNIVERSE[:6], "us")):
        for c, nm in uni:
            try:
                kc2 = f"us{canon.get(c, c)}" if market == "us" else f"hk{c}"
                r = requests.get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                                 params={"param": f"{kc2},day,,,120,qfq"},
                                 headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com"}, timeout=15)
                d = (r.json().get("data") or {}).get(kc2) or {}
                rows = d.get("qfqday") or d.get("day") or []
                if len(rows) < 5:
                    log(f"  {market} {c} 日线 {len(rows)} 根，跳过")
                    continue
                marketdb.save_bars(market, c,
                                   [{"t": x[0], "o": float(x[1]), "c": float(x[2]), "h": float(x[3]),
                                     "l": float(x[4]), "v": float(x[5])} for x in rows if len(x) >= 6])
            except Exception as e:
                log(f"  {market} {c} 日线失败：{e}")
    log("港美指数/头部个股日线补齐")


def batch_index() -> None:
    try:
        import market
        a = market.indices_a()
        marketdb.save_idx_snap("a", a)
        log(f"A 股指数快照 {len(a)} 条")
    except Exception as e:
        log(f"A 股指数快照失败：{e}")
    try:
        import market
        g = market.global_indices()
        marketdb.save_idx_snap("global", g)
    except Exception as e:
        log(f"全球指数快照失败：{e}")
    try:
        import market
        m = market.global_markets()
        marketdb.save_idx_snap("hk", m.get("hk") or [])
        marketdb.save_idx_snap("us", m.get("us") or [])
        log(f"港美指数快照 {len(m.get('hk') or [])}+{len(m.get('us') or [])} 条")
    except Exception as e:
        log(f"港美指数快照失败：{e}")


def batch_hold_bars() -> None:
    try:
        import kline, store
    except Exception as e:
        log(f"依赖不可用：{e}")
        return
    rows = [r for r in store.list_stocks() if float(r.get("shares") or 0) > 0 or r.get("bucket") == "watch"]
    for r in rows[:20]:
        try:
            items = (kline.fetch(r["code"], "day", 250) or {}).get("items") or []
            marketdb.save_bars("cn", r["code"], items)
        except Exception as e:
            log(f"  {r['code']} 日线失败：{e}")
    log(f"持仓/自选日线补齐 {min(len(rows), 20)} 只")


def batch_calendar() -> None:
    """财报预约披露 + 除权除息。东财数据中心取不到就跳过，不写占位数据。"""
    import requests
    base = "https://datacenter-web.eastmoney.com/api/data/v1/get"
    hdr = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}
    events = []
    try:
        r = requests.get(base, params={
            "reportName": "RPT_PUBLIC_BS_APPOIN", "columns": "ALL", "pageNumber": 1, "pageSize": 200,
            "sortColumns": "APPOINT_PUBLISH_DATE", "sortTypes": 1,
            "filter": f"(FIRST_CHANGE_DATE>='{datetime.now(BJ).strftime('%Y-%m-%d')}')",
        }, headers=hdr, timeout=10)
        for it in ((r.json() or {}).get("result") or {}).get("data") or []:
            events.append({"code": str(it.get("SECURITY_CODE") or ""), "name": str(it.get("SECURITY_NAME_ABBR") or ""),
                           "kind": "report", "date": str(it.get("APPOINT_PUBLISH_DATE") or "")[:10],
                           "title": f"预约披露 {it.get('REPORT_YEAR') or ''} 年报表".replace("  ", " "),
                           "source": "eastmoney"})
    except Exception as e:
        log(f"财报日历跳过：{e}")
    try:
        r = requests.get(base, params={
            "reportName": "RPT_SHAREBONUS_DET", "columns": "ALL", "pageNumber": 1, "pageSize": 300,
            "sortColumns": "EX_DIVIDEND_DATE", "sortTypes": 1,
            "filter": f"(EX_DIVIDEND_DATE>='{datetime.now(BJ).strftime('%Y-%m-%d')}')",
        }, headers=hdr, timeout=10)
        for it in ((r.json() or {}).get("result") or {}).get("data") or []:
            bonus = it.get("PRETAX_BONUS_RMB")
            title = "除权除息"
            try:
                if bonus is not None and float(bonus) > 0:
                    title = f"除权除息 · 每股派息 {float(bonus):.3f} 元"
            except Exception:
                pass
            events.append({"code": str(it.get("SECURITY_CODE") or ""), "name": str(it.get("SECURITY_NAME_ABBR") or ""),
                           "kind": "dividend", "date": str(it.get("EX_DIVIDEND_DATE") or "")[:10],
                           "title": title, "source": "eastmoney"})
    except Exception as e:
        log(f"除权日历跳过：{e}")
    if events:
        n = marketdb.save_cal_events(events)
        log(f"日历事件写入 {n} 条")


def batch_auto_note() -> None:
    """收盘后自动生成当天的一条「分析」记录（在 app 里的 dashboard 逻辑里写，按日去重）。

    放在夜批里跑，是为了保证用户当天第一次打开页面之前记录就已经存在。
    """
    try:
        import app
        app.dashboard(_=None)
        log("今日复盘记录已生成（无重复则跳过）")
    except Exception as e:
        log(f"自动复盘记录跳过：{e}")


def run(fast: bool = False) -> None:
    marketdb.init()
    rid = marketdb.start_run("night")
    t0 = time.time()
    try:
        rows = batch_a(rid, fast)
        batch_index()
        batch_hk_us(fast)
        if not fast:
            batch_hold_bars()
        batch_calendar()
        batch_auto_note()
        marketdb.finish_run(rid, rows, "ok", f"{time.time() - t0:.0f}s fast={fast}")
        log(f"完成：{rows} 行，用时 {time.time() - t0:.1f}s")
    except Exception as e:
        marketdb.finish_run(rid, 0, "fail", str(e))
        log(f"失败：{e}")
        raise


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--fast", action="store_true")
    a = ap.parse_args()
    if a.once:
        run(a.fast)
    else:
        print(__doc__)
        sys.exit(0)
