#!/usr/bin/env python3
"""新闻总结取数与分领域统计。

把「上一张卡结束 → 现在」的站点新闻库（财联社电报 + 站点要闻）按领域归类，
输出每个领域的条数和标题样本，供「新闻总结」卡片使用。每天 08:00（am）/
20:00（pm）各一张，正常约 12 小时；中间断档时最多回看 24 小时。

计数口径：
  raw_total      原始去重（完整标题）后的条数
  deduped_total  事件级去重后的条数
  total          真正归入某个主领域的条数（各段条数相加）
  uncategorized  deduped_total - total，未归入重点领域的条数

用法：
  venv/bin/python scripts/news_digest.py                 # 打印 JSON（自动窗口，约 12h）
  venv/bin/python scripts/news_digest.py --hours 12 --bullets 6   # 0=列出全部（默认）
  venv/bin/python scripts/news_digest.py --post          # 直接用统计结果生成草稿卡片并入库
  venv/bin/python scripts/news_digest.py --post --file /tmp/digest.txt   # 用自己写的正文入库
  venv/bin/python scripts/news_digest.py --post --file /tmp/digest.txt --stats /tmp/dg.json
                                                          # 用同一份统计入库，计数不会漂

正文格式（--file / --post 都按这个渲染）：
  第一行：总览一句话
  ## 领域名 · N 条
  - 一条一个要点
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import digest_tts  # noqa: E402
import store  # noqa: E402

BJ = store.BJ

# 领域顺序＝卡片里的顺序；同一领域内先匹配的算这条新闻的主领域
SECTIONS: list[tuple[str, str]] = [
    # 用户点名最关心的两块放最前：政策（只认国内文件/会议）+ 光模块三剑客「易中天」
    ("政策", r"国务院|国常会|政治局|发改委|证监会|工信部|商务部|财政部|国资委|市场监管总局|"
             r"十[四五]五|印发|下发|出台|试点方案|降准|降息|\bLPR\b|逆回购|MLF|专项债|特别国债|"
             r"标准发布|征求意见稿|专项行动|部令|条例|办法发布"),
    ("光模块(易中天)", r"光模块|光通信|新易盛|中际旭创|天孚通信|CPO|800G|1\.6T|硅光|光芯片|"
                       r"铜连接|MPO|Lumentum|光器件|光引擎"),
    ("能源", r"石油|原油|OPEC|欧佩克|天然气|油价|WTI|布伦特|煤炭|焦煤|动力煤|电力|电价|光伏|硅料|"
             r"储能|锂电|锂矿|碳酸锂|稀土|风电|核电|氢能|油轮|成品油"),
    ("AI与算力", r"人工智能|大模型|算力|英伟达|NVIDIA|\bGPU\b|芯片|半导体|光模块|数据中心|OpenAI|"
                 r"智能体|HBM|先进封装|存储芯片|CPO|推理|DeepSeek|Anthropic|台积电"),
    ("机器人", r"机器人|人形|具身|减速器|丝杠|伺服|灵巧手|宇树|Optimus|机械臂|本体厂"),
    ("宏观数据", r"CPI|PPI|\bPMI\b|\bGDP\b|社融|M2|货币供应|进出口数据|外储|国债收益率|美联储|非农|"
                 r"通胀数据|失业率|零售销售|工业增加值"),
    ("医药", r"医药|创新药|集采|疫苗|CXO|医保|生物医药|临床|医疗器械|中药"),
    ("军工与航天", r"军工|国防|导弹|无人机|商业航天|卫星|航母|航天|发射|军演"),
    ("汽车与智驾", r"汽车|新能源车|智驾|自动驾驶|车企|比亚迪|特斯拉|整车|车市|零部件|充电桩"),
    ("消费", r"消费|白酒|零售|旅游|免税|餐饮|家电|食品|白酒|电商|黄金周|电影票房"),
    ("地产与基建", r"地产|楼市|房企|基建|水泥|钢铁|建筑|保障房|城投"),
    ("海外与地缘", r"特朗普|白宫|美国|欧盟|俄罗斯|乌克兰|以色列|伊朗|关税|制裁|地缘|谈判|"
                   r"中东|日韩|欧洲央行"),
    ("金融与市场", r"券商|银行|保险|IPO|再融资|北向|公募|私募|增持|减持|回购|退市|停牌|重组|并购"),
]

_BRACKET = re.compile(r"^[【\[]|[】\]]$")
# 行情描述类标题不进「政策 / 宏观」：这两块要的是文件、会议、数据本身
_ACTION = re.compile(r"涨停|涨超|跌超|异动|盘中|拉升|封板|跟涨|领涨|跌幅|涨幅|成交额|指数")
# 汇编/日历/要闻类标题：不是文件本身，政策和必看都不收
_AGG_LOCAL = re.compile(r"投资日历|新闻精选|要闻一览|要闻汇总|新闻汇总|新闻联播|盘前要闻|隔夜全球要闻|你需要知道|涨停分析|竞价看龙头|快照|简报|早知道")
# 重要性信号：有具体动作/数字的电报比一句行情描写更值得进卡片
_EVENT = re.compile(r"印发|下发|发布|公告|签署|中标|订单|收购|并购|投产|开工|获批|核准|注册证|"
                    r"突破|首次|同比|净利润|营收|业绩|预告|融资|募资|扩产|涨价|提价|减产|增持|"
                    r"减持|回购|停牌|复牌|重组|处罚|立案|会议|讲话|数据|规划|"
                    r"触雷|爆炸|遇袭|袭击|空袭|冲突|开战|停火|制裁|关税|打击|"
                    r"收涨|收跌|大涨|大跌|暴跌|飙升|重挫")
_NOISE = re.compile(r"中标利率|贴现利率|投标倍数|招标|回购协议（RRP）|汇率中间价|隔夜|拆借利率|"
                    r"夜盘|收涨|收跌|盘中涨|盘中跌|收盘涨|收盘跌|涨跌幅")
# 「政策」段只要国内口径：海外央行/财政部/投研报告不进这一段
_FOREIGN = re.compile(r"美国|美联储|德银|高盛|摩根|杰富瑞|欧洲|欧盟|日本|韩国|泰国|新西兰|"
                      r"澳大利亚|意大利|法国|英国|印度|俄罗斯|乌克兰|加拿大|巴西")
_CN_POLICY = re.compile(r"国务院|国常会|发改委|工信部|商务部|财政部|证监会|央行|中共中央|政治局|"
                        r"印发|出台|下发|征求意见|专项行动|条例|管理办法|规划|标准")


def _score(item: dict) -> int:
    t = item["title"]
    s = {"A": 3, "B": 2}.get(item.get("level") or "", 0)
    if _EVENT.search(t):
        s += 2
    if 30 <= len(t) <= 140:
        s += 1
    if len(t) < 18:
        s -= 3
    if _NOISE.search(t):
        s -= 3
    return s


# 标题里常见的来源/电头：做事件指纹前先去掉，否则不同事件会因为同一个电头被误合并
_SRC_BOILER = re.compile(
    r"(?:财联社[\d月日]+[电讯]|金十数据[\d月日]+讯|《[^》]{2,20}》[\d月日]+讯|记者获悉)[，,]?"
)
_DOC_RE = re.compile(r"《([^》]{2,80})》")
_DOC_PUNCT = re.compile(r"[^\w一-鿿%]+")
# 《科创板日报》这类媒体名不是事件；不能拿它当文件指纹
_MEDIA_DOC = re.compile(
    r"^(?:科创板日报|证券时报|上海证券报|中国证券报|证券日报|中国基金报|"
    r"财联社|新华社|人民日报|央视新闻|央视财经|经济观察报|第一财经|每日经济新闻|"
    r"21世纪经济报道|财新|澎湃新闻|界面新闻|路透社|彭博|华尔街见闻|格隆汇|智通财经|中国新闻网)$"
)


def _strip_src(title: str) -> str:
    return _SRC_BOILER.sub("", (title or "").strip()).strip("，, ：:；; ")


def _doc_key(title: str) -> str:
    """取标题里引用的文件/报告名；媒体名不算事件指纹。"""
    for name in _DOC_RE.findall(_strip_src(title)):
        name = re.sub(r"\s+", "", name)
        if len(name) >= 4 and not _MEDIA_DOC.match(name):
            return name
    return ""


def _subject(title: str) -> str:
    t = _strip_src(title)
    m = re.match(r"([^：:，,。；;]{2,24})", t)
    return m.group(1) if m else t[:24]


def _fingerprint(title: str) -> str:
    def _doc(m: re.Match) -> str:
        name = re.sub(r"\s+", "", m.group(1))
        return "" if len(name) < 4 or _MEDIA_DOC.match(name) else f"《{name}》"
    t = _DOC_RE.sub(_doc, _strip_src(title))
    return _DOC_PUNCT.sub("", t)[:140]


def _same_event(a: dict, b: dict) -> bool:
    da, db = _doc_key(a["title"]), _doc_key(b["title"])
    if da and db:
        return da == db
    if bool(da) != bool(db):
        return False
    fa, fb = _fingerprint(a["title"]), _fingerprint(b["title"])
    ratio = SequenceMatcher(None, fa, fb).ratio()
    return (_subject(a["title"]) == _subject(b["title"]) and ratio >= 0.72) or ratio >= 0.78


def _dedupe_events(items: list[dict]) -> list[dict]:
    """事件级去重：同一文件/同一条电报的不同拆条只留信息量最大的一条。"""
    reps: list[dict] = []
    for it in sorted(items, key=lambda x: (-_score(x), -len(x["title"]))):
        if any(_same_event(it, r) for r in reps):
            continue
        reps.append(it)
    reps.sort(key=lambda x: x.get("at", ""))
    return reps


def _clean(title: str) -> str:
    t = (title or "").strip()
    if t.startswith("【") and "】" in t:
        t = t[1:t.index("】")] + "：" + t[t.index("】") + 1:].strip()
    return re.sub(r"\s+", " ", t)[:120]


def _cite(nid: object) -> str:
    """新闻引用 token，前端会把它渲染成可点击的「来源」。"""
    try:
        return "{{n%d}}" % int(nid)
    except (TypeError, ValueError):
        return ""


_SECTION_RX = [(name, re.compile(pattern)) for name, pattern in SECTIONS]
_MODULE_RX = re.compile(dict(SECTIONS)["光模块(易中天)"])


def _section_for(title: str) -> str:
    """每条新闻只归一个主领域：按 SECTIONS 顺序第一个命中的段；不命中返回空串。"""
    for name, rx in _SECTION_RX:
        if not rx.search(title):
            continue
        if name in ("政策", "宏观数据") and _ACTION.search(title):
            continue
        if name == "政策":
            # 国内政策：要有国内部委/文件口径，且不是海外消息、不是台办发布会、不是日历类
            if not (_CN_POLICY.search(title)
                    and not _FOREIGN.search(title[:30])
                    and not _AGG_LOCAL.search(title)
                    and "台办" not in title and "台湾" not in title):
                continue
        if name == "光模块(易中天)" and _AGG_LOCAL.search(title):
            continue
        if name == "AI与算力" and _MODULE_RX.search(title):
            continue   # 光模块已单列，不在 AI 段重复出现
        return name
    return ""


# 必看同分时的主题优先顺序：用户最关心的主线在前
_MUST_PRIORITY = {
    "政策": 0, "光模块(易中天)": 1, "能源": 2, "AI与算力": 3, "海外与地缘": 4,
    "金融与市场": 5, "宏观数据": 6, "军工与航天": 7, "汽车与智驾": 8,
    "机器人": 9, "医药": 10, "消费": 11, "地产与基建": 12,
}

# 跨卡故事线的主题词表：同一主题在不同卡片里反复出现时，用固定 key 串起来。
# 放得越前越优先（例如「伊朗油轮」先归油轮，不归俄乌/中东）。
STORY_TOPICS: list[tuple[str, str]] = [
    ("霍尔木兹/油轮", r"霍尔木兹|油轮|伊朗革命卫队|布伦特|Brent|WTI|原油|油价|OPEC|欧佩克|VLCC|油运|航运|造船"),
    ("存储涨价", r"存储|DRAM|NAND|闪存|SSD|内存|颗粒|合约价|海力士|美光|三星|江波龙|佰维"),
    ("光模块/CPO", r"光模块|CPO|800G|1\.6T|硅光|光芯片|Lumentum|新易盛|中际旭创|天孚|光纤|长飞|空芯|太辰光|仕佳|源杰|剑桥科技"),
    ("AI芯片/算力", r"英伟达|NVIDIA|AI芯片|算力|GPU|HBM|台积电|半导体|CoreWeave|Anthropic|OpenAI"),
    ("机器人", r"机器人|人形|具身|宇树|减速器|丝杠|灵巧手|本体"),
    ("美联储/美债", r"美联储|加息|降息|议息|CPI|PPI|美债|收益率|非农|通胀"),
    ("央行/货币政策", r"央行|降准|降息|逆回购|MLF|LPR|货币政策|公开市场"),
    ("俄乌/中东", r"俄乌|俄美|俄罗斯|乌克兰|以色列|伊朗|阿布扎比|会谈|停火|换俘|制裁|中东"),
    ("新能源车", r"新能源车|汽车|比亚迪|特斯拉|智驾|整车|乘用车"),
    ("医药", r"医药|创新药|集采|医保|临床|CXO|药品|器械"),
    ("房地产/基建", r"地产|楼市|房企|基建|水泥|钢铁|保障房|宅地|土地"),
    ("军工/航天", r"军工|航天|卫星(?!化学)|导弹|无人机|航母"),
    ("消费", r"消费|白酒|免税|旅游|电商|餐饮|零售"),
]

_EVENT_TYPES: list[tuple[str, str]] = [
    ("定增", r"定增|向特定对象发行|可转债|配股|募资|发行股份|融资"),
    ("业绩", r"业绩|营收|净利|利润|预告|快报|财报|季报|年报"),
    ("订单", r"中标|订单|合同|采购|签约|框架协议|供货"),
    ("增持减持", r"增持|减持|回购|举牌|持股比例"),
    ("并购", r"收购|并购|重组|资产注入|借壳|合并|分拆|上市|IPO"),
    ("涨价", r"涨价|提价|降价|合约价|报价"),
    ("停复牌", r"停牌|复牌"),
    ("监管", r"立案|处罚|问询|监管|警示|违规|退市|风险提示"),
    ("地缘", r"袭击|空袭|冲突|战事|谈判|会谈|停火|制裁|关税|封锁|爆炸|触雷"),
    ("宏观", r"CPI|PPI|PMI|GDP|社融|M2|非农|加息|降息|议息|LPR|逆回购|MLF"),
    ("科技", r"发布|推出|量产|投产|扩产|研发|突破|首飞|发射|测试|认证|送样"),
]


def _event_type(title: str) -> str:
    for name, rx in _EVENT_TYPES:
        if re.search(rx, title):
            return name
    return ""


def _story_key(title: str, stock_names: list[str] | None = None) -> tuple[str, str]:
    """给一条新闻算稳定的跨卡 story key/label。

    个股级（标题开头/冒号后跟股票名 + 事件类型）优先；其次主题词表；
    最后退回「领域 + 标题主语」。算不出就返回空，不进故事线。
    """
    t = _strip_src(title)
    for name in (stock_names or []):
        pos = t.find(name)
        if pos < 0:
            continue
        # 只在标题开头或「股票名：」时按个股故事处理，避免行业新闻里顺带提到个股被拆散
        if pos <= 12 or t[pos + len(name):pos + len(name) + 1] in ("：", ":"):
            ev = _event_type(t)
            if ev:
                return f"stock:{name}:{ev}", f"{name}·{ev}"
            break
    for label, rx in STORY_TOPICS:
        if re.search(rx, t):
            return f"topic:{label}", label
    sec = _section_for(t)
    if sec:
        sub = _subject(t)[:10]
        return f"sec:{sec}:{sub}", f"{sec}·{sub}"
    return "", ""


def _story_history(items: list[dict], stock_names: list[str],
                   current_day: str, current_slot: str) -> tuple[list[dict], dict]:
    """从最近 30 天（最多 60 张卡）里的 {{nID}} 引用反推故事历史；给当前新闻标 new/ongoing。"""
    try:
        cards = store.list_digests(limit=store.DIGEST_KEEP_DAYS * 2)
    except Exception:
        cards = []
    history: dict[str, dict] = {}
    prev_keys_by_card: dict[tuple[str, str], set[str]] = {}
    for card in cards:
        day = str(card.get("day") or "")
        slot = str(card.get("slot") or "am")
        if day == current_day and slot == current_slot:
            continue
        ids: list[int] = []
        for m in re.finditer(r"\{\{n(\d+)\}\}", card.get("content") or ""):
            nid = int(m.group(1))
            if nid not in ids:
                ids.append(nid)
        if not ids:
            continue
        try:
            news = store.news_by_ids(ids)
        except Exception:
            continue
        card_keys: set[str] = set()
        for n in news:
            title = _clean(n.get("title") or n.get("body") or "")
            if _AGG_LOCAL.search(title) or store.FLAG_AGG_RE.search(title):
                continue
            key, label = _story_key(title, stock_names)
            if not key:
                continue
            card_keys.add(key)
            h = history.setdefault(key, {"label": label, "days": set(), "cards": set(),
                                         "first": (day, slot), "last": (day, slot),
                                         "items": []})
            h["days"].add(day)
            h["cards"].add((day, slot))
            h["first"] = min(h["first"], (day, slot))
            h["last"] = max(h["last"], (day, slot))
            h["items"].append({"id": n.get("id"), "title": title[:120],
                               "at": (n.get("published_at") or n.get("created_at") or "")[:16],
                               "cite": _cite(n.get("id"))})
        prev_keys_by_card[(day, slot)] = card_keys
    for it in items:
        if _AGG_LOCAL.search(it["title"]) or store.FLAG_AGG_RE.search(it["title"]):
            it["story_key"], it["story_label"] = "", ""
            it["story_status"], it["story_days"], it["story_cards"] = "", 0, 0
            continue
        key, label = _story_key(it["title"], stock_names)
        it["story_key"], it["story_label"] = key, label
        h = history.get(key)
        if h:
            it["story_status"] = "ongoing"
            # days/cards 包含当前这张卡：昨晚 pm → 今早 am 是第 2 天；同日 am/pm 是第 2 次
            it["story_days"] = len(h["days"] | {current_day})
            it["story_cards"] = len(h["cards"] | {(current_day, current_slot)})
            it["story_first"] = "%s %s" % h["first"]
            it["story_prev_ids"] = [x["id"] for x in sorted(
                h["items"], key=lambda x: x["at"])[-3:]]
        else:
            it["story_status"] = "new" if key else ""
            it["story_days"] = 0
            it["story_cards"] = 0
    groups: dict[str, dict] = {}
    for it in items:
        key = it.get("story_key")
        if not key:
            continue
        g = groups.setdefault(key, {
            "key": key, "label": it.get("story_label") or key,
            "status": it.get("story_status") or "new",
            "days": it.get("story_days") or 0, "cards": it.get("story_cards") or 0,
            "first": it.get("story_first") or "",
            "items": [],
            "prev_items": list(reversed(sorted(
                (history.get(key) or {}).get("items", []), key=lambda x: x["at"])[-3:])),
        })
        g["items"].append({"id": it.get("id"), "title": it["title"],
                           "at": it["at"], "level": it.get("level") or "",
                           "cite": _cite(it.get("id"))})
        if it.get("story_status") == "ongoing":
            g["status"] = "ongoing"
    for g in groups.values():
        g["items"].sort(key=lambda x: x.get("at", ""), reverse=True)
    stories = sorted(groups.values(), key=lambda g: (
        max((x.get("at", "") for x in g["items"]), default=""), len(g["items"])), reverse=True)
    # 不截断故事组：用户要求重要的都列，由模型按 status/天数/信息量取舍
    prev_cards = sorted(prev_keys_by_card, reverse=True)
    prev_keys = prev_keys_by_card.get(prev_cards[0], set()) if prev_cards else set()
    current_keys = set(groups)
    label_by_key = {k: (groups.get(k) or history.get(k) or {}).get("label") or k
                    for k in current_keys | prev_keys}
    new_keys = sorted((k for k in current_keys if k not in history),
                      key=lambda k: -len(groups[k]["items"]))
    ongoing_keys = sorted((k for k in current_keys if k in history),
                          key=lambda k: -len(groups[k]["items"]))
    changes = {
        "new": [label_by_key[k] for k in new_keys][:8],
        "ongoing": [label_by_key[k] for k in ongoing_keys][:8],
        "dropped": [label_by_key[k] for k in sorted(prev_keys - current_keys)][:8],
    }
    return stories, changes


_GLOBAL_AI_RX = re.compile(
    r"CoreWeave|英伟达|NVIDIA|台积电|SK海力士|美光|AMD|博通|OpenAI|Anthropic|算力租赁|AI资本开支", re.I)
_AI_EVENT_RX = re.compile(
    r"业绩|营收|净利|指引|订单|积压|超预期|上调|下调|涨超|涨幅|大涨|跌超|暴跌|突破")


def _must_score(item: dict, portfolio_keys: set[str] | None = None) -> int:
    s = _score(item)
    if item.get("section") in ("政策", "光模块(易中天)"):
        s += 1   # 用户最关心的两块，同分时优先
    if portfolio_keys and any(k in item["title"] for k in portfolio_keys if len(k) >= 3):
        s += 2   # 命中持仓/关注 A/B：优先让用户先看到跟自己有关的
    if _GLOBAL_AI_RX.search(item["title"]) and _AI_EVENT_RX.search(item["title"]):
        s += 2   # CoreWeave/英伟达/台积电等 AI 资本开支证据，优先进候选池
    return s


def _pick_must(items: list[dict], limit: int = 60,
               portfolio_keys: set[str] | None = None) -> list[dict]:
    """必看候选：按不同主领域各取高分条，再按分数补足（最多 60 条候选）。

    用户要求必看不设硬上限；这里给模型一个足够大的候选池（14 个领域 × 最多 3 条），
    由模型按重要性取舍。「其他」不是主题，第一轮不选，避免一条高分的杂项挤掉政策/能源/科技等主线。
    """
    cand = [i for i in items
            if not _AGG_LOCAL.search(i["title"])
            and not store.FLAG_AGG_RE.search(i["title"])]
    cand.sort(key=lambda i: (-_must_score(i, portfolio_keys),
                             _MUST_PRIORITY.get(i.get("section"), 99),
                             i.get("at", "")))
    picked: list[dict] = []
    used: set[int] = set()
    used_sections: set[str] = set()
    for i in cand:
        sec = i.get("section") or ""
        if not sec or sec in used_sections:
            continue
        picked.append(i)
        used.add(id(i))
        used_sections.add(sec)
        if len(picked) >= limit:
            break
    counts = Counter((i.get("section") or "其他") for i in picked)
    for i in cand:
        if len(picked) >= limit:
            break
        if id(i) in used:
            continue
        sec = i.get("section") or "其他"
        if counts[sec] >= 3:
            continue
        picked.append(i)
        used.add(id(i))
        counts[sec] += 1
    # 用户要求：必看最终按时间从新到旧排列（候选仍按重要性挑选）
    picked.sort(key=lambda i: i.get("at", ""), reverse=True)
    return picked[:limit]


def slot_for(end: datetime) -> str:
    """北京时间 08:00 档=am，20:00 档=pm；手动补跑按小时就近归类。"""
    return "am" if end.hour < 12 else "pm"


def auto_hours(end: datetime, slot: str) -> float:
    """从上一张卡的 window_end 起算，正常约 12h；断档最多补 24h。"""
    try:
        rows = store.list_digests(limit=1)
    except Exception:
        return 12.0
    if not rows:
        return 12.0
    last = rows[0]
    if (last.get("day") == end.strftime("%Y-%m-%d")
            and (last.get("slot") or "am") == slot):
        return 12.0   # 同一档重跑：固定回看 12h，避免窗口被压成几分钟
    stamp = str(last.get("window_end") or last.get("updated_at") or "")[:19]
    try:
        last_end = datetime.fromisoformat(stamp).replace(tzinfo=BJ)
    except ValueError:
        return 12.0
    hours = (end - last_end).total_seconds() / 3600.0
    return max(6.0, min(24.0, hours))


def resolve_hours(value: object, end: datetime, slot: str) -> float:
    if str(value).strip().lower() in ("auto", ""):
        return auto_hours(end, slot)
    return float(value)


def _stock_keys(s: dict) -> set[str]:
    """股票名称/代码/ETF 简称，用于把新闻标题映射到持仓与关注。"""
    name = str(s.get("name") or "").strip()
    code = str(s.get("code") or "").strip()
    keys = {name, code, name.replace(" ", "")}
    if name:
        if "ETF" in name:
            alias = name.split("ETF")[0].strip()
            # 「机器人ETF」「通信ETF」这类两三个字的泛主题前缀会误匹配整片新闻，
            # 只有足够具体的简称（如「科创100」「中韩半导体」）才纳入匹配。
            if len(alias) >= 5:
                keys.add(alias)
        if "-" in name:
            alias = name.split("-")[0].strip()
            if len(alias) >= 3:
                keys.add(alias)
    return {k for k in keys if k}


def _all_stock_names() -> list[str]:
    """所有股票名称（含关注 C），用于给新闻挂跨卡故事线。"""
    try:
        rows = store.list_stocks()
    except Exception:
        return []
    names = {str(s.get("name") or "").strip() for s in rows}
    return sorted((n for n in names if len(n) >= 2), key=len, reverse=True)


# 个股 -> 行业/商品关键词：新闻标题里可能没有股票名，但铝价、LME、反倾销、
# 央行报告这些才是股价真正的驱动。只用于持仓/关注雷达的「相关驱动」。
SECTOR_KEYWORDS: dict[str, list[str]] = {
    "银行": ["央行", "LPR", "净息差", "信贷", "社融", "降准", "降息", "存款", "贷款", "银行板块"],
    "水泥": ["水泥", "熟料", "基建投资", "基建项目", "基建板块", "房地产", "楼市", "房企", "错峰生产", "建材"],
    "传媒": ["传媒", "电视", "广电", "短剧", "漫剧", "文娱", "影视", "视频"],
    "机器人": ["机器人", "人形", "具身", "减速器", "丝杠", "灵巧手", "宇树", "伺服"],
    "通信": ["通信", "光模块", "CPO", "800G", "1.6T", "硅光", "光芯片", "光纤"],
    "半导体": ["半导体", "芯片", "存储", "DRAM", "NAND", "算力", "AI芯片", "晶圆"],
    "券商": ["券商", "证券", "成交额", "IPO", "并购", "两融"],
    "原油": ["原油", "石油", "油价", "WTI", "布伦特", "OPEC", "油服", "油运", "天然气"],
    "黄金": ["黄金", "金价", "COMEX", "沪金"],
    "有色": ["铜", "铝", "锌", "镍", "稀土", "锂", "电解铝", "氧化铝",
             "LME", "沪铝", "铝土矿", "铝合金", "铝挤压", "反倾销"],
    "电力": ["电力", "水电", "电价", "核电", "绿电", "电网"],
    "红利": ["红利", "高股息", "分红"],
    "粮食": ["粮食", "农业", "种业", "大豆", "玉米", "小麦"],
    "军工": ["军工", "航天", "卫星", "导弹", "无人机"],
    "医药": ["医药", "创新药", "集采", "医保", "临床", "CXO"],
    "消费": ["消费", "白酒", "免税", "旅游", "电商", "零售", "餐饮"],
}

# ETF 名称里没有行业标签，按名称前缀补
ETF_KEYWORDS: dict[str, list[str]] = {
    "科创100": ["科创", "半导体", "芯片", "存储", "算力", "科技"],
    "机器人": ["机器人", "人形", "具身", "减速器", "丝杠"],
    "通信": ["通信", "光模块", "CPO", "800G", "1.6T", "光纤"],
    "石油": ["原油", "石油", "油价", "WTI", "布伦特", "OPEC"],
    "油气": ["原油", "石油", "油价", "天然气"],
    "券商": ["券商", "证券", "成交额", "IPO", "并购"],
    "红利低波": ["红利", "高股息", "银行", "电力", "煤炭"],
    "粮食": ["粮食", "农业", "种业", "大豆", "玉米"],
    "半导体": ["半导体", "芯片", "存储", "DRAM", "算力"],
}

# 交易标签 -> 行业；按标签逐个匹配，命中第一个就停（避免「文娱消费」同时吃到消费大词表）
TAG_SECTORS: dict[str, str] = {
    "国有大型银行": "银行", "银行": "银行",
    "水泥": "水泥", "建材": "水泥",
    "文娱": "传媒", "电视": "传媒", "视频": "传媒", "短剧": "传媒", "影视": "传媒",
    "机器人": "机器人", "人形": "机器人", "具身": "机器人",
    "半导体": "半导体", "芯片": "半导体", "存储": "半导体", "算力": "半导体",
    "光模块": "通信", "CPO": "通信", "通信": "通信",
    "券商": "券商", "证券": "券商",
    "石油": "原油", "原油": "原油", "油气": "原油",
    "黄金": "黄金",
    "有色": "有色", "铝": "有色", "铜": "有色",
    "电力": "电力", "电网": "电力",
    "红利": "红利", "高股息": "红利",
    "粮食": "粮食", "农业": "粮食",
    "军工": "军工", "航天": "军工",
    "医药": "医药", "创新药": "医药",
    "消费": "消费", "白酒": "消费",
}


def _sector_keys(s: dict) -> set[str]:
    """从股票名称/交易标签/自定义标签/ETF 名称里推行业关键词。"""
    name = str(s.get("name") or "")
    tags = [* (s.get("tags") or []), *(s.get("ext_tags") or [])]
    sectors: set[str] = set()
    for part in [name, *tags]:
        for trigger, sector in TAG_SECTORS.items():
            if trigger in part:
                sectors.add(sector)
                break
    keys: set[str] = set()
    for sec in sectors:
        keys.update(SECTOR_KEYWORDS.get(sec, []))
    for frag, words in ETF_KEYWORDS.items():
        if frag in name:
            keys.update(words)
    return {k for k in keys if len(k) >= 2 and k not in ("ETF", "老登防守", "奇迹暖暖")}


def _portfolio() -> tuple[list[dict], set[str]]:
    """持仓全部 + 关注 A/B；返回名单和用于标题匹配的键集合。"""
    try:
        rows = store.list_stocks()
    except Exception:
        return [], set()
    picked: list[dict] = []
    keys: set[str] = set()
    for s in rows:
        bucket = str(s.get("bucket") or "").lower()
        priority = str(s.get("priority") or "").upper()
        if not (bucket == "hold" or (bucket == "watch" and priority in ("A", "B"))):
            continue
        item = {"code": str(s.get("code") or ""), "name": str(s.get("name") or ""),
                "bucket": bucket, "priority": priority,
                "tags": s.get("custom_tags") or [],
                "ext_tags": s.get("tags") or []}
        picked.append(item)
        keys |= _stock_keys(item)
    return picked, keys


def _portfolio_hits(items: list[dict], portfolio: list[dict]) -> list[dict]:
    """按名称/代码把窗口内新闻挂到持仓与关注 A/B 上；只返回有消息的股票。"""
    out: list[dict] = []
    for s in portfolio:
        keys = _stock_keys(s)
        hit = [i for i in items if any(k in i["title"] for k in keys)]
        if not hit:
            continue
        hit.sort(key=lambda i: i.get("at", ""), reverse=True)
        out.append({**s, "count": len(hit),
                    "items": [{"id": i.get("id"), "title": i["title"],
                               "at": i["at"], "time": i["at"][11:16],
                               "level": i.get("level") or "",
                               "cite": _cite(i.get("id"))}
                              for i in hit]})
    out.sort(key=lambda s: (0 if s["bucket"] == "hold" else 1,
                            s.get("priority") or "Z", -s["count"]))
    return out


_NEG_RX = re.compile(r"减持|立案|处罚|问询|反倾销|关税|制裁|事故|停产|爆炸|亏损|终止|违约|质押")


def _portfolio_radar(items: list[dict], portfolio: list[dict]) -> list[dict]:
    """每只持仓/关注 A/B 都要有一行：个股消息 + 行业/商品相关驱动 + 行情异动。

    与 portfolio_hits 的区别：hits 只返回「标题里出现股票名」的股票；
    radar 覆盖全部持仓/关注 A/B，并把铝价、LME、印度反倾销、央行报告这类
    标题里没有股票名、但实际驱动股价的新闻挂到 related。
    """
    try:
        import quotes
        qs = quotes.fetch([s["code"] for s in portfolio])
    except Exception:
        qs = {}
    out: list[dict] = []
    for s in portfolio:
        fresh = [i for i in items
                 if not _AGG_LOCAL.search(i["title"])
                 and not store.FLAG_AGG_RE.search(i["title"])]
        direct_keys = _stock_keys(s)
        direct = [i for i in fresh if any(k in i["title"] for k in direct_keys)]
        direct_ids = {id(i) for i in direct}
        sector_keys = _sector_keys(s)

        def _rel_rank(i: dict) -> int:
            title = i["title"]
            best, hits = 999, 0
            for k in sector_keys:
                pos = title.find(k)
                if pos >= 0:
                    best = min(best, pos)
                    hits += 1
            if best == 999:
                return 0
            return (3 if best <= 20 else 2 if best <= 40 else 1) + min(hits, 2)

        related = [(i, _rel_rank(i)) for i in fresh
                   if id(i) not in direct_ids and _rel_rank(i) >= 2]
        related.sort(key=lambda x: (-x[1], -_score(x[0]), x[0].get("at", "")))
        related = [i for i, _ in related[:6]]
        related.sort(key=lambda i: i.get("at", ""), reverse=True)   # 每只股内部：越新越靠前
        direct.sort(key=lambda i: i.get("at", ""), reverse=True)
        q = qs.get(s["code"]) or {}
        pct = q.get("pct")
        risk: list[str] = []
        if isinstance(pct, (int, float)) and abs(pct) >= 3:
            risk.append(f"异动{pct:+.2f}%")
        if any(_NEG_RX.search(i["title"]) for i in direct[:8] + related[:8]):
            risk.append("利空关键词")
        def _brief(i: dict) -> dict:
            return {"id": i.get("id"), "title": i["title"], "at": i["at"],
                    "time": i["at"][11:16], "level": i.get("level") or "",
                    "cite": _cite(i.get("id"))}
        out.append({**s, "sector_keys": sorted(sector_keys),
                    "quote": ({k: q.get(k) for k in
                               ("price", "pct", "prev_close", "amount", "time", "stale")}
                              if q else None),
                    "direct": [_brief(i) for i in direct[:8]],
                    "related": [_brief(i) for i in related[:6]],
                    "risk": risk})
    out.sort(key=lambda s: (0 if s["bucket"] == "hold" else 1,
                            s.get("priority") or "Z", s["name"]))
    return out


def _latest_report(slot: str) -> dict | None:
    """早班读最新盘前、晚班读最新盘后；让总结只写报告之外的新消息。"""
    kind = "pre" if slot == "am" else "post"
    try:
        rows = store.list_reports(kind=kind, limit=1)
        if not rows:
            return None
        r = store.get_report(rows[0]["id"])
        if not r:
            return None
        return {"kind": kind, "day": r.get("day") or "", "title": r.get("title") or "",
                "created_at": r.get("created_at") or "",
                "content": (r.get("content") or "")[:9000]}
    except Exception:
        return None


def _calendar(days: int = 2, slot: str = "am", now: datetime | None = None) -> list[dict]:
    """未来关键日程：本地规则（财报截止/美联储/期权到期）+ 东财财经日历。"""
    now = now or datetime.now(BJ)
    out: list[dict] = []
    try:
        import market_calendar as mc
        out.extend(mc.upcoming(days=days))
        out.extend(mc.remote_events(days=days))
    except Exception:
        pass
    today, clock = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
    seen: set[tuple] = set()
    res: list[dict] = []
    for e in out:
        day = str(e.get("day") or "")
        if day < today:
            continue
        if day == today and slot == "pm":
            # 晚班只留今天还没发生的事；无具体时间的会议已经过去，不再算「未来」
            t = str(e.get("time") or "")
            if not t or t < clock:
                continue
        key = (day, e.get("title"))
        if key in seen:
            continue
        seen.add(key)
        res.append({k: e.get(k) for k in ("day", "time", "kind", "title", "note", "weekday")})
    res.sort(key=lambda x: (x.get("day") or "", x.get("time") or "99:99", x.get("title") or ""))
    return res[:16]


def _previous_digest() -> dict | None:
    """上一张卡的领域计数与必看，供「较上期」和去重使用。"""
    try:
        rows = store.list_digests(limit=1)
    except Exception:
        return None
    if not rows:
        return None
    prev = rows[0]
    sections: list[dict] = []
    must: list[str] = []
    current = ""
    for line in (prev.get("content") or "").splitlines():
        s = line.strip()
        m = re.match(r"^##\s*(.+?)\s*[·:：]\s*(\d+)\s*条", s)
        if m:
            current = m.group(1).strip()
            sections.append({"name": current, "count": int(m.group(2))})
            continue
        if current == "必看" and re.match(r"^[-•]\s+", s):
            must.append(re.sub(r"^[-•]\s+", "", s))
    return {"day": prev["day"], "slot": prev.get("slot") or "am",
            "window_end": prev.get("window_end") or prev.get("updated_at") or "",
            "total": prev.get("total") or 0,
            "sections": sections, "must": must[:10]}


def collect(hours: float = 12, end: datetime | None = None, slot: str | None = None) -> dict:
    end = end or datetime.now(BJ)
    slot = (slot or slot_for(end)).strip().lower()
    if slot not in store.DIGEST_SLOTS:
        raise ValueError(f"bad digest slot: {slot!r}")
    hours = max(0.1, float(hours))
    portfolio, portfolio_keys = _portfolio()
    stock_names = _all_stock_names()
    start = end - timedelta(hours=hours)
    fmt = "%Y-%m-%d %H:%M"
    rows = store.news_between(start.strftime(fmt), end.strftime(fmt))
    # 先按完整标题去重（同一电报可能被多次入库）
    seen: set[str] = set()
    items: list[dict] = []
    for r in rows:
        t = _clean(r.get("title") or r.get("body") or "")
        if len(t) < 6 or t in seen:
            continue
        if t.startswith("①"):   # 财联社 ①② 式聚合条，跨多个领域，不能算给某一个领域
            continue
        if (r.get("source") or "") == "report":   # 站点自己的日报不是新闻，不进总结
            continue
        seen.add(t)
        items.append({"id": r.get("id"),
                      "title": t, "at": (r.get("published_at") or r.get("created_at") or "")[:16],
                      "level": r.get("level") or ""})
    raw_total = len(items)
    items = _dedupe_events(items)
    deduped_total = len(items)
    # 每条新闻只归一个主领域，避免同一事件在多个段重复出现
    for it in items:
        it["section"] = _section_for(it["title"])
    sections = []
    for name, _ in SECTIONS:
        hit = [i for i in items if i["section"] == name]
        hit.sort(key=lambda i: -_score(i))
        if name == "政策":
            # 同一发布主体最多留 2 条（事件去重后通常只剩 1~2 份文件）
            per_subject: dict[str, int] = {}
            kept = []
            for i in hit:
                subj = _subject(i["title"])[:12]
                if per_subject.get(subj, 0) >= 2:
                    continue
                per_subject[subj] = per_subject.get(subj, 0) + 1
                kept.append(i)
            hit = kept
        hit.sort(key=lambda i: i.get("at", ""), reverse=True)   # 领域索引：越新越靠前
        sections.append({"name": name, "count": len(hit),
                         "items": [f"{i['at'][11:16]} {i['title']}{_cite(i.get('id'))}"
                                   for i in hit]})
    # 板块顺序：政策 → 光模块 → 能源 → AI → 机器人 → 其余按条数
    lead = {"政策": 0, "光模块(易中天)": 1, "能源": 2, "AI与算力": 3, "机器人": 4}
    sections.sort(key=lambda s: (lead.get(s["name"], 9), -s["count"]))
    categorized = sum(s["count"] for s in sections)
    uncategorized = deduped_total - categorized
    must = [f"{i['at'][11:16]} {i['title']}{_cite(i.get('id'))}"
            for i in _pick_must(items, portfolio_keys=portfolio_keys)]
    # 「较上期」：上一张卡的领域计数；同一档重跑不算上一期
    previous = _previous_digest()
    if previous and previous.get("day") == end.strftime("%Y-%m-%d") \
            and previous.get("slot") == slot:
        previous = None
    prev_counts = {s["name"]: s["count"] for s in (previous or {}).get("sections", [])}
    deltas = [{"name": s["name"], "prev": prev_counts[s["name"]], "now": s["count"],
               "delta": s["count"] - prev_counts[s["name"]]}
              for s in sections if s["name"] in prev_counts]
    deltas.sort(key=lambda x: (-abs(x["delta"]), x["name"]))
    stories, story_changes = _story_history(
        items, stock_names, end.strftime("%Y-%m-%d"), slot)
    latest_at = max((i["at"] for i in items), default="")
    try:
        latest_dt = datetime.strptime(latest_at, "%Y-%m-%d %H:%M").replace(tzinfo=BJ)
        stale_hours = round((end - latest_dt).total_seconds() / 3600, 1)
    except ValueError:
        stale_hours = None
    return {"day": end.strftime("%Y-%m-%d"), "slot": slot,
            "hours": round(hours, 2), "catch_up": hours > 14,
            "window": [start.strftime(fmt), end.strftime(fmt)],
            "raw_total": raw_total, "deduped_total": deduped_total,
            "total": categorized, "uncategorized": uncategorized,
            "latest_at": latest_at, "stale_hours": stale_hours,
            "must": must, "sections": sections,
            "portfolio": portfolio, "portfolio_hits": _portfolio_hits(items, portfolio),
            "portfolio_radar": _portfolio_radar(items, portfolio),
            "calendar": _calendar(2, slot, end), "report": _latest_report(slot),
            "previous": previous, "deltas": deltas,
            "stories": stories, "story_changes": story_changes}


_TIME_RX = re.compile(r"\d{1,2}:\d{2}|\d{1,2}点(?:\d{1,2}分)?|\d{1,2}时(?:\d{1,2}分)?")


def check_times(text: str) -> list[str]:
    """检查总结里每条新闻是否带具体时点；返回缺时点的行（供 --check 用）。"""
    bad: list[str] = []
    current = ""
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith("## "):
            current = s[3:].split("·")[0].strip()
            continue
        if not s.startswith("- "):
            continue
        if current in ("较上期", "接下来关注"):
            continue
        if ("无跨卡延续故事" in s or "无个股级新消息" in s or "无个股级新闻" in s
                or "该时段无重要消息" in s or "无重要日程" in s):
            continue
        if not _TIME_RX.search(s):
            bad.append(f"[{current}] {s[:100]}")
    return bad


_CITE_RX = re.compile(r"\{\{n\d+\}\}")


def check_citations(text: str) -> list[str]:
    """检查每条总结是否带来源 token；今日主线/必看/故事线/雷达/领域必须有。"""
    bad: list[str] = []
    current = ""
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith("## "):
            current = s[3:].split("·")[0].strip()
            continue
        if not s.startswith("- "):
            continue
        if current in ("较上期", "接下来关注"):
            continue
        if ("无跨卡延续故事" in s or "无个股级新闻" in s or "无个股级新消息" in s
                or "无重要日程" in s):
            continue
        if not _CITE_RX.search(s):
            bad.append(f"[{current}] {s[:100]}")
    return bad


def sort_digest_by_time(text: str) -> str:
    """按每条 bullet 引用新闻的最晚时间重排（越新越靠上）。

    领域索引和必看是脚本排的；今日主线/故事线/雷达由模型写，
    入库前用引用 ID 对应的新闻时间再兜一次，避免模型按重要性排。
    `接下来关注` 保持日历正序，`较上期` 保持升温/降温/延续逻辑，
    `持仓/关注雷达` 保持「持仓 → 关注 A/B」的股票顺序，均不重排。
    """
    lines = (text or "").splitlines()
    lead: list[str] = []
    sections: list[dict] = []
    current: dict | None = None
    for line in lines:
        if line.startswith("## "):
            current = {"head": line, "bullets": [], "other": []}
            sections.append(current)
        elif current is None:
            lead.append(line)
        elif line.strip().startswith("- "):
            current["bullets"].append(line)
        else:
            current["other"].append(line)

    all_ids: set[int] = set()
    for sec in sections:
        for b in sec["bullets"]:
            all_ids.update(int(x) for x in re.findall(r"\{\{n(\d+)\}\}", b))
    time_map: dict[int, str] = {}
    if all_ids:
        try:
            for r in store.news_by_ids(sorted(all_ids)):
                t = r.get("published_at") or r.get("created_at") or ""
                if t:
                    time_map[int(r["id"])] = t[:16]
        except Exception:
            pass

    skip = {"接下来关注", "较上期", "持仓/关注雷达"}
    for sec in sections:
        name = sec["head"][3:].split("·")[0].strip()
        if name in skip or len(sec["bullets"]) < 2:
            continue

        def key(b: str) -> str:
            ids = [int(x) for x in re.findall(r"\{\{n(\d+)\}\}", b)]
            times = [time_map[i] for i in ids if i in time_map]
            if times:
                return max(times)
            m = _TIME_RX.search(b)
            return ("0000-00-00 " + m.group(0)) if m else ""

        sec["bullets"].sort(key=key, reverse=True)

    out = list(lead)
    for sec in sections:
        out.append(sec["head"])
        out.extend(sec["bullets"])
        out.extend(sec["other"])
    return "\n".join(out).strip() + "\n"


def render(data: dict, bullets: int = 0) -> str:
    top = "、".join(f"{s['name']} {s['count']} 条" for s in data["sections"][:5] if s["count"])
    raw = data.get("raw_total", data.get("deduped_total", data.get("total", 0)))
    deduped = data.get("deduped_total", data.get("total", 0))
    covered = data.get("total", 0)
    un = data.get("uncategorized", max(0, deduped - covered))
    tail = f"，{un} 条未归入重点领域" if un else ""
    hours = float(data.get("hours", 24))
    hours_txt = f"{hours:.0f}" if hours.is_integer() else f"{hours:.1f}"
    catch = "（补跑）" if data.get("catch_up") else ""
    out = [f"总览{catch}：过去 {hours_txt} 小时（{data['window'][0][5:]}—{data['window'][1][5:]}）"
           f"原始 {raw} 条，事件去重后 {deduped} 条；其中 {covered} 条归入重点领域{tail}，"
           f"分布上 {top}。"]
    if data.get("must"):
        out.append(f"## 必看 · {len(data['must'])} 条")
        for it in data["must"]:
            out.append(f"- {it}")
    for s in data["sections"]:
        if not s["count"]:
            continue
        out.append(f"## {s['name']} · {s['count']} 条")
        items = s["items"] if bullets <= 0 else s["items"][:bullets]
        for it in items:
            out.append(f"- {it}")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", default="auto",
                    help="统计窗口小时数；auto=从上一张卡的 window_end 起算（6~24h），默认 auto")
    ap.add_argument("--slot", choices=("auto", "am", "pm"), default="auto",
                    help="卡片时段；auto=按北京时间（<12 点 am，否则 pm）")
    ap.add_argument("--bullets", type=int, default=0, help="每个领域列多少条样本；0=全部（默认）")
    ap.add_argument("--post", action="store_true", help="把结果写入站点新闻总结卡片")
    ap.add_argument("--file", help="用这个文件的正文入库（配合 --post）")
    ap.add_argument("--stats", help="用这份 --json-out 的统计入库，保证正文计数与库一致")
    ap.add_argument("--day", help="卡片日期，默认今天（北京时间）")
    ap.add_argument("--json-out", help="把统计 JSON 写到文件")
    ap.add_argument("--check", help="检查这个文件的每条总结是否带具体时点（HH:MM）")
    a = ap.parse_args()

    if a.check:
        text = Path(a.check).read_text(encoding="utf-8")
        bad_t = check_times(text)
        bad_c = check_citations(text)
        if bad_t:
            print("缺少时点的条目（每条总结必须带 HH:MM）：")
            for x in bad_t:
                print(" -", x)
        if bad_c:
            print("缺少来源 token 的条目（必须带 {{n数字}}）：")
            for x in bad_c:
                print(" -", x)
        if bad_t or bad_c:
            raise SystemExit(1)
        print(f"OK: {a.check} 每条总结都带时点和来源")
        return

    now = datetime.now(BJ)
    slot = slot_for(now) if a.slot == "auto" else a.slot
    if a.stats:
        data = json.loads(Path(a.stats).read_text(encoding="utf-8"))
        slot = (data.get("slot") or slot).strip().lower()
    else:
        try:
            hours = resolve_hours(a.hours, now, slot)
        except ValueError:
            ap.error("--hours 只能是 auto 或数字")
        data = collect(hours, now, slot)
    if a.json_out and not a.stats:
        Path(a.json_out).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if a.post:
        day = (a.day or data["day"])[:10]
        content = Path(a.file).read_text(encoding="utf-8").strip() if a.file else render(data, a.bullets)
        content = sort_digest_by_time(content)
        store.upsert_digest(
            day, content, data["total"], slot,
            (data.get("window") or ["", ""])[0],
            (data.get("window") or ["", ""])[1],
        )
        # 后台预生成「重点」语音；成功与否都不影响总结入库
        try:
            digest_tts.warm_async(day, slot, "key")
        except Exception as e:
            print(f"语音预生成启动失败：{e}", file=sys.stderr)
        print(json.dumps({"ok": True, "day": day, "slot": slot, "chars": len(content),
                          "total": data["total"], "window": data.get("window")},
                         ensure_ascii=False))
        return
    if a.file:
        print("--file 只配合 --post 使用")
        return
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
