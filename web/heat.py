"""股票热度榜：同花顺「大家都在看」+ 东方财富人气榜，均为免费公开接口。"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime

import requests

import kline
import quotes

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

THS_URL = ("https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock"
           "?stock_type=a&type=hour&list_type=normal")
EM_URL = "https://emappdata.eastmoney.com/stockrank/getAllCurrentList"
NAMES = {"ths": "同花顺·大家都在看", "dfcf": "东方财富·人气榜"}
TYPES = {"ths": "ths&normal", "dfcf": "dfcf&renqi"}

_cache: dict[str, tuple[float, dict]] = {}
TTL = 60.0


def _flat_tag(tag) -> str:
    if isinstance(tag, dict):
        parts = []
        if tag.get("popularity_tag"):
            parts.append(str(tag["popularity_tag"]))
        parts += [str(t) for t in (tag.get("concept_tag") or [])[:2]]
        return " · ".join(parts)
    return str(tag or "")


def _ths(limit: int) -> list[dict]:
    r = requests.get(THS_URL, headers={"User-Agent": UA}, timeout=10)
    data = (r.json().get("data") or {}).get("stock_list") or []
    out = []
    for x in data[:limit]:
        out.append({
            "rank": int(x.get("order") or 0),
            "code": str(x.get("code") or "").zfill(6),
            "name": x.get("name") or "",
            "pct": round(float(x.get("rise_and_fall") or 0), 2),
            "heat": x.get("rate") or "",
            "tag": _flat_tag(x.get("tag")) or x.get("analyse_title") or "",
            "reason": (x.get("analyse") or "").replace("\n", " ")[:180],
        })
    return out


# 盘前同花顺榜单的 rise_and_fall 全是 0（当天还没成交），但对用户没用：
# 用最近两个交易日的日 K 算「昨日涨幅」补上，并在前端标「昨」。
# 每只股票缓存 30 分钟，避免每次 60 秒刷新都去打 50 个 K 线接口。
_prev_cache: dict[str, tuple[float, float | None]] = {}
PREV_TTL = 1800.0
PREV_MAX_AGE = 6 * 3600.0


def _one_prev_pct(code: str) -> tuple[str, float | None]:
    try:
        d = kline.fetch(code, "day", 20)
        items = d.get("items") or []
        if len(items) >= 2:
            a, b = items[-2].get("c") or 0, items[-1].get("c") or 0
            if a:
                return code, round((b / a - 1) * 100, 2)
    except Exception:
        pass
    return code, None


def _prev_pcts(codes: list[str]) -> dict[str, float]:
    now = time.time()
    need = [c for c in dict.fromkeys(codes)
            if c and (c not in _prev_cache or now - _prev_cache[c][0] > PREV_TTL)]
    if need:
        # 盘前页面不能为了补涨幅等太久：最多等 6 秒，没回来的下次再补
        ex = ThreadPoolExecutor(max_workers=12)
        futs = [ex.submit(_one_prev_pct, c) for c in need]
        done, _ = wait(futs, timeout=6)
        for f in done:
            try:
                code, pct = f.result()
                if pct is not None:  # 失败不缓存，下一拍再补
                    _prev_cache[code] = (now, pct)
            except Exception:
                pass
        ex.shutdown(wait=False, cancel_futures=True)
    return {c: v for c, (ts, v) in _prev_cache.items()
            if c in codes and v is not None and now - ts <= PREV_MAX_AGE}


def _fill_prev_pct(items: list[dict]) -> None:
    """盘前/休市时涨幅全 0：换成最近一个交易日的涨幅，并标记 pct_note=昨。"""
    if not items or any((x.get("pct") or 0) != 0 for x in items):
        return
    st = quotes.market_status().get("state")
    if st in ("open", "lunch"):
        return
    pcts = _prev_pcts([x["code"] for x in items])
    for x in items:
        p = pcts.get(x["code"])
        if p is not None:
            x["pct"] = p
            x["pct_note"] = "昨"


def _dfcf(limit: int) -> list[dict]:
    r = requests.post(
        EM_URL,
        json={"appId": "appId01", "globalId": "786e4c21-70dc-435a-93bb-38",
              "marketType": "", "pageNo": 1, "pageSize": min(max(limit, 10), 100)},
        headers={"User-Agent": UA, "Content-Type": "application/json"}, timeout=10,
    )
    rows = r.json().get("data") or []
    codes = []
    for x in rows:
        sc = str(x.get("sc") or "")
        if len(sc) >= 8:
            codes.append(sc[2:])
    q = quotes.fetch(codes) if codes else {}
    out = []
    for x in rows[:limit]:
        sc = str(x.get("sc") or "")
        code = sc[2:] if len(sc) >= 8 else ""
        d = q.get(code) or {}
        out.append({
            "rank": int(x.get("rk") or 0), "code": code,
            "name": d.get("name") or "", "pct": round(float(d.get("pct") or 0), 2),
            "heat": "", "tag": "", "reason": "",
        })
    return [x for x in out if x["code"]]


def get(src: str = "ths", limit: int = 50) -> dict:
    src = src if src in TYPES else "ths"
    limit = max(5, min(int(limit or 50), 100))
    now = time.time()
    hit = _cache.get(src)
    if hit and now - hit[0] < TTL:
        return dict(hit[1], cached=True)

    try:
        items = _ths(limit) if src == "ths" else _dfcf(limit)
    except Exception as e:
        return {"src": src, "name": NAMES[src], "items": [], "error": str(e),
                "updated_at": datetime.now(quotes.BJ).strftime("%H:%M"), "note": ""}
    # 补盘前涨幅是锦上添花，失败不能把整个榜单搞没
    try:
        _fill_prev_pct(items)
    except Exception:
        pass

    out = {"src": src, "name": NAMES[src], "items": items, "note": "",
           "updated_at": datetime.now(quotes.BJ).strftime("%H:%M")}
    _cache[src] = (now, out)
    return out
