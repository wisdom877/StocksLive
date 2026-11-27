#!/usr/bin/env python3
"""stock-site 部署脚本（带闸门 + 备份 + 回读校验）。

用法：
  python tools/deploy2.py check      # 只跑检查，不上传
  python tools/deploy2.py static     # 只传 static（app 分区 + index.html），不重启
  python tools/deploy2.py backend    # 只传 py 并重启 + 健康检查
  python tools/deploy2.py logrotate  # 安装日志轮转配置（不重启服务）
  python tools/deploy2.py all        # backend + static
上传前闸门：顶层函数重名 → 拒绝；js 语法；py 语法。上传后：md5 回读比对，不一致就报错。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path

import paramiko

HOST = os.environ.get("STOCK_HOST", "")
PORT = int(os.environ.get("STOCK_PORT", "22"))
USER = os.environ.get("STOCK_USER", "")
PWD = os.environ.get("STOCK_PASSWORD", "")
REMOTE = os.environ.get("STOCK_REMOTE", "/www/wwwroot/stock-site")
BASE = Path(__file__).resolve().parent.parent
LOCAL = BASE / "web"
TOOLS = BASE / "tools"
if not (HOST and USER and PWD):
    raise SystemExit("缺少部署环境变量：请先 source tools/deploy.env（STOCK_HOST / STOCK_USER / STOCK_PASSWORD）")

APP_PARTS = ["app-base.js", "app-detail.js", "app-note.js", "app-tag.js",
             "app-trend.js", "app-chart.js", "app-work.js", "app-standby.js", "app-boot.js"]
STATIC_FILES = APP_PARTS + ["index.html", "style.css"]
# 静态图片素材（待机页照片等）：只上传、不做上一版备份（改图就走这里，不挤在 static 根目录）
_SDIR = LOCAL / "static" / "data" / "standby"
STATIC_EXTRA = sorted(f"data/standby/{p.name}" for p in _SDIR.glob("*.jpg")) if _SDIR.exists() else []
# 线上有的 Python 全部纳入（Wind 相关的 wind.py / scripts/wind_brief.py 只在本地，没部署，不上传）。
LOCAL_ONLY = {"wind.py", "wind_brief.py"}
PY_FILES = sorted([p.name for p in LOCAL.glob("*.py") if p.name not in LOCAL_ONLY]
                  + [f"scripts/{p.name}" for p in (LOCAL / "scripts").glob("*.py") if p.name not in LOCAL_ONLY])


def connect(tries: int = 12):
    last = None
    for i in range(tries):
        try:
            c = paramiko.SSHClient()
            c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            c.connect(HOST, PORT, USER, PWD, timeout=15, banner_timeout=25, auth_timeout=25)
            return c
        except Exception as e:  # noqa: BLE001 - 网络抖动全都要重试
            last = e
            print(f"  retry {i} {type(e).__name__}", flush=True)
            time.sleep(4)
    raise last


def run(cmd: str, client=None) -> str:
    """执行命令并返回输出（原来 deploy.py 的 run 不返回文本，这里修掉）。"""
    own = client is None
    c = client or connect()
    try:
        _, out, err = c.exec_command(cmd, timeout=300)
        text = out.read().decode("utf-8", "replace")
        text += err.read().decode("utf-8", "replace")
        return text
    finally:
        if own:
            c.close()


def md5_local(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def check() -> None:
    print("① 顶层函数重名闸门")
    r = subprocess.run(["node", str(TOOLS / "check_dupes.js")] + [str(LOCAL / "static" / n) for n in APP_PARTS],
                       capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode != 0:
        raise SystemExit("✗ 有重名函数，拒绝部署")
    print("② JS 语法")
    for n in APP_PARTS:
        rc = subprocess.run(["node", "--check", str(LOCAL / "static" / n)], capture_output=True, text=True)
        if rc.returncode != 0:
            raise SystemExit(f"✗ {n} 语法错误：{rc.stderr}")
        print(f"  ✓ {n}")
    print("③ Python 语法")
    for n in PY_FILES:
        # 线上是 3.11，本地是 3.12：本地能过的新语法（f-string 里同名嵌套引号）在线上会直接起不来，
        # 所以优先用 3.11 校验，没装才退回当前解释器
        py311 = next((p for p in ("/usr/local/bin/python3.11", "/usr/bin/python3.11") if Path(p).exists()), None)
        rc = subprocess.run([py311 or sys.executable, "-c",
                             f"import ast,pathlib;ast.parse(pathlib.Path(r'{LOCAL / n}').read_text())"],
                            capture_output=True, text=True)
        if rc.returncode != 0:
            raise SystemExit(f"✗ {n} 语法错误：{rc.stderr}")
        print(f"  ✓ {n}")


# 上传前把线上旧版本留一份到 data/deploy-backup/（每个文件只留最近一份，不在 static 里堆历史）。
# 以前每次部署都在原位生成 .bak-时间戳，static 目录下的备份不带登录就能下载，两天堆了 1878 个。
BACKUP_DIR = f"{REMOTE}/data/deploy-backup"


def backup_remote(client, remote_path: str) -> None:
    name = remote_path.rsplit("/", 1)[-1]
    run(f"mkdir -p {BACKUP_DIR} && cp -p {remote_path} {BACKUP_DIR}/{name}.prev 2>/dev/null || true", client)


def deploy_static(client) -> None:
    sftp = client.open_sftp()
    try:
        for n in STATIC_FILES:
            remote = f"{REMOTE}/static/{n}"
            backup_remote(client, remote)
            sftp.put(str(LOCAL / "static" / n), remote)
        if STATIC_EXTRA:
            run(f"mkdir -p {REMOTE}/static/data/standby", client)
            for n in STATIC_EXTRA:
                sftp.put(str(LOCAL / "static" / n), f"{REMOTE}/static/{n}")
    finally:
        sftp.close()
    all_files = STATIC_FILES + STATIC_EXTRA
    local = {n: md5_local(LOCAL / "static" / n) for n in all_files}
    remote_md5 = run("md5sum " + " ".join(f"{REMOTE}/static/{n}" for n in all_files), client)
    for n in all_files:
        line = next((x for x in remote_md5.splitlines() if x.endswith(f"/{n}")), "")
        if local[n] not in line:
            raise SystemExit(f"✗ md5 不一致：{n}")
        print(f"  ✓ {n} {local[n][:10]}")


def deploy_backend(client) -> None:
    sftp = client.open_sftp()
    try:
        for n in PY_FILES:
            remote = f"{REMOTE}/{n}"
            backup_remote(client, remote)
            sftp.put(str(LOCAL / n), remote)
    finally:
        sftp.close()
    for n in PY_FILES:
        print(f"  ✓ 上传 {n}")
    print(run("systemctl restart stock-site; sleep 2; systemctl is-active stock-site", client).strip())
    if not wait_ready(client):
        raise SystemExit("✗ 服务重启后 20 秒内没起来，看 data/service.log")
    print(run("tail -n 12 /www/wwwroot/stock-site/data/service.log", client).strip())


def wait_ready(client, tries: int = 40) -> bool:
    """等 uvicorn 真正能接请求，再让 nginx 重新加载。

    nginx 到 8100 是长连接池：进程一重启，池里的连接全指向死进程，重启后的头几个
    请求会突然 502（实测 2026-11-26 部署后 /market、/rank 各中一次）。reload 之后
    新 worker 的连接池是空的，就不会再撞上。reload 不断流，比 restart 安全。
    """
    for i in range(tries):
        code = run("curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8100/", client).strip()
        if code.endswith("200"):
            print(f"  ✓ 服务已就绪（{i * 0.5:.1f}s）")
            print("  " + run("nginx -t 2>&1 | tail -1 && nginx -s reload && echo 'nginx reloaded'", client).strip())
            return True
        time.sleep(0.5)
    return False


def deploy_logrotate(client) -> None:
    sftp = client.open_sftp()
    try:
        sftp.put(str(TOOLS / "stock-site-logrotate"), "/etc/logrotate.d/stock-site")
    finally:
        sftp.close()
    print(run("chmod 644 /etc/logrotate.d/stock-site && logrotate -d /etc/logrotate.d/stock-site 2>&1 | tail -6", client).strip())


def main() -> None:
    what = sys.argv[1] if len(sys.argv) > 1 else "check"
    check()
    if what == "check":
        return
    c = connect()
    try:
        if what in ("backend", "all"):
            deploy_backend(c)
        if what in ("static", "all"):
            deploy_static(c)
        if what == "logrotate":
            deploy_logrotate(c)
        if what == "all":
            deploy_logrotate(c)
    finally:
        c.close()
    print(f"完成。核对：curl -s http://{HOST}/stocks/ | grep 'app-base'")


if __name__ == "__main__":
    main()
