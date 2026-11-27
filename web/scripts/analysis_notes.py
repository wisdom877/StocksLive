#!/usr/bin/env python3
"""想法页「需分析」条目的读写辅助（给盘后复盘 / 盘前简报的 cron 用）。

用法
  python3 scripts/analysis_notes.py                 # 列出待分析（近 14 天、未标「已分析」）
  python3 scripts/analysis_notes.py --days 30       # 放宽回看天数
  python3 scripts/analysis_notes.py --all           # 连已分析的也列出来（只看不做）
  python3 scripts/analysis_notes.py --done 12 15    # 给这些 id 追加「已分析」标签
  python3 scripts/analysis_notes.py --answer 12 "今天的答案…"
                                                    # 写回回答（answer）+ 打「已分析」；
                                                    # 回答里可以有换行：用 --answer-file 或传 "-" 从 stdin 读

输出格式（每条形如）：
  #12 [10-24 21:03] 关联:002179宏昌电子 标签:待验证,PCB
    待验证什么：…
    为什么重要：…
    怎么验证：…
    见分晓：…
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import store  # noqa: E402

DONE_TAG = "已分析"


def _cutoff(days: int) -> str:
    return (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")


def _analysis_rows() -> list[dict]:
    """「需分析」= kind 为 analysis 的条目，或标签里写了「需分析」的条目。"""
    rows = store.list_notes(limit=500)
    return [r for r in rows
            if r.get("kind") == "analysis" or "需分析" in (r.get("tags") or [])]


def pending(days: int = 14, include_done: bool = False) -> list[dict]:
    rows = _analysis_rows()
    cut = _cutoff(days)
    out = []
    for r in rows:
        if (r.get("created_at") or "")[:10] < cut:
            continue
        if not include_done and DONE_TAG in (r.get("tags") or []):
            continue
        out.append(r)
    return out


def mark_done(ids: list[int]) -> int:
    n = 0
    for nid in ids:
        rows = [r for r in _analysis_rows() if r["id"] == nid]
        if not rows:
            print(f"#{nid} 不存在或不是需分析条目，跳过")
            continue
        tags = list(rows[0].get("tags") or [])
        if DONE_TAG not in tags:
            tags.append(DONE_TAG)
            store.update_note(nid, tags=tags)
            n += 1
    return n


def answer_note(nid: int, text: str) -> bool:
    """把复盘结论写回这条「分析」并在标签里打上「已分析」。"""
    rows = [r for r in _analysis_rows() if r["id"] == nid]
    if not rows:
        print(f"#{nid} 不存在或不是分析条目，跳过")
        return False
    text = (text or "").strip()
    if not text:
        print(f"#{nid} 回答为空，跳过")
        return False
    tags = list(rows[0].get("tags") or [])
    if DONE_TAG not in tags:
        tags.append(DONE_TAG)
    store.update_note(nid, tags=tags, answer=text)
    print(f"#{nid} 已写回回答（{len(text)} 字）")
    return True


def main() -> None:
    args = sys.argv[1:]
    if "--answer-file" in args or "--answer" in args:
        key = "--answer-file" if "--answer-file" in args else "--answer"
        i = args.index(key)
        rest = args[i + 1:]
        if not rest or not rest[0].isdigit():
            print("用法：--answer <id> <文本>  或  --answer <id> - （从 stdin 读）")
            return
        nid = int(rest[0])
        body = rest[1] if len(rest) > 1 else ""
        if key == "--answer-file" or body == "-":
            src = body if key == "--answer-file" else None
            body = Path(src).read_text(encoding="utf-8") if src else sys.stdin.read()
        answer_note(nid, body)
        return
    if "--done" in args:
        ids = [int(x) for x in args[args.index("--done") + 1:] if x.isdigit()]
        print(f"已标记 {mark_done(ids)} 条为「{DONE_TAG}」")
        return
    days = 14
    if "--days" in args:
        try:
            days = int(args[args.index("--days") + 1])
        except (IndexError, ValueError):
            pass
    rows = pending(days, include_done="--all" in args)
    if not rows:
        print(f"近 {days} 天没有待分析的需分析条目")
        return
    print(f"待分析 {len(rows)} 条（近 {days} 天）：")
    for r in rows:
        code = r.get("stock_code") or ""
        name = ""
        if code:
            s = store.get_stock(code)
            name = (s or {}).get("name") or ""
        tags = ",".join(t for t in (r.get("tags") or []) if t != DONE_TAG)
        head = f"#{r['id']} [{(r.get('created_at') or '')[5:16]}]"
        if code:
            head += f" 关联:{code}{name}"
        if tags:
            head += f" 标签:{tags}"
        print(head)
        for line in (r.get("content") or "").splitlines():
            print("    " + line.strip())
        ans = (r.get("answer") or "").strip()
        if ans:
            print(f"    [已回答 {(r.get('answered_at') or '')[5:16]}]")
            for line in ans.splitlines():
                print("    → " + line.strip())
        else:
            print("    [待回答]")
        print()


if __name__ == "__main__":
    main()
