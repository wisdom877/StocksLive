"""K 线：腾讯行情公开接口（日K前复权 / 5分钟 / 当日分时），东财兜底。

服务端短缓存：分时 10s、分钟 30s、日/周 60s、月 300s。
"""
from __future__ import annotations

import threading
import time
from datetime import datetime

import requests

import quotes

HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.qq.com/"}
DAY_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
M5_URL = "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
MIN_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query"

EM_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
EM_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
EM_KLT = {"min": "1", "m1": "1", "m5": "5", "m15": "15", "m30": "30", "m60": "60",
          "day": "101", "week": "102", "month": "103"}

PERIODS = {"min", "m1", "m5", "m15", "m30", "m60", "day", "week", "month"}
TTL = {"min": 10, "m1": 10, "m5": 30, "m15": 30, "m30": 30, "m60": 30,
       "day": 60, "week": 60, "month": 300}

_cache: dict[tuple[str, str, int], tuple[float, dict]] = {}
_cache_ttl: dict[tuple[str, str, int], float] = {}
_lock = threading.Lock()


def _tx_symbol(sym: str) -> str:
    """腾讯的港美日线要带交易所后缀（usNVDA.OQ / hk00700），只有 usNVDA 只能拿到两根。"""
    if not sym.startswith("us") or "." in sym:
        return sym
    try:
        q = quotes.fetch([sym[2:]]) or {}
        for v in q.values():
            c = str(v.get("code") or "")
            if "." in c:
                return "us" + c
    except Exception:
        pass
    return sym


def _tx_fetch(code: str, period: str, limit: int) -> dict:
    sym = _tx_symbol(quotes.secid(code))
    if period == "min":
        r = requests.get(MIN_URL, params={"code": sym}, headers=HEADERS, timeout=8)
        d = r.json()["data"][sym]
        raw = (d.get("data") or {}).get("data") or []
        prev = 0.0
        try:
            prev = float(d["qt"][sym][4])
        except Exception:
            pass
        items = []
        prev_cum = 0.0
        for line in raw:
            p = line.split()
            if len(p) < 3:
                continue
            hhmm, price, cum = p[0], float(p[1]), float(p[2])
            vol = max(cum - prev_cum, 0.0)
            prev_cum = cum
            items.append({"t": f"{hhmm[:2]}:{hhmm[2:]}", "c": price, "v": vol})
        return {"code": code, "period": "min", "items": items, "prev_close": prev,
                "date": (d.get("data") or {}).get("date", ""), "source": "tx"}

    if period in ("m1", "m5", "m15", "m30", "m60"):
        r = requests.get(M5_URL, params={"param": f"{sym},{period},,{limit}"}, headers=HEADERS, timeout=8)
        d = r.json()["data"][sym]
        rows = d.get(period) or []
        items = [
            {"t": f"{x[0][4:6]}-{x[0][6:8]} {x[0][8:10]}:{x[0][10:12]}",
             "o": float(x[1]), "c": float(x[2]), "h": float(x[3]), "l": float(x[4]), "v": float(x[5])}
            for x in rows
        ]
        return {"code": code, "period": period, "items": items, "prev_close": 0, "source": "tx"}

    r = requests.get(DAY_URL, params={"param": f"{sym},{period},,,{limit},qfq"}, headers=HEADERS, timeout=8)
    d = r.json()["data"][sym]
    # 前复权优先；腾讯对美股的前复权常常只回两三根，反而「不复权」那组是全的
    qfq = d.get("qfq" + period) or []
    raw = d.get(period) or []
    rows = qfq if len(qfq) >= len(raw) else raw
    items = [
        {"t": x[0], "o": float(x[1]), "c": float(x[2]), "h": float(x[3]), "l": float(x[4]), "v": float(x[5])}
        for x in rows
    ]
    name = ""
    try:
        name = d["qt"][sym][1]
    except Exception:
        pass
    return {"code": code, "period": period, "name": name, "items": items,
            "prev_close": 0, "source": "tx"}


def _em_fetch(code: str, period: str, limit: int) -> dict:
    """东财兜底；分时用 1 分钟 K 线近似，日/周/月用前复权 K 线。"""
    sym = quotes.secid(code)
    if not sym.startswith(("sh", "sz", "bj")):
        return {"code": code, "period": period, "name": "", "items": [],
                "prev_close": 0, "source": "none"}
    secid = ("1." if sym.startswith("sh") else "0.") + sym[2:]
    r = requests.get(EM_URL, params={
        "secid": secid, "klt": EM_KLT[period], "fqt": "1", "lmt": str(limit),
        "end": "20500101", "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }, headers=EM_HEADERS, timeout=8)
    data = r.json().get("data") or {}
    rows = data.get("klines") or []
    name = data.get("name") or ""
    prev = float(data.get("preKPrice") or 0)
    if not rows:
        return {"code": code, "period": period, "name": name, "items": [],
                "prev_close": prev, "source": "eastmoney"}

    if period == "min":
        parsed = []
        for line in rows:
            f = line.split(",")
            if len(f) < 6:
                continue
            try:
                parsed.append((f[0], float(f[2]), float(f[5])))  # datetime, close, volume(手)
            except ValueError:
                continue
        if not parsed:
            return {"code": code, "period": "min", "items": [], "prev_close": prev,
                    "date": "", "name": name, "source": "eastmoney"}
        day = parsed[-1][0][:10]
        items = [{"t": t[11:16], "c": c, "v": v} for t, c, v in parsed if t[:10] == day]
        return {"code": code, "period": "min", "items": items, "prev_close": prev,
                "date": day, "name": name, "source": "eastmoney"}

    items = []
    minute = period in ("m1", "m5", "m15", "m30", "m60")
    for line in rows:
        f = line.split(",")
        if len(f) < 6:
            continue
        try:
            t = f[0][5:] if minute else f[0]
            items.append({"t": t, "o": float(f[1]), "c": float(f[2]),
                          "h": float(f[3]), "l": float(f[4]), "v": float(f[5])})
        except ValueError:
            continue
    return {"code": code, "period": period, "name": name, "items": items,
            "prev_close": (prev if period == "min" else 0), "source": "eastmoney"}


TTL_FUND = 1800      # 场外基金一天一个净值，长缓存


def _fund_fetch(code: str, period: str, limit: int) -> dict | None:
    """场外基金没有盘中 K 线：用天天的单位净值历史当「日净值」，周/月按区间聚合。"""
    prof = quotes.fund_profile(code)
    if not prof.get("ok"):
        return None
    hist = prof.get("history") or []
    if len(hist) < 2:
        return None
    days = []
    prev = 0.0
    for h in hist:
        try:
            nav = float(h["nav"])
        except (TypeError, ValueError):
            continue
        o = prev or nav
        days.append({"t": h["date"], "o": round(o, 4), "c": round(nav, 4),
                     "h": round(max(o, nav), 4), "l": round(min(o, nav), 4), "v": 0})
        prev = nav
    if not days:
        return None
    # 档案里的最新净值（f10 逐日净值）常比 pingzhongdata 的曲线点位新一天：
    # 不补这一根，页头会写「+6.80%」而曲线末尾还停在上一交易日的「-5.57%」
    nd = str(prof.get("nav_date") or "")[:10]
    try:
        nav_now = float(prof.get("nav") or 0)
    except (TypeError, ValueError):
        nav_now = 0.0
    if nd and nav_now > 0 and nd > days[-1]["t"]:
        prev_nav = days[-1]["c"]
        days.append({"t": nd, "o": round(prev_nav, 4), "c": round(nav_now, 4),
                     "h": round(max(prev_nav, nav_now), 4), "l": round(min(prev_nav, nav_now), 4), "v": 0})

    items = days
    if period in ("week", "month"):
        grouped: dict[str, list[dict]] = {}
        order: list[str] = []
        for x in days:
            t = x["t"]
            if period == "month":
                key = t[:7]
            else:
                try:
                    y, w, _ = datetime.strptime(t, "%Y-%m-%d").isocalendar()
                except ValueError:
                    continue
                key = "%04d-W%02d" % (y, w)
            if key not in grouped:
                grouped[key] = []
                order.append(key)
            grouped[key].append(x)
        items = []
        prev_c = 0.0
        for key in order:
            g = grouped[key]
            o = prev_c or g[0]["o"]
            c = g[-1]["c"]
            items.append({"t": g[-1]["t"], "o": o, "c": c,
                         "h": max(o, c, max(x["h"] for x in g)),
                         "l": min(o, c, min(x["l"] for x in g)), "v": 0})
            prev_c = c

    return {"code": code, "period": period, "name": prof.get("name") or code,
            "items": items[-limit:], "prev_close": 0, "source": "fund_nav",
            "unit": "净值", "nav_date": prof.get("nav_date") or ""}


def _aggregate(items: list[dict], period: str) -> list[dict]:
    """日线聚合周/月：腾讯对港股/美股的周月线只给当前一段，回退时自己算。"""
    grouped: dict[str, list[dict]] = {}
    order: list[str] = []
    for x in items:
        t = str(x.get("t") or "")[:10]
        if not t:
            continue
        try:
            if period == "month":
                key = t[:7]
            else:
                y, w, _d = datetime.strptime(t, "%Y-%m-%d").isocalendar()
                key = "%04d-W%02d" % (y, w)
        except ValueError:
            continue
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(x)
    out = []
    prev_c = 0.0
    for key in order:
        g = grouped[key]
        o = prev_c or float(g[0].get("o") or g[0].get("c") or 0)
        c = float(g[-1].get("c") or 0)
        out.append({"t": str(g[-1].get("t") or "")[:10], "o": o, "c": c,
                    "h": max([o, c] + [float(x.get("h") or 0) for x in g]),
                    "l": min([o, c] + [float(x.get("l") or 0) for x in g if x.get("l")]),
                    "v": sum(float(x.get("v") or 0) for x in g)})
        prev_c = c
    return out


def fetch(code: str, period: str = "day", limit: int = 160) -> dict:
    period = period if period in PERIODS else "day"
    limit = max(20, min(int(limit or 160), 480))
    key = (code, period, limit)
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < _cache_ttl.get(key, TTL[period]):
            return hit[1]

    known_fund = False
    try:
        known_fund = str(code).strip() in quotes.fund_codes()
    except Exception:
        known_fund = False

    d = None
    if not known_fund:
        try:
            d = _tx_fetch(code, period, limit)
        except Exception:
            d = None
        if not d or not d.get("items"):
            try:
                em = _em_fetch(code, period, limit)
                if em.get("items") or not d:
                    d = em
            except Exception:
                if d is None:
                    d = None
    if not d or not d.get("items"):
        try:
            fd = _fund_fetch(code, period, limit)
            if fd:
                d = fd
        except Exception:
            pass

    # 港股/美股指数的周月线腾讯只返回当前一段，回退成日线聚合
    if (not d or len(d.get("items") or []) < 5) and period in ("week", "month"):
        try:
            dd = fetch(code, "day", 480 if period == "month" else 240)
            rows = dd.get("items") or []
            if len(rows) >= 5:
                d = {"code": code, "period": period, "name": dd.get("name") or "",
                     "items": _aggregate(rows, period)[-limit:], "prev_close": 0,
                     "source": dd.get("source") or "tx"}
        except Exception:
            pass

    if d and d.get("items"):
        ttl = TTL_FUND if d.get("source") == "fund_nav" else TTL[period]
        with _lock:
            _cache[key] = (time.time(), d)
        _cache_ttl[key] = ttl
    return d or {"code": code, "period": period, "items": [], "source": "none"}
