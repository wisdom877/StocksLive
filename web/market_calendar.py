"""关键日程：财报披露截止日、美联储议息、ETF 期权到期、LPR + 东方财富财经日历。

系统日程两类来源：
1. 本地规则（下面的 `_events_for_year`）：财报披露截止、ETF 期权到期、FOMC、LPR。
2. 东方财富财经日历（`remote_events`）：行业大会/论坛、各国央行议息、中美核心经济数据，
   现抓 + 30 分钟缓存 + 磁盘兜底；只保留对盯盘有影响的事件，每天最多 3 条。

用户自己加的「日程」条目由 store.upcoming_events() 另取，app.py 合并后一起下发。

FOMC 官方日期每年由 Fed 公布，需要把新年份加进 FOMC_DECISIONS（窗口内的会先从
东财日历取到，这张表是兜底）。
"""
from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

try:  # 站点里跑用 venv 的 requests；缺了就让远端日程静默为空
    import requests
except Exception:  # pragma: no cover
    requests = None

BJ = timezone(timedelta(hours=8))

# 美联储 2026 年议息会议：决议公布（美东第二天 14:00）换算成北京时间。
# 夏令时 3/8–11/1 为 02:00，冬令时为 03:00；2026-10-28 会议 → 10-29 02:00。
FOMC_DECISIONS = {
    "2026-01-29": "03:00",
    "2026-03-19": "02:00",
    "2026-04-30": "02:00",
    "2026-06-18": "02:00",
    "2026-07-30": "02:00",
    "2026-09-17": "02:00",
    "2026-10-29": "02:00",
    "2026-12-10": "03:00",
    "2027-01-28": "03:00",
}


def _mmdd(d: date) -> str:
    return d.strftime("%m-%d")


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """某月第 n 个星期几（weekday: 周一=0 … 周日=6）。"""
    first = date(year, month, 1)
    day = first + timedelta(days=(weekday - first.weekday()) % 7)
    return day + timedelta(days=7 * (n - 1))


def _next_trading(d: date) -> date:
    try:
        import quotes
        while not quotes.is_trading_day(d.strftime("%Y-%m-%d")):
            d += timedelta(days=1)
    except Exception:
        while d.weekday() >= 5:
            d += timedelta(days=1)
    return d


def _events_for_year(year: int) -> list[dict]:
    out: list[dict] = [
        {"day": f"{year}-04-30", "time": "", "kind": "财报",
         "title": "年报 / 一季报披露截止日", "note": "按规定 4 月 30 日前披露"},
        {"day": f"{year}-08-31", "time": "", "kind": "财报",
         "title": "半年报披露截止日", "note": "按规定 8 月 31 日前披露"},
        {"day": f"{year}-10-31", "time": "", "kind": "财报",
         "title": "三季报披露截止日", "note": "按规定 10 月 31 日前披露"},
    ]
    # ETF 期权到期：每月第四个星期三（遇休市顺延到下一个交易日）
    for m in range(1, 13):
        d = _next_trading(_nth_weekday(year, m, 2, 4))
        out.append({"day": d.strftime("%Y-%m-%d"), "time": "", "kind": "期权",
                    "title": "ETF 期权到期日", "note": "每月第四个星期三（遇休市顺延）"})
    for day, tm in FOMC_DECISIONS.items():
        if day.startswith(str(year)):
            out.append({"day": day, "time": tm, "kind": "美联储",
                        "title": "美联储公布利率决议", "note": "北京时间"})
    # LPR 报价：每月 20 日 9:00（遇周末/休市顺延到下一个交易日）
    for m in range(1, 13):
        d = _next_trading(date(year, m, 20))
        out.append({"day": d.strftime("%Y-%m-%d"), "time": "09:00", "kind": "数据",
                    "title": "LPR 报价（1年 / 5年）", "note": "每月 20 日，遇休市顺延"})
    return out


def upcoming(days: int = 14, today: str | None = None) -> list[dict]:
    """今天起 N 天内的关键日程（含今天），按日期/时间排序。"""
    if today:
        base = datetime.strptime(today, "%Y-%m-%d").date()
    else:
        base = datetime.now(BJ).date()
    end = base + timedelta(days=max(1, int(days)))
    events: list[dict] = []
    for y in (base.year, end.year):
        events.extend(_events_for_year(y))
    out = []
    seen = set()
    for e in events:
        try:
            d = datetime.strptime(e["day"], "%Y-%m-%d").date()
        except ValueError:
            continue
        if not (base <= d <= end):
            continue
        key = (e["day"], e["title"])
        if key in seen:
            continue
        seen.add(key)
        out.append(dict(e, weekday=["周一", "周二", "周三", "周四", "周五", "周六", "周日"][d.weekday()]))
    out.sort(key=lambda x: (x["day"], x.get("time") or "99:99", x["title"]))
    return out


# ---------------- 东方财富财经日历：行业大会 / 央行议息 / 中美核心数据 ----------------
# 接口实测（2026-10）：reportName=RPT_CPH_FECALENDAR 可按 START_DATE 过滤，字段
# START_DATE/END_DATE/FE_NAME/FE_TYPE/CITY。原始数据很吵（400+ 条/两周，含各国库存、
# 官员讲话、逆回购到期），所以这里做三层过滤：类型白名单 → 指标白名单 → 每天最多 3 条。

EM_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
EM_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/cjrl/"}
REMOTE_TTL = 1800  # 30 分钟缓存；日程是低频变化数据，不用每次请求都打上游
CACHE_PATH = Path(__file__).with_name("data") / "em_calendar.json"
MAX_PER_DAY = 3

_MEET_TYPES = {"行业会议", "世界互联网大会", "高峰论坛", "其他会议", "政策", "论坛"}
_MEET_BIG = {"行业会议", "世界互联网大会", "高峰论坛"}  # 有产业映射的大会，优先于普通会见
_NOISE = re.compile(
    r"逆回购到期|发表讲话|致辞|演讲|新闻发布会|会议纪要|CFTC|官方原油售价|评估标准|新规|"
    r"库存[:：]|EIA|DOE|大豆|玉米|小麦|棉花|吞吐量|炼油厂|消费信贷|职位空缺|"
    r"首次申请失业金|四周移动|密歇根|成屋|未决房屋|成房销售|平均小时工资|平均每周|"
    r"出口金额:季调|进口金额:季调|贸易差额|库存量:|引伸需求|引申需求|期初库存|"
    r"折年率|期末汇率|产量|开工率|销售:季调"
)
# 中国核心数据：(正则, 展示名)
_CN_DATA = [
    (r"^中国:CPI:同比", "CPI"),
    (r"^中国:PPI:全部工业品:同比", "PPI"),
    (r"^中国:制造业PMI", "制造业PMI"),
    (r"^中国:非制造业PMI:商务活动", "非制造业PMI"),
    (r"^中国:GDP", "GDP"),
    (r"^中国:社会融资规模存量:同比", "社融"),
    (r"^中国:社会融资增量:新增人民币贷款", "新增贷款"),
    (r"^中国:M\d", "M0/M1/M2"),
    (r"^中国:进出口金额:同比", "进出口"),
    (r"^中国:社会消费品零售", "社零"),
    (r"^中国:工业增加值", "工业增加值"),
    (r"^中国:固定资产投资", "固投"),
    (r"^中国:央行外汇储备", "外汇储备"),
    (r"LPR|贷款市场报价利率", "LPR"),
]
# 美国核心数据：只留对 A 股隔夜情绪有直接影响的
_US_DATA = [
    (r"^美国:CPI:非季调:同比", "CPI"),
    (r"^美国:核心CPI:季调:当月同比", "核心CPI"),
    (r"^美国:PPI:季调:同比", "PPI"),
    (r"^美国:核心PPI:季调:当月同比", "核心PPI"),
    (r"^美国:非农就业人数:季调", "非农"),
    (r"^美国:失业率:季调", "失业率"),
    (r"^美国:ISM:PMI:制造业:季调", "ISM制造业PMI"),
    (r"^美国:ISM:服务业PMI:季调", "ISM服务业PMI"),
    (r"^美国:ADP就业人数", "ADP"),
    (r"^美国:零售销售", "零售销售"),
    (r"^美国:GDP", "GDP"),
    (r"^美国:核心PCE|^美国:PCE", "PCE"),
]
_CN_PRI, _US_PRI, _CB_PRI, _MEET_PRI, _MISC_PRI = 9, 7, 10, 8, 3

_remote_cache: dict = {"key": "", "at": 0.0, "events": []}


def _em_rows(start: str, end: str, max_pages: int = 8) -> list[dict]:
    """按日期区间拉东财财经日历原始行；失败抛异常，由调用方兜底。"""
    if requests is None:
        raise RuntimeError("requests 不可用")
    rows: dict = {}
    for page in range(1, max_pages + 1):
        params = {
            "reportName": "RPT_CPH_FECALENDAR", "columns": "ALL",
            "pageNumber": str(page), "pageSize": "100",
            "sortColumns": "START_DATE", "sortTypes": "1",
            "source": "WEB", "client": "WEB",
            "filter": f"(START_DATE>='{start}')(START_DATE<='{end}')",
        }
        resp = requests.get(EM_URL, params=params, timeout=15, headers=EM_HEADERS)
        resp.raise_for_status()
        data = ((resp.json() or {}).get("result") or {}).get("data") or []
        if not data:
            break
        for r in data:
            rows[(r.get("START_DATE"), r.get("FE_NAME"))] = r
        if len(data) < 100:
            break
    return list(rows.values())


def _month_of(name: str) -> str:
    m = re.search(r"报告期[:：](\d{4})年(\d{1,2})月", name or "")
    return f"{int(m.group(2))}月" if m else ""


def _match(rules, name: str):
    for pat, label in rules:
        if re.search(pat, name):
            return label
    return None


def _classify(row: dict) -> dict | None:
    """把一条东财日历行转成日程候选；不要的返回 None。"""
    raw = (row.get("FE_NAME") or "").strip()
    name = raw.replace("：", ":")
    if not raw or _NOISE.search(name):
        return None
    t = (row.get("FE_TYPE") or "").strip()
    day = (row.get("START_DATE") or "")[:10]
    if not day:
        return None
    hm = (row.get("START_DATE") or "")[11:16]
    time_s = "" if hm in ("", "00:00") else hm
    city = (row.get("CITY") or "").strip()

    is_cb = ("议息会议" in t or "央行利率决议" in name or "FOMC" in name
             or "美联储议息" in name)
    if is_cb:
        title = raw
        if "美联储" in name or "FOMC" in name:
            title = "美联储议息会议"
        elif ":" in name and "央行利率决议" in name:
            title = f"{name.split(':')[0]}央行利率决议"
        pri = _CB_PRI + (0.5 if "议息会议" in t else 0.0)
        return {"day": day, "time": time_s, "kind": "央行", "title": title,
                "note": city or "央行利率决议", "_pri": pri, "_merge": None}

    if t in _MEET_TYPES:
        # 「其他会议」里的外事活动（访华/出席开幕式/会见）与盯盘无关，收紧掉
        if t == "其他会议" and re.search(r"访华|访问|将出席|开幕式|运动会|会见|会谈|通话|致电", name):
            return None
        pri = _MEET_PRI if t in _MEET_BIG else _MISC_PRI
        return {"day": day, "time": time_s, "kind": "会议", "title": raw,
                "note": city or t, "_pri": pri, "_merge": None}

    if t == "经济数据":
        country = city
        if country == "中国":
            label = _match(_CN_DATA, name)
            pri = _CN_PRI
        elif country == "美国":
            label = _match(_US_DATA, name)
            pri = _US_PRI
        else:
            return None
        if not label:
            return None
        return {"day": day, "time": time_s, "kind": "数据",
                "title": f"{country} {_month_of(name)}{label}".strip(),
                "note": raw, "_pri": pri, "_merge": (country, label)}
    return None


def _squash(events: list[dict]) -> list[dict]:
    """同一时点的数据合并成一条；同一天标题互相包含的会议去重；每天最多 MAX_PER_DAY 条。"""
    merged: dict = {}
    out: list[dict] = []
    for e in events:
        mk = e.get("_merge")
        if mk:
            key = (e["day"], e["time"], mk[0])
            if key not in merged:
                merged[key] = dict(e, _labels=[mk[1]], _n=1)
                out.append(merged[key])
            else:
                cur = merged[key]
                if mk[1] not in cur["_labels"]:
                    cur["_labels"].append(mk[1])
                cur["_n"] += 1
        else:
            out.append(e)
    # 合并后的数据行重写标题：中国 10月CPI、PPI
    for e in out:
        labels = e.pop("_labels", None)
        e.pop("_n", None)
        if labels:
            country = e["_merge"][0]
            month = _month_of(e["note"])
            e["title"] = f"{country} {month}{'、'.join(labels)}".strip()
    # 同一天标题互相包含 → 只留优先级高的那条（"半导体封测年会" vs "…于11月4-6日在南京举行"）
    keep: list[dict] = []
    cb_seen: set = set()
    for e in sorted(out, key=lambda x: (-x["_pri"], x["day"], x["time"] or "99:99")):
        dup = False
        if e["kind"] == "央行":
            # 同一国家央行同一时点常有「议息会议」+「央行利率决议」两条，按国名去重
            token = re.sub(r"[^\u4e00-\u9fa5]", "", e["title"])[:3]
            ck = (e["day"], e["time"], token)
            if ck in cb_seen:
                dup = True
            else:
                cb_seen.add(ck)
        for k in keep:
            if dup:
                break
            if k["day"] != e["day"]:
                continue
            a, b = e["title"], k["title"]
            if a == b or a in b or b in a:
                dup = True
                break
        if not dup:
            keep.append(e)
    # 每天至多 MAX_PER_DAY 条
    per_day: dict = {}
    final: list[dict] = []
    for e in keep:
        n = per_day.get(e["day"], 0)
        if n >= MAX_PER_DAY:
            continue
        per_day[e["day"]] = n + 1
        final.append(e)
    for e in final:
        e.pop("_merge", None)
        e.pop("_pri", None)
        e["auto"] = True
        e["source"] = "东财日历"
        e["weekday"] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][
            datetime.strptime(e["day"], "%Y-%m-%d").weekday()]
    final.sort(key=lambda x: (x["day"], x.get("time") or "99:99", x["title"]))
    return final


def _read_cache_file() -> list[dict]:
    try:
        return json.loads(CACHE_PATH.read_text("utf-8")).get("events") or []
    except Exception:
        return []


def _write_cache_file(events: list[dict]) -> None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps({"at": time.time(), "events": events}, ensure_ascii=False),
                              "utf-8")
    except Exception:
        pass


def remote_events(days: int = 7, today: str | None = None) -> list[dict]:
    """东财财经日历里未来 N 天的行业大会 / 央行议息 / 中美核心数据。

    抓不到时退回上一次成功结果（磁盘缓存），再退回空列表——日程卡不会因为
    上游抖动整体消失或报错。
    """
    if today:
        base = datetime.strptime(today, "%Y-%m-%d").date()
    else:
        base = datetime.now(BJ).date()
    days = max(1, int(days))
    end = base + timedelta(days=days)
    key = f"{base.isoformat()}|{days}"
    if _remote_cache["key"] == key and time.time() - _remote_cache["at"] < REMOTE_TTL:
        return [dict(e) for e in _remote_cache["events"]]
    try:
        # 上界带上当天时刻，否则最后一天 00:00 之后的事件会被字符串比较漏掉（如 21:30 的美国非农）
        rows = _em_rows(base.isoformat(), end.isoformat() + " 23:59:59")
        events = _squash([c for c in (_classify(r) for r in rows) if c])
        if events:
            _remote_cache.update({"key": key, "at": time.time(), "events": events})
            _write_cache_file(events)
            return [dict(e) for e in events]
        raise RuntimeError("上游无可用事件")
    except Exception:
        cached = _read_cache_file()
        if cached:
            return [dict(e) for e in cached if e.get("day", "") <= end.isoformat()]
        return []

