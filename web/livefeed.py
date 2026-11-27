"""实时新闻：财联社电报（签名接口，主源）+ 金十快讯（兜底）。
只保留「战事 / 宏观」两类，60-90 秒轮询一次，写入 news(source='live')。
"""
from __future__ import annotations

import hashlib
import re
import time
from datetime import datetime, timedelta, timezone

import requests

import store

BJ = timezone(timedelta(hours=8))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

CLS_URL = "https://www.cls.cn/v1/roll/get_roll_list"
JIN10_URL = "https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1"

CATS = [
    ("战事", r"战事|冲突|导弹|无人机|袭击|空袭|开战|停火|制裁|地缘|俄乌|乌克兰|俄罗斯|中东|以色列|伊朗|"
             r"红海|霍尔木兹|军事|核潜艇|航母|台海|朝鲜|半岛|巴勒斯坦|加沙|胡塞|叙利亚|黎巴嫩|也门|"
             r"北约|军演|边境|停战|谈判"),
    ("宏观", r"美联储|降息|加息|央行|LPR|降准|关税|财政部|证监会|国常会|发改委|CPI|PPI|PMI|非农|GDP|"
             r"国债|汇率|人民币|鲍威尔|财政政策|货币政策|白宫|日本央行|欧央行|通胀|就业|关税|"
             r"出口管制|反倾销|刺激计划|预算"),
]

# B 级「重点」判定：财联社加粗（bold）的直接算；普通推送（jpush）再看是否命中
# 宏观/政策/战事关键词。每天的新闻联播、早间精选、投资日历等合集不推。
ALERT_HIGH = re.compile(
    r"央行|中国人民银行|证监会|国务院|国常会|财政部|发改委|降准|降息|加息|LPR|MLF|SLF|"
    r"逆回购|关税|制裁|美联储|FOMC|CPI|PPI|PMI|GDP|非农|印花税|专项债|特别国债|"
    r"人民币汇率|人民币贬值|人民币升值|互换便利|平准基金|政治局|中央经济工作会议|两会|十五五|"
    r"战争|战事|袭击|空袭|导弹|冲突|开战|停火|霍尔木兹|俄乌|伊朗|以色列|中东|台海|"
    r"朝鲜|北约|军演|核潜艇|核设施|航母"
)
ALERT_DIGEST = re.compile(
    r"新闻联播|早间新闻精选|晚间新闻精选|投资日历|隔夜全球要闻|美股盘前要闻|"
    r"美股收盘|你需要知道的|要闻一览"
)


def _flag(v) -> bool:
    """CLS 的 jpush/bold 可能是 0/1/-1，也可能是字符串；-1 也算重点。"""
    try:
        return int(v) != 0
    except (TypeError, ValueError):
        return bool(v)


def is_important(level: str, raw: dict, text: str) -> bool:
    """B 级里值得推到 APK 通知栏的重点电报。"""
    if str(level or "").upper() != "B":
        return False
    body = _clean(text)
    if ALERT_DIGEST.search(body):
        return False
    return _flag(raw.get("bold")) or (_flag(raw.get("jpush")) and bool(ALERT_HIGH.search(body)))



def classify(text: str) -> str:
    for cat, pat in CATS:
        if re.search(pat, text):
            return cat
    if re.search(r"A股|沪指|深成|创业板|涨停|跌停|主力|北向|板块|个股|ETF|成交额|两市|基金", text):
        return "市场"
    if re.search(r"公司|公告|订单|中标|业绩|签约|投产|扩产|收购|重组|净利", text):
        return "行业"
    return "综合"


def _clean(text: str) -> str:
    s = re.sub(r"\s+", " ", (text or "")).strip()
    s = re.sub(r"^财联社\d+月\d+日电，?", "", s)
    s = re.sub(r"^【(.{2,40}?)】財?财联社.*?，", r"【\1】", s)
    return s


def _add(text: str, epoch: int, weight: int, source: str, level: str = "C",
         alert: bool = False) -> dict | None:
    body = _clean(text)
    if len(body) < 10:
        return None
    # 必须按北京时间换算：服务器时区是 UTC，用 localtime 会差 8 小时
    dt = datetime.fromtimestamp(epoch, BJ)
    return {
        "day": dt.strftime("%Y-%m-%d"),
        "category": classify(body),
        "title": body[:store.MAX_LIVE_TITLE],   # 别截断：财联社电报正文常有 200+ 字
        "body": source,
        "weight": weight,
        "level": level,
        "alert": bool(alert),
        "published_at": dt.strftime("%Y-%m-%d %H:%M"),
    }


def _cls_page(cursor: str = "", rn: int = 50) -> list[dict]:
    p = {
        "app": "CailianpressWeb", "category": "", "last_time": cursor, "os": "web",
        "refresh_type": "1", "rn": str(rn), "sv": "7.7.5",
    }
    raw = "&".join(f"{k}={p[k]}" for k in sorted(p))
    p["sign"] = hashlib.md5(hashlib.sha1(raw.encode()).hexdigest().encode()).hexdigest()
    r = requests.get(CLS_URL, params=p, timeout=12,
                     headers={"User-Agent": UA, "Referer": "https://www.cls.cn/telegraph"})
    j = r.json()
    if j.get("errno") != 0:
        raise RuntimeError(f"CLS errno={j.get('errno')}")
    return j["data"]["roll_data"]


def fetch_cls() -> list[dict]:
    """增量拉全量电报：从上次最新 ctime 往前翻页，一条不漏（首次最多 3 页）。"""
    last = int(store.get_meta("cls_last", "0") or 0)
    max_pages = 3 if last == 0 else 20
    out: list[dict] = []
    cursor = ""
    newest = last
    for _ in range(max_pages):
        rows = _cls_page(cursor)
        if not rows:
            break
        for x in rows:
            ctime = int(x.get("ctime") or 0)
            newest = max(newest, ctime)
            if ctime <= last:
                continue
            text = x.get("content") or x.get("title") or ""
            lvl = x.get("level") or "C"
            it = _add(text, ctime, {"A": 9, "B": 8}.get(lvl, 5), "财联社", lvl,
                      alert=is_important(lvl, x, text))
            if it:
                out.append(it)
        if rows[-1].get("ctime", 0) <= last:
            break
        cursor = str(rows[-1]["ctime"])
        time.sleep(0.3)
    if newest > last:
        store.set_meta("cls_last", str(newest))
    return out


def fetch_jin10() -> list[dict]:
    r = requests.get(JIN10_URL, timeout=12, headers={
        "User-Agent": UA, "x-app-id": "bVBF4FyRTn5NJF5n", "x-version": "1.0.0",
        "Referer": "https://www.jin10.com/",
    })
    data = r.json().get("data") or []
    out = []
    for it in data:
        text = (it.get("data") or {}).get("content") or ""
        try:
            dt = datetime.strptime(it["time"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJ)
        except Exception:
            dt = datetime.now(BJ)
        w = 8 if it.get("important") in (1, True) else 6
        body = _clean(text)
        if len(body) < 12:
            continue
        out.append({
            "day": dt.strftime("%Y-%m-%d"), "category": classify(body), "title": body[:store.MAX_LIVE_TITLE],
            "body": "金十快讯", "weight": w, "level": "B" if w >= 8 else "C",
            "published_at": dt.strftime("%Y-%m-%d %H:%M"),
        })
    return out


def refresh() -> dict:
    err = None
    items: list[dict] = []
    try:
        items = fetch_cls()
    except Exception as e:  # 主源失败自动降级
        err = f"cls: {e}"
        try:
            items = fetch_jin10()
        except Exception as e2:
            return {"added": 0, "fetched": 0, "error": f"{err}; jin10: {e2}"}
    added = store.add_live(items)
    return {"added": added, "fetched": len(items), "error": err}
