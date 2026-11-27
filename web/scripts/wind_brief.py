#!/usr/bin/env python3
"""Wind 预取脚本：报告生成前跑一次，把宏观/指数节奏/个股财务/基金持仓写到
data/wind_brief.json（机器读）和 data/wind_brief.md（模型读）。

用法（在 /root/stock-site 下）：
    venv/bin/python scripts/wind_brief.py            # 全量预取（按缓存 TTL 决定是否真调用）
    venv/bin/python scripts/wind_brief.py --no-stocks  # 只取宏观+指数+基金
    venv/bin/python scripts/wind_brief.py --force      # 忽略缓存
    venv/bin/python scripts/wind_brief.py --print      # 只打印已有缓存摘要，不发请求

约定：任何一项取不到就写“暂无”，不阻塞报告。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from wind import Wind  # noqa: E402

BRIEF_JSON = os.path.join(ROOT, "data", "wind_brief.json")
BRIEF_MD = os.path.join(ROOT, "data", "wind_brief.md")
STOCK_FLAG = os.path.join(ROOT, "scripts", "flag_push.py")
PY = os.path.join(ROOT, "venv", "bin", "python")


def load_stocks() -> list[tuple[str, str, str]]:
    """从站点取当前持仓/关注：[(code, name, kind)]，kind = hold / watch。
    与报告口径一致：持仓全取，关注只取 A/B（C 或未设置不取），总数上限 15 只。"""
    try:
        out = subprocess.run([PY, STOCK_FLAG, "--stocks"], cwd=ROOT,
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return []
    res, watch_cnt = [], 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        code, name = parts[0], parts[1]
        if not (len(code) == 6 and code.isdigit()):
            continue
        if "hold" in line:
            res.append((code, name, "hold"))
            continue
        # 关注股：只留 A/B
        pri = ""
        for tok in parts[2:]:
            t = tok.strip("[]")
            if t in ("A", "B") or t.startswith(("watch/",)):
                pri = t.split("/")[-1]
        if pri in ("A", "B"):
            if watch_cnt >= 9:
                continue
            watch_cnt += 1
            res.append((code, name, "watch"))
    return res


def wind_code(code: str, name: str) -> str:
    """6 位代码 -> Wind 代码。ETF/LOF 用 .SH/.SZ 规则。"""
    if code.startswith(("5", "6", "9")):
        return f"{code}.SH"
    if code.startswith(("0", "1", "2", "3")):
        return f"{code}.SZ"
    return code


def is_fund(name: str, code: str) -> bool:
    return ("ETF" in name.upper()) or code.startswith(("51", "15", "58", "16"))


def fmt_macro(m) -> str:
    if not m or not m.get("items"):
        return "- 宏观（Wind）：暂无"
    lines = []
    for it in m["items"]:
        series = "、".join(it.get("series") or [])
        if series:
            lines.append(f"  - {it['name']}（{it.get('unit','')}，{it.get('freq','')}）：{series}")
    if not lines:
        return "- 宏观（Wind）：暂无"
    return "- 宏观（Wind，抓取于 %s）：\n%s" % (m.get("fetched_at", "?"), "\n".join(lines))


def fmt_index(i) -> str:
    if not i:
        return "- 上证分时节奏（Wind）：暂无"
    return ("- 上证分时节奏（Wind）：开 %.2f → 收 %.2f（高 %.2f / 低 %.2f）；"
            "上午 %+.2f 点，下午至 14:30 %+.2f 点，尾盘 %+.2f 点；"
            "分钟成交额峰值 %s（%.0f 元）；共 %d 根分钟线") % (
        i["open"], i["close"], i["high"], i["low"],
        i.get("am_change") or 0, i.get("pm_change") or 0, i.get("tail_change") or 0,
        i.get("peak_turnover_min", "?"), i.get("peak_turnover") or 0, i.get("bars", 0))


def fmt_stock(code, name, s) -> str:
    if not s or not s.get("raw"):
        return f"- {name}({code}) 财务/估值（Wind）：暂无"
    vals = []
    for r in s["raw"][:2]:
        vals.append(" | ".join(f"{k}={v}" for k, v in r.items() if v not in (None, "", "None")))
    return f"- {name}({code}) 财务/估值（Wind，抓取于 {s.get('fetched_at','?')}）：\n  " + "\n  ".join(vals)


def fmt_tech(name, t) -> str:
    if not t:
        return f"  - {name} 技术指标：暂无"
    def n(v, d=2):
        try:
            return f"{float(v):.{d}f}"
        except Exception:
            return "—"
    parts = [f"MA5 {n(t.get('ma5'))} / MA20 {n(t.get('ma20'))} / MA60 {n(t.get('ma60'))}",
             f"MACD {n(t.get('macd'), 3)}",
             f"RSI6 {n(t.get('rsi6'), 1)}"]
    if t.get("boll_low") is not None and t.get("boll_up") is not None:
        parts.append(f"BOLL {n(t['boll_low'])}–{n(t['boll_up'])}（中轨 {n(t['boll_mid'])}）")
    if t.get("chg20") is not None:
        parts.append(f"近20日 {n(t['chg20'])}%")
    if t.get("chg60") is not None:
        parts.append(f"近60日 {n(t['chg60'])}%")
    return f"  - {name}：" + "；".join(parts)


def fmt_holders(name, h) -> str:
    if not h or not h.get("top10"):
        return f"  - {name} 前十大股东：暂无"
    top = h["top10"][:5]
    def nm(x):
        return f"{x.get('name')}({x.get('ratio')})" if x.get("ratio") is not None else str(x.get("name"))
    return f"  - {name} 前五大股东：" + "、".join(nm(x) for x in top)


def _pct_txt(v):
    """Wind 已带 % 的直接用，未带的补上。"""
    if v is None:
        return ""
    s = str(v)
    if isinstance(v, (int, float)):
        return f"{v:+g}%"
    return s if s.endswith("%") else s + "%"


def fmt_trend(name, tr) -> str:
    if not tr or not tr.get("series"):
        return f"  - {name} 财务多期：暂无"
    out = []
    for s in tr["series"][:4]:
        bits = [str(s.get("period"))]
        if s.get("rev") is not None:
            bits.append(f"营收{s['rev']}" + (f"({_pct_txt(s.get('rev_yoy'))})" if s.get("rev_yoy") is not None else ""))
        if s.get("np") is not None:
            bits.append(f"净利{s['np']}" + (f"({_pct_txt(s.get('np_yoy'))})" if s.get("np_yoy") is not None else ""))
        if s.get("roe") is not None:
            bits.append(f"ROE {s['roe']}")
        out.append(" ".join(bits))
    return f"  - {name}：" + "；".join(out)


def fmt_index_val(v) -> str:
    if not v:
        return "- 指数估值（Wind）：暂无"
    def f(x):
        import re as _re
        if x is None:
            return None
        m = _re.search(r"-?\d+(?:\.\d+)?", str(x))
        return float(m.group()) if m else None
    pe, pb, pct = f(v.get("pe")), f(v.get("pb")), f(v.get("pe_pct10y"))
    if pe is None and pb is None:
        return "- 指数估值（Wind）：暂无"
    parts = []
    if pe is not None:
        parts.append(f"PE {pe:.2f}")
    if pb is not None:
        parts.append(f"PB {pb:.2f}")
    tail = f"，PE 近十年分位 {pct:.1f}%（>80% 偏贵、<20% 偏便宜）" if pct is not None else ""
    return f"- {v.get('name') or '沪深300'} 估值（Wind）：" + " / ".join(parts) + tail


def fmt_fund(code, name, f) -> str:
    if not f or (not f.get("top10") and not f.get("allocation")):
        return f"- {name}({code}) 持仓（Wind）：暂无"
    parts = [f"{k} {v}" for k, v in (f.get("allocation") or {}).items()]
    head = f"- {name}({code}) 持仓（Wind，抓取于 {f.get('fetched_at','?')}）："
    if parts:
        head += "资产配置：" + "、".join(parts)
    top = f.get("top10") or []
    if top:
        head += "\n  重仓股：" + "、".join(
            f"{t['name']}({t.get('weight','?')})" for t in top)
    return head


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-stocks", action="store_true")
    ap.add_argument("--no-full", action="store_true", help="不取技术指标/股东/多期趋势")
    ap.add_argument("--no-funds", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--print", dest="print_only", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="调试用：只取前 N 只个股")
    args = ap.parse_args()

    if args.print_only:
        if os.path.exists(BRIEF_MD):
            print(open(BRIEF_MD, encoding="utf-8").read())
        else:
            print("暂无 Wind 预取结果（data/wind_brief.md 不存在）")
        return 0

    stocks = load_stocks()
    holds = [(c, n) for c, n, k in stocks if k == "hold"]
    watches = [(c, n) for c, n, k in stocks if k == "watch"]
    pool = holds + watches
    if args.limit:
        pool = pool[: args.limit]

    funds = [(c, n) for c, n in holds if is_fund(n, c)]
    eq = [(wind_code(c, n), n) for c, n in pool if not is_fund(n, c)]
    fund_codes = [(wind_code(c, n), n) for c, n in funds]

    w = Wind(use_cache=not args.force)
    snap = w.snapshot(eq, fund_codes,
                      with_stocks=not args.no_stocks,
                      with_funds=not args.no_funds,
                      full=not args.no_full)

    lines = ["## Wind 数据（脚本预取，勿自行调用 Wind 接口）",
             "用法：本块数据直接用于报告——宏观数值进「宏观/事件」段；上证分时节奏与沪深300估值分位进「指数与量能」段"
             "（分位 >80% 说明估值偏贵、<20% 偏便宜，必须原样引用数值，不要自行推断历史分位）；"
             "个股财务/估值/技术指标/前十大股东/多期趋势进个股段；ETF 持仓进 ETF 段。"
             "取不到的项写「暂无」，不得估算或套用旧值。",
             "报告末尾的数据源说明里加一行「数据来源：Wind」，列出本块实际取到的项。",
             f"生成时间：{snap['generated_at']}　标的：持仓 {len(holds)} 只 + 关注 {len(watches)} 只",
             "", "### 宏观", fmt_macro(snap["macro"]),
             "", "### 指数", fmt_index(snap["index"]), fmt_index_val(snap.get("index_val")), ""]
    if not args.no_stocks:
        lines.append("### 个股财务/估值")
        for wc, name in eq:
            lines.append(fmt_stock(wc, name, snap["stocks"].get(wc)))
        lines.append("")
        if not args.no_full:
            lines.append("### 个股技术面（K线与指标，用于判断位置与节奏）")
            for wc, name in eq:
                lines.append(fmt_tech(name, snap["techs"].get(wc)))
            lines.append("")
            lines.append("### 前十大股东（结构，变化需自行比对两期数值）")
            for wc, name in eq:
                lines.append(fmt_holders(name, snap["holders"].get(wc)))
            lines.append("")
            lines.append("### 财务多期趋势（同比在括号里，用于判断加速/减速）")
            for wc, name in eq:
                lines.append(fmt_trend(name, snap.get("trends", {}).get(wc)))
            lines.append("")
    if not args.no_funds:
        lines.append("### 基金持仓/业绩")
        if fund_codes:
            for wc, name in fund_codes:
                lines.append(fmt_fund(wc, name, snap["funds"].get(wc)))
        else:
            lines.append("- 暂无（持仓池中没有 ETF/基金）")
        lines.append("")

    md = "\n".join(lines).rstrip() + "\n"
    os.makedirs(os.path.dirname(BRIEF_MD), exist_ok=True)
    with open(BRIEF_JSON, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=1)
    with open(BRIEF_MD, "w", encoding="utf-8") as f:
        f.write(md)

    ok = sum(1 for v in snap["stocks"].values() if v) + sum(1 for v in snap["funds"].values() if v)
    ok += sum(1 for v in snap.get("techs", {}).values() if v)
    ok += sum(1 for v in snap.get("trends", {}).values() if v)
    ok += sum(1 for v in snap.get("holders", {}).values() if v)
    ok += 1 if snap["macro"] else 0
    ok += 1 if snap["index"] else 0
    ok += 1 if snap.get("index_val") else 0
    total = len(eq) * 4 + len(fund_codes) + 3
    print(md)
    print(f"[wind] 成功 {ok}/{total}，已写入 {BRIEF_MD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
