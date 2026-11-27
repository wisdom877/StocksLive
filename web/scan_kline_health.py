#!/usr/bin/env python3
"""K 线健康巡检：把「标的 × 周期」全打一遍，找出真正取不到数据的点位。

用法（服务器上）：
    /www/wwwroot/stock-site/venv/bin/python scan_kline_health.py            # 只看当前持仓/关注
    /www/wwwroot/stock-site/venv/bin/python scan_kline_health.py --all      # 全市场（需先有 universe.txt）
    /www/wwwroot/stock-site/venv/bin/python scan_kline_health.py --codes 159650,512800

输出：data/kline_health.json + 控制台表格（只打印异常的）。
"""
from __future__ import annotations

import argparse
import threading
from concurrent.futures import ThreadPoolExecutor
import json
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

import kline  # noqa: E402
import store  # noqa: E402

PERIODS = [("min", "分时"), ("day", "日K"), ("week", "周K")]


def universe(all_market: bool, codes_arg: str) -> list[tuple[str, str]]:
    """返回 [(code, name)]。"""
    if codes_arg:
        return [(c.strip(), c.strip()) for c in codes_arg.split(",") if c.strip()]
    if all_market:
        # 趋势页实际扫描的 ETF 全集（trend.py 抓的名单，417 只左右）
        uf = BASE / "data" / "trend_etf" / "universe.json"
        if uf.exists():
            try:
                data = json.loads(uf.read_text(encoding="utf-8"))
                rows = data.get("items") if isinstance(data, dict) else data
                out = [(str(r.get("code") or r.get("symbol") or "").strip(),
                        str(r.get("name") or "").strip()) for r in rows or []]
                out = [(c, n) for c, n in out if c]
                if len(out) >= 200:
                    return out
            except Exception as e:
                print(f"[!] 读 ETF 名单失败：{e}")
        print(f"[!] ETF 名单不存在或过少：{uf}，回退到跟踪标的")
    rows = store.list_stocks()
    tracked = [(r["code"], r.get("name") or r["code"]) for r in rows]
    if not all_market:
        return tracked
    f = BASE / "data" / "universe.txt"
    if not f.exists():
        print(f"[!] 全市场清单不存在：{f}（先用 universe 抓取脚本生成），本次只巡检 {len(tracked)} 只跟踪标的")
        return tracked
    extra = [(line.strip(), line.strip()) for line in f.read_text(encoding="utf-8").splitlines() if line.strip()]
    seen = {c for c, _ in tracked}
    return tracked + [(c, n) for c, n in extra if c not in seen]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="扫趋势页的 ETF 全集（data/trend_etf/universe.json）")
    ap.add_argument("--codes", default="", help="逗号分隔的代码，优先于持仓")
    ap.add_argument("--out", default="data/kline_health.json")
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()

    targets = universe(args.all, args.codes)
    print(f"巡检 {len(targets)} 只 · 周期 {[p for p, _ in PERIODS]}")
    t0 = time.time()
    bad: list[dict] = []
    ok = [0]
    lock = threading.Lock()

    def check(item: tuple[str, str]) -> None:
        code, name = item
        for period, _label in PERIODS:
            try:
                d = kline.fetch(code, period, 480)
            except Exception as e:                      # 上游异常单独记，不和"没数据"混
                rec = {"code": code, "name": name, "period": period,
                       "kind": "error", "detail": str(e)[:90]}
            else:
                if len((d or {}).get("items") or []) == 0:
                    rec = {"code": code, "name": name, "period": period,
                           "kind": "empty", "source": (d or {}).get("source")}
                else:
                    rec = None
            with lock:
                if rec:
                    bad.append(rec)
                else:
                    ok[0] += 1

    done = [0]
    def tick(_f=None):
        done[0] += 1
        if done[0] % 50 == 0:
            print(f"  {done[0]}/{len(targets)} 只 … 异常 {len(bad)}")

    if args.workers > 1 and len(targets) > 20:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
            for f in [ex.submit(check, t) for t in targets]:
                f.add_done_callback(tick)
    else:
        for t in targets:
            check(t)
            tick()
            time.sleep(0.1)     # 少批量时给上游留口气

    out = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "targets": len(targets),
        "checks": len(targets) * len(PERIODS),
        "ok": ok[0],
        "failed": len(bad),
        "elapsed": round(time.time() - t0, 1),
        "items": bad,
    }
    (BASE / args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n完成：{ok[0]} 项正常，{len(bad)} 项异常，用时 {out['elapsed']}s → {args.out}")
    for b in bad[:30]:
        print(f"  [{b['kind']:5s}] {b['code']} {b['name'][:12]} {b['period']:5s} src={b.get('source', '-')}")
    if len(bad) > 30:
        print(f"  … 其余 {len(bad) - 30} 条见 json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
