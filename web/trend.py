"""全市场趋势选股：沪深主板 + 连涨≥2 + 站上 MA20 + MA20 向上 + 多头排列。

数据源
- 股票列表：新浪 Market_Center hs_a（沪深京全 A），只保留沪深主板：
  沪 600/601/603/605，深 000/001/002/003；排除创业板 300/301、
  科创板 688/689、北交所（4/8/92 开头）。
- 日线：同花顺前复权优先；腾讯前复权兜底；新浪不复权最后兜底（会标记）。
  同花顺 last.js 取 140 根，today.js 补当天；腾讯一次取 180 根。
- 缓存：data/trend/bars.db。以“抓取时的最新交易日”为版本，而不是“最后一根
  K 线在最近 3 天内”——交易日重跑直接复用，新交易日必须重新抓；停牌股也不会
  每轮重复请求。
- 预筛：唯一口径是 bars.db 里的前复权 K 线——按「今天这根 K 线」和「昨天」的
  涨跌幅做必要条件过滤（连涨≥2 必然今天和昨天都涨），不再用行情快照的当日涨幅
  （快照与除权口径打架，就是「候选里其实在跌」的来源）。库里没有当天 K 线的代码
  一律放行、交给深扫用 K 线定论。

口径（全部按前复权收盘价）
- 连涨：从最新交易日往前数，收盘 > 前一交易日收盘的连续天数，今天必须上涨。
- 站上 MA20：收盘 > MA20。
- MA20 向上：MA20 比 5 个交易日前高。
- 多头排列：MA5 > MA10 > MA20；上市不足 60 个交易日（MA60 为 None）放宽为
  MA5 > MA10 > MA20，并在结果里标 new_stock。

命令行
  python3 trend.py --print                 # 收盘后扫描并打印
  python3 trend.py --limit 20 --print      # 只深扫前 20 只候选，调试用
  python3 trend.py --all --force           # 全主板重扫（首次建缓存/验算用）
"""
from __future__ import annotations

import argparse
import fcntl
import json
import logging
import os
import re
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed, wait
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import quotes
import tags

BASE = Path(__file__).resolve().parent

# 2026-11-14 用户主要玩 ETF：趋势页默认扫描 ETF。恢复「趋势选股」把这里改回 "stock"，
# 并把前端「趋势选ETF」按钮文字与界面文案改回即可；两套缓存/历史完全分开，互不覆盖。
MODE = "etf"
OUT_DIR = BASE / "data" / "trend_etf"
DB_PATH = OUT_DIR / "bars.db"
LATEST_PATH = OUT_DIR / "latest.json"
UNIVERSE_PATH = OUT_DIR / "universe.json"
HISTORY_DIR = OUT_DIR / "history"
LOCK_PATH = OUT_DIR / "scan.lock"


def _apply_mode(mode: str) -> None:
    """切换 stock / etf 两套独立的缓存目录。"""
    global MODE, OUT_DIR, DB_PATH, LATEST_PATH, UNIVERSE_PATH, HISTORY_DIR, LOCK_PATH
    MODE = "etf" if mode == "etf" else "stock"
    OUT_DIR = BASE / "data" / ("trend_etf" if MODE == "etf" else "trend")
    DB_PATH = OUT_DIR / "bars.db"
    LATEST_PATH = OUT_DIR / "latest.json"
    UNIVERSE_PATH = OUT_DIR / "universe.json"
    HISTORY_DIR = OUT_DIR / "history"
    LOCK_PATH = OUT_DIR / "scan.lock"


_apply_mode(MODE)

BJ = timezone(timedelta(hours=8))
MAX_BARS = 180
MIN_BARS = 25          # MA20 + 5 日前 MA20 至少需要 25 根
DEFAULT_WORKERS = 6
DEFAULT_MIN_STREAK = 2

# 沪深主板：沪 600/601/603/605，深 000/001/002/003。002 是原中小板，已并入深主板。
MAIN_RE = re.compile(r"^(?:600|601|603|605|000|001|002|003)\d{3}$")

# ETF：沪 51/56/58，深 15/16 开头；剔除货币/债券等不看趋势的品种。
ETF_RE = re.compile(r"^(?:15|16|51|56|58)\d{4}$")
ETF_NAME_EXCLUDE = re.compile(
    r"货币|添益|日利|快线|保证金|现金|理财|债|国债|政金|城投|信用|转债|短融|融资"
    r"|国开|口行|农发|存单|利率|同业存单|政金债"
)
# 沪市 511xxx 是债券 ETF 专区（国债/政金债/信用债/转债），逐只认名字不如按段一刀切
ETF_BOND_PREFIX = ("511",)
ETF_MIN_AMOUNT = 20_000_000   # 当日成交额门槛（元）：2000 万以下的 ETF 不参与趋势筛选
SINA_LIST = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
             "Market_Center.getHQNodeData")
SINA_KLINE = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_{sym}_240_1_1=/" \
             "CN_MarketDataService.getKLineData"
SINA_KLINE_JSON = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/" \
                  "CN_MarketData.getKLineData"
THS_LINE = "https://d.10jqka.com.cn/v6/line/hs_{code}/{kind}/{name}.js"
XQ_KLINE = "https://stock.xueqiu.com/v5/stock/chart/kline.json"
XQ_HOME = "https://xueqiu.com/"
TX_HOSTS = [
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get",
    "https://ifzq.gtimg.cn/appstock/app/fqkline/get",
]

HDR_SINA = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}
HDR_THS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.10jqka.com.cn/"}
HDR_TX = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
          "Referer": "https://finance.qq.com/"}

log = logging.getLogger("trend")
_local = threading.local()
_tx_cooldown: dict[str, float] = {}
_tx_lock = threading.Lock()
_xq_jar: requests.cookies.RequestsCookieJar | None = None
_xq_lock = threading.Lock()


class FetchError(RuntimeError):
    pass


# ---------------- HTTP ----------------

def _session() -> requests.Session:
    s = getattr(_local, "session", None)
    if s is None:
        s = requests.Session()
        s.mount("https://", requests.adapters.HTTPAdapter(
            pool_connections=1, pool_maxsize=2, max_retries=0))
        _local.session = s
    return s


def _get(url: str, params: dict | None, headers: dict, timeout: float) -> requests.Response:
    r = _session().get(url, params=params, headers=headers, timeout=timeout)
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}")
    return r


def _sina_json(url: str, params: dict, timeout: float = 12) -> object:
    r = _get(url, params, HDR_SINA, timeout)
    text = r.text.strip()
    if text.startswith("/*"):
        text = text[text.find("*/") + 2:].strip()
    if "=(" in text:
        text = text[text.index("=(") + 2:text.rindex(")")]
    return json.loads(text)


# ---------------- 股票列表 ----------------

def is_main_board(code: str) -> bool:
    """沪深主板（不含创业板/科创板/北交所）。"""
    return bool(MAIN_RE.match(str(code or "").zfill(6)))


def _normalize_universe(rows: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for x in rows or []:
        code = str(x.get("code") or "").zfill(6)
        if not is_main_board(code) or code in seen:
            continue
        try:
            trade = float(x.get("trade") or 0)
            settle = float(x.get("settlement") or 0)
            pct = float(x.get("changepercent") or 0)
            chg = float(x.get("pricechange") or 0)
            pe = float(x.get("per") or 0) or None          # 负数为亏损，保留；0 视为无
            pb = float(x.get("pb") or 0) or None
            float_cap = float(x.get("nmc") or 0) / 10000 or None   # 新浪 nmc 单位万元 → 亿元
            total_cap = float(x.get("mktcap") or 0) / 10000 or None
            turnover = float(x.get("turnoverratio") or 0)
        except (TypeError, ValueError):
            continue
        seen.add(code)
        out.append({
            "code": code,
            "name": str(x.get("name") or "").strip() or code,
            "trade": trade,
            "settlement": settle,
            "pct": pct,
            "pricechange": chg,
            "pe": pe,
            "pb": pb,
            "float_cap": float_cap,
            "total_cap": total_cap,
            "turnover": turnover,
        })
    out.sort(key=lambda x: x["code"])
    return out


def _official_name_map() -> dict[str, str]:
    """market.db 夜批存的是腾讯快照名称（正式全名），比新浪简称准。"""
    try:
        import marketdb
        with marketdb.conn() as c:
            r = c.execute("SELECT MAX(date) AS d FROM snap WHERE market='a'").fetchone()
            if not r or not r["d"]:
                return {}
            rows = c.execute("SELECT code,name FROM snap WHERE market='a' AND date=?",
                             (r["d"],)).fetchall()
            return {x["code"]: x["name"] for x in rows if x["name"]}
    except Exception:
        return {}


def _normalize_etf_universe(rows: list[dict]) -> list[dict]:
    """把新浪 ETF 列表整理成扫描池：剔除货币/债券，按当日成交额设门槛。"""
    out: list[dict] = []
    seen: set[str] = set()
    official = _official_name_map()
    for x in rows or []:
        code = str(x.get("code") or "").zfill(6)
        if not ETF_RE.match(code) or code in seen:
            continue
        name = str(x.get("name") or "").strip() or code
        if code.startswith(ETF_BOND_PREFIX):
            continue
        # 简称先过一遍，再拿正式全名过一遍（「国开ETF」的正式名是「国开债ETF博时」）
        if ETF_NAME_EXCLUDE.search(name) or ETF_NAME_EXCLUDE.search(official.get(code, "")):
            continue
        try:
            trade = float(x.get("trade") or 0)
            settle = float(x.get("settlement") or 0)
            pct = float(x.get("changepercent") or 0)
            chg = float(x.get("pricechange") or 0)
            amount = float(x.get("amount") or 0)
            float_cap = float(x.get("nmc") or 0) / 10000 or None   # 新浪 nmc 单位万元 → 亿元
            total_cap = float(x.get("mktcap") or 0) / 10000 or None
            turnover = float(x.get("turnoverratio") or 0)
        except (TypeError, ValueError):
            continue
        if trade <= 0 or amount < ETF_MIN_AMOUNT:
            continue
        seen.add(code)
        out.append({
            "code": code,
            "name": name,
            "trade": trade,
            "settlement": settle,
            "pct": pct,
            "pricechange": chg,
            "pe": None,
            "pb": None,
            "float_cap": float_cap,
            "total_cap": total_cap,
            "turnover": turnover,
            "amount": amount,
            "is_etf": True,
        })
    out.sort(key=lambda x: (-x["amount"], x["code"]))
    return out


def _fetch_etf_universe() -> list[dict]:
    """新浪 ETF 列表（node=etf_hq_fund），按 100 条分页。"""
    last = ""
    for attempt in range(3):
        try:
            rows: list[dict] = []
            page = 1
            while page <= 20:
                try:
                    data = _sina_json(SINA_LIST, {
                        "page": page, "num": 100, "sort": "symbol", "asc": 1,
                        "node": "etf_hq_fund", "symbol": "", "_s_r_a": "page",
                    }, timeout=15)
                except Exception as e:
                    raise FetchError(f"第 {page} 页失败：{e}") from e
                if not data:
                    break
                if not isinstance(data, list):
                    raise FetchError(f"第 {page} 页格式异常")
                rows.extend(data)
                if len(data) < 100:
                    break
                page += 1
            if len(rows) < 200:
                raise FetchError(f"ETF 列表不完整：{len(rows)} 只")
            return _normalize_etf_universe(rows)
        except Exception as e:
            last = str(e)
            time.sleep(1.0 + attempt)
    raise FetchError(f"ETF 列表获取失败：{last}")


def _fetch_universe() -> list[dict]:
    """新浪股票/ETF 列表，按 100 条分页。任何一页失败都重试；缺页则抛错，不静默半份列表。"""
    if MODE == "etf":
        return _fetch_etf_universe()
    last = ""
    for attempt in range(3):
        try:
            rows: list[dict] = []
            page = 1
            while page <= 80:
                try:
                    data = _sina_json(SINA_LIST, {
                        "page": page, "num": 100, "sort": "symbol", "asc": 1,
                        "node": "hs_a", "symbol": "", "_s_r_a": "page",
                    }, timeout=15)
                except Exception as e:
                    raise FetchError(f"第 {page} 页失败：{e}") from e
                if not data:
                    break
                if not isinstance(data, list):
                    raise FetchError(f"第 {page} 页格式异常")
                rows.extend(data)
                if len(data) < 100:
                    break
                page += 1
            if len(rows) < 4000:
                raise FetchError(f"股票列表不完整：{len(rows)} 只")
            return _normalize_universe(rows)
        except Exception as e:
            last = str(e)
            time.sleep(1.0 + attempt)
    raise FetchError(f"股票列表获取失败：{last}")


def _load_universe(latest: str, force: bool = False) -> tuple[list[dict], str]:
    """同一天内复用列表（含当天涨幅），跨交易日必须重新抓。"""
    try:
        raw = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
        age = time.time() - float(raw.get("ts") or 0)
        min_items = 100 if MODE == "etf" else 3000
        if (not force and raw.get("date") == latest and age < 12 * 3600
                and isinstance(raw.get("items"), list) and len(raw["items"]) > min_items):
            return raw["items"], "cache"
    except Exception:
        pass
    try:
        items = _fetch_universe()
    except Exception:
        # 当天已有缓存时允许降级复用；跨交易日绝不用旧涨幅预筛。
        try:
            raw = json.loads(UNIVERSE_PATH.read_text(encoding="utf-8"))
            if raw.get("date") == latest and isinstance(raw.get("items"), list):
                log.warning("股票列表刷新失败，复用当天缓存 %d 只", len(raw["items"]))
                return raw["items"], "cache-stale"
        except Exception:
            pass
        raise
    _atomic_json(UNIVERSE_PATH, {"date": latest, "ts": time.time(), "items": items})
    return items, "sina"


# ---------------- 交易日 ----------------

def _sina_index_dates(n: int = 6) -> list[str]:
    sym = "sh000001"
    last = ""
    for attempt in range(3):
        for url, params in (
            (SINA_KLINE.format(sym=sym),
             {"symbol": sym, "scale": 240, "ma": "no", "datalen": n}),
            (SINA_KLINE_JSON,
             {"symbol": sym, "scale": 240, "ma": "no", "datalen": n}),
        ):
            try:
                rows = _sina_json(url, params, timeout=10)
                dates = [str(x.get("day") or "") for x in (rows or []) if x.get("day")]
                dates = [d for d in dates if re.match(r"^\d{4}-\d{2}-\d{2}$", d)]
                if len(dates) >= 2:
                    return sorted(dict.fromkeys(dates))[-n:]
            except Exception as e:
                last = str(e)
        time.sleep(0.8 + attempt)
    raise FetchError(f"指数交易日获取失败：{last}")


def _trade_dates() -> tuple[str, str]:
    dates = _sina_index_dates(8)
    if len(dates) < 2:
        raise FetchError("指数历史不足两个交易日")
    return dates[-1], dates[-2]


# ---------------- 缓存 ----------------

def _db() -> sqlite3.Connection:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(OUT_DIR, 0o700)
    except OSError:
        pass
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.executescript("""
CREATE TABLE IF NOT EXISTS bars (
  code TEXT PRIMARY KEY,
  checked_date TEXT NOT NULL,
  last_date TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  closes TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_pct (
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  pct REAL NOT NULL,
  pricechange REAL NOT NULL,
  trade REAL NOT NULL,
  settlement REAL NOT NULL,
  PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_daily_pct_date ON daily_pct(date);
""")
    c.commit()
    return c


def _load_cache(c: sqlite3.Connection) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for r in c.execute("SELECT code, checked_date, last_date, source, closes FROM bars"):
        try:
            raw = json.loads(r["closes"])
            bars = [(str(x[0]), float(x[1])) for x in raw
                    if isinstance(x, (list, tuple)) and len(x) >= 2 and float(x[1]) > 0]
        except Exception:
            continue
        if bars:
            out[r["code"]] = {
                "checked_date": r["checked_date"],
                "last_date": r["last_date"],
                "source": r["source"] or "",
                "bars": bars[-MAX_BARS:],
            }
    return out


def _save_cache(c: sqlite3.Connection, rows: dict[str, dict], latest: str) -> None:
    now = datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")
    c.executemany(
        "INSERT OR REPLACE INTO bars(code, checked_date, last_date, source, fetched_at, closes) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [(code, latest, r["bars"][-1][0], r["source"], now,
          json.dumps([[d, round(v, 4)] for d, v in r["bars"]], ensure_ascii=False))
         for code, r in rows.items() if r.get("bars")],
    )
    c.commit()





# ---------------- K 线源 ----------------

def _clean_bars(rows: list) -> list[tuple[str, float]]:
    """去重、升序、丢掉非正收盘价。rows 元素为 (date, close) 或 [date, close]。"""
    by_day: dict[str, float] = {}
    for x in rows or []:
        try:
            d, c = str(x[0]), float(x[1])
        except (TypeError, ValueError, IndexError):
            continue
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d) and c > 0:
            by_day[d] = c
    return sorted(by_day.items())[-MAX_BARS:]


def _ths_last(code: str) -> list[tuple[str, float]]:
    r = _get(THS_LINE.format(code=code, kind="01", name="last"), None, HDR_THS, 10)
    text = r.text
    i, j = text.find("("), text.rfind(")")
    if i < 0 or j <= i:
        raise FetchError("同花顺 last.js 格式异常")
    data = json.loads(text[i + 1:j]).get("data") or ""
    rows = []
    for line in data.split(";"):
        p = line.split(",")
        if len(p) < 5 or len(p[0]) != 8:
            continue
        rows.append((f"{p[0][:4]}-{p[0][4:6]}-{p[0][6:8]}", p[4]))
    bars = _clean_bars(rows)
    if not bars:
        raise FetchError("同花顺无历史 K 线")
    return bars


def _ths_today(code: str) -> tuple[str, float]:
    r = _get(THS_LINE.format(code=code, kind="01", name="today"), None, HDR_THS, 10)
    text = r.text
    i, j = text.find("("), text.rfind(")")
    if i < 0 or j <= i:
        raise FetchError("同花顺 today.js 格式异常")
    obj = json.loads(text[i + 1:j])
    v = obj.get(f"hs_{code}") or next(iter(obj.values()), {})
    raw_day, raw_close = str(v.get("1") or ""), v.get("11")
    if len(raw_day) != 8 or raw_close in (None, ""):
        raise FetchError("同花顺今日 K 线缺失")
    close = float(raw_close)
    if close <= 0:
        raise FetchError("同花顺今日收盘价无效")
    return f"{raw_day[:4]}-{raw_day[4:6]}-{raw_day[6:8]}", close


def _merge_today(bars: list[tuple[str, float]], today: tuple[str, float],
                 latest: str, prev: str) -> list[tuple[str, float]]:
    if not bars:
        raise FetchError("无历史 K 线")
    if bars[-1][0] == latest:
        return bars[-MAX_BARS:]
    if bars[-1][0] != prev:
        raise FetchError(f"历史止于 {bars[-1][0]}，不是上一交易日 {prev}")
    if not today or today[0] != latest:
        raise FetchError("今日 K 线日期不符")
    return (bars + [today])[-MAX_BARS:]


def _fetch_ths_full(code: str, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    bars = _ths_last(code)
    if bars[-1][0] == latest:
        return bars, "ths"
    today = _ths_today(code)
    return _merge_today(bars, today, latest, prev), "ths"


def _fetch_ths_today(code: str, latest: str) -> float:
    today = _ths_today(code)
    if today[0] != latest:
        raise FetchError(f"今日 K 线日期 {today[0]} 不符")
    return today[1]


def _xq_cookies() -> requests.cookies.RequestsCookieJar:
    """雪球 K 线需要首页下发的 xq_a_token；整轮扫描只取一次。"""
    global _xq_jar
    with _xq_lock:
        if _xq_jar is None:
            r = requests.get(XQ_HOME, headers=HDR_SINA, timeout=10)
            if r.status_code != 200:
                raise FetchError(f"雪球首页 HTTP {r.status_code}")
            _xq_jar = r.cookies
        return _xq_jar


def _xq_session() -> requests.Session:
    s = getattr(_local, "xq", None)
    if s is None:
        s = requests.Session()
        s.cookies.update(_xq_cookies())
        _local.xq = s
    return s


def _fetch_xq_full(code: str, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    sym = quotes.secid(code).upper()
    last_err = ""
    for attempt in range(2):
        try:
            r = _xq_session().get(XQ_KLINE, params={
                "symbol": sym, "begin": int(time.time() * 1000), "period": "day",
                "type": "before", "count": -MAX_BARS, "indicator": "kline",
            }, headers={**HDR_SINA, "Referer": f"https://xueqiu.com/S/{sym}"}, timeout=10)
            if r.status_code in (400, 401) and attempt == 0:
                global _xq_jar
                with _xq_lock:
                    _xq_jar = None
                _local.xq = None
                last_err = f"HTTP {r.status_code}"
                continue
            if r.status_code != 200:
                raise FetchError(f"HTTP {r.status_code}")
            data = (r.json().get("data") or {})
            cols = data.get("column") or []
            rows = data.get("item") or []
            if "timestamp" not in cols or "close" not in cols:
                raise FetchError("雪球 K 线字段异常")
            ti, ci = cols.index("timestamp"), cols.index("close")
            parsed = []
            for x in rows:
                d = datetime.fromtimestamp(float(x[ti]) / 1000, BJ).strftime("%Y-%m-%d")
                parsed.append((d, x[ci]))
            bars = _clean_bars(parsed)
            if bars and bars[-1][0] == latest:
                return bars, "xueqiu"
            last_err = f"最新 {bars[-1][0] if bars else '无'}"
        except Exception as e:
            last_err = str(e)
        time.sleep(0.3 + attempt)
    raise FetchError(f"雪球 K 线失败：{last_err}")


def _fetch_tx_full(code: str, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    sym = quotes.secid(code)
    last_err = ""
    for host in TX_HOSTS:
        with _tx_lock:
            until = _tx_cooldown.get(host, 0)
        if until > time.time():
            continue
        try:
            r = _get(host, {"param": f"{sym},day,,,{MAX_BARS},qfq"}, HDR_TX, 10)
            j = r.json()
            d = (j.get("data") or {}).get(sym) or {}
            raw = d.get("qfqday") or d.get("day") or []
            rows = []
            for x in raw:
                if len(x) >= 3:
                    rows.append((x[0], x[2]))
            bars = _clean_bars(rows)
            if bars and bars[-1][0] == latest:
                return bars, "tx" if d.get("qfqday") else "tx_unadj"
            last_err = f"最新 {bars[-1][0] if bars else '无'}"
        except Exception as e:
            last_err = str(e)
            if "501" in last_err:
                with _tx_lock:
                    _tx_cooldown[host] = time.time() + 600
    raise FetchError(f"腾讯 K 线失败：{last_err}")


def _fetch_sina_full(code: str, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    sym = quotes.secid(code)
    last_err = ""
    for attempt in range(2):
        try:
            rows = _sina_json(SINA_KLINE_JSON, {
                "symbol": sym, "scale": 240, "ma": "no", "datalen": MAX_BARS,
            }, timeout=10)
            bars = _clean_bars([(x.get("day"), x.get("close")) for x in (rows or [])])
            if bars and bars[-1][0] == latest:
                return bars, "sina_unadj"
            last_err = f"最新 {bars[-1][0] if bars else '无'}"
        except Exception as e:
            last_err = str(e)
        time.sleep(0.4 + attempt)
    raise FetchError(f"新浪 K 线失败：{last_err}")


def _settle_ok(bars: list[tuple[str, float]], item: dict, offset: int = 1) -> bool:
    """前复权序列中“昨收”必须等于交易所口径的昨收；不相等说明复权基准过期/不复权。

    offset=1：序列已含今天，昨收是 bars[-2]（完整/追加后校验）；
    offset=0：序列止于昨天，昨收是 bars[-1]（增量抓取前的缓存校验）。
    """
    settle = float(item.get("settlement") or 0)
    idx = 1 + max(0, int(offset))
    if settle <= 0 or len(bars) < idx:
        return True
    return abs(bars[-idx][1] - settle) <= max(0.021, settle * 0.0015)


def _validate(bars: list[tuple[str, float]], item: dict, latest: str) -> None:
    if not bars:
        raise FetchError("无 K 线")
    if bars[-1][0] != latest:
        raise FetchError(f"最新 K 线 {bars[-1][0]} 不是 {latest}")
    if not _settle_ok(bars, item):
        raise FetchError("复权校验失败（昨收与交易所不一致）")


def _fetch_full(item: dict, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    errors: list[str] = []
    for fn, label in ((_fetch_ths_full, "ths"), (_fetch_xq_full, "xueqiu"),
                      (_fetch_tx_full, "tx"), (_fetch_sina_full, "sina")):
        try:
            bars, src = fn(item["code"], latest, prev)
            _validate(bars, item, latest)
            return bars, src
        except Exception as e:
            errors.append(f"{label}:{e}")
    raise FetchError("；".join(errors)[:400])


def _fetch_qfq_only(item: dict, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    """只走前复权源；用于把新浪不复权兜底的结果再抢救一次。"""
    errors: list[str] = []
    for fn, label in ((_fetch_ths_full, "ths"), (_fetch_xq_full, "xueqiu"),
                      (_fetch_tx_full, "tx")):
        try:
            bars, src = fn(item["code"], latest, prev)
            if src.endswith("_unadj"):
                raise FetchError("不复权源")
            _validate(bars, item, latest)
            return bars, src
        except Exception as e:
            errors.append(f"{label}:{e}")
    raise FetchError("；".join(errors)[:300])


def _fetch_incremental(item: dict, row: dict, latest: str, prev: str) -> tuple[list[tuple[str, float]], str]:
    # 不复权历史不能和新一天的收盘拼在一起；交给全量源重新取前复权。
    if (row.get("source") or "").endswith("_unadj") or not _settle_ok(row["bars"], item, offset=0):
        return _fetch_full(item, latest, prev)
    try:
        close = _fetch_ths_today(item["code"], latest)
        bars = (row["bars"] + [(latest, close)])[-MAX_BARS:]
        _validate(bars, item, latest)
        return bars, "ths+today"
    except Exception:
        return _fetch_full(item, latest, prev)


# ---------------- 条件 ----------------

def _sma(vals: list[float], n: int, offset: int = 0) -> float | None:
    end = len(vals) - offset
    if end < n:
        return None
    return sum(vals[end - n:end]) / n


def check(bars: list[tuple[str, float]], min_streak: int = DEFAULT_MIN_STREAK,
          stages: dict | None = None) -> dict | None:
    """按前复权收盘价判断四个条件，全部满足才返回指标，否则 None。

    stages 传进来时顺手统计「漏斗」每一步剩多少只，给空结果页解释用。"""
    def _tick(k: str) -> None:
        if stages is not None:
            stages[k] = int(stages.get(k, 0)) + 1

    closes = [float(x[1]) for x in bars]
    if len(closes) < MIN_BARS or closes[-1] <= 0 or closes[-2] <= 0:
        return None
    _tick("bars_ok")
    ma5 = _sma(closes, 5)
    ma10 = _sma(closes, 10)
    ma20 = _sma(closes, 20)
    ma60 = _sma(closes, 60)
    ma20_prev = _sma(closes, 20, offset=5)
    if ma5 is None or ma10 is None or ma20 is None or ma20_prev is None:
        return None

    # 1) 站上 MA20
    if not closes[-1] > ma20:
        return None
    _tick("above_ma20")
    # 2) MA20 近 5 个交易日向上
    if not ma20 > ma20_prev:
        return None
    _tick("ma20_up")
    # 3) 多头排列；次新股（不足 60 根）放宽 MA60 这一档
    if not (ma5 > ma10 > ma20):
        return None
    if ma60 is not None and not (ma20 > ma60):
        return None
    _tick("bull")
    # 4) 连涨天数：严格收盘 > 前一交易日收盘，从最新往前数
    streak = 0
    for i in range(len(closes) - 1, 0, -1):
        if closes[i] > closes[i - 1]:
            streak += 1
        else:
            break
    if streak < max(1, int(min_streak)):
        return None
    _tick("streak")
    _tick("pass")

    streak_pcts = [
        round((closes[i] / closes[i - 1] - 1) * 100, 2)
        for i in range(len(closes) - streak, len(closes))
    ]
    streak_total = round((closes[-1] / closes[-1 - streak] - 1) * 100, 2)
    return {
        "streak": streak,
        "price": round(closes[-1], 3),
        "pct": round((closes[-1] / closes[-2] - 1) * 100, 2),
        "streak_pcts": streak_pcts,
        "streak_total": streak_total,
        "spark": [round(x, 3) for x in closes[-20:]],
        "ma5": round(ma5, 3),
        "ma10": round(ma10, 3),
        "ma20": round(ma20, 3),
        "ma60": round(ma60, 3) if ma60 is not None else None,
        "ma20_slope": round((ma20 / ma20_prev - 1) * 100, 2),
        "dist_ma20": round((closes[-1] / ma20 - 1) * 100, 2),
        "new_stock": ma60 is None,
    }


def _is_up(pct: float, chg: float) -> bool:
    return pct > 0 or chg > 0


def _is_down(pct: float, chg: float) -> bool:
    return pct < 0 or (pct == 0 and chg < 0)


def _bar_pct_at(bars: list[tuple[str, float]], day: str) -> float | None:
    """某日相对前一日的涨跌幅（%），取不到返回 None。bars 是 [(日期, 收盘), ...]。"""
    for i in range(len(bars) - 1, 0, -1):
        if bars[i][0] == day:
            try:
                prev = float(bars[i - 1][1])
                if prev:
                    return (float(bars[i][1]) / prev - 1) * 100
            except (TypeError, ValueError, ZeroDivisionError):
                return None
            return None
    return None


def _db_pct_index(c: sqlite3.Connection, days: list[str]) -> dict[str, dict]:
    """预筛的唯一数据源：直读 bars.db，按前复权收盘价算指定交易日的涨跌幅（%）。

    不再拿行情快照的涨幅判定——快照是当日口径、K 线是除权口径，两边打架正是
    「155 只候选里 8 只其实在跌」的来源。库里没有当天 K 线的代码返回 None，
    由调用方保守放进深扫（宁可多抓一只，也不误杀一只）。
    """
    out: dict[str, dict] = {}
    for r in c.execute("SELECT code, source, closes FROM bars"):
        if str(r["source"] or "").endswith("_unadj"):
            continue                     # 不复权数据不参与判定
        try:
            raw = json.loads(r["closes"])
            bars = [(str(x[0]), float(x[1])) for x in raw
                    if isinstance(x, (list, tuple)) and len(x) >= 2 and float(x[1]) > 0]
        except Exception:
            continue
        if not bars:
            continue
        rec = {d: _bar_pct_at(bars, d) for d in days}
        if any(v is not None for v in rec.values()):
            out[r["code"]] = rec
    return out


def _prefilter_ok(pct: float | None) -> bool:
    """今天该不该进深扫：只看库里的 K 线涨跌幅，缺数据一律放行。"""
    return True if pct is None else _is_up(float(pct), 0.0)


def _prev_prefilter_ok(pct: float | None) -> bool:
    """昨天不该是下跌日：同样只看库里的 K 线。"""
    return True if pct is None else not _is_down(float(pct), 0.0)


# 板块/概念里排除风格、指数、地域等噪声；卡片只留行业 + 具体题材。
TAG_NOISE = re.compile(
    r"标准普尔|标普|MSCI|富时|罗素|HS300|上证50|中证|深证|创业板指|科创50|沪深300|A50|"
    r"大盘|中盘|小盘|价值|成长|风格|央企|国企改革|乡村振兴|"
    r"超级品牌|融资融券|股通|指数|成分|次新|破净|高股息|低价股|AH股|B股|转债"
)
REGION_RE = re.compile(
    r"^(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|"
    r"河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|"
    r"内蒙古|香港|澳门|台湾)$"
)


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if x != 0 else None


def _clean_tags(tags_in) -> list[str]:
    out: list[str] = []
    for t in tags_in or []:
        t = str(t or "").strip()
        if not t or TAG_NOISE.search(t) or REGION_RE.match(t):
            continue
        if t not in out:
            out.append(t)
    return out[:3]


def _enrich_hits(hits: list[dict], items: dict[str, dict]) -> None:
    """给命中股补 PE/流通值/量比/换手/行业概念；任何一项失败都不影响扫描结果。"""
    if not hits:
        return
    if MODE == "etf":
        # ETF 没有 PE/PB，也不去查个股行业标签；补规模、成交额、量比、换手就够。
        codes = [h["code"] for h in hits]
        try:
            qmap = quotes.fetch(codes) or {}
        except Exception as e:
            log.warning("ETF 结果补充行情失败：%s", e)
            qmap = {}
        for h in hits:
            q = qmap.get(h["code"]) or {}
            u = items.get(h["code"]) or {}
            h["is_etf"] = True
            h["name"] = q.get("name") or h.get("name") or h["code"]
            h["pe"] = None
            h["pb"] = None
            h["tags"] = []
            h["float_cap"] = _num(q.get("float_cap")) or _num(u.get("float_cap"))
            h["total_cap"] = _num(q.get("total_cap")) or _num(u.get("total_cap"))
            h["turnover_rate"] = _num(q.get("turnover_rate")) or _num(u.get("turnover"))
            h["vol_ratio"] = _num(q.get("vol_ratio"))
            amt = _num(q.get("amount"))          # quotes 返回万元
            h["amount"] = amt if amt is not None else (
                _num(u.get("amount")) / 10000 if _num(u.get("amount")) else None)
        return
    codes = [h["code"] for h in hits]
    qmap: dict[str, dict] = {}
    try:
        qmap = quotes.fetch(codes) or {}
    except Exception as e:
        log.warning("趋势结果补充行情失败：%s", e)

    tag_map: dict[str, list[str]] = {}

    def one(code: str):
        try:
            return code, tags.auto_tags(code, 4)
        except Exception:
            return code, []

    # 东财 F10 偶尔慢/限流；最多等 20 秒，拿不到的先空着，不拖死整轮扫描。
    ex = ThreadPoolExecutor(max_workers=min(8, len(codes)))
    futs = {ex.submit(one, c): c for c in codes}
    done, _ = wait(futs, timeout=20)
    for f in done:
        try:
            code, tg = f.result()
            tag_map[code] = tg
        except Exception:
            pass
    ex.shutdown(wait=False, cancel_futures=True)

    for h in hits:
        q = qmap.get(h["code"]) or {}
        u = items.get(h["code"]) or {}
        pe = _num(q.get("pe"))
        tr = _num(q.get("turnover_rate"))
        h["pe"] = pe if pe is not None else _num(u.get("pe"))
        h["float_cap"] = _num(q.get("float_cap")) or _num(u.get("float_cap"))
        h["total_cap"] = _num(q.get("total_cap")) or _num(u.get("total_cap"))
        h["vol_ratio"] = _num(q.get("vol_ratio"))
        h["turnover_rate"] = tr if tr is not None else _num(u.get("turnover"))
        h["pb"] = _num(q.get("pb")) or _num(u.get("pb"))
        h["tags"] = _clean_tags(tag_map.get(h["code"]) or [])


# ---------------- 扫描 ----------------

def _scan_params(min_streak: int) -> dict:
    """输出给前端的口径说明；stock/etf 两套文案分开。"""
    if MODE == "etf":
        return {
            "min_streak": max(1, int(min_streak)),
            "boards": "沪深ETF",
            "exclude": ["货币/债券ETF", f"当日成交额 < {ETF_MIN_AMOUNT / 10000:.0f}万"],
            "ma20_up_days": 5,
            "bull_alignment": "MA5>MA10>MA20>MA60（不足60根放宽）",
        }
    return {
        "min_streak": max(1, int(min_streak)),
        "boards": "沪深主板",
        "exclude": ["创业板 300/301", "科创板 688/689", "北交所"],
        "ma20_up_days": 5,
        "bull_alignment": "MA5>MA10>MA20>MA60（不足60根放宽）",
    }


def _prev_list_days(prev: str) -> dict[str, int]:
    """读取上一交易日的命中记录，用来算“连续在榜 N 天”。"""
    try:
        d = json.loads((HISTORY_DIR / f"{prev}.json").read_text(encoding="utf-8"))
        return {str(x.get("code")): int(x.get("on_list_days") or 1)
                for x in d.get("items") or [] if x.get("code")}
    except Exception:
        return {}


def _atomic_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    finally:
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except OSError:
            pass


def _acquire_lock():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    f = open(LOCK_PATH, "a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        raise RuntimeError("已有趋势扫描在运行")
    return f


def _intraday_guard(now: datetime, allow_intraday: bool) -> None:
    if allow_intraday or not quotes.is_trading_day(now.strftime("%Y-%m-%d")):
        return
    minutes = now.hour * 60 + now.minute
    if minutes < 15 * 60 + 20:
        raise RuntimeError("交易日 15:20 前不扫描（收盘价/行情源未定）；调试请加 --intraday")


def scan(workers: int = DEFAULT_WORKERS, limit: int = 0, force: bool = False,
         min_streak: int = DEFAULT_MIN_STREAK, all_mode: bool = False,
         intraday: bool = False, allow_stale: bool = False) -> dict:
    started = time.time()
    now = datetime.now(BJ)
    _intraday_guard(now, intraday)
    lock = _acquire_lock()
    try:
        latest, prev = _trade_dates()
        today = now.strftime("%Y-%m-%d")
        if (not allow_stale and latest != today and quotes.is_trading_day(today)
                and now.hour * 60 + now.minute >= 15 * 60 + 20):
            raise RuntimeError(f"行情源尚未更新今日收盘（指数最新 {latest}），本次不覆盖结果")

        c = _db()
        try:
            # 交易日必须现抓列表：中午/盘中缓存里的涨幅不能拿来当收盘预筛，
            # 也会把错误的当天涨幅写进 daily_pct 影响第二天。
            items, universe_src = _load_universe(
                latest, force=force or quotes.is_trading_day(today))
            pct_idx = _db_pct_index(c, [latest, prev])
            cache = _load_cache(c)

            reuse: dict[str, dict] = {}
            incremental: list[tuple[dict, dict]] = []
            full: list[dict] = []
            prefiltered = suspended = 0

            for item in items:
                code = item["code"]
                if item["trade"] <= 0:
                    suspended += 1
                    continue
                row = cache.get(code)
                if not all_mode:
                    rec = pct_idx.get(code) or {}
                    if not _prefilter_ok(rec.get(latest)) or not _prev_prefilter_ok(rec.get(prev)):
                        prefiltered += 1
                        continue
                if not force and row and row["checked_date"] == latest \
                        and row["bars"] and row["bars"][-1][0] == latest:
                    reuse[code] = row
                    continue
                if not force and row and row["bars"] and row["bars"][-1][0] == prev \
                        and not (row.get("source") or "").endswith("_unadj") \
                        and _settle_ok(row["bars"], item, offset=0):
                    incremental.append((item, row))
                else:
                    full.append(item)

            if limit and limit > 0:
                incremental = incremental[:limit]
                full = full[:max(0, limit - len(incremental))]

            log.info("趋势扫描 %s：全市场 %d，复用 %d，增量 %d，全量 %d，预筛跳过 %d，停牌 %d",
                     latest, len(items), len(reuse), len(incremental), len(full),
                     prefiltered, suspended)

            fetched: dict[str, dict] = {}
            failed_items: list[tuple[dict, str]] = []
            tasks = [("inc", x) for x in incremental] + [("full", x) for x in full]
            done = 0

            def one(kind: str, payload):
                item = payload[0] if kind == "inc" else payload
                try:
                    if kind == "inc":
                        bars, src = _fetch_incremental(item, payload[1], latest, prev)
                    else:
                        bars, src = _fetch_full(item, latest, prev)
                    return item, bars, src, ""
                except Exception as e:
                    return item, None, "", str(e)[:300]

            if tasks:
                with ThreadPoolExecutor(max_workers=max(1, int(workers))) as ex:
                    futs = [ex.submit(one, k, p) for k, p in tasks]
                    for f in as_completed(futs):
                        done += 1
                        item, bars, src, err = f.result()
                        if err:
                            failed_items.append((item, err))
                        else:
                            fetched[item["code"]] = {"bars": bars, "source": src}
                        if done % 100 == 0 or done == len(tasks):
                            log.info("  进度 %d/%d，成功 %d，失败 %d，用时 %.0fs",
                                     done, len(tasks), len(fetched), len(failed_items),
                                     time.time() - started)

            # 失败任务再补扫一次（临时 DNS/限流很常见；复权校验失败重试通常也没用，但只多一轮）
            if failed_items:
                retry = [x[0] for x in failed_items]
                log.info("补扫 %d 只失败股…", len(retry))
                time.sleep(1.0)
                retry_failed: list[tuple[dict, str]] = []
                with ThreadPoolExecutor(max_workers=min(3, max(1, len(retry)))) as ex:
                    futs = {ex.submit(_fetch_full, x, latest, prev): x for x in retry}
                    for f in as_completed(futs):
                        x = futs[f]
                        try:
                            bars, src = f.result()
                            fetched[x["code"]] = {"bars": bars, "source": src}
                        except Exception as e:
                            retry_failed.append((x, str(e)[:300]))
                failed_items = retry_failed

            failed = [{"code": x["code"], "name": x["name"], "error": err}
                      for x, err in failed_items]

            # 新浪不复权只是最后兜底：对这类结果再用前复权源补一次，
            # 避免除权缺口把 MA20/MA60 算歪。
            unadj_items = [x for x in items
                           if fetched.get(x["code"], {}).get("source") in ("sina_unadj", "tx_unadj")
                           or reuse.get(x["code"], {}).get("source") in ("sina_unadj", "tx_unadj")]
            if unadj_items:
                log.info("前复权补扫 %d 只不复权兜底股…", len(unadj_items))
                with ThreadPoolExecutor(max_workers=min(3, len(unadj_items))) as ex:
                    futs = {ex.submit(_fetch_qfq_only, x, latest, prev): x for x in unadj_items}
                    for f in as_completed(futs):
                        x = futs[f]
                        try:
                            bars, src = f.result()
                            fetched[x["code"]] = {"bars": bars, "source": src}
                        except Exception:
                            pass

            _save_cache(c, fetched, latest)
            fresh: dict[str, dict] = {}
            for code, row in reuse.items():
                fresh[code] = row
            for code, row in fetched.items():
                fresh[code] = row

            hits: list[dict] = []
            stages: dict = {}
            for item in items:
                row = fresh.get(item["code"])
                if not row or not row.get("bars") or row["bars"][-1][0] != latest:
                    continue
                m = check(row["bars"], min_streak=min_streak, stages=stages)
                if not m:
                    continue
                hits.append({
                    "code": item["code"],
                    "name": item["name"],
                    "source": row.get("source") or "",
                    **m,
                })
            hits.sort(key=lambda x: (-x["streak"], -x["pct"], x["code"]))
            prev_days = _prev_list_days(prev)
            for h in hits:
                h["on_list_days"] = prev_days.get(h["code"], 0) + 1
                h["is_new"] = h["on_list_days"] == 1
            try:
                _enrich_hits(hits, {x["code"]: x for x in items})
            except Exception as e:
                log.warning("趋势结果补充 PE/流通值/板块失败：%s", e)

            unadjusted = sum(1 for x in hits if x["source"] in ("sina_unadj", "tx_unadj"))
            # 覆盖校验：每只股票必须有归属——深扫 / 预筛跳过 / 停牌 / 失败。
            # 加 --limit 调试时只扫一部分，不做这项校验。
            covered = len(fresh) + prefiltered + suspended + len(failed)
            coverage_ok = bool(limit > 0) or covered == len(items)
            if not coverage_ok:
                log.warning("覆盖数异常：已核对 %d，股票池 %d，预筛 %d，停牌 %d，深扫 %d，失败 %d",
                            covered, len(items), prefiltered, suspended, len(fresh), len(failed))
            out = {
                "ok": True,
                "available": True,
                "asset": MODE,
                "date": latest,
                "prev_date": prev,
                "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
                "elapsed_sec": round(time.time() - started, 1),
                "params": _scan_params(min_streak),
                "universe": len(items),
                "covered": covered,
                "coverage_ok": coverage_ok,
                "evaluated": len(fresh),
                "passed": len(hits),
                "prefiltered": prefiltered,
                "suspended": suspended,
                "reused": len(reuse),
                "fetched": len(fetched),
                "failed": len(failed),
                "failed_codes": failed[:200],
                "unadjusted": unadjusted,
                "intraday": bool(intraday),
                "universe_source": universe_src,
                "funnel": {"universe": len(items), "evaluated": int(stages.get("bars_ok", 0)),
                           "above_ma20": int(stages.get("above_ma20", 0)),
                           "ma20_up": int(stages.get("ma20_up", 0)),
                           "bull": int(stages.get("bull", 0)),
                           "streak": int(stages.get("streak", 0)),
                           "passed": len(hits)},
                "items": hits,
            }
            _atomic_json(LATEST_PATH, out)
            HISTORY_DIR.mkdir(parents=True, exist_ok=True)
            _atomic_json(HISTORY_DIR / f"{latest}.json", out)
            log.info("趋势扫描完成：命中 %d / 深扫 %d / 全市场 %d，失败 %d，用时 %.1fs",
                     len(hits), len(fresh), len(items), len(failed),
                     time.time() - started)
            return out
        finally:
            c.close()
    finally:
        try:
            fcntl.flock(lock, fcntl.LOCK_UN)
        finally:
            lock.close()


def backfill(days: int = 10, min_streak: int = DEFAULT_MIN_STREAK) -> list[str]:
    """用现有前复权日线回算最近 N 个交易日，补齐 history 供日期条切换。

    只回算 K 线字段（连涨/MA/价格/逐日涨幅），PE/量比/换手/板块不回填——
    历史基本面拿不到，返回后前端会标“历史回算”。
    """
    days = max(1, min(int(days), 30))
    latest, prev = _trade_dates()
    all_dates = _sina_index_dates(days + 8)
    past = [d for d in all_dates if d < latest][-days:]
    if not past:
        return []
    lock = _acquire_lock()
    try:
        c = _db()
        try:
            items, _ = _load_universe(latest, force=False)
            cache = _load_cache(c)
        finally:
            c.close()
        by_code = {x["code"]: x for x in items}
        prev_hits: dict[str, int] = {}
        written: list[str] = []
        for day in past:
            path = HISTORY_DIR / f"{day}.json"
            if path.exists():
                try:
                    old = json.loads(path.read_text(encoding="utf-8"))
                    prev_hits = {str(x.get("code")): int(x.get("on_list_days") or 1)
                                 for x in old.get("items") or [] if x.get("code")}
                except Exception:
                    prev_hits = {}
                continue
            hits = []
            evaluated = suspended = 0
            stages: dict = {}
            for code, item in by_code.items():
                row = cache.get(code)
                if not row or not row.get("bars"):
                    suspended += 1
                    continue
                bars = [(d, v) for d, v in row["bars"] if d <= day]
                if not bars or bars[-1][0] != day:
                    suspended += 1
                    continue
                evaluated += 1
                m = check(bars, min_streak=min_streak, stages=stages)
                if not m:
                    continue
                hits.append({
                    "code": code,
                    "name": item["name"],
                    "source": row.get("source") or "",
                    **m,
                })
            hits.sort(key=lambda x: (-x["streak"], -x["pct"], x["code"]))
            for h in hits:
                h["on_list_days"] = prev_hits.get(h["code"], 0) + 1
                h["is_new"] = h["on_list_days"] == 1
            prev_hits = {h["code"]: h["on_list_days"] for h in hits}
            idx = all_dates.index(day)
            out = {
                "ok": True,
                "available": True,
                "asset": MODE,
                "date": day,
                "prev_date": all_dates[idx - 1] if idx > 0 else "",
                "generated_at": datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S"),
                "elapsed_sec": 0,
                "params": _scan_params(min_streak),
                "universe": len(items),
                "covered": evaluated + suspended,
                "coverage_ok": evaluated + suspended == len(items),
                "evaluated": evaluated,
                "passed": len(hits),
                "prefiltered": 0,
                "suspended": suspended,
                "reused": 0,
                "fetched": 0,
                "failed": 0,
                "failed_codes": [],
                "unadjusted": sum(1 for h in hits if h["source"] in ("sina_unadj", "tx_unadj")),
                "intraday": False,
                "universe_source": "cache",
                "backfilled": True,
                "enriched": False,
                "items": hits,
            }
            _atomic_json(path, out)
            written.append(day)
            log.info("回算 %s：命中 %d / 有K线 %d / 全市场 %d",
                     day, len(hits), evaluated, len(items))
        if written:
            prev_map = _prev_list_days(prev)
            if prev_map:
                for path in (LATEST_PATH, HISTORY_DIR / f"{latest}.json"):
                    try:
                        d = json.loads(path.read_text(encoding="utf-8"))
                        for h in d.get("items") or []:
                            h["on_list_days"] = prev_map.get(h["code"], 0) + 1
                            h["is_new"] = h["on_list_days"] == 1
                        _atomic_json(path, d)
                    except Exception:
                        pass
        return written
    finally:
        try:
            fcntl.flock(lock, fcntl.LOCK_UN)
        finally:
            lock.close()


def available_dates(limit: int = 30) -> list[str]:
    """历史结果日期，新的在前；日期条用。"""
    try:
        names = [p.stem for p in HISTORY_DIR.glob("*.json")]
    except OSError:
        return []
    dates = [x for x in names if re.match(r"^\d{4}-\d{2}-\d{2}$", x)]
    return sorted(dates, reverse=True)[:max(1, int(limit))]


def latest(date: str | None = None) -> dict:
    """读最新结果或指定日期的历史结果；date=None 走 latest.json。"""
    dates = available_dates(5)
    if date:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            return {"ok": False, "available": False, "error": "日期格式应为 YYYY-MM-DD",
                    "dates": dates}
        path = HISTORY_DIR / f"{date}.json"
    else:
        path = LATEST_PATH
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        d["available"] = True
        d["dates"] = dates
        d["is_history"] = bool(date)
        if date:
            d["stale"] = False
        else:
            now = datetime.now(BJ)
            today = now.strftime("%Y-%m-%d")
            # 交易日 15:30 后还拿着上一交易日的文件，说明今天这班没跑成。
            d["stale"] = bool(quotes.is_trading_day(today) and d.get("date") != today
                              and now.hour * 60 + now.minute >= 15 * 60 + 30)
        return d
    except Exception:
        if date:
            return {"ok": False, "available": False, "error": f"没有 {date} 的扫描结果",
                    "hint": "日期条里只显示已保存的扫描日", "dates": dates}
        return {
            "ok": False,
            "available": False,
            "error": "还没有趋势扫描结果",
            "hint": "每天 15:30 收盘后自动扫描；也可手动运行 scripts/trend_scan.py",
            "dates": dates,
        }


def _print_result(d: dict, limit: int = 30) -> None:
    label = "沪深ETF趋势" if d.get("asset", MODE) == "etf" else "沪深主板趋势选股"
    print(f"{label} · {d.get('date')} · 生成 {d.get('generated_at')}")
    print(f"命中 {d.get('passed')} / 深扫 {d.get('evaluated')} / 全市场 {d.get('universe')}"
          f"（预筛跳过 {d.get('prefiltered')}，停牌 {d.get('suspended')}，失败 {d.get('failed')}）")
    if d.get("failed"):
        print("失败代码：" + ", ".join(x.get("code", "?") for x in (d.get("failed_codes") or [])[:50]))
    print("-" * 72)
    for i, x in enumerate((d.get("items") or [])[:limit], 1):
        flag = " 次新" if x.get("new_stock") else ""
        print(f"{i:>2}. {x['code']} {x['name']}  连涨{x['streak']}天  "
              f"{x['pct']:+.2f}%  收{x['price']}  距MA20 {x['dist_ma20']:+.2f}%  "
              f"MA20五日 {x['ma20_slope']:+.2f}%{flag}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="趋势选ETF（沪深ETF）" if MODE == "etf" else "全市场趋势选股（沪深主板）")
    p.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    p.add_argument("--limit", type=int, default=0, help="只深扫前 N 只候选（调试）")
    p.add_argument("--force", action="store_true", help="忽略当日 K 线缓存，全部重抓")
    p.add_argument("--all", action="store_true", help="不做涨幅预筛，扫描全部沪深主板")
    p.add_argument("--min-streak", type=int, default=DEFAULT_MIN_STREAK)
    p.add_argument("--intraday", action="store_true", help="允许盘中运行（结果仅供参考）")
    p.add_argument("--allow-stale", action="store_true", help="允许指数未更新到今天时运行")
    p.add_argument("--backfill", nargs="?", const=10, type=int, default=None,
                   help="用现有日线回算最近 N 个交易日（默认 10），补齐日期条")
    p.add_argument("--print", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if args.backfill is not None:
        try:
            days = backfill(args.backfill)
        except Exception as e:
            log.error("趋势回算失败：%s", e)
            return 1
        print(f"回算完成：{'、'.join(days) if days else '没有需要补的日期'}")
        return 0
    try:
        d = scan(workers=args.workers, limit=args.limit, force=args.force,
                 min_streak=args.min_streak, all_mode=args.all,
                 intraday=args.intraday, allow_stale=args.allow_stale)
    except Exception as e:
        log.error("趋势扫描失败：%s", e)
        return 1
    if args.print:
        _print_result(d)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
