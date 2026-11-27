"""筹码分布（估算）：按日 K + 换手率衰减的三角分布模型。

没有可靠的免费官方筹码接口（东财 cyq 被限流、雪球 WAF、同花顺需登录），
这里用通行算法估算：每日新增筹码按当日价格区间三角分布，旧筹码按换手率衰减。
输出：获利比例、平均成本、90% 成本区间、成本分布直方图。
"""
from __future__ import annotations


import kline
import quotes


def fetch(code: str, days: int = 120) -> dict:
    days = max(60, min(int(days or 120), 240))
    q = quotes.fetch([code]).get(code) or {}
    try:
        vol = float(q.get("volume") or 0)      # 手
        turnover = float((q.get("turnover") or "0").strip("%") or 0) / 100.0
    except (TypeError, ValueError):
        vol, turnover = 0.0, 0.0
    float_shares = (vol * 100 / turnover) if turnover > 0 else 0.0

    k = kline.fetch(code, "day", days)
    bars = k.get("items") or []
    if len(bars) < 20 or float_shares <= 0:
        return {"code": code, "ok": False, "reason": "数据不足（缺换手率或K线）"}

    lo = min(b["l"] for b in bars)
    hi = max(b["h"] for b in bars)
    if hi <= lo:
        return {"code": code, "ok": False, "reason": "价格区间异常"}
    bins = 80
    w = (hi - lo) / bins
    chips = [0.0] * bins

    for b in bars:
        tr = min(0.8, max(0.0, b["v"] * 100 / float_shares))
        for i in range(bins):
            chips[i] *= (1 - tr)
        mid = (b["h"] + b["l"] + b["c"]) / 3
        span = max((b["h"] - b["l"]) / 2, w)
        add = 0.0
        weights = []
        for i in range(bins):
            p = lo + (i + 0.5) * w
            wt = max(0.0, 1 - abs(p - mid) / span)
            weights.append(wt)
            add += wt
        if add > 0:
            for i in range(bins):
                chips[i] += tr * weights[i] / add

    total = sum(chips) or 1.0
    cur = bars[-1]["c"]
    profit = sum(chips[i] for i in range(bins) if lo + (i + 0.5) * w <= cur) / total
    avg = sum((lo + (i + 0.5) * w) * chips[i] for i in range(bins)) / total

    def pct(p):
        acc = 0.0
        for i in range(bins):
            acc += chips[i]
            if acc / total >= p:
                return lo + (i + 0.5) * w
        return hi

    return {
        "code": code, "ok": True, "current": cur, "profit_ratio": round(profit * 100, 1),
        "avg_cost": round(avg, 2), "low90": round(pct(0.05), 2), "high90": round(pct(0.95), 2),
        "bars": [{"p": round(lo + (i + 0.5) * w, 2), "w": round(chips[i] / total, 4)} for i in range(bins)],
        "days": len(bars), "note": "按日K+换手率估算",
    }
