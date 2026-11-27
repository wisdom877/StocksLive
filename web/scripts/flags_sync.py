#!/usr/bin/env python3
"""把新闻库里命中「持仓 / 关注」个股的条目刷成红标（app 里该股名字变红）。

来源就是站点自己的新闻库：实时快报（财联社/金十，只取 A/B 级或高权重）
+ 日报里挑出的重点（含个股公告、行业新闻）。

用法：
    cd /root/stock-site && venv/bin/python scripts/flags_sync.py            # 默认扫最近 18 小时
    venv/bin/python scripts/flags_sync.py --hours 48
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import store  # noqa: E402

BJ = timezone(timedelta(hours=8))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=18, help="回看多少小时的新闻（默认 18）")
    ap.add_argument("--limit", type=int, default=500, help="最多扫多少条")
    ap.add_argument("--include-report", action="store_true",
                    help="连日报摘录一起扫（复盘长句常顺手提个股，容易刷屏，默认关）")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    store.init()
    since = (datetime.now(BJ) - timedelta(hours=max(1, a.hours))).strftime("%Y-%m-%d %H:%M:%S")
    with store.conn() as c:
        rows = c.execute(
            "SELECT title, source, weight, level, published_at, created_at FROM news"
            " WHERE COALESCE(published_at, created_at) >= ?"
            "   AND (source != 'report' OR ?)"
            "   AND (source != 'live' OR weight >= 8 OR UPPER(COALESCE(level,'')) IN ('A','B'))"
            " ORDER BY id DESC LIMIT ?",
            (since, 1 if a.include_report else 0, max(1, a.limit)),
        ).fetchall()

    added, hits = 0, []
    for r in rows:
        n = store.flag_scan(
            r["title"],
            source=("实时新闻" if r["source"] == "live" else "日报"),
            kind="news",
            published_at=(r["published_at"] or r["created_at"])[:16],
        )
        if n:
            added += n
            hits.append(r["title"][:60])
    # 笔记/想法不再参与个股检索：只有笔记里「显式关联」了个股才会在该股消息里挂一条（见 store.flag_scan_note）。

    if not a.quiet:
        print(f"扫描 {len(rows)} 条新闻，新写红标 {added} 条")
        for h in hits[:20]:
            print("  ·", h)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
