#!/usr/bin/env python3
"""生成发布清单 build/release-manifest.json（CI 与本地通用）。

版本、构建号、提交号都来自环境变量：VER / BUILD / COMMIT。
每个 ipa 记录文件名、字节数、sha256，供服务器登记与 App 端对账。
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import sys
import time
from pathlib import Path


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ver = os.environ.get("VER", "").strip()
    build = os.environ.get("BUILD", "").strip()
    commit = os.environ.get("COMMIT", "").strip()
    if not ver or not build.isdigit():
        print("缺 VER / BUILD 环境变量", file=sys.stderr)
        return 2

    doc = {
        "version": ver,
        "build": int(build),
        "commit": commit,
        "built_at": time.strftime("%Y-%m-%d %H:%M"),
        "ipa": {},
    }
    for p in sorted(Path("build").glob("StocksLive*-*.ipa")):
        plat = "ipad" if "StocksLiveHD" in p.name else "iphone"
        doc["ipa"][plat] = {
            "file": p.name,
            "size": p.stat().st_size,
            "sha256": sha256_of(p),
        }

    if not doc["ipa"]:
        print("build/ 下没有找到 ipa", file=sys.stderr)
        return 3

    out = Path("build/release-manifest.json")
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(doc["ipa"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
