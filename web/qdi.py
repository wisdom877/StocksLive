"""我的场外基金持仓盈亏：直接按站点「我的持仓」里的基金实时计算，不落库、不预置任何组合。

每个基金的市值 = 持有份额 × 最新官方净值；当日收益 = 份额 × (最新净值 - 前一日净值)；
累计收益 = 市值 - 成本。净值来自 quotes.fund_profile（服务端缓存 30 分钟）。
"""
from __future__ import annotations

import logging

import quotes
import store

log = logging.getLogger("qdi")


def snapshot() -> dict:
    """页面用：组合汇总 + 每只基金的市值/累计。没有基金持仓就返回 {}。"""
    try:
        with store.conn() as c:
            rows = [dict(x) for x in c.execute(
                "SELECT code, name, cost, shares FROM stocks WHERE bucket='hold'")]
    except Exception as e:
        log.warning("读取持仓失败：%s", e)
        return {}

    items = []
    mv_total = cost_total = today_total = dca_total = 0.0
    day = ""
    for f in rows:
        code = str(f.get("code") or "")
        shares = float(f.get("shares") or 0)
        cost = float(f.get("cost") or 0)
        dca = float(f.get("dca") or 0)
        if shares <= 0:
            continue
        try:
            prof = quotes.fund_profile(code)
        except Exception:
            continue
        if not prof.get("ok") or not prof.get("nav"):
            continue
        nav = float(prof["nav"])
        pct = prof.get("pct") or 0.0
        prev_nav = nav / (1 + pct / 100.0) if pct > -100 else nav
        mv = shares * nav
        today = mv - shares * prev_nav
        pnl = mv - cost
        mv_total += mv
        cost_total += cost
        today_total += today
        dca_total += dca
        if prof.get("nav_date") and prof["nav_date"] > day:
            day = prof["nav_date"]
        items.append({
            "code": code, "name": f.get("name") or prof.get("name") or code,
            "mv": round(mv, 2), "cost": round(cost, 2), "pnl": round(pnl, 2),
            "today": round(today, 2), "pct": pct, "dca": round(dca, 2),
        })

    if not items:
        return {}
    return {
        "funds": items,
        "mv": round(mv_total, 2),
        "cost": round(cost_total, 2),
        "pnl": round(mv_total - cost_total, 2),
        "today": round(today_total, 2),
        "dca": round(dca_total, 2),
        "day": day,
        "status": "actual",
    }
