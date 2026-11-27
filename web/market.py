"""市场行情：A股指数 + 涨跌家数 + 美股/日经/韩国 + 黄金/原油/沪铜。

- A股指数与商品：腾讯 qt.gtimg.cn / 新浪 hq.sinajs.cn
- 涨跌家数：新浪 hs_a 全量分页（并发），缓存 5 分钟
- 全球指数 / 沪铜：东方财富 push2（带行情源时间；新浪 int_* 已停止更新，不再使用）
- 韩国 KOSPI：东方财富，Naver polling 兜底
"""
from __future__ import annotations

import re
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import requests

import quotes
import store

log = logging.getLogger("stock-site")

TENCENT_HQ = "https://qt.gtimg.cn/q="
SINA_FUT_K = ("https://stock2.finance.sina.com.cn/futures/api/jsonp.php/"
              "var%20_x=/InnerFuturesNewService.getDailyKLine?symbol=")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
SINA_HQ = "https://hq.sinajs.cn/list="
SINA_NODE = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData"
SINA_COUNT = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a"
NAVER_KOSPI = "https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI"
SINA_HEAD = {"User-Agent": UA, "Referer": "https://finance.sina.com.cn/"}
EM_LIST = "http://push2.eastmoney.com/api/qt/ulist.np/get"  # 该网 python 走 https 会被断连，http 正常
EM_QUOTE = "http://push2.eastmoney.com/api/qt/stock/get"
EM_HEAD = {"User-Agent": UA}
# 东财 secid：全球指数用 100.*（只留纳指100、日经、韩综）
# 全球指数：东财 push2 在这台服务器 IP 被断连（且要重试 3 次、白等 8 秒），
# 改用腾讯美股/港股指数（实测可用）+ Naver KOSPI，都是 getName/price/pct 齐全的源。
# (腾讯代码, 展示名, 内部 code)
GLOBAL_TENCENT = [
    ("usNDX", "纳指100", "100.NDX100"),
    ("usINX", "标普500", "100.SPX"),
    ("usDJI", "道琼斯", "100.DJIA"),
    ("hkHSI", "恒生指数", "100.HSI"),
]
GLOBAL_EXTRA = [("100.KS11", "韩国KOSPI")]      # 由 Naver 兜底补
GLOBAL_ORDER = [(c, n) for _, n, c in GLOBAL_TENCENT] + GLOBAL_EXTRA

# 商品分四张卡片；hf_* 是外盘，nf_* 是国内期货连续合约（新浪）
COMMODITY_GROUPS = [
    ("金属", [("hf_GC", "COMEX黄金", "hf"), ("nf_AU0", "沪金", "nf"),
              ("nf_CU0", "沪铜", "nf"), ("nf_AL0", "沪铝", "nf")]),
    ("油气", [("hf_CL", "WTI原油", "hf"), ("hf_OIL", "布伦特", "hf"),
              ("hf_NG", "美国天然气", "hf"), ("nf_SC0", "上海原油", "nf")]),
    ("农产品", [("nf_M0", "豆粕", "nf"), ("nf_C0", "玉米", "nf"),
               ("nf_SR0", "白糖", "nf"), ("nf_P0", "棕榈油", "nf")]),
    ("资源", [("nf_JM0", "焦煤", "nf"), ("nf_SA0", "纯碱", "nf"),
              ("nf_I0", "铁矿石", "nf"), ("nf_RB0", "螺纹钢", "nf")]),
]
COMMODITY_CODES = [c for _, items in COMMODITY_GROUPS for c, _, _ in items]

# 涨跌家数：成功结果缓存 5 分钟；抓取失败不覆盖上次成功值，失败后 60 秒内不重复抓
_breadth = {"ts": 0.0, "data": None, "fail_ts": 0.0, "fail": ""}
_breadth_lock = threading.Lock()
BREADTH_TTL = 300
BREADTH_RETRY = 60
# 外盘/商品变化慢，60 秒缓存；手动 ↻ 会带 force 绕过，避免每次打开行情页都打上游
EXTRA_TTL = 60
_global_cache = {"ts": 0.0, "data": None}
_commodity_cache = {"ts": 0.0, "data": None}
# 复用线程池：行情页 3s 一刷，不必每次 new 一组线程
_market_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="market")
_breadth_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="breadth")


def _hms(ts: float | None) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, quotes.BJ).strftime("%H:%M:%S")


def _quote_dt(raw) -> datetime | None:
    """解析行情源时间：腾讯 20261026100830 / 新浪 2026-10-26 10:08:30 / Naver ISO。"""
    s = str(raw or "").strip()
    if not s:
        return None
    if "T" in s:
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=quotes.BJ)
        return dt.astimezone(quotes.BJ).replace(tzinfo=None)
    for fmt in ("%Y%m%d%H%M%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _quote_dt_text(dt: datetime | None) -> str:
    """今天的行情只显示时分秒；隔夜/休市带上月日，避免看成刚刚更新。"""
    if dt is None:
        return ""
    if dt.date() == datetime.now(quotes.BJ).date():
        return dt.strftime("%H:%M:%S")
    return dt.strftime("%m-%d %H:%M")


def _quote_text(raw) -> str:
    return _quote_dt_text(_quote_dt(raw))


def _quote_epoch(raw) -> int:
    """行情源时间 → 北京时间戳（秒），用于比较哪块数据最新。"""
    dt = _quote_dt(raw)
    if dt is None:
        return 0
    return int(dt.replace(tzinfo=quotes.BJ).timestamp())


def _epoch_text(ts) -> str:
    try:
        sec = int(ts)
    except (TypeError, ValueError):
        return ""
    if sec <= 0:
        return ""
    try:
        return _quote_dt_text(datetime.fromtimestamp(sec, quotes.BJ))
    except (OverflowError, OSError, ValueError):
        return ""


def _fill_cached(out: list[dict], hit: list[dict] | None) -> list[dict]:
    """本次没抓到的条目沿用上次成功值（标延迟），避免局部失败把整块清空。"""
    have = {x.get("code") for x in out}
    for old in hit or []:
        if old.get("code") not in have:
            out.append(dict(old, stale=True))
    return out


def _sina(codes: list[str]) -> dict[str, list[str]]:
    try:
        r = requests.get(SINA_HQ + ",".join(codes), headers=SINA_HEAD, timeout=8)
        text = r.content.decode("gbk", errors="ignore")
    except Exception:
        return {}
    out = {}
    for line in text.splitlines():
        if '="' not in line:
            continue
        key = line.split("=", 1)[0].replace("var hq_str_", "").strip()
        body = line.split('="', 1)[1].rstrip('";')
        out[key] = body.split(",") if body else []
    return out


def _f(v: str) -> float:
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def indices_a() -> list[dict]:
    q = quotes.fetch([c for c, _ in quotes.INDICES])
    out = []
    for code, label in quotes.INDICES:
        d = q.get(code[2:]) or {}
        out.append({
            "code": code, "name": label,
            "price": d.get("price") or 0, "pct": round(d.get("pct") or 0, 2),
            "chg": d.get("change") or 0, "amount": d.get("amount") or 0,
            "stale": bool(d.get("stale")), "source": d.get("source", ""),
            "time": _quote_text(d.get("time")), "ts": _quote_epoch(d.get("time")),
        })
    return out


GLOBAL_MK_URL = "https://qt.gtimg.cn/q=hkHSI,hkHSCEI,hkHSTECH,usDJI,usIXIC,usINX"
GLOBAL_MK_CODES = [("hkHSI", "恒生指数"), ("hkHSCEI", "国企指数"), ("hkHSTECH", "恒生科技"),
                   ("usDJI", "道琼斯"), ("usIXIC", "纳斯达克"), ("usINX", "标普500")]
_global_mk_cache: dict = {"ts": 0.0, "data": None}


def global_markets(force: bool = False) -> dict:
    """港股三指数 + 美股三指数（腾讯 hk/us 报价，60 秒缓存）。

    行情页「跨市场」用；只取指数，不碰个股，避免把页面拖慢。
    """
    now = time.time()
    if not force and _global_mk_cache["data"] and now - _global_mk_cache["ts"] < 60:
        return dict(_global_mk_cache["data"], cached=True)
    out = {"hk": [], "us": [], "at": ""}
    try:
        r = requests.get(GLOBAL_MK_URL, headers={"User-Agent": UA, "Referer": "https://gu.qq.com/"}, timeout=8)
        r.encoding = "gbk"
        for line in (r.text or "").split(";"):
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            code = key.replace("v_", "").strip()
            f = val.strip().strip('"').split("~")
            label = dict(GLOBAL_MK_CODES).get(code)
            if not label or len(f) < 6:
                continue
            try:
                price = float(f[3] or 0)
                prev = float(f[4] or 0)
                pct = float(f[32]) if len(f) > 32 and f[32] else (round((price / prev - 1) * 100, 2) if prev else 0.0)
            except ValueError:
                continue
            if price <= 0:
                continue
            item = {"code": code, "name": label, "price": price, "pct": round(pct, 2), "time": (f[30] if len(f) > 30 else "")}
            out["hk" if code.startswith("hk") else "us"].append(item)
            if f[30] if len(f) > 30 else "":
                out["at"] = f[30][-8:]
    except Exception as e:  # 上游抖动：返回旧缓存
        log.warning("global_markets failed: %s", e)
        if _global_mk_cache["data"]:
            return dict(_global_mk_cache["data"], cached=True)
        return out
    _global_mk_cache["ts"], _global_mk_cache["data"] = time.time(), out
    return out


def _global_fallback() -> list[dict]:
    """备用源：Naver KOSPI（唯一在该服务器 IP 稳定可用的补充源）。

    新浪 gb_*/b_* 在这台机器上被 403，东财 push2 全系断连，所以这里只留 Naver；
    别的指数缺了就用上次缓存（_fill_cached），不再做无意义的 8 秒重试。
    """
    out = []
    try:
        r = requests.get(NAVER_KOSPI, headers={"User-Agent": UA, "Referer": "https://finance.naver.com/"},
                         timeout=8)
        d = (r.json().get("datas") or [{}])[0]
        price = _f(d.get("closePrice"))
        if price:
            out.append({"code": "100.KS11", "name": "韩国KOSPI", "price": price,
                        "chg": _f(d.get("compareToPreviousClosePrice")),
                        "pct": round(_f(d.get("fluctuationsRatio")), 2),
                        "stale": True, "source": "naver",
                        "time": _quote_text(d.get("localTradedAt")),
                        "ts": _quote_epoch(d.get("localTradedAt"))})
    except Exception:
        pass
    return out


def _tencent_tilde(codes: list[str]) -> dict[str, list[str]]:
    """腾讯指数行情，返回按 ~ 分隔的字段表：[1]=名称 [3]=现价 [30]=时间 [31]=涨跌 [32]=涨跌幅%。"""
    if not codes:
        return {}
    try:
        r = requests.get(TENCENT_HQ + ",".join(codes), headers={"User-Agent": UA}, timeout=8)
        text = r.content.decode("gbk", errors="ignore")
    except Exception as e:
        log.warning("腾讯指数行情失败：%s", e)
        return {}
    out = {}
    for line in text.splitlines():
        if '="' not in line:
            continue
        key = line.split("=", 1)[0].replace("v_", "").strip()
        body = line.split('="', 1)[1].rstrip('";')
        out[key] = body.split("~")
    return out


def global_indices(force: bool = False) -> list[dict]:
    """全球指数：腾讯（纳指100/标普500/道琼斯/恒生）+ Naver（KOSPI），失败沿用上次缓存。"""
    now = time.time()
    hit = _global_cache["data"]
    if not force and hit is not None and now - _global_cache["ts"] < EXTRA_TTL:
        return [dict(x) for x in hit]

    out = []
    rows = _tencent_tilde([c for c, _, _ in GLOBAL_TENCENT])
    for tcode, label, code in GLOBAL_TENCENT:
        f = rows.get(tcode) or []
        price = _f(f[3]) if len(f) > 3 else 0
        if not price:
            continue
        raw = (f[30] or "") if len(f) > 30 else ""
        out.append({"code": code, "name": label, "price": price,
                    "chg": _f(f[31]) if len(f) > 31 else 0,
                    "pct": round(_f(f[32]) if len(f) > 32 else 0, 2),
                    "stale": False, "source": "tencent",
                    "time": _quote_text(raw), "ts": _quote_epoch(raw)})

    # 缺的（KOSPI 等）用 Naver/备用源补，补不到就沿用上次缓存
    have = {x["code"] for x in out}
    extra = [x for x in _global_fallback() if x.get("code") not in have]
    out += extra
    out = _fill_cached(out, hit)

    order = {code: i for i, (code, _) in enumerate(GLOBAL_ORDER)}
    out = [x for x in out if x.get("code") in order]
    out.sort(key=lambda x: order.get(x.get("code"), len(order)))
    if out:
        _global_cache.update(ts=time.time(), data=[dict(x) for x in out])
    return out


def _tencent(codes: list[str]) -> dict[str, list[str]]:
    """腾讯外盘行情：v_hf_CL="价,涨跌幅%,买,卖,高,低,时间,昨收,开,……,日期,名称"。"""
    if not codes:
        return {}
    try:
        r = requests.get(TENCENT_HQ + ",".join(codes), headers={"User-Agent": UA}, timeout=8)
        text = r.content.decode("gbk", errors="ignore")
    except Exception as e:
        log.warning("腾讯商品行情失败：%s", e)
        return {}
    out = {}
    for line in text.splitlines():
        if '="' not in line:
            continue
        key = line.split("=", 1)[0].replace("v_", "").strip()
        body = line.split('="', 1)[1].rstrip('";')
        out[key] = body.split(",") if body else []
    return out


def _hf_item(code: str, label: str, rows: dict[str, list[str]]) -> dict | None:
    f = rows.get(code) or []
    if len(f) < 8 or not _f(f[0]):
        return None
    price = _f(f[0])
    pct = round(_f(f[1]), 2)                      # 腾讯直接给涨跌幅百分比
    raw = f"{f[12]} {f[6]}".strip() if len(f) > 12 else ""
    name = (f[13] or label) if len(f) > 13 and f[13] else label
    return {"code": code, "name": name, "price": price, "pct": pct, "unit": "",
            "stale": False, "time": _quote_text(raw), "ts": _quote_epoch(raw)}


def _nf_item(code: str, label: str) -> dict | None:
    """国内期货：新浪日线（收盘/最新）最后两根，用前一日收盘算涨跌幅。"""
    sym = code[3:] if code.startswith("nf_") else code
    try:
        r = requests.get(SINA_FUT_K + sym, headers=SINA_HEAD, timeout=8)
        text = r.text
        i, j = text.find("(["), text.rfind("])")
        if i < 0 or j < 0:
            return None
        rows = json.loads(text[i + 1:j + 1])
    except Exception as e:
        log.warning("新浪期货日线失败 %s：%s", sym, e)
        return None
    if not rows:
        return None
    last = rows[-1]
    price = _f(last.get("c"))
    if not price:
        return None
    prev = _f(rows[-2].get("c")) if len(rows) > 1 else _f(last.get("s"))
    pct = round((price / prev - 1) * 100, 2) if prev else 0.0
    day = str(last.get("d") or "")
    return {"code": code, "name": label, "price": price, "pct": pct, "unit": "",
            "stale": False, "time": _quote_text(day), "ts": _quote_epoch(day)}


def commodities(force: bool = False) -> list[dict]:
    """商品按 金属 / 油气 / 农产品 / 资源 分四张卡片。

    外盘走腾讯 qt.gtimg.cn（hf_*），国内期货走新浪财经日线（nf_*）；
    这两个源在本机网络下可达，原 hq.sinajs.cn 已被封 403。
    """
    now = time.time()
    hit = _commodity_cache["data"]
    if not force and hit is not None and now - _commodity_cache["ts"] < EXTRA_TTL:
        return [{"name": g["name"], "items": [dict(x) for x in g["items"]]} for g in hit]
    all_items = [it for _, items in COMMODITY_GROUPS for it in items]
    hf_codes = [c for c, _, k in all_items if k == "hf"]
    nf_items = [x for x in _market_pool.map(lambda t: _nf_item(t[0], t[1]),
                                            [(c, l) for c, l, k in all_items if k == "nf"]) if x]
    hf_rows = _tencent(hf_codes)
    hf_items = {x["code"]: x for x in (_hf_item(c, l, hf_rows) for c, l, k in all_items if k == "hf") if x}
    by_code = dict(hf_items)
    by_code.update({x["code"]: x for x in nf_items})

    groups = []
    for gname, items in COMMODITY_GROUPS:
        got = [by_code[c] for c, _, _ in items if c in by_code]
        if got:
            groups.append({"name": gname, "items": got})
    if groups:  # 部分抓不到时沿用上次的同组数据（标延迟）
        old = {g.get("name"): g for g in (hit or [])}
        for g in groups:
            prev = old.get(g["name"]) or {}
            have = {x["code"] for x in g["items"]}
            g["items"] += [dict(x, stale=True) for x in prev.get("items", []) if x.get("code") not in have]
        groups.sort(key=lambda g: [n for n, _ in COMMODITY_GROUPS].index(g["name"]))
        _commodity_cache.update(ts=time.time(), data=[{"name": g["name"], "items": [dict(x) for x in g["items"]]} for g in groups])
        return groups
    if hit is not None:
        return [{"name": g["name"], "items": [dict(x, stale=True) for x in g["items"]]} for g in hit]
    return []

def _breadth_page(page: int, timeout: float = 10) -> list[dict] | None:
    try:
        r = requests.get(SINA_NODE, params={"page": page, "num": 100, "sort": "symbol", "asc": 1,
                                            "node": "hs_a", "symbol": "", "_s_r_a": "page"},
                         headers=SINA_HEAD, timeout=timeout)
        return r.json() or []
    except Exception:
        return None


def _breadth_failure(msg: str, now: float) -> dict:
    """抓取失败：保留上次成功值并标记 stale，60 秒内不重复抓 50+ 页。"""
    _breadth["fail_ts"] = now
    _breadth["fail"] = msg
    if _breadth["data"]:
        return dict(_breadth["data"], cached=True, stale=True, error=msg)
    return {"up": 0, "down": 0, "flat": 0, "total": 0, "at": "",
            "stale": True, "error": msg, "ttl": BREADTH_TTL}


def breadth(force: bool = False) -> dict:
    now = time.time()
    with _breadth_lock:
        if not force:
            if _breadth["data"] and now - _breadth["ts"] < BREADTH_TTL:
                return dict(_breadth["data"], cached=True)
            if _breadth["fail"] and now - _breadth["fail_ts"] < BREADTH_RETRY:
                return _breadth_failure(_breadth["fail"], _breadth["fail_ts"])

        err = ""
        total = 0
        for attempt in range(2):
            try:
                total = int(requests.get(SINA_COUNT, headers=SINA_HEAD, timeout=4).json())
                break
            except Exception as e:
                err = f"涨跌家数数量接口失败：{e}"
                if attempt == 0:
                    time.sleep(0.3)
        if total <= 0 and _breadth["data"]:
            total = int(_breadth["data"].get("total") or 0)  # 计数接口偶发超时，沿用上次总数
        pages = (total + 99) // 100 if total else 0
        page_rows: list[list[dict] | None] = []
        if pages:
            page_rows = list(_breadth_pool.map(_breadth_page, range(1, pages + 1)))
            # 单页偶发超时/限流：补抓一轮，避免一片失败就把整块涨跌家数作废
            missing = [i + 1 for i, rows in enumerate(page_rows) if not rows]
            for page in missing:
                page_rows[page - 1] = _breadth_page(page, timeout=6)
        up = down = flat = 0
        failed = 0
        for rows in page_rows:
            if not rows:
                failed += 1
                continue
            for x in rows:
                try:
                    p = float(x.get("changepercent") or 0)
                except (TypeError, ValueError):
                    continue
                if p > 0:
                    up += 1
                elif p < 0:
                    down += 1
                else:
                    flat += 1
        counted = up + down + flat
        if total <= 0 or failed or counted < total * 0.9:
            msg = err or f"涨跌家数抓取不完整（{counted}/{total}，失败页 {failed}）"
            return _breadth_failure(msg, now)
        data = {"up": up, "down": down, "flat": flat, "total": counted,
                "at": datetime.now(quotes.BJ).strftime("%H:%M"), "stale": False,
                "ttl": BREADTH_TTL, "source": "sina"}
        _breadth.update(ts=time.time(), data=data, fail="", fail_ts=0.0)
        return data


def _fmt_yi(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v/1e4:.2f} 万亿" if v >= 1e4 else f"{v:.0f} 亿"


def _turnover_hist() -> dict:
    """最近若干交易日的两市成交额（亿元），存 meta，避免每次都依赖第三方历史接口。"""
    try:
        h = json.loads(store.get_meta("turnover_hist", "{}") or "{}")
        return h if isinstance(h, dict) else {}
    except Exception:
        return {}


def _save_turnover(total: float, day: str) -> None:
    if not total or not day:
        return
    h = _turnover_hist()
    if h.get(day) == round(total):
        return
    h[day] = round(total)
    for k in sorted(h)[:-40]:
        h.pop(k, None)
    try:
        store.set_meta("turnover_hist", json.dumps(h, ensure_ascii=False))
    except Exception as e:
        log.warning("昨日成交额写入失败: %s", e)


def _prev_turnover(before_day: str = "") -> tuple[float | None, str]:
    """沪深两市上一个交易日的成交额（亿元）。

    顺序：本地 meta 历史（每天收盘自动累积，最可靠）→ 东财日 K 的 f57（单位元）
    → 报告正文里的口径。原来只靠东财日 K，“从正文抠数字”又只认「昨日约 X 万亿」，
    措辞一变就永远显示“暂无”。
    """
    today = before_day or datetime.now(quotes.BJ).strftime("%Y-%m-%d")
    hist = _turnover_hist()
    past = {k: v for k, v in hist.items() if k < today}
    if past:
        day = max(past)
        try:
            return float(past[day]), day
        except Exception:
            pass
    dates, total = [], 0.0
    for secid in ("1.000001", "0.399001"):
        try:
            r = requests.get("http://push2his.eastmoney.com/api/qt/stock/kline/get", params={
                "secid": secid, "fields1": "f1,f2,f3",
                "fields2": "f51,f52,f53,f54,f55,f56,f57",
                "klt": 101, "fqt": 1, "end": "20500101", "lmt": 4,
            }, headers={"User-Agent": UA}, timeout=8)
            rows = ((r.json() or {}).get("data") or {}).get("klines") or []
            if len(rows) < 2:
                return None, ""
            p = rows[-2].split(",")   # 倒数第二根＝上一交易日（最后一根是今天/最新）
            dates.append(p[0])
            total += float(p[6])
        except Exception as e:
            log.warning("昨日成交额取数失败 %s: %s", secid, e)
            return None, ""
    if not dates:
        return None, ""
    return round(total / 1e8, 0), min(dates)


def turnover() -> dict:
    """两市成交额（沪+深）：今日实时 + 昨日对比。"""
    a = indices_a()
    total = round(((a[0]["amount"] or 0) + (a[1]["amount"] or 0)) / 1e4, 0) if len(a) >= 2 else 0
    # 收盘后把当日成交额记进本地历史，次日直接读，不再依赖第三方历史接口
    try:
        now = datetime.now(quotes.BJ)
        key_day = ""
        if now.weekday() < 5 and (now.hour > 15 or (now.hour == 15 and now.minute >= 5)):
            key_day = now.strftime("%Y-%m-%d")            # 当天收盘后
        elif now.hour < 8:                                 # 凌晨看到的还是上一交易日收盘数据
            prev = now - timedelta(days=1)
            while prev.weekday() >= 5:
                prev -= timedelta(days=1)
            key_day = prev.strftime("%Y-%m-%d")
        if total and key_day:
            _save_turnover(total, key_day)
    except Exception:
        pass
    prev, src_day = _prev_turnover(key_day or datetime.now(quotes.BJ).strftime("%Y-%m-%d"))
    if not prev:   # 日 K / 本地历史都取不到时退回报告正文里的昨日口径
        try:
            for r in store.list_reports("post", 3):
                c = (store.get_report(r["id"]) or {}).get("content") or ""
                m = re.search(r"(?:昨日约|前一交易日)\s*\**\s*([\d.]+)\s*万亿", c)
                if m:
                    prev = round(float(m.group(1)) * 1e4, 0)
                    src_day = r["day"]
                    break
                m = re.search(r"较昨日\s*\**\s*([放缩])量\s*\**\s*([\d.]+)\s*亿", c)
                if m and total:
                    d = float(m.group(2)) * (1 if m.group(1) == "放" else -1)
                    prev = round(total - d, 0)
                    src_day = r["day"]
                    break
        except Exception:
            pass
    diff = round(total - prev, 0) if prev else None
    pct = round(diff / prev * 100, 1) if prev and diff is not None else None
    return {
        "total": total, "text": _fmt_yi(total),
        "prev": prev, "prev_text": _fmt_yi(prev) if prev else "",
        "prev_day": src_day,
        "diff": diff,
        "diff_text": (("+" if diff >= 0 else "") + f"{diff/1e4:.2f} 万亿") if diff is not None and abs(diff) >= 1e4 else (f"{diff:+.0f} 亿" if diff is not None else ""),
        "pct": pct,
        "tag": ("放量" if diff > 0 else "缩量") if diff is not None else "",
        "intraday": quotes.market_status()["state"] != "closed",
    }


def _latest_text(rows: list[dict]) -> str:
    """取一组行情里最新的数据源时间（不是请求时间）；支持商品分组结构。"""
    stamps = []
    for x in rows or []:
        if "items" in x:
            stamps += [int(i.get("ts") or 0) for i in x.get("items") or [] if i.get("ts")]
        elif x.get("ts"):
            stamps.append(int(x["ts"]))
    return _epoch_text(max(stamps)) if stamps else ""


def all_market(force: bool = False) -> dict:
    a = indices_a()
    # 手动强制刷新时，涨跌家数(50+页)、外盘、商品并行抓，避免串行等 7~8 秒
    fg = _market_pool.submit(global_indices, force)
    fc = _market_pool.submit(commodities, force)
    fb = _market_pool.submit(breadth, force)
    ft = _market_pool.submit(turnover)
    glob, comm, br, t = fg.result(), fc.result(), fb.result(), ft.result()
    flat = [x for g in comm for x in g.get("items") or []]
    return {
        "a": a, "global": glob, "commodity": flat, "commodity_groups": comm,
        "breadth": br, "turnover": t,
        "market": quotes.market_status(),
        # 显示行情源的最后更新时间；抓不到源时间才退回本次请求时间
        "quotes_at": _latest_text(a) or _hms(time.time()),
        "quotes_stale": any(x.get("stale") for x in a),
        "global_at": _latest_text(glob) or _hms(_global_cache["ts"]),
        "global_stale": any(x.get("stale") for x in glob),
        "commodity_at": _latest_text(comm) or _hms(_commodity_cache["ts"]),
        "commodity_stale": any(x.get("stale") for x in flat),
    }
