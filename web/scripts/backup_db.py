#!/usr/bin/env python3
"""SQLite 在线备份：每天一份，保留最近 14 份，文件权限 600。

由 cron 调用（服务器 UTC 19:20 = 北京 03:20）：
    /root/stock-site/venv/bin/python /root/stock-site/scripts/backup_db.py
"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DB = BASE / "data" / "stock.db"
OUT = BASE / "data" / "backups"
KEEP = 14


def main() -> int:
    if not DB.exists():
        print(f"backup failed: {DB} not found")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    os.chmod(OUT, 0o700)
    dst = OUT / f"stock-{time.strftime('%Y%m%d-%H%M%S')}.db"

    # 用普通连接而不是 mode=ro：服务停机时 WAL 没有 -shm，只读连接可能打不开；
    # backup() 本身只读源库，不会改动数据。
    src = sqlite3.connect(DB, timeout=10)
    out = sqlite3.connect(dst, timeout=10)
    try:
        src.execute("PRAGMA busy_timeout=10000")
        src.backup(out)
        ok = out.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        out.close()
        src.close()
    if ok != "ok":
        dst.unlink(missing_ok=True)
        print(f"backup failed: integrity_check={ok}")
        return 1
    os.chmod(dst, 0o600)

    files = sorted(OUT.glob("stock-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[KEEP:]:
        old.unlink(missing_ok=True)
    print(f"backup ok: {dst} ({dst.stat().st_size} bytes), kept {min(len(files), KEEP)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
