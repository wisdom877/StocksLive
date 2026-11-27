"""外网 API 标签：取东方财富 F10 所属板块（行业 + 概念），最多 4 个。

F10 会返回 1/2/3 级行业和几十个概念板块，其中 IS_PRECISE=1 是东财标记的精准概念。
行业和概念的区分只用于排序，不再做“只留最纯 1-2 个”的硬限制：

- 行业：只取最细的第 3 级；名字太长且包含第 2 级时收短
  （消费电子零部件及组装 → 消费电子）
- 概念：按与 F10「主营业务」文本的匹配度排序，精准概念优先
- 最多返回 4 个；用于详情和持仓/关注列表展示，自定义标签另存一列
"""
from __future__ import annotations

import re
import threading
import time

import requests

URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"}

# 地域、风格、资金面、指数成分等不是“题材”，不进标签
SKIP = re.compile(r"(板块|小盘|大盘|中盘|股通|融资融券|重仓|增仓|减仓|新进|调研|预增|预减|"
                  r"涨停|跌停|振幅|换手|指数|成分|富时|MSCI|标普|AH股|破净|高股息|低价股|次新股)$")

# 同一只股票 10 分钟内不重复请求 F10（添加弹窗预览 + 保存会连着请求两次）
_CACHE: dict[tuple[str, int], tuple[float, list[str]]] = {}
_CACHE_TTL = 600
_cache_lock = threading.Lock()


def _code(code: str) -> str:
    c = code.strip()
    if c.startswith(("sh", "sz", "bj")):
        return c[2:] + "." + c[:2].upper()
    # 北交所 920xxx 要放在 9 开头（沪 B）之前
    if c[0] == "8" or c[:2] in ("43", "87", "92"):
        return c + ".BJ"
    if c[0] in "569":
        return c + ".SH"
    return c + ".SZ"


def _clean(name: str) -> str:
    n = re.sub(r"(概念|板块)$", "", name).strip()
    return re.sub(r"[ⅠⅡⅢⅣⅤ]+$", "", n).strip()


def _grams(s: str) -> set[str]:
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def _relevance(name: str, texts: list[str]) -> float:
    """概念名在主营业务描述里的匹配度：完整命中加分，再按二字片段覆盖率打分。"""
    best = 0.0
    grams = _grams(name)
    for text in texts:
        score = 0.0
        if name in text:
            score += 10 + len(name)
        if grams:
            score += 10 * sum(1 for g in grams if g in text) / len(grams)
        best = max(best, score)
    return best


def _fetch_tags(code: str, max_tags: int) -> list[str]:
    try:
        r = requests.get(URL, params={"code": _code(code)}, headers=HEADERS, timeout=8)
        j = r.json()
    except Exception:
        return []
    if not isinstance(j, dict):
        return []
    boards = j.get("ssbk") or []
    if not boards:
        return []

    stock_name = (boards[0].get("SECURITY_NAME_ABBR") or "").strip()
    industries: list[tuple[int, str]] = []
    concepts: list[tuple[int, str, bool]] = []
    for b in boards:
        raw = (b.get("BOARD_NAME") or "").strip()
        name = _clean(raw)
        if not raw or not name or SKIP.search(name):
            continue
        try:
            rank = int(b.get("BOARD_RANK") or 99)
        except (TypeError, ValueError):
            rank = 99
        if rank <= 3:
            industries.append((rank, name))
        else:
            concepts.append((rank, name, b.get("IS_PRECISE") == "1"))

    industry = ""
    if industries:
        industries.sort()
        industry = industries[-1][1]
        # 三级行业名太长且包含二级名时收短，如“消费电子零部件及组装”→“消费电子”
        if len(industry) > 6 and len(industries) >= 2 and industries[-2][1] in industry:
            industry = industries[-2][1]

    # 主营业务文本（东财 KEY_CLASSIF_CODE=003），用来判断概念和公司到底有多相关
    texts = [
        f"{h.get('KEYWORD') or ''} {h.get('MAINPOINT_CONTENT') or ''}".strip()
        for h in (j.get("hxtc") or [])
        if h.get("KEY_CLASSIF_CODE") == "003"
    ]
    texts = [t for t in texts if t]

    scored: list[tuple[float, int, int, str]] = []
    seen = {industry}
    for rank, name, precise in concepts:
        if name in seen:
            continue
        # 概念名就是股票自己的简称/全称（如中芯国际 → “中芯”），对分组没意义
        if stock_name and (name in stock_name or stock_name in name):
            continue
        seen.add(name)
        scored.append((_relevance(name, texts), 1 if precise else 0, rank, name))
    # 先按主营业务相关度，其次精准概念，最后按东财板块顺序
    scored.sort(key=lambda x: (-x[0], -x[1], x[2]))

    tags = [industry] if industry else []
    for _score, _precise, _rank, name in scored:
        if len(tags) >= max_tags:
            break
        tags.append(name)
    return tags[:max_tags]


def auto_tags(code: str, max_tags: int = 4) -> list[str]:
    """返回最多 max_tags 个外网 API 标签；成功结果缓存 10 分钟。"""
    key = (code.strip(), max_tags)
    now = time.time()
    with _cache_lock:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _CACHE_TTL:
            return list(hit[1])
    tags = _fetch_tags(code, max_tags)
    if tags:
        with _cache_lock:
            _CACHE[key] = (time.time(), tags)
    return tags
