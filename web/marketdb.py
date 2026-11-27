"""market.db：全市场快照与日线的本地底座。

设计原则：只存「能长期维护」的东西，抓不到就不写，绝不用假数据填。
- snap     每个交易日一份收盘快照（用于排行榜与筛选）
- bars     指数 / 持仓标的的日线（用于曲线与统计）
- idx_snap 指数快照（A股 / 港股 / 美股 / 全球）
- cal_events 财报 / 除权这类日历事件（有源才写）
- runs     每次夜批的执行记录，用来判断数据新不新
"""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DB_PATH = Path(__file__).resolve().parent / "data" / "market.db"
BJ = ZoneInfo("Asia/Shanghai")
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS snap (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  price REAL,
  pct REAL,
  amount REAL,
  turnover REAL,
  pe REAL,
  cap REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (market, code, date)
);
CREATE INDEX IF NOT EXISTS idx_snap_rank ON snap(market, date, pct DESC);
CREATE INDEX IF NOT EXISTS idx_snap_amount ON snap(market, date, amount DESC);

CREATE TABLE IF NOT EXISTS bars (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  o REAL, h REAL, l REAL, c REAL, vol REAL,
  PRIMARY KEY (market, code, date)
);

CREATE TABLE IF NOT EXISTS idx_snap (
  date TEXT NOT NULL,
  group_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (date, group_name)
);

CREATE TABLE IF NOT EXISTS cal_events (
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,          -- report 财报 / dividend 除权除息
  date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (code, kind, date)
);
CREATE INDEX IF NOT EXISTS idx_cal_date ON cal_events(date);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  note TEXT NOT NULL DEFAULT ''
);
"""


def now_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")


def today_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d")


@contextmanager
def conn():
    """一次连接一次关闭（与 store.conn 同一口径），避免长期运行堆句柄。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        raise
    finally:
        c.close()


def init() -> None:
    with _lock, conn() as c:
        c.executescript(SCHEMA)


# ---------------- snap 写入 / 读取 ----------------
def save_snap(market: str, rows: list[dict], date: str | None = None) -> int:
    """rows: code/name/price/pct/amount/turnover/pe/cap"""
    day = date or today_bj()
    ts = now_bj()
    n = 0
    with _lock, conn() as c:
        for r in rows:
            code = str(r.get("code") or "").strip()
            if not code:
                continue
            c.execute(
                "INSERT INTO snap(market,code,date,name,price,pct,amount,turnover,pe,cap,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(market,code,date) DO UPDATE SET name=excluded.name,price=excluded.price,"
                " pct=excluded.pct,amount=excluded.amount,turnover=excluded.turnover,pe=excluded.pe,"
                " cap=excluded.cap,updated_at=excluded.updated_at",
                (market, code, day, str(r.get("name") or ""), r.get("price"), r.get("pct"),
                 r.get("amount"), r.get("turnover"), r.get("pe"), r.get("cap"), ts),
            )
            n += 1
    return n


def latest_date(market: str) -> str | None:
    with conn() as c:
        r = c.execute("SELECT MAX(date) AS d FROM snap WHERE market=?", (market,)).fetchone()
    return r["d"] if r and r["d"] else None


def rank(market: str = "a", by: str = "pct", limit: int = 30, min_pct: float | None = None,
         min_amount: float | None = None, min_turnover: float | None = None,
         max_pe: float | None = None, q: str | None = None) -> dict:
    day = latest_date(market)
    if not day:
        return {"date": None, "items": [], "total": 0}
    col = {"pct": "pct", "amount": "amount", "turnover": "turnover"}.get(by, "pct")
    sql = f"SELECT * FROM snap WHERE market=? AND date=? AND price>0 AND {col} IS NOT NULL"
    args: list = [market, day]
    if min_pct is not None:
        sql += " AND pct>=?"
        args.append(min_pct)
    if min_amount is not None:
        sql += " AND amount>=?"
        args.append(min_amount)
    if min_turnover is not None:
        sql += " AND turnover>=?"
        args.append(min_turnover)
    if max_pe is not None:
        sql += " AND pe IS NOT NULL AND pe>0 AND pe<=?"
        args.append(max_pe)
    if q:
        sql += " AND (code LIKE ? OR name LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    total_sql = sql
    sql += f" ORDER BY {col} DESC LIMIT ?"
    args.append(int(limit))
    with conn() as c:
        rows = [dict(r) for r in c.execute(sql, args).fetchall()]
        total = c.execute(total_sql.replace("SELECT *", "SELECT COUNT(*) AS n"), args[:-1]).fetchone()["n"]
    return {"date": day, "items": rows, "total": total}


def save_bars(market: str, code: str, bars: list[dict]) -> int:
    n = 0
    with _lock, conn() as c:
        for b in bars:
            d = str(b.get("t") or "")[:10]
            if not d:
                continue
            c.execute(
                "INSERT INTO bars(market,code,date,o,h,l,c,vol) VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT(market,code,date) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,"
                " c=excluded.c,vol=excluded.vol",
                (market, code, d, b.get("o"), b.get("h"), b.get("l"), b.get("c"), b.get("v")),
            )
            n += 1
    return n


def save_idx_snap(group_name: str, payload: list[dict] | dict, date: str | None = None) -> None:
    day = date or today_bj()
    with _lock, conn() as c:
        c.execute(
            "INSERT INTO idx_snap(date,group_name,payload,updated_at) VALUES(?,?,?,?)"
            " ON CONFLICT(date,group_name) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
            (day, group_name, json.dumps(payload, ensure_ascii=False), now_bj()),
        )


def save_cal_events(rows: list[dict]) -> int:
    n = 0
    ts = now_bj()
    with _lock, conn() as c:
        for r in rows:
            code, kind, date = str(r.get("code") or ""), str(r.get("kind") or ""), str(r.get("date") or "")[:10]
            if not (code and kind and date):
                continue
            c.execute(
                "INSERT INTO cal_events(code,name,kind,date,title,source,updated_at) VALUES(?,?,?,?,?,?,?)"
                " ON CONFLICT(code,kind,date) DO UPDATE SET name=excluded.name,title=excluded.title,"
                " source=excluded.source,updated_at=excluded.updated_at",
                (code, str(r.get("name") or ""), kind, date, str(r.get("title") or ""),
                 str(r.get("source") or ""), ts),
            )
            n += 1
    return n


def cal_events(days: int = 14, limit: int = 30) -> list[dict]:
    from datetime import timedelta
    today = today_bj()
    end = (datetime.strptime(today, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM cal_events WHERE date>=? AND date<=? ORDER BY date ASC LIMIT ?",
            (today, end, limit)).fetchall()]


def start_run(market: str) -> int:
    with _lock, conn() as c:
        cur = c.execute("INSERT INTO runs(market,started_at,status) VALUES(?,?, 'running')",
                        (market, now_bj()))
        return int(cur.lastrowid)


def finish_run(rid: int, rows: int, status: str, note: str = "") -> None:
    with _lock, conn() as c:
        c.execute("UPDATE runs SET finished_at=?,rows=?,status=?,note=? WHERE id=?",
                  (now_bj(), rows, status, note[:500], rid))


def last_run(market: str | None = None) -> dict | None:
    with conn() as c:
        if market:
            r = c.execute("SELECT * FROM runs WHERE market=? ORDER BY id DESC LIMIT 1", (market,)).fetchone()
        else:
            r = c.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    return dict(r) if r else None


def health() -> dict:
    out = {"db": str(DB_PATH), "snap": {}, "cal": 0, "runs": []}
    with conn() as c:
        for m in ("a", "hk", "us"):
            d = c.execute("SELECT MAX(date) AS d, COUNT(*) AS n FROM snap WHERE market=?", (m,)).fetchone()
            if d and d["d"]:
                n = c.execute("SELECT COUNT(*) AS n FROM snap WHERE market=? AND date=?", (m, d["d"])).fetchone()["n"]
                out["snap"][m] = {"date": d["d"], "rows": n}
        out["cal"] = c.execute("SELECT COUNT(*) AS n FROM cal_events").fetchone()["n"]
        out["runs"] = [dict(r) for r in c.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 5").fetchall()]
    return out


if __name__ == "__main__":
    init()
    print(json.dumps(health(), ensure_ascii=False, indent=1))
