#!/usr/bin/env python3
"""Wind（万得）数据接入层：给报告和站点提供宏观/个股/基金/指数数据。

设计原则
- 不让模型直接调 Wind：统一由脚本预取、落 SQLite 缓存，prompt 只读缓存。
- 任何失败都返回 None / 空，绝不抛异常打断报告生成。
- 每次真实调用都记到 data/wind_usage.log（时间/工具/参数摘要/耗时/成败），便于核对积分消耗。

用法：
    from wind import Wind
    w = Wind()
    w.macro()                      # 宏观一组指标（缓存 7 天）
    w.stock_metrics("600519.SH", name="贵州茅台")   # 财务/估值/股东（缓存 7 天）
    w.fund_holdings("518880.SH", name="黄金ETF华夏") # 持仓（缓存 30 天）
    w.index_intraday("000001.SH")  # 当日分时节奏摘要（每天 1 次）
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.expanduser("~/.agents/skills/wind-mcp-skill")
CLI = os.path.join(SKILL_DIR, "scripts", "cli.mjs")
CACHE_DB = os.path.join(ROOT, "data", "wind_cache.db")
USAGE_LOG = os.path.join(ROOT, "data", "wind_usage.log")
NODE = "node"
TIMEOUT = 45

# 缓存新鲜度（秒）
TTL = {
    "macro": 7 * 86400,
    "stock": 7 * 86400,
    "fund": 30 * 86400,
    "intraday": 6 * 3600,
    "tech": 24 * 3600,
}


def _now():
    return datetime.now(timezone.utc).astimezone()


def _period_key(p: str) -> int:
    """报告期排序键：'Q3 FY2026' → 20263；也兼容 '2026Q3' / '2026-09-30'。"""
    s = str(p or "").strip()
    m = re.search(r"Q([1-4])\s*FY\s*(\d{4})", s, re.I)          # Wind 原样：Q3 FY2026
    if m:
        return int(m.group(2)) * 10 + int(m.group(1))
    m = re.search(r"(\d{4})\s*Q([1-4])", s, re.I)               # 2026Q3
    if m:
        return int(m.group(1)) * 10 + int(m.group(2))
    m = re.match(r"(\d{4})-(\d{2})", s)                          # 2026-09-30
    if m:
        return int(m.group(1)) * 10 + max(1, min(4, (int(m.group(2)) - 1) // 3 + 1))
    return 0


def _log(line: str) -> None:
    try:
        os.makedirs(os.path.dirname(USAGE_LOG), exist_ok=True)
        with open(USAGE_LOG, "a", encoding="utf-8") as f:
            f.write(line.rstrip() + "\n")
    except Exception:
        pass


class Wind:
    def __init__(self, use_cache: bool = True, verbose: bool = False):
        self.use_cache = use_cache
        self.verbose = verbose
        self._init_db()

    # ---------- cache ----------
    def _init_db(self) -> None:
        os.makedirs(os.path.dirname(CACHE_DB), exist_ok=True)
        con = sqlite3.connect(CACHE_DB)
        con.execute(
            """CREATE TABLE IF NOT EXISTS wind_cache(
                   k TEXT PRIMARY KEY, payload TEXT NOT NULL, ts INTEGER NOT NULL)"""
        )
        con.execute(
            """CREATE TABLE IF NOT EXISTS wind_metrics(
                   code TEXT PRIMARY KEY, name TEXT, metrics TEXT, source_time TEXT, ts INTEGER NOT NULL)"""
        )
        con.commit()
        con.close()

    def _cache_get(self, key: str, ttl: int):
        if not self.use_cache:
            return None
        try:
            con = sqlite3.connect(CACHE_DB)
            row = con.execute("SELECT payload, ts FROM wind_cache WHERE k=?", (key,)).fetchone()
            con.close()
            if row and time.time() - row[1] < ttl:
                return json.loads(row[0])
        except Exception:
            pass
        return None

    def _cache_put(self, key: str, payload) -> None:
        try:
            con = sqlite3.connect(CACHE_DB)
            con.execute(
                "INSERT INTO wind_cache(k,payload,ts) VALUES(?,?,?) "
                "ON CONFLICT(k) DO UPDATE SET payload=excluded.payload, ts=excluded.ts",
                (key, json.dumps(payload, ensure_ascii=False), int(time.time())),
            )
            con.commit()
            con.close()
        except Exception:
            pass

    # ---------- transport ----------
    def call(self, server_type: str, tool: str, params: dict):
        """调 cli.mjs，返回解析后的 data 字典；失败返回 None。"""
        if not os.path.exists(CLI):
            _log(f"{_now():%F %T}\tSKILL_MISSING\t{server_type}.{tool}")
            return None
        t0 = time.time()
        try:
            p = subprocess.run(
                [NODE, CLI, "call", server_type, tool, json.dumps(params, ensure_ascii=False)],
                cwd=SKILL_DIR, capture_output=True, text=True, timeout=TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            _log(f"{_now():%F %T}\tTIMEOUT\t{server_type}.{tool}\t{time.time()-t0:.1f}s")
            return None
        except Exception as e:
            _log(f"{_now():%F %T}\tEXEC_ERR\t{server_type}.{tool}\t{e}")
            return None

        dt = time.time() - t0
        raw = (p.stdout or "").strip()
        if not raw:
            _log(f"{_now():%F %T}\tEMPTY\t{server_type}.{tool}\t{dt:.1f}s\t{p.stderr[:120]}")
            return None
        try:
            outer = json.loads(raw)
        except Exception:
            _log(f"{_now():%F %T}\tBAD_JSON\t{server_type}.{tool}\t{dt:.1f}s")
            return None

        if outer.get("ok") is False or outer.get("isError") is True:
            msg = outer.get("message") or ""
            if not msg:
                try:
                    msg = outer["content"][0]["text"][:160]
                except Exception:
                    msg = "unknown"
            _log(f"{_now():%F %T}\tAPI_ERR\t{server_type}.{tool}\t{dt:.1f}s\t{msg[:120]}")
            return None

        try:
            text = outer["content"][0]["text"]
            body = json.loads(text)
        except Exception:
            raw_txt = ""
            try:
                raw_txt = outer["content"][0]["text"][:40]
            except Exception:
                pass
            kind = "NO_DATA" if "没找到数据" in raw_txt else "BAD_BODY"
            _log(f"{_now():%F %T}\t{kind}\t{server_type}.{tool}\t{dt:.1f}s")
            return None

        _log(f"{_now():%F %T}\tOK\t{server_type}.{tool}\t{dt:.1f}s\t{str(params)[:80]}")
        if body.get("error"):
            return None
        # 有些工具（如 EDB 宏观）直接返回 {"metrics":[...]}，没有 data 包裹层
        return body["data"] if isinstance(body, dict) and "data" in body else body

    # ---------- 业务 ----------
    @staticmethod
    def _rows(data) -> list[dict]:
        """把 Wind 结果转成 list[dict]。兼容两种形态：
        {columns:[{name}], rows:[[...]]}  或  {data:[{columns,rows}, ...]}（多结果集）。
        """
        if not isinstance(data, dict):
            return []
        tables = []
        if isinstance(data.get("data"), list):
            tables = [t for t in data["data"] if isinstance(t, dict)]
        elif "columns" in data:
            tables = [data]
        out = []
        for t in tables:
            cols = [c.get("name") for c in t.get("columns") or []]
            units = {c.get("name"): c.get("unit") for c in t.get("columns") or [] if c.get("unit")}
            for r in t.get("rows") or []:
                d = {}
                for k, v in zip(cols, r):
                    if v is None or (isinstance(v, str) and v.strip() in ("None", "None%", "", "--")):
                        continue
                    if k in units and isinstance(v, (int, float)):
                        d[k] = f"{v}{units[k]}"
                    else:
                        d[k] = v
                if d:
                    out.append(d)
        return out

    # 宏观只保留这几类核心指标，其余（预测值/分项）丢掉，报告不需要
    MACRO_KEEP = ("CPI:当月同比", "PPI:当月同比", "制造业PMI", "社会融资规模存量:同比",
                  "M2:同比", "GDP:当季同比")

    def macro(self):
        """宏观核心指标：CPI/PPI/PMI/社融/M2/GDP，各取最近 4 期。缓存 7 天。"""
        key = "macro:v3"
        hit = self._cache_get(key, TTL["macro"])
        if hit is not None:
            return hit
        q = ("提取中国最新一期 CPI 当月同比、PPI 当月同比、制造业 PMI、社会融资规模存量同比、"
             "M2 同比、GDP 当季同比，近 4 期")
        data = self.call("economic_data", "query_economic_indicator_data",
                         {"question": q, "observation": "4"})
        if not isinstance(data, dict):
            return None
        items, seen = [], set()
        for m in data.get("metrics") or []:
            meta = m.get("meta") or {}
            name = meta.get("name") or ""
            if "预测" in name or ":" not in name or name in seen:
                continue
            hit = (
                ("CPI" in name and "当月同比" in name)
                or ("PPI" in name and "当月同比" in name)
                or name == "中国:制造业PMI"
                or ("社会融资规模" in name and "同比" in name)
                or ("M2" in name and "同比" in name)
                or ("GDP" in name and "当季同比" in name)
            )
            if not hit:
                continue
            seen.add(name)
            dates = m.get("date") or []
            vals = m.get("value") or []
            pairs = list(zip(dates, vals))[-4:]
            items.append({
                "name": name, "unit": meta.get("unit", ""), "freq": meta.get("freq", ""),
                "series": [f"{d[:6]}={v}" for d, v in pairs if v is not None],
            })
        if not items:
            return None
        res = {"fetched_at": f"{_now():%F %T}", "items": items}
        self._cache_put(key, res)
        return res

    def stock_metrics(self, code: str, name: str = ""):
        """个股财务/估值/股东：一次调用拿一组字段。缓存 7 天，同时写入 wind_metrics 供页面用。"""
        key = f"stock:{code}"
        hit = self._cache_get(key, TTL["stock"])
        if hit is not None:
            return hit
        q = (f"查询{name or ''}({code})最新报告期的营业收入、营收同比、归母净利润、净利同比、"
             f"ROE、毛利率、PE(TTM)、PB、总市值，以及最近一期前十大流通股东合计持股比例")
        data = self.call("stock_data", "get_stock_fundamentals", {"question": q})
        rows = self._rows(data)
        if not rows:
            return None
        res = {"code": code, "name": name, "fetched_at": f"{_now():%F %T}", "raw": rows[:5]}
        self._cache_put(key, res)
        try:
            con = sqlite3.connect(CACHE_DB)
            con.execute(
                "INSERT INTO wind_metrics(code,name,metrics,source_time,ts) VALUES(?,?,?,?,?) "
                "ON CONFLICT(code) DO UPDATE SET name=excluded.name, metrics=excluded.metrics, "
                "source_time=excluded.source_time, ts=excluded.ts",
                (code, name, json.dumps(rows[:5], ensure_ascii=False), res["fetched_at"], int(time.time())),
            )
            con.commit()
            con.close()
        except Exception:
            pass
        return res

    def fund_holdings(self, code: str, name: str = ""):
        """基金持仓：资产配置 + 前十大重仓股。缓存 30 天。"""
        key = f"fund:{code}"
        hit = self._cache_get(key, TTL["fund"])
        if hit is not None:
            return hit
        q = f"查询{name or ''}({code})最新报告期的资产类别配置比例与前十大重仓股及占比"
        data = self.call("fund_data", "get_fund_holdings", {"question": q})
        rows = self._rows(data)
        if not rows:
            return None
        # 同一返回里常有多张表：一张带「名次」的是重仓股，其余是资产配置
        top10, alloc, seen = [], {}, set()
        for r in rows:
            stock = r.get("前十大重仓股股票名称") or r.get("重仓股股票名称")
            if stock:
                if stock in seen:
                    continue
                seen.add(stock)
                w = (r.get("前十大重仓股市值占基金资产净值比")
                     or r.get("重仓股市值占基金资产净值比"))
                top10.append({"name": stock, "weight": w, "rank": r.get("名次")})
            for k, v in r.items():
                if "占基金资产净值比" in k and "重仓股" not in k and "股票名称" not in k:
                    short = k.replace("最新一期", "").replace("市值占基金资产净值比", "") \
                             .replace("占基金资产净值比", "")
                    alloc.setdefault(short, v)
        if not top10 and not alloc:
            return None
        res = {"code": code, "name": name, "fetched_at": f"{_now():%F %T}",
               "allocation": alloc, "top10": top10[:10]}
        self._cache_put(key, res)
        return res

    @staticmethod
    def _pick(row, *subs, exclude=("周期", "指标选项")):
        """按列名子串取第一个非空值。"""
        for k, v in row.items():
            if any(s in k for s in subs) and not any(e in k for e in exclude) \
                    and v not in (None, "", "None", "None%"):
                return v
        return None

    def stock_technicals(self, code: str, name: str = ""):
        """K线技术指标：均线/MACD/RSI/BOLL + 区间涨跌幅。缓存 1 天。"""
        key = f"tech:{code}"
        hit = self._cache_get(key, TTL["tech"])
        if hit is not None:
            return hit
        q = (f"查询{name}({code})最新MA5、MA20、MA60、MACD、RSI6、"
             f"BOLL上轨/中轨/下轨、近20日涨跌幅、近60日涨跌幅")
        rows = self._rows(self.call("stock_data", "get_stock_technicals", {"question": q}))
        if not rows:
            return None
        r = rows[0]
        res = {
            "code": code, "name": name, "fetched_at": f"{_now():%F %T}",
            "ma5": self._pick(r, "MA5"), "ma20": self._pick(r, "MA20"), "ma60": self._pick(r, "MA60"),
            "macd": self._pick(r, "MACD"), "rsi6": self._pick(r, "RSI6"),
            "boll_up": self._pick(r, "BOLL上轨"), "boll_mid": self._pick(r, "BOLL中轨"),
            "boll_low": self._pick(r, "BOLL下轨"),
            "chg20": self._pick(r, "近20日涨跌幅") or self._pick(r, "近20交易日涨跌幅"),
            "chg60": self._pick(r, "近60日涨跌幅") or self._pick(r, "近60交易日涨跌幅"),
        }
        if not any(res[k] is not None for k in ("ma5", "ma20", "macd", "rsi6")):
            return None
        self._cache_put(key, res)
        return res

    def stock_holders(self, code: str, name: str = ""):
        """前十大股东名单与持股比例（增减持明细本订阅取不到，取不到就返回 None）。缓存 7 天。"""
        key = f"holders:{code}"
        hit = self._cache_get(key, TTL["stock"])
        if hit is not None:
            return hit
        q = f"查询{name}({code})最新一期前十大股东名称及持股比例"
        rows = self._rows(self.call("stock_data", "get_stock_equity_holders", {"question": q}))
        top = []
        for r in rows:
            nm = self._pick(r, "大股东名称", exclude=())
            if not nm:
                continue
            top.append({"rank": self._pick(r, "名次", exclude=()), "name": nm,
                        "ratio": self._pick(r, "大股东持股比例", exclude=("合计", "变化"))})
        if not top:
            return None
        res = {"code": code, "name": name, "fetched_at": f"{_now():%F %T}", "top10": top[:10]}
        self._cache_put(key, res)
        return res

    def stock_trend(self, code: str, name: str = ""):
        """财务多期趋势：近 8 个报告期营收/净利/ROE 及同比。缓存 7 天。"""
        key = f"trend:{code}"
        hit = self._cache_get(key, TTL["stock"])
        if hit is not None:
            # 老缓存是按「旧 → 新」写的，读出来也统一倒序一次
            hit["series"] = sorted(hit.get("series") or [],
                                   key=lambda x: _period_key(x.get("period")), reverse=True)
            return hit
        q = (f"查询{name}({code})近8个报告期的营业收入、营业收入同比增长率、"
             f"归母净利润、净利润同比增长率、ROE")
        rows = self._rows(self.call("stock_data", "get_stock_fundamentals", {"question": q}))
        series = []
        for r in rows:
            period = self._pick(r, "日期", "报告期", exclude=())
            if not period:
                continue
            series.append({
                "period": period,
                "rev": self._pick(r, "营业收入", exclude=("同比", "增长")),
                "rev_yoy": self._pick(r, "营业收入同比", "营收同比", exclude=()),
                "np": self._pick(r, "归母净利润", "净利润", exclude=("同比", "增长")),
                "np_yoy": self._pick(r, "净利润同比", exclude=()),
                "roe": self._pick(r, "ROE", exclude=("同比",)),
            })
        if not series:
            return None
        # 上游按「旧 → 新」返回（Q4 FY2024 … Q3 FY2026），页面把第一条当「最新一期」，
        # 所以这里统一按报告期倒序排，最新一期必须在最前。
        series.sort(key=lambda x: _period_key(x["period"]), reverse=True)
        res = {"code": code, "name": name, "fetched_at": f"{_now():%F %T}", "series": series[:8]}
        self._cache_put(key, res)
        return res

    def index_valuation(self, code: str = "000300.SH", name: str = "沪深300"):
        """指数估值：PE/PB + 近十年 PE 分位。缓存 1 天。"""
        key = f"val:{code}"
        hit = self._cache_get(key, TTL["tech"])
        if hit is not None:
            return hit
        q = f"查询{name}指数({code})最新市盈率PE_TTM、市净率PB_LF、以及最新市盈率在过去10年的分位数"
        rows = self._rows(self.call("index_data", "get_index_fundamentals", {"question": q}))
        if not rows:
            return None
        # 多张结果表混在一起：逐行扫描，取第一个非空
        def scan(*subs, exclude=("序号", "最大")):
            for r in rows:
                v = self._pick(r, *subs, exclude=exclude)
                if v is not None:
                    return v
            return None
        res = {
            "code": code, "name": name, "fetched_at": f"{_now():%F %T}",
            "pe": scan("最新市盈率", "过去10年市盈率", exclude=("分位", "序号", "最大")),
            "pb": scan("市净率", "过去10年市净率", exclude=("分位", "序号")),
            "pe_pct10y": scan("分位数", exclude=("序号",)),
            "date": scan("日期", exclude=()),
        }
        if res["pe"] is None and res["pe_pct10y"] is None:
            return None
        self._cache_put(key, res)
        return res

    def index_intraday(self, code: str = "000001.SH"):
        """当日分时节奏摘要：把 240 根分钟线压成上午/下午/尾盘三段 + 放量时点。"""
        key = f"intraday:{code}"
        hit = self._cache_get(key, TTL["intraday"])
        if hit is not None:
            return hit
        data = self.call("index_data", "get_index_quote", {"windcode": code})
        rows = self._rows(data)
        if not rows:
            return None
        pts = []
        for r in rows:
            try:
                pts.append((r.get("TIME", ""), float(r.get("MATCH")), float(r.get("TURNOVER") or 0)))
            except Exception:
                continue
        if not pts:
            return None
        noon = [p for p in pts if p[0][11:16] <= "11:30"]
        tail = [p for p in pts if p[0][11:16] > "14:30"]
        peak = max(pts, key=lambda x: x[2])
        res = {
            "code": code,
            "fetched_at": f"{_now():%F %T}",
            "open": pts[0][1], "close": pts[-1][1],
            "high": max(p[1] for p in pts), "low": min(p[1] for p in pts),
            "am_change": round(pts[len(noon) - 1][1] - pts[0][1], 2) if noon else None,
            "pm_change": round(pts[-1][1] - pts[len(noon) - 1][1], 2) if noon else None,
            "tail_change": round(pts[-1][1] - tail[0][1], 2) if tail else None,
            "peak_turnover_min": peak[0][11:16],
            "peak_turnover": peak[2],
            "bars": len(pts),
        }
        self._cache_put(key, res)
        return res

    def snapshot(self, stocks: list[tuple[str, str]], funds: list[tuple[str, str]],
                 index_code: str = "000001.SH", with_stocks: bool = True,
                 with_funds: bool = True, full: bool = True):
        """一次性预取，返回给 prompt 用的字典；任一环节失败该键为 None。

        full=True 时额外取：个股技术指标/前十大股东/财务多期趋势 + 沪深300估值分位。
        """
        out = {"generated_at": f"{_now():%F %T}", "macro": None, "stocks": {},
               "funds": {}, "index": None, "techs": {}, "trends": {},
               "holders": {}, "index_val": None}
        out["macro"] = self.macro()
        out["index"] = self.index_intraday(index_code)
        out["index_val"] = self.index_valuation()
        if with_stocks:
            for code, name in stocks:
                try:
                    out["stocks"][code] = self.stock_metrics(code, name)
                except Exception:
                    out["stocks"][code] = None
                if not full:
                    continue
                for key, fn in (("techs", self.stock_technicals),
                                ("trends", self.stock_trend),
                                ("holders", self.stock_holders)):
                    try:
                        out[key][code] = fn(code, name)
                    except Exception:
                        out[key][code] = None
        if with_funds:
            for code, name in funds:
                try:
                    out["funds"][code] = self.fund_holdings(code, name)
                except Exception:
                    out["funds"][code] = None
        return out
