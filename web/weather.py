"""上海浦东新区天气（open-meteo，免 key）：是否下雨、未来几小时降雨概率、今日温度。

命令行：python3 weather.py

取数原则（重要，别改回「每次同步拉、失败就等超时」）：
1. 磁盘缓存在 TTL（10 分钟）内 → 直接返回，零开销；
2. 缓存过期 → **先返回旧数据**（标 `stale: True`，前端照常显示「更新于 HH:MM」），
   同时在后台线程刷新。服务器到 open-meteo 不通时一次要等满超时，这个等待绝不能落在
   用户请求上（历史上 /api/v1/feed 因此每次卡 12 秒）；
3. 一次都没有缓存时才同步试一次（超时 4 秒），失败返回占位文案，并退避 10 分钟再试；
4. 抓取失败不清空旧缓存：天气「旧一点」远好过「没有」。
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

BASE = Path(__file__).resolve().parent
CACHE = BASE / "data" / "weather.json"
BJ = timezone(timedelta(hours=8))
LAT, LON = 31.2215, 121.5444          # 浦东新区（世纪公园一带）
PLACE = "上海浦东新区"
TTL = 600          # 数据有效期
TIMEOUT = 4        # 单次上游请求（原来 12s，比整个首屏还慢）
RETRY_AFTER_FAIL = 600   # 抓取失败后多久再试

WMO = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
    45: "雾", 48: "冻雾",
    51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
    56: "冻毛毛雨", 57: "强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "米雪",
    80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    85: "小阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
}
RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}

_mem: dict = {"data": None, "fail_at": 0.0}
_lock = threading.Lock()
_busy = False


def _desc(code) -> str:
    try:
        return WMO.get(int(code), "未知")
    except (TypeError, ValueError):
        return "未知"


def _read_cache() -> dict | None:
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _fresh(d: dict | None) -> bool:
    return bool(d) and time.time() - d.get("_ts", 0) < TTL


def _fetch() -> dict | None:
    """真正联网取一次；失败返回 None（不抛异常）。"""
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": LAT, "longitude": LON,
            "current": "temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m",
            "hourly": "precipitation,precipitation_probability,weather_code,temperature_2m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max",
            "timezone": "Asia/Shanghai", "forecast_days": 2,
        }, timeout=TIMEOUT)
        return r.json()
    except Exception:  # noqa: BLE001 - 网络/DNS/超时/上游 5xx 都按「这次没拿到」处理
        return None


def _parse(d: dict) -> dict | None:
    """把 open-meteo 原始响应整理成前端用的结构；关键字段缺失返回 None。"""
    now = datetime.now(BJ)
    nl = now.replace(tzinfo=None)
    cur = d.get("current") or {}
    hourly = d.get("hourly") or {}
    times = hourly.get("time") or []
    if not cur or not times:
        return None
    code_now = cur.get("weather_code", 0)
    temp = cur.get("temperature_2m")
    rain_now = float(cur.get("precipitation") or 0) >= 0.05 or int(code_now or 0) in RAIN_CODES

    # 未来 6 小时（从当前整点开始）
    nxt = []
    for i, t in enumerate(times):
        try:
            ht = datetime.strptime(t, "%Y-%m-%dT%H:%M")
        except ValueError:
            continue
        if ht < nl.replace(minute=0, second=0, microsecond=0) or ht > nl + timedelta(hours=6):
            continue
        nxt.append({"t": ht.strftime("%H:%M"),
                    "p": int((hourly.get("precipitation_probability") or [0] * len(times))[i] or 0),
                    "mm": round(float((hourly.get("precipitation") or [0] * len(times))[i] or 0), 2),
                    "code": (hourly.get("weather_code") or [0] * len(times))[i],
                    "temp": (hourly.get("temperature_2m") or [None] * len(times))[i]})
    rain_soon = [x for x in nxt if x["mm"] >= 0.1 or x["p"] >= 50]

    daily = d.get("daily") or {}

    def day(i):
        try:
            return {"date": (daily.get("time") or [])[i], "code": (daily.get("weather_code") or [])[i],
                    "desc": _desc((daily.get("weather_code") or [])[i]),
                    "tmax": (daily.get("temperature_2m_max") or [])[i],
                    "tmin": (daily.get("temperature_2m_min") or [])[i],
                    "rain": round(float((daily.get("precipitation_sum") or [0])[i] or 0), 1),
                    "prob": int((daily.get("precipitation_probability_max") or [0])[i] or 0)}
        except (IndexError, TypeError):
            return {}
    today, tomorrow = day(0), day(1)

    if rain_now:
        rain_txt = f"现在在下{_desc(code_now)}"
    elif rain_soon:
        first = rain_soon[0]
        rain_txt = f"现在没下雨，{first['t']} 起可能下雨（概率 {first['p']}%）"
    else:
        rain_txt = "现在没下雨，未来 6 小时基本无雨"

    parts = [f"{PLACE} {_desc(code_now)} {temp:.1f}℃" if temp is not None else f"{PLACE} {_desc(code_now)}"]
    if today:
        parts.append(f"今日 {today['desc']} {today['tmin']:.0f}~{today['tmax']:.0f}℃")
        parts.append(f"降雨概率 {today['prob']}% / 雨量 {today['rain']}mm")
    parts.append(rain_txt)
    if tomorrow:
        parts.append(f"明日 {tomorrow['desc']} {tomorrow['tmin']:.0f}~{tomorrow['tmax']:.0f}℃")

    return {
        "ok": True, "place": PLACE, "updated": now.strftime("%m-%d %H:%M"),
        "now": {"desc": _desc(code_now), "temp": temp, "precip": cur.get("precipitation"),
                "humidity": cur.get("relative_humidity_2m"), "wind": cur.get("wind_speed_10m")},
        "rain_now": bool(rain_now), "rain_soon": bool(rain_soon), "rain_text": rain_txt,
        "next": nxt, "today": today, "tomorrow": tomorrow,
        "text": " · ".join(parts), "_ts": time.time(),
    }


def _refresh() -> dict | None:
    """同步刷新一次并落盘（成功才写，失败保留旧文件）。"""
    raw = _fetch()
    if not raw:
        _mem["fail_at"] = time.time()
        return None
    out = _parse(raw)
    if not out:
        _mem["fail_at"] = time.time()
        return None
    _mem["data"] = out
    _mem["fail_at"] = 0.0
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, CACHE)          # 原子写，别让半个文件被读到
    except OSError:
        pass
    return out


def _refresh_bg() -> None:
    global _busy
    try:
        _refresh()
    finally:
        with _lock:
            _busy = False


def _spawn_refresh() -> None:
    global _busy
    with _lock:
        if _busy:
            return
        if _mem["fail_at"] and time.time() - _mem["fail_at"] < RETRY_AFTER_FAIL:
            return                      # 刚失败过，别每个请求都去撞墙
        _busy = True
    threading.Thread(target=_refresh_bg, name="weather-refresh", daemon=True).start()


def _placeholder(reason: str = "") -> dict:
    txt = f"{PLACE} 天气暂时取不到" + (f"（{reason}）" if reason else "")
    return {"ok": False, "place": PLACE, "text": txt, "updated": "", "stale": True}


def get(force: bool = False) -> dict:
    """永远快速返回：新鲜缓存 → 旧缓存(并后台刷新) → 首次同步试一次 → 占位。"""
    disk = _mem["data"] or _read_cache()
    if disk:
        _mem["data"] = disk
    if force:
        return _refresh() or disk or _placeholder("强制刷新失败")
    if _fresh(disk):
        return disk
    if disk:                            # 过期但有旧值：先给旧的，后台补新的
        _spawn_refresh()
        return {**disk, "stale": True}
    got = _refresh()                    # 一次都没有缓存：同步等一次（≤4s），只发生在首次
    return got or _placeholder("上游不通")


if __name__ == "__main__":
    print(get(force=True)["text"])
