"""新闻总结语音朗读：用微软 Edge 神经语音生成 MP3，按内容哈希缓存。

设计：
  - 只依赖免费的 edge-tts（非官方接口），首次生成较慢，生成后落盘复用；
  - 按 day + slot + scope + 正文内容算缓存键，正文重写后自动失效；
  - 文件锁 + 进度文件跨进程去重，定时预生成和用户点播不会重复合成；
  - 生成线程在后台跑，接口只返回 ready / generating / error 三种状态。

用法：
  venv/bin/python digest_tts.py 2026-11-15 pm key    # 前台生成（调试/补缓存）
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import store

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
TTS_DIR = DATA / "tts"

VOICE = os.environ.get("STOCK_TTS_VOICE", "zh-CN-YunyangNeural")
RATE = os.environ.get("STOCK_TTS_RATE", "+0%")
# 清理规则/朗读稿结构变了就 +1，让旧缓存自动失效（缓存键里带这个版本号）
SCRIPT_VERSION = "2"
SCOPES = ("key", "full")
# 编辑层：必看 / 今日主线 / 故事线 / 持仓雷达 / 接下来 / 较上期
KEY_PREFIXES = ("必看", "今日主线", "故事线", "持仓", "接下来", "较上期")
CHUNK_CHARS = 1800
CACHE_DAYS = 14   # 音频是随时可再生成的缓存，留 14 天足够（35 天会占 100M+ 磁盘）
CHUNK_RETRIES = 2

log = logging.getLogger("digest-tts")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False


# ---------------- 正文清理 / 朗读稿 ----------------

_SECTION_RE = re.compile(r"^(.*?)\s*·\s*(\d+)\s*条\s*$")


def _speech_clean(text: str) -> str:
    """把 Markdown / 来源 token 清成适合朗读的句子。"""
    s = str(text or "")
    s = re.sub(r"\{\{n\d+\}\}", "", s)          # 来源 token 不读
    s = re.sub(r"^\s*#{1,6}\s*", "", s)          # 行首标题号
    s = re.sub(r"^\s*[-•]\s*", "", s)            # 行首圆点
    s = s.replace("**", "").replace("`", "")
    # 时间区间先读成「至」，剩下的破折号再当停顿
    s = re.sub(r"(\d{1,2}:\d{2})\s*[—–~～]\s*(\d{1,2}:\d{2})", r"\1至\2", s)
    s = re.sub(r"(\d{1,2}:\d{2})\s*[—–~～]\s*", r"\1至", s)
    # 让 TTS 别把斜杠读成「斜杠」、别把间隔号读成「点」
    s = s.replace("/", "、").replace("·", "，")
    s = s.replace("→", "，")
    s = s.replace("—", "，").replace("–", "，")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_content(content: str) -> tuple[list[str], list[dict]]:
    """和前端 parseDigest 同口径：## 标题为分段，- 开头为条目，其余为首段总览。"""
    lead: list[str] = []
    secs: list[dict] = []
    for raw in str(content or "").splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("#"):
            t = re.sub(r"^#+\s*", "", s).strip()
            m = _SECTION_RE.match(t)
            title = m.group(1).strip() if m else t
            count = int(m.group(2)) if m else None
            secs.append({"title": title, "count": count, "items": []})
        else:
            s = re.sub(r"^[-•]\s*", "", s)
            if secs:
                secs[-1]["items"].append(s)
            else:
                lead.append(s)
    return lead, secs


def build_script(day: str, slot: str, scope: str, content: str) -> str:
    """生成朗读稿。scope=key 只读编辑层，full 连领域索引一起读。"""
    lead, secs = parse_content(content)
    label = "晚报" if slot == "pm" else "早报"
    try:
        _, m, d = day.split("-")
        intro = f"新闻总结，{int(m)}月{int(d)}日{label}。"
    except (ValueError, TypeError):
        intro = f"新闻总结，{label}。"
    intro += "先读重点内容。" if scope == "key" else "读全文。"
    parts = [intro]

    lead_txt = _speech_clean(" ".join(lead))
    if lead_txt:
        parts.append(lead_txt)

    for sec in secs:
        if scope == "key" and not sec["title"].startswith(KEY_PREFIXES):
            continue
        items = [_speech_clean(x) for x in sec["items"]]
        items = [x for x in items if x]
        if not items:
            continue
        title = _speech_clean(sec["title"])
        n = sec["count"] if sec["count"] is not None else len(items)
        parts.append(f"{title}，{n}条。")
        parts.extend(items)

    parts.append("以上是本期新闻总结。")
    return "\n".join(parts)


def _split_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """按句号切块，让每次 Edge 请求不超过 limit 字符。"""
    sents = [x.strip() for x in re.split(r"(?<=[。！？!?；;])\s*|\n+", text) if x.strip()]
    chunks: list[str] = []
    cur = ""
    for s in sents:
        while len(s) > limit:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(s[:limit])
            s = s[limit:]
        if not s:
            continue
        if cur and len(cur) + len(s) > limit:
            chunks.append(cur)
            cur = s
        else:
            cur = (cur + "\n" + s) if cur else s
    if cur:
        chunks.append(cur)
    return chunks


# ---------------- 缓存 / 文件锁 ----------------

def _paths(day: str, slot: str, scope: str, content: str) -> tuple[str, Path, Path]:
    raw = f"v{SCRIPT_VERSION}|{day}|{slot}|{scope}|{VOICE}|{RATE}|{content}"
    key = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]
    base = TTS_DIR / key
    return key, base.with_suffix(".mp3"), base.with_suffix(".json")


def _validate(day: str, slot: str, scope: str) -> None:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(day or "")):
        raise ValueError("day 格式不对")
    if slot not in store.DIGEST_SLOTS:
        raise ValueError("slot 只能是 am / pm")
    if scope not in SCOPES:
        raise ValueError("scope 只能是 key / full")


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _try_lock(path: Path):
    """拿到就返回 fd（进程退出自动释放），已经被别人拿着返回 None。"""
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


def _lock_held(path: Path) -> bool:
    fd = _try_lock(path)
    if fd is None:
        return True
    os.close(fd)
    return False


def _cache_ready(mp3: Path, meta: Path) -> bool:
    return mp3.is_file() and meta.is_file()


def _meta_or_none(mp3: Path, meta: Path) -> dict | None:
    if not _cache_ready(mp3, meta):
        return None
    m = _read_json(meta)
    return m if isinstance(m, dict) else None


# ---------------- 合成 ----------------

async def _synth_chunk(text: str) -> tuple[bytes, float]:
    try:
        import edge_tts
    except Exception as e:  # pragma: no cover - 部署时缺依赖才会走到
        raise RuntimeError("edge-tts 未安装，无法生成语音") from e

    c = edge_tts.Communicate(
        text, voice=VOICE, rate=RATE, boundary="SentenceBoundary",
        connect_timeout=20, receive_timeout=180,
    )
    buf = bytearray()
    end = 0
    async for ev in c.stream():
        typ = ev.get("type")
        if typ == "audio":
            buf.extend(ev.get("data") or b"")
        elif typ in ("SentenceBoundary", "WordBoundary"):
            try:
                end = max(end, int(ev.get("offset") or 0) + int(ev.get("duration") or 0))
            except (TypeError, ValueError):
                pass
    if not buf:
        raise RuntimeError("语音服务没有返回音频")
    # Edge 的时间单位是 100ns；拿不到时间戳时按 48kbps 估算
    duration = end / 10_000_000 if end else len(buf) * 8 / 48_000
    return bytes(buf), duration


async def _run_chunks(chunks: list[str], progress_path: Path) -> tuple[bytes, float]:
    audio = bytearray()
    total = 0.0
    for i, text in enumerate(chunks):
        last_err: Exception | None = None
        for attempt in range(CHUNK_RETRIES + 1):
            try:
                data, dur = await _synth_chunk(text)
                break
            except Exception as e:  # 网络抖动重试；最后一次才抛出
                last_err = e
                if attempt < CHUNK_RETRIES:
                    log.warning("tts chunk %d/%d failed (try %d): %s",
                                i + 1, len(chunks), attempt + 1, e)
                    await asyncio.sleep(1.5 * (attempt + 1))
        else:  # pragma: no cover
            raise RuntimeError(f"第 {i + 1} 段语音生成失败：{last_err}")
        audio.extend(data)
        total += dur
        _write_json(progress_path, {"done": i + 1, "total": len(chunks),
                                    "updated_at": int(time.time())})
        log.info("tts chunk %d/%d: %d chars, %.1fs", i + 1, len(chunks), len(text), dur)
        if i + 1 < len(chunks):
            await asyncio.sleep(0.3)
    return bytes(audio), total


def _generate(day: str, slot: str, scope: str, content: str) -> dict:
    key, mp3, meta = _paths(day, slot, scope, content)
    base = mp3.with_suffix("")
    progress = base.with_suffix(".progress")
    errfile = base.with_suffix(".error")
    TTS_DIR.mkdir(parents=True, exist_ok=True)

    fd = _try_lock(base.with_suffix(".lock"))
    if fd is None:
        # 另一个进程（预生成）正在做
        return {"ready": False, "generating": True, "key": key}
    try:
        text = build_script(day, slot, scope, content)
        chunks = _split_text(text)
        if not chunks:
            raise RuntimeError("没有可朗读的内容")
        try:
            errfile.unlink()
        except FileNotFoundError:
            pass
        _write_json(progress, {"done": 0, "total": len(chunks), "updated_at": int(time.time())})
        audio, duration = asyncio.run(_run_chunks(chunks, progress))
        if not audio:
            raise RuntimeError("没有生成音频")
        tmp_mp3 = base.with_suffix(".mp3.tmp")
        tmp_mp3.write_bytes(audio)
        os.replace(tmp_mp3, mp3)
        m = {
            "day": day,
            "slot": slot,
            "scope": scope,
            "voice": VOICE,
            "rate": RATE,
            "key": key,
            "chars": len(text),
            "chunks": len(chunks),
            "duration": round(duration, 3),
            "bytes": len(audio),
            "created_at": int(time.time()),
        }
        # meta 最后写：只有它出现了，status 才认为语音可用
        _write_json(meta, m)
        try:
            progress.unlink()
        except FileNotFoundError:
            pass
        log.info("tts done: %s %s %s, %.1f min, %.1f MB",
                 day, slot, scope, duration / 60, len(audio) / 1024 / 1024)
        return {"ready": True, "key": key, **m}
    except Exception as e:
        log.exception("tts failed: %s %s %s: %s", day, slot, scope, e)
        try:
            progress.unlink()
        except FileNotFoundError:
            pass
        try:
            errfile.write_text(str(e)[:800], encoding="utf-8")
        except OSError:
            pass
        return {"ready": False, "generating": False, "key": key, "error": str(e)[:800]}
    finally:
        os.close(fd)


# ---------------- 对外接口 ----------------

def status(day: str, slot: str = "am", scope: str = "key") -> dict:
    """ready / generating（带进度）/ error 三种状态；给前端轮询用。"""
    _validate(day, slot, scope)
    d = store.get_digest(day, slot)
    if not d:
        return {"ready": False, "generating": False, "error": "找不到这张总结"}
    content = d.get("content") or ""
    key, mp3, meta = _paths(day, slot, scope, content)
    m = _meta_or_none(mp3, meta)
    if m:
        return {
            "ready": True,
            "generating": False,
            "key": key,
            "scope": scope,
            "duration": m.get("duration", 0),
            "bytes": m.get("bytes", 0),
            "chars": m.get("chars", 0),
            "voice": m.get("voice", VOICE),
        }
    base = mp3.with_suffix("")
    lock = base.with_suffix(".lock")
    if _lock_held(lock):
        prog = _read_json(base.with_suffix(".progress")) or {}
        return {
            "ready": False,
            "generating": True,
            "key": key,
            "scope": scope,
            "progress": {
                "done": int(prog.get("done") or 0),
                "total": int(prog.get("total") or 0),
            },
        }
    error = ""
    errpath = base.with_suffix(".error")
    if errpath.is_file():
        try:
            error = errpath.read_text(encoding="utf-8").strip()
        except OSError:
            error = "生成失败"
    return {"ready": False, "generating": False, "key": key, "scope": scope, "error": error}


def ensure(day: str, slot: str = "am", scope: str = "key") -> dict:
    """缓存没命中就在后台线程生成；接口立即返回状态。"""
    st = status(day, slot, scope)
    if st.get("ready") or st.get("generating"):
        return st
    d = store.get_digest(day, slot)
    if not d:
        return st
    content = d.get("content") or ""
    key, mp3, meta = _paths(day, slot, scope, content)
    base = mp3.with_suffix("")
    for sfx in (".error", ".progress"):
        try:
            base.with_suffix(sfx).unlink()
        except FileNotFoundError:
            pass
    threading.Thread(target=_generate, args=(day, slot, scope, content), daemon=True).start()
    return {
        "ready": False,
        "generating": True,
        "key": key,
        "scope": scope,
        "progress": {"done": 0, "total": 0},
    }


def cache_file(day: str, slot: str = "am", scope: str = "key") -> Path | None:
    """已生成就返回 mp3 路径，否则 None（文件接口用）。"""
    _validate(day, slot, scope)
    d = store.get_digest(day, slot)
    if not d:
        return None
    _, mp3, meta = _paths(day, slot, scope, d.get("content") or "")
    return mp3 if _meta_or_none(mp3, meta) else None


def warm_async(day: str, slot: str = "am", scope: str = "key") -> bool:
    """总结入库后调用：起一个脱离父进程的后台任务预生成，别让用户第一下等几分钟。"""
    try:
        st = status(day, slot, scope)
    except ValueError:
        return False
    if st.get("ready") or st.get("generating"):
        return False
    try:
        logs = BASE / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        f = open(logs / "tts.log", "a", encoding="utf-8")
        f.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] warm {day} {slot} {scope}\n")
        f.flush()
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), day, slot, scope],
            cwd=str(BASE), stdout=f, stderr=f, start_new_session=True, close_fds=True,
        )
        f.close()
        return True
    except Exception as e:
        log.warning("tts warm failed: %s", e)
        return False


def prune(keep_days: int = CACHE_DAYS) -> int:
    """清掉长期不用的音频/元数据/残留临时文件。"""
    if not TTS_DIR.is_dir():
        return 0
    cutoff = time.time() - keep_days * 86400
    n = 0
    for p in TTS_DIR.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            pass
    return n


def _main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if len(sys.argv) < 3:
        print("用法：python digest_tts.py <day> <slot> [key|full]", file=sys.stderr)
        raise SystemExit(2)
    day, slot = sys.argv[1], sys.argv[2]
    scope = sys.argv[3] if len(sys.argv) > 3 else "key"
    try:
        _validate(day, slot, scope)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(2)
    d = store.get_digest(day, slot)
    if not d:
        print("找不到这张总结", file=sys.stderr)
        raise SystemExit(2)
    result = _generate(day, slot, scope, d.get("content") or "")
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if not result.get("error") else 1)


if __name__ == "__main__":
    _main()
