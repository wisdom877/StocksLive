#!/usr/bin/env python3
"""收盘趋势扫描 cron 入口。

- 2026-11-14 起 trend.py 默认 MODE="etf"，本 cron 扫的是沪深 ETF（原选股代码保留）；
- 非交易日直接退出；
- 默认班（15:30）：当天已有完整结果（date=今天、非盘中、failed=0）则跳过；
- --refresh 班（16:20）：强制重抓，接住收盘后迟到的行情修正；
- 任何一班失败都会在日志里留错误，不会静默跳过。
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import quotes
import trend


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--refresh", action="store_true", help="强制重抓（16:20 复核班）")
    p.add_argument("--ignore-calendar", action="store_true",
                   help="忽略交易日判断，手动扫一次（周末想看到最近交易日结果时用）")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("trend.cron")
    today = datetime.now(quotes.BJ).strftime("%Y-%m-%d")
    if not quotes.is_trading_day(today) and not args.ignore_calendar:
        log.info("%s 不是交易日，跳过趋势扫描（手动扫可加 --ignore-calendar）", today)
        return 0
    if not args.refresh:
        cur = trend.latest()
        if (cur.get("available") and cur.get("date") == today
                and not cur.get("failed") and not cur.get("intraday")):
            log.info("%s 趋势扫描已完成（命中 %s），跳过；16:20 复核班仍会刷新",
                     today, cur.get("passed"))
            return 0
    if args.ignore_calendar:
        log.info("忽略交易日判断，手动扫描 %s", today)
        return trend.main(["--force"])
    return trend.main(["--force"] if args.refresh else [])


if __name__ == "__main__":
    raise SystemExit(main())
