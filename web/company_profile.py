"""公司介绍：东财 F10「公司概况」+「核心题材」。

一次抓两份公开页面数据：
- CompanySurvey/PageAjax  公司简介、所属行业、上市日期、员工数、官网
- OperationsRequired/PageAjax  hxtc 里的 主营业务 / 行业背景 / 核心竞争力 / 经营范围

结果在内存 + data/profile/<code>.json 缓存 12 小时；上游失败时回退旧文件。
"""
from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

import quotes

BASE = Path(__file__).resolve().parent
CACHE_DIR = BASE / "data" / "profile"
TTL = 12 * 3600.0
SURVEY_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax"
CORE_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/OperationsRequired/PageAjax"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Referer": "https://emweb.securities.eastmoney.com/",
}
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _clean(s) -> str:
    """压掉 F10 里的全角空格/连续空行，保留段落。"""
    t = str(s or "").replace("　", " ")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _block(rows: list[dict], kind: str) -> list[dict]:
    out = []
    for x in rows or []:
        if (x.get("KEY_CLASSIF") or "") != kind:
            continue
        title = _clean(x.get("KEYWORD"))
        content = _clean(x.get("MAINPOINT_CONTENT"))
        if title and content:
            out.append({"title": title, "content": content})
    return out


def _secid(code: str) -> str:
    sym = quotes.secid(code)  # sz002747 / sh600519 / bj920001
    return sym.upper()


def _fetch(code: str) -> dict:
    sym = _secid(code)

    def get(url: str, timeout: float) -> dict:
        return requests.get(url, params={"code": sym}, headers=HEADERS, timeout=timeout).json() or {}

    # 两份 F10 互不依赖，并发抓，避免隧道后面等两个 RTT
    with ThreadPoolExecutor(max_workers=2) as ex:
        f_survey = ex.submit(get, SURVEY_URL, 8)
        f_core = ex.submit(get, CORE_URL, 10)
        survey = f_survey.result()
        core = f_core.result()
    jb = ((survey.get("jbzl") or [{}])[0]) or {}
    fxxg = ((survey.get("fxxg") or [{}])[0]) or {}
    hx = core.get("hxtc") or []
    if not jb and not hx:
        raise RuntimeError("东财 F10 没有返回公司资料")
    main = _block(hx, "主营业务")
    background = _block(hx, "行业背景")
    advantages = _block(hx, "核心竞争力")
    scope = next((x for x in _block(hx, "经营范围")), None)
    return {
        "code": code,
        "name": jb.get("SECURITY_NAME_ABBR") or "",
        "org_name": _clean(jb.get("ORG_NAME")),
        "intro": _clean(jb.get("ORG_PROFILE")),
        "industry": _clean(jb.get("EM2016")),
        "industry_csrc": _clean(jb.get("INDUSTRYCSRC1")),
        "list_date": str(fxxg.get("LISTING_DATE") or "")[:10],
        "province": _clean(jb.get("PROVINCE")),
        "employees": jb.get("EMP_NUM"),
        "website": _clean(jb.get("ORG_WEB")),
        "scope": scope["content"] if scope else "",
        "main_business": main,
        "industry_background": background,
        "advantages": advantages,
        "source": "eastmoney",
        "updated_at": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M"),
    }


def _disk_path(code: str) -> Path:
    return CACHE_DIR / f"{code}.json"


def _read_disk(code: str) -> dict | None:
    try:
        return json.loads(_disk_path(code).read_text(encoding="utf-8"))
    except Exception:
        return None


def get(code: str, force: bool = False) -> dict:
    """公司介绍（带缓存）。上游失败时回退旧缓存；从没成功过则抛出。"""
    now = time.time()
    with _lock:
        hit = _cache.get(code)
    if hit and not force and now - hit[0] < TTL:
        return hit[1]

    try:
        d = _fetch(code)
    except Exception:
        old = _read_disk(code)
        if old:
            return old
        raise
    with _lock:
        _cache[code] = (now, d)
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _disk_path(code).write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return d
