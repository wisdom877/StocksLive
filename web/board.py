"""标签选股：东方财富 F10 板块成分（按概念名查全市场个股）+ 同花顺热门板块做候选。

- 成分：datacenter-web RPT_F10_CORETHEME_BOARDTYPE，filter=(BOARD_NAME="人形机器人")
  同时取 SELECTED_BOARD_REASON（入选理由），按理由把成分分成 核心/相关/沾边。
  东财 F10 的板块是“沾边”口径（人工智能 755 只，连环保、建材都在），
  所以不直接把它当“纯题材”，只把理由按证据强弱分层，前端默认按纯度排序。
- 候选：同花顺 hot_list plate（20 个当下热门概念）
- 标签名解析：精确名 → 常见别名（PCB概念→PCB、CPO→CPO概念）→ 东财 suggest 搜索。
  同花顺和东财命名经常对不上，不解析的话“PCB概念/CPO/芯片概念/猪肉”点了会空列表。
- 手动纠错：tag_marks 表存 pin/hide，按解析后的标准板块名存储。
行情用腾讯批量补齐（价格/涨幅/换手/流通市值）。
"""
from __future__ import annotations

import re
import threading
import time

import requests

import quotes
import store

EM_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
THS_PLATE = "https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate?type=concept"
SUGGEST_URL = "https://searchapi.eastmoney.com/api/suggest/get"
SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}
THS_HEADERS = {"User-Agent": "Mozilla/5.0"}
SUGGEST_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.eastmoney.com/"}

# 同花顺热门概念名 → 东财 F10 板块名
ALIASES = {
    "PCB概念": "PCB",
    "共封装光学(CPO)": "CPO概念",
    "共封装光学": "CPO概念",
    "CPO": "CPO概念",
    "芯片": "半导体概念",
    "芯片概念": "半导体概念",
    "猪肉": "猪肉概念",
    "海峡两岸": "福建板块",
    "算力": "算力概念",
    "算力租赁": "算力概念",
    "光模块": "光通信模块",
}

# 入选理由里的证据强度。目的不是判行业，而是回答“它为什么在这个板块里”：
# 是主营/产品，还是互动回复/战略合作/成立小组/管理赋能这类沾边证据。
_STRONG_BIZ = re.compile(
    r"主营业务|主要产品|主要从事|核心业务|核心产品|产品包括|产品涵盖|产品覆盖|"
    r"自主研发|招股书|公司是.{0,20}(供应商|龙头)|市占率|收入占比"
)
_FOCUS = re.compile(r"专注于|致力于|全球首个|首家|领先的|龙头企业")
_WEAK_COOP = re.compile(
    r"战略合作|签署.{0,12}(协议|备忘录)|达成合作|联手|参股|"
    r"成立.{0,12}(小组|研究院|实验室|中心|事业部)"
)
_MGMT = re.compile(
    r"管理效能|管理效率|降本增效|提质增效|内部管理|办公效率|运营效率|"
    r"数字化管理|管理水平|赋能.{0,8}(管理|效率|办公|运营)"
)
_SUBSTANCE = re.compile(
    r"产品|技术|平台|解决方案|芯片|算法|模型|系统|软件|硬件|服务|研发|"
    r"客户|供应商|应用|业务|收入|产能|项目|专利|订单"
)

TIER_LABEL = {"core": "核心", "related": "相关", "peripheral": "沾边"}
TIER_RANK = {"core": 1, "related": 2, "peripheral": 3}
RESOLVE_TTL = 6 * 3600
RESOLVE_NEG_TTL = 600
MEMBERS_TTL = 300
MAX_ROWS = 2000

_resolve_cache: dict[str, tuple[float, dict]] = {}
_resolve_lock = threading.Lock()
_members_cache: dict[str, tuple[float, list[dict]]] = {}
_members_lock = threading.Lock()


def hot_tags() -> list[dict]:
    try:
        r = requests.get(THS_PLATE, headers=THS_HEADERS, timeout=8)
        rows = (r.json().get("data") or {}).get("plate_list") or []
        return [{"name": x.get("name") or "", "pct": round(float(x.get("rise_and_fall") or 0), 2)}
                for x in rows if x.get("name")]
    except Exception:
        return []


def _escape(name: str) -> str:
    return name.replace("\\", "\\\\").replace('"', '\\"')


def _strip_suffix(name: str) -> str:
    # 同花顺/用户常带这些尾巴；只在精确名失败后用于“再试一次”
    return re.sub(r"(概念|板块|租赁|设备|材料|零部件|服务|应用|产业|主题|指数)$", "", name or "").strip()


def _board_count(name: str) -> int:
    """只查 count，用来判断东财 F10 里有没有这个板块。"""
    if not name:
        return 0
    try:
        r = requests.get(EM_URL, params={
            "reportName": "RPT_F10_CORETHEME_BOARDTYPE",
            "columns": "SECURITY_CODE",
            "filter": f'(BOARD_NAME="{_escape(name)}")',
            "pageNumber": 1, "pageSize": 1,
        }, headers=HEADERS, timeout=10)
        res = r.json().get("result") or {}
        return int(res.get("count") or 0)
    except Exception:
        return 0


def _suggest_boards(q: str) -> list[str]:
    """东财搜索联想里的板块名（Classify=BK / 板块）。"""
    if not q:
        return []
    try:
        r = requests.get(SUGGEST_URL, params={
            "input": q, "type": "14", "token": SUGGEST_TOKEN, "count": "50",
        }, headers=SUGGEST_HEADERS, timeout=8)
        rows = ((r.json().get("QuotationCodeTable") or {}).get("Data") or [])
    except Exception:
        return []
    out: list[str] = []
    for x in rows:
        if x.get("Classify") == "BK" or x.get("SecurityTypeName") == "板块":
            name = (x.get("Name") or "").strip()
            if name and name not in out:
                out.append(name)
    return out


def resolve_tag(tag: str) -> dict:
    """把用户/同花顺的标签名解析成东财 F10 板块名，并给出找不到时的候选。"""
    raw = (tag or "").strip()
    if not raw:
        return {"tag": "", "requested": "", "resolved": False, "suggestions": [], "error": "标签为空"}

    now = time.time()
    with _resolve_lock:
        hit = _resolve_cache.get(raw)
        if hit and now - hit[0] < (RESOLVE_TTL if not hit[1].get("error") else RESOLVE_NEG_TTL):
            return dict(hit[1])

    candidates: list[str] = []

    def add(name: str | None) -> None:
        name = (name or "").strip()
        if name and name not in candidates:
            candidates.append(name)

    stripped = _strip_suffix(raw)
    add(raw)
    add(ALIASES.get(raw))
    if stripped != raw:
        add(stripped)
        add(ALIASES.get(stripped))

    # 1) 精确名 / 常见别名
    for name in candidates:
        if _board_count(name) > 0:
            res = {"tag": name, "requested": raw, "resolved": name != raw,
                   "suggestions": [], "error": ""}
            with _resolve_lock:
                _resolve_cache[raw] = (now, res)
            return res

    # 2) 东财搜索联想
    suggestions: list[str] = []
    for q in [raw, stripped, ALIASES.get(raw), ALIASES.get(stripped)]:
        for name in _suggest_boards(q or ""):
            if name in suggestions:
                continue
            suggestions.append(name)
            if _board_count(name) > 0:
                res = {"tag": name, "requested": raw, "resolved": name != raw,
                       "suggestions": [], "error": ""}
                with _resolve_lock:
                    _resolve_cache[raw] = (now, res)
                return res

    res = {"tag": raw, "requested": raw, "resolved": False,
           "suggestions": suggestions[:5],
           "error": f"东财没有「{raw}」这个板块"}
    with _resolve_lock:
        _resolve_cache[raw] = (now, res)
    return res


def _fetch_members(board: str) -> list[dict]:
    """一次取全板块成分；接口单页上限 1000，超过就翻页。结果缓存 5 分钟。"""
    now = time.time()
    with _members_lock:
        hit = _members_cache.get(board)
        if hit and now - hit[0] < MEMBERS_TTL:
            return hit[1]

    rows: list[dict] = []
    page = 1
    while True:
        r = requests.get(EM_URL, params={
            "reportName": "RPT_F10_CORETHEME_BOARDTYPE",
            "columns": "SECURITY_CODE,SECURITY_NAME_ABBR,BOARD_NAME,BOARD_CODE,IS_PRECISE,"
                       "SELECTED_BOARD_REASON",
            "filter": f'(BOARD_NAME="{_escape(board)}")',
            "pageNumber": page, "pageSize": 1000,
        }, headers=HEADERS, timeout=20)
        j = r.json()
        res = j.get("result") or {}
        batch = res.get("data") or []
        if not batch:
            break
        rows.extend(batch)
        total = int(res.get("count") or 0)
        if len(rows) >= total or len(rows) >= MAX_ROWS:
            break
        page += 1

    with _members_lock:
        _members_cache[board] = (now, rows)
    return rows


def _tier(reason: str) -> tuple[str, str]:
    """按入选理由判断证据强度：core/related/peripheral。"""
    s = (reason or "").strip()
    if not s:
        return "peripheral", TIER_LABEL["peripheral"]
    strong = bool(_STRONG_BIZ.search(s)) or (bool(_FOCUS.search(s)) and bool(_SUBSTANCE.search(s)))
    weak = bool(_WEAK_COOP.search(s))
    mgmt = bool(_MGMT.search(s))
    subst = bool(_SUBSTANCE.search(s))
    if strong and not mgmt:
        key = "core"
    elif (mgmt and not strong) or (weak and not strong):
        key = "peripheral"
    elif subst:
        key = "related"
    else:
        key = "peripheral"
    return key, TIER_LABEL[key]


def _quote_map(codes: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(codes), 400):
        out.update(quotes.fetch(codes[i:i + 400]))
    return out


def _sort_items(items: list[dict], sort: str, direction: str) -> None:
    sort = sort if sort in ("purity", "pct", "float_cap", "pe") else "purity"
    default_dir = {"purity": "asc", "pct": "desc", "float_cap": "desc", "pe": "asc"}[sort]
    desc = (direction or default_dir).lower() == "desc"

    def key(x: dict):
        pin = 0 if x.get("pinned") else 1
        if sort == "purity":
            rank = x.get("purity_rank") or 3
            return pin, (-rank if desc else rank), -(x.get("pct") or 0)
        if sort == "pct":
            pct = x.get("pct") or 0
            return pin, (-pct if desc else pct)
        if sort == "float_cap":
            cap = x.get("float_cap") or 0
            return pin, (-cap if desc else cap)
        pe = x.get("pe")
        valid = pe is not None and pe > 0
        if desc:
            return pin, 0 if valid else 1, -(pe if valid else 0)
        return pin, 0 if valid else 1, pe if valid else 0

    items.sort(key=key)


def members(tag: str, limit: int = 80, sort: str = "purity", direction: str = "",
            include_hidden: bool = False) -> dict:
    tag = (tag or "").strip()
    if not tag:
        return {"tag": "", "requested": "", "items": [], "error": "标签为空"}

    try:
        limit = int(limit or 0)
    except (TypeError, ValueError):
        limit = 80
    limit = max(0, min(limit, MAX_ROWS))

    resolved = resolve_tag(tag)
    if resolved.get("error"):
        return {"tag": resolved.get("tag") or tag, "requested": tag, "items": [],
                "error": resolved["error"], "suggestions": resolved.get("suggestions") or []}

    board = resolved["tag"]
    try:
        rows = _fetch_members(board)
    except Exception as e:
        return {"tag": board, "requested": tag, "items": [],
                "error": f"板块接口失败：{e}"}
    if not rows:
        return {"tag": board, "requested": tag, "items": [],
                "error": "没有这个标签的成分股（试试更标准的板块名）",
                "suggestions": resolved.get("suggestions") or []}

    marks = store.tag_marks(board)
    by_code: dict[str, dict] = {}
    codes: list[str] = []
    for x in rows:
        c = str(x.get("SECURITY_CODE") or "").strip()
        if not c or c in by_code:
            continue
        by_code[c] = x
        codes.append(c)

    quote_map = _quote_map(codes)
    items: list[dict] = []
    counts = {"core": 0, "related": 0, "peripheral": 0}
    hidden_count = 0
    pinned_count = 0

    for code in codes:
        x = by_code[code]
        reason = (x.get("SELECTED_BOARD_REASON") or "").strip()
        purity_key, purity = _tier(reason)
        mark = marks.get(code, "")
        pinned = mark == "pin"
        hidden = mark == "hide"
        if pinned:
            pinned_count += 1
        if hidden:
            hidden_count += 1
        if hidden and not include_hidden:
            continue

        d = quote_map.get(code) or {}
        counts[purity_key] += 1
        items.append({
            "code": code,
            "name": d.get("name") or (x.get("SECURITY_NAME_ABBR") or "").strip(),
            "price": d.get("price") or 0,
            "pct": round(float(d.get("pct") or 0), 2),
            "turnover_rate": d.get("turnover_rate"),
            "float_cap": d.get("float_cap"),
            "pe": d.get("pe"),
            "purity": purity,
            "purity_key": purity_key,
            "purity_rank": 0 if pinned else TIER_RANK[purity_key],
            "pinned": pinned,
            "hidden": hidden,
            "reason": reason,
        })

    _sort_items(items, sort, direction)
    shown_items = items[:limit] if limit else items
    if limit and include_hidden:
        # 被隐藏的股票可能排在 limit 之外；始终带回，前端才能在「已隐藏」里恢复。
        seen = {x["code"] for x in shown_items}
        shown_items = shown_items + [x for x in items if x["hidden"] and x["code"] not in seen]

    return {
        "tag": board,
        "requested": tag,
        "resolved": bool(resolved.get("resolved")),
        "suggestions": resolved.get("suggestions") or [],
        "total": len(codes),
        "shown": len(shown_items),
        "hidden": hidden_count,
        "pinned": pinned_count,
        "counts": counts,
        "items": shown_items,
    }
