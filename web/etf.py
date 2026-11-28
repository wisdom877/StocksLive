"""ETF 基础数据：前十大持仓权重（免费源，缓存 7 天）。

数据源：天天基金移动端 FundMNInverstPosition，返回最新季报披露的股票/债券持仓。
- 股票 ETF：fundStocks（代码/名称/占净值比例/较上期增减）
- 债券 ETF：fundboods（债券代码/名称/占净值比例）
- 商品 ETF（黄金等）通常没有股票/债券持仓，返回空列表，前端展示「无持仓披露」。

只用免费接口，不消耗 Wind 积分；季报数据本身有滞后，前端会标报告期。
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import quotes

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "data" / "etf.db"
BJ = timezone(timedelta(hours=8))
TTL = 7 * 86400
PERF_TTL = 6 * 3600
URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition"
FUND_PERF_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNPeriodIncrease"
EM_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
XQ_HOME = "https://xueqiu.com"
XQ_KLINE_URL = "https://stock.xueqiu.com/v5/stock/chart/kline.json"
HDR = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
    "Referer": "https://fund.eastmoney.com/",
}
_lock = threading.Lock()


def is_etf_code(code: str) -> bool:
    return bool(re.fullmatch(r"(?:15|16|51|56|58)\d{4}", str(code or "")))


def _now() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")


def _db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.executescript("""
CREATE TABLE IF NOT EXISTS holdings (
  code TEXT PRIMARY KEY,
  fetched_ts REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perf (
  code TEXT PRIMARY KEY,
  fetched_ts REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
""")
    c.commit()
    return c


def _weight(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def _fetch(code: str) -> dict:
    r = requests.get(URL, params={
        "FCODE": code, "deviceid": "Wap", "plat": "Wap",
        "product": "EFund", "version": "6.3.8",
    }, headers=HDR, timeout=12)
    if r.status_code != 200:
        raise RuntimeError(f"天天基金 HTTP {r.status_code}")
    try:
        j = r.json()
    except Exception as e:
        raise RuntimeError(f"天天基金返回格式异常：{e}") from e
    if not j.get("Success") or str(j.get("ErrCode")) not in ("0", "None"):
        raise RuntimeError(str(j.get("ErrMsg") or "天天基金暂未返回持仓"))
    d = j.get("Datas") or {}
    stocks, bonds = [], []
    for x in d.get("fundStocks") or []:
        w = _weight(x.get("JZBL"))
        if w is None:
            continue
        stocks.append({
            "code": str(x.get("GPDM") or ""),
            "name": str(x.get("GPJC") or ""),
            "weight": w,
            "change_type": str(x.get("PCTNVCHGTYPE") or ""),
            "change": _weight(x.get("PCTNVCHG")),
            "industry": str(x.get("INDEXNAME") or ""),
        })
    for x in d.get("fundboods") or []:
        w = _weight(x.get("ZJZBL"))
        if w is None:
            continue
        bonds.append({
            "code": str(x.get("ZQDM") or ""),
            "name": str(x.get("ZQMC") or ""),
            "weight": w,
        })
    stocks.sort(key=lambda x: -x["weight"])
    bonds.sort(key=lambda x: -x["weight"])
    return {
        "ok": True,
        "code": code,
        "report_date": str(j.get("Expansion") or ""),
        "fetched_at": _now(),
        "stocks": stocks[:10],
        "bonds": bonds[:10],
    }


def get_holdings(code: str, force: bool = False) -> dict:
    """取 ETF 前十大持仓；7 天内走缓存，接口失败时尽量回退到旧缓存。"""
    code = str(code or "").strip()
    if not is_etf_code(code):
        raise ValueError("不是 ETF 代码")
    with _lock:
        c = _db()
        try:
            row = c.execute("SELECT * FROM holdings WHERE code=?", (code,)).fetchone()
        finally:
            c.close()
    cached = None
    if row:
        try:
            cached = json.loads(row["payload"])
        except Exception:
            cached = None
        if not force and cached is not None and time.time() - float(row["fetched_ts"]) < TTL:
            return cached
    try:
        data = _fetch(code)
    except Exception as e:
        if cached is not None:
            cached["stale"] = True
            cached["error"] = str(e)[:200]
            return cached
        return {"ok": False, "code": code, "error": str(e)[:200]}
    with _lock:
        c = _db()
        try:
            c.execute(
                "INSERT OR REPLACE INTO holdings(code,fetched_ts,fetched_at,payload) VALUES(?,?,?,?)",
                (code, time.time(), data["fetched_at"], json.dumps(data, ensure_ascii=False)),
            )
            c.commit()
        finally:
            c.close()
    return data


# ---------------- 持仓重合度（前十大估算） ----------------

def _norm_etfs(items, limit: int = 20) -> list[dict]:
    out, seen = [], set()
    for x in items or []:
        if isinstance(x, dict):
            code = str(x.get("code") or "").strip()
            name = str(x.get("name") or "").strip()
        else:
            code, name = str(x or "").strip(), ""
        if not is_etf_code(code) or code in seen:
            continue
        seen.add(code)
        out.append({"code": code, "name": name or code})
        if len(out) >= limit:
            break
    return out


def _row_key(x: dict) -> str:
    code = str(x.get("code") or "").strip()
    return f"c:{code}" if code else f"n:{x.get('name') or ''}"


def _common_rows(a: list, b: list) -> list[dict]:
    a_map = {_row_key(x): x for x in a or []}
    b_map = {_row_key(x): x for x in b or []}
    out = []
    for k, x in a_map.items():
        y = b_map.get(k)
        if not y:
            continue
        try:
            wa = float(x.get("weight") or 0)
            wb = float(y.get("weight") or 0)
        except (TypeError, ValueError):
            continue
        out.append({
            "code": str(x.get("code") or ""),
            "name": str(x.get("name") or y.get("name") or ""),
            "a_weight": round(wa, 2),
            "b_weight": round(wb, 2),
            "overlap": round(min(wa, wb), 2),
        })
    out.sort(key=lambda z: -z["overlap"])
    return out


def overlaps(candidates, tracked, compare=None) -> list[dict]:
    """计算候选 ETF 与用户持仓/关注的重合度。

    - 直接重合：候选 ETF 前十大里出现用户直接持有的股票，按候选权重求和；
    - ETF 重合：候选与用户持有/关注 ETF（以及自定义对比 ETF）的前十大，
      按共同持仓的 min(权重) 估计重叠暴露；
    - 口径为前十大近似，季报数据有滞后，适合提示重复暴露，不是精确穿透。
    """
    cands = _norm_etfs(candidates, 20)
    if not cands:
        return []
    tracked = [s for s in (tracked or []) if s.get("code")]
    tracked_map = {str(s["code"]): s for s in tracked}
    tracked_etfs = [s for s in tracked if is_etf_code(str(s.get("code") or ""))]
    tracked_etfs.sort(key=lambda s: (0 if s.get("bucket") == "hold" else 1, str(s.get("code"))))
    tracked_etfs = tracked_etfs[:10]

    comps = _norm_etfs(compare, 6)
    comp_list, seen = [], set()
    for s in tracked_etfs:
        code = str(s["code"])
        if code in seen:
            continue
        seen.add(code)
        # 持仓和关注分开：只有「持仓」算重复暴露，关注只做信息展示
        source = "hold" if s.get("bucket") == "hold" else "watch"
        comp_list.append({"code": code, "name": str(s.get("name") or code), "source": source})
    for c in comps:
        if c["code"] in seen:
            continue
        seen.add(c["code"])
        comp_list.append({**c, "source": "compare"})

    all_codes = []
    for c in cands + comp_list:
        if c["code"] not in all_codes:
            all_codes.append(c["code"])
    holdings: dict[str, dict] = {}
    if all_codes:
        with ThreadPoolExecutor(max_workers=min(6, len(all_codes))) as ex:
            futs = {ex.submit(get_holdings, code): code for code in all_codes}
            for f in as_completed(futs):
                code = futs[f]
                try:
                    holdings[code] = f.result()
                except Exception as e:
                    holdings[code] = {"ok": False, "code": code, "error": str(e)[:160]}

    results = []
    for c in cands:
        h = holdings.get(c["code"]) or {}
        if h.get("ok") is False:
            results.append({"ok": False, "code": c["code"], "name": c["name"],
                            "error": h.get("error") or "持仓获取失败"})
            continue
        stocks = h.get("stocks") or []
        bonds = h.get("bonds") or []

        hold_items, watch_items = [], []
        for x in stocks:
            t = tracked_map.get(str(x.get("code") or ""))
            if not t:
                continue
            item = {
                "code": str(x.get("code") or ""),
                "name": str(x.get("name") or t.get("name") or ""),
                "weight": round(float(x.get("weight") or 0), 2),
                "tracked_name": str(t.get("name") or ""),
                "bucket": "hold" if t.get("bucket") == "hold" else "watch",
            }
            (hold_items if item["bucket"] == "hold" else watch_items).append(item)
        hold_items.sort(key=lambda z: -z["weight"])
        watch_items.sort(key=lambda z: -z["weight"])
        direct_total = round(sum(x["weight"] for x in hold_items), 2)
        watch_total = round(sum(x["weight"] for x in watch_items), 2)

        if stocks:
            kind, a = "stock", stocks
        elif bonds:
            kind, a = "bond", bonds
        else:
            kind, a = "", []

        etf_items = []
        for cmp in comp_list:
            if cmp["code"] == c["code"]:
                continue
            oh = holdings.get(cmp["code"]) or {}
            if oh.get("ok") is False:
                etf_items.append({**cmp, "ok": False, "error": oh.get("error") or "持仓获取失败",
                                  "overlap": 0, "common_count": 0, "common": []})
                continue
            b = (oh.get("stocks") or []) if kind == "stock" else (
                (oh.get("bonds") or []) if kind == "bond" else [])
            if not kind or not a or not b:
                if cmp["source"] == "compare":
                    etf_items.append({**cmp, "ok": True, "kind": kind, "overlap": 0,
                                      "common_count": 0, "common": []})
                continue
            common = _common_rows(a, b)
            overlap = round(sum(x["overlap"] for x in common), 2)
            if cmp["source"] in ("hold", "watch") and overlap <= 0:
                continue
            etf_items.append({**cmp, "ok": True, "kind": kind, "overlap": overlap,
                              "common_count": len(common), "common": common[:10]})
        etf_items.sort(key=lambda x: (not x.get("ok", True), -float(x.get("overlap") or 0)))
        max_hold = max([float(x.get("overlap") or 0) for x in etf_items
                        if x.get("ok") and x.get("source") == "hold"], default=0)
        max_watch = max([float(x.get("overlap") or 0) for x in etf_items
                         if x.get("ok") and x.get("source") == "watch"], default=0)
        score = round(max(direct_total, max_hold), 2)
        if max_hold >= 50 or direct_total >= 20:
            level = "high"
        elif max_hold >= 25 or direct_total >= 10:
            level = "mid"
        else:
            level = "low"
        results.append({
            "ok": True,
            "code": c["code"],
            "name": c["name"] or h.get("name") or c["code"],
            "report_date": h.get("report_date") or "",
            "no_holdings": not (stocks or bonds),
            "direct": {
                "total": direct_total, "items": hold_items,
                "watch_total": watch_total, "watch_items": watch_items,
            },
            "etfs": etf_items,
            "max_etf": round(max_hold, 2),
            "max_etf_watch": round(max_watch, 2),
            "score": score,
            "level": level,
        })
    return results


# ---------------- 收益 / 最大回撤（今年 / 本季度 / 成立以来） ----------------

def _parse_klines(rows: list) -> list[tuple[str, float]]:
    by_day: dict[str, float] = {}
    for line in rows or []:
        f = str(line).split(",")
        if len(f) < 3:
            continue
        d = f[0].strip()
        try:
            c = float(f[2])
        except (TypeError, ValueError):
            continue
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d) and c > 0:
            by_day[d] = c
    return sorted(by_day.items())


def _quarter_start(day: str) -> str:
    y, m = int(day[:4]), int(day[5:7])
    qm = ((m - 1) // 3) * 3 + 1
    return f"{y}-{qm:02d}-01"


def _period_stats(dates: list[str], closes: list[float], start: str | None) -> dict:
    idx = -1
    if start:
        for i, d in enumerate(dates):
            if d < start:
                idx = i
            else:
                break
    base_idx = idx if idx >= 0 else 0
    partial = bool(start) and idx < 0
    base = closes[base_idx]
    ret = round((closes[-1] / base - 1) * 100, 2) if base > 0 else None
    peak = closes[base_idx]
    mdd = 0.0
    for c in closes[base_idx:]:
        peak = max(peak, c)
        if peak > 0:
            mdd = min(mdd, (c / peak - 1) * 100)
    rets = [closes[i] / closes[i - 1] - 1 for i in range(base_idx + 1, len(closes))
            if closes[i - 1] > 0]
    vol = None
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / (len(rets) - 1)
        vol = round(math.sqrt(var) * math.sqrt(252) * 100, 2)
    return {"return": ret, "max_drawdown": round(mdd, 2),
            "volatility": vol, "partial": partial}


def _xq_history(code: str) -> list[tuple[str, float]]:
    sym = quotes.secid(code).upper()
    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    session = requests.Session()
    session.get(XQ_HOME, headers={"User-Agent": ua}, timeout=10)
    last_err = ""
    for attempt in range(2):
        try:
            r = session.get(XQ_KLINE_URL, params={
                "symbol": sym, "begin": int(time.time() * 1000), "period": "day",
                "type": "before", "count": -10000, "indicator": "kline",
            }, headers={"User-Agent": ua, "Referer": f"https://xueqiu.com/S/{sym}"}, timeout=12)
            if r.status_code in (400, 401) and attempt == 0:
                session = requests.Session()
                session.get(XQ_HOME, headers={"User-Agent": ua}, timeout=10)
                last_err = f"HTTP {r.status_code}"
                continue
            r.raise_for_status()
            data = r.json().get("data") or {}
            cols = data.get("column") or []
            rows = data.get("item") or []
            if "timestamp" not in cols or "close" not in cols:
                raise RuntimeError("雪球字段异常")
            ti, ci = cols.index("timestamp"), cols.index("close")
            bars: dict[str, float] = {}
            for x in rows:
                try:
                    d = datetime.fromtimestamp(float(x[ti]) / 1000, BJ).strftime("%Y-%m-%d")
                    c = float(x[ci])
                except (TypeError, ValueError, IndexError):
                    continue
                if c > 0:
                    bars[d] = c
            out = sorted(bars.items())
            if len(out) >= 20:
                return out
            last_err = f"只有 {len(out)} 根"
        except Exception as e:
            last_err = str(e)[:160]
        time.sleep(0.4)
    raise RuntimeError(f"雪球历史行情失败：{last_err}")


def _em_history(code: str) -> list[tuple[str, float]]:
    sym = quotes.secid(code)
    secid = ("1." if sym.startswith("sh") else "0.") + sym[2:]
    r = requests.get(EM_KLINE_URL, params={
        "secid": secid, "klt": "101", "fqt": "1", "lmt": "10000",
        "end": "20500101", "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"},
        timeout=12)
    rows = ((r.json().get("data") or {}).get("klines") or [])
    bars = _parse_klines(rows)
    if len(bars) < 20:
        raise RuntimeError("东财历史行情不足")
    return bars


def _fund_reported(code: str) -> dict:
    """基金公布的阶段收益（今年/成立来）与成立日，优先用于收益口径。"""
    try:
        r = requests.get(FUND_PERF_URL, params={
            "FCODE": code, "deviceid": "Wap", "plat": "Wap",
            "product": "EFund", "version": "6.3.8",
        }, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://fund.eastmoney.com/"},
            timeout=10)
        j = r.json()
        out: dict = {}
        for x in j.get("Datas") or []:
            title = str(x.get("title") or "")
            try:
                v = float(x.get("syl"))
            except (TypeError, ValueError):
                continue
            if title == "JN":
                out["ytd"] = round(v, 2)
            elif title == "LN":
                out["since"] = round(v, 2)
        exp = j.get("Expansion") or {}
        if exp.get("ESTABDATE"):
            out["estabdate"] = str(exp["ESTABDATE"])
        if exp.get("TIME"):
            out["as_of"] = str(exp["TIME"])
        return out
    except Exception:
        return {}


def _fetch_perf(code: str) -> dict:
    bars: list[tuple[str, float]] = []
    source = "xueqiu"
    try:
        bars = _xq_history(code)
    except Exception:
        bars = []
    if len(bars) < 20:
        try:
            bars = _em_history(code)
            source = "eastmoney"
        except Exception:
            bars = []
    if len(bars) < 20:
        try:
            import kline
            d = kline.fetch(code, "day", 480)
            bars = sorted({x["t"]: float(x["c"]) for x in (d.get("items") or [])
                           if x.get("c") and x.get("t")}.items())
            source = (d.get("source") or "tx") + "_recent"
        except Exception as e:
            raise RuntimeError(f"ETF 历史行情获取失败：{e}") from e
    if len(bars) < 2:
        raise RuntimeError("ETF 历史行情不足")
    reported = _fund_reported(code)
    dates = [x[0] for x in bars]
    closes = [x[1] for x in bars]
    as_of = dates[-1]
    ytd = _period_stats(dates, closes, f"{as_of[:4]}-01-01")
    qtd = _period_stats(dates, closes, _quarter_start(as_of))
    since = _period_stats(dates, closes, None)
    # 收益优先用基金公布口径；回撤/波动用前复权行情算
    if reported.get("ytd") is not None:
        ytd["return"] = reported["ytd"]
    if reported.get("since") is not None:
        since["return"] = reported["since"]
    if source.endswith("_recent"):
        since["max_drawdown"] = None
        since["volatility"] = None
        since["partial"] = True
    return {
        "ok": True,
        "v": 2,
        "code": code,
        "as_of": reported.get("as_of") or as_of,
        "inception": reported.get("estabdate") or dates[0],
        "bars": len(closes),
        "source": source,
        "ytd": ytd,
        "qtd": qtd,
        "since": since,
        "reported": reported,
    }

def get_perf(code: str, force: bool = False) -> dict:
    code = str(code or "").strip()
    if not is_etf_code(code):
        raise ValueError("不是 ETF 代码")
    with _lock:
        c = _db()
        try:
            row = c.execute("SELECT * FROM perf WHERE code=?", (code,)).fetchone()
        finally:
            c.close()
    cached = None
    if row:
        try:
            cached = json.loads(row["payload"])
        except Exception:
            cached = None
        # 旧缓存（没有 v2 / 波动率字段）当作失效重算一次
        if cached is not None and (cached.get("v") != 2 or "volatility" not in (cached.get("ytd") or {})):
            cached = None
        if not force and cached is not None and time.time() - float(row["fetched_ts"]) < PERF_TTL:
            return cached
    try:
        data = _fetch_perf(code)
    except Exception as e:
        if cached is not None:
            cached["stale"] = True
            cached["error"] = str(e)[:200]
            return cached
        return {"ok": False, "code": code, "error": str(e)[:200]}
    data["fetched_at"] = _now()
    with _lock:
        c = _db()
        try:
            c.execute(
                "INSERT OR REPLACE INTO perf(code,fetched_ts,fetched_at,payload) VALUES(?,?,?,?)",
                (code, time.time(), data["fetched_at"], json.dumps(data, ensure_ascii=False)),
            )
            c.commit()
        finally:
            c.close()
    return data
