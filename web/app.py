"""A股日刊 v2：报告/要闻 · 持仓 · 关注 · 想法。运行在 127.0.0.1:8099，由 nginx 反代 /stocks/。"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import urllib.parse
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import BackgroundTasks, Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import requests

import board as board_mod
import brief
import chip
import digest_tts
import etf as etf_mod
import fundflow
import heat
import hot
import kline as kline_mod
import tags as tags_mod
import livefeed
import marketdb
import market_calendar
import company_profile as profile_mod
import quotes
import qdi
import store
import quote_service
import trend
import weather
import urllib.request
import urllib.error

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
STATIC = BASE / "static"
SESSION_TTL = 24 * 3600
TOKEN_TTL = 30 * 24 * 3600
APP_TTL = 365 * 24 * 3600
FEED_LIVE_LIMIT = 60   # 首屏只带 60 条，更多走 /api/v1/live 按需加载

# 首次启动（data/auth.json 不存在）时的初始密码：环境变量优先，否则随机生成并打日志，
# 不再内置任何固定密码（原主人设置的密码已从代码中彻底移除）
DEFAULT_PASSWORD = os.environ.get("STOCK_SITE_PASSWORD", "")
log = logging.getLogger("stock-site")
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_handler)
    log.setLevel(logging.INFO)
    log.propagate = False


def _load_secret() -> bytes:
    p = DATA / "secret"
    if not p.exists():
        p.write_bytes(secrets.token_bytes(32))
        p.chmod(0o600)
    return p.read_bytes()


def _load_hash() -> tuple[bytes, bytes]:
    p = DATA / "auth.json"
    if not p.exists():
        pw = DEFAULT_PASSWORD or secrets.token_urlsafe(12)
        salt = secrets.token_bytes(16)
        h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 200_000)
        p.write_text(json.dumps({"salt": salt.hex(), "hash": h.hex()}))
        p.chmod(0o600)
        log.warning("初始化登录密码：%s（请登录后自行保管）", pw)
    d = json.loads(p.read_text())
    return bytes.fromhex(d["salt"]), bytes.fromhex(d["hash"])


def _load_appkey() -> str:
    """APK 内嵌的长期访问密钥：?k=<key> 直接换 365 天 cookie，不需要输密码。"""
    p = DATA / "appkey"
    if not p.exists():
        p.write_text(secrets.token_urlsafe(24))
        p.chmod(0o600)
    return p.read_text().strip()


SECRET = _load_secret()
SALT, PASS_HASH = _load_hash()
APP_KEY = _load_appkey()


def check_password(pw: str) -> bool:
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), SALT, 200_000)
    return hmac.compare_digest(h, PASS_HASH)


def _sign(exp: int) -> str:
    msg = str(exp).encode()
    return f"{exp}.{hmac.new(SECRET, msg, hashlib.sha256).hexdigest()}"


def _verify(val: str | None) -> bool:
    if not val or "." not in val:
        return False
    exp_s, sig = val.rsplit(".", 1)
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(sig, hmac.new(SECRET, exp_s.encode(), hashlib.sha256).hexdigest())


def is_authed(request: Request) -> bool:
    if _verify(request.cookies.get("sk")):
        return True
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer ") and _verify(auth[7:].strip()):
        return True
    return False


def require_auth(request: Request) -> None:
    if not is_authed(request):
        raise HTTPException(status_code=401, detail="未登录")


def require_app(request: Request) -> None:
    """本机脚本 / 定时任务用：cookie、Bearer token 或 X-App-Key（data/appkey）任一通过。"""
    k = (request.headers.get("x-app-key") or request.query_params.get("k") or "").strip()
    if k and hmac.compare_digest(k, APP_KEY):
        return
    require_auth(request)


def _etag_response(request: Request, payload: dict, hash_payload: dict | None = None) -> Response:
    """带 ETag 的 JSON 响应：内容没变返回 304，省隧道流量。

    hash_payload 用于排除 server_time 这类每次都变、但客户端并不依赖的字段，
    否则 ETag 每秒都不同，永远命中不了 304。
    """
    stable = payload if hash_payload is None else hash_payload
    etag = '"' + hashlib.sha1(
        json.dumps(stable, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    inm = request.headers.get("if-none-match", "")
    if inm and any(v.strip().removeprefix("W/") == etag for v in inm.split(",")):
        return Response(status_code=304, headers=headers)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return Response(content=body, media_type="application/json", headers=headers)


def _warm_hot():
    """启动即预热热门板块：有磁盘快照是秒回 + 后台刷新，没有就现抓一次。"""
    try:
        hot.payload()
    except Exception as e:
        log.warning("hot warmup failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init()
    store.sync_reports()
    store.purge_trash()
    store.prune_digests()
    digest_tts.prune()
    threading.Thread(target=_warm_hot, daemon=True).start()
    # 手表快照预热：进程启动 3 秒后在后台算一次，首个请求直接命中
    quote_service.warm("watch_summary", _watch_summary_build, delay=3)
    brief.start()
    try:
        import monitor
        monitor.start()
    except Exception as e:
        log.warning("异动监控没起来：%s", e)

    async def sync_loop():
        while True:
            await asyncio.sleep(300)
            try:
                store.sync_reports()
            except Exception as e:
                log.warning("report sync failed: %s", e)

    async def live_loop():
        while True:
            try:
                await asyncio.to_thread(livefeed.refresh)
            except Exception as e:
                log.warning("livefeed refresh failed: %s", e)
            # A 级通知要求时效：CLS 增量拉取 1 次/分钟，成本很低
            await asyncio.sleep(60)

    async def stock_news_loop():
        """个股详情「公司 · 消息」只看近 2h 实时新闻：每小时整点后匹配一次。"""
        while True:
            try:
                await asyncio.to_thread(store.sync_live_news, 2)
            except Exception as e:
                log.warning("stock live news sync failed: %s", e)
            now = datetime.now(store.BJ)
            nxt = now.replace(minute=5, second=0, microsecond=0)
            if nxt <= now:
                nxt += timedelta(hours=1)
            await asyncio.sleep((nxt - now).total_seconds())

    tasks = [asyncio.create_task(sync_loop()), asyncio.create_task(live_loop()),
             asyncio.create_task(stock_news_loop())]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="A股日刊", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


# ---------------- auth ----------------
def _cookie_response(payload: dict, ttl: int) -> JSONResponse:
    exp = int(time.time()) + ttl
    r = JSONResponse(dict(payload, ok=True, expires_at=exp))
    r.set_cookie("sk", _sign(exp), max_age=ttl, httponly=True, samesite="lax", path="/stocks")
    return r


@app.post("/api/v1/login")
def login(password: str = Body(..., embed=True)):
    if not check_password(password):
        raise HTTPException(status_code=401, detail="密码不正确")
    return _cookie_response({}, SESSION_TTL)


@app.post("/api/v1/logout")
def logout():
    r = JSONResponse({"ok": True})
    r.delete_cookie("sk", path="/stocks")
    return r


@app.get("/api/v1/session")
def session(request: Request):
    return {"authed": is_authed(request)}


@app.post("/api/v1/token")
def issue_token(password: str = Body(..., embed=True)):
    """给安卓 APK / 第三方客户端用的长期令牌（30 天）。"""
    if not check_password(password):
        raise HTTPException(status_code=401, detail="密码不正确")
    exp = int(time.time()) + TOKEN_TTL
    return {"token": _sign(exp), "expires_at": exp}


# ---------------- quotes ----------------
def _codes() -> list[str]:
    return [s["code"] for s in store.list_stocks()]


@app.get("/api/v1/quotes")
def get_quotes(codes: str = "", _: None = Depends(require_auth)):
    """不带 codes 时返回全部持仓/关注快照；带 codes 时按逗号分隔批量取（ETF 前十大持仓用）。"""
    if codes:
        lst = [x.strip() for x in codes.split(",") if x.strip()]
        lst = [x for x in lst if len(x) == 6 and x.isdigit()][:30]
        return quote_service.quotes_snapshot(lst)
    return quote_service.quotes_snapshot(_codes())


@app.get("/api/v1/health")
def health(_: None = Depends(require_app)):
    """本机/监控用：行情缓存年龄、上游最近错误、实时新闻游标。"""
    m = quotes.market_status()
    return {
        "ok": True,
        "time": m["server_time"],
        "market": m,
        "quotes": quotes.cache_info(),
        "unified": quote_service.stats(),
        "live_at": store.last_live_at(),
    }


@app.post("/api/v1/debug/probe")
def debug_probe(request: Request, payload: dict = Body(...), _: None = Depends(require_app)):
    """前端版面抖动探针：只在 ?dbg=jitter 时上报，写 data/jitter.log 供排查。"""
    rec = {"ts": int(time.time()), "ua": (request.headers.get("user-agent") or "")[:140],
           "d": payload}
    try:
        with open(DATA / "jitter.log", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError as e:
        log.warning("probe 写盘失败：%s", e)
    return {"ok": True}


@app.get("/api/v1/kline/health")
def kline_health(_: None = Depends(require_app)):
    """K 线巡检结果（scan_kline_health.py 每天收盘后由 stock-khealth.timer 生成）。

    没有文件说明还没跑过 → 返回 404 和怎么补跑，而不是空对象让人以为一切正常。
    """
    for name in ("kline_health_all.json", "kline_health.json"):
        f = DATA / name
        if f.exists():
            try:
                return json.loads(f.read_text(encoding="utf-8"))
            except Exception as e:
                raise HTTPException(500, f"{name} 解析失败：{e}")
    raise HTTPException(404, "还没有巡检结果，服务器上跑 scan_kline_health.py 即可生成")


# ---- K 线巡检手动触发：起 systemd 的一次性任务，前端轮询状态 ----
# 状态落盘在 data/kline_run.json：服务重启后仍能知道「任务是不是还在跑」，
# 重启时只要 systemd 里那条 oneshot 还没结束，界面不会误显示成没启动。
KH_RUN_FILE = DATA / "kline_run.json"
_KH_LOCK = threading.RLock()  # 终态补结果时会嵌套加锁，必须可重入
_KH_EMPTY = {"running": False, "started_at": None, "finished_at": None,
             "ok": None, "error": None, "checks": None, "failed": None}


def _kh_stamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _kh_load() -> dict:
    st = dict(_KH_EMPTY)
    try:
        st.update(json.loads(KH_RUN_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return st


def _kh_save(st: dict) -> dict:
    try:
        tmp = KH_RUN_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(KH_RUN_FILE)
    except OSError as e:
        log.warning("巡检状态写盘失败：%s", e)
    return st


def _kh_read_result() -> None:
    """把最新巡检结果里的计数补进状态，供界面显示进度/结论。"""
    for name in ("kline_health_all.json", "kline_health.json"):
        f = DATA / name
        if not f.exists():
            continue
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        with _KH_LOCK:
            st = _kh_load()
            st.update(checks=d.get("checks"), failed=d.get("failed"))
            _kh_save(st)
        break


def _kh_finalize(st: dict) -> dict:
    """systemd 那条 oneshot 已经退出：按 Result 定成败，并把计数补上。"""
    ok, err = False, None
    try:
        res = subprocess.run(["systemctl", "show", "stock-khealth.service", "-p", "Result", "--value"],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        ok = res == "success"
        if not ok:
            err = f"Result={res or '?'}"
    except Exception as e:  # noqa: BLE001
        err = str(e) or e.__class__.__name__
    # Result=success 也可能是「任务根本没跑」，用结果文件的 mtime 再核一次
    if ok:
        try:
            started = time.mktime(time.strptime(str(st.get("started_at")), "%Y-%m-%d %H:%M:%S"))
            newest = max((DATA / n).stat().st_mtime for n in ("kline_health_all.json", "kline_health.json")
                         if (DATA / n).exists())
            if newest + 2 < started:
                ok, err = False, "任务结束了但结果文件没更新"
        except Exception:
            pass
    st.update(running=False, finished_at=_kh_stamp(), ok=ok, error=err)
    _kh_save(st)
    _kh_read_result()
    return _kh_load()


def _kh_start() -> dict:
    """只负责「把任务交给 systemd」：--no-block 立刻返回，任务本体不挂在 web 进程里，
    所以重启服务也不会把巡检一起带走（之前 daemon 线程被杀过一次）。"""
    st = _kh_load()
    st.update(running=True, started_at=_kh_stamp(), finished_at=None,
              ok=None, error=None, checks=None, failed=None)
    _kh_save(st)
    try:
        r = subprocess.run(["systemctl", "start", "--no-block", "stock-khealth.service"],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            st.update(running=False, finished_at=_kh_stamp(), ok=False,
                      error=(r.stderr or r.stdout or "systemctl 启动失败").strip()[:120])
            _kh_save(st)
    except Exception as e:  # noqa: BLE001
        st.update(running=False, finished_at=_kh_stamp(), ok=False, error=str(e)[:120])
        _kh_save(st)
    return _kh_load()


def _kh_state() -> dict:
    st = _kh_load()
    if not st.get("running"):
        return st
    # 进程可能重启过：真正的裁判是 systemd，不是内存标记
    try:
        active = subprocess.run(["systemctl", "is-active", "stock-khealth.service"],
                                capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        active = ""
    if active in ("activating", "active", "reloading"):
        return st
    with _KH_LOCK:
        st = _kh_load()
        if st.get("running"):
            return _kh_finalize(st)
    return st


@app.post("/api/v1/kline/health/run")
def kline_health_run(_: None = Depends(require_app)):
    """手动跑一次巡检（全市场 ETF，和每天 16:35 的定时任务同一条命令）。"""
    st = _kh_state()
    if st.get("running"):
        return st
    with _KH_LOCK:
        st = _kh_load()
        if st.get("running"):
            return st
        return _kh_start()


@app.get("/api/v1/kline/health/run")
def kline_health_run_status(_: None = Depends(require_app)):
    return _kh_state()

# ---------- 今日看板 / 关键位 / 绩效 / 提醒 ----------
_DASH_CACHE: dict = {"at": 0.0, "data": None}
_IDX_LAST: dict = {"at": 0.0, "items": []}


def _holds() -> list[dict]:
    return [r for r in store.list_stocks()
            if (r.get("bucket") or "watch") == "hold" and float(r.get("shares") or 0) > 0]


def _day_bars(code: str, limit: int = 60) -> list[dict]:
    try:
        d = quote_service.kline(code, "day", limit)
        return (d or {}).get("items") or []
    except Exception as e:
        log.warning("关键位取 %s 日线失败：%s", code, e)
        return []


@app.get("/api/v1/rank")
def rank(market: str = "a", by: str = "pct", limit: int = 30,
         min_pct: float | None = None, min_amount: float | None = None,
         min_turnover: float | None = None, max_pe: float | None = None,
         q: str | None = None, _: None = Depends(require_app)):
    """全市场排行：目前稳定维护的是 A 股 ETF 全场（417 只）；港美只有指数，没有名单。"""
    marketdb.init()
    d = marketdb.rank(market=market, by=by, limit=max(1, min(int(limit or 30), 200)),
                      min_pct=min_pct, min_amount=min_amount, min_turnover=min_turnover,
                      max_pe=max_pe, q=q)
    return {"market": market, "by": by, **d, "run": marketdb.last_run("night")}


@app.get("/api/v1/rank/health")
def rank_health(_: None = Depends(require_app)):
    marketdb.init()
    return marketdb.health()


@app.get("/api/v1/calendar")
def calendar(days: int = 30, _: None = Depends(require_app)):
    """提醒中心的「即将发生」：定投扣款日 + 财报/除权日历（有源才有数据）。"""
    marketdb.init()
    rows = [r for r in store.list_stocks() if float(r.get("dca") or 0) > 0]
    total = sum(float(r["dca"]) for r in rows)
    out_days = []
    today = store.today_bj()
    base = datetime.strptime(today, "%Y-%m-%d").date()
    for i in range(1, 8):
        d = base + timedelta(days=i)
        day = d.strftime("%Y-%m-%d")
        trading = bool(quotes.is_trading_day(day))
        out_days.append({"date": day, "weekday": "周" + "日一二三四五六"[d.isoweekday() % 7],
                         "trading": trading, "total": round(total, 2) if trading else 0,
                         "count": len(rows) if trading else 0})
        if len([x for x in out_days if x["trading"]]) >= 3:
            break
    return {"dca": {"total": round(total, 2), "count": len(rows), "days": out_days},
            "events": marketdb.cal_events(days=max(3, min(int(days or 30), 90)), limit=200),
            "today": today}


@app.get("/api/v1/global-markets")
def global_markets(_: None = Depends(require_app)):
    """跨市场指数：港股三只 + 美股三只（60 秒缓存）。"""
    return quote_service.market_global()



AUTO_NOTE_TAG = "自动复盘"


def _auto_analysis_note(rows, per, todos, cost, mv, today) -> None:
    """收盘后自动生成一条「分析」记录（每个自然日只写一条）。

    结构：① 组合概况 ② 收益归因（最大拖累 / 最大贡献，带占今日亏损或盈利的比例）
    ③ 仓位结构（前二集中度）④ 值得看一眼的异动 ⑤ 明日关注（定投 / 连跌 / 距成本）。
    抓不到就不写，绝不编日期或数字。
    """
    try:
        day = store.today_bj()
        # 盘前/非交易日跑批时，行情还是上一交易日的：复盘日期跟随行情，别写成"今天收盘"
        try:
            qd = str((quote_service.quotes_fetch([rows[0]["code"]]).get(rows[0]["code"]) or {}).get("time") or "")[:10]
            if len(qd) == 10 and qd <= day:
                day = qd
        except Exception:
            pass
        # 去重按「复盘写的哪天」而不是 created_at：盘后跑批与盘前补跑可能跨自然日
        existing = store.list_notes(kind="analysis", day=day, limit=40) or []
        if any(AUTO_NOTE_TAG in (n.get("tags") or []) for n in existing):
            return
        if not rows:
            return

        import re as _re

        def _short(n: str) -> str:
            """名字里的括号定语（QDII / 人民币 / A 类）在记录里没用，去掉省宽度。"""
            n = str(n or "")
            for a, b in (("（", "）"), ("(", ")")):
                while a in n and b in n and n.index(b) > n.index(a):
                    n = n[:n.index(a)] + n[n.index(b) + 1:]
            for junk, rep in (("纳斯达克生物科技", "生科"), ("纳斯达克", "纳指"), ("生物科技", "生科"),
                              ("标普500", "标普"), ("黄金ETF", "黄金"),
                              ("指数", ""), ("ETF联接", ""), ("联接", ""), ("基金", ""), ("人民币", ""),
                              ("QDII", "")):
                n = n.replace(junk, rep)
            for b in ("汇添富", "华安", "摩根", "南方", "易方达", "华夏", "嘉实", "广发", "天弘",
                      "国泰", "富国", "工银", "招商", "博时"):
                n = n.replace(b, "")
            n = n.strip() or "持仓"
            n = _re.sub(r"\d{0,3}[A-C]$", "", n) or n   # 份额类别（100A / A / C）在记录里不重要
            return n if len(n) <= 11 else n[:10] + "…"

        lines = []
        pct = (mv - cost) / cost * 100 if cost else 0.0
        head = f"持仓 {len(rows)} 只｜市值 {mv:,.2f}"
        head += f"｜浮动 {pct:+.2f}%｜今日 {today:+,.2f}" if cost else f"｜今日 {today:+,.2f}"
        lines.append(head)

        # ② 收益归因：今日谁拖累、谁贡献，占比按当日盈亏绝对值算
        rated = [x for x in per if x.get("today") is not None and x.get("price")]
        if rated and today:
            denom = abs(float(today)) or 1
            drag = min(rated, key=lambda x: float(x["today"]))
            gain = max(rated, key=lambda x: float(x["today"]))
            seg = []
            if float(drag["today"]) < 0:
                seg.append(f"拖累 {_short(drag.get('name') or drag['code'])} {float(drag['today']):+,.1f}"
                           f"（{abs(float(drag['today'])) / denom * 100:.0f}%）")
            if float(gain["today"]) > 0:
                seg.append(f"贡献 {_short(gain.get('name') or gain['code'])} {float(gain['today']):+,.1f}"
                           f"（{abs(float(gain['today'])) / denom * 100:.0f}%）")
            if seg:
                lines.append("｜".join(seg))

        # ③ 仓位结构：市值最大的两只占比，超过一半就点名
        code = None
        try:
            vals = []
            for r in rows:
                px = next((float(x.get("price") or 0) for x in per if x["code"] == r["code"]), 0)
                sh = float(r.get("shares") or 0)
                if px > 0 and sh > 0:
                    vals.append((r.get("name") or r["code"], sh * px, r["code"]))
            if vals and mv > 0:
                vals.sort(key=lambda x: -x[1])
                code = vals[0][2]
                top2pct = sum(v[1] for v in vals[:2]) / mv * 100
                lines.append(f"最重 {_short(vals[0][0])} {vals[0][1] / mv * 100:.1f}%，前二 {top2pct:.1f}%"
                             + ("（偏集中）" if top2pct >= 50 else ""))
        except Exception:
            pass

        # ④ 关注：连跌 / 距成本 + 定投节奏，一条说完
        def _tidy(t: str) -> str:
            t = _re.sub(r"[（(][^）)]*[）)]", "", str(t or ""))
            for junk, rep in (("纳斯达克生物科技", "生科"), ("纳斯达克", "纳指"), ("生物科技", "生科"),
                              ("ETF联接", ""), ("联接", ""), ("基金", ""), ("人民币", ""), ("指数", "")):
                t = t.replace(junk, rep)
            for b in ("汇添富", "华安", "摩根", "南方", "易方达", "华夏"):
                t = t.replace(b, "")
            t = _re.sub(r"\d{0,3}[A-C](?=\s|$)", "", t)
            return t.strip().rstrip("。")
        watch = [_tidy(t.get("t")).replace("距成本", "成本") for t in (todos or [])[:2]]
        try:
            plan = store.list_stocks()
            dca = sum(float(r.get("dca") or 0) for r in plan)
        except Exception:
            dca = 0
        if dca > 0:
            lines.append(f"定投 ¥{dca:g}/日" + ("｜关注 " + "、".join(watch) if watch else ""))
        elif watch:
            lines.append("关注 " + "、".join(watch))

        store.add_note("\n".join(lines), [AUTO_NOTE_TAG], code, kind="analysis", when=f"{day} 15:10")
    except Exception as e:
        log.warning("自动分析记录失败：%s", e)


@app.get("/api/v1/dashboard")
def dashboard(_: None = Depends(require_app)):
    """今日看板：指数条 + 我的今日 + 待办。一次请求给齐首页第一屏要用的东西。"""
    now = time.time()
    if _DASH_CACHE["data"] and now - _DASH_CACHE["at"] < 30:
        return _DASH_CACHE["data"]
    rows = _holds()
    codes = [r["code"] for r in rows]
    q = (quote_service.quotes_snapshot(codes).get("quotes") or {}) if codes else {}
    mv = cost = today = 0.0
    per = []
    for r in rows:
        d = q.get(r["code"]) or {}
        sh = float(r.get("shares") or 0)
        px = float(d.get("price") or 0)
        prev = float(d.get("prev_close") or 0)
        c = r.get("cost")
        pnl = (sh * px - float(c)) if (px and c not in (None, "")) else None
        today_pnl = sh * (px - prev) if (px and prev) else None
        if pnl is not None:
            cost += float(c)
            mv += sh * px
            today += today_pnl or 0
        per.append({"code": r["code"], "name": r.get("name") or r["code"], "price": px,
                    "pct": d.get("pct"), "pnl": round(pnl, 2) if pnl is not None else None,
                    "today": round(today_pnl, 2) if today_pnl is not None else None})
    global _IDX_LAST
    try:
        mm = quote_service.market_all()
        raw_idx = [x for x in (mm.get("a") or []) if float(x.get("price") or 0) > 0]
    except Exception as e:
        log.warning("dashboard 指数失败：%s", e)
        raw_idx = []
    # 上游抖动时用上一次拿到的指数，避免首页第一屏出现一排 0
    if raw_idx:
        _IDX_LAST = {"at": now, "items": raw_idx[:5]}
    elif _IDX_LAST["items"] and now - _IDX_LAST["at"] < 21600:
        raw_idx = _IDX_LAST["items"]
    IDX_NAME = {"sh000001": "上证", "sz399001": "深证", "sz399006": "创业板",
                "sh000688": "科创50", "sh000300": "沪深300"}
    idx = [{"n": IDX_NAME.get(x.get("code"), (x.get("name") or "").replace("指数", "")),
            "v": x.get("price"), "p": x.get("pct")} for x in raw_idx[:4]]

    # 领涨 / 领跌：按当日涨跌幅排，只取有价格的
    rated = [x for x in per if x.get("pct") is not None and x.get("price")]
    rated.sort(key=lambda x: float(x["pct"]), reverse=True)
    lead = rated[0] if rated else None
    lag = rated[-1] if len(rated) > 1 else None

    todos = []
    for ev in store.list_price_alert_events(limit=5, unread_only=True):
        todos.append({"k": "alert", "t": f"{ev['name'] or ev['code']} {ev['kind']} 提醒已触发",
                      "sub": f"{ev['price']} · {str(ev['fired_at'])[5:16]}"})
    # 连跌 / 距成本：只对持仓算，最多 6 只，避免把首屏拖慢
    for r in rows[:6]:
        pnl = next((x["pnl"] for x in per if x["code"] == r["code"]), None)
        c = r.get("cost")
        if pnl is not None and c not in (None, ""):
            pct_cost = pnl / float(c) * 100 if float(c) else 0
            if pct_cost <= -8:
                todos.append({"k": "cost", "t": f"{r.get('name') or r['code']} 距成本 {pct_cost:.1f}%",
                              "sub": "已跌破 8% 阈值"})
        bars = _day_bars(r["code"], 30)
        if len(bars) >= 4:
            down = 0
            for i in range(len(bars) - 1, 0, -1):
                if float(bars[i].get("c") or 0) < float(bars[i - 1].get("c") or 0):
                    down += 1
                else:
                    break
            if down >= 3:
                todos.append({"k": "down", "t": f"{r.get('name') or r['code']} 连跌 {down} 天",
                              "sub": "要不要看一眼回撤"})

    _auto_analysis_note(rows, per, todos, cost, mv, today)

    payload = {
        "t": int(now),
        "as_of": dict(quotes.market_status()).get("text") or "",
        "idx": idx,
        "hold": {"n": len(rows), "cost": round(cost, 2), "mv": round(mv, 2),
                 "pnl": round(mv - cost, 2) if cost else None,
                 "pct": round((mv - cost) / cost * 100, 2) if cost else None,
                 "today": round(today, 2) if rows else None},
        "lead": {"name": lead["name"], "pct": lead["pct"]} if lead else None,
        "lag": {"name": lag["name"], "pct": lag["pct"]} if lag else None,
        "todo": todos[:4],
        "alert_unread": len(store.list_price_alert_events(limit=99, unread_only=True)),
    }
    _DASH_CACHE["at"], _DASH_CACHE["data"] = now, payload
    return payload


@app.get("/api/v1/keylevels")
def keylevels(code: str, _: None = Depends(require_app)):
    """详情页「关键位」四格：距MA20、20日高低、连涨天数。"""
    bars = _day_bars(code, 60)
    closes = [float(b.get("c") or 0) for b in bars if b.get("c")]
    if len(closes) < 20:
        return {"ok": False, "items": None}
    ma20 = sum(closes[-20:]) / 20
    ma20_prev = sum(closes[-25:-5]) / 20 if len(closes) >= 25 else ma20
    streak = 0
    for i in range(len(closes) - 1, 0, -1):
        if closes[i] > closes[i - 1]:
            streak += 1
        else:
            break
    return {"ok": True, "ma20": round(ma20, 3),
            "dist_ma20": round((closes[-1] / ma20 - 1) * 100, 2),
            "ma20_slope": round((ma20 / ma20_prev - 1) * 100, 2) if ma20_prev else None,
            "hi20": round(max(closes[-20:]), 3), "lo20": round(min(closes[-20:]), 3),
            "streak": streak}


@app.get("/api/v1/perf")
def perf(range: str = "90", _: None = Depends(require_app)):
    """持仓绩效：等权累计收益率曲线（按份额×收盘价）+ 最大回撤 + 每只贡献度。"""
    days = {"30": 30, "90": 90, "all": 480}.get(str(range), 90)
    rows = _holds()
    series: dict[str, dict[str, float]] = {}
    shares, costs, names = {}, [], {}
    for r in rows:
        try:
            bars = (quote_service.kline(r["code"], "day", min(480, max(30, days))) or {}).get("items") or []
        except Exception as e:
            log.warning("绩效取 %s 日线失败：%s", r["code"], e)
            bars = []
        sh = float(r.get("shares") or 0)
        if not sh or not bars:
            continue
        shares[r["code"]] = sh
        names[r["code"]] = r.get("name") or r["code"]
        if r.get("cost") not in (None, ""):
            costs.append(float(r["cost"]))
        series[r["code"]] = {str(b.get("t"))[:10]: float(b.get("c") or 0) for b in bars if b.get("c")}
    if not series:
        return {"ok": False, "points": [], "cost": 0}
    dates = sorted({d for s in series.values() for d in s})[-days:]
    last = {c: 0.0 for c in series}
    points, vals = [], []
    for d in dates:
        v = 0.0
        for c, s in series.items():
            if d in s:
                last[c] = s[d]
            v += last[c] * shares[c]
        vals.append(v)
        points.append({"d": d, "v": round(v, 2)})
    cost = sum(costs)
    base = vals[0] or 1
    for p, v in zip(points, vals):
        p["r"] = round((v / base - 1) * 100, 2)
        p["pnl"] = round(v - cost, 2) if cost else None
    peak, maxdd, dd_at = -1e9, 0.0, None
    for p in points:
        peak = max(peak, p["v"])
        dd = (p["v"] / peak - 1) * 100 if peak else 0
        if dd < maxdd:
            maxdd, dd_at = dd, p["d"]
    contrib = []
    for c in series:
        v = last[c] * shares[c]
        contrib.append({"code": c, "name": names[c], "mv": round(v, 2)})
    total_mv = sum(x["mv"] for x in contrib) or 1
    for x in contrib:
        x["w"] = round(x["mv"] / total_mv * 100, 2)
    contrib.sort(key=lambda x: -x["mv"])
    return {"ok": True, "points": points, "cost": round(cost, 2),
            "maxdd": round(maxdd, 2), "dd_at": dd_at, "contrib": contrib,
            "cur": round((vals[-1] / base - 1) * 100, 2) if vals else None}


@app.get("/api/v1/price-alerts")
def alerts_list(_: None = Depends(require_app)):
    return {"active": store.list_price_alerts(), "events": store.list_price_alert_events(limit=40),
            "unread": len(store.list_price_alert_events(limit=99, unread_only=True))}


@app.post("/api/v1/price-alerts")
def alerts_set(payload: dict = Body(...), _: None = Depends(require_app)):
    code = str(payload.get("code") or "").strip()
    kind = str(payload.get("kind") or "").strip()
    val = payload.get("value")
    if not code or kind not in ("up", "down", "pct") or val in (None, ""):
        raise HTTPException(400, "需要 code / kind(up|down|pct) / value")
    try:
        return store.upsert_price_alert(code, str(payload.get("name") or ""), kind, float(val))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/v1/price-alerts/{aid}")
def alerts_del(aid: int, _: None = Depends(require_app)):
    store.delete_price_alert(aid)
    return {"ok": True}


@app.get("/api/v1/price-alerts/check")
def alerts_check(_: None = Depends(require_app)):
    """算一遍有没有触发；服务端用行情缓存比对，不额外打上游。"""
    items = store.list_price_alerts(active_only=True)
    if not items:
        return {"events": [], "checked": 0}
    q = quote_service.quotes_snapshot([a["code"] for a in items]).get("quotes") or {}
    fired = []
    for a in items:
        d = q.get(a["code"]) or {}
        px = float(d.get("price") or 0)
        pct = d.get("pct")
        if not px:
            continue
        hit = False
        if a["kind"] == "up":
            hit = px >= float(a["value"])
        elif a["kind"] == "down":
            hit = px <= float(a["value"])
        elif a["kind"] == "pct" and pct is not None:
            hit = abs(float(pct)) >= abs(float(a["value"]))
        if hit:
            ev = store.fire_price_alert(int(a["id"]), px)
            if ev:
                fired.append(ev)
        elif not a.get("armed", 1):
            store.arm_price_alert(int(a["id"]))
    return {"events": fired, "checked": len(items)}


@app.post("/api/v1/price-alerts/read")
def alerts_read(_: None = Depends(require_app)):
    return {"ok": True, "n": store.mark_price_alert_events_read()}


@app.get("/api/v1/watch/summary")
def watch_summary(request: Request, _: None = Depends(require_app)):
    """Apple Watch 用的极简快照：指数五格 + 持仓汇总 + 每只持仓一行。

    字段名压到单字母，手表端一次请求只解析几百字节；ETag 让休市时直接 304。
    冷缓存原来要等 5.6 秒（场外基金净值 + 指数两路上游同步拉），现在走 stale-while-revalidate：
    进程启动就预热一次，之后过期先回旧值（带 stale 标记）、刷新丢后台线程。
    """
    payload, stale, age = quote_service.swr("watch_summary", _watch_summary_build)
    if payload is None:
        raise HTTPException(status_code=503, detail="行情暂时不可用，稍后重试")
    payload = dict(payload)
    payload["t"] = int(time.time())
    if stale:
        payload["stale"] = True
        payload["age"] = int(age)
    return _etag_response(request, payload)


def _watch_summary_build() -> dict:
    rows = [s for s in store.list_stocks() if (s.get("bucket") or "watch") == "hold"]
    q = quote_service.quotes_snapshot([r["code"] for r in rows])["quotes"] if rows else {}
    try:
        mm = quote_service.market_all()
        raw_idx = mm.get("a") or []
    except Exception as e:  # 上游慢/断线时指数留空，别把整次请求拖死
        log.warning("watch summary 指数失败：%s", e)
        raw_idx = []
    IDX_NAME = {"sh000001": "上证", "sz399001": "深证", "sz399006": "创业板",
                "sh000688": "科创50", "sh000300": "沪深300"}
    idx = [{"n": IDX_NAME.get(x.get("code"), (x.get("name") or "").replace("指数", "")),
            "v": x.get("price"), "p": x.get("pct")} for x in raw_idx[:5]]
    mv = cost = pnl = 0.0
    out = []
    for r in rows:
        d = q.get(r["code"]) or {}
        sh = float(r.get("shares") or 0)
        c = r.get("cost")
        px = float(d.get("price") or 0)
        m = sh * px if sh and px else 0.0
        pc = (m - float(c)) if (m and c not in (None, "")) else 0.0
        if sh and c not in (None, ""):
            cost += float(c)
            mv += m
            pnl += pc
        out.append({"c": r["code"], "n": r.get("name") or r["code"], "p": px,
                    "pct": d.get("pct"), "pn": pc, "a": r.get("priority") or ""})
    pct_hold = (pnl / cost * 100) if cost else None
    payload = {
        "t": int(time.time()),
        "st": (quotes.market_status() or {}).get("text") or "",
        "idx": idx,
        "hold": {"n": len([x for x in out if x["p"]]), "cost": round(cost, 2),
                 "mv": round(mv, 2), "pnl": round(pnl, 2),
                 "pct": round(pct_hold, 2) if pct_hold is not None else None},
        "rows": out,
        "open_at": quotes.next_open_at(),
    }
    return payload


def _board_payload() -> dict:
    """持仓 + 关注（价格/涨幅/标签/今日关注/关联想法数），不含金额。"""
    stocks = store.list_stocks()
    q = quote_service.quotes_snapshot([s["code"] for s in stocks])
    auto_focus = store.stock_focus_map()
    note_counts = store.note_counts_by_stock()
    # 个股分析只给「持仓 + 关注里优先级 A/B」，历史叠加（新的在前）
    ana_codes = [s["code"] for s in stocks
                 if (s.get("bucket") == "hold" or (s.get("priority") or "") in ("A", "B"))]
    ana_map = store.stock_sections(ana_codes, 6)
    out = []
    for s in stocks:
        d = q["quotes"].get(s["code"], {})
        manual_focus = (s.get("focus") or "").strip()
        auto = auto_focus.get(s["code"], "")
        out.append({
            "code": s["code"], "name": s["name"], "bucket": s["bucket"] or "watch",
            "tags": s["tags"], "custom_tags": s["custom_tags"],
            "note": s["note"], "sort": s["sort"],
            "priority": s.get("priority") or "",
            "focus": manual_focus or auto,
            "focus_auto": auto,
            "focus_manual": bool(manual_focus),
            "analysis": ana_map.get(s["code"], []),
            "note_count": note_counts.get(s["code"], 0),
            "price": d.get("price") or 0, "pct": d.get("pct") or 0, "change": d.get("change") or 0,
            "amount": d.get("amount") or 0, "turnover_rate": d.get("turnover_rate"),
            "vol_ratio": d.get("vol_ratio"), "float_cap": d.get("float_cap"),
            "total_cap": d.get("total_cap"), "pe": d.get("pe"), "pb": d.get("pb"),
            "stale": bool(d.get("stale")), "source": d.get("source", ""),
        })
    tags: dict[str, int] = {}       # 外网 API 标签计数（兼容旧字段）
    custom_tags: dict[str, int] = {}  # 自定义标签计数（前端筛选/分组用）
    for s in out:
        for t in s["tags"]:
            tags[t] = tags.get(t, 0) + 1
        for t in s["custom_tags"]:
            custom_tags[t] = custom_tags.get(t, 0) + 1
    return {
        "server_time": q["server_time"], "market": q["market"], "stocks": out,
        "tags": sorted(tags.items(), key=lambda kv: (-kv[1], kv[0])),
        "custom_tags": sorted(custom_tags.items(), key=lambda kv: (-kv[1], kv[0])),
        # 标签条的手动排序（长按拖动后保存），持仓/关注各一套
        "tag_order": {b: store.get_tag_order(b) for b in ("hold", "watch")},
        "flags": store.flag_summary(),
        "hold_count": sum(1 for s in out if s["bucket"] == "hold"),
        "watch_count": sum(1 for s in out if s["bucket"] != "hold"),
        # 下一次开盘/午休恢复的北京时间戳（epoch ms）；前端据此定时唤醒，
        # 不再自己猜 9:14/9:15，也能跳过节假日。
        "next_open_at": quotes.next_open_at(),
    }


def _board_etag_payload(d: dict) -> dict:
    """去掉每次请求都会变的 server_time，让休市时的 board 能命中 304。"""
    stable = dict(d)
    stable.pop("server_time", None)
    m = stable.get("market")
    if isinstance(m, dict):
        m = dict(m)
        m.pop("server_time", None)
        stable["market"] = m
    return stable


@app.get("/api/v1/board")
def board(request: Request, _: None = Depends(require_auth)):
    d = _board_payload()
    return _etag_response(request, d, _board_etag_payload(d))


# ---------------- 市场行情 ----------------
@app.get("/api/v1/market")
def market_board(force: bool = False, _: None = Depends(require_auth)):
    try:
        d = quote_service.market_all(force=force)
    except Exception as e:
        raise HTTPException(502, f"行情获取失败：{e}")
    try:
        d["qdi"] = qdi.snapshot()   # 场外纳指定投组合（本地库，不发外网请求）
    except Exception as e:
        log.warning("qdi snapshot 失败：%s", e)
        d["qdi"] = {}
    return d


# ---------------- 热度榜 / K线 ----------------
@app.get("/api/v1/quote/{code}")
def quote_one(code: str, _: None = Depends(require_auth)):
    return quote_service.quotes_fetch([code]).get(code) or {}


@app.get("/api/v1/etf/holdings/{code}")
def etf_holdings(code: str, _: None = Depends(require_auth)):
    """ETF 前十大持仓权重（天天基金，服务端缓存 7 天）。"""
    code = (code or "").strip()
    if not etf_mod.is_etf_code(code):
        raise HTTPException(400, "代码需为 6 位 ETF 代码")
    return quote_service.etf_holdings(code)


@app.get("/api/v1/etf/perf/{code}")
def etf_perf(code: str, _: None = Depends(require_auth)):
    """ETF 收益 / 最大回撤：今年以来、本季度、成立以来（东财前复权日线，缓存 6 小时）。"""
    code = (code or "").strip()
    if not etf_mod.is_etf_code(code):
        raise HTTPException(400, "代码需为 6 位 ETF 代码")
    return etf_mod.get_perf(code)


@app.post("/api/v1/etf/overlap")
def etf_overlap(payload: dict = Body(...), _: None = Depends(require_auth)):
    """ETF 持仓重合度（前十大估算）：候选 ETF vs 用户持仓/关注 + 自定义对比 ETF。"""
    codes = payload.get("codes") or []
    compare = payload.get("compare") or []
    if not isinstance(codes, list):
        raise HTTPException(400, "codes 需为数组")
    if not isinstance(compare, list):
        compare = []
    tracked = store.list_stocks()
    return {"items": etf_mod.overlaps(codes, tracked, compare)}


@app.get("/api/v1/heat")
def heat_rank(src: str = "ths", limit: int = 50, _: None = Depends(require_auth)):
    return heat.get(src, limit)


@app.get("/api/v1/trend")
def trend_rank(date: str = "", _: None = Depends(require_auth)):
    """趋势选股：date 为空读最新，传 YYYY-MM-DD 读历史。"""
    return trend.latest(date or None)


@app.get("/api/v1/profile/{code}")
def company_profile(code: str, force: bool = False, _: None = Depends(require_auth)):
    """公司介绍：简介、主营业务、行业背景/地位（东财 F10）。"""
    code = (code or "").strip()
    if not code.isdigit() or len(code) != 6:
        raise HTTPException(400, "代码需为 6 位数字")
    try:
        return profile_mod.get(code, force=force)
    except Exception as e:
        raise HTTPException(502, f"公司资料获取失败：{e}")


@app.get("/api/v1/chip/{code}")
def chip_info(code: str, days: int = 120, _: None = Depends(require_auth)):
    try:
        return chip.fetch(code, days)
    except Exception as e:
        raise HTTPException(502, f"筹码估算失败：{e}")


@app.get("/api/v1/fundflow/{code}")
def fund_flow(code: str, days: int = 30, _: None = Depends(require_auth)):
    try:
        return fundflow.fetch(code, days)
    except Exception as e:
        raise HTTPException(502, f"资金流获取失败：{e}")


@app.get("/api/v1/tags")
def tag_list(_: None = Depends(require_auth)):
    mine: list[str] = []
    for s in store.list_stocks():
        for t in (s.get("tags") or []):
            if t not in mine:
                mine.append(t)
    return {"hot": board_mod.hot_tags(), "mine": mine[:40]}


@app.get("/api/v1/tags/order")
def get_tag_order(bucket: str = "hold", _: None = Depends(require_auth)):
    b = bucket if bucket in ("hold", "watch") else "hold"
    return {"bucket": b, "order": store.get_tag_order(b)}


@app.post("/api/v1/tags/order")
def set_tag_order(payload: dict = Body(...), _: None = Depends(require_auth)):
    b = str(payload.get("bucket") or "hold")
    if b not in ("hold", "watch"):
        raise HTTPException(400, "bucket 只能是 hold 或 watch")
    return {"bucket": b, "order": store.set_tag_order(b, payload.get("order") or [])}


@app.get("/api/v1/tags/{name}")
def tag_stocks(name: str, limit: int = 80, sort: str = "purity", dir: str = "",
               include_hidden: int = 0, _: None = Depends(require_auth)):
    return board_mod.members(name, limit=limit, sort=sort, direction=dir,
                             include_hidden=bool(include_hidden))


@app.post("/api/v1/tags/{name}/mark")
def tag_mark(name: str, payload: dict = Body(...), _: None = Depends(require_auth)):
    """按标签置顶/隐藏一只股票；mark=pin|hide|none（none 表示恢复）。"""
    code = str(payload.get("code") or "").strip()
    mark = str(payload.get("mark") or "").strip()
    if not code or mark not in ("pin", "hide", "none"):
        raise HTTPException(400, "参数不对")
    resolved = board_mod.resolve_tag(name)
    tag = resolved.get("tag") or name
    store.set_tag_mark(tag, code, None if mark == "none" else mark)
    return {"ok": True, "tag": tag, "code": code, "mark": mark}


@app.get("/api/v1/search")
def search_stock(q: str = "", _: None = Depends(require_auth)):
    items = quotes.search(q, 12)
    if items:  # 搜索结果直接带价和涨跌幅，点开前就能判断
        snap = quote_service.quotes_fetch([x["code"] for x in items])
        for x in items:
            d = snap.get(x["code"]) or {}
            x["price"] = d.get("price") or 0
            x["pct"] = d.get("pct") or 0
            if d.get("name"):
                x["name"] = d["name"]
    return {"items": items}


@app.get("/api/v1/global-search")
def global_search(q: str = "", limit: int = 12, _: None = Depends(require_auth)):
    """全局搜索：个股 → 新闻 → 笔记，一次取齐（页面上按这个顺序分组显示）。"""
    q = (q or "").strip()
    if not q:
        return {"q": q, "stocks": [], "news": [], "notes": [], "marks": []}
    limit = max(1, min(int(limit or 12), 30))
    ql = q.lower()
    # 已在持仓/关注里的个股优先（本地名字/代码），不依赖外网联想
    local = [s for s in store.list_stocks()
             if ql in f"{s.get('name') or ''}{s.get('code') or ''}".lower()][:limit]
    stocks = [{"code": s["code"], "name": s["name"],
               "type": "ETF" if s["code"].startswith(("15", "51", "56", "58")) else "股",
               "price": 0, "pct": 0, "tracked": s.get("bucket") or ""}
              for s in local]
    seen = {x["code"] for x in stocks}
    try:
        extra = [x for x in quotes.search(q, limit) if x.get("code") not in seen]
    except Exception:
        extra = []
    extra = extra[:max(0, limit - len(stocks))]
    for x in extra:
        x["tracked"] = ""
    stocks += extra
    if stocks:  # 结果直接带价和涨跌幅，点开前就能判断
        try:
            snap = quote_service.quotes_fetch([x["code"] for x in stocks])
        except Exception:
            snap = {}
        for x in stocks:
            d = snap.get(x["code"]) or {}
            if d.get("price") is not None:
                x["price"] = d.get("price") or 0
                x["pct"] = d.get("pct") or 0
            if d.get("name"):
                x["name"] = d["name"]
    # 已收藏的新闻不再出现在「新闻」块：它已经是「记录」里的那条新闻记录，重复显示没有意义
    news = [x for x in store.search_news(q, max(limit * 3, limit)) if not x.get("saved")][:limit]
    notes = store.list_notes(q=q, limit=limit)
    # 总结上的标注也进全局搜索：搜批注文字或选中的原文都能找到
    marks = store.list_digest_marks(q=q, limit=limit)
    return {"q": q, "stocks": stocks, "news": news, "notes": notes, "marks": marks}


@app.get("/api/v1/kline/{code}")
def kline_data(code: str, period: str = "day", limit: int = 120, _: None = Depends(require_auth)):
    if period not in kline_mod.PERIODS:
        raise HTTPException(400, "period 不支持")
    try:
        return quote_service.kline(code, period, limit)
    except Exception as e:
        raise HTTPException(502, f"K线获取失败：{e}")


@app.get("/api/v1/fund/{code}")
def fund_detail(code: str, _: None = Depends(require_auth)):
    """场外基金档案：净值、阶段涨幅、同类排名、申购状态、净值历史。"""
    try:
        d = quote_service.fund_profile(code)
    except Exception as e:
        raise HTTPException(502, f"基金档案获取失败：{e}")
    if not d.get("ok"):
        raise HTTPException(404, d.get("error") or "没有这只基金的公开数据")
    return d


# 工作台：工作类型 + 日程
# ---------------- AI 助手（DeepSeek） ----------------
AI_CFG = DATA / "ai.json"


def _ai_cfg() -> dict:
    try:
        return json.loads(AI_CFG.read_text())
    except Exception:
        return {}


def _ai_key() -> str:
    return str(_ai_cfg().get("key") or "").strip()


# 可切换的模型：V3 快、便宜、稳；R1 推理强，但慢、贵，而且不支持 JSON 模式
AI_MODELS = {"deepseek-chat": "V3 · 快", "deepseek-reasoner": "R1 · 推理"}


def _ai_model() -> str:
    m = str(_ai_cfg().get("model") or "").strip()
    return m if m in AI_MODELS else "deepseek-chat"


def _ai_mask(key: str) -> str:
    if not key:
        return ""
    return key[:5] + "…" + key[-4:] if len(key) > 12 else "…" + key[-4:]


def _ai_shift_ahead(w: dict, n: int = 12) -> str:
    """未来 n 天实际排的班次：AI 以前回答不了「下周哪天休」，就是因为它只看到轮转表名字。"""
    import datetime as _dt
    sh = w.get("shift") or {}
    types = {int(t["id"]): t for t in (sh.get("types") or [])}
    rosters = [r for r in (sh.get("rosters") or []) if (r.get("pattern") or [])]
    ov = sh.get("overrides") or {}
    today = w.get("today") or store.today_bj()
    base = _dt.date.fromisoformat(today)
    out = []
    for i in range(n):
        day = (base + _dt.timedelta(days=i)).isoformat()
        wd = "一二三四五六日"[_dt.date.fromisoformat(day).weekday()]
        sid = 0
        if day in ov:
            sid = int(ov[day] or 0)
        else:
            pick = None
            for r in rosters:
                ef = str(r.get("effective_from") or "")[:10]
                ed = str(r.get("end_date") or "")[:10]
                sd = str(r.get("start_date") or ef)[:10]
                if ef and day < ef:
                    continue
                if ed and day > ed:
                    continue
                if sd and day < sd:
                    continue
                # 在岗日：留空=每天排，否则只看集合里的周几
                days = r.get("days")
                if days and (_dt.date.fromisoformat(day).isoweekday() not in [int(x) for x in days]):
                    continue
                if pick is None or str(r.get("effective_from") or "") >= str(pick.get("effective_from") or ""):
                    pick = r
            if pick:
                pat = [int(x) for x in (pick.get("pattern") or [])]
                sd = str(pick.get("start_date") or pick.get("effective_from"))[:10]
                if pat:
                    idx = (_dt.date.fromisoformat(day) - _dt.date.fromisoformat(sd)).days % len(pat)
                    sid = pat[idx]
        t = types.get(sid)
        label = ("休息" if (not t or t.get("kind") == "off") else f'{t["short"]} {t["start"]}-{t["end"]}')
        if t and t.get("kind") == "off":
            label = "休息"
        mark = "（手调）" if day in ov else ""
        out.append(f'{day[5:]} 周{wd} {label}{mark}')
    return "；".join(out)


_AI_ROUTE = {
    "tasks": ("日程", "安排", "待办", "任务", "加一条", "删掉", "改到", "记一下", "开会", "买菜", "交"),
    "focus": ("专注", "模式", "步骤", "番茄", "计时"),
    "shift": ("值班", "排班", "班次", "轮转", "调班", "上班", "休息", "白班", "夜班", "早班", "晚班", "常白"),
    "daily": ("每日提醒", "每天提醒", "每日的提醒"),
}


def _ai_window(text: str) -> tuple[str, str]:
    """决定这次给模型看哪段日期。
    优先级：明确的「M.D/M月D日」日期或区间 > 提到的月份 > 默认今天前后。
    「之前/以前」这类词把起点拉到一年前，不然模型看不到过去、会误以为「没有记录」。"""
    import datetime as _dt
    today = store.today_bj()
    d0 = _dt.date.fromisoformat(today)
    text = str(text or "")
    past_word = bool(re.search(r"之前|以前|往前|过去|截至|截止", text))

    def mk(y: int, m: int, d: int, fallback_year: bool = True) -> _dt.date:
        try:
            return _dt.date(y, m, d)
        except ValueError:
            return _dt.date(y, m, 28)

    # M.D / M月D日 出现两次 = 区间；出现一次 + 「之前/以后」= 单边
    mds = re.findall(r"(\d{1,2})\s*[./月]\s*(\d{1,2})\s*(?:日|号)?", text)
    def year_for(m: int) -> int:
        y = d0.year
        if m < d0.month - 6:
            y += 1
        elif m > d0.month + 6:
            y -= 1
        return y
    if len(mds) >= 2:
        (m1, d1), (m2, d2) = mds[0], mds[1]
        a = mk(year_for(int(m1)), int(m1), int(d1))
        b = mk(a.year if int(m2) >= int(m1) else a.year + 1, int(m2), int(d2))
        if b < a:
            a, b = b, a
        return (a - _dt.timedelta(days=2)).isoformat(), (b + _dt.timedelta(days=2)).isoformat()
    if mds and past_word:
        m1, d1 = int(mds[0][0]), int(mds[0][1])
        b = mk(year_for(m1), m1, d1)
        if b > d0 + _dt.timedelta(days=30):
            b = mk(d0.year - 1, m1, d1)
        return (b - _dt.timedelta(days=400)).isoformat(), b.isoformat()
    if past_word:
        return (d0 - _dt.timedelta(days=400)).isoformat(), (d0 + _dt.timedelta(days=40)).isoformat()

    m = re.search(r"(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月", text)
    if m:
        mon = int(m.group(2))
        year = int(m.group(1)) if m.group(1) else d0.year
        if not m.group(1):
            if mon < d0.month - 6:
                year += 1
            elif mon > d0.month + 6:
                year -= 1
        first = _dt.date(year, mon, 1)
        nxt = _dt.date(year + (1 if mon == 12 else 0), 1 if mon == 12 else mon + 1, 1)
        return (first - _dt.timedelta(days=4)).isoformat(), (nxt + _dt.timedelta(days=8)).isoformat()
    return (d0 - _dt.timedelta(days=7)).isoformat(), (d0 + _dt.timedelta(days=40)).isoformat()


AI_SYSTEM = """你是「工作台」的数据库管理员。用户用一句话说想改什么，你直接写 SQLite 的 INSERT / UPDATE / DELETE 去改。
只输出 JSON：{"reply":"用人话说你做了什么（≤80字，含数量与范围）","sql":"多条语句用分号分隔","undo_hint":"可选，一句话"}

【动手前必须想清楚 — 这是最高优先级】
1. 先读「当前数据」：有哪些班次、专注模式、日程类型、轮转表、手动调班，各自 id 是多少。用户提到的东西，先在里面找。
2. 找不到就自己决定：
   - 类型/标签不合适 → 直接 INSERT 一个新的 work_types，这是你的权限，不用问。
   - 班次不存在（如「早班」）→ 这是实体定义，缺上下班时间没法建，停下来问一句。
   - 其他拿不准的 → 先按最合理的方式做，把假设写进 reply；只有「完全不知道改哪条」才问。
3. 删除/清空类：先在上下文里核对那个范围到底有没有东西，再删。范围以用户这次说的日期为准（「X 之前」= ≤X），
   上下文里列出的轮转表都带 [effective_from, end_date]，只有 effective_from ≤ X 的才算在范围内；
   手动调班只算 day ≤ X 的。范围内本来就没有任何排班/记录 → sql 留空，reply 直接说「X 之前本来就没有排班」。
   一条都没删到就直说，不要回「已清」。

【页面是怎么算出来的 — 删东西前必须懂】
- 日历上某天的班次 = shift_overrides[day] 优先；没有就看当天落在哪张 shift_rosters 的 [effective_from, end_date] 里，按 pattern 循环取。
- 所以「让某段日期没人排班」= 删掉这段的 shift_overrides + 把覆盖这段的 shift_rosters 删掉或截到段外（改 effective_from / end_date）。
- 「删掉 X 之前的排班」含 X 当天 = DELETE day ≤ X 的 overrides + DELETE effective_from ≤ X 的 rosters。
  要删就 DELETE 整张表，不要用 UPDATE 把 effective_from 往后挪来「截断」——那会留下空壳行，还容易漏掉别的表。
  只删 overrides 不动 rosters，日历上照样有班——用户会认为你没删。

【表结构】
work_types(id, name, sort, created_at)
work_tasks(id, type_id→work_types, title, note, due_at 'YYYY-MM-DD HH:MM', done 0/1, notified_at, created_at, sort, days '[]'或'[1,3]', head)
  days 非空 = 重复日程（周几，1=周一）；head = 所属规则行 id，0 = 单条。重复日程的子实例 head 指向规则行。
focus_modes(id, name, note, ring_each_step, sort, created_at, auto 0/1, days, shifts '[]'班次id, dkind ''/'work'/'off')
focus_steps(id, mode_id→focus_modes, title, minutes, anchor ''=接续或'HH:MM', note, sort)
shift_types(id, name, short, start 'HH:MM', end, cross_day 0/1, sort, kind 'shift'/'off'/'long', dur_min, modes '[]', breaks '[["11:30","13:00"]]')
shift_rosters(id, name, pattern '[班次id,0=休…]', start_date, effective_from, end_date NULL=一直, days NULL)
shift_overrides(day 'YYYY-MM-DD' PK, shift_id 0=休)
focus_step_done(day 'YYYY-MM-DD', mode_id→focus_modes, step_idx 从 0 数, done_at, done_by)  三列联合主键 = 这一天这个模式的第几步做完了

【硬规则】
- 只能写上面这 8 张表；只能 INSERT/UPDATE/DELETE；不要 DROP/ALTER/CREATE。
- created_at 用 'YYYY-MM-DD HH:MM:SS' 北京时间；主键 id 自增，INSERT 时不要给 id。
- 改哪条用 WHERE id=? 或 WHERE day=?，禁止没有 WHERE 的 UPDATE/DELETE。
- 不要凭空编 id：上下文里已经把 8 张表的内容都列出来了（每日提醒 daily.json 不在 SQL 表里），id 从那里拿。
- 你写的所有语句是一次性执行的，你看不到 SELECT 的结果。所以别用 SELECT 探路——直接按上下文写 INSERT/UPDATE/DELETE。
- 日期时间北京时间 24 小时制；「之前/以前」含当天；「明天/下周」按今天推算。
- 「工作日」= 周一至周五，「周末」= 周六、周日。给一段日期设班次时，先算清每天是周几：
  用户说「工作日上班」→ 周六日必须写成 0（休），不能漏掉不写，否则那天会落到轮转表上显示别的班。
- 手动调班按天写：INSERT OR REPLACE INTO shift_overrides(day, shift_id) VALUES(...),(...)；shift_id=0 表示休。
- 「某一步做完了 / 勾掉这一步」写 focus_step_done：INSERT OR REPLACE INTO focus_step_done(day, mode_id, step_idx, done_at, done_by) VALUES('YYYY-MM-DD', 模式id, 步序号, 'YYYY-MM-DD HH:MM:SS', 'ai')；
  取消勾 = DELETE FROM focus_step_done WHERE day=? AND mode_id=? AND step_idx=?。
  步序号 step_idx 是 steps 里的位置，从 0 开始（上下文 focus_modes 的 steps=… 按位置数第 1 个就是 0）；写之前先数清楚用户说的是第几步、属于哪个模式、哪一天。
- reply 里别贴 SQL，只说结果。有 undo_hint 时一句话说明回滚会丢什么。"""



def _ai_json(content: str) -> dict:
    txt = (content or "").strip()
    if txt.startswith("```"):
        txt = txt.split("```")[1]
        if txt.startswith("json"):
            txt = txt[4:]
    try:
        d = json.loads(txt)
    except Exception:
        raise HTTPException(502, "AI 返回的不是合法 JSON")
    return d if isinstance(d, dict) else {}


def _ai_history(payload: dict) -> list:
    msgs = [{"role": "system", "content": AI_SYSTEM}]
    for m in (payload.get("history") or [])[-10:]:
        if not isinstance(m, dict):
            continue
        role = "assistant" if str(m.get("role")) == "assistant" else "user"
        c = str(m.get("content") or "").strip()[:600]
        if c:
            msgs.append({"role": role, "content": c})
    return msgs


def _ai_context(text: str = "") -> str:
    """把「库里现在有什么」原样给模型：它要靠这些 id 写 SQL。
    不再按关键词猜要读哪张表——工作台相关的表本来就小，全给，省得猜错方向。"""
    s, e = _ai_window(text)
    d = store.ai_context_data(s, e, limit=200)
    sh = d.get("shift") or {}
    today, now = d.get("today"), store.now_bj()[11:16]
    parts = ["今天 %s，现在 %s。日期窗口 %s ~ %s（删除/查询类按这个窗口看）。" % (today, now, s, e)]

    ty = "；".join("%s=%s" % (t["id"], t["name"]) for t in (d.get("types") or [])) or "空"
    parts.append("日程类型 work_types：" + ty)

    tl = d.get("tasks") or []
    rows = []
    for t in tl[:60]:
        rows.append("%s=type%s|%s|%s|%s|%s" % (t["id"], t["type_id"], str(t["due_at"])[:16], t["title"],
                                                 t.get("days") or "[]", t.get("done") or 0))
    parts.append("日程 work_tasks（id=类型id|due_at|title|days|done）：" + ("；".join(rows) or "空")
                 + "（窗口内共 %d 条）" % len(tl))

    fm = (d.get("focus") or {}).get("modes") or []
    frows = []
    for m in fm[:12]:
        steps = "→".join("%s %s %s分" % (x.get("anchor") or "接续", x.get("title"), x.get("minutes"))
                       for x in (m.get("steps") or [])[:8])
        frows.append("%s=%s（steps=%s，days=%s，shifts=%s，auto=%s）" % (
            m["id"], m["name"], steps, m.get("days"), m.get("shifts"), m.get("auto")))
    parts.append("专注模式 focus_modes：" + ("；".join(frows) or "空"))

    dn = d.get("done") or []
    drows = ["%s|%s|%s|%s" % (x["day"], x["mode_id"], x["step_idx"], str(x.get("done_at") or "")[11:16])
             for x in dn]
    parts.append("专注已完成步骤 focus_step_done（day|mode_id|step_idx|done_at，step_idx 从 0 数）："
                 + ("；".join(drows) or "空"))

    st = sh.get("types") or []
    srows = []
    for t in st:
        srows.append("%s=%s(%s) %s-%s kind=%s%s" % (
            t["id"], t["name"], t["short"], t.get("start"), t.get("end"), t.get("kind"),
            (" breaks=%s" % t.get("breaks")) if t.get("breaks") else ""))
    parts.append("班次 shift_types：" + ("；".join(srows) or "空"))

    ro = sh.get("rosters") or []
    rrows = ["%s=%s pattern=%s %s~%s" % (r["id"], r["name"], r.get("pattern"),
                                          str(r.get("effective_from"))[:10], str(r.get("end_date") or "∞")[:10])
             for r in ro]
    parts.append("轮转表 shift_rosters：" + ("；".join(rrows) or "空"))

    ov_all = sh.get("overrides") or {}
    ov = {k: v for k, v in ov_all.items() if s <= str(k) <= e}
    orows = ["%s=%s" % (k, v) for k, v in sorted(ov.items())]
    parts.append("手动调班 shift_overrides（窗口内 day=班次id）：" + ("；".join(orows) or "空")
                 + "（库里共 %d 条）" % len(ov_all))
    if re.search(r"之前|以前|往前|过去|截至|截止", text):
        past = sorted(k for k in ov_all if k < s)
        if past:
            parts.append("注意：窗口之前还有 %d 条手动调班，最早 %s 最晚 %s（「之前」类操作要算上它们）。"
                         % (len(past), past[0], past[-1]))
    parts.append("未来 12 天实际班次：" + (_ai_shift_ahead(d) or "空"))
    dl = "；".join("%s %s" % (x.get("time"), x.get("text")) for x in _daily_read())
    parts.append("每日提醒 daily.json（不在 SQL 表里，由系统单独处理）：" + (dl or "空") + "。")
    return "\n".join(parts)


def _ai_chat(messages: list) -> str:
    key = _ai_key()
    if not key:
        raise HTTPException(400, "还没填 DeepSeek API Key：右上角「更多 → AI 助手」里填一下")
    model = _ai_model()
    body = {"model": model, "messages": messages, "max_tokens": 2000}
    # R1 不吃 response_format / temperature，硬塞会 400；只要求它按提示词里的 JSON 格式回
    if model == "deepseek-reasoner":
        body["max_tokens"] = 3000
    else:
        body["temperature"] = 0.1
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass
        if e.code == 402:
            raise HTTPException(402, "DeepSeek 余额不足。右上角「更多 → AI 助手」里点「充值」，充完回来点刷新")
        raise HTTPException(502, f"DeepSeek 返回 {e.code}：{detail or '请求失败'}")
    except Exception as e:
        raise HTTPException(502, f"连不上 DeepSeek：{e}")
    try:
        return d["choices"][0]["message"]["content"]
    except Exception:
        raise HTTPException(502, "DeepSeek 返回格式不对")


def _ai_drop_snapshot(name: str) -> None:
    try:
        f = store.BK_DIR / f"{name}.json"
        if f.exists():
            f.unlink()
    except Exception:
        pass


_SCOPE_NAME = {"work_tasks": "日程", "work_types": "日程类型", "focus_modes": "专注模式", "focus_steps": "专注步骤",
               "shift_types": "班次", "shift_rosters": "轮转表", "shift_overrides": "手动调班",
               "focus_step_done": "专注完成记录"}


def _ai_scope(tables) -> list[str]:
    return sorted({_SCOPE_NAME.get(t, t) for t in (tables or [])})


@app.get("/api/v1/ai/config")
def ai_config(_: None = Depends(require_auth)):
    key = _ai_key()
    return {"configured": bool(key), "hint": _ai_mask(key), "model": _ai_model(),
            "models": [{"id": k, "name": v} for k, v in AI_MODELS.items()]}


@app.get("/api/v1/ai/balance")
def ai_balance(_: None = Depends(require_auth)):
    key = _ai_key()
    if not key:
        raise HTTPException(400, "还没填 DeepSeek API Key")
    req = urllib.request.Request("https://api.deepseek.com/user/balance",
                                 headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise HTTPException(502, f"查询余额失败：HTTP {e.code}" + ("，Key 可能不对" if e.code in (401, 403) else ""))
    except Exception as e:
        raise HTTPException(502, f"连不上 DeepSeek：{e}")


@app.post("/api/v1/ai/config")
def ai_config_save(payload: dict = Body(...), _: None = Depends(require_auth)):
    cfg = _ai_cfg()
    key = str(payload.get("key") or "").strip()
    # 留空就当「不改 Key」：只切模型的时候不能把已经配好的 Key 顺手清掉
    if key:
        cfg["key"] = key
    elif payload.get("clear"):
        cfg["key"] = ""
    # 只认白名单里的模型，别把写错的值存进去
    model = str(payload.get("model") or "").strip()
    cfg["model"] = model if model in AI_MODELS else _ai_model()
    AI_CFG.write_text(json.dumps(cfg))
    try:
        AI_CFG.chmod(0o600)
    except Exception:
        pass
    return {"ok": True, "configured": bool(cfg.get("key")), "hint": _ai_mask(str(cfg.get("key") or "")),
            "model": cfg["model"]}


NOTE_SYSTEM = """你是「记录」输入框的整理助手。用户随手写一段，你把它整理成一条能直接保存的记录，只输出 JSON：
{"content":"整理后的正文","stage":"idea|plan|done|review","tags":["标签"],"stock_code":"代码或空","memo":""}
规则：
- content 保留用户原意和信息量，只理顺口语、修正错别字，不要扩写成作文，长度和原文相当；原文里的数字、结论、时间一律照抄，不能把原文信息搬到 memo 里丢掉。
- 用户自己写的 #标签 原样收进 tags；标签 1–3 个，优先用「常用标签」里已有的词，别造营销词。
- stage：只是观察/看法/判断→idea；出现「明天/下周/要盯/跟进/待办/记得/回头」这类将来动作→plan；已经做完/完成→done；复盘/总结/事后回顾→review。
- stock_code 只在明确说到某只股票时给，用「持仓/关注」列表里的代码；拿不准就空字符串。
- memo 只在用户写了明确的提醒（如「明天盯 XX」）时填一句，否则空。
- 不要输出 markdown、不要代码块、不要解释。"""


def _note_context() -> str:
    tags: dict[str, int] = {}
    try:
        for n in store.list_notes(limit=120):
            for t in (n.get("tags") or []):
                t = str(t).strip()
                if t:
                    tags[t] = tags.get(t, 0) + 1
    except Exception:
        pass
    top = [k for k, _ in sorted(tags.items(), key=lambda kv: (-kv[1], kv[0]))[:18]]
    names = []
    for bucket in ("hold", "watch"):
        try:
            for st in store.list_stocks(bucket)[:30]:
                names.append(f'{st.get("code")}={st.get("name")}')
        except Exception:
            pass
    return (f"今天 {store.today_bj()}。\n"
            f"常用标签：{'、'.join(top) or '空'}。\n"
            f"持仓/关注：{'、'.join(names[:40]) or '空'}。")


@app.post("/api/v1/ai/note")
def ai_note(payload: dict = Body(...), _: None = Depends(require_auth)):
    if not _ai_key():
        raise HTTPException(400, "还没填 DeepSeek API Key")
    text = str(payload.get("text") or "").strip()[:800]
    if not text:
        raise HTTPException(400, "先写点什么")
    content = _ai_chat([
        {"role": "system", "content": NOTE_SYSTEM},
        {"role": "user", "content": _note_context() + "\n随手写：\n" + text},
    ])
    txt = (content or "").strip()
    if txt.startswith("```"):
        txt = txt.split("```")[1]
        if txt.startswith("json"):
            txt = txt[4:]
    try:
        d = json.loads(txt)
    except Exception:
        raise HTTPException(502, "AI 返回的不是合法 JSON")
    stage = str(d.get("stage") or "idea")
    if stage not in ("idea", "plan", "done", "review"):
        stage = "idea"
    tags = []
    for x in (d.get("tags") or [])[:5]:
        x = str(x).strip().lstrip("#")
        if x and x not in tags:
            tags.append(x[:12])
    code = re.sub(r"[^0-9A-Za-z.]", "", str(d.get("stock_code") or ""))[:12]
    return {"ok": True,
            "content": (str(d.get("content") or "").strip() or text)[:2000],
            "stage": stage, "tags": tags, "stock_code": code,
            "memo": str(d.get("memo") or "").strip()[:200]}


WK_FILTER_SYSTEM = """你是「数据总览」页的筛选助手，用中文跟人说话。你只负责「看什么」，绝对不能改数据：
不许写 SQL、不许改表、不许删任何东西。每轮只输出 JSON：
{"mode_id":0,"weeks":4,"metric":"focus","reply":"一句话"}
参数：
- mode_id：0 = 全部专注模式；否则只能是「可选的专注模式」里给出的 id，不许编。
- weeks：4 / 13 / 26（近四周 / 近十三周 / 近半年），说了别的取最接近的一档。
- metric：focus=专注时长 / runs=专注场次 / task=任务完成 / shift=值班工时。
- 值班工时和任务完成跟专注模式无关：这两项时 mode_id 必须是 0，reply 里也不许提任何模式名（写「近半年，看值班工时」）。
reply 怎么写：
- 寒暄、闲聊、和筛选无关的话（「你好」「谢谢」「你是谁」）：参数一项都不动，reply 自然接一句并给个方向，
  例如「你好，想看哪个模式、哪段时间？」。**不要**说「保持当前设置」这类机器话，也不要复述当前参数。
- 真要改了筛选：一句话说清看什么，例如「按司法日常，近半年，看专注时长」，≤24 字。
- 没改参数但用户在问数据：按当前参数看，reply 说清看的是哪段哪项。
- 永远不报具体数字（数字由页面自己显示），不解释思考过程，不道歉，不用「已为您」这套话，不要 markdown。
"""


@app.post("/api/v1/work/ai-filter")
def work_ai_filter(payload: dict = Body(...), _: None = Depends(require_auth)):
    """只读：把一句话翻译成「数据总览」的筛选参数。这里不碰任何表。"""
    if not _ai_key():
        raise HTTPException(400, "还没填 DeepSeek API Key")
    text = str(payload.get("text") or "").strip()[:300]
    if not text:
        raise HTTPException(400, "先说想怎么看")
    try:
        today = store.today_bj()[:10]
        from datetime import datetime, timedelta   # 本地导入，模块其余部分没用到
        ov = store.work_overview((datetime.now() - timedelta(days=364)).strftime("%Y-%m-%d"), today)
        stats = ov.get("mode_stats") or []
    except Exception:
        stats = []
    cur_mid = int(payload.get("mode_id") or 0)
    cur_weeks = int(payload.get("weeks") or 4)
    cur_metric = str(payload.get("metric") or "focus")
    lines = [f"{x['id']}={x['name']}（{x['runs']} 场 / {x['min']} 分钟）" for x in stats[:40]]
    ctx = (f"今天 {store.today_bj()[:10]}。\n"
           f"可选的专注模式：{'；'.join(lines) or '空'}。\n"
           f"当前显示：mode_id={cur_mid}，weeks={cur_weeks}，metric={cur_metric}。")
    msgs = [{"role": "system", "content": WK_FILTER_SYSTEM}]
    for m in (payload.get("history") or [])[-6:]:      # 带上前几轮，接着问「那白班呢」能听懂
        if not isinstance(m, dict):
            continue
        c = str(m.get("content") or "").strip()[:400]
        if c:
            msgs.append({"role": "assistant" if str(m.get("role")) == "assistant" else "user", "content": c})
    msgs.append({"role": "user", "content": ctx + "\n用户说：\n" + text})
    d = _ai_json(_ai_chat(msgs))
    ids = {int(x["id"]) for x in stats}
    mid = int(d.get("mode_id") or 0)
    if mid and mid not in ids:
        mid = cur_mid if cur_mid in ids else 0
    weeks = int(d.get("weeks") or cur_weeks)
    if weeks not in (4, 13, 26):
        weeks = min((4, 13, 26), key=lambda x: abs(x - weeks))
    metric = str(d.get("metric") or cur_metric)
    if metric not in ("focus", "task", "shift", "runs"):
        metric = cur_metric
    # 值班工时 / 任务完成跟专注模式无关：这时把模式清成「全部」，免得抬头写着白班、数字却是全员的
    if metric in ("shift", "task"):
        mid = 0
    reply = str(d.get("reply") or "").strip()[:80] or "想看哪个模式、哪段时间？"
    return {"ok": True, "mode_id": mid, "weeks": weeks, "metric": metric, "reply": reply,
            "mode_name": next((x["name"] for x in stats if x["id"] == mid), "全部模式")}


@app.post("/api/v1/ai/exec")
def ai_exec(payload: dict = Body(...), _: None = Depends(require_auth)):
    """AI 直接写 SQL 改工作台的表。这里只负责：喂上下文 → 拿 SQL → 快照 → 执行 → 用真实结果生成回报。
    数字一律以后端实测为准，不让模型自己编「删了 N 条」。"""
    text = str(payload.get("text") or "").strip()[:600]
    if not text:
        raise HTTPException(400, "先说要改什么")

    def _log(reply: str, ok: bool, sql: str = "", tables=None, rows: int = 0, snapshot=None):
        try:
            store.ai_log_add({"at": store.now_bj()[:19], "text": text, "reply": str(reply or "")[:300],
                              "sql": str(sql or "")[:2000], "ok": bool(ok), "tables": list(tables or []),
                              "rows": int(rows or 0), "snapshot": snapshot, "undone": False})
        except Exception as e:
            log.warning("[ai] log failed: %s", e)

    msgs = _ai_history(payload)
    msgs.append({"role": "user", "content": _ai_context(text) + "\n用户： " + text})
    d = _ai_json(_ai_chat(msgs))
    sql = str(d.get("sql") or "").strip()
    log.warning("[ai] %r -> sql=%r", text, sql[:600])
    if not sql:
        rep = str(d.get("reply") or "").strip()[:300] or "这句我没找到要改的东西。"
        _log(rep, True)
        return {"ok": True, "reply": rep,
                "applied": [], "skipped": [], "snapshot": None, "snap_at": None, "scope": []}

    snap = store.work_snapshot("ai", {"daily": _daily_read()})
    try:
        r = store.ai_sql_exec(sql)
    except Exception as e:
        _ai_drop_snapshot(snap["id"])
        log.warning("[ai] exec failed: %s", e)
        _log("没改成。" + str(e), False, sql)
        return {"ok": True, "reply": "没改成。%s" % e, "applied": [], "skipped": [str(e)],
                "snapshot": None, "snap_at": None, "scope": [], "failed": True}

    if r["rows"] == 0:
        _ai_drop_snapshot(snap["id"])
        why = ("只给了查询语句，没有要改的。" if r["n"] == 0
               else "库里没有任何行受影响——这个范围里可能本来就没有记录，或条件没对上。")
        _log("没改成。" + why, False, sql, r["tables"])
        return {"ok": True, "reply": "没改成。" + why, "applied": [{"kind": "sql", "tables": r["tables"], "rows": 0}],
                "skipped": [why], "snapshot": None, "snap_at": None, "scope": [], "failed": True}

    # 执行成功后，把每条语句真实改了几行告诉模型，让它照着写 reply（这一轮不允许再出 SQL）
    def _tbl(st: str) -> str:
        m = re.search(r"\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update|delete\s+from)\s+([A-Za-z_]\w*)", st, re.I)
        return _SCOPE_NAME.get(m.group(1).lower(), m.group(1)) if m else "工作台"
    facts = "；".join("%s 改了 %d 行" % (_tbl(st), n) for st, n in r["per_stmt"])
    msgs.append({"role": "assistant", "content": json.dumps({"reply": d.get("reply") or "", "sql": sql}, ensure_ascii=False)})
    msgs.append({"role": "user", "content": "SQL 已执行。真实结果：%s。\n请根据真实结果重写 reply（≤80字，写清改了什么/哪个范围/几行；"
                 "用上面这些中文名，不要出现英文表名；不要再出 SQL，sql 字段留空）。" % facts})
    try:
        d2 = _ai_json(_ai_chat(msgs))
        reply = str(d2.get("reply") or "").strip()[:300] or str(d.get("reply") or "").strip()[:300]
    except Exception:
        reply = str(d.get("reply") or "").strip()[:300]
    reply = reply or ("已改 %d 行。" % r["rows"])
    _log(reply, True, sql, r["tables"], r["rows"], snap["id"])
    return {"ok": True, "reply": reply, "applied": [{"kind": "sql", **{k: v for k, v in r.items() if k != "per_stmt"}}],
            "skipped": [], "snapshot": snap["id"], "snap_at": snap["at"], "scope": _ai_scope(r["tables"]),
            "sql": sql[:2000], "undo_hint": str(d.get("undo_hint") or "")[:120]}


def _ai_do_undo(name: str, reply: str) -> dict:
    try:
        r = store.work_restore(name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    daily = (r.get("extra") or {}).get("daily")
    if isinstance(daily, list):
        _daily_write(daily)
    try:
        store.ai_log_mark_undone(name)     # 历史里那条「已改」要变成「已回滚」
    except Exception:
        pass
    return {"ok": True, "reply": reply, "ops": [], "applied": [{"kind": "undo", "id": name}],
            "skipped": [], "snapshot": None, "scope": ["回滚"], "undo_to": name}


@app.post("/api/v1/ai/undo")
def ai_undo(payload: dict = Body(...), _: None = Depends(require_auth)):
    name = str(payload.get("id") or "").strip()
    if not name:
        snaps = store.work_snapshots(1)
        if not snaps:
            raise HTTPException(400, "还没有可回滚的改动记录")
        name = snaps[0]["id"]
    return _ai_do_undo(name, "已回滚。")


@app.get("/api/v1/ai/snapshots")
def ai_snapshots(_: None = Depends(require_auth)):
    return {"items": store.work_snapshots(12)}


@app.get("/api/v1/ai/history")
def ai_history_list(limit: int = 80, _: None = Depends(require_auth)):
    return {"items": store.ai_log_list(limit)}


@app.delete("/api/v1/ai/history")
def ai_history_clear(_: None = Depends(require_auth)):
    store.ai_log_clear()
    return {"ok": True}


def _ai_norm_day(v) -> str:
    d = str(v or "").strip()[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        raise ValueError("日期要 YYYY-MM-DD")
    return d


def _ai_norm_dt(v) -> str:
    d = str(v or "").strip().replace("T", " ")[:16]
    if not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", d):
        raise ValueError("时间要 YYYY-MM-DD HH:MM")
    return d


@app.get("/api/v1/work")
def work_all(_: None = Depends(require_auth)):
    """工作台全量：类型清单 + 所有日程 + 每日提醒。"""
    d = store.work_list()
    d["daily"] = _daily_read()
    return d


# ---------- 每日提醒：一句话 + 一个时刻，按天重复 ----------
# 不进 work_tasks（那张表是 type_id + due_at 的一次性日程），单独一份 JSON，
# 前端跟着工作页一起取，服务端 notify.py --tick 也读同一份，两处只有一处真源。
DAILY = DATA / "daily.json"


def _daily_read() -> list:
    try:
        items = json.loads(DAILY.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [x for x in items if isinstance(x, dict) and x.get("time")]


def _daily_write(items: list) -> None:
    DAILY.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def _daily_norm(payload: dict, base: dict | None = None) -> dict:
    it = dict(base or {})
    t = str(payload.get("time", it.get("time", ""))).strip()[:5]
    if not re.match(r"^\d{1,2}:\d{2}$", t):
        raise HTTPException(400, "时间要 HH:MM")
    hh, mm = t.split(":")
    if int(hh) > 23 or int(mm) > 59:
        raise HTTPException(400, "时间要 HH:MM")
    it["time"] = "%02d:%s" % (int(hh), mm)
    if "text" in payload or not it.get("text"):
        it["text"] = str(payload.get("text", it.get("text", ""))).strip()[:24] or "每日提醒"
    if "days" in payload or not it.get("days"):
        it["days"] = "work" if str(payload.get("days", it.get("days", "all"))) == "work" else "all"
    it["on"] = bool(payload.get("on", it.get("on", True)))
    return it


@app.get("/api/v1/daily")
def daily_list(_: None = Depends(require_auth)):
    return {"items": _daily_read()}


@app.post("/api/v1/daily")
def daily_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    items = _daily_read()
    it = _daily_norm(payload)
    it["id"] = (max([int(x.get("id") or 0) for x in items] or [0]) + 1)
    items.append(it)
    items.sort(key=lambda x: x["time"])
    _daily_write(items)
    return it


@app.patch("/api/v1/daily/{rid}")
def daily_edit(rid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    items = _daily_read()
    cur = next((x for x in items if int(x.get("id") or 0) == rid), None)
    if not cur:
        raise HTTPException(404, "这条每日提醒不在了")
    items[items.index(cur)] = _daily_norm(payload, cur)
    items.sort(key=lambda x: x["time"])
    _daily_write(items)
    return cur


@app.delete("/api/v1/daily/{rid}")
def daily_del(rid: int, _: None = Depends(require_auth)):
    items = _daily_read()
    keep = [x for x in items if int(x.get("id") or 0) != rid]
    if len(keep) == len(items):
        raise HTTPException(404, "这条每日提醒不在了")
    _daily_write(keep)
    return {"ok": True}


@app.post("/api/v1/work/types")
def work_type_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.work_add_type(payload.get("name") or "")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/work/types/{tid}")
def work_type_patch(tid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        ok = store.work_update_type(tid, payload.get("name") or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not ok:
        raise HTTPException(404, "没有这个类型")
    return {"ok": True}


@app.delete("/api/v1/work/types/{tid}")
def work_type_del(tid: int, _: None = Depends(require_auth)):
    return {"ok": True, "removed": store.work_del_type(tid)}


@app.post("/api/v1/work/tasks")
def work_task_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.work_add_task(int(payload.get("type_id") or 0),
                                   payload.get("title") or "",
                                   payload.get("note") or "",
                                   payload.get("due_at") or "",
                                   payload.get("days") or [])
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/work/tasks/{tid}")
def work_task_patch(tid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    patch = {}
    for k in ("title", "note", "due_at", "type_id", "done", "notified_at", "snooze_at", "days"):
        if k in payload:
            patch[k] = payload[k]
    if not store.work_update_task(tid, patch):
        raise HTTPException(404, "没有这条日程")
    return {"ok": True}


@app.delete("/api/v1/work/tasks/{tid}")
def work_task_del(tid: int, _: None = Depends(require_auth)):
    return {"ok": True, "removed": store.work_del_task(tid)}


# ---- 专注模式 ----
@app.get("/api/v1/work/day")
def work_day(day: str, _: None = Depends(require_auth)):
    try:
        return store.work_day_brief(day)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/v1/work/overview")
def work_overview(start: str = "", end: str = "", mode: int | None = None,
                  _: None = Depends(require_auth)):
    """数据总览：按天汇总专注时长/场次/步数 + 任务完成数。值班工时由前端本地排班算。"""
    try:
        return store.work_overview(start, end, mode)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/v1/work/focus")
def work_focus(_: None = Depends(require_auth)):
    return store.focus_list()


@app.post("/api/v1/work/focus/modes")
def focus_mode_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.focus_save_mode(None, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/work/focus/modes/{mid}")
def focus_mode_patch(mid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.focus_save_mode(mid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/v1/work/focus/modes/{mid}")
def focus_mode_del(mid: int, _: None = Depends(require_auth)):
    return {"ok": True, "removed": store.focus_del_mode(mid)}


@app.post("/api/v1/work/focus/runs")
def focus_run_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.focus_start_run(int(payload.get("mode_id") or 0), str(payload.get("plan") or "auto"))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/work/focus/runs/{rid}")
def focus_run_patch(rid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.focus_update_run(rid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- 步完成（跨设备共用一条账）----
@app.get("/api/v1/work/focus/done")
def focus_done_list(day: str = "", days: int = 3, _: None = Depends(require_auth)):
    try:
        return store.focus_step_done_list(day or store.today_bj(), days)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/v1/work/focus/done")
def focus_done_set(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.focus_set_step_done(
            str(payload.get("day") or ""), int(payload.get("mode_id") or 0),
            int(payload.get("step_idx") or 0), bool(payload.get("done")),
            str(payload.get("by") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---- 值班模式 ----
@app.get("/api/v1/work/shift")
def work_shift(_: None = Depends(require_auth)):
    return store.shift_list()


@app.post("/api/v1/work/shift/types")
def shift_type_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.shift_save_type(None, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/work/shift/types/{tid}")
def shift_type_patch(tid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.shift_save_type(tid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/v1/work/shift/types/{tid}")
def shift_type_del(tid: int, _: None = Depends(require_auth)):
    return store.shift_del_type(tid)


@app.post("/api/v1/work/shift/rosters")
def shift_roster_add(payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.shift_save_roster(None, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/work/shift/rosters/{rid}")
def shift_roster_patch(rid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.shift_save_roster(rid, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/v1/work/shift/rosters/{rid}")
def shift_roster_del(rid: int, _: None = Depends(require_auth)):
    return {"ok": True, "removed": store.shift_del_roster(rid)}


@app.put("/api/v1/work/shift/overrides/{day}")
def shift_override_set(day: str, payload: dict = Body(...), _: None = Depends(require_auth)):
    try:
        return store.shift_set_override(day, payload.get("shift_id"))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/v1/fund/{code}/news")
def fund_news(code: str, limit: int = 20, _: None = Depends(require_auth)):
    """基金「最新新闻」：目标 ETF/指数 + 前十大重仓股的个股资讯，按时间倒序合并。"""
    code = (code or "").strip()
    try:
        prof = quote_service.fund_profile(code)
    except Exception:
        prof = {}
    pos: dict = {}
    try:
        pos = quote_service.fund_position(code)
    except Exception:
        pos = {}
    targets: list[dict] = []
    etf = pos.get("etf") or None
    if etf and etf.get("code"):
        ec = str(etf["code"])
        targets.append({"code": ec, "name": etf.get("name") or "目标ETF", "kind": "指数",
                        "market": "1" if ec[0] in "569" else "0"})
    stocks = [x for x in (pos.get("stocks") or []) if x.get("code") and x.get("market")]
    if not stocks and etf and etf.get("code"):
        try:  # 联接基金自己没披露股票，就用目标 ETF 的重仓股
            stocks = [x for x in (quote_service.fund_position(etf["code"]).get("stocks") or [])
                      if x.get("market")]
        except Exception:
            stocks = []
    for x in stocks[:5]:
        targets.append({**x, "kind": "重仓"})
    items: list[dict] = []
    seen: set[str] = set()
    for t in targets:
        try:
            one = quotes.stock_news(t["code"], t.get("market") or "", 5)
        except Exception:
            one = []
        for n in one:
            if n["title"] in seen:
                continue
            seen.add(n["title"])
            items.append({**n, "code": t["code"], "name": t["name"], "kind": t["kind"]})
    items.sort(key=lambda x: x.get("time") or "", reverse=True)
    return {"code": code, "name": prof.get("name") or "",
            "report": pos.get("report") or "", "based_on": targets,
            "items": items[:max(1, min(int(limit), 40))]}


# ---------------- feed（首页） ----------------
HOT_CAT = "热门板块"


def _upcoming_events(days: int = 7) -> list[dict]:
    """需关注顶部的「关键日程」：固定日程 + 东财财经日历 + 用户手动加的 category=日程 条目。"""
    events = market_calendar.upcoming(days)
    try:  # 自动日程（行业大会/央行议息/中美核心数据），抓不到就只用固定日程
        events += market_calendar.remote_events(days)
    except Exception:
        pass
    # 固定日程与自动日程撞同一件事（美联储议息、LPR）：同一主题只留固定那条
    same_topic = [("美联储", "FOMC"), ("LPR", "贷款市场报价")]
    fixed_txt = [e for e in events if not e.get("auto")]

    def _dup(e: dict) -> bool:
        for f in fixed_txt:
            if f["day"] != e["day"]:
                continue
            a, b = f["title"], e["title"]
            if a == b or a in b or b in a:
                return True
            for k1, k2 in same_topic:
                if (k1 in a or k2 in a) and (k1 in b or k2 in b):
                    return True
        return False

    events = [e for e in events if e.get("auto") is not True or not _dup(e)]
    seen = {(e["day"], e["title"]) for e in events}
    for m in store.upcoming_events(days):
        key = (m["day"], m["title"])
        if key in seen:
            continue
        seen.add(key)
        events.append({
            "day": m["day"], "time": "", "kind": (m.get("tag") or "日程"),
            "title": m["title"], "note": m.get("body") or "手动添加",
            "weekday": "", "id": m["id"], "manual": True, "tag": m.get("tag") or "",
        })
    hidden = store.hidden_events()
    events = [e for e in events if f"{e['day']}|{e['title']}" not in hidden]
    events.sort(key=lambda x: (x["day"], x.get("time") or "99:99", x["title"]))
    return events


_last_purge = 0.0


def _feed_payload() -> dict:
    """首页：最新报告 + 需关注（报告抽取/手动）+ 实时新闻（财联社/金十）+ 收藏夹。

    天气不再随 feed 下发：前端早就不显示了，留着只会让首屏多背 1KB 和被上游拖慢
    （open-meteo 在服务器上不通时曾让这个接口每次卡 12 秒）。需要时走 /api/v1/weather。
    """
    global _last_purge
    if time.time() - _last_purge > 3600:  # 过期日程每小时清一次
        _last_purge = time.time()
        try:
            store.purge_past_events()
        except Exception:
            pass
    rep = store.latest_report()
    report = None
    read = False
    if rep:
        rid = rep["id"]
        read = store.is_read(rid)
        report = {"id": rid, "day": rep["day"], "kind": rep["kind"], "title": rep["title"],
                  "content": rep["content"], "size": len(rep["content"])}
    # 需关注只保留「你自己加的」条目；报告里的热门/宏观/大盘/个股分析已分别进
    # 行情页（热门分析 / 市场行情）和个股卡片，不再在这里铺一遍。
    focus = store.list_manual_focus()
    today = store.today_bj()
    mkt = quotes.market_status()
    mkt.pop("server_time", None)  # 否则 feed 的 ETag 每秒都变，304 永远不命中
    live_stats = store.live_stats(day=today)   # 全量统计：首屏只带 60 条，但计数要准
    return {
        "report": report, "read": read, "focus": focus, "saved_count": store.count_saved(),
        "live": store.list_live(FEED_LIVE_LIMIT, day=today),
        "live_limit": FEED_LIVE_LIMIT,
        "live_total": live_stats["total"],
        "live_stats": live_stats,
        "live_at": store.last_live_at(), "days": store.news_days(30),
        "live_days": store.live_days(10), "today": today,
        "events": _upcoming_events(7),
        "trash_days": store.TRASH_DAYS,
        "market": mkt,
    }


@app.get("/api/v1/feed")
def feed(request: Request, _: None = Depends(require_auth)):
    return _etag_response(request, _feed_payload())


@app.get("/api/v1/boot")
def boot(request: Request):
    """一次拿齐 session + board + feed，减少移动网络下的往返（隧道单次 ~3s）。"""
    if not is_authed(request):
        return {"authed": False}
    return {"authed": True, "board": _board_payload(), "feed": _feed_payload()}


@app.post("/api/v1/reports/{rid}/read")
def read_report(rid: int, _: None = Depends(require_auth)):
    if not store.get_report(rid):
        raise HTTPException(404, "报告不存在")
    store.mark_read(rid)
    return {"ok": True}


@app.delete("/api/v1/reports/{rid}/read")
def unread_report(rid: int, _: None = Depends(require_auth)):
    with store.conn() as c:
        c.execute("DELETE FROM report_reads WHERE report_id=?", (rid,))
    return {"ok": True}


# ---------------- 热门板块 / 涨停 / 天气 ----------------
@app.get("/api/v1/weather")
def weather_now(force: bool = False, _: None = Depends(require_auth)):
    return weather.get(force=force)


# ---------------- 心率（快捷指令 / 壳把采样推上来，待机与体能页读） ----------------
HR_FILE = DATA / "hr.json"
_hr_lock = threading.Lock()


def _hr_load() -> dict:
    try:
        d = json.loads(HR_FILE.read_text())
        if isinstance(d, dict) and isinstance(d.get("samples"), list):
            return d
    except Exception:
        pass
    return {"samples": [], "max_bpm": 0}


def _hr_save(d: dict) -> None:
    tmp = HR_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False))
    tmp.replace(HR_FILE)


def _hr_trim(d: dict) -> dict:
    now = time.time()
    keep = []
    for x in d.get("samples") or []:
        try:
            bpm = float(x.get("bpm"))
            at = float(x.get("at"))
        except Exception:
            continue
        if bpm < 25 or bpm > 240:
            continue
        if now - at > 3600:
            continue
        keep.append({"bpm": round(bpm), "at": at})
    d["samples"] = keep[-200:]
    d["updated"] = keep[-1]["at"] if keep else 0
    return d


def _hr_add(items: list, max_bpm: float | None = None) -> dict:
    now = time.time()
    with _hr_lock:
        d = _hr_load()
        if max_bpm and 120 <= float(max_bpm) <= 230:
            d["max_bpm"] = int(float(max_bpm))
        for it in items:
            try:
                bpm = float(it.get("bpm"))
                at = float(it.get("at") or now)
            except Exception:
                continue
            if 25 <= bpm <= 240:
                d.setdefault("samples", []).append({"bpm": round(bpm), "at": at})
        d = _hr_trim(d)
        _hr_save(d)
        return d


@app.get("/api/v1/health")
@app.get("/api/v1/hr")
def hr_get(bpm: float | None = None, at: float | None = None, max_bpm: float | None = None,
           _: None = Depends(require_app)):
    """不带参数就是读最近一小时采样；带 bpm 就是推一条（快捷指令直接 GET 这个 URL 最省事）。"""
    if bpm is not None:
        _hr_add([{"bpm": bpm, "at": at or time.time()}], max_bpm)
    d = _hr_load()
    return {"ok": True, "samples": d.get("samples") or [], "updated": d.get("updated") or 0,
            "max_bpm": d.get("max_bpm") or 0, "metrics": d.get("metrics") or {},
            "metrics_at": d.get("metrics_at") or 0}


# ---------- 音乐：正在播放的封面 + 第三方歌词匹配（个人自用，只做本机缓存） ----------
# 歌词源是网易云那两个老接口，非官方，随时可能变；命中就落盘，之后离线直接用。
# 封面优先用壳从系统「音乐」App 拿到的封面，拿不到时再按「歌名+歌手」问 iTunes。
_LYRIC_FILE = DATA / "lyric_cache.json"
_COVER_FILE = DATA / "cover_cache.json"
_mus_lock = threading.Lock()
_UA = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"}


def _cache_load(p: Path) -> dict:
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return {}


def _cache_save(p: Path, d: dict) -> None:
    try:
        if len(d) > 800:                       # 只留最近 800 首，别无限长
            for k in list(d.keys())[: len(d) - 800]:
                d.pop(k, None)
        p.write_text(json.dumps(d, ensure_ascii=False), "utf-8")
    except Exception:
        pass


def _norm(s: str) -> str:
    return re.sub(r"[\s\W_]+", "", (s or "").lower())


def _lyric_key(title: str, artist: str) -> str:
    # 前缀带源名：换源以后旧缓存自然作废，不会被上一版残留污染
    return f"qq|{_norm(title)}|{_norm(artist)}"


_QQ_H = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
         "Referer": "https://y.qq.com/"}


def _qq_search(title: str, artist: str, limit: int = 8) -> list:
    """QQ 音乐搜索（非官方接口）。返回 [{mid,name,artists,dur_s,album_mid}]。
    「歌名 + 歌手」拼在一起查经常直接 0 条（接口按整串匹配），所以先用歌名查，
    不够再补一次「歌名 歌手」并去重 —— 封面/歌词以前时有时无就是这里只剩一种查法。"""
    def _one(w: str) -> list:
        try:
            r = requests.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
                             params={"w": w, "n": limit, "format": "json"},
                             headers=_QQ_H, timeout=8)
            return (r.json() or {}).get("data", {}).get("song", {}).get("list") or []
        except Exception:
            return []
    raw = _one(title) if title else []
    if len(raw) < 3 and artist:
        extra = _one(f"{title} {artist}".strip())
        seen = {x.get("songmid") for x in raw}
        raw += [x for x in extra if x.get("songmid") not in seen]
    out = []
    for x in raw:
        out.append({
            "mid": x.get("songmid") or "",
            "name": x.get("songname") or "",
            "artists": [a.get("name") or "" for a in (x.get("singer") or [])],
            "dur_s": float(x.get("interval") or 0) / 1000.0,
            "album_mid": x.get("albummid") or "",
        })
    return out


def _itunes_cover(title: str, artist: str, dur_s: float = 0) -> tuple:
    """iTunes Search（免费公开、无需登录、https），QQ 拿不到专辑图时兜底。
    返回 (600x600 图 url, 匹配到的曲名)；拿不到就 ("", "")。"""
    try:
        r = requests.get("https://itunes.apple.com/search",
                         params={"term": f"{title} {artist}".strip(), "entity": "song", "limit": 12},
                         headers={"User-Agent": "Mozilla/5.0"}, timeout=9)
        results = (r.json() or {}).get("results") or []
    except Exception:
        return "", ""
    best, best_rate, best_url = "", -1.0, ""
    for it in results:
        name, arts = it.get("trackName") or "", it.get("artistName") or ""
        rate = 0.0
        if title and title == name: rate += 3
        elif title and title in name: rate += 2
        if artist and artist == arts: rate += 4
        elif artist and artist in arts: rate += 2
        try: ms = float(it.get("trackTimeMillis") or 0) / 1000.0
        except Exception: ms = 0.0
        if dur_s and ms and abs(ms - dur_s) <= 4: rate += 3
        u = it.get("artworkUrl100") or ""
        if rate >= 5 and u and rate > best_rate:
            best, best_rate, best_url = name, rate, u.replace("100x100bb", "600x600bb")
    return best_url, best


def _qq_pick(items: list, title: str, artist: str, dur_s: float):
    """挑最像的一首：歌名相等/包含、歌手相等/包含，时长差 3 秒内加分最多。原唱优先。"""
    best, bestRate = None, -1.0
    for i, it in enumerate(items):
        arts = " ".join(it["artists"])
        rate = 0.0
        nt, ns = _norm(title), _norm(it["name"])
        if nt and nt == ns:
            rate += 3
        elif nt and nt in ns:
            rate += 2
        na = _norm(artist)
        if na:
            if na == _norm(arts):
                rate += 4
            elif na in _norm(arts):
                rate += 2
            elif any(na in _norm(a) for a in it["artists"]):
                rate += 1
        if dur_s > 0 and it["dur_s"] > 0 and abs(it["dur_s"] - dur_s) <= 3:
            rate += 3
        rate -= i * 0.1
        if rate > bestRate:
            best, bestRate = it, rate
    return best


@app.get("/api/v1/lyric")
def lyric_get(title: str = "", artist: str = "", dur: float = 0,
              _: None = Depends(require_app)):
    """按歌名+歌手（时长当校验）匹配歌词，命中返回 LRC 原文，解析交给前端。"""
    title, artist = (title or "").strip(), (artist or "").strip()
    if not title:
        return {"ok": False, "error": "缺少歌名"}
    key = _lyric_key(title, artist)
    with _mus_lock:
        cache = _cache_load(_LYRIC_FILE)
    if key in cache:
        return {"ok": True, "hit": True, "cached": True, "lrc": cache[key].get("lrc") or "",
                "matched": cache[key].get("matched") or {}}
    items = _qq_search(title, artist)
    if not items:
        return {"ok": False, "error": "搜索失败（QQ 源不可达）"}
    it = _qq_pick(items, title, artist, float(dur or 0))
    if not it or not it["mid"]:
        return {"ok": True, "hit": False, "error": "没搜到"}
    try:
        r2 = requests.get("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
                          params={"songmid": it["mid"], "format": "json", "nobase64": 1},
                          headers=dict(_QQ_H, Referer="https://y.qq.com/portal/player.html"),
                          timeout=8)
        lrc = ((r2.json() or {}).get("lyric")) or ""
    except Exception as e:
        return {"ok": False, "error": f"取词失败：{type(e).__name__}"}
    if not lrc.strip():
        return {"ok": True, "hit": False, "error": "这首没有歌词"}
    matched = {"mid": it["mid"], "title": it["name"], "artist": ",".join(it["artists"]),
               "dur": int(it["dur_s"] * 1000)}
    with _mus_lock:
        cache = _cache_load(_LYRIC_FILE)
        cache[key] = {"lrc": lrc, "matched": matched, "at": int(time.time())}
        _cache_save(_LYRIC_FILE, cache)
    return {"ok": True, "hit": True, "cached": False, "lrc": lrc, "matched": matched}


@app.get("/api/v1/cover")
def cover_get(title: str = "", artist: str = "", dur: float = 0, pic: str = "",
              _: None = Depends(require_app)):
    """壳拿不到封面（云端曲目常见）时的兜底：同一套 QQ 搜索的专辑图。
    歌词和封面走同一个匹配函数，不会出现图跟词不是同一首。"""
    title, artist = (title or "").strip(), (artist or "").strip()
    if pic:
        return {"ok": True, "url": pic, "cached": True}     # 壳已经拿到图，直接用
    if not title:
        return {"ok": False, "error": "缺少歌名"}
    key = _lyric_key(title, artist)
    with _mus_lock:
        cache = _cache_load(_COVER_FILE)
    if key in cache:
        return {"ok": True, "url": cache[key], "cached": True}
    items = _qq_search(title, artist)
    with_pic = [x for x in items if x["album_mid"]]
    it = _qq_pick(with_pic, title, artist, float(dur or 0)) if with_pic else None
    if it:
        url = f"https://y.gtimg.cn/music/photo_new/T002R500x500M000{it['album_mid']}.jpg"
    else:
        url, hit = _itunes_cover(title, artist, float(dur or 0))
        if not url:
            return {"ok": True, "url": "", "error": "两个源都没找到这张封面"}
        it = {"name": hit}
    with _mus_lock:
        cache = _cache_load(_COVER_FILE)
        cache[key] = url
        _cache_save(_COVER_FILE, cache)
    return {"ok": True, "url": url, "cached": False, "track": it["name"]}


_MUSIC_SEARCH_CACHE = {}
_MUSIC_SEARCH_FILE = os.path.join(_DATA_DIR, "music_search.json") if "_DATA_DIR" in globals() else ""


def _itunes_search(term: str, kind: str, limit: int) -> list:
    """Apple 的公开目录检索（iTunes Search）。自签包没有 MusicKit 能力，
    所以搜索只用这个不用登录的接口，播放交给系统「音乐」App。
    kind=album 返回专辑，kind=song 返回单曲。"""
    entity = "album" if kind == "album" else "song"
    out = []
    # 中文歌在 cn 店经常是 0 条（大陆曲库不在 iTunes 目录里），港台店最全；
    # 三个店都试一遍、取结果最多的那个，英文歌才会落到默认店。
    for country in ("cn", "hk", "tw", None):
        params = {"term": term, "media": "music", "entity": entity, "limit": str(limit)}
        if country:
            params["country"] = country
        try:
            r = requests.get("https://itunes.apple.com/search", params=params,
                             headers={"User-Agent": "Mozilla/5.0"}, timeout=9)
            items = (r.json() or {}).get("results") or []
        except Exception:
            items = []
        if len(items) > len(out):
            out = items
        if len(out) >= limit:
            break
    res = []
    for it in out:
        art = (it.get("artworkUrl100") or "").replace("100x100bb", "600x600bb")
        if kind == "album":
            res.append({
                "id": str(it.get("collectionId") or ""),
                "name": it.get("collectionName") or "",
                "artist": it.get("artistName") or "",
                "art": art,
                "url": it.get("collectionViewUrl") or "",
                "year": (it.get("releaseDate") or "")[:4],
                "tracks": it.get("trackCount") or 0,
            })
        else:
            res.append({
                "id": str(it.get("trackId") or ""),
                "name": it.get("trackName") or "",
                "artist": it.get("artistName") or "",
                "album": it.get("collectionName") or "",
                "art": art,
                "url": it.get("trackViewUrl") or "",
                "dur": round(float(it.get("trackTimeMillis") or 0) / 1000.0, 1),
            })
    return [x for x in res if x["name"] and x["url"]]


@app.get("/api/v1/music/search")
def music_search(term: str = "", kind: str = "album", limit: int = 24,
                 _: None = Depends(require_app)):
    """搜 Apple Music 目录里的专辑/单曲。结果里带 Apple 的页面地址，
    前端点一下就是把这个地址交给壳（UIApplication.open）打开系统「音乐」。"""
    term = (term or "").strip()
    if len(term) < 1:
        return {"ok": True, "items": []}
    kind = "song" if kind == "song" else "album"
    limit = max(1, min(40, int(limit or 24)))
    key = f"{kind}|{term.lower()}|{limit}"
    hit = _MUSIC_SEARCH_CACHE.get(key)
    if hit:
        return {"ok": True, "items": hit, "cached": True}
    items = _itunes_search(term, kind, limit)
    if len(_MUSIC_SEARCH_CACHE) > 200:
        _MUSIC_SEARCH_CACHE.clear()
    if items:
        _MUSIC_SEARCH_CACHE[key] = items
    return {"ok": True, "items": items, "cached": False}


@app.get("/api/v1/hr/link")
def hr_link(request: Request, _: None = Depends(require_app)):
    """给快捷指令用的推送地址（带 appkey）：GET 带 bpm 或 POST JSON 都行。"""
    base = str(request.base_url).rstrip("/")
    prefix = request.url.path.split("/api/")[0].rstrip("/")
    return {"ok": True, "url": f"{base}{prefix}/api/v1/hr?k={APP_KEY}",
            "path": f"api/v1/hr?k={APP_KEY}",
            "max_bpm": _hr_load().get("max_bpm") or 0}


@app.post("/api/v1/health")
@app.post("/api/v1/hr")
def hr_post(payload: dict = Body(...), _: None = Depends(require_app)):
    items = payload.get("samples")
    if not isinstance(items, list):
        items = [payload] if "bpm" in payload else []
    d = _hr_add(items, payload.get("max_bpm"))
    metrics = payload.get("metrics")
    if isinstance(metrics, dict) and metrics:
        with _hr_lock:
            d = _hr_load()
            clean = {}
            for k, v in metrics.items():
                try:
                    clean[str(k)[:32]] = round(float(v), 2)
                except Exception:
                    continue
            d["metrics"] = clean
            d["metrics_at"] = time.time()
            _hr_save(d)
    return {"ok": True, "samples": d.get("samples") or [], "updated": d.get("updated") or 0,
            "max_bpm": d.get("max_bpm") or 0, "metrics": d.get("metrics") or {}}


@app.post("/api/v1/events/hide")
def event_hide(payload: dict = Body(...), _: None = Depends(require_auth)):
    """隐藏一条系统日程（财报截止 / 美联储 / 期权到期）；手动日程请直接删除。"""
    day = str(payload.get("day") or "").strip()
    title = str(payload.get("title") or "").strip()
    if not day or not title:
        raise HTTPException(400, "缺少 day / title")
    store.hide_event(day, title)
    return {"ok": True, "events": _upcoming_events(7)}


@app.get("/api/v1/events")
def events_list(request: Request, days: int = 7):
    """关键日程（固定 + 自动 + 手动），报告 cron 与外部工具共用同一口径。"""
    require_app(request)
    return {"today": store.today_bj(), "days": days, "events": _upcoming_events(days)}




@app.get("/api/v1/hot")
def hot_board(force: bool = False, _: None = Depends(require_auth)):
    """昨日热门 / 今日热门（按涨停原因合并题材 + 与昨日对比）。

    force=1 走手动「实时刷新」：绕开本地缓存与磁盘快照，现抓上游。
    """
    try:
        return hot.payload(force=force)
    except Exception as e:
        raise HTTPException(502, f"热门板块获取失败：{e}")


@app.get("/api/v1/analysis")
def report_analysis(section: str = "", limit: int = 8, _: None = Depends(require_auth)):
    """报告里的分析原文：宏观政策 macro / 大盘行情 market / 热门板块 hot。

    一次拿齐前端要用的三段，避免隧道上多开请求；section 传了就只返回那一类。
    """
    limit = max(1, min(int(limit or 8), 20))
    brief.ensure()   # 本站自生成：没有段落就现算一段，避免永远空着
    if section:
        if section not in ("macro", "market", "hot"):
            raise HTTPException(400, "section 需为 macro/market/hot")
        return {section: store.list_sections(section, limit)}
    return {s: store.list_sections(s, limit) for s in ("macro", "market", "hot")}


@app.post("/api/v1/hot/snapshot")
def hot_snapshot(payload: dict = Body(default={}), _: None = Depends(require_auth)):
    kind = (payload or {}).get("kind") or "live"
    if kind not in ("am", "close", "live"):
        raise HTTPException(400, "kind 需为 am/close/live")
    s = hot.save(kind)
    return {"ok": True, "day": s["day"], "kind": kind, "total": s["total"],
            "at": s["fetched_at"], "text": hot.text("am")}


# ---------------- stocks ----------------
@app.get("/api/v1/stocks")
def stocks(bucket: str | None = None, _: None = Depends(require_auth)):
    return store.list_stocks(bucket)


def _fill_auto_tags(code: str) -> None:
    """后台补外网标签：快速关注先返回，不让 F10 接口拖住请求。"""
    try:
        if not store.get_stock(code):
            return
        new = tags_mod.auto_tags(code)
        if new:
            store.set_external_tags(code, new)  # 只 UPDATE 已存在的行，避免删了又被写回来
    except Exception:
        pass


@app.post("/api/v1/stocks")
def add_stock(background: BackgroundTasks, payload: dict = Body(...), _: None = Depends(require_auth)):
    code = (payload.get("code") or "").strip()
    if not code.isdigit() or len(code) != 6:
        raise HTTPException(400, "代码需为 6 位数字")
    fast = bool(payload.get("fast"))
    name = (payload.get("name") or "").strip()
    if not (fast and name):  # 搜索/热度榜带名称时跳过同步行情校验
        d = quote_service.quotes_fetch([code]).get(code)
        if not d:
            raise HTTPException(400, "取不到该代码的行情，请确认代码正确")
        name = name or d["name"]
    payload["code"] = code
    payload["name"] = name
    payload.setdefault("bucket", "watch")
    has_tags = bool(payload.get("tags"))
    if not has_tags and not fast:
        payload["tags"] = tags_mod.auto_tags(code)
    elif has_tags:
        payload["tags"] = payload["tags"][:4]
    existing = store.get_stock(code)
    if existing:  # 已存在：不改所属页，避免把持仓改成关注；空的标签不覆盖旧值
        payload.pop("bucket", None)
        if not payload.get("tags"):
            payload.pop("tags", None)
        if not payload.get("custom_tags"):
            payload.pop("custom_tags", None)
    result = store.upsert_stock(payload)
    if fast and not has_tags:
        background.add_task(_fill_auto_tags, code)
    return result


@app.get("/api/v1/stocks/{code}/external-tags")
def external_tags(code: str, _: None = Depends(require_auth)):
    """给「添加个股」弹窗预览外网 API 标签；不写库。"""
    code = code.strip()
    if not code.isdigit() or len(code) != 6:
        raise HTTPException(400, "代码需为 6 位数字")
    return {"code": code, "tags": tags_mod.auto_tags(code)}


@app.post("/api/v1/stocks/{code}/autotag")
def autotag_stock(code: str, _: None = Depends(require_auth)):
    s = store.get_stock(code)
    if not s:
        raise HTTPException(404, "个股不存在")
    # 刷新外网标签，最多 4 个；抓取失败（空结果）时保留旧标签
    new = tags_mod.auto_tags(code)
    return store.set_external_tags(code, new) if new else s


@app.patch("/api/v1/stocks/{code}")
def edit_stock(code: str, payload: dict = Body(...), _: None = Depends(require_auth)):
    if not store.get_stock(code):
        raise HTTPException(404, "个股不存在")
    return store.upsert_stock(payload, code)


@app.post("/api/v1/stocks/{code}/bucket")
def move_stock(code: str, payload: dict = Body(...), _: None = Depends(require_auth)):
    r = store.set_bucket(code, (payload.get("bucket") or "").strip())
    if not r:
        raise HTTPException(400, "bucket 需为 hold 或 watch")
    return r


@app.get("/api/v1/stocks/{code}/live-news")
def stock_live_news(code: str, hours: int = 2, name: str = "",
                    _: None = Depends(require_auth)):
    """个股详情「公司 · 消息」：只给近 N 小时（默认 2h）的实时新闻。

    不做历史记录检索（笔记 / 日报 / 更早的新闻都不查），后台每小时刷新一次。
    港股/美股没有个股级扫描，改在实时新闻库里按名称/代码匹配。
    """
    code = (code or "").strip()
    if not code.isdigit() or len(code) != 6:
        terms = [x for x in (name.strip(), code) if len(x) >= 2][:4]
        h = max(1, min(int(hours or 24), 24))
        return {"hours": h, "items": store.search_live_recent(terms, hours=h * 24, limit=12) if terms else []}
    return {"hours": max(1, min(int(hours or 2), 24)),
            "items": store.list_live_news(code, hours=hours)}


@app.get("/api/v1/etf/news/{code}")
def etf_news(code: str, name: str = "", hours: int = 24,
             _: None = Depends(require_auth)):
    """ETF「最新新闻」：近 N 小时新闻标题里，命中 ETF 名称或其前十大成分股名的消息。"""
    code = (code or "").strip()
    if not etf_mod.is_etf_code(code):
        raise HTTPException(400, "代码需为 6 位 ETF 代码")
    nm = (name or "").strip()
    if not nm:
        try:
            nm = (quote_service.quotes_fetch([code]).get(code) or {}).get("name") or ""
        except Exception:
            nm = ""
    etf_terms = []
    if nm:
        etf_terms.append(nm)
        i = nm.find("ETF")
        if i > 0:
            etf_terms.append(nm[:i + 3])
            base = nm[:i]
            # 只保留较长的指数名（沪深300/中证500/红利低波…），避免「通信」「银行」
            # 这种两字行业词把无关新闻（例如空管通信故障）也匹配进来。
            if len(base) >= 4:
                etf_terms.append(base)
    hold_terms = []
    try:
        h = quote_service.etf_holdings(code)
        for x in (h.get("stocks") or [])[:6]:
            n = str(x.get("name") or "").strip()
            if len(n) >= 2 and n not in hold_terms:
                hold_terms.append(n)
    except Exception:
        pass
    terms = list(dict.fromkeys(etf_terms + hold_terms))
    etf_set = set(etf_terms)
    items = store.search_live_recent(terms, hours=hours, limit=30)
    for it in items:
        it["match"] = "ETF" if it.get("match") in etf_set else "成分股"
    h = max(1, min(int(hours or 24), 72))
    return {"hours": h, "terms": terms[:12], "items": items}


@app.get("/api/v1/stocks/{code}/related-notes")
def stock_related_notes(code: str, _: None = Depends(require_auth)):
    """删个股前问一句：笔记里还有多少跟它相关的内容。"""
    return store.related_notes(code)


@app.delete("/api/v1/stocks/{code}")
def rm_stock(code: str, with_notes: bool = False, _: None = Depends(require_auth)):
    removed = store.delete_stock(code, with_notes=with_notes)
    return {"ok": True, "notes_removed": removed}


# ---------------- groups（兼容保留） ----------------
@app.get("/api/v1/groups")
def groups(_: None = Depends(require_auth)):
    return store.list_groups()


@app.post("/api/v1/groups")
def add_group(payload: dict = Body(...), _: None = Depends(require_auth)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "组名不能为空")
    return store.create_group(name, payload.get("color") or "#0a84ff")


@app.patch("/api/v1/groups/{gid}")
def edit_group(gid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    r = store.update_group(gid, payload.get("name"), payload.get("color"), payload.get("sort"))
    if not r:
        raise HTTPException(404, "分组不存在")
    return r


@app.delete("/api/v1/groups/{gid}")
def rm_group(gid: int, _: None = Depends(require_auth)):
    store.delete_group(gid)
    return {"ok": True}


# ---------------- notes ----------------
@app.get("/api/v1/notes")
def notes(tag: str | None = None, q: str | None = None, code: str | None = None,
          kind: str | None = None, day: str | None = None, stage: str | None = None,
          _: None = Depends(require_auth)):
    return {"items": store.list_notes(tag=tag, q=q, code=code, kind=kind, day=day, stage=stage),
            "tags": store.all_note_tags(), "days": store.note_days(),
            "today": store.today_bj()}


@app.post("/api/v1/notes")
def add_note(payload: dict = Body(...), _: None = Depends(require_auth)):
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "内容不能为空")
    # day：按某一天写批注（created_at 落到那天中午，记录页/总览页看到的就是那天）
    day = str(payload.get("day") or "").strip()[:10]
    when = f"{day} 12:00:00" if re.match(r"^\d{4}-\d{2}-\d{2}$", day) else None
    return store.add_note(content, payload.get("tags") or [], payload.get("stock_code"),
                          payload.get("kind") or "idea", when=when,
                          stage=(payload.get("stage") or "idea"))


@app.patch("/api/v1/notes/{nid}")
def edit_note(nid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    r = store.update_note(nid, payload.get("content"), payload.get("tags"),
                          payload.get("pinned"), payload.get("stock_code"), payload.get("kind"),
                          payload.get("answer"), payload.get("memo"), payload.get("stage"))
    if not r:
        raise HTTPException(404, "笔记不存在")
    return r


@app.delete("/api/v1/notes/{nid}")
def rm_note(nid: int, _: None = Depends(require_auth)):
    store.delete_note(nid)
    return {"ok": True}


# ---------------- 新闻总结（记录·新闻 → 总结；每天 08:00/20:00 各一张） ----------------
@app.get("/api/v1/digest")
def digests(frm: str | None = None, to: str | None = None, limit: int = 60,
            _: None = Depends(require_auth)):
    # 首屏只取 10 张（loadDigests 默认），打开总结面板再取全量；total 始终是真实总数
    limit = max(1, min(int(limit or 60), 200))
    return {"items": store.list_digests(frm, to, limit=limit),
            "total": store.count_digests(frm, to), "today": store.today_bj()}


@app.post("/api/v1/digest")
def save_digest(payload: dict = Body(...), _: None = Depends(require_auth)):
    content = (payload.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "内容不能为空")
    day = (payload.get("day") or store.today_bj()).strip()[:10]
    slot = (payload.get("slot") or "am").strip().lower()
    if slot not in store.DIGEST_SLOTS:
        raise HTTPException(400, "slot 只能是 am 或 pm")
    row = store.upsert_digest(
        day, content, payload.get("total") or 0, slot,
        (payload.get("window_start") or "").strip(),
        (payload.get("window_end") or "").strip(),
    )
    # 总结一入库就在后台预生成「重点」语音，用户打开时通常已经能直接播
    try:
        digest_tts.warm_async(day, slot, "key")
    except Exception as e:
        log.warning("digest tts warm failed: %s", e)
    return row


# ---------------- 新闻总结语音朗读（Edge 神经语音，缓存到 data/tts） ----------------
@app.get("/api/v1/digest/tts/status")
def digest_tts_status(day: str, slot: str = "am", scope: str = "key",
                      _: None = Depends(require_auth)):
    try:
        return digest_tts.status(day.strip()[:10], slot, scope)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/v1/digest/tts")
def digest_tts_start(payload: dict = Body(...), _: None = Depends(require_auth)):
    day = str(payload.get("day") or "").strip()[:10]
    slot = str(payload.get("slot") or "am").strip().lower()
    scope = str(payload.get("scope") or "key").strip().lower()
    try:
        return digest_tts.ensure(day, slot, scope)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/v1/digest/tts/file")
def digest_tts_file(day: str, slot: str = "am", scope: str = "key",
                    _: None = Depends(require_auth)):
    try:
        path = digest_tts.cache_file(day.strip()[:10], slot, scope)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not path:
        # 音频元素会先请求这个地址：没生成时给 409，前端据此转去轮询生成进度
        return JSONResponse({"error": "语音还没生成", "generating": True}, status_code=409,
                            headers={"Cache-Control": "no-store"})
    return FileResponse(path, media_type="audio/mpeg",
                        headers={"Cache-Control": "private, no-cache"})


@app.delete("/api/v1/digest/{day}")
def rm_digest(day: str, slot: str | None = None, _: None = Depends(require_auth)):
    return {"ok": store.delete_digest(day, slot)}


# ---------------- 新闻总结标注（标红 / 下划线 / 批注） ----------------
@app.get("/api/v1/digest/marks")
def digest_marks(frm: str | None = None, to: str | None = None, q: str | None = None,
                 limit: int = 500, _: None = Depends(require_auth)):
    return {"items": store.list_digest_marks(frm, to, q=q, limit=limit)}


@app.post("/api/v1/digest/marks")
def add_digest_mark(payload: dict = Body(...), _: None = Depends(require_auth)):
    day = str(payload.get("day") or "").strip()[:10]
    slot = str(payload.get("slot") or "am").strip().lower()
    block = str(payload.get("block") or "").strip()
    quote = str(payload.get("quote") or "").strip()
    style = str(payload.get("style") or "red").strip().lower()
    note = str(payload.get("note") or "").strip()
    if not day or len(day) != 10:
        raise HTTPException(400, "day 格式不对")
    if slot not in store.DIGEST_SLOTS:
        raise HTTPException(400, "slot 只能是 am 或 pm")
    if not block or len(block) > 32 or not re.fullmatch(r"lead|s\d+i\d+", block):
        raise HTTPException(400, "block 格式不对")
    if not quote or len(quote) > 2000:
        raise HTTPException(400, "选中的文字为空或太长")
    if style not in store.DIGEST_MARK_STYLES:
        raise HTTPException(400, "style 只能是 red / underline / note")
    if len(note) > 2000:
        raise HTTPException(400, "批注太长")
    try:
        start_off = int(payload.get("start_off"))
        end_off = int(payload.get("end_off"))
    except (TypeError, ValueError):
        raise HTTPException(400, "位置参数不对")
    if start_off < 0 or end_off <= start_off:
        raise HTTPException(400, "位置参数不对")
    try:
        return store.add_digest_mark(day, slot, block, start_off, end_off, quote, style, note)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.patch("/api/v1/digest/marks/{mid}")
def edit_digest_mark(mid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    style = payload.get("style")
    note = payload.get("note")
    if style is not None:
        style = str(style)
    if note is not None:
        note = str(note)
    if note is not None and len(note) > 2000:
        raise HTTPException(400, "批注太长")
    try:
        row = store.update_digest_mark(mid, style=style, note=note)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not row:
        raise HTTPException(404, "标注不存在")
    return row


@app.delete("/api/v1/digest/marks/{mid}")
def rm_digest_mark(mid: int, _: None = Depends(require_auth)):
    return {"ok": store.delete_digest_mark(mid)}


# ---------------- reports ----------------
@app.get("/api/v1/reports")
def reports(kind: str | None = None, _: None = Depends(require_auth)):
    return store.list_reports(kind)


@app.get("/api/v1/reports/{rid}")
def report(rid: int, _: None = Depends(require_auth)):
    r = store.get_report(rid)
    if not r:
        raise HTTPException(404, "报告不存在")
    return r


@app.post("/api/v1/reports/sync")
def sync(_: None = Depends(require_auth)):
    return {"imported": store.sync_reports(), "news": store.extract_news()}


# ---------------- news ----------------
@app.get("/api/v1/news")
def news(day: str | None = None, start: str | None = None, end: str | None = None,
         _: None = Depends(require_auth)):
    return {"items": store.list_news(day, start=start, end=end), "days": store.news_days()}


_AUTO_READ = {"day": ""}


def _auto_read_old_news() -> None:
    """每天首次进收件箱/查未读数时，把「昨天及更早」的资讯自动标已读。

    只在本进程每天跑一次，不额外扫表；跨天时下一次请求自然触发。
    """
    day = store.now_bj()[:10]
    if _AUTO_READ.get("day") == day:
        return
    try:
        n = store.mark_read_before(day)
    except Exception:
        log.exception("自动已读旧资讯失败")
        return
    _AUTO_READ["day"] = day
    if n:
        log.info("跨天自动已读：%s 之前 %s 条", day, n)


@app.get("/api/v1/news/inbox")
def news_inbox(page: int = 1, size: int = 50, max_id: int | None = None, only: str = "unread",
               level: str | None = None, _: None = Depends(require_auth)):
    """新闻收件箱：only=unread 从新到旧分页（max_id 冻结本次会话，level=A/B/C 筛级别），
    only=read 回看近 24h。"""
    _auto_read_old_news()
    return store.news_inbox(page=page, size=size, max_id=max_id,
                            only=only if only in ("read", "all") else "unread", level=level)


@app.get("/api/v1/news/unread-count")
def news_unread_count(max_id: int | None = None, _: None = Depends(require_auth)):
    _auto_read_old_news()
    return store.unread_newer(max_id)


@app.post("/api/v1/news/read")
def news_mark_read(payload: dict = Body(...), _: None = Depends(require_auth)):
    ids = payload.get("ids") or ([payload["id"]] if payload.get("id") else [])
    return {"ok": True, "read": store.mark_news_read(ids),
            **store.unread_newer(payload.get("max_id"))}


@app.post("/api/v1/news/read-pages")
def news_mark_pages(payload: dict = Body(...), _: None = Depends(require_auth)):
    """按页标已读：pages=[1,2,3]，可多页一次提交（页面顺序与会话边界同收件箱）。"""
    r = store.mark_pages_read(payload.get("pages") or [], size=payload.get("size") or 50,
                              max_id=payload.get("max_id"), level=payload.get("level"))
    return {"ok": True, **r, **store.unread_newer(payload.get("max_id"))}


@app.get("/api/v1/news/saved")
def saved_news(limit: int = 500, _: None = Depends(require_auth)):
    """收藏夹列表（点「收藏夹」标签时才拉，不等同于需关注）。"""
    limit = max(1, min(int(limit or 500), 500))
    return {"items": store.list_saved(limit), "count": store.count_saved()}


@app.get("/api/v1/news/search")
def news_search(q: str = "", limit: int = 500, _: None = Depends(require_auth)):
    """实时新闻/需关注/报告抽取的全库搜索。"""
    q = (q or "").strip()
    if not q:
        return {"items": [], "q": q}
    limit = max(1, min(int(limit or 500), 500))
    items = store.search_news(q, limit)
    return {"items": items, "q": q, "count": len(items)}


@app.get("/api/v1/news/{nid}")
def news_detail(nid: int, _: None = Depends(require_auth)):
    """新闻总结里的「来源」点击后取原文。"""
    r = store.get_news(nid)
    if not r:
        raise HTTPException(404, "原文已删除")
    return r


@app.get("/api/v1/live")
def live(limit: int = 80, day: str | None = None, start: str | None = None,
         end: str | None = None, before: str | None = None, before_id: int | None = None,
         _: None = Depends(require_auth)):
    limit = max(1, min(int(limit or 80), 500))
    # 多取一条判断还有没有下一页；前端每次只拿一页，点「查看更多」再翻
    rows = store.list_live(limit + 1, day=day, start=start, end=end,
                           before=before, before_id=before_id)
    stats = store.live_stats(day=day, start=start, end=end)
    return {"items": rows[:limit], "has_more": len(rows) > limit,
            "total": stats["total"], "stats": stats,
            "updated_at": store.last_live_at(),
            "days": store.live_days(10), "day": day or store.today_bj()}


@app.get("/api/v1/stream/quote/{code}")
async def stream_quote(code: str, request: Request, _: None = Depends(require_auth)):
    """SSE：打开个股弹层时每 3 秒推一次报价；前端失败会自动退回轮询。"""
    # 港美没有 A 股那样的 3 秒快照节奏，推一条就结束，别让前端挂一条空流
    global_code = not (code.isdigit() and len(code) == 6)

    async def gen():
        while True:
            if await request.is_disconnected():
                break
            try:
                q = (await asyncio.to_thread(quotes.fetch, [code])).get(code) or {}
            except Exception:
                q = {}
            yield "data: " + json.dumps({"code": code, "quote": q}, ensure_ascii=False) + "\n\n"
            # 盘中 3 秒（与 Level-1 快照同步）；收盘/午休推完这一条就结束，前端别再空转
            st = quotes.market_status()["state"]
            if global_code or st not in ("open", "pre"):
                break
            await asyncio.sleep(3)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


@app.get("/api/v1/live/alerts")
def live_alerts(after: int = 0, limit: int = 20, _: None = Depends(require_auth)):
    """通知功能已停用（2026-10-31）。

    旧版 APK 仍可能每 60 秒轮询这个地址；保留空接口是为了让它安静下来，
    而不是一直收到 404。恢复通知功能时：取消下面注释，并删掉最后的 return。
    """
    # limit = max(1, min(int(limit or 20), 50))
    # max_id = store.max_alert_id()
    # if after < 0 or after > max_id:  # 初始化 / 数据库回档：只回游标，不补发
    #     return {"items": [], "last_id": max_id}
    # items = store.list_alerts(after, limit)
    # return {"items": items, "last_id": items[-1]["id"] if items else after}
    return {"items": [], "last_id": store.max_alert_id()}


@app.post("/api/v1/live/refresh")
async def live_refresh(_: None = Depends(require_auth)):
    r = await asyncio.to_thread(livefeed.refresh)
    return dict(r, items=store.list_live(80), updated_at=store.last_live_at())


# ---------------- 个股红标（新闻/公告 → 标红 → 读过恢复） ----------------
_EM_NOTICE_RE = re.compile(r"data\.eastmoney\.com/notices/detail/[\w./-]+/(AN\d+)\.html", re.I)
_EM_NOTICE_API = "https://np-cnotice-stock.eastmoney.com/api/content/ann"
_em_notice_cache: dict[str, tuple[float, dict]] = {}
_em_notice_lock = threading.Lock()


def _eastmoney_notice(url: str) -> dict | None:
    """从东财公告详情 URL 取全文（只允许 data.eastmoney.com 的公告链接）。"""
    m = _EM_NOTICE_RE.search(url or "")
    if not m:
        return None
    code = m.group(1)
    now = time.time()
    with _em_notice_lock:
        hit = _em_notice_cache.get(code)
        if hit and now - hit[0] < 600:
            return hit[1]
    parts: list[str] = []
    title = ""
    notice_date = ""
    try:
        with requests.Session() as s:
            for page in range(1, 7):
                r = s.get(_EM_NOTICE_API, params={
                    "art_code": code, "client_source": "web", "page_index": str(page),
                }, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"},
                   timeout=10)
                data = (r.json() or {}).get("data") or {}
                if not data:
                    break
                title = title or (data.get("notice_title") or "")
                notice_date = notice_date or (data.get("notice_date") or "")
                body = (data.get("notice_content") or "").strip()
                if body:
                    parts.append(body)
                if page >= int(data.get("page_size") or 1):
                    break
    except Exception:
        return None
    content = "\n".join(parts).strip()
    if not content:
        return None
    out = {"title": title, "content": content[:30000], "date": notice_date,
           "truncated": len(content) > 30000}
    with _em_notice_lock:
        _em_notice_cache[code] = (now, out)
    return out


@app.get("/api/v1/flags/{fid}/preview")
def flag_preview(fid: int, _: None = Depends(require_auth)):
    """红标全文预览：公告抓东财正文，新闻回查新闻库，笔记取笔记正文。不跳转外站。"""
    f = store.get_flag(fid)
    if not f:
        raise HTTPException(404, "消息不存在")
    title = f["title"]
    kind = f["kind"] or "news"
    content = ""
    has_full = False
    date = ""
    if kind == "note":
        body = store.note_content_by_ref(f.get("ref") or "")
        if body:
            content, has_full = body, True
    elif kind == "news":
        n = store.live_news_by_prefix(f["title"])
        if n:
            content, has_full = n["title"], True
            date = n.get("published_at") or ""
    elif f.get("url"):
        em = _eastmoney_notice(f["url"])
        if em:
            title = em.get("title") or title
            content, has_full = em["content"], True
            date = em.get("date") or ""
    return {
        "id": fid, "code": f["code"], "title": title, "content": content,
        "has_full": has_full, "kind": kind, "source": f["source"], "url": f["url"],
        "published_at": f["published_at"], "date": date,
    }


@app.get("/api/v1/flags")
def get_flags(code: str | None = None, unread: bool = True, _: None = Depends(require_auth)):
    return {"items": store.list_flags(code=code, unread_only=unread), "summary": store.flag_summary()}


@app.delete("/api/v1/flags/{fid}")
def rm_flag(fid: int, _: None = Depends(require_auth)):
    if not store.delete_flag(fid):
        raise HTTPException(404, "消息不存在")
    return {"ok": True, "summary": store.flag_summary()}


@app.post("/api/v1/flags")
def push_flags(payload: dict = Body(...), _: None = Depends(require_app)):
    """定时任务/脚本推送个股新闻或公告：{code,title,kind,source,url,published_at} 或 {items:[...]}。"""
    items = payload.get("items")
    if not isinstance(items, list):
        items = [payload]
    n = store.flag_push(items)
    return {"ok": True, "added": n, "summary": store.flag_summary()}


@app.post("/api/v1/flags/read")
def read_flags(payload: dict = Body(default={}), _: None = Depends(require_app)):
    payload = payload or {}
    n = store.flag_mark_read(codes=payload.get("codes") or [], ids=payload.get("ids") or [])
    return {"ok": True, "read": n, "summary": store.flag_summary()}


@app.post("/api/v1/events/parse")
def events_parse(payload: dict = Body(...), _: None = Depends(require_auth)):
    """把一段话里的「日期 + 标的」拆成多条日程（只解析，不写库）。"""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "先粘贴一段话")
    from datetime import date
    import event_parse
    items = event_parse.parse(text, date.fromisoformat(store.today_bj()))
    return {"items": items, "tags": event_parse.TAGS}


@app.post("/api/v1/news")
def add_news(payload: dict = Body(...), _: None = Depends(require_auth)):
    title = (payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "标题不能为空")
    return store.add_news(payload.get("day") or store.today_bj(),
                          payload.get("category") or "市场", title,
                          payload.get("body") or "", int(payload.get("weight") or 5),
                          payload.get("source") or "manual",
                          tag=(payload.get("tag") or "").strip())


@app.patch("/api/v1/news/{nid}")
def edit_news(nid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    """编辑需关注条目 / 日程 / 收藏新闻的笔记（memo）。只能改这几个字段。"""
    body = payload or {}
    if not any(k in body for k in ("day", "category", "title", "body", "memo", "tag", "stock_code")):
        raise HTTPException(400, "没有可更新的字段")
    item = store.update_news(nid, body)
    if not item:
        raise HTTPException(404, "条目不存在")
    return {"ok": True, "item": item}


@app.post("/api/v1/tags/rename")
def rename_tag(payload: dict = Body(...), _: None = Depends(require_auth)):
    old = str(payload.get("old") or "").strip()
    new = str(payload.get("new") or "").strip()
    if not old:
        raise HTTPException(400, "标签名不能为空")
    if len(new) > 20:
        raise HTTPException(400, "标签名最多 20 个字")
    r = store.rename_tag(old, new)
    if not new:                     # 删除标签：顺手把它从标签条顺序里摘掉
        for b in ("hold", "watch"):
            order = [t for t in store.get_tag_order(b) if t != old]
            store.set_tag_order(b, order)
    return r


@app.post("/api/v1/news/{nid}/save")
def save_news(nid: int, payload: dict = Body(...), _: None = Depends(require_auth)):
    r = store.toggle_save(nid, int(payload.get("saved", 1)))
    if not r:
        raise HTTPException(404, "条目不存在")
    if r.get("saved"):
        store.mark_news_read([nid])   # 收藏即视为已读，收件箱里也消失
    return r


@app.delete("/api/v1/news/{nid}")
def rm_news(nid: int, _: None = Depends(require_auth)):
    store.delete_news(nid)
    return {"ok": True}


# ---------------- 多选删除 ----------------
@app.post("/api/v1/bulk-delete")
def bulk_delete(payload: dict = Body(...), _: None = Depends(require_auth)):
    kind = payload.get("kind") or ""
    ids = payload.get("ids") or []
    if kind not in ("stock", "note", "news"):
        raise HTTPException(400, "类型不对")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "没有选中条目")
    if len(ids) > 500:
        raise HTTPException(400, "一次最多删除 500 项")
    r = store.bulk_delete(kind, ids, with_notes=bool(payload.get("with_notes")))
    return {"ok": True, **r}


# ---------------- 回收站 ----------------
@app.get("/api/v1/trash")
def trash_list(_: None = Depends(require_auth)):
    return {"items": store.list_trash(), "days": store.TRASH_DAYS}


@app.post("/api/v1/trash/{tid}/restore")
def trash_restore(tid: int, _: None = Depends(require_auth)):
    r = store.restore_trash(tid)
    if not r:
        raise HTTPException(404, "回收站里没有这一项")
    return r


@app.delete("/api/v1/trash/{tid}")
def trash_drop(tid: int, _: None = Depends(require_auth)):
    if not store.drop_trash(tid):
        raise HTTPException(404, "回收站里没有这一项")
    return {"ok": True}


@app.delete("/api/v1/trash")
def trash_clear(_: None = Depends(require_auth)):
    return {"ok": True, "removed": store.clear_trash()}


# ---------------- static ----------------
class _CachedStatic(StaticFiles):
    """静态资源带 ?v=内容哈希：可以直接长缓存；没带版本号的走协商缓存，改了立刻生效。"""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if "v=" in scope.get("query_string", b"").decode("latin-1"):
            resp.headers["cache-control"] = "public, max-age=31536000, immutable"
        else:
            resp.headers["cache-control"] = "no-cache"
        return resp


app.mount("/static", _CachedStatic(directory=STATIC), name="static")

_index_cache: dict[str, object] = {"sig": (), "html": ""}
_index_lock = threading.Lock()

# 前端分区（顺序必须与 index.html 里的 script 顺序一致）。
# 版本号统一取「所有分区内容哈希的哈希」：任一分区改了，整包版本就变，客户端会整组换新。
APP_PARTS = ("app-base.js", "app-detail.js", "app-note.js", "app-tag.js",
             "app-trend.js", "app-chart.js", "app-work.js", "app-standby.js", "app-boot.js")


def _app_digest() -> str:
    h = hashlib.sha1()
    for name in APP_PARTS:
        try:
            h.update((STATIC / name).read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:10]


def _style_digest() -> str:
    try:
        return hashlib.sha1((STATIC / "style.css").read_bytes()).hexdigest()[:10]
    except OSError:
        return ""


def _render_index() -> str:
    """把 index.html 里的 ?v=0 换成静态文件内容哈希，改完前端不用再手工 bump。"""
    src = STATIC / "index.html"
    assets = [STATIC / n for n in (*APP_PARTS, "style.css")]
    try:
        sig = tuple((p.stat().st_mtime_ns, p.stat().st_size) if p.exists() else (0, 0)
                    for p in [src, *assets])
        if _index_cache["sig"] == sig and _index_cache["html"]:
            return str(_index_cache["html"])
        html = src.read_text(encoding="utf-8")
        app_ver = _app_digest()
        for name in APP_PARTS:
            html = re.sub(rf"({re.escape(name)}\?v=)[\w.-]+", rf"\g<1>{app_ver}", html)
        html = re.sub(r"(style\.css\?v=)[\w.-]+", rf"\g<1>{_style_digest()}", html)
        _index_cache.update(sig=sig, html=html)
        return html
    except OSError:
        return src.read_text(encoding="utf-8")


def _trend_key(it):
    """报告期排序键：'Q3 FY2026' → 20263（兼容 '2026Q3' / '2026-09-30'）。"""
    s = str((it or {}).get("period") or "").strip()
    m = re.search(r"Q([1-4])\s*FY\s*(\d{4})", s, re.I)
    if m:
        return int(m.group(2)) * 10 + int(m.group(1))
    m = re.search(r"(\d{4})\s*Q([1-4])", s, re.I)
    if m:
        return int(m.group(1)) * 10 + int(m.group(2))
    m = re.match(r"(\d{4})-(\d{2})", s)
    if m:
        return int(m.group(1)) * 10 + max(1, min(4, (int(m.group(2)) - 1) // 3 + 1))
    return 0


@app.get("/api/v1/wind/fundamentals")
def wind_fundamentals(code: str = ""):
    """个股基本面（Wind 预取结果，只读缓存，不发新请求、不耗积分）。
    数据由 scripts/wind_brief.py 在每次报告前预取，落在 data/wind_cache.db 的
    wind_metrics 表；没有就返回 ok=false，前端显示“暂无”。
    """
    code = (code or "").strip()
    if not (len(code) == 6 and code.isdigit()):
        return JSONResponse({"ok": False, "reason": "bad_code"}, status_code=400)
    db = BASE / "data" / "wind_cache.db"
    if not db.exists():
        return JSONResponse({"ok": False, "reason": "no_data"}, headers={"Cache-Control": "no-store"})
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        row = con.execute(
            "SELECT code,name,metrics,source_time,ts FROM wind_metrics "
            "WHERE code=? OR code LIKE ? ORDER BY ts DESC LIMIT 1",
            (code, f"{code}.%"),
        ).fetchone()
        con.close()
    except Exception:
        return JSONResponse({"ok": False, "reason": "no_data"}, headers={"Cache-Control": "no-store"})
    if not row:
        return JSONResponse({"ok": False, "reason": "no_data"}, headers={"Cache-Control": "no-store"})

    wcode, name, raw, fetched_at, ts = row
    try:
        tables = json.loads(raw or "[]")
    except Exception:
        tables = []

    def find(keys):
        for t in tables:
            for k, v in (t or {}).items():
                if any(x in k for x in keys) and v not in (None, "", "None%", "None"):
                    return v
        return None

    pe = find(["市盈率PE_TTM", "市盈率PE", "PE_TTM"])
    pb = find(["市净率PB_LF", "市净率PB"])
    roe = find(["净资产收益率ROE"])
    rev = find(["营业收入同比增长率", "营收同比增长率"])
    npy = find(["净利润同比增长率"])
    holders = find(["前十大流通股东持股比例合计"])
    period = find(["日期", "报告期", "交易时间"])
    payload = {
        "ok": True, "code": wcode, "name": name,
        "pe": pe, "pb": pb, "roe": roe, "rev_yoy": rev, "np_yoy": npy,
        "holders": holders, "period": period, "fetched_at": fetched_at,
    }

    # 追加：技术面 / 财务多期 / 前十大股东（同样只读预取缓存）
    try:
        import sqlite3
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        def kv(key):
            r = con.execute("SELECT payload FROM wind_cache WHERE k=?", (key,)).fetchone()
            if not r:
                return None
            try:
                return json.loads(r[0])
            except Exception:
                return None
        payload["tech"] = kv(f"tech:{wcode}")
        tr = kv(f"trend:{wcode}")
        if tr and tr.get("series"):
            # 报告期统一倒序（最新一期在最前）：老缓存里是「旧 → 新」，页面把第一条当最新一期用
            tr["series"] = sorted(tr["series"], key=_trend_key, reverse=True)
        payload["trend"] = tr
        payload["top10"] = (kv(f"holders:{wcode}") or {}).get("top10")
        con.close()
    except Exception:
        payload.setdefault("tech", None)
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.get("/api/v1/assetver")
def assetver():
    """前端资源版本（内容哈希）：前端启动时比对，发现手机上缓存的是旧版就自动刷新一次。
    拆分后 app 是一组文件，这里返回的是整包合并哈希，和 index.html 注入的版本号同源。"""
    return JSONResponse({"app": _app_digest(), "style": _style_digest()},
                        headers={"Cache-Control": "no-store"})


@app.get("/")
def index(k: str | None = None):
    """带上正确的 k 参数（APK 内嵌）即自动登录 365 天，无需输入密码。"""
    r = HTMLResponse(content=_render_index(), headers={"Cache-Control": "no-cache"})
    if k and hmac.compare_digest(k.strip(), APP_KEY):
        exp = int(time.time()) + APP_TTL
        r.set_cookie("sk", _sign(exp), max_age=APP_TTL, httponly=True, samesite="lax", path="/stocks")
    return r


@app.exception_handler(HTTPException)
def http_err(request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# ---------------- 行情缓存预热 ----------------
# 开盘时段每 45 秒在后台把涨跌家数/全球指数/期货刷新一遍，
# 用户打开行情页时读到的就是热缓存（冷启动原来要 9 秒，预热后 <1 秒）。
def _warm_market_loop() -> None:
    time.sleep(8)                      # 等 uvicorn 起来
    while True:
        try:
            st = quotes.market_status() or {}
            if st.get("state") in ("open", "pre", "lunch"):
                quote_service.market_all(False)
                time.sleep(45)
            else:
                time.sleep(150)
        except Exception as e:         # 预热失败不影响主服务
            log.warning("行情预热失败：%s", e)
            time.sleep(120)


def _start_warm_market() -> None:
    if os.environ.get("STOCK_NO_WARM") == "1":
        return
    t = threading.Thread(target=_warm_market_loop, name="market-warm", daemon=True)
    t.start()


_start_warm_market()


@app.get("/api/v1/dca/plan")
def dca_plan(_: None = Depends(require_auth)):
    """每日定投的「今天会不会真的买」：按交易日 / 申购状态 / 限额算出生效金额。

    - 非交易日（周末、节假日）一律不计，只有交易日才投；
    - 基金「暂停申购」当天跳过；
    - 「限大额」按单日申购上限截断（拿不到上限就照原额度，标注未知）；
    - 场内股票/ETF 无申购限制，只受交易日约束。
    """
    from datetime import datetime as _dt
    today = _dt.now(quotes.BJ).strftime("%Y-%m-%d")
    trading = bool(quotes.is_trading_day(today))
    items = []
    total = 0.0
    effective = 0.0
    for st in store.list_stocks():
        if st.get("bucket") != "hold":
            continue
        dca = float(st.get("dca") or 0)
        if dca <= 0:
            continue
        code = st["code"]
        total += dca
        item = {"code": code, "name": st.get("name") or code, "dca": round(dca, 2),
                "effective": 0.0, "status": "ok", "limit": None, "note": "", "sgzt": ""}
        # 申购状态/单日上限先查：休市日也要把「限额」告诉前端，卡片上一直能看到
        prof = {}
        try:
            prof = quote_service.fund_profile(code)
        except Exception:
            prof = {}
        sgzt = (prof.get("sgzt") or "") if prof.get("ok") else ""
        limit = prof.get("maxsg") if prof.get("ok") else None
        item["sgzt"] = sgzt
        if limit and float(limit or 0) > 0:
            item["limit"] = round(float(limit), 2)
        if not trading:
            item["status"] = "closed"
            item["note"] = "今日休市不计"
            items.append(item)
            continue
        if "暂停" in sgzt or "停止" in sgzt:
            item["status"] = "paused"
            item["note"] = f"{sgzt}，今日跳过"
        elif "限大额" in sgzt or "限额" in sgzt:
            item["status"] = "limited"
            if limit and limit > 0:
                item["limit"] = round(float(limit), 2)
                amt = min(dca, float(limit))
                item["effective"] = round(amt, 2)
                item["note"] = (f"限大额，单日上限 {limit:g} 元"
                                + ("" if amt >= dca else f"，按 {amt:g} 元投"))
            else:
                item["effective"] = round(dca, 2)
                item["note"] = "限大额，上限未知，按设定额度投"
        else:
            item["effective"] = round(dca, 2)
            item["note"] = sgzt or "正常申购"
        effective += item["effective"]
        items.append(item)
    return {"date": today, "trading_day": trading, "total": round(total, 2),
            "effective_total": round(effective, 2), "items": items}
