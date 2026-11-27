"""个股资金流向：新浪资金流历史（主力净额，免费稳定），东财作为兜底。

字段口径：main = 主力净额（r0_net），total = 总净额（netamount），单位元。
"""
from __future__ import annotations

import requests

import quotes

SINA_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs"
DETAIL_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssi_ssfx_flzjtj"
EM_URL = "https://push2his.eastmoney.com/api/qt/stock/fflow/kline/get"
HEAD_SINA = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn/"}
HEAD_EM = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}


def _sina(code: str, days: int) -> list[dict]:
    r = requests.get(SINA_URL, params={"page": 1, "num": days, "sort": "opendate",
                                       "asc": 0, "daima": quotes.secid(code)},
                     headers=HEAD_SINA, timeout=8)
    rows = r.json() or []
    items = []
    for x in rows:
        try:
            items.append({
                "date": x["opendate"],
                "main": float(x["r0_net"]),
                "total": float(x.get("netamount") or 0),
                "close": float(x["trade"]),
                "chg": round(float(x["changeratio"]) * 100, 2),
            })
        except (KeyError, TypeError, ValueError):
            continue
    items.sort(key=lambda i: i["date"])
    return items


def _detail(code: str) -> dict | None:
    """当日资金明细：超大/大/中/小单净额与净占比（新浪 r0-r3 口径）。"""
    try:
        r = requests.get(DETAIL_URL, params={"daima": quotes.secid(code)},
                         headers=HEAD_SINA, timeout=8)
        j = r.json() or {}
        vol = float(j.get("volume") or 0)
        price = float(j.get("trade") or 0)
        amount = vol * price
        names = {"0": "超大单", "1": "大单", "2": "中单", "3": "小单"}
        rows = []
        for i in ("0", "1", "2", "3"):
            net = float(j.get(f"r{i}_in") or 0) - float(j.get(f"r{i}_out") or 0)
            rows.append({"name": names[i], "net": round(net, 2),
                         "pct": round(net / amount * 100, 2) if amount else 0})
        main = rows[0]["net"] + rows[1]["net"]
        return {"rows": rows, "main": round(main, 2),
                "main_pct": round(main / amount * 100, 2) if amount else 0,
                "amount": round(amount, 2), "date": ""}
    except Exception:
        return None


def _em(code: str, days: int) -> list[dict]:
    sym = quotes.secid(code)
    secid = ("1." if sym.startswith("sh") else "0.") + sym[2:]
    r = requests.get(EM_URL, params={"secid": secid, "lmt": 0, "klt": 101,
                                     "fields1": "f1,f2,f3,f7",
                                     "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63"},
                     headers=HEAD_EM, timeout=8)
    rows = (r.json().get("data") or {}).get("klines") or []
    items = []
    for line in rows:
        f = line.split(",")
        if len(f) < 13:
            continue
        try:
            items.append({"date": f[0], "main": float(f[1]), "total": float(f[1]),
                          "close": float(f[11]), "chg": float(f[12])})
        except ValueError:
            continue
    return items[-days:]


def fetch(code: str, days: int = 20) -> dict:
    days = max(5, min(int(days or 20), 60))
    items: list[dict] = []
    src = "sina"
    try:
        items = _sina(code, days)
    except Exception:
        items = []
    if not items:
        try:
            items = _em(code, days)
            src = "eastmoney"
        except Exception:
            items = []
            src = "none"
    items = items[-days:]

    def total(n: int) -> float | None:
        part = items[-n:]
        return round(sum(x["main"] for x in part), 2) if part else None

    detail = _detail(code)
    if detail and items:
        detail["date"] = items[-1]["date"]
    return {
        "code": code, "source": src, "items": items, "detail": detail,
        "sum": {"1": total(1), "5": total(5), "10": total(10), "20": total(20)},
        "today": items[-1] if items else None,
    }
