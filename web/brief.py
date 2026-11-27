"""本站自生成的大盘分析：用自己抓的指数/涨跌家数/成交额/板块/新闻，写出「大盘行情分析」「宏观政策分析」两段。

朋友的日报链（Wind / agent 生成报告段落）早已下线、旧报告段落也清空了，
所以「报告里还没有这一段」永远不会有内容；这里直接由本站数据本地生成，
写进 report_sections（report_id=0，kind='post'），前端 /api/v1/analysis 照旧读。
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta

import hot
import market
import store

REPORT_ID = 0            # 专用占位 id：不和真实报告（report_id>=1）冲突
KIND = "post"
_TTL = 900               # 15 分钟重新生成一次（盘中数字会变）
_lock = threading.Lock()
_last = {"at": 0.0, "day": ""}

import json  # noqa: F401  (预留，便于本地调试落盘)

POLICY_KEYS = ("政策", "印发", "资本市场", "股市", "国务院", "发改委", "财政部", "央行", "人民银行", "降准", "降息",
               "利率", "LPR", "MLF", "证监会", "国常会", "政治局", "会议", "部署",
               "印发", "监管", "数据局", "商务部", "工信部", "住建部",
               "统计局", "专项债", "国债", "改革", "关税", "出口", "消费", "社融",
               "CPI", "PMI", "就业", "楼市", "房地产", "医保", "补贴", "税收")
STRONG_KEYS = ("央行", "降准", "降息", "LPR", "MLF", "国常会", "政治局", "财政部",
               "发改委", "专项债", "社融", "CPI", "PMI", "证监会", "关税")
NOISE_KEYS = ("违纪", "审查调查", "双开", "受贿", "被查", "判刑", "逮捕", "落马",
              "特朗普", "美国国务院", "白宫", "参议院", "众议院", "伊朗", "以色列",
              "俄罗斯", "乌克兰", "哈马斯",
              "美债", "美股", "美国股市", "标普", "纳指", "英伟达", "美联储")
TOTAL_KEYS = ("降准", "降息", "LPR", "MLF", "社融", "赤字率", "专项债")


def _fmt_pct(x) -> str:
    try:
        v = float(x)
    except Exception:
        return "—"
    return f"{v:+.2f}%"


def _num_pos(x) -> bool:
    try:
        return float(x) > 0
    except Exception:
        return False


def _fmt_num(x, nd=2) -> str:
    try:
        return f"{float(x):,.{nd}f}"
    except Exception:
        return "—"


def _today_data_day(m: dict) -> str:
    for row in (m.get("a") or []):
        t = str(row.get("time") or "")
        mo = re.match(r"(\d{2})-(\d{2})", t)
        if mo:
            return f"{datetime.now(store.BJ).year}-{mo.group(1)}-{mo.group(2)}"
    return datetime.now(store.BJ).strftime("%Y-%m-%d")


def _glue(text: str) -> str:
    """统计口径不再往字缝里塞零宽粘连符：文本保持干净（复制/朗读/搜索都正常），
    折行由前端 decorAna 给这些块套 .nw{white-space:nowrap} 来处理。
    这里只负责把历史数据里残留的 U+2060 洗掉。"""
    if not text:
        return text
    return re.sub("[\u2060\u200b\u200c\u200d]", "", text)


def _market_text(m: dict, h: dict) -> str:
    a = m.get("a") or []
    if not a:
        return ""
    lines = []

    # 上游偶发回 0 / 缺价格：宁可整段不出，也别写出「上证指数 0.94」这种假数字
    # 沪深/科创/创业板这些指数点位都在千位以上，周末上游偶发只回个零点几的口径，
    # 用「点位 ≥ 50」把它们挡掉，宁可少一行也不写错数
    parts = [f"{r['name']} {_fmt_num(r.get('price'))}（{_fmt_pct(r.get('pct'))}）" for r in a
             if _num_pos(r.get("price")) and float(r.get("price") or 0) >= 50]
    if parts:
        lines.append("- 指数：" + "、".join(parts) + "。")

    tn = (m.get("turnover") or {})
    tn_text = str(tn.get("text") or "").strip()
    if tn_text and not tn_text.startswith(("0", "—")):
        lines.append(f"- 成交：两市成交 {tn_text}。")

    b = m.get("breadth") or {}
    if b.get("total"):
        up, down, flat = b.get("up", 0), b.get("down", 0), b.get("flat", 0)
        ratio = (up / down) if down else 0
        if down and up <= down * 0.15:
            mood = "普跌、赚钱效应极差"
        elif down > up:
            mood = "跌多涨少，情绪偏弱"
        elif up > down * 2:
            mood = "普涨、情绪偏强"
        else:
            mood = "涨跌互现，结构行情"
        lines.append(f"- 涨跌：涨 {up} 家 / 跌 {down} 家 / 平 {flat} 家（共 {b['total']} 家），"
                     f"涨跌比 {ratio:.2f}，{mood}。")

    # 涨跌停 / 炸板：取最新一份热门统计（没有就取上一交易日）
    block = None
    for k in ("latest", "am", "yesterday"):
        v = h.get(k)
        if isinstance(v, dict) and isinstance(v.get("totals"), dict) and v["totals"].get("total"):
            block = v
            break
    t = (block or {}).get("totals") or {}
    day_label = (block or {}).get("day", "")[5:] or "最近"
    if t:
        seg = f"- 情绪：{day_label}涨停 {t.get('total', 0)} 家、跌停 {t.get('dieting', 0)} 家"
        if t.get("zhaban_rate") is not None:
            seg += f"、炸板率 {t['zhaban_rate']}%"
        if t.get("max_name"):
            seg += f"，最高板 {t.get('max_board', 0)} 板（{t['max_name']}）"
        lines.append(seg + "。")

    secs = []
    for k in ("latest", "am", "yesterday"):
        v = h.get(k)
        if isinstance(v, dict) and v.get("sectors"):
            secs = [x for x in v["sectors"] if isinstance(x, dict) and x.get("name")]
            break
    if secs:
        top = []
        for x in secs[:4]:
            extra = []
            if x.get("count"):
                extra.append(f"{x['count']}家涨停")
            if x.get("pct") is not None:
                extra.append(_fmt_pct(x.get("pct")))
            top.append(f"{x['name']}（{'、'.join(extra)}）" if extra else x["name"])
        lines.append("- 题材：" + "、".join(top) + "。")

    g = [r for r in (m.get("global") or []) if r.get("pct") is not None]
    if g:
        lines.append("- 外盘：" + "、".join(f"{r['name']} {_fmt_pct(r.get('pct'))}" for r in g[:5]) + "。")

    concl = []
    sh = next((r for r in a if "上证" in str(r.get("name"))), a[0])
    try:
        p = float(sh.get("pct"))
        if p <= -2:
            concl.append("指数大幅下挫")
        elif p < 0:
            concl.append("指数小幅收跌")
        elif p >= 2:
            concl.append("指数放量走强")
        else:
            concl.append("指数小幅收涨")
    except Exception:
        pass
    if b.get("up") and b.get("down"):
        if b["down"] > b["up"] * 3:
            concl.append("个股明显弱于指数，属于被指数掩盖的普跌")
        elif b["up"] > b["down"] * 3:
            concl.append("个股普涨、强于指数")
    try:
        amt = float((tn or {}).get("total") or 0)
        if amt:
            concl.append("量能仍在万亿以上，方向要看成交能否继续放大" if amt >= 10000
                         else "量能不足万亿，反弹持续性需要观察")
    except Exception:
        pass
    if concl:
        lines.append("- 小结：" + "；".join(concl) + "。")

    return "\n".join(lines)


def _headline(raw: str) -> str:
    """新闻原文里摘一个不超过 50 字的标题：优先【】内的，否则取第一句。"""
    s = (raw or "").strip()
    mo = re.match(r"^【([^】]{4,80})】", s)
    if mo:
        return mo.group(1).strip()
    s = re.sub(r"^\s*[-*•]\s*", "", s)
    s = s.split("。")[0].split("（")[0].strip()
    return (s[:50] + "…") if len(s) > 50 else s


def _policy_news(limit: int = 6) -> list[dict]:
    since = (datetime.now(store.BJ) - timedelta(hours=72)).strftime("%Y-%m-%d")
    try:
        with store.conn() as c:
            rows = c.execute(
                "SELECT day,title,body,source FROM news WHERE day>=?"
                " ORDER BY day DESC, id DESC LIMIT 300", (since,)).fetchall()
    except Exception:
        return []

    cands, seen = [], set()
    for r in rows:
        d = dict(r)
        head = _headline(d.get("title") or d.get("body") or "")
        if len(head) < 6 or head in seen:
            continue
        text = head
        if any(k in text for k in NOISE_KEYS):
            continue
        if not any(k in text for k in POLICY_KEYS):
            continue
        score = sum(1 for k in STRONG_KEYS if k in text)
        if "会议" in head or "政策" in head:
            score += 1
        cands.append({"day": (d.get("day") or ""), "head": head,
                      "source": (d.get("source") or "").strip(), "score": score})
        seen.add(head)

    cands.sort(key=lambda x: (-x["score"], -int(x["day"].replace("-", "") or 0)))
    return cands[:limit]


def _macro_text(news: list[dict]) -> str:
    lines = []
    if news:
        lines.append(f"- 概览：近 3 日政策面 · 共 {len(news)} 条")
        lines.append("\n".join(
            f"- {n['day'][5:]}　{n['head']}" for n in news))
        total = [n for n in news if any(k in n["head"] for k in TOTAL_KEYS)]
        if total:
            lines.append("- 怎么看：出现了总量政策相关表述，要盯落地节奏（会议到文件、文件到资金），"
                         "落地前只做交易性机会，别提前把仓位押在预期上。")
        else:
            lines.append("- 怎么看：目前以部委、产业和监管口径为主，没有新的总量级货币/财政动作，"
                         "对指数偏中性；这类消息更多是结构性题材的引子，受益方向要看成交能否放量接力。")
    else:
        lines.append("- 近 3 日没有抓到明确的政策类消息（新闻库以产业、公司动态为主）。")
        lines.append("- 怎么看：政策空窗期，指数由资金面主导，不做政策博弈，等新的会议或文件落地再定方向。")
    return "\n".join(lines)


def generate(force: bool = False) -> dict:
    """生成并写入两段分析；15 分钟内不重复生成（force 强制刷新）。"""
    with _lock:
        now = time.time()
        if not force and now - _last["at"] < _TTL and _last["day"]:
            return {"ok": True, "cached": True, "day": _last["day"]}

        m = market.all_market(False)
        try:
            h = hot.payload()
        except Exception:
            h = {}
        day = _today_data_day(m)
        mtext = _glue(_market_text(m, h))
        ntext = _glue(_macro_text(_policy_news()))
        # 上游偶发把「涨跌幅」当成「点位」回：这时整段指数会缺，直接不写，
        # 保留上一次正常的分析，别让面板出现没有指数、只剩结论的残篇
        if not mtext or "- 指数" not in mtext:
            return {"ok": False, "err": "行情数据异常，保留上一版"}
        _save(day, mtext, ntext)
        _last.update(at=now, day=day)
        return {"ok": True, "cached": False, "day": day}


def _save(day: str, market_text: str, macro_text: str) -> None:
    ts = datetime.now(store.BJ).strftime("%Y-%m-%d %H:%M:%S")
    with store.conn() as c:
        for section, title, body in (("market", "大盘行情分析", market_text),
                                     ("macro", "宏观政策分析", macro_text)):
            c.execute(
                "INSERT OR REPLACE INTO report_sections"
                "(report_id,section,stock_code,day,kind,title,content,created_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                (REPORT_ID, section, "", day, KIND, title, body, ts))


def ensure() -> None:
    """接口调用前顺手保证有内容：没有段落就生成一次，异常不打扰请求。"""
    try:
        if store.list_sections("market", 1):
            return
        generate()
    except Exception:
        pass


def start() -> None:
    """起一个后台线程：启动后先生成一次，之后每 15 分钟跟着行情一起刷新。"""
    def loop():
        time.sleep(3)
        while True:
            try:
                generate()
            except Exception as e:  # 上游抖动不影响服务
                print("brief generate failed:", e)
            time.sleep(_TTL)

    threading.Thread(target=loop, daemon=True).start()
