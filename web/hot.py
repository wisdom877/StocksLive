"""热门板块 + 涨停全景：把「涨停」按题材合并分类，并保留 10:00/收盘 快照用于对比。

数据源
- 东财涨停池/炸板池/跌停池（push2ex）：连板数 lbc、封单 fund、行业 hybk、封板时间 fbt
- 同花顺涨停原因（dataapi/limit_up/limit_up_pool）：reason_type 完整题材名、high_days、换手板/一字板
- 同花顺热门概念（dq.10jqka）：板块涨幅 + 「N家涨停」标签 + 上榜热度

命令行
  python3 hot.py --snapshot am      # 存今日 10:00 快照并打印早盘对比（给 cron 推送）
  python3 hot.py --snapshot close   # 只存收盘快照，不推送
  python3 hot.py --print            # 打印当前对比文本
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import kline
import quotes

BASE = Path(__file__).resolve().parent
SNAP_DIR = BASE / "data" / "hot"
BJ = timezone(timedelta(hours=8))

EM = "https://push2ex.eastmoney.com/"
THS_POOL = "https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool"
THS_PLATE = "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate?type=concept"
THS_FIELDS = "199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004"
H_EM = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
        "Referer": "https://quote.eastmoney.com/"}
H_THS = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
         "Referer": "https://data.10jqka.com.cn/"}

WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
# 涨停原因里不是「板块」的通用词，聚合题材时跳过，改用行业
GENERIC = {"摘帽", "st", "次新股", "次新", "业绩预增", "业绩扭亏", "公告", "回购", "增持", "股权转让",
           "重组", "并购", "中标", "订单", "涨价", "扭亏", "预增", "高送转", "破净", "国改", "国企改革"}
TIER_MAIN, TIER_SUB, TIER_TAIL = 6, 3, 1
# 把同题材的细分涨停原因合并成一个大类（顺序即优先级）
CANON = [
    (r"机器人|具身|物理AI|灵巧手|减速器|丝杠|谐波", "人形机器人"),
    (r"PCB|覆铜板|铜箔|电子布|环氧|树脂|CCL", "PCB/覆铜板"),
    (r"算力|CPO|光模块|液冷|数据中心|AI服务器|服务器|人工智能|AI应用|大模型|MLOps|AIGC", "AI算力"),
    (r"半导体|芯片|存储|光刻|先进封装|晶圆|第三代半导体", "半导体"),
    (r"固态电池|锂电|电池|钠电|储能", "电池/储能"),
    (r"光伏|风电|电网|特高压|绿电|核电|充电桩", "新能源"),
    (r"医药|创新药|CXO|疫苗|减肥药|医疗器械|中药", "医药"),
    (r"军工|航空|航天|船舶|兵装|无人机|大飞机", "军工"),
    (r"黄金|有色|稀土|铜|铝|锂矿|小金属|钨|锑", "有色资源"),
    (r"低空|飞行汽车|eVTOL", "低空经济"),
    (r"白酒|食品|零售|旅游|酒店|养殖|种业|消费|家电|免税", "大消费"),
    (r"汽车|零部件|整车|智能驾驶|无人驾驶|车路云", "汽车产业链"),
    (r"软件|信创|数据要素|网络安全|IT服务|数字|云计算", "信创/软件"),
    (r"重组|并购|国改|国企改革|股权转让|资产注入", "重组/国改"),
    (r"业绩|三季报|预增|扭亏|高送转|摘帽|ST", "业绩/摘帽"),
    (r"化工|化纤|农药|化肥|钛白粉|制冷剂", "化工"),
    (r"电力|公用|燃气|水务|环保", "公用事业"),
    (r"银行|券商|保险|金融|参股", "大金融"),
    (r"房地产|地产|建筑|基建|水泥|钢铁|工程", "地产基建"),
    (r"农业|生猪|饲料|种植|渔业", "农业"),
]
CANON_RE = [(re.compile(p, re.I), n) for p, n in CANON]

_cache: dict[tuple, tuple[float, object]] = {}
TTL = 45


def _cached(key: tuple, fn, ttl: int = TTL):
    ts, val = _cache.get(key, (0, None))
    if val is not None and time.time() - ts < ttl:
        return val
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def today_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d")


def _d(s: str) -> str:
    return s.replace("-", "")


def _md(s: str) -> str:
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if "-" not in s else s


def weekday(day: str) -> str:
    try:
        return WEEK[datetime.strptime(day, "%Y-%m-%d").weekday()]
    except ValueError:
        return ""


def _em(ep: str, day: str, pagesize: int = 300) -> dict:
    """东财涨停/炸板/跌停池；非交易日会自动回退到最近一个交易日（qdate）。"""
    try:
        r = requests.get(EM + ep, params={
            "ut": "7eea3edcaed734bea9cbfc24409ed989", "dpt": "wz.ztzt",
            "Pageindex": 0, "pagesize": pagesize, "sort": "fbt:asc", "date": _d(day),
        }, headers=H_EM, timeout=12)
        d = r.json().get("data") or {}
    except Exception:
        return {"qdate": "", "tc": 0, "pool": []}
    qdate = str(d.get("qdate") or "")
    return {"qdate": _md(qdate) if len(qdate) == 8 else "",
            "tc": int(d.get("tc") or 0), "pool": d.get("pool") or []}


def _ths_pool(day: str) -> list[dict]:
    out: list[dict] = []
    for page in range(1, 4):
        try:
            r = requests.get(THS_POOL, params={
                "page": page, "limit": 100, "field": THS_FIELDS,
                "filter": "HS,GEM2STAR", "order_field": "330324", "order_type": 0,
                "date": _d(day),
            }, headers=H_THS, timeout=12)
            d = r.json().get("data") or {}
        except Exception:
            break
        info = d.get("info") or []
        out.extend(info)
        total = int((d.get("page") or {}).get("total") or 0)
        if len(out) >= total or not info:
            break
    return out


def concepts() -> list[dict]:
    """同花顺热门概念：板块涨幅 + 涨停家数标签。"""
    def go():
        try:
            r = requests.get(THS_PLATE, headers=H_THS, timeout=10)
            rows = (r.json().get("data") or {}).get("plate_list") or []
        except Exception:
            return []
        out = []
        for x in rows:
            tag = x.get("tag") or ""
            m = re.search(r"(\d+)\s*家涨停", tag)
            out.append({"name": x.get("name") or "", "pct": round(float(x.get("rise_and_fall") or 0), 2),
                        "zt": int(m.group(1)) if m else 0, "tag": tag,
                        "hot": x.get("hot_tag") or "", "rank": x.get("order") or 0})
        return [x for x in out if x["name"]]
    return _cached(("concepts", today_bj()), go, 300)


# 题材 → 同花顺板块名（用于给每个板块补一个涨幅）
SEC_ALIAS = {
    "人形机器人": ["人形机器人", "机器人概念"],
    "AI算力": ["人工智能", "算力", "CPO", "光模块", "数据中心"],
    "半导体": ["半导体", "存储芯片", "芯片"],
    "PCB/覆铜板": ["PCB", "覆铜板"],
    "电池/储能": ["电池", "储能"],
    "新能源": ["光伏设备", "风电设备", "电网设备"],
    "医药": ["化学制药", "中药", "医疗器械"],
    "军工": ["航天装备", "航空装备"],
    "有色资源": ["贵金属", "有色", "小金属"],
    "大消费": ["白酒", "食品", "零售", "旅游"],
    "汽车产业链": ["汽车零部件", "乘用车"],
    "信创/软件": ["软件开发", "计算机应用", "数据要素", "网络安全"],
    "大金融": ["证券", "银行", "保险", "多元金融"],
    "地产基建": ["房地产开发", "建筑装饰", "水泥"],
    "公用事业": ["电力", "燃气"],
    "化工": ["化学制品", "化学原料"],
    "农业": ["养殖业", "种植业"],
    "低空经济": ["低空经济", "飞行汽车"],
    "AI眼镜": ["AI眼镜"],
    "重组/国改": [],
    "业绩/摘帽": [],
}


def boards() -> dict[str, float]:
    """同花顺热门概念 + 热门行业板块的涨幅表（各 20 个），给题材补涨幅用。"""
    def go():
        out: dict[str, float] = {}
        for kind in ("concept", "industry"):
            try:
                r = requests.get(THS_PLATE.split("?")[0], params={"type": kind}, headers=H_THS, timeout=10)
                rows = (r.json().get("data") or {}).get("plate_list") or []
            except Exception:
                continue
            for x in rows:
                nm = (x.get("name") or "").strip()
                if nm and nm not in out:
                    try:
                        out[nm] = round(float(x.get("rise_and_fall") or 0), 2)
                    except (TypeError, ValueError):
                        pass
        return out
    return _cached(("boards", today_bj()), go, 300)


def _pct_from(b: dict[str, float], name: str) -> float | None:
    if not b or not name:
        return None
    keys = SEC_ALIAS.get(name)
    if keys is None:
        keys = [k for k in b if (k in name or name in k) and len(k) >= 2]
    vals = [b[k] for k in keys if k in b]
    if not vals:
        return None
    return round(sum(vals) / len(vals), 2)


def sector_pct(name: str) -> float | None:
    """按题材名找对应板块涨幅：精确名 → 映射表 → 名字互相包含，取匹配板块的均值。"""
    return _pct_from(boards(), name)


BAD_MAIN = re.compile(r"业绩|三季报|半年报|预增|扭亏|摘帽|高送转|ST|公告|回购|增持|中标|订单|涨价|次新", re.I)


def _reason_main(reason: str, hybk: str) -> str:
    """取涨停原因里第一个「像板块」的词做主分类，再用 CANON 合并同题材的细分写法。"""
    toks = []
    for tok in re.split(r"[+＋、,，/\s]+", reason or ""):
        t = tok.strip()
        if not t or t.lower() in GENERIC or re.fullmatch(r"[0-9.%]+", t):
            continue
        if "摘帽" in t or t.upper().startswith("ST"):
            continue
        toks.append(t[:16])
    sector_toks = [t for t in toks if not BAD_MAIN.search(t)]
    main = (sector_toks or toks or [""])[0]
    for pat, name in CANON_RE:
        if pat.search(main):
            return name
    return main or (hybk or "其他").strip()


def trading_days(n: int = 40) -> list[str]:
    """用上证指数日线确认交易日（周末/节假日不会误判）。空结果不缓存，避免一次超时把 10 分钟都搞坏。"""
    ts, val = _cache.get(("days", n), (0, []))
    if val and time.time() - ts < 600:
        return val
    try:
        k = kline.fetch("sh000001", "day", n)
        ds = [x["t"] for x in k["items"] if x.get("t")]
    except Exception:
        ds = []
    if ds:
        _cache[("days", n)] = (time.time(), ds)
    return ds


def latest_trading_day() -> str:
    ds = trading_days()
    if ds:
        last = ds[-1]
        return last if last <= today_bj() else today_bj()
    q = _em("getTopicZTPool", today_bj(), pagesize=1)["qdate"]
    return q or today_bj()


def prev_trading_day(day: str) -> str:
    ds = trading_days()
    if ds:
        if day in ds:
            i = ds.index(day)
            return ds[i - 1] if i > 0 else day
        earlier = [d for d in ds if d < day]
        if earlier:
            return earlier[-1]
    d = datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def build(day: str | None = None) -> dict:
    if day is None:
        today = today_bj()
        zt = _em("getTopicZTPool", today)
        q = zt["qdate"]
        if q and q == today:
            day = today
        else:  # 未开盘 / 休市：以东财给的最新交易日为准
            day = q or latest_trading_day()
            if day == today:
                day = latest_trading_day()
            zt = _em("getTopicZTPool", day)
    else:
        zt = _em("getTopicZTPool", day)
    # 东财炸板池/跌停池、同花顺涨停原因、市场状态互不依赖，并发抓，省 3~4 个串行 RTT
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_zb = ex.submit(_em, "getTopicZBPool", day)
        f_dt = ex.submit(_em, "getTopicDTPool", day)
        f_ths = ex.submit(_ths_pool, day)
        f_st = ex.submit(quotes.market_status)
        zb, dt, ths, st = f_zb.result(), f_dt.result(), f_ths.result(), f_st.result()

    tmap = {str(x.get("code")): x for x in ths}
    stocks = []
    for x in zt["pool"]:
        code = str(x.get("c") or "")
        t = tmap.get(code) or {}
        lbc = int(x.get("lbc") or 0) or 1
        reason = (t.get("reason_type") or "").strip()
        stocks.append({
            "code": code, "name": x.get("n") or "", "lbc": lbc,
            "days": t.get("high_days") or (f"{lbc}板" if lbc > 1 else "首板"),
            "reason": reason, "type": t.get("limit_up_type") or "",
            "fund": round(float(x.get("fund") or 0) / 1e8, 2),      # 封单，亿
            "fbt": _hhmm(x.get("fbt")), "hybk": (x.get("hybk") or "").strip(),
            "turnover": round(float(x.get("hs") or 0), 1),
            "sector": _reason_main(reason, x.get("hybk") or ""),
        })
    stocks.sort(key=lambda s: (-s["lbc"], -s["fund"]))

    by = {}
    for s in stocks:
        by.setdefault(s["sector"], []).append(s)
    sectors = []
    for name, arr in by.items():
        arr.sort(key=lambda s: (-s["lbc"], -s["fund"]))
        top = arr[0]
        reasons = Counter(a["reason"] for a in arr if a["reason"])
        sectors.append({
            "name": name, "count": len(arr),
            "first": sum(1 for a in arr if a["lbc"] <= 1),
            "lian": sum(1 for a in arr if a["lbc"] > 1),
            "max_board": top["lbc"], "max_name": top["name"],
            "max_days": top["days"],
            "fund": round(sum(a["fund"] for a in arr), 2),
            "leader": top["name"],
            "stocks": [a["name"] for a in arr[:5]],
            "why": (reasons.most_common(1)[0][0] if reasons else "")[:40],
            "pct": sector_pct(name),
            "tier": "主线" if len(arr) >= TIER_MAIN else "支线" if len(arr) >= TIER_SUB else "轮动",
        })
    sectors.sort(key=lambda x: (-x["count"], -x["max_board"], -x["fund"]))

    zt_total = len(stocks) or zt["tc"]
    lian = sum(1 for s in stocks if s["lbc"] > 1)
    zb_n = zb["tc"]
    top = max(stocks, key=lambda s: s["lbc"]) if stocks else None
    return {
        "day": day, "weekday": weekday(day), "live": day == today_bj() and st["state"] != "closed",
        "fetched_at": datetime.now(BJ).strftime("%H:%M"),
        "total": zt_total, "first": zt_total - lian, "lian": lian,
        "max_board": top["lbc"] if top else 0,
        "max_name": top["name"] if top else "",
        "max_days": top["days"] if top else "",
        "zhaban": zb_n,
        "zhaban_rate": round(zb_n / (zt_total + zb_n) * 100, 1) if zt_total + zb_n else 0,
        "dieting": dt["tc"], "yi": sum(1 for s in stocks if s["type"] == "一字板"),
        "sectors": sectors, "stocks": stocks,
        "concepts": concepts()[:12],
    }


def _hhmm(v) -> str:
    try:
        s = str(int(v)).zfill(6)
        return f"{s[:2]}:{s[2:4]}"
    except (TypeError, ValueError):
        return ""


def _lean(s: dict) -> dict:
    """只留页面需要的字段，减小体积。"""
    return {"day": s["day"], "weekday": s.get("weekday") or weekday(s["day"]),
            "at": s.get("at") or s.get("fetched_at") or "",
            "totals": {k: s.get(k) for k in
                       ("total", "first", "lian", "max_board", "max_name", "zhaban",
                        "zhaban_rate", "dieting", "yi")},
            "sectors": [{"name": x["name"], "count": x["count"], "max_board": x["max_board"],
                         "max_name": x["max_name"], "tier": x["tier"], "fund": x.get("fund"),
                         "pct": x.get("pct"),
                         "leader": x.get("leader"), "stocks": x.get("stocks") or [],
                         "members": [[z.get("code") or "", z.get("name") or "", z.get("lbc") or 1]
                                     for z in (s.get("stocks") or []) if z.get("sector") == x["name"]][:60],
                         "why": x.get("why") or ""} for x in s["sectors"]],
            "concepts": s.get("concepts", [])[:8]}


# ---------- 快照 ----------
def snap_path(day: str, kind: str) -> Path:
    return SNAP_DIR / f"{day}_{kind}.json"


def save(kind: str, s: dict | None = None) -> dict:
    s = s or build()
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    snap_path(s["day"], kind).write_text(json.dumps({"kind": kind, "at": s["fetched_at"], **s},
                                                    ensure_ascii=False), encoding="utf-8")
    for f in sorted(SNAP_DIR.glob("*.json"))[:-120]:
        f.unlink(missing_ok=True)
    return s


def load(day: str, kind: str) -> dict | None:
    p = snap_path(day, kind)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _prev_trading_day(day: str) -> str:
    return prev_trading_day(day)


def compare(base: dict, cur: dict) -> dict:
    """以 base 板块家数为基准，给出 cur 的增减与新晋/断板。"""
    b = {x["name"]: x for x in base["sectors"]}
    c = {x["name"]: x for x in cur["sectors"]}
    rows = []
    for name, x in c.items():
        old = b.get(name)
        rows.append(dict(x, prev=old["count"] if old else 0, delta=(x["count"] - old["count"]) if old else x["count"],
                         new=old is None, prev_board=old["max_board"] if old else 0))
    gone = [x for n, x in b.items() if n not in c]
    return {"rows": rows, "gone": gone}


_bg_lock = threading.Lock()
_bg_running = False
# 「今日热门」最多可以直接用 5 分钟内的实时快照秒回；再旧就必须现抓，
# 否则早上 10:00 的快照会在每次缓存过期后被当成「今日热门」反复端出来。
SNAP_LIVE_SEC = 300


def _snap_at(snap: dict) -> datetime | None:
    """快照的抓取时刻（day + at/fetched_at，均为北京时间）。"""
    day = str(snap.get("day") or "")
    at = str(snap.get("at") or snap.get("fetched_at") or "")
    if not day:
        return None
    try:
        if at:
            return datetime.strptime(f"{day} {at}", "%Y-%m-%d %H:%M").replace(tzinfo=BJ)
        return datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=BJ)
    except ValueError:
        return None


def _latest_snap() -> dict | None:
    """磁盘上最近一份完整快照。

    只认「收盘」和「实时」两种：am（10:00 快照）永远不能当作今日最新，
    同一天优先 close（cron 收盘快照）> live。
    """
    if not SNAP_DIR.exists():
        return None
    cand: list[tuple[tuple[str, int, str], dict]] = []
    for f in sorted(SNAP_DIR.glob("*.json"), reverse=True)[:40]:
        try:
            s = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(s, dict) or s.get("sectors") is None or not s.get("day"):
            continue
        kind = str(s.get("kind") or f.stem.rsplit("_", 1)[-1])
        if kind not in ("close", "live"):
            continue
        cand.append(((str(s["day"]), 2 if kind == "close" else 1,
                      str(s.get("at") or "")), s))
    if not cand:
        return None
    return max(cand, key=lambda x: x[0])[1]


def _snap_fresh(snap: dict) -> bool:
    """快照是不是「够新」：4 天内（覆盖周末与长假前的最后一个交易日）。"""
    try:
        d = datetime.strptime(snap["day"], "%Y-%m-%d").date()
        return (datetime.now(BJ).date() - d).days <= 4
    except Exception:
        return False


def _snap_usable(snap: dict) -> bool:
    """这份快照能不能直接当页面上的「最新」用。

    - 历史交易日：可以（那天的行情已经定型）；
    - 今天：close 快照要等 15:00 后；live 快照只在 5 分钟内有效。
    """
    if not _snap_fresh(snap):
        return False
    day = str(snap.get("day") or "")
    today = today_bj()
    if day < today:
        return True
    if day > today:
        return False
    kind = str(snap.get("kind") or "")
    if kind == "close":
        now = datetime.now(BJ)
        return now.hour * 100 + now.minute >= 1500
    at = _snap_at(snap)
    if at is None:
        return False
    return (datetime.now(BJ) - at).total_seconds() <= SNAP_LIVE_SEC


def _snap_needs_refresh(snap: dict) -> bool:
    """用快照秒回时，要不要再后台现抓一次。

    - 今天的 close：收盘定稿，不再刷新；
    - 今天的 live：盘中会继续变，后台补一次；
    - 历史交易日的 close：盘前先秒回，9:15 后（集合竞价开始）再后台刷新。
    """
    day = str(snap.get("day") or "")
    today = today_bj()
    if day == today:
        return str(snap.get("kind") or "") != "close"
    if not quotes.is_trading_day(today):
        return False
    now = datetime.now(BJ)
    return now.hour * 100 + now.minute >= 915


def _prev_snap(day: str) -> dict | None:
    for kind in ("close", "live"):
        s = load(day, kind)
        if s and s.get("sectors") is not None:
            return s
    return None


def _write_snap(day: str, kind: str, s: dict, overwrite: bool = False) -> None:
    """把现抓到的数据落盘，下一次冷启动/切页就能秒回。"""
    if not day or s.get("day") != day:
        return
    p = snap_path(day, kind)
    if p.exists() and not overwrite:
        return
    try:
        SNAP_DIR.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"kind": kind, "at": s.get("fetched_at"), **s}, ensure_ascii=False),
                     encoding="utf-8")
    except Exception:
        pass


def _save_if_absent(day: str, kind: str, s: dict) -> None:
    """已有文件不覆盖，cron 写的优先。"""
    _write_snap(day, kind, s, overwrite=False)


def _fill_live_bits(out: dict) -> dict:
    """快照路径：用当前板块涨幅与热门概念补齐快照里缺的字段。

    最多等 1.5 秒；超时就直接返回快照（涨幅那一栏先空着，后台刷新随后会补上）。
    """
    res: dict = {}

    def go():
        try:
            b = boards()
            res["pct"] = {s["name"]: _pct_from(b, s["name"]) for s in out["latest"]["sectors"]}
        except Exception:
            res["pct"] = {}
        try:
            res["concepts"] = concepts()
        except Exception:
            res["concepts"] = []

    t = threading.Thread(target=go, daemon=True)
    t.start()
    t.join(1.5)
    if t.is_alive():
        return out

    pcts = res.get("pct") or {}
    today_day = out["latest"]["day"]
    for blk in (out["latest"], out["am"]):
        if blk.get("day") != today_day:
            continue
        for sec in blk["sectors"]:
            if sec.get("pct") is None:
                sec["pct"] = pcts.get(sec["name"])
    c = res.get("concepts") or []
    if c:
        out["concepts"] = c[:12]
        for blk in (out["latest"], out["am"]):
            if blk.get("day") == today_day:
                blk["concepts"] = c[:8]
    return out


def _refresh_bg() -> None:
    """后台重建一次 payload，不阻塞当前请求（同一个进程里只会跑一个）。"""
    global _bg_running
    with _bg_lock:
        if _bg_running:
            return
        _bg_running = True

    def run():
        global _bg_running
        try:
            payload(force=True)
        except Exception:
            pass
        finally:
            with _bg_lock:
                _bg_running = False

    threading.Thread(target=run, daemon=True).start()


def _compose(cur: dict, prev: dict | None = None, fresh: bool = False) -> dict:
    cur_day = cur["day"]
    prev_day = _prev_trading_day(cur_day)
    if prev is None:
        prev = _cached(("build", prev_day), lambda: build(prev_day), 600)
    am = load(cur_day, "am")
    close_prev = load(prev_day, "close")
    if close_prev:
        prev = close_prev
    # 现抓到的交易日数据落盘，后续冷启动不再等上游。
    # 现抓的 live 覆盖旧快照，避免早上 10:00 的「live」一直冒充实时。
    _save_if_absent(prev_day, "close", prev)
    if fresh:
        _write_snap(cur_day, "live", cur, overwrite=True)
    else:
        _save_if_absent(cur_day, "live", cur)

    cmp_cur = {x["name"]: x["count"] for x in cur["sectors"]}
    cmp_prev = {x["name"]: x["count"] for x in prev["sectors"]}
    new_secs = [x["name"] for x in cur["sectors"] if x["name"] not in cmp_prev][:6]
    gone_secs = [x["name"] for x in prev["sectors"] if x["name"] not in cmp_cur][:6]

    am_view = am if am else cur
    prev_am = load(prev_day, "am")
    return {
        "now": datetime.now(BJ).strftime("%Y-%m-%d %H:%M"),
        "today": today_bj(),
        "yesterday": _lean(prev) | {"cmp": cmp_cur},
        "am": _lean(am_view) | {"exists": bool(am), "is_today": bool(am), "cmp": cmp_prev,
                                "prev_am": bool(prev_am),
                                "label": "10:00 快照" if am else "暂无 10:00 快照（以下为最新）"},
        "latest": _lean(cur) | {"cmp": cmp_prev, "new": new_secs, "gone": gone_secs},
        "concepts": cur["concepts"],
        "stocks": cur["stocks"][:40],
    }


def payload(force: bool = False) -> dict:
    """热门板块整包。

    冷启动优先用磁盘快照秒回（同时后台刷新），避免每次重启后第一次打开
    都卡在现抓上游的 9~10 秒上。
    """
    key = ("payload", today_bj())
    ts, val = _cache.get(key, (0, None))
    if val is not None and not force and time.time() - ts < 45:
        return val

    if force:
        # 手动「实时刷新」要把上游缓存一起打掉，否则只是换个壳，里面还是 5 分钟前的涨幅/家数
        for k in list(_cache.keys()):
            if k[0] in ("build", "concepts", "boards"):
                _cache.pop(k, None)

    if not force:
        snap = _latest_snap()
        if snap and _snap_usable(snap):
            prev_day = _prev_trading_day(snap["day"])
            prev = _prev_snap(prev_day)
            if prev is not None:
                out = _fill_live_bits(_compose(snap, prev))
                _cache[key] = (time.time(), out)
                if _snap_needs_refresh(snap):
                    _refresh_bg()
                return out

    out = _compose(_cached(("build", today_bj()), lambda: build(), 60), fresh=True)
    _cache[key] = (time.time(), out)
    return out


# ---------- 文本（cron 推送） ----------
def _sec_line(x: dict, cmp: dict | None = None) -> str:
    d = ""
    if cmp is not None:
        old = cmp.get(x["name"])
        if old is None:
            d = "，新晋"
        elif x["count"] - old:
            d = f"，{x['count'] - old:+d}"
        else:
            d = "，持平"
    board = f"最高{x['max_board']}板" if x["max_board"] > 1 else "首板"
    return f"- {x['name']} {x['count']}家（{board}，封单{x['fund']:.1f}亿，{x['leader']}）{d}"


def text(kind: str = "am") -> str:
    cur = build()
    prev_day = _prev_trading_day(cur["day"])
    prev = build(prev_day)
    am = load(cur["day"], "am")
    snap = am if (kind == "am" and am) else cur
    cmp = {x["name"]: x["count"] for x in prev["sectors"]}
    at = snap.get("at") or snap.get("fetched_at") or ""
    head = f"【热门板块 · {cur['day']} {weekday(cur['day'])} {at}】"
    if not cur["live"]:
        head = f"【热门板块 · 最近交易日 {cur['day']} {weekday(cur['day'])}】"
    lines = [
        head,
        f"涨停 {snap['total']} 家（连板 {snap['lian']} / 首板 {snap['first']}）· 最高 {snap['max_board']}板 {snap['max_name']}"
        f" · 炸板 {snap['zhaban']} 家（{snap['zhaban_rate']}%）"
        + (f" · 一字板 {snap['yi']} 家" if snap.get("yi") else ""),
        f"对比昨日 {prev['day']} {weekday(prev['day'])}：涨停 {prev['total']} 家（连板 {prev['lian']} / 最高 {prev['max_board']}板）",
        "",
    ]
    main = [x for x in snap["sectors"] if x["tier"] == "主线"][:5]
    sub = [x for x in snap["sectors"] if x["tier"] == "支线"][:5]
    tail = [x for x in snap["sectors"] if x["tier"] == "轮动"][:3]
    if main:
        lines.append("主线（≥6家）")
        lines += [_sec_line(x, cmp) for x in main]
    if sub:
        lines.append("支线（3-5家）")
        lines += [_sec_line(x, cmp) for x in sub]
    if tail:
        lines.append("轮动（1-2家）")
        lines += [_sec_line(x, cmp) for x in tail]
    added = [x["name"] for x in snap["sectors"] if x["name"] not in cmp][:6]
    gone = [x for x in cmp if x not in {y["name"] for y in snap["sectors"]}][:6]
    if added:
        lines.append("新晋：" + "、".join(added))
    if gone:
        lines.append("退潮：" + "、".join(gone))
    if snap.get("concepts"):
        c = "、".join(f"{x['name']}{x['pct']:+.1f}%" + (f"（{x['zt']}家涨停）" if x["zt"] else "")
                      for x in snap["concepts"][:6])
        lines.append("热门概念：" + c)
    lines.append("")
    lines.append("说明：按「涨停原因」合并同类，家数=该题材涨停股数；10:00 数据为盘中快照，晋级/炸板还会变。")
    return "\n".join(lines)


def main() -> None:
    args = sys.argv[1:]
    if "--snapshot" in args:
        kind = args[args.index("--snapshot") + 1] if len(args) > args.index("--snapshot") + 1 else "live"
        s = save(kind)
        if not s.get("total"):
            print(f"热门板块数据未取到（涨停池为空，{datetime.now(BJ):%H:%M}），本次快照跳过。")
            return
        print(text(kind if kind == "am" else "am"))
        return
    print(text("am"))


if __name__ == "__main__":
    main()
