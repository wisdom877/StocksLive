"""统一行情读取层：TTL 一处登记、stale 统一标记、刷新单飞。

背景：quotes / market / kline / etf / fund 各自维护缓存与 TTL（2.5s / 60s / 300s / 600s），
口径漂移会直接体现在「同一只票不同页面刷新节奏不一致」和趋势预筛与判定打架上。
2026-11-25 起已从「只服务 watch_summary」升级为唯一读取入口：quotes 快照/单票、
market 全市场与全球指数、kline、基金档案/持仓、ETF 成分全部走 read()，
app.py 里不再有直连 quotes/market/kline/etf 的行情调用。每一层做四件事：

1. TTL 登记表 —— 所有缓存时效从这里取，新增数据源不再散落魔法数字；
2. SWR 缓存 —— 先返回上次结果（带 stale 标记），刷新丢后台线程，首屏不再等上游；
3. 单飞 —— 同一时刻只允许一个刷新任务，避免轮询把上游打穿；
4. 降级顺序 —— 主源空/异常时按 backups 链依次回退，返回体统一带 stale / age /
   fallback，前端只需要认这三个字段，不用关心下面是哪家上游。
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

import logging

log = logging.getLogger("stock-site.quotes")

# 唯一的时效口径表（秒）。旧模块里的常量按这张表对齐。
TTL: dict[str, float] = {
    "quote": 2.5,          # 实时快照（盘中）
    "market": 60.0,        # 全球指数 / 期货等扩展行情
    "breadth": 300.0,      # 涨跌家数
    "extra": 60.0,         # 商品 / 板块补充
    "fund": 600.0,         # 场外基金净值（一天一更）
    "kline": 300.0,        # K 线
    "watch_summary": 15.0,  # 手表快照
    "board": 2.0,           # 持仓 / 关注列表
    "market_global": 60.0,   # 全球指数 / 商品
    "fund_profile": 1800.0,  # 基金档案 + 净值历史（半小时）
    "fund_position": 43200.0,  # 基金季报持仓（半天）
    "etf_holdings": 3600.0,  # ETF 成分（本地库）
}

# 超过这个年龄的旧数据一律不再返回（宁可报错也不要给出错得离谱的价）
DEFAULT_STALE_MAX = 900.0


def ttl_of(kind: str, default: float = 60.0) -> float:
    return float(TTL.get(kind, default))


class SWR:
    """stale-while-revalidate 缓存：命中即回、过期先回旧的、后台单飞刷新。"""

    __slots__ = ("name", "ttl", "stale_max", "_data", "_ts", "_lk", "_fly")

    def __init__(self, name: str, ttl: float | None = None, stale_max: float | None = None):
        self.name = name
        self.ttl = float(ttl if ttl is not None else ttl_of(name))
        self.stale_max = float(stale_max if stale_max is not None else DEFAULT_STALE_MAX)
        self._data: Any = None
        self._ts = 0.0
        self._lk = threading.Lock()
        self._fly = threading.Lock()

    def get(self, build: Callable[[], Any]) -> tuple[Any, bool, float]:
        """返回 (数据, 是否 stale, 数据年龄秒)。从没算过时同步算一次。"""
        age = time.time() - self._ts
        with self._lk:
            data = self._data
        if data is not None and age < self.ttl:
            return data, False, age
        if data is not None and age <= self.stale_max:
            self._kick(build)
            return data, True, age
        fresh = self._compute(build)
        if fresh is not None:
            return fresh, False, 0.0
        return (data, True, age) if data is not None else (None, True, age)

    def store(self, data: Any) -> None:
        with self._lk:
            self._data, self._ts = data, time.time()

    def peek(self) -> tuple[Any, float]:
        with self._lk:
            return self._data, (time.time() - self._ts if self._data is not None else -1.0)

    def _kick(self, build: Callable[[], Any]) -> None:
        if not self._fly.acquire(blocking=False):
            return          # 已有刷新在跑，直接吃旧数据
        def _run() -> None:
            try:
                self._compute(build)
            finally:
                self._fly.release()
        threading.Thread(target=_run, daemon=True, name=f"swr-{self.name}").start()

    def _compute(self, build: Callable[[], Any]) -> Any:
        try:
            data = build()
        except Exception as e:            # 上游挂了不影响返回旧数据
            log.warning("swr[%s] 刷新失败：%s", self.name, e)
            return None
        if data is None:
            return None
        with self._lk:
            self._data, self._ts = data, time.time()
        return data


_registry: dict[str, SWR] = {}
_registry_lk = threading.Lock()


def swr(name: str, build: Callable[[], Any], ttl: float | None = None,
        stale_max: float | None = None) -> tuple[Any, bool, float]:
    """按名字取一个全局 SWR 实例并取值，调用方不必自己持有对象。"""
    with _registry_lk:
        box = _registry.get(name)
        if box is None:
            box = _registry[name] = SWR(name, ttl, stale_max)
    return box.get(build)


def warm(name: str, build: Callable[[], Any], delay: float = 3.0) -> None:
    """进程启动后在后台预热一次，别让第一个用户替所有人等上游。"""
    def _run() -> None:
        time.sleep(delay)
        try:
            swr(name, build)
        except Exception as e:
            log.warning("预热 %s 失败：%s", name, e)
    threading.Thread(target=_run, daemon=True, name=f"warm-{name}").start()

# ---------------- 统一读取门面 ----------------
# 所有行情读取都从这里走：TTL 取 TTL 表、失败先回旧值、payload 统一带 stale/age。
# 上层模块（quotes / market / kline / etf / fund）继续管自己的上游顺序与解析，
# 这里只管「多久算旧、旧了怎么给、给不出来能不能退到备用源」。

import quotes
import market
import kline as kline_mod
import etf as etf_mod


def _box(kind: str, key: str, ttl: float | None = None, stale_max: float | None = None) -> SWR:
    name = f"{kind}:{key}"
    with _registry_lk:
        box = _registry.get(name)
        if box is None:
            box = _registry[name] = SWR(name, ttl if ttl is not None else ttl_of(kind), stale_max)
        return box


def _tag(payload: Any, stale: bool, age: float, source: str = "") -> Any:
    if isinstance(payload, dict):
        payload["stale"] = bool(stale)
        payload["age"] = round(age, 1) if age >= 0 else None
        if source:
            payload["source"] = payload.get("source") or source
    return payload


def _empty(v: Any) -> bool:
    return v is None or (isinstance(v, dict) and not v) or (isinstance(v, list) and not v)


def read(kind: str, key: str, build: Callable[[], Any], ttl: float | None = None,
         stale_max: float | None = None, force: bool = False,
         backups: list[tuple[str, Callable[[], Any]]] | None = None) -> tuple[Any, bool, float]:
    """统一读取：force 直算并写回；否则 SWR；主源空/异常时按 backups 顺序降级。"""
    box = _box(kind, key, ttl, stale_max)

    def _with_fallback() -> Any:
        try:
            d = build()
        except Exception as e:
            log.warning("read[%s:%s] 主源失败：%s", kind, key, e)
            d = None
        if not _empty(d):
            return d
        for name, fn in backups or []:
            try:
                d2 = fn()
            except Exception as e:
                log.warning("read[%s:%s] 备用源 %s 失败：%s", kind, key, name, e)
                continue
            if not _empty(d2):
                log.info("read[%s:%s] 用备用源 %s", kind, key, name)
                if isinstance(d2, dict):
                    d2.setdefault("source", name)
                    d2.setdefault("fallback", True)
                return d2
        return d

    if force:
        fresh = _with_fallback()
        if not _empty(fresh):
            box.store(fresh)
            return fresh, False, 0.0
    return box.get(_with_fallback)


def quotes_snapshot(codes: list[str]) -> dict:
    """quotes.snapshot 的统一入口（同一代码集合共用一个缓存槽）。"""
    key = ",".join(sorted({str(c) for c in codes if c}))
    data, stale, age = read("quote", key or "-", lambda: quotes.snapshot(codes),
                            backups=[("sina", lambda: quotes.snapshot(codes))])
    return _tag(data or {}, stale, age)


def quotes_fetch(codes: list[str]) -> dict:
    key = ",".join(sorted({str(c) for c in codes if c}))
    data, stale, age = read("quote", key or "-", lambda: quotes.fetch(codes))
    return _tag(data or {}, stale, age)


def kline(code: str, period: str = "day", limit: int = 160) -> dict:
    ttl = 300.0 if period == "day" else 60.0
    data, stale, age = read("kline", f"{code}:{period}:{limit}",
                            lambda: kline_mod.fetch(code, period, limit), ttl=ttl)
    return _tag(data or {}, stale, age)


def market_all(force: bool = False) -> dict:
    def _build() -> dict:
        return market.all_market(force=force)

    data, stale, age = read("market", "all", _build, force=force,
                            backups=[("global", lambda: market.global_markets(force=force))])
    return _tag(data or {}, stale, age)


def market_global(force: bool = False) -> dict:
    data, stale, age = read("market_global", "global",
                            lambda: market.global_markets(force=force), force=force)
    return _tag(data or {}, stale, age)


def fund_profile(code: str) -> dict:
    data, stale, age = read("fund_profile", code, lambda: quotes.fund_profile(code),
                            backups=[("kline_fund", lambda: kline_mod.fetch(code, "day", 400))])
    return _tag(data or {}, stale, age)


def fund_position(code: str) -> dict:
    data, stale, age = read("fund_position", code, lambda: quotes.fund_position(code))
    return _tag(data or {}, stale, age)


def etf_holdings(code: str, force: bool = False) -> dict:
    data, stale, age = read("etf_holdings", code, lambda: etf_mod.get_holdings(code, force=force),
                            force=force)
    return _tag(data or {}, stale, age)


def stats() -> dict:
    """给 /health 看的统一层状态：每个槽的年龄与是否过期。"""
    out = {}
    with _registry_lk:
        boxes = list(_registry.items())
    for name, box in boxes:
        data, age = box.peek()
        if age < 0:
            continue
        out[name] = {"age": round(age, 1), "ttl": box.ttl, "stale": age > box.ttl}
    return out
