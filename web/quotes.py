"""行情：腾讯 qt.gtimg.cn 批量快照，服务端短缓存（全站共用，避免被源限流）。

A 股 Level-1 快照约 3 秒一笔，所以前端最快也只值得 3 秒一刷；缓存略短于 3 秒，
保证每一拍都能拿到新快照。并发请求用一把锁做 single-flight，避免同时打上游。
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path

import requests

BJ = timezone(timedelta(hours=8))
# 前端 3s 轮询；缓存 2.5s，避免请求恰好落在 3s 边界时吃到上一拍
CACHE_TTL = 2.5
# 超过 30s 没更新才在界面上标「延迟」
CACHE_STALE_AFTER = 30.0
# 腾讯整体失败后 30 秒内直接用新浪兜底，别每一拍都等满腾讯 6 秒；
# 两个源都失败才整体退避 3 秒，避免空转。
TENCENT_FAIL_BACKOFF = 30.0
FETCH_FAIL_BACKOFF = 3.0
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()          # single-flight：保护缓存 + 上游抓取
_tencent_fail_until = 0.0
_fail_until = 0.0
_last_error = ""
_last_warn = 0.0
log = logging.getLogger("stock-site.quotes")

# 复用连接：3s 一刷时避免每次都重新做 TCP/TLS 握手
_session = requests.Session()
_session.mount("https://", requests.adapters.HTTPAdapter(
    pool_connections=4, pool_maxsize=16, max_retries=0))
_session.mount("http://", requests.adapters.HTTPAdapter(
    pool_connections=4, pool_maxsize=16, max_retries=0))

INDICES = [
    ("sh000001", "上证指数"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
    ("sh000688", "科创50"),
    ("sh000300", "沪深300"),
]

HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.qq.com/"}
SINA_URL = "https://hq.sinajs.cn/list="
SINA_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}


# ---- 场外基金（支付宝里的 ETF 联接 / QDII）净值兜底 ----
# A 股行情源没有场外基金代码，命中 data/fund_codes.json 的代码改走天天基金官方净值
# （f10/lsjz，与场外 T+1 口径一致；QDII 净值有 1 天滞后）。
BASE = Path(__file__).resolve().parent
FUND_CODES_FILE = BASE / "data" / "fund_codes.json"
FUND_NAV_URL = "https://api.fund.eastmoney.com/f10/lsjz"
FUND_SUGGEST_URL = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
FUND_SUGGEST_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://fund.eastmoney.com/" }
FUND_NEG_TTL = 60.0                 # 取不到净值的代码，60 秒后再试一次
_fund_failed: dict[str, float] = {}
FUND_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://fundf10.eastmoney.com/"}
FUND_TTL = 600.0                    # 场外基金一天只更一次净值，缓存 10 分钟足够
_fund_cache: dict[str, tuple[float, dict]] = {}


def fund_codes() -> set[str]:
    """data/fund_codes.json：本机认定为「场外基金」的代码清单。"""
    try:
        return {str(c).strip() for c in json.loads(FUND_CODES_FILE.read_text())}
    except Exception:
        return set()


def fund_lookup(q: str, limit: int = 6) -> list[dict]:
    """天天基金联想：代码或名称 → 场外基金（带最新净值，免 key）。

    只返回 6 位数字代码；名称同名多份额（A/C/美元现汇…）会各占一行，由用户自己选。
    """
    q = (q or "").strip()
    if len(q) < 2:
        return []
    try:
        r = _session.get(FUND_SUGGEST_URL, params={"m": 1, "key": q},
                         headers=FUND_SUGGEST_HEADERS, timeout=(3.05, 6))
        d = r.json()
    except Exception:
        return []
    out: list[dict] = []
    for x in (d.get("Datas") or []):
        code = str(x.get("CODE") or "").strip()
        if not (code.isdigit() and len(code) == 6):
            continue
        base = x.get("FundBaseInfo") or {}
        try:
            nav = float(base.get("DWJZ") or 0)
        except (TypeError, ValueError):
            nav = 0.0
        out.append({
            "code": code,
            "name": (x.get("NAME") or base.get("SHORTNAME") or "").strip(),
            "market": "fund",
            "type": "基金",
            "pinyin": x.get("JP") or "",
            "ftype": base.get("FTYPE") or "",
            "nav": nav or None,
            "nav_date": base.get("FSRQ") or "",
        })
        if len(out) >= limit:
            break
    return out


def _fund_name(code: str) -> str:
    for x in fund_lookup(code, 2):
        if x["code"] == code:
            return x["name"]
    return ""

def _fund_fetch(codes: list[str]) -> dict[str, dict]:
    """逐只取最新公布净值，返回与 A 股行情同构的 dict。"""
    out: dict[str, dict] = {}
    for c in codes:
        try:
            r = _session.get(FUND_NAV_URL, headers=FUND_HEADERS, timeout=(3.05, 8),
                             params={"fundCode": c, "pageIndex": 1, "pageSize": 1})
            row = ((r.json().get("Data") or {}).get("LSJZList") or [{}])[0]
            nav = float(row.get("DWJZ") or 0)
            if nav <= 0:
                continue
            try:
                pct = float(row.get("JZZZL"))
            except (TypeError, ValueError):
                pct = 0.0
            prev = nav / (1 + pct / 100.0) if pct > -100 else nav
            out[c] = {
                "code": c, "name": _fund_name(c), "price": round(nav, 4),
                "prev_close": round(prev, 4), "open": None, "high": None, "low": None,
                "change": round(nav - prev, 4), "pct": round(pct, 2),
                "volume": None, "amount": None, "turnover": "",
                "turnover_rate": None, "pe": None, "float_cap": None, "total_cap": None,
                "pb": None, "vol_ratio": None,
                "time": str(row.get("FSRQ") or ""),
                "source": "fund_nav",
            }
        except Exception:
            continue
    return out


FUND_MOB_BASE = "https://fundmobapi.eastmoney.com/FundMNewApi/"
FUND_MOB_HEADERS = {"User-Agent": "EMProjJijin/6.2.8 (iPhone; iOS 16.6; Scale/3.00)",
                    "Referer": "https://fund.eastmoney.com/"}
FUND_MOB_PARAMS = {"deviceid": "Wap", "plat": "Iphone", "product": "EFund", "version": "6.2.8"}
FUND_PZ_URL = "https://fund.eastmoney.com/pingzhongdata/{code}.js"
FUND_PROFILE_TTL = 1800.0      # 档案/净值历史半小时一刷足够
FUND_PROFILE_NEG_TTL = 300.0
_fund_profile: dict[str, tuple[float, dict]] = {}
_fund_profile_fail: dict[str, float] = {}
_profile_lock = threading.Lock()

FUND_POS_TTL = 43200.0          # 季报持仓，半天刷一次足够
_fund_pos: dict[str, tuple[float, dict]] = {}
STOCK_NEWS_URL = "https://np-listapi.eastmoney.com/comm/web/getListInfo"
STOCK_NEWS_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
STOCK_NEWS_TTL = 900.0
_stock_news: dict[tuple[str, int], tuple[float, list]] = {}
_news_lock = threading.Lock()
# 东财资讯的 mTypeAndCode：1=沪 0=深 116=港股
TEXCH_MARKET = {"1": "1", "0": "0", "116": "116", "5": "116", "7": "105"}


def fund_position(code: str) -> dict:
    """基金季报前十大持仓 + 联接基金的目标 ETF（天天基金公开接口）。"""
    code = str(code or "").strip()
    now = time.time()
    with _news_lock:
        hit = _fund_pos.get(code)
        if hit and now - hit[0] < FUND_POS_TTL:
            return hit[1]
    out: dict = {"stocks": [], "etf": None, "report": ""}
    try:
        r = _session.get(FUND_MOB_BASE + "FundMNInverstPosition",
                         params={**FUND_MOB_PARAMS, "FCODE": code},
                         headers=FUND_MOB_HEADERS, timeout=(3.05, 10))
        j = r.json() or {}
        d = j.get("Datas") or {}
        if isinstance(d, dict):
            out["report"] = str(j.get("Expansion") or "")
            stocks = []
            for x in (d.get("fundStocks") or []):
                c = str(x.get("GPDM") or "").strip()
                nm = str(x.get("GPJC") or "").strip()
                if not c or not nm:
                    continue
                stocks.append({"code": c, "name": nm,
                               "weight": _fnum(x.get("JZBL"), 2),
                               "market": TEXCH_MARKET.get(str(x.get("TEXCH") or ""), "")})
            out["stocks"] = stocks
            etf_code = str(d.get("ETFCODE") or "").strip()
            if etf_code:
                out["etf"] = {"code": etf_code, "name": str(d.get("ETFSHORTNAME") or "").strip()}
    except Exception:
        pass
    with _news_lock:
        _fund_pos[code] = (time.time(), out)
    return out


def stock_news(code: str, market: str = "1", size: int = 6) -> list[dict]:
    """东财个股资讯（免 key，公开接口）：按代码取最近 N 条新闻标题。"""
    if not market:
        market = "1" if str(code)[0] in "569" else "0"
    key = (f"{market}.{code}", int(size))
    now = time.time()
    with _news_lock:
        hit = _stock_news.get(key)
        if hit and now - hit[0] < STOCK_NEWS_TTL:
            return hit[1]
    items: list[dict] = []
    try:
        r = _session.get(STOCK_NEWS_URL, headers=STOCK_NEWS_HEADERS, timeout=(3.05, 8),
                         params={"client": "web", "mTypeAndCode": f"{market}.{code}",
                                 "type": "1", "pageIndex": 1, "pageSize": max(1, min(int(size), 20)),
                                 "fields": "code,title,showTime,uniqueUrl,mediaName"})
        lst = ((r.json() or {}).get("data") or {}).get("list") or []
        for x in lst:
            title = str(x.get("Art_Title") or "").strip()
            if not title:
                continue
            items.append({"title": title,
                          "time": str(x.get("Art_ShowTime") or "")[:16],
                          "url": x.get("Art_Url") or x.get("Art_OriginUrl") or "",
                          "source": str(x.get("Art_MediaName") or "")})
    except Exception:
        items = []
    with _news_lock:
        _stock_news[key] = (time.time(), items)
    return items


FUND_PERIOD_LABEL = {"Z": "近1周", "Y": "近1月", "3Y": "近3月", "6Y": "近6月", "1N": "近1年",
                     "2N": "近2年", "3N": "近3年", "JN": "今年来", "LN": "成立来"}


def _fnum(v, nd: int = 2):
    """东财字段大量用 "--" 表示无值，统一转成 None。"""
    try:
        x = float(str(v).replace("%", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    if x != x:      # NaN
        return None
    return round(x, nd)


def fund_nav_history(code: str) -> list[dict]:
    """天天基金 pingzhongdata：一次请求拿到全部单位净值历史（含当日增长率）。"""
    try:
        r = _session.get(FUND_PZ_URL.format(code=code), headers=FUND_SUGGEST_HEADERS,
                         timeout=(3.05, 12))
        m = re.search(r"Data_netWorthTrend\s*=\s*(\[[^\]]*\])", r.text)
        if not m:
            return []
        arr = json.loads(m.group(1))
    except Exception:
        return []
    out: list[dict] = []
    for x in arr:
        try:
            nav = float(x.get("y"))
            ts = int(float(x.get("x"))) / 1000.0
        except (TypeError, ValueError):
            continue
        if nav <= 0:
            continue
        # 东财的 x 是北京时间当天 0 点，按 UTC 转会整体偏早一天（净值日会写成前一天）
        day = datetime.fromtimestamp(ts, BJ).strftime("%Y-%m-%d")
        pct = _fnum(x.get("equityReturn")) or 0.0
        out.append({"date": day, "nav": round(nav, 4), "pct": round(pct, 2)})
    return out


_acc_trend: dict[str, tuple[float, list[dict]]] = {}
_ACC_TTL = 1800


def fund_acc_trend(code: str) -> list[dict]:
    """天天基金 pingzhongdata 的 Data_ACWorthTrend：累计净值走势（[[毫秒, 累计], …]）。
    单独缓存，避免为了一个累计值把整个 pingzhongdata 再拉一遍。"""
    code = str(code or "").strip()
    now = time.time()
    hit = _acc_trend.get(code)
    if hit and now - hit[0] < _ACC_TTL:
        return hit[1]
    try:
        r = _session.get(FUND_PZ_URL.format(code=code), headers=FUND_SUGGEST_HEADERS,
                         timeout=(3.05, 12))
        # 累计净值是「嵌套数组」：[[毫秒,值],[…]]，里面的 ] 会截断简单正则，必须跨行惰性匹配到 ; 为止
        m = re.search(r"Data_ACWorthTrend\s*=\s*(\[.*?\])\s*;", r.text, re.S)
        arr = json.loads(m.group(1)) if m else []
    except Exception:
        arr = []
    out = []
    for x in arr:
        try:
            ts = int(float(x[0])) / 1000.0
            v = float(x[1])
        except (TypeError, ValueError, IndexError):
            continue
        if v <= 0:
            continue
        out.append({"date": datetime.fromtimestamp(ts, BJ).strftime("%Y-%m-%d"),
                    "acc": round(v, 4)})
    if out:
        _acc_trend[code] = (now, out)
    return out


def fund_accnav(code: str, near_date: str = "", near_nav: float | None = None) -> float | None:
    """累计净值：优先取与净值同一天的值；差一天就对最后几根做邻近匹配。"""
    rows = fund_acc_trend(code)
    if not rows:
        return None
    if near_date:
        for x in reversed(rows[-6:]):
            if x["date"] == near_date:
                return x["acc"]
    return rows[-1]["acc"]


def fund_profile(code: str) -> dict:
    """场外基金档案：基本信息 + 阶段涨幅/同类排名 + 净值历史（全部走公开接口，无 key）。"""
    code = str(code or "").strip()
    if not (code.isdigit() and len(code) == 6):
        return {"code": code, "ok": False, "error": "不是 6 位基金代码"}
    now = time.time()
    with _profile_lock:
        hit = _fund_profile.get(code)
        if hit and now - hit[0] < FUND_PROFILE_TTL:
            return hit[1]
        failed = _fund_profile_fail.get(code)
        if failed and now - failed < FUND_PROFILE_NEG_TTL:
            return {"code": code, "ok": False, "error": "暂时取不到这只基金的公开数据"}

    basic: dict = {}
    periods: list = []
    try:
        r = _session.get(FUND_MOB_BASE + "FundMNBasicInformation",
                         params={**FUND_MOB_PARAMS, "FCODE": code},
                         headers=FUND_MOB_HEADERS, timeout=(3.05, 10))
        basic = r.json().get("Datas") or {}
        if not isinstance(basic, dict):
            basic = {}
    except Exception:
        basic = {}
    try:
        r2 = _session.get(FUND_MOB_BASE + "FundMNPeriodIncrease",
                          params={**FUND_MOB_PARAMS, "FCODE": code},
                          headers=FUND_MOB_HEADERS, timeout=(3.05, 10))
        d2 = r2.json().get("Datas") or []
        if isinstance(d2, list):
            periods = [x for x in d2 if isinstance(x, dict)]
    except Exception:
        periods = []

    hist = fund_nav_history(code)
    if not basic and not hist:
        with _profile_lock:
            _fund_profile_fail[code] = now
        return {"code": code, "ok": False, "error": "暂时取不到这只基金的公开数据"}

    nav = _fnum(basic.get("DWJZ"), 4)
    nav_date = str(basic.get("FSRQ") or "")
    pct = _fnum(basic.get("RZDF"))
    if (nav is None or not nav_date) and hist:
        nav, nav_date, pct = hist[-1]["nav"], hist[-1]["date"], hist[-1]["pct"]

    out = {
        "code": code,
        "ok": True,
        "name": (basic.get("SHORTNAME") or _fund_name(code) or "").strip(),
        "ftype": basic.get("FTYPE") or "",
        "nav": nav,
        "nav_date": nav_date,
        "pct": pct,
        "accnav": None,   # 下面用 Data_ACWorthTrend 填，basic 的 LJJZ 常与单位净值相同
        "w1": _fnum(basic.get("SYL_Z")), "m1": _fnum(basic.get("SYL_Y")),
        "m3": _fnum(basic.get("SYL_3Y")), "m6": _fnum(basic.get("SYL_6Y")),
        "y1": _fnum(basic.get("SYL_1N")), "y2": _fnum(basic.get("SYL_2N")),
        "y3": _fnum(basic.get("SYL_3N")), "ytd": _fnum(basic.get("SYL_JN")),
        "since": _fnum(basic.get("SYL_LN")),
        "sgzt": basic.get("SGZT") or "",
        "sgzt_mark": basic.get("SGZTMARK") or "",
        "shzt": basic.get("SHZT") or "",
        "rate": _fnum(basic.get("RATE"), 2),
        "source_rate": _fnum(basic.get("SOURCERATE"), 2),
        "minsg": basic.get("MINSG") or "",
        "maxsg": _fnum(basic.get("MAXSG"), 0),          # 单日/单笔申购上限（限大额时的额度）
        "risk": basic.get("RISKLEVEL") or "",
        "company": basic.get("JJGS") or "",
        "manager": basic.get("JJJL") or "",
        "found": str(basic.get("ISSBDATE") or "")[:10],
        "endnav": _fnum(basic.get("ENDNAV"), 0),
        "scale": (round(_fnum(basic.get("ENDNAV"), 0) / 1e8, 2)
                  if _fnum(basic.get("ENDNAV"), 0) else None),
        "periods": [{
            "key": x.get("title"),
            "label": FUND_PERIOD_LABEL.get(str(x.get("title") or ""), str(x.get("title") or "")),
            "syl": _fnum(x.get("syl")), "avg": _fnum(x.get("avg")),
            "hs300": _fnum(x.get("hs300")), "rank": _fnum(x.get("rank"), 0),
            "sc": _fnum(x.get("sc"), 0),
        } for x in periods if FUND_PERIOD_LABEL.get(str(x.get("title") or ""))],
        "history": hist[-800:],
    }
    try:
        out["accnav"] = fund_accnav(code, out.get("nav_date") or "", out.get("nav"))
    except Exception:
        out["accnav"] = _fnum(basic.get("LJJZ"), 4)
    if out["accnav"] and out["nav"] and abs(out["accnav"] - out["nav"]) < 1e-6:
        out["accnav"] = _fnum(basic.get("LJJZ"), 4) or out["accnav"]
    # pingzhongdata 的最后一根有时比基本信息慢一天（数值相同、日期落后）：直接把日期对齐
    if out["history"] and out["nav"] and out["nav_date"] \
            and out["history"][-1]["date"] < out["nav_date"] \
            and abs((out["history"][-1]["nav"] or 0) - out["nav"]) < 1e-6:
        out["history"][-1]["date"] = out["nav_date"]
    with _profile_lock:
        _fund_profile[code] = (time.time(), out)
        _fund_profile_fail.pop(code, None)
    return out


# 2026 年 A 股工作日休市日（周末由 weekday 判断；来源：上交所 2026 年休市安排）
# 每年交易所公布新安排后更新这里。
MARKET_HOLIDAYS = {
    "2026-01-01", "2026-01-02",
    "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-23",
    "2026-04-06",
    "2026-05-01", "2026-05-04", "2026-05-05",
    "2026-06-19",
    "2026-09-25",
    "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07",
}
_HOLIDAY_YEARS = {int(d[:4]) for d in MARKET_HOLIDAYS if d[:4].isdigit()}
if datetime.now(BJ).year not in _HOLIDAY_YEARS:
    log.warning("%s 年的 A 股休市日还没配置，节假日会被当作交易日",
                datetime.now(BJ).year)


def is_trading_day(day: str) -> bool:
    """day=YYYY-MM-DD；周末和节假日为 False。"""
    try:
        d = datetime.strptime(day, "%Y-%m-%d")
    except ValueError:
        return False
    return d.weekday() < 5 and day not in MARKET_HOLIDAYS


# 美股代码形如 NVDA / BRK.B / BRK-A；港股 5 位数字（00700 / 700）
_US_CODE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9.\-]{0,9}$")


def secid(code: str) -> str:
    """A 股 / 场内基金 / 港股 / 美股统一成腾讯的符号写法（usNVDA、hk00700）。"""
    code = (code or "").strip()
    low = code.lower()
    if low.startswith(("sh", "sz", "bj")):
        return low
    if low.startswith("us") and _US_CODE_RE.match(code[2:] or ""):
        return "us" + code[2:].upper()
    if low.startswith("hk") and (code[2:] or "").isdigit():
        return "hk" + code[2:].zfill(5)
    # 港股指数（hkHSI / hkHSTECH / hkHSCEI）：字母后缀必须留 hk，否则会被当成美股拼成 usHKHSI
    if low.startswith("hk") and re.fullmatch(r"[a-z]{2,8}", code[2:] or "", re.I):
        return "hk" + code[2:].upper()
    if code.isdigit():
        if len(code) <= 5:          # 港股：700 / 00700
            return "hk" + code.zfill(5)
        # 北交所要放在 9 开头（沪 B）之前，否则 920xxx 会被误判成 sh
        if code[0] == "8" or code[:2] in ("43", "87", "92"):
            return "bj" + code
        if code[0] in "569":
            return "sh" + code
        return "sz" + code
    if _US_CODE_RE.match(code):
        return "us" + code.upper()
    return "sz" + code


def market_of(sym: str) -> str:
    """sym 是 secid 形式：a / hk / us。"""
    if sym.startswith("us"):
        return "us"
    if sym.startswith("hk"):
        return "hk"
    return "a"


def market_status() -> dict:
    now = datetime.now(BJ)
    hm = now.hour * 100 + now.minute
    weekday = now.weekday() < 5
    today = now.strftime("%Y-%m-%d")
    if not weekday:
        st = ("closed", "周末休市")
    elif today in MARKET_HOLIDAYS:
        st = ("closed", "节假日休市")
    elif 915 <= hm < 925:
        st = ("pre", "集合竞价")
    elif 925 <= hm < 930:
        st = ("pre", "等待开盘")
    elif 930 <= hm < 1130:
        st = ("open", "交易中")
    elif 1130 <= hm < 1300:
        st = ("lunch", "午间休市")
    elif 1300 <= hm < 1500:
        st = ("open", "交易中")
    elif hm >= 1500:
        st = ("closed", "已收盘")
    else:
        st = ("closed", "未开盘")
    return {"state": st[0], "text": st[1], "server_time": now.strftime("%Y-%m-%d %H:%M:%S")}


def _next_trading_day(day: date) -> date:
    d = day + timedelta(days=1)
    while not is_trading_day(d.strftime("%Y-%m-%d")):
        d += timedelta(days=1)
    return d


def next_open_at(now: datetime | None = None) -> int:
    """下一次「行情可能变化」的北京时间，epoch 毫秒；已开盘/竞价中返回 0。

    由服务端统一计算，前端就不用自己猜 9:14/9:15 和节假日。集合竞价 9:15 开始，
    所以 9:14 醒来的旧逻辑会把下一次错误地推到明天；这里以 9:15 为准。
    """
    if now is None:
        now = datetime.now(BJ)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=BJ)
    else:
        now = now.astimezone(BJ)
    today = now.date()
    hm = now.hour * 100 + now.minute
    if is_trading_day(today.strftime("%Y-%m-%d")):
        if hm < 915:
            target = datetime.combine(today, dtime(9, 15), tzinfo=BJ)
        elif hm < 1130:
            return 0
        elif hm < 1300:
            target = datetime.combine(today, dtime(13, 0), tzinfo=BJ)
        elif hm < 1500:
            return 0
        else:
            target = datetime.combine(_next_trading_day(today), dtime(9, 15), tzinfo=BJ)
    else:
        target = datetime.combine(_next_trading_day(today), dtime(9, 15), tzinfo=BJ)
    return int(target.timestamp() * 1000)



def _num(f: list, i: int) -> float | None:
    try:
        v = f[i].strip()
        return float(v) if v not in ("", "-") else None
    except (IndexError, ValueError):
        return None


def _parse(line: str, sym: str = "") -> dict | None:
    try:
        body = line.split('="', 1)[1].rstrip('";').rstrip('"')
        f = body.split("~")
        if len(f) < 40:
            return None
        price = float(f[3] or 0)
        mkt = market_of(sym)
        prev = float(f[4] or 0)
        pct = float(f[32] or 0)
        return {
            "code": f[2],
            "name": f[1],
            "price": price,
            "prev_close": prev,
            "open": float(f[5] or 0),
            "high": float(f[33] or 0),
            "low": float(f[34] or 0),
            "change": float(f[31] or 0),
            "pct": pct,
            "volume": float(f[36] or 0),      # 手
            "amount": float(f[37] or 0),      # 万元
            "turnover": f[38] if len(f) > 38 else "",
            "turnover_rate": _num(f, 38),
            "pe": _num(f, 39),
            "float_cap": _num(f, 44),   # 亿元
            "total_cap": _num(f, 45),   # 亿元
            "pb": _num(f, 46),
            "vol_ratio": _num(f, 49),
            "time": f[30] if len(f) > 30 else "",
            "market": mkt,
            # A 股成交量按「手」、成交额按「万元」；港股/美股按股、按原币种「元」
            "vol_unit": "hand" if mkt == "a" else "share",
            "money_unit": "wan" if mkt == "a" else "yuan",
            # 美股的 f[35] 是 USD 这类币种；港股这个位置是别的数，别照抄
            "currency": ("USD" if mkt == "us" else "HKD") if mkt in ("us", "hk") else "CNY",
            "source": "tx",
        }
    except (IndexError, ValueError):
        return None


def _warn(msg: str) -> None:
    """日志限流：上游持续失败时不要每 3 秒刷一行。"""
    global _last_warn
    now = time.time()
    if now - _last_warn >= 60:
        _last_warn = now
        log.warning("%s", msg)


def _mark_error(msg: str) -> None:
    global _last_error
    _last_error = msg[:300]
    _warn(msg)


def _sina_fetch(symbols: list[str]) -> dict[str, dict]:
    """新浪备用源：腾讯失败/缺数据时补齐价格、涨跌幅；没有量比/换手等扩展字段。"""
    out: dict[str, dict] = {}
    chunk_all = list(dict.fromkeys(
        s for s in symbols if s.startswith(("sh", "sz", "bj"))
    ))
    for i in range(0, len(chunk_all), 200):
        chunk = chunk_all[i:i + 200]
        try:
            r = _session.get(SINA_URL + ",".join(chunk), headers=SINA_HEADERS, timeout=8)
            text = r.content.decode("gbk", errors="ignore")
        except requests.RequestException as e:
            _mark_error(f"sina quote failed: {e}")
            continue
        for line in text.splitlines():
            if '="' not in line:
                continue
            try:
                key = line.split("=", 1)[0].replace("var hq_str_", "").strip()
                if key not in chunk:
                    continue
                body = line.split('="', 1)[1].rstrip('";')
                f = body.split(",")
                if len(f) < 32:
                    continue
                name = f[0].strip()
                open_p = float(f[1] or 0)
                prev = float(f[2] or 0)
                price = float(f[3] or 0)
                high = float(f[4] or 0)
                low = float(f[5] or 0)
                vol = float(f[8] or 0) / 100.0       # 股 -> 手（与腾讯口径一致）
                amount = float(f[9] or 0) / 1e4       # 元 -> 万元
                change = price - prev if prev else 0.0
                pct = (change / prev * 100.0) if prev else 0.0
            except (ValueError, IndexError):
                continue
            if not name:
                continue
            out[key] = {
                "code": key[2:], "name": name, "price": price, "prev_close": prev,
                "open": open_p, "high": high, "low": low, "change": change,
                "pct": round(pct, 2), "volume": vol, "amount": amount,
                "turnover": "", "turnover_rate": None, "pe": None,
                "float_cap": None, "total_cap": None, "pb": None,
                "vol_ratio": None,
                "time": f"{f[30]} {f[31]}" if len(f) > 31 else "",
                "source": "sina",
            }
    return out


EM_QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
EM_QUOTE_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/"}
EM_QUOTE_FIELDS = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170"


def _em_quote_dict(symbol: str, d: dict) -> dict | None:
    """东财 stock/get → 与腾讯同构的行情 dict（价格类字段东财都是「分」，要 /100）。"""
    def num(v, k=1.0, nd=2):
        try:
            x = float(v) / k
        except (TypeError, ValueError):
            return None
        return round(x, nd) if x == x else None

    price = num(d.get("f43"), 100)
    if price is None or price <= 0:
        return None
    prev = num(d.get("f60"), 100) or 0.0
    change = num(d.get("f169"), 100) or (price - prev if prev else 0.0)
    pct = num(d.get("f170"), 100)
    return {
        "code": symbol[2:],
        "name": str(d.get("f58") or "").strip(),
        "price": price,
        "prev_close": prev,
        "open": num(d.get("f46"), 100),
        "high": num(d.get("f44"), 100),
        "low": num(d.get("f45"), 100),
        "change": change,
        "pct": pct if pct is not None else round((price / prev - 1) * 100, 2) if prev else 0.0,
        "volume": num(d.get("f47"), 1, 0),
        "amount": num(d.get("f48"), 1e4, 2),        # 元 → 万元
        "turnover": "",
        "turnover_rate": num(d.get("f168"), 100),
        "pe": num(d.get("f162"), 100),
        "pb": num(d.get("f167"), 100),
        "float_cap": num(d.get("f116"), 1e8),        # 元 → 亿元
        "total_cap": num(d.get("f117"), 1e8),
        "vol_ratio": None,
        "time": "",
        "source": "eastmoney",
    }


def _em_fetch(symbols: list[str]) -> dict[str, dict]:
    """东财兜底（第三顺位）：腾讯、新浪都取不到时才逐只问一次，避免界面空白。"""
    out: dict[str, dict] = {}
    for sym in symbols:
        if not sym.startswith(("sh", "sz", "bj")):
            continue
        mkt = {"sh": 1, "sz": 0, "bj": 0}[sym[:2]]
        try:
            r = _session.get(EM_QUOTE_URL, headers=EM_QUOTE_HEADERS, timeout=(3.05, 6),
                             params={"secid": f"{mkt}.{sym[2:]}", "fields": EM_QUOTE_FIELDS})
            d = (r.json() or {}).get("data") or {}
        except Exception as e:
            _mark_error(f"eastmoney quote failed: {e}")
            continue
        q = _em_quote_dict(sym, d)
        if q:
            out[sym] = q
    return out


def _tencent_fetch(symbols: list[str]) -> dict[str, dict]:
    """腾讯批量快照（HTTPS，避免明文行情数据被中间人改写）。"""
    try:
        r = _session.get("https://qt.gtimg.cn/q=" + ",".join(symbols),
                         headers=HEADERS, timeout=(3.05, 6))
        r.encoding = "gbk"
    except requests.RequestException as e:
        _mark_error(f"tencent quote failed: {e}")
        return {}
    out: dict[str, dict] = {}
    for line in r.text.splitlines():
        if "=" not in line:
            continue
        key = line.split("=", 1)[0].replace("v_", "").strip()
        d = _parse(line, key)
        if d:
            out[key] = d
    return out


_offsite_cache: dict[str, tuple[float, bool]] = {}


def _is_offsite_fund(code: str) -> bool:
    """腾讯联想把这个代码认成 jj（场外基金）时返回 True。

    场内 LOF/ETF 在联想里是 sz/sh；真 A 股也是 sz/sh。只有 jj 说明它是
    支付宝式场外基金，A 股行情源（腾讯/新浪/东财）必然查不到，应改用官方净值。
    """
    now = time.time()
    hit = _offsite_cache.get(code)
    if hit and now - hit[0] < 1800:
        return hit[1]
    ok = False
    try:
        r = requests.get(SEARCH_URL, params={"q": code, "t": "all"},
                         headers={"User-Agent": "Mozilla/5.0", "Referer": "https://gu.qq.com/"},
                         timeout=2.5)
        text = r.content.decode("gbk", errors="ignore")
        inner = text.split('"', 1)[1].rsplit('"', 1)[0] if '"' in text else ""
        # 只看联想的第一条：腾讯按相关度排序，000001 这种数字既是平安银行又是
        # 华夏成长，往后翻能翻到基金，只看首条才不会被同名基金顶掉
        first = inner.split("^")[0].split("~")
        ok = len(first) >= 2 and first[0] == "jj" and first[1] == code
    except Exception:
        ok = False
    _offsite_cache[code] = (now, ok)
    return ok


def _is_fund_sym(symbol: str, fc: set[str]) -> bool:
    """这个 secid 是不是场外基金（已登记fund_codes.json，或探测确认过）。

    场外基金拿不到 A 股三源的行情，必须只走天天基金净值；混进 stale/need
    会让每次刷新都白跑腾讯→新浪→东财，并把整拍拖成秒级。只在 fetch 锁内调用。
    """
    raw = symbol[2:]
    if raw in fc:
        return True
    return bool(_offsite_cache.get(raw, (0.0, False))[1])


def fetch(codes: list[str]) -> dict[str, dict]:
    """返回 {原始代码: 行情}；缓存 2.5s，腾讯失败时用新浪兜底。

    并发请求用一把锁串行化：第二个请求等第一个抓完，直接复用新缓存，
    避免同一时刻重复打上游（腾讯按 IP 限流时会直接返回空）。
    """
    global _fail_until, _tencent_fail_until, _last_error
    wanted = []
    for c in codes:
        s = secid(c)
        raw = s[2:]
        wanted.append((raw, s))
    if not wanted:
        return {}
    fc = fund_codes()
    with _lock:
        now = time.time()
        # 场外基金一律不进 A 股三源抓取集合：它们只走下面的天天基金净值分支。
        # 以前一视同仁导致 5 只基金就把一拍拖到 6 秒，并误触发 _fail_until 连累正常股票。
        fund_syms = {s for _, s in wanted if _is_fund_sym(s, fc)}
        stale = [s for _, s in wanted
                 if s not in fund_syms and now - _cache.get(s, (0, {}))[0] > CACHE_TTL]
        if stale and now >= _fail_until:
            got: dict[str, dict] = {}
            # 腾讯 30 秒退避期内直接跳过它，让每一拍都走更快的新浪
            if now >= _tencent_fail_until:
                got = _tencent_fetch(stale)
                if got:
                    ts = time.time()
                    for key, d in got.items():
                        _cache[key] = (ts, d)
                    _last_error = ""
                    _tencent_fail_until = 0.0
                else:
                    _tencent_fail_until = time.time() + TENCENT_FAIL_BACKOFF
            # 腾讯没取到/仍过期的代码，走新浪兜底（不覆盖腾讯已有数据）
            need = [s for s in stale
                    if s not in fund_syms and time.time() - _cache.get(s, (0, {}))[0] > CACHE_TTL]
            if need:
                em: dict[str, dict] = {}
                sina = _sina_fetch(need)
                if sina:
                    ts = time.time()
                    for symbol, d in sina.items():
                        _cache[symbol] = (ts, d)
                # 新浪也没拿到的，最后问一次东财（逐只，数量通常很少）
                still = [s for s in need
                         if s not in fund_syms and time.time() - _cache.get(s, (0, {}))[0] > CACHE_TTL]
                if still:
                    em = _em_fetch(still)
                    if em:
                        ts = time.time()
                        for symbol, d in em.items():
                            _cache[symbol] = (ts, d)
        out: dict[str, dict] = {}
        now = time.time()
        missing: list[str] = []
        for raw, s_ in wanted:
            ts, d = _cache.get(s_, (0, {}))
            if d:
                fund = d.get("source") == "fund_nav"
                out[raw] = dict(d, stale=(now - ts) > (FUND_TTL if fund else CACHE_STALE_AFTER))
            else:
                missing.append(raw)

    # 锁外：只有 A 股三源都拿不到的代码才去探「是不是场外基金」（最多 4 只、每只最多
    # 2.5 秒）。普通股票走完三源就有数据了，根本到不了这里；探测也不再占着全局锁。
    probe = [r for r in missing
             if len(r) == 6 and r.isdigit() and r not in fc
             and time.time() - _offsite_cache.get(r, (0.0, False))[0] > 1800][:4]
    for r in probe:
        _is_offsite_fund(r)

    fund_list = [r for r in missing
                 if r in fc or _offsite_cache.get(r, (0.0, False))[1]]
    if fund_list:
        now_t = time.time()
        todo = [c for c in fund_list
                if now_t - _fund_cache.get(c, (0, {}))[0] > FUND_TTL
                and now_t - _fund_failed.get(c, 0) > FUND_NEG_TTL]
        if todo:
            got_f = _fund_fetch(todo)
            ts_f = time.time()
            for c, d in got_f.items():
                _fund_cache[c] = (ts_f, d)
                _fund_failed.pop(c, None)
            for c in todo:
                if c not in got_f:
                    _fund_failed[c] = ts_f
        for raw in fund_list:
            ts, d = _fund_cache.get(raw, (0, {}))
            if d:
                out[raw] = dict(d, stale=(time.time() - ts) > FUND_TTL)

    # 只有「真·A 股代码在三源里一个都拿不到」才算上游挂了、才整体退避。
    # 以前只要有一只没登记的场外基金混在批量里就触发 3 秒全局退避，正常股票跟着停更。
    if [r for r in missing if r not in out
            and not _offsite_cache.get(r, (0.0, False))[1]]:
        _fail_until = time.time() + FETCH_FAIL_BACKOFF
        _warn("quotes upstream unavailable; serving last cache")
    return out


def cache_info() -> dict:
    """给 /api/v1/health 用的上游状态快照（不包含行情内容）。"""
    now = time.time()
    with _lock:
        ages = [now - ts for ts, _ in _cache.values()]
        return {
            "symbols": len(_cache),
            "oldest_age": round(max(ages), 1) if ages else None,
            "newest_age": round(min(ages), 1) if ages else None,
            "last_error": _last_error,
            "fail_backoff": max(0.0, round(_fail_until - now, 1)),
            "tencent_backoff": max(0.0, round(_tencent_fail_until - now, 1)),
        }


SEARCH_URL = "https://smartbox.gtimg.cn/s3/"
OK_TYPES = {"GP-A", "GP-B", "ETF", "QDII-ETF", "LOF", "REITs"}
SEARCH_TTL = 300.0
SEARCH_CACHE_MAX = 200
_search_cache: dict[tuple[str, int], tuple[float, list[dict]]] = {}
_search_lock = threading.Lock()


def search(q: str, limit: int = 12) -> list[dict]:
    """按名称/拼音/代码搜 A 股与场内基金（腾讯 smartbox，GBK）。

    至少 2 个字符；名称/代码结果缓存 5 分钟，避免边输入边打腾讯接口。
    行情由调用方另行批量补，缓存里只放搜索元数据。
    """
    q = (q or "").strip()
    if len(q) < 2:
        return []
    limit = max(1, min(int(limit or 12), 20))
    key = (q.lower(), limit)
    now = time.time()
    with _search_lock:
        hit = _search_cache.get(key)
        if hit and now - hit[0] < SEARCH_TTL:
            return [dict(x) for x in hit[1][:limit]]
    try:
        # 搜索是低频路径，单独建连接，避免与 fetch 的 Session 并发使用
        r = requests.get(SEARCH_URL, params={"q": q, "t": "all"},
                         headers={"User-Agent": "Mozilla/5.0", "Referer": "https://finance.qq.com/"},
                         timeout=6)
        text = r.content.decode("gbk", errors="ignore")
        inner = text.split('"', 1)[1].rsplit('"', 1)[0] if '"' in text else ""
    except Exception:
        return []  # 抓取失败不缓存，下次输入/刷新会重试
    out = []
    for part in inner.split("^"):
        f = part.split("~")
        if len(f) < 5:
            continue
        market, code, name, py, typ = f[0], f[1], f[2], f[3], f[4]
        if market not in ("sh", "sz", "bj") or not code.isdigit() or len(code) != 6:
            continue
        # 科创板返回 GP-A-KCB（如宇树科技 688836），不能只精确匹配 GP-A
        if not (typ in OK_TYPES or typ.startswith("GP-A") or typ.startswith("GP-B")):
            continue
        try:
            name = bytes(name, "utf-8").decode("unicode_escape")
        except Exception:
            pass
        out.append({"code": code, "name": name, "market": market, "type": typ, "pinyin": py})
        if len(out) >= limit:
            break
    # 场外基金（支付宝里的 ETF 联接 / QDII / 主动基金）：腾讯联想没有，另取天天基金
    seen = {x["code"] for x in out}
    for x in fund_lookup(q, min(6, limit)):
        if x["code"] in seen:
            continue
        out.append(x)
        seen.add(x["code"])
        if len(out) >= limit:
            break
    with _search_lock:
        _search_cache[key] = (now, [dict(x) for x in out])
        if len(_search_cache) > SEARCH_CACHE_MAX:
            oldest = min(_search_cache, key=lambda k: _search_cache[k][0])
            _search_cache.pop(oldest, None)
    return out


def snapshot(codes: list[str]) -> dict:
    quotes = fetch(codes)
    return {"server_time": datetime.now(BJ).strftime("%H:%M:%S"), "market": market_status(), "quotes": quotes}
