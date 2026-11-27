"""把一段话里提到的「日期 + 标的」拆成多条日程。

用法：`from event_parse import parse; parse(text)` → [{day, title, tag, raw}]

支持写法：
  中际旭创（10月29日）、天孚通信(10月28日)
  10月29日 中际旭创、新易盛
  2026-10-29 贵州茅台 / 10/29 贵州茅台
同一天的多只票合并成一条日程，标题用「、」连接；标签按全文关键词推断。
"""
from __future__ import annotations

import re
from datetime import date, timedelta

# 标签关键词（按顺序命中，先到先得）
TAG_RULES = [
    ("财报", ("财报", "季报", "年报", "中报", "业绩", "披露", "预告")),
    ("美联储", ("美联储", "FOMC", "议息", "鲍威尔", "加息", "降息")),
    ("数据", ("CPI", "PPI", "PMI", "M2", "GDP", "社融", "非农", "数据发布")),
    ("会议", ("全会", "会议", "峰会", "论坛", "发布会", "听证会")),
    ("解禁", ("解禁", "限售")),
    ("期权", ("期权", "交割")),
    ("政策", ("国策", "政策", "国常会", "发改委", "工信部", "证监会", "财政部")),
]
TAGS = ["日程", "财报", "美联储", "数据", "会议", "政策", "解禁", "期权"]

# 2026-10-29 / 2026/10/29 / 10月29日 / 10月29号 / 10/29
DATE_RE = re.compile(
    r"(?:(?P<y>\d{4})\s*[年./-]\s*)?(?P<m>\d{1,2})\s*[月./-]\s*(?P<d>\d{1,2})\s*[日号]?"
)
DELIM = "，,。；;：:、！!？?\n\t 　"
# 找名字时不把空格当分隔（「美联储 11月7日」要能取到美联储）
NAME_DELIM = "，,。；;：:、！!？?\n\t"
NAME_RE = re.compile(r"[\u4e00-\u9fa5A-Za-z0-9*·]{2,12}")


def _norm(text: str) -> str:
    return (text or "").replace("（", "(").replace("）", ")").replace("～", "-").strip()


def _tag_of(text: str) -> str:
    for tag, keys in TAG_RULES:
        if any(k in text for k in keys):
            return tag
    return "日程"


def _resolve(y: str | None, m: int, d: int, today: date) -> date | None:
    try:
        if y:
            return date(int(y), m, d)
        base = date(today.year, m, d)
    except ValueError:
        return None
    # 没写年份：跨年时（写的是 1 月、现在 12 月）顺延到下一年；太久以前也顺延
    if base < today - timedelta(days=45):
        try:
            base = date(today.year + 1, m, d)
        except ValueError:
            return None
    return base


def _name_before(text: str, pos: int) -> str:
    """日期左边同一个分句里的名称（跳过括号、空格）。"""
    seg = text[:pos]
    for i in range(len(seg) - 1, -1, -1):
        if seg[i] in NAME_DELIM:
            seg = seg[i + 1:]
            break
    seg = seg.strip(" (（）[【]")
    m = NAME_RE.search(seg[-14:]) if seg else None
    if not m:
        return ""
    name = m.group(0).strip()
    # 去掉「例如」「以及」这类连接词开头
    for p in ("以及", "例如", "包括", "其中", "另外", "且", "和", "与"):
        if name.startswith(p) and len(name) > len(p) + 1:
            name = name[len(p):]
    # 时间词不是事件名（「下周三（11月4日）国常会」应取后面的国常会）
    if re.match(r"^(周[一二三四五六日天]|下周|本周|这周|今天|明天|后天|当日|同日|次日|月底|月初)", name):
        return ""
    return name if 2 <= len(name) <= 12 else ""


def _names_after(text: str, pos: int) -> list[str]:
    """日期后面紧跟的名称（「10月29日 中际旭创、新易盛」这种写法）。"""
    seg = text[pos:].lstrip(" 　、,，）)】](")
    m = re.match(
        r"((?:[\u4e00-\u9fa5A-Za-z0-9*·]{2,12})(?:\s*[、,，]\s*[\u4e00-\u9fa5A-Za-z0-9*·]{2,12})*)",
        seg,
    )
    if not m:
        return []
    names = [x.strip() for x in re.split(r"[、,，]", m.group(1)) if x.strip()]
    # 明显是动词/连接词的不要当成名字
    stop = {"将", "等", "发布", "公布", "召开", "举行", "披露", "亮相", "议息", "非农"}
    out = []
    for x in names:
        if x in stop or len(x) < 2 or len(x) > 10:
            continue
        if re.search(r"\d+\s*[月./-]\s*\d+", x):  # 「11月10日解禁」这类不是名字
            continue
        out.append(x)
    return out[:8]


def parse(text: str, today: date | None = None) -> list[dict]:
    """返回 [{day, title, tag, names}]，同一天合并成一条，按日期升序。"""
    text = _norm(text)
    if not text:
        return []
    today = today or date.today()
    tag = _tag_of(text)
    buckets: dict[str, list[str]] = {}
    spare: dict[str, str] = {}

    for m in DATE_RE.finditer(text):
        day = _resolve(m.group("y"), int(m.group("m")), int(m.group("d")), today)
        if not day or (day - today).days > 400:
            continue
        key = day.isoformat()
        before = _name_before(text, m.start())
        names = [before] if before else _names_after(text, m.end())
        if names:
            bucket = buckets.setdefault(key, [])
            for n in names:
                if n not in bucket:
                    bucket.append(n)
        else:
            # 光秃秃的日期：用这一分句的文字当标题（去掉日期本身和括号）
            clause = text[max(0, m.start() - 30):m.end() + 30]
            clause = DATE_RE.sub("", clause).strip(DELIM + "()")
            spare.setdefault(key, clause[:40])

    out = []
    for key in sorted(buckets.keys() | spare.keys()):
        names = buckets.get(key) or []
        title = "、".join(names[:8]) if names else spare.get(key, "")
        if not title:
            continue
        out.append({"day": key, "title": title, "tag": tag, "names": names})
    return out
