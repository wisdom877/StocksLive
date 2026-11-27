#!/usr/bin/env python3
"""截止提醒：把 work_tasks.due_at 变成「快到了」的系统通知。

网页做不到「通知里每秒走字」，能做的是准点提醒。这个脚本就是那一半：
每分钟跑一次，扫今天还没完成的任务，在 T-30 / T-10 / T-1 分钟各推一条，
同一条任务同一个阈值只发一次（状态落在 data/notify_state.json）。

用法：
  python3 notify.py --dry      # 只打印这一分钟该发什么，不发
  python3 notify.py --tick     # 按配置发（data/notify.json 里 enabled=true 才真的发）
  python3 notify.py --test     # 立刻发一条测试通知
  python3 notify.py --list     # 看今天剩下的任务

配置 data/notify.json（不存在=未启用，脚本安静退出）：
  {
    "enabled": false,
    "thresholds": [30, 10, 1],
    "bark": {"url": "https://api.day.app", "key": "", "group": "stock"},
    "ntfy": {"server": "", "topic": "", "priority": "high"}
  }
"""
from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "data" / "stock.db"
CONF_PATH = BASE / "data" / "notify.json"
STATE_PATH = BASE / "data" / "notify_state.json"
BJ = timezone(timedelta(hours=8))

log = logging.getLogger("notify")


def _conf() -> dict:
    try:
        return json.loads(CONF_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"sent": {}}


def _save_state(st: dict) -> None:
    cutoff = time.time() - 3 * 86400
    st["sent"] = {k: v for k, v in st.get("sent", {}).items() if float(v) >= cutoff}
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE_PATH)


def due_tasks(now: datetime, horizon_min: int) -> list[dict]:
    """今天还没完成、且截止时间落在 [now, now+horizon] 的任务。"""
    if not DB_PATH.exists():
        return []
    lo = now.strftime("%Y-%m-%d %H:%M")
    hi = (now + timedelta(minutes=horizon_min)).strftime("%Y-%m-%d %H:%M")
    c = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    c.row_factory = sqlite3.Row
    try:
        rows = c.execute(
            "SELECT id, title, note, due_at, done FROM work_tasks "
            "WHERE done = 0 AND due_at >= ? AND due_at <= ? ORDER BY due_at",
            (lo, hi),
        ).fetchall()
    except sqlite3.Error as e:
        log.warning("读任务失败：%s", e)
        return []
    finally:
        c.close()
    return [dict(r) for r in rows]


DAILY_PATH = BASE / "data" / "daily.json"


def _daily() -> list:
    try:
        items = json.loads(DAILY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [x for x in items if isinstance(x, dict) and x.get("time") and x.get("on", True)]


def _pick_threshold(remain_min: float, thresholds: list[int]) -> int | None:
    """取最紧的那个还没越过的阈值，避免一次任务连发三条。"""
    for t in sorted(thresholds):
        if remain_min <= t:
            return t
    return None


def plan(now: datetime, conf: dict) -> list[dict]:
    thresholds = sorted({int(x) for x in (conf.get("thresholds") or [30, 10, 1])})
    tasks = due_tasks(now, max(thresholds) + 1)
    st = _state()
    out: list[dict] = []
    for t in tasks:
        due = datetime.strptime(t["due_at"], "%Y-%m-%d %H:%M").replace(tzinfo=BJ)
        remain = (due - now).total_seconds() / 60.0
        if remain < 0:
            continue
        th = _pick_threshold(remain, thresholds)
        if th is None:
            continue
        key = f"{t['id']}:{th}"
        if key in st.get("sent", {}):
            continue
        mins = int(round(remain))
        out.append({
            "key": key,
            "title": t["title"],
            "due": t["due_at"],
            "remain": mins,
            "body": f"还有 {mins} 分钟 · {t['due_at'][11:]} 截止",
            "urgent": th <= 1,
        })
    # 每日提醒：App 没开着的时候由这一支兜住（同一分钟内只发一次，key 带日期）
    hm = now.strftime("%H:%M")
    wd = now.weekday()
    for it in _daily():
        if it["time"] != hm:
            continue
        if it.get("days") == "work" and wd >= 5:
            continue
        key = f"d{it.get('id')}:{now.strftime('%Y-%m-%d')}"
        if key in st.get("sent", {}):
            continue
        out.append({
            "key": key,
            "title": it.get("text") or "每日提醒",
            "due": f"{now.strftime('%Y-%m-%d')} {hm}",
            "remain": 0,
            "body": f"每日提醒 · {hm}",
            "urgent": False,
        })
    return out


def _bark(cfg: dict, title: str, body: str, urgent: bool) -> bool:
    key = (cfg.get("key") or "").strip()
    if not key:
        return False
    base = (cfg.get("url") or "https://api.day.app").rstrip("/")
    # Bark 的路径式接口：/key/title/body，参数走 query
    url = f"{base}/{key}/{requests.utils.quote(title)}/{requests.utils.quote(body)}"
    params = {"group": cfg.get("group") or "stock", "level": "timeSensitive"}
    if urgent:
        params["sound"] = "alarm"
    requests.get(url, params=params, timeout=6)
    return True


def _ntfy(cfg: dict, title: str, body: str, urgent: bool) -> bool:
    server = (cfg.get("server") or "").rstrip("/")
    topic = (cfg.get("topic") or "").strip()
    if not (server and topic):
        return False
    # ntfy 的 JSON 发布口：中文标题/正文放 body 里，别塞 HTTP 头（头只能 ASCII）
    payload = {
        "topic": topic,
        "title": title,
        "message": body,
        "priority": 5 if urgent else 3,
        "tags": ["alarm_clock"] if urgent else ["hourglass"],
    }
    requests.post(server + "/", json=payload, timeout=6)
    return True


def send(title: str, body: str, urgent: bool, conf: dict, dry: bool) -> list[str]:
    cfg = conf or {}
    done: list[str] = []
    for name, fn in (("bark", _bark), ("ntfy", _ntfy)):
        sub = cfg.get(name) or {}
        if not any(sub.values()):
            continue
        if dry:
            done.append(f"[dry] {name}: {title} / {body}")
            continue
        try:
            if fn(sub, title, body, urgent):
                done.append(name)
        except Exception as e:
            log.warning("%s 发送失败：%s", name, e)
    return done


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tick", action="store_true", help="按配置发一轮")
    ap.add_argument("--dry", action="store_true", help="只打印")
    ap.add_argument("--test", action="store_true", help="发一条测试")
    ap.add_argument("--list", action="store_true", help="列出今天剩余任务")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    conf = _conf()
    now = datetime.now(BJ).replace(second=0, microsecond=0)

    if args.list:
        for t in due_tasks(now, 24 * 60):
            print(t["due_at"], t["title"])
        return

    if args.test:
        got = send("测试 · 关闭免打扰", "还有 10 分钟 · 10:00 截止", False, conf, dry=False)
        print("已发送：", got or "没有可用的通道（先在 data/notify.json 填 bark.key 或 ntfy）")
        return

    if not (args.tick or args.dry):
        ap.print_help()
        return

    if args.tick and not conf.get("enabled"):
        return                      # 未启用：安静退出，别在日志里刷存在感

    items = plan(now, conf)
    if not items:
        if args.dry:
            print("这一分钟没有要发的提醒")
        return

    st = _state()
    for it in items:
        got = send(it["title"], it["body"], it["urgent"], conf, dry=args.dry)
        print(f"{it['due']} {it['title']} → {it['body']} {got}")
        if args.dry:
            continue
        if got:
            st.setdefault("sent", {})[it["key"]] = time.time()
    if not args.dry:
        _save_state(st)


if __name__ == "__main__":
    sys.exit(main())
