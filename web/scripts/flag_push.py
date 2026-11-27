#!/usr/bin/env python3
"""定时任务用：把检索到的个股新闻/公告推进站点，持仓/关注列表里该股会标红，
用户点开该股（已读）后自动恢复颜色。

用法（在 /root/stock-site 下）：
    venv/bin/python scripts/flag_push.py --stocks        # 先看站点当前持仓/关注（代码以此为准）
    venv/bin/python scripts/flag_push.py --code 603278 \
        --title "大业股份：拟发行可转债募资 6 亿元扩产（上交所公告）" \
        --kind announcement --source 巨潮资讯 \
        --url "https://www.sse.com.cn/..." \
        --published-at "2026-10-26 07:40"
    venv/bin/python scripts/flag_push.py --json '[{"code":"002747","title":"..."}]'
    venv/bin/python scripts/flag_push.py --list        # 看当前未读红标

kind: news / announcement / report / policy
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import store  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--code")
    ap.add_argument("--title")
    ap.add_argument("--kind", default="announcement")
    ap.add_argument("--source", default="")
    ap.add_argument("--url", default="")
    ap.add_argument("--published-at", dest="published_at", default="")
    ap.add_argument("--json", help="直接传 [{code,title,kind,source,url,published_at}, ...]")
    ap.add_argument("--list", action="store_true", help="列出当前未读红标")
    ap.add_argument("--stocks", action="store_true", help="列出站点里的持仓/关注（定时任务用来确认代码）")
    a = ap.parse_args()

    store.init()
    if a.stocks:
        for s in store.list_stocks():
            p = s.get("priority") or ""
            tag = s["bucket"] + (f"/{p}" if p else "")
            print(f"{s['code']} {s['name']}  [{tag}]")
        return 0
    if a.list:
        summ = store.flag_summary()
        if not summ:
            print("当前没有未读红标")
        for code, d in summ.items():
            print(f"{code} {d['name']}  未读 {d['n']} 条 · {d['last']}\n    {d['title'][:80]}")
        return 0

    if a.json:
        try:
            items = json.loads(a.json)
        except json.JSONDecodeError as e:
            print(f"JSON 解析失败：{e}", file=sys.stderr)
            return 2
        if isinstance(items, dict):
            items = [items]
    else:
        if not a.code or not a.title:
            print("需要 --code 和 --title（或用 --json / --list）", file=sys.stderr)
            return 2
        items = [{"code": a.code, "title": a.title, "kind": a.kind,
                  "source": a.source, "url": a.url, "published_at": a.published_at}]

    n = store.flag_push(items)
    print(f"新增红标 {n} 条")
    for it in items:
        code = str(it.get("code") or "")
        if store.get_stock(code):
            print(f"  {code} {store.get_stock(code)['name']} ← {str(it.get('title'))[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
