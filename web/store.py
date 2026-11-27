"""SQLite 存储层：持仓/关注 / 标签 / 笔记 / 报告 / 要闻。
v2：分组改为 bucket(hold|watch) + 标签；新增 news（重要新闻）与 report_reads（已读）。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
from contextlib import contextmanager
import time
from datetime import datetime, timezone, timedelta, date
from pathlib import Path

BASE = Path(__file__).resolve().parent
DB_PATH = BASE / "data" / "stock.db"
CRON_OUT = Path.home() / ".hermes" / "cron" / "output"
BJ = timezone(timedelta(hours=8))
log = logging.getLogger("store")

_lock = threading.Lock()
# 已扫描过的报告文件签名（mtime_ns, size）：每 5 分钟只重读有变化的文件
_report_sig: dict[str, tuple[int, int]] = {}


def now_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")


def today_bj() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d")


@contextmanager
def conn():
    """一次连接一次关闭：with 块正常结束提交、异常回滚，最后一定 close()。

    原来的写法 `with conn() as c` 只会提交/回滚，连接要靠 GC 才收回，
    长期运行会堆文件句柄、偶尔撞上 database is locked。
    """
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    try:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        yield c
        c.commit()
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        raise
    finally:
        c.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0a84ff',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  shares REAL NOT NULL DEFAULT 0,
  cost REAL,
  tags TEXT NOT NULL DEFAULT '[]',
  custom_tags TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  focus TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  bucket TEXT NOT NULL DEFAULT 'watch',
  dca REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  stock_code TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'idea',
  answer TEXT NOT NULL DEFAULT '',
  answered_at TEXT,
  memo TEXT NOT NULL DEFAULT '',
  news_id INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(day, kind)
);
CREATE TABLE IF NOT EXISTS report_reads (
  report_id INTEGER PRIMARY KEY,
  read_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  weight INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'report',
  created_at TEXT NOT NULL,
  published_at TEXT,
  level TEXT,
  alert INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  stock_code TEXT,
  read_at TEXT,
  UNIQUE(day, category, title)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
-- 报告拆段：供「行情·市场行情/热门板块」和个股卡片直接引用报告里的分析原文
CREATE TABLE IF NOT EXISTS report_sections (
  report_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  stock_code TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(report_id, section, stock_code)
);
CREATE INDEX IF NOT EXISTS idx_rs_section ON report_sections(section, day DESC);
CREATE INDEX IF NOT EXISTS idx_rs_stock ON report_sections(stock_code, day DESC);
-- 个股红标：新闻库/定时任务检索到某只持仓或关注股的新闻、公告时写一条，打开个股即已读
CREATE TABLE IF NOT EXISTS stock_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'news',
  source TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  read_at TEXT,
  ref TEXT NOT NULL DEFAULT '',
  UNIQUE(code, title)
);
CREATE INDEX IF NOT EXISTS idx_flags_unread ON stock_flags(code, read_at);
-- board 每次都要取全量未读红标；部分索引比 (code, read_at) 更贴合这个查询
CREATE INDEX IF NOT EXISTS idx_flags_unread_all ON stock_flags(read_at) WHERE read_at IS NULL;
-- 价格提醒：一只标的最多三条（涨到 / 跌到 / 日涨跌幅超），触发写一条事件进提醒中心
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                 -- up / down / pct
  value REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_fired TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(code, kind)
);
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  value REAL NOT NULL,
  price REAL,
  fired_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_time ON alert_events(fired_at DESC);
-- 用户删掉的红标：定时任务再次扫描新闻库时不要再写回来（30 天）
CREATE TABLE IF NOT EXISTS stock_flag_tomb (
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  del_at TEXT NOT NULL,
  PRIMARY KEY(code, title)
);
-- 个股详情「公司 · 消息」只放实时新闻：后台每小时把近 2h 的实时电报匹配进来，页面只读这张表
CREATE TABLE IF NOT EXISTS stock_live_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  news_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(code, news_id)
);
CREATE INDEX IF NOT EXISTS idx_sln_code_pub ON stock_live_news(code, published_at);
-- A级新闻游标查询（APK 通知服务用）
CREATE INDEX IF NOT EXISTS idx_news_alert ON news(source, level, id);
-- 实时新闻按天/游标、收藏夹、笔记关联查询；数据量上来后避免全表扫
CREATE INDEX IF NOT EXISTS idx_news_source_day ON news(source, day, id);
CREATE INDEX IF NOT EXISTS idx_news_saved ON news(saved, id) WHERE saved=1;
CREATE INDEX IF NOT EXISTS idx_notes_stock ON notes(stock_code, deleted);
CREATE INDEX IF NOT EXISTS idx_notes_deleted_created ON notes(deleted, created_at);
-- 已删除的实时新闻墓碑：拉取时按标题命中就不再写回来（"真删"）
CREATE TABLE IF NOT EXISTS news_tomb (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  del_at TEXT NOT NULL
);
-- 回收站：所有删除先进这里，默认 7 天后自动清理
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
-- 标签选股的手动纠错：按“解析后的标准板块名”记住置顶/隐藏
CREATE TABLE IF NOT EXISTS tag_marks (
  tag TEXT NOT NULL,
  code TEXT NOT NULL,
  mark TEXT NOT NULL CHECK(mark IN ('pin','hide')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tag, code)
);
-- 新闻总结：每天 08:00（am）/ 20:00（pm）各一张卡片，汇总上一张卡结束以来的新闻
CREATE TABLE IF NOT EXISTS news_digest (
  day TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'am' CHECK(slot IN ('am','pm')),
  content TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT '',
  window_end TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(day, slot)
);
-- 新闻总结上的标注：标红 / 下划线 / 批注。
-- block 是卡内区块（lead 或 s{段}i{条}），start_off/end_off 是该区块原始文本里的字符位置；
-- quote 存选中的原文，内容重新生成导致位置漂移时前端按原文重新定位。
CREATE TABLE IF NOT EXISTS digest_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'am' CHECK(slot IN ('am','pm')),
  block TEXT NOT NULL,
  start_off INTEGER NOT NULL,
  end_off INTEGER NOT NULL,
  quote TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT 'red' CHECK(style IN ('red','underline','note')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_digest_marks_digest ON digest_marks(day, slot);
-- 工作台：自己定义的工作类型（相当于清单），每类下面挂若干带时间的日程
CREATE TABLE IF NOT EXISTS work_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,                 -- YYYY-MM-DD HH:MM（北京时间）
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT NOT NULL DEFAULT '',      -- 勾上完成的那一刻（YYYY-MM-DD HH:MM:SS），统计按它归日
  notified_at TEXT,
  snooze_at TEXT NOT NULL DEFAULT '',    -- 只推迟「这一次」提醒（YYYY-MM-DD HH:MM），不动 due_at / 不动重复规则
  created_at TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  days TEXT NOT NULL DEFAULT '[]',      -- 重复：周几集合 [1..6]，空 = 不重复
  head INTEGER NOT NULL DEFAULT 0       -- 0=规则行（首条）；>0=这条属于哪个规则行
);
CREATE INDEX IF NOT EXISTS idx_work_tasks_due ON work_tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_work_tasks_type ON work_tasks(type_id, due_at);
-- 专注模式：一套有序步骤的模板，开始后生成当天的一条真实时间线（focus_runs）
CREATE TABLE IF NOT EXISTS focus_modes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  ring_each_step INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS focus_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 25,
  anchor TEXT NOT NULL DEFAULT '',      -- '' = 接续上一步；'09:30' = 定点
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_focus_steps_mode ON focus_steps(mode_id, sort);
-- 「这一步做完了」写服务端：换手机 / 清缓存 / 装新包都还在，不然当天旧步骤会再响一遍
CREATE TABLE IF NOT EXISTS focus_step_done (
  day TEXT NOT NULL,
  mode_id INTEGER NOT NULL,
  step_idx INTEGER NOT NULL,
  done_at TEXT NOT NULL DEFAULT '',
  done_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (day, mode_id, step_idx)
);
CREATE INDEX IF NOT EXISTS idx_focus_done_day ON focus_step_done(day);
CREATE TABLE IF NOT EXISTS focus_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode_id INTEGER NOT NULL,
  mode_name TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  cur_start TEXT NOT NULL DEFAULT '',   -- 当前这一步实际开始的时刻
  step_idx INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',  -- running / done / quit
  ended_at TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '[]'    -- 启动瞬间的步骤快照
);
CREATE INDEX IF NOT EXISTS idx_focus_runs_day ON focus_runs(day, status);
-- 值班：班次定义 + 轮转表（只存规则，日历按需推算）
CREATE TABLE IF NOT EXISTS shift_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  cross_day INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'shift',
  dur_min INTEGER NOT NULL DEFAULT 0,
  breaks TEXT NOT NULL DEFAULT '[]',    -- 班次内的休息区间 [["12:00","13:00"]]，按上班时刻算
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shift_rosters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,                -- '[白id,夜id,0,0]'，0 = 休
  start_date TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  end_date TEXT                          -- 到哪天为止（NULL = 一直沿用）
);
CREATE TABLE IF NOT EXISTS shift_overrides (
  day TEXT PRIMARY KEY,                 -- YYYY-MM-DD
  shift_id INTEGER NOT NULL DEFAULT 0   -- 0 = 休
);
"""

# 只在「首次初始化且库为空」时灌种子（防丢库重建）；日常名单以 stocks 表为准，用户随时在 App 里改
# 2026-10-26 站点快照：6 持仓 + 8 关注，份额/成本未维护
HOLDINGS = [
    ("002196", "方正电机", 0, None, ["电机", "人形机器人"]),
    ("159148", "石油ETF富国", 0, None, ["能源", "ETF"]),
    ("600127", "金健米业", 0, None, ["粮油加工"]),
    ("600802", "福建水泥", 0, None, ["水泥制造"]),
    ("601398", "工商银行", 0, None, ["国有大型银行"]),
    ("601811", "新华文轩", 0, None, ["教育出版", "电商"]),
]

WATCHLIST = [
    ("603278", "大业股份", ["金属制品", "机器人"]),
    ("000636", "风华高科", ["被动元件", "MLCC", "超级电容"]),
    ("002368", "太极股份", ["IT服务", "智慧城市", "数据要素"]),
    ("603187", "海容冷链", ["制冷空调设备"]),
    ("002747", "埃斯顿", ["工业机器人", "机器视觉", "工业母机"]),
    ("300124", "汇川技术", ["工控设备", "人形机器人", "PLC"]),
    ("600025", "华能水电", ["水力发电", "绿色电力"]),
    ("300014", "亿纬锂能", ["锂电池", "储能", "新能源车"]),
]


def _migrate_work_v2(c: sqlite3.Connection) -> None:
    """第二批：班次分三类（常规 / 长日 / 不值班），给老表补字段。"""
    cols = {r["name"] for r in c.execute("PRAGMA table_info(shift_types)")}
    if "kind" not in cols:
        c.execute("ALTER TABLE shift_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'shift'")
    if "dur_min" not in cols:
        c.execute("ALTER TABLE shift_types ADD COLUMN dur_min INTEGER NOT NULL DEFAULT 0")
    if "breaks" not in cols:
        c.execute("ALTER TABLE shift_types ADD COLUMN breaks TEXT NOT NULL DEFAULT '[]'")
    tcols = {r["name"] for r in c.execute("PRAGMA table_info(work_tasks)")}
    if "snooze_at" not in tcols:
        # 晚点提醒以前是靠把 due_at 往后挪 10 分钟实现的，重复日程因此被改了所有天。
        # 现在单独一列，只影响那一次。
        c.execute("ALTER TABLE work_tasks ADD COLUMN snooze_at TEXT NOT NULL DEFAULT ''")
    rcols = {r["name"] for r in c.execute("PRAGMA table_info(shift_rosters)")}
    if "end_date" not in rcols:
        c.execute("ALTER TABLE shift_rosters ADD COLUMN end_date TEXT")
    if "days" not in rcols:
        # 轮转表「只在哪几天在岗」：1=周一 … 7=周日；NULL = 每天。不在的日子按休算
        c.execute("ALTER TABLE shift_rosters ADD COLUMN days TEXT")


def _backfill_shift_modes(c: sqlite3.Connection) -> None:
    """老数据（专注模式里选了「班次」）一次性搬到班次的 modes 上，之后只认班次这一份。"""
    try:
        rows = c.execute("SELECT id,shifts FROM focus_modes").fetchall()
    except Exception:
        return
    per: dict[int, list] = {}
    for r in rows:
        try:
            ids = [int(x) for x in json.loads(r["shifts"] or "[]")]
        except Exception:
            ids = []
        for sid in ids:
            per.setdefault(sid, []).append(int(r["id"]))
    for r in c.execute("SELECT id FROM shift_types"):
        sid = int(r["id"])
        got = per.get(sid)
        if got:
            c.execute("UPDATE shift_types SET modes=? WHERE id=?", (json.dumps(sorted(got)), sid))


def _migrate(c: sqlite3.Connection) -> None:
    cols = {r["name"] for r in c.execute("PRAGMA table_info(stocks)")}
    if "bucket" not in cols:
        c.execute("ALTER TABLE stocks ADD COLUMN bucket TEXT NOT NULL DEFAULT 'watch'")
        c.execute("UPDATE stocks SET bucket='hold' WHERE shares>0")
    if "custom_tags" not in cols:
        # 自定义标签与 tags（外网 API 标签）分开存；旧数据不迁移，自定义标签从空开始
        c.execute("ALTER TABLE stocks ADD COLUMN custom_tags TEXT NOT NULL DEFAULT '[]'")
    if "focus" not in cols:
        # 手动编辑的「关注」；为空时回退到报告自动提取
        c.execute("ALTER TABLE stocks ADD COLUMN focus TEXT NOT NULL DEFAULT ''")
    if "dca" not in cols:
        # 每只基金的每日定投额度（元/天），0 表示没设
        c.execute("ALTER TABLE stocks ADD COLUMN dca REAL NOT NULL DEFAULT 0")
    if "priority" not in cols:
        # 关注优先级 A/B/C（空=未设置）；列表按 A→B→C→未设置 排
        c.execute("ALTER TABLE stocks ADD COLUMN priority TEXT NOT NULL DEFAULT ''")
    ncols = {r["name"] for r in c.execute("PRAGMA table_info(notes)")}
    if "stage" not in ncols:
        # 记录的四段状态：idea 想法 / plan 计划 / done 已执行 / review 复盘
        c.execute("ALTER TABLE notes ADD COLUMN stage TEXT NOT NULL DEFAULT 'idea'")
    if "kind" not in ncols:
        c.execute("ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'idea'")
    if "answer" not in ncols:
        # 「分析」条目由每天盘后复盘 agent 回答；有 answer（或「已分析」标签）显示成绿色已分析，否则橙色未分析
        c.execute("ALTER TABLE notes ADD COLUMN answer TEXT NOT NULL DEFAULT ''")
    if "answered_at" not in ncols:
        c.execute("ALTER TABLE notes ADD COLUMN answered_at TEXT")
    if "memo" not in ncols:
        # 收藏新闻迁进 notes 后，「我的笔记」也存在这里（卡片上橙色高亮）
        c.execute("ALTER TABLE notes ADD COLUMN memo TEXT NOT NULL DEFAULT ''")
    if "news_id" not in ncols:
        # 收藏新闻和 news 行的对应关系：取消收藏 / 删除新闻时据此联动
        c.execute("ALTER TABLE notes ADD COLUMN news_id INTEGER")
    c.execute("CREATE INDEX IF NOT EXISTS idx_notes_news ON notes(news_id)")
    _backfill_saved_notes(c)
    acols = {r["name"] for r in c.execute("PRAGMA table_info(alerts)")}
    if acols and "armed" not in acols:
        # 价格提醒改成「边沿触发」：没命中时重新武装，命中且已武装才发一条，
        # 避免收盘后价格不动、每小时重复推同一只（以前是按小时桶去重，一小时一响）
        c.execute("ALTER TABLE alerts ADD COLUMN armed INTEGER NOT NULL DEFAULT 1")
    tcols = {r["name"] for r in c.execute("PRAGMA table_info(work_tasks)")}
    if tcols and "days" not in tcols:
        # 日程重复：复用 work_tasks 行，规则挂在首条上，后续条目用 head 指回来
        c.execute("ALTER TABLE work_tasks ADD COLUMN days TEXT NOT NULL DEFAULT '[]'")
    if tcols and "head" not in tcols:
        c.execute("ALTER TABLE work_tasks ADD COLUMN head INTEGER NOT NULL DEFAULT 0")
    if tcols and "done_at" not in tcols:
        # 完成时刻：以前只有 done 布尔，没法知道哪天做完的，统计只能按计划日算
        c.execute("ALTER TABLE work_tasks ADD COLUMN done_at TEXT NOT NULL DEFAULT ''")
    scols = {r["name"] for r in c.execute("PRAGMA table_info(shift_types)")}
    if scols and "modes" not in scols:
        # 班次 → 专注模式：唯一一份绑定关系，专注侧不再单独记「哪些班次」
        c.execute("ALTER TABLE shift_types ADD COLUMN modes TEXT NOT NULL DEFAULT '[]'")
        _backfill_shift_modes(c)
    fcols = {r["name"] for r in c.execute("PRAGMA table_info(focus_modes)")}
    if fcols:
        if "auto" not in fcols:
            # 到点自动开始
            c.execute("ALTER TABLE focus_modes ADD COLUMN auto INTEGER NOT NULL DEFAULT 0")
        if "days" not in fcols:
            # 周几跑：1=周一 … 7=周日，空数组 = 每天
            c.execute("ALTER TABLE focus_modes ADD COLUMN days TEXT NOT NULL DEFAULT '[]'")
        if "shifts" not in fcols:
            # 哪些值班类型下跑：shift_types.id，0=休，空数组 = 不限
            c.execute("ALTER TABLE focus_modes ADD COLUMN shifts TEXT NOT NULL DEFAULT '[]'")
        if "dkind" not in fcols:
            # 日类型：''=不限 / work=工作日 / off=休息日
            c.execute("ALTER TABLE focus_modes ADD COLUMN dkind TEXT NOT NULL DEFAULT ''")
    wcols = {r["name"] for r in c.execute("PRAGMA table_info(news)")}
    if wcols and "published_at" not in wcols:
        c.execute("ALTER TABLE news ADD COLUMN published_at TEXT")
    if wcols and "saved" not in wcols:
        c.execute("ALTER TABLE news ADD COLUMN saved INTEGER NOT NULL DEFAULT 0")
    fcols = {r["name"] for r in c.execute("PRAGMA table_info(stock_flags)")}
    if fcols and "ref" not in fcols:
        c.execute("ALTER TABLE stock_flags ADD COLUMN ref TEXT NOT NULL DEFAULT ''")
    if wcols and "read_at" not in wcols:
        # 新闻收件箱：上线当天把库里的旧新闻一次性标成已读，收件箱从零开始
        c.execute("ALTER TABLE news ADD COLUMN read_at TEXT")
        c.execute("UPDATE news SET read_at = COALESCE(NULLIF(published_at,''), created_at)")
    if wcols and "level" not in wcols:
        c.execute("ALTER TABLE news ADD COLUMN level TEXT")
    # 金十兜底源写入时没带 level，历史行会留 NULL：统计/标签按 C 级算，
    # 这里统一补成 C，别让筛选和计数各说各话（幂等，只在有 NULL 时写一次）
    c.execute("UPDATE news SET level='C' WHERE source='live' AND COALESCE(level,'')=''")
    if wcols and "alert" not in wcols:
        # B 级重点：只给财联社主动推送（jpush）里加粗/命中宏观战事关键词的电报置 1
        c.execute("ALTER TABLE news ADD COLUMN alert INTEGER NOT NULL DEFAULT 0")
    if wcols and "memo" not in wcols:
        # 收藏新闻的「我的笔记」：在笔记页给收藏的新闻补一段自己的批注，用高亮色显示
        c.execute("ALTER TABLE news ADD COLUMN memo TEXT NOT NULL DEFAULT ''")
    if wcols and "tag" not in wcols:
        # 手工日程的标签（财报 / 美联储 / 数据 …），决定关键日程左侧那枚彩色小标签
        c.execute("ALTER TABLE news ADD COLUMN tag TEXT NOT NULL DEFAULT ''")
    if wcols and "stock_code" not in wcols:
        # 收藏新闻也能关联个股（在「记录 · 新闻」里挂上，点个股可回看）
        c.execute("ALTER TABLE news ADD COLUMN stock_code TEXT")
    dcols = {r["name"] for r in c.execute("PRAGMA table_info(news_digest)")}
    if dcols and "slot" not in dcols:
        # 旧版一天一张（day 主键）→ 新版早/晚各一张（day+slot 主键）。
        # 旧卡片统一记为 am；老卡片没有 window_*，用生成时间兜底。
        c.execute("DROP TABLE IF EXISTS news_digest_migrate")
        c.execute(
            "CREATE TABLE news_digest_migrate ("
            " day TEXT NOT NULL,"
            " slot TEXT NOT NULL DEFAULT 'am' CHECK(slot IN ('am','pm')),"
            " content TEXT NOT NULL,"
            " total INTEGER NOT NULL DEFAULT 0,"
            " window_start TEXT NOT NULL DEFAULT '',"
            " window_end TEXT NOT NULL DEFAULT '',"
            " created_at TEXT NOT NULL,"
            " updated_at TEXT NOT NULL,"
            " PRIMARY KEY(day, slot))"
        )
        c.execute(
            "INSERT INTO news_digest_migrate"
            "(day,slot,content,total,window_start,window_end,created_at,updated_at)"
            " SELECT day,'am',content,total,created_at,updated_at,created_at,updated_at"
            " FROM news_digest"
        )
        c.execute("DROP TABLE news_digest")
        c.execute("ALTER TABLE news_digest_migrate RENAME TO news_digest")


def init() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, conn() as c:
        c.executescript(SCHEMA)
        _migrate(c)
        _migrate_work_v2(c)
        ts = now_bj()
        # 只在第一次初始化时灌入种子数据：用户删除/移动后，重启不能把它们加回来
        seeded = c.execute("SELECT v FROM meta WHERE k='seeded'").fetchone()
        existing = {r["code"] for r in c.execute("SELECT code FROM stocks")}
        if not seeded and not existing:
            order = c.execute("SELECT COALESCE(MAX(sort),0) FROM stocks").fetchone()[0]
            for code, name, shares, cost, tags in HOLDINGS:
                order += 1
                c.execute(
                    "INSERT INTO stocks(code,name,shares,cost,tags,note,sort,created_at,bucket)"
                    " VALUES(?,?,?,?,?,?,?,?,'hold')",
                    (code, name, shares, cost, json.dumps(tags, ensure_ascii=False), "", order, ts),
                )
            for code, name, tags in WATCHLIST:
                order += 1
                c.execute(
                    "INSERT INTO stocks(code,name,shares,cost,tags,note,sort,created_at,bucket)"
                    " VALUES(?,?,0,NULL,?,?,?,?,'watch')",
                    (code, name, json.dumps(tags, ensure_ascii=False), "", order, ts),
                )
        if not seeded:
            c.execute("INSERT INTO meta(k,v) VALUES('seeded','1')"
                      " ON CONFLICT(k) DO UPDATE SET v='1'")
        if c.execute("SELECT COUNT(*) FROM notes").fetchone()[0] == 0:
            c.execute(
                "INSERT INTO notes(created_at,updated_at,content,tags,stock_code,pinned,deleted,kind)"
                " VALUES(?,?,?,?,?,1,0,'note')",
                (ts, ts, "时间线已就绪：把每天的想法、看到的新闻直接写在这里，支持标签和关联个股。",
                 json.dumps(["使用说明"], ensure_ascii=False), None),
            )


# ---------- stocks ----------
def _tag_list(v) -> list[str]:
    """标签统一成去重、去空白的字符串列表。"""
    if not isinstance(v, list):
        return []
    return list(dict.fromkeys(str(t).strip() for t in v if str(t).strip()))


def _json_list(raw: str | None) -> list[str]:
    try:
        return _tag_list(json.loads(raw or "[]"))
    except Exception:
        return []


def _priority(v) -> str:
    """优先级只允许 A/B/C；其它值（含空）统一成空，避免脏数据排错位置。"""
    p = str(v or "").strip().upper()[:1]
    return p if p in ("A", "B", "C") else ""


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    for key in ("tags", "custom_tags"):
        if key in d:
            d[key] = _json_list(d.get(key))
    return d


def list_stocks(bucket: str | None = None) -> list[dict]:
    sql = "SELECT s.*, g.name AS group_name, g.color AS group_color FROM stocks s" \
          " LEFT JOIN groups g ON g.id=s.group_id"
    args: list = []
    if bucket:
        sql += " WHERE s.bucket=?"
        args.append(bucket)
    sql += " ORDER BY s.sort, s.id"
    with conn() as c:
        rows = c.execute(sql, args).fetchall()
    return [_row(r) for r in rows]


def get_stock(code: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
    return _row(r) if r else None


# ---------- 标签选股：置顶 / 隐藏 ----------
def tag_marks(tag: str) -> dict[str, str]:
    """{code: 'pin'|'hide'}；tag 用解析后的标准板块名。"""
    with conn() as c:
        rows = c.execute("SELECT code, mark FROM tag_marks WHERE tag=?", (tag,)).fetchall()
    return {r["code"]: r["mark"] for r in rows}


def set_tag_mark(tag: str, code: str, mark: str | None) -> None:
    with _lock, conn() as c:
        if mark in ("pin", "hide"):
            c.execute(
                "INSERT INTO tag_marks(tag,code,mark,created_at) VALUES(?,?,?,?)"
                " ON CONFLICT(tag,code) DO UPDATE SET mark=excluded.mark,"
                " created_at=excluded.created_at",
                (tag, code, mark, now_bj()),
            )
        else:
            c.execute("DELETE FROM tag_marks WHERE tag=? AND code=?", (tag, code))


def upsert_stock(payload: dict, code: str | None = None) -> dict:
    code = code or payload["code"]
    with _lock, conn() as c:
        row = c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
        if row is None:
            # 新加的股票默认给最高优先级 A（持仓不走这套，靠 bucket=hold 单独展示）
            _bucket = payload.get("bucket", "watch")
            _prio = _priority(payload.get("priority")) or ("A" if _bucket != "hold" else "")
            cur = c.execute(
                "INSERT INTO stocks(code,name,group_id,shares,cost,tags,custom_tags,note,focus,priority,sort,created_at,bucket,dca)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (code, payload.get("name", code), payload.get("group_id"),
                 payload.get("shares", 0), payload.get("cost"),
                 json.dumps(_tag_list(payload.get("tags", [])), ensure_ascii=False),
                 json.dumps(_tag_list(payload.get("custom_tags", [])), ensure_ascii=False),
                 payload.get("note", ""),
                 str(payload.get("focus") or "")[:500],
                 _prio,
                 c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM stocks").fetchone()[0],
                 now_bj(), _bucket, float(payload.get("dca") or 0)),
            )
            new = c.execute("SELECT * FROM stocks WHERE id=?", (cur.lastrowid,)).fetchone()
        else:
            c.execute(
                "UPDATE stocks SET name=?, group_id=?, shares=?, cost=?, tags=?, custom_tags=?,"
                " note=?, focus=?, priority=?, bucket=?, dca=? WHERE code=?",
                (payload.get("name", row["name"]),
                 payload.get("group_id", row["group_id"]),
                 payload.get("shares", row["shares"]),
                 payload.get("cost", row["cost"]),
                 json.dumps(_tag_list(payload.get("tags", _json_list(row["tags"]))), ensure_ascii=False),
                 json.dumps(_tag_list(payload.get("custom_tags", _json_list(row["custom_tags"]))),
                            ensure_ascii=False),
                 payload.get("note", row["note"]),
                 str(payload["focus"])[:500] if payload.get("focus") is not None else (row["focus"] or ""),
                 _priority(payload.get("priority", row["priority"])),
                 payload.get("bucket", row["bucket"] or "watch"),
                 float(payload.get("dca", row["dca"] if "dca" in row.keys() else 0) or 0),
                 code),
            )
            new = c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
    return _row(new)


def set_external_tags(code: str, tags: list[str]) -> dict | None:
    """替换已存在个股的外网 API 标签（最多 4 个）。

    不存在就返回 None（后台补标签不能把已删的股票写回来）；抓取失败返回空列表时
    保留旧标签，避免一次网络抖动把已有标签清空。
    """
    new_tags = _tag_list(tags)[:4]
    if not new_tags:
        return get_stock(code)
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
        if not r:
            return None
        c.execute("UPDATE stocks SET tags=? WHERE code=?",
                  (json.dumps(new_tags, ensure_ascii=False), code))
        return _row(c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone())


def set_bucket(code: str, bucket: str) -> dict | None:
    if bucket not in ("hold", "watch"):
        return None
    with _lock, conn() as c:
        c.execute("UPDATE stocks SET bucket=? WHERE code=?", (bucket, code))
        r = c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
    return _row(r) if r else None


def related_notes(code: str) -> dict:
    """这只股相关的笔记：显式关联的（linked=True）+ 正文提到名字的；删除个股时只删前者。"""
    with conn() as c:
        r = c.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
        name = (r["name"] or "") if r else ""
        rows = c.execute(
            "SELECT id, content, created_at, kind, COALESCE(stock_code,'') AS sc FROM notes"
            " WHERE deleted=0 AND (stock_code=? OR (? != '' AND content LIKE ?))"
            " ORDER BY created_at DESC LIMIT 100",
            (code, name, f"%{name}%"),
        ).fetchall()
    items = [{"id": x["id"], "kind": x["kind"], "linked": x["sc"] == str(code),
              "title": re.sub(r"\s+", " ", x["content"] or "").strip()[:80],
              "created_at": x["created_at"]} for x in rows]
    return {
        "code": code, "name": name, "count": len(items),
        "linked_count": sum(1 for x in items if x["linked"]), "items": items,
    }


def delete_stock(code: str, with_notes: bool = False) -> int:
    """删个股；with_notes=True 时把「显式关联」它的笔记一起进回收站。返回删掉的笔记数。"""
    removed = 0
    linked = [x for x in related_notes(code)["items"] if x["linked"]]
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM stocks WHERE code=?", (code,)).fetchone()
        if r:
            _trash_add(c, "stock", r)
        c.execute("DELETE FROM stocks WHERE code=?", (code,))
        c.execute("DELETE FROM stock_flags WHERE code=?", (code,))
    if with_notes:
        for it in linked:
            try:
                delete_note(int(it["id"]))
                removed += 1
            except Exception:
                continue
        return removed
    # 不删笔记也要断开关联，免得留个指向已删个股的代码
    for it in linked:
        try:
            update_note(int(it["id"]), stock_code="")
        except Exception:
            continue
    return 0


# ---------- groups（保留兼容，前端已改用标签） ----------
def list_groups() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT g.*, (SELECT COUNT(*) FROM stocks s WHERE s.group_id=g.id) AS count"
            " FROM groups g ORDER BY g.sort, g.id"
        ).fetchall()
    return [dict(r) for r in rows]


def create_group(name: str, color: str = "#0a84ff") -> dict:
    with _lock, conn() as c:
        cur = c.execute(
            "INSERT INTO groups(name,color,sort,created_at) VALUES(?,?,?,?)",
            (name, color, c.execute("SELECT COALESCE(MAX(sort),0)+1 FROM groups").fetchone()[0], now_bj()),
        )
        return dict(c.execute("SELECT * FROM groups WHERE id=?", (cur.lastrowid,)).fetchone())


def update_group(gid: int, name=None, color=None, sort=None) -> dict | None:
    with _lock, conn() as c:
        row = c.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE groups SET name=?, color=?, sort=? WHERE id=?",
            (name if name is not None else row["name"],
             color if color is not None else row["color"],
             sort if sort is not None else row["sort"], gid),
        )
        return dict(c.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone())


def delete_group(gid: int) -> None:
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
        if r:
            _trash_add(c, "group", r)
        c.execute("DELETE FROM groups WHERE id=?", (gid,))


# ---------- alerts ----------
ALERT_KINDS = ("up", "down", "pct")


def list_price_alerts(active_only: bool = False) -> list[dict]:
    sql = "SELECT * FROM alerts" + (" WHERE active=1" if active_only else "") + " ORDER BY created_at DESC"
    with conn() as c:
        return [dict(r) for r in c.execute(sql)]


def get_price_alert(code: str, kind: str) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM alerts WHERE code=? AND kind=?", (code, kind)).fetchone()
    return dict(r) if r else None


def upsert_price_alert(code: str, name: str, kind: str, value: float) -> dict:
    if kind not in ALERT_KINDS:
        raise ValueError("kind 只支持 up / down / pct")
    with _lock, conn() as c:
        c.execute(
            "INSERT INTO alerts(code,name,kind,value,active,created_at) VALUES(?,?,?,?,1,?)"
            # 改阈值就重新武装一次，否则把「涨到 5」改到 6 时，价格已经在 6 以上却永远不会响
            " ON CONFLICT(code,kind) DO UPDATE SET value=excluded.value, active=1, name=excluded.name,"
            " armed=CASE WHEN alerts.value<>excluded.value THEN 1 ELSE alerts.armed END",
            (code, name or code, kind, float(value), now_bj()),
        )
        return dict(c.execute("SELECT * FROM alerts WHERE code=? AND kind=?", (code, kind)).fetchone())


def delete_price_alert(aid: int) -> None:
    with _lock, conn() as c:
        c.execute("DELETE FROM alerts WHERE id=?", (aid,))


def _alert_gap_ok(last: str, ts: str, minutes: int = 30) -> bool:
    """距上次触发是否已过冷却时间（分钟）。时间都是北京时间字符串。"""
    if not last:
        return True
    try:
        a = datetime.strptime(last[:19], "%Y-%m-%d %H:%M:%S")
        b = datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return True
    return (b - a).total_seconds() >= minutes * 60


def fire_price_alert(alert_id: int, price: float) -> dict | None:
    """触发一次：写事件 + 记 last_fired。条件没回落的这段时间里不再重复发（边沿触发）。"""
    ts = now_bj()
    with _lock, conn() as c:
        a = c.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not a:
            return None
        if not int(a["armed"] if a["armed"] is not None else 1):
            return None
        if not _alert_gap_ok(a["last_fired"] or "", ts):
            return None
        c.execute("UPDATE alerts SET last_fired=?, armed=0 WHERE id=?", (ts, alert_id))
        cur = c.execute(
            "INSERT INTO alert_events(alert_id,code,name,kind,value,price,fired_at) VALUES(?,?,?,?,?,?,?)",
            (alert_id, a["code"], a["name"], a["kind"], a["value"], price, ts),
        )
        return dict(c.execute("SELECT * FROM alert_events WHERE id=?", (cur.lastrowid,)).fetchone())


def arm_price_alert(alert_id: int) -> None:
    """条件回落：重新武装，等下一次命中再发。已经是武装状态就不写库。"""
    with _lock, conn() as c:
        c.execute("UPDATE alerts SET armed=1 WHERE id=? AND armed=0", (alert_id,))


def list_price_alert_events(limit: int = 50, unread_only: bool = False) -> list[dict]:
    sql = "SELECT * FROM alert_events" + (" WHERE read_at IS NULL" if unread_only else "") \
        + " ORDER BY fired_at DESC LIMIT ?"
    with conn() as c:
        return [dict(r) for r in c.execute(sql, (int(limit),))]


def mark_price_alert_events_read() -> int:
    with _lock, conn() as c:
        cur = c.execute("UPDATE alert_events SET read_at=? WHERE read_at IS NULL", (now_bj(),))
        return cur.rowcount


# ---------- notes ----------
def list_notes(tag: str | None = None, q: str | None = None, code: str | None = None,
               kind: str | None = None, limit: int = 300, day: str | None = None,
               stage: str | None = None) -> list[dict]:
    sql = "SELECT * FROM notes WHERE deleted=0"
    args: list = []
    if stage:
        sql += " AND stage=?"
        args.append(stage)
    if day:
        sql += " AND substr(created_at,1,10)=?"
        args.append(day)
    if code:
        sql += " AND stock_code=?"
        args.append(code)
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    if q:
        sql += " AND content LIKE ?"
        args.append(f"%{q}%")
    sql += " ORDER BY pinned DESC, created_at DESC LIMIT ?"
    args.append(limit)
    with conn() as c:
        rows = [_row(r) for r in c.execute(sql, args).fetchall()]
    if tag:
        rows = [r for r in rows if tag in r["tags"]]
    return rows


def add_note(content: str, tags: list[str], stock_code: str | None, kind: str = "idea",
             when: str | None = None, stage: str | None = None) -> dict:
    """when：记录时间，自动记录用行情时间传进来（盘前补跑不会写成"现在"）。"""
    with _lock, conn() as c:
        ts = when or now_bj()
        cur = c.execute(
            "INSERT INTO notes(created_at,updated_at,content,tags,stock_code,pinned,deleted,kind,stage)"
            " VALUES(?,?,?,?,?,0,0,?,?)",
            (ts, ts, content, json.dumps(tags, ensure_ascii=False), stock_code, kind,
             (stage or "idea")),
        )
        r = c.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()
    row = _row(r)
    try:
        flag_scan_note(row["id"], row["content"], row["stock_code"], row["created_at"])
    except Exception:
        pass
    return row


def update_note(nid: int, content=None, tags=None, pinned=None, stock_code=None, kind=None,
                answer=None, memo=None, stage=None) -> dict | None:
    with _lock, conn() as c:
        row = c.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if not row:
            return None
        old_content = row["content"]
        old_code = row["stock_code"]
        new_answer = answer if answer is not None else row["answer"]
        answered_at = row["answered_at"]
        if answer is not None:
            answered_at = now_bj() if (answer or "").strip() else None
        c.execute(
            "UPDATE notes SET content=?, tags=?, pinned=?, stock_code=?, kind=?, answer=?, answered_at=?,"
            " memo=?, stage=?, updated_at=? WHERE id=?",
            (content if content is not None else row["content"],
             json.dumps(tags, ensure_ascii=False) if tags is not None else row["tags"],
             pinned if pinned is not None else row["pinned"],
             stock_code if stock_code is not None else row["stock_code"],
             kind if kind is not None else row["kind"],
             new_answer, answered_at,
             memo if memo is not None else row["memo"],
             (stage if stage is not None else (row["stage"] or "idea")),
             now_bj(), nid),
        )
        r = c.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    row = _row(r)
    # 内容或关联个股变了：先删掉这条笔记旧的红标，再按新内容重建
    if (content is not None and content != old_content) or (stock_code is not None and stock_code != old_code):
        try:
            flag_clear_ref(f"note:{nid}")
        except Exception:
            pass
    try:
        flag_scan_note(row["id"], row["content"], row["stock_code"], row["updated_at"])
    except Exception:
        pass
    return row


def delete_note(nid: int) -> None:
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
        if r:
            _trash_add(c, "note", r)
            if r["news_id"]:  # 删掉这条记录 = 不再是收藏
                c.execute("UPDATE news SET saved=0 WHERE id=?", (r["news_id"],))
        c.execute("UPDATE notes SET deleted=1, updated_at=? WHERE id=?", (now_bj(), nid))
    try:
        flag_clear_ref(f"note:{nid}")
    except Exception:
        pass


def _news_ts(r) -> str:
    """news 行的时间 → notes.created_at（19 位）；只有分钟时补 :00。"""
    ts = str(r["published_at"] or r["created_at"] or (r["day"] + " 00:00:00"))[:19]
    return ts + ":00" if len(ts) == 16 else ts


def _backfill_saved_notes(c) -> None:
    """收藏新闻迁进 notes（幂等）：saved=1 但还没有对应记录时补一条 kind='news'。"""
    try:
        rows = c.execute(
            "SELECT n.* FROM news n WHERE n.saved=1 AND NOT EXISTS"
            " (SELECT 1 FROM notes t WHERE t.news_id=n.id AND t.deleted=0)"
        ).fetchall()
    except sqlite3.OperationalError:  # 老库还没加列
        return
    for r in rows:
        c.execute(
            "INSERT INTO notes(created_at,updated_at,content,tags,stock_code,pinned,deleted,kind,memo,news_id)"
            " VALUES(?,?,?,'[]',?,0,0,'news',?,?)",
            (_news_ts(r), now_bj(), r["title"], r["stock_code"], r["memo"] or "", r["id"]),
        )


def _sync_saved_note(c, nid: int) -> None:
    """收藏/取消收藏时同步 notes 里那条「新闻记录」：收藏=建/更新，取消收藏=删。"""
    r = c.execute("SELECT * FROM news WHERE id=?", (nid,)).fetchone()
    if not r:
        return
    note = c.execute("SELECT id FROM notes WHERE news_id=? AND deleted=0", (nid,)).fetchone()
    if r["saved"]:
        if note:
            c.execute(
                "UPDATE notes SET content=?, stock_code=?, memo=?, updated_at=? WHERE id=?",
                (r["title"], r["stock_code"], r["memo"] or "", now_bj(), note["id"]),
            )
        else:
            c.execute(
                "INSERT INTO notes(created_at,updated_at,content,tags,stock_code,pinned,deleted,kind,memo,news_id)"
                " VALUES(?,?,?,'[]',?,0,0,'news',?,?)",
                (_news_ts(r), now_bj(), r["title"], r["stock_code"], r["memo"] or "", r["id"]),
            )
    elif note:
        c.execute("DELETE FROM notes WHERE id=?", (note["id"],))


def all_note_tags() -> list[str]:
    with conn() as c:
        rows = c.execute("SELECT tags FROM notes WHERE deleted=0").fetchall()
    tags: set[str] = set()
    for r in rows:
        try:
            tags.update(json.loads(r["tags"] or "[]"))
        except Exception:
            pass
    return sorted(tags)


def rename_tag(old: str, new: str) -> dict:
    """把标签改名：记录(notes.tags) 和个股自定义标签(stocks.custom_tags) 一起改。
    new 为空 = 删除这个标签（个股就变成未分类）。"""
    old, new = (old or "").strip(), (new or "").strip()
    if not old or old == new:
        return {"notes": 0, "stocks": 0}

    def _swap(raw: str | None) -> list[str] | None:
        try:
            tags = json.loads(raw or "[]")
        except Exception:
            return None
        if old not in tags:
            return None
        out: list[str] = []
        for t in tags:
            t = new if t == old else t
            if not t:
                continue          # new 为空时把这个标签抹掉
            if t not in out:
                out.append(t)
        return out

    n = m = 0
    with _lock, conn() as c:
        for r in c.execute("SELECT id,tags FROM notes").fetchall():
            swapped = _swap(r["tags"])
            if swapped is not None:
                c.execute("UPDATE notes SET tags=?, updated_at=? WHERE id=?",
                          (json.dumps(swapped, ensure_ascii=False), now_bj(), r["id"]))
                n += 1
        for r in c.execute("SELECT code,custom_tags FROM stocks").fetchall():
            swapped = _swap(r["custom_tags"])
            if swapped is not None:
                c.execute("UPDATE stocks SET custom_tags=? WHERE code=?",
                          (json.dumps(swapped, ensure_ascii=False), r["code"]))
                m += 1
    return {"notes": n, "stocks": m}


def note_days(limit: int = 40) -> list[str]:
    """有记录的日子（新→旧），给想法页做日期选择。"""
    with conn() as c:
        rows = c.execute(
            "SELECT DISTINCT substr(created_at,1,10) AS d FROM notes WHERE deleted=0"
            " ORDER BY d DESC LIMIT ?", (limit,)
        ).fetchall()
    return [r["d"] for r in rows if r["d"]]


def note_counts_by_stock() -> dict[str, int]:
    """每只股「显式关联」的想法/笔记数量（用于列表上的小图标）。"""
    with conn() as c:
        rows = c.execute(
            "SELECT stock_code, COUNT(*) AS n FROM notes"
            " WHERE deleted=0 AND stock_code IS NOT NULL AND stock_code != ''"
            " GROUP BY stock_code"
        ).fetchall()
    return {r["stock_code"]: int(r["n"]) for r in rows}


# ---------- 新闻总结（每天 08:00 / 20:00 各一张：上一张卡以来的新闻分领域汇总） ----------
DIGEST_KEEP_DAYS = 30  # 用户要求：故事线看更长周期；留最近 30 天（每天早/晚两张，最多 60 张）供跨卡反查
DIGEST_SLOTS = ("am", "pm")


def prune_digests(keep_days: int = DIGEST_KEEP_DAYS) -> int:
    """删掉早于「今天-(keep_days-1)」的总结卡片，只留最近 keep_days 天。"""
    cutoff = (datetime.now(BJ) - timedelta(days=max(0, keep_days - 1))).strftime("%Y-%m-%d")
    with _lock, conn() as c:
        n = c.execute("SELECT COUNT(*) FROM news_digest WHERE day < ?", (cutoff,)).fetchone()[0]
        c.execute("DELETE FROM news_digest WHERE day < ?", (cutoff,))
        # 用户选择「标注随总结一起清理」：卡片过期后，上面的标红 / 批注也一起走
        c.execute("DELETE FROM digest_marks WHERE day < ?", (cutoff,))
    return n


def upsert_digest(day: str, content: str, total: int = 0, slot: str = "am",
                  window_start: str = "", window_end: str = "") -> dict:
    slot = (slot or "am").strip().lower()
    if slot not in DIGEST_SLOTS:
        raise ValueError(f"bad digest slot: {slot!r}")
    ts = now_bj()
    with _lock, conn() as c:
        c.execute(
            "INSERT INTO news_digest(day,slot,content,total,window_start,window_end,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?)"
            " ON CONFLICT(day,slot) DO UPDATE SET content=excluded.content, total=excluded.total,"
            " window_start=excluded.window_start, window_end=excluded.window_end,"
            " updated_at=excluded.updated_at",
            (day, slot, content, int(total or 0), window_start or "", window_end or "", ts, ts),
        )
        r = c.execute("SELECT * FROM news_digest WHERE day=? AND slot=?", (day, slot)).fetchone()
    prune_digests()
    return _row(r)


def get_digest(day: str, slot: str = "am") -> dict | None:
    """取某天某个时段的一张总结；语音朗读按 day+slot 取正文做缓存键。"""
    with conn() as c:
        r = c.execute("SELECT * FROM news_digest WHERE day=? AND slot=?", (day, slot)).fetchone()
    return _row(r) if r else None


def list_digests(frm: str | None = None, to: str | None = None, limit: int = 60) -> list[dict]:
    sql = "SELECT * FROM news_digest WHERE 1=1"
    args: list = []
    if frm:
        sql += " AND day>=?"
        args.append(frm)
    if to:
        sql += " AND day<=?"
        args.append(to)
    # 同一天晚班（pm）排在早班（am）前面，最新一张永远在最上面
    sql += " ORDER BY day DESC, slot DESC LIMIT ?"
    args.append(limit)
    with conn() as c:
        return [_row(r) for r in c.execute(sql, args).fetchall()]


def count_digests(frm: str | None = None, to: str | None = None) -> int:
    """当前保留的总结卡片总数（前端「查看更多」用真实总数，不按已加载条数算）。"""
    sql = "SELECT COUNT(*) FROM news_digest WHERE 1=1"
    args: list = []
    if frm:
        sql += " AND day>=?"
        args.append(frm)
    if to:
        sql += " AND day<=?"
        args.append(to)
    with conn() as c:
        return int(c.execute(sql, args).fetchone()[0])


def delete_digest(day: str, slot: str | None = None) -> bool:
    with _lock, conn() as c:
        if slot:
            cur = c.execute("DELETE FROM news_digest WHERE day=? AND slot=?", (day, slot))
            c.execute("DELETE FROM digest_marks WHERE day=? AND slot=?", (day, slot))
        else:
            cur = c.execute("DELETE FROM news_digest WHERE day=?", (day,))
            c.execute("DELETE FROM digest_marks WHERE day=?", (day,))
    return cur.rowcount > 0


# ---------- 新闻总结标注（标红 / 下划线 / 批注） ----------
DIGEST_MARK_STYLES = ("red", "underline", "note")


def list_digest_marks(frm: str | None = None, to: str | None = None,
                      q: str | None = None, limit: int = 500) -> list[dict]:
    sql = "SELECT * FROM digest_marks WHERE 1=1"
    args: list = []
    if frm:
        sql += " AND day>=?"
        args.append(frm)
    if to:
        sql += " AND day<=?"
        args.append(to)
    if q:
        sql += " AND (quote LIKE ? OR note LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY day DESC, slot DESC, block, start_off, id LIMIT ?"
    args.append(max(1, min(int(limit or 500), 2000)))
    with conn() as c:
        return [_row(r) for r in c.execute(sql, args).fetchall()]


def add_digest_mark(day: str, slot: str, block: str, start_off: int, end_off: int,
                    quote: str, style: str = "red", note: str = "") -> dict:
    slot = (slot or "am").strip().lower()
    style = (style or "red").strip().lower()
    if slot not in DIGEST_SLOTS:
        raise ValueError(f"bad digest slot: {slot!r}")
    if style not in DIGEST_MARK_STYLES:
        raise ValueError(f"bad digest mark style: {style!r}")
    ts = now_bj()
    with _lock, conn() as c:
        cur = c.execute(
            "INSERT INTO digest_marks(day,slot,block,start_off,end_off,quote,style,note,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (day, slot, block, int(start_off), int(end_off), quote, style, note or "", ts, ts),
        )
        r = c.execute("SELECT * FROM digest_marks WHERE id=?", (cur.lastrowid,)).fetchone()
    return _row(r)


def update_digest_mark(mid: int, style: str | None = None, note: str | None = None) -> dict | None:
    with _lock, conn() as c:
        row = c.execute("SELECT * FROM digest_marks WHERE id=?", (mid,)).fetchone()
        if not row:
            return None
        new_style = (style or "").strip().lower() if style is not None else row["style"]
        if new_style not in DIGEST_MARK_STYLES:
            raise ValueError(f"bad digest mark style: {new_style!r}")
        c.execute(
            "UPDATE digest_marks SET style=?, note=?, updated_at=? WHERE id=?",
            (new_style, note if note is not None else row["note"], now_bj(), mid),
        )
        r = c.execute("SELECT * FROM digest_marks WHERE id=?", (mid,)).fetchone()
    return _row(r)


def delete_digest_mark(mid: int) -> bool:
    with _lock, conn() as c:
        cur = c.execute("DELETE FROM digest_marks WHERE id=?", (mid,))
    return cur.rowcount > 0


def news_between(start: str, end: str, limit: int = 4000) -> list[dict]:
    """按发布时间的闭区间取新闻（新闻总结的取数口）。"""
    with conn() as c:
        rows = c.execute(
            "SELECT id,day,category,title,body,source,level,published_at,created_at FROM news"
            " WHERE COALESCE(published_at, created_at) >= ? AND COALESCE(published_at, created_at) <= ?"
            " ORDER BY COALESCE(published_at, created_at) ASC LIMIT ?",
            (start, end, limit),
        ).fetchall()
    return [_row(r) for r in rows]


# ---------- 今日关注（从当天早/午/晚报告里按个股提取） ----------
_FOCUS_EXACT = (
    "今日关注：", "今日关注:", "今日重点看：", "今日重点看:",
    "今日重点：", "今日重点:", "触发条件：", "触发条件:",
    "关注：", "关注:",
)
_FOCUS_ACTION = ("冲高", "跌破", "突破", "失守", "支撑", "压力", "涨停", "封住", "止跌", "方向", "回封")
_focus_cache: tuple[float, tuple, dict[str, str]] = (0.0, (), {})


def _focus_clean(seg: str, limit: int = 180) -> str:
    seg = re.sub(r"\s+", " ", seg or "").replace("**", "").strip(" ：:-—")
    for stop in ("数据说明", "数据源说明", "最大风险", "风险提示"):
        i = seg.find(stop)
        if i > 0:
            seg = seg[:i].strip()
    # 「A、B，以及 C」型长句只留下和这只股有关的前半句
    i = seg.find("，以及")
    if i >= 8:
        seg = seg[:i].strip()
    if len(seg) > limit:
        cut = max(seg.rfind("。", 0, limit), seg.rfind("；", 0, limit))
        seg = seg[:cut + 1] if cut >= 40 else seg[:limit].rstrip() + "…"
    return seg


def _focus_candidate(line: str, code: str, name: str) -> tuple[int, str] | None:
    """从报告的一行里提取「这只股今天要盯什么」；没有可操作信息就返回 None。"""
    s = (line or "").strip()
    if len(s) < 8 or (name not in s and code not in s):
        return None
    plain = re.sub(r"^\s*(?:[-*•·]|\d{1,2}[.)、])\s*", "", s.replace("**", ""))
    anchor = len(plain)
    for needle in (name, code):
        i = plain.find(needle)
        if i >= 0:
            anchor = min(anchor, i)

    seg = None
    marker = ""
    for m in _FOCUS_EXACT:
        i = plain.find(m)
        if i >= 0:
            seg, marker = plain[i + len(m):], m
            break
    if seg is None:
        # 「关注大业股份能否…」这种，要求「关注」后面紧跟着这只股
        for m in re.finditer("关注", plain):
            after = plain[m.end():]
            if after.startswith(("点", "度")):
                continue
            if after[:1] in ("：", ":"):
                seg, marker = after[1:], "关注"
                break
            if name in after[:16] or code in after[:16]:
                seg, marker = after, "关注"
                break
    if seg is None:
        for m in ("观察", "盯", "若"):
            i = plain.find(m)
            if i < 0 or plain[i:i + 3] == "观察点" or plain[i:i + 4] == "观察名单":
                continue
            if i < anchor and name not in plain[i + len(m):i + len(m) + 10] \
                    and code not in plain[i + len(m):i + len(m) + 10]:
                continue
            seg, marker = plain[i:], m
            break
    if seg is None:
        return None
    seg = _focus_clean(seg)
    if len(seg) < 4:
        return None

    score = 0
    if marker.startswith(("今日关注", "今日重点", "触发条件")):
        score += 6
    elif marker in ("观察", "盯"):
        score += 4
    elif marker == "若":
        score += 3
    else:
        score += 2
    if plain.startswith(name) or re.match(rf"^{re.escape(name)}\s*[（(]?{re.escape(code)}", plain):
        score += 6
    if re.search(r"\d+\.\d+", seg):
        score += 2
    if any(k in seg for k in _FOCUS_ACTION):
        score += 2
    if "若" in seg:
        score += 1
    return score, seg


def stock_focus_map() -> dict[str, str]:
    """最新一个报告日里，每只持仓/关注股的「今日关注」。

    同时看盘前/午间/盘后：盘后优先，其次午间、盘前；每只股取最有信息量的一条
    （例如「若冲高回落跌破 10.16 元，说明是分歧转一致失败」）。结果缓存 2 分钟。
    """
    global _focus_cache
    with conn() as c:
        stocks = [dict(r) for r in c.execute("SELECT code, name FROM stocks ORDER BY sort, id")]
        day_row = c.execute("SELECT MAX(day) AS d FROM reports").fetchone()
        day = day_row["d"] if day_row else None
        reports = []
        prev_post = None
        if day:
            reports = [dict(r) for r in c.execute(
                "SELECT id, kind, content, created_at FROM reports WHERE day=?"
                " ORDER BY CASE kind WHEN 'post' THEN 3 WHEN 'mid' THEN 2 ELSE 1 END DESC, id DESC",
                (day,),
            )]
            # 今天盘后还没出时，昨晚盘后的「明日观察」就是今天的关注
            if not any(r["kind"] == "post" for r in reports):
                prev_post = c.execute(
                    "SELECT id, kind, content, created_at FROM reports"
                    " WHERE day < ? AND kind='post' ORDER BY day DESC, id DESC LIMIT 1",
                    (day,),
                ).fetchone()
                prev_post = dict(prev_post) if prev_post else None
    scan = reports + ([prev_post] if prev_post else [])
    key = (
        tuple((r["id"], r["created_at"], len(r["content"])) for r in scan),
        tuple(s["code"] for s in stocks),
    )
    now = time.time()
    if _focus_cache[0] and now - _focus_cache[0] < 120 and _focus_cache[1] == key:
        return dict(_focus_cache[2])

    out: dict[str, str] = {}
    for st in stocks:
        best: tuple[int, str] | None = None
        for r in reports:
            for line in (r["content"] or "").splitlines():
                cand = _focus_candidate(line, st["code"], st["name"])
                if cand and (best is None or cand[0] > best[0]):
                    best = cand
        if best is None and prev_post:
            for line in (prev_post["content"] or "").splitlines():
                cand = _focus_candidate(line, st["code"], st["name"])
                if cand and (best is None or cand[0] > best[0]):
                    best = cand
        if best:
            out[st["code"]] = best[1]
    _focus_cache = (now, key, out)
    return dict(out)


# ---------- reports ----------
# 标题分隔符模型常漂移：`【盘前简报 · 2026-10-27】`、`**盘前简报 · 2026-10-27 周二**`、
# 甚至裸写的 `盘前简报 · 2026-10-27` 都要能认，否则 cron 成功但当天报告进不了库。
REPORT_HEAD = re.compile(r"[【\*\[]?\s*(盘前简报|午间速报|盘中简报|盘后复盘)\s*[·・]\s*(\d{4}-\d{2}-\d{2})")
KIND_MAP = {"盘前简报": "pre", "午间速报": "mid", "盘中简报": "mid", "盘后复盘": "post"}
KIND_SQL = "CASE kind WHEN 'post' THEN 2 WHEN 'mid' THEN 1 ELSE 0 END"
KIND_LABEL = {"pre": "盘前", "mid": "午间", "post": "盘后"}
KIND_RANK = {"post": 3, "mid": 2, "pre": 1}

# 报告小标题：`**一、指数与量能**` / `一、宏观与事件（最高优先级）` / `### 三、热门板块...`
SECTION_HEAD = re.compile(
    r"^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?\s*([一二三四五六七八九十]{1,3})、\s*(.*?)\s*(?:\*\*)?\s*$"
)


def _split_sections(text: str) -> list[tuple[int, str, str]]:
    """把报告正文按「一、二、三」小标题切开，返回 [(序号, 标题, 正文)]。"""
    out: list[tuple[int, str, str]] = []
    idx, title, buf = 0, "", []
    started = False

    def flush():
        if started:
            out.append((idx, title, "\n".join(buf).strip()))

    for line in (text or "").splitlines():
        m = SECTION_HEAD.match(line)
        # 正文里以「一、」开头的长句不算标题（报告小标题一般不超过 40 字）
        if m and len(line.strip()) <= 60:
            flush()
            idx = "一二三四五六七八九十".find(m.group(1)[0]) + 1 if len(m.group(1)) == 1 else 11
            title, buf, started = m.group(2).strip("* ").strip(), [], True
        elif started:
            buf.append(line)
    flush()
    return out


def _section_role(kind: str, idx: int, title: str) -> str:
    """报告小标题 → 站点用途：macro（宏观政策）/ market（大盘行情）/ hot（热门板块）/ stock（个股）。"""
    t = title or ""
    if "热门" in t or "题材为什么火" in t:
        return "hot"
    if "指数与量能" in t or "上午盘面" in t:
        return "market"
    if ("持仓" in t or "关注池" in t or "个股" in t) and ("个股" in t or "表现" in t or "专项" in t or "异动" in t):
        return "stock"
    if kind == "pre" and idx == 1:
        return "macro"
    return ""


def _stock_blocks(content: str) -> list[tuple[str, str]]:
    """个股段落 → [(块正文)]；调用方再按持仓/关注名单匹配代码。"""
    blocks: list[str] = []
    cur: list[str] = []

    def flush():
        if cur:
            blocks.append("\n".join(cur).strip())
            cur.clear()

    for raw in (content or "").splitlines():
        s = raw.strip()
        if not s:
            flush()
            continue
        # markdown 表格行不进个股卡片：个股卡片只放文字叙述，表格原文会显示成「| 名称(代码) | 收盘 |…」
        if s.startswith("|"):
            flush()
            continue
        new = bool(re.match(r"^[-*•]\s+", s)) or bool(re.match(r"^\*\*[^*]{1,40}[（(][0-9A-Za-z]{4,8}[）)]", s))
        if new:
            flush()
        cur.append(s)
    flush()
    return blocks


def _index_report(c: sqlite3.Connection, rid: int, day: str, kind: str,
                  content: str, created_at: str) -> None:
    """把一份报告拆成 macro/market/hot + 每只股的 stock 段落，覆盖写入 report_sections。"""
    c.execute("DELETE FROM report_sections WHERE report_id=?", (rid,))
    stocks = [dict(r) for r in c.execute("SELECT code,name FROM stocks ORDER BY sort,id")]
    for idx, title, body in _split_sections(content):
        role = _section_role(kind, idx, title)
        if not role:
            continue
        if role != "stock":
            if body:
                c.execute(
                    "INSERT OR REPLACE INTO report_sections(report_id,section,stock_code,day,kind,title,content,created_at)"
                    " VALUES(?,?,?,?,?,?,?,?)",
                    (rid, role, "", day, kind, title, body[:6000], created_at),
                )
            continue
        for block in _stock_blocks(body):
            head = block[:120]
            hit = None
            for st in stocks:
                if st["name"] and st["name"] in head:
                    if hit is None or head.find(st["name"]) < head.find(hit["name"]):
                        hit = st
                elif st["code"] in head and hit is None:
                    hit = st
            if not hit:
                continue
            text = re.sub(r"^[-*•]\s+", "", block).strip()
            if len(text) < 8:
                continue
            c.execute(
                "INSERT INTO report_sections(report_id,section,stock_code,day,kind,title,content,created_at)"
                " VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT(report_id,section,stock_code) DO UPDATE SET"
                " content=report_sections.content || '\n\n' || excluded.content",
                (rid, "stock", hit["code"], day, kind, hit["name"], text[:1500], created_at),
            )


def rebuild_sections() -> int:
    """重建全部报告的拆段（改了解析规则或首次上线时跑一次）。"""
    n = 0
    with _lock, conn() as c:
        rows = [dict(r) for r in c.execute("SELECT id,day,kind,content,created_at FROM reports")]
        for r in rows:
            _index_report(c, r["id"], r["day"], r["kind"], r["content"], r["created_at"])
            n += 1
    return n


def list_sections(section: str, limit: int = 8) -> list[dict]:
    """某个用途的最新报告段落（新的在前；同一天 盘后 > 午间 > 盘前）。"""
    with conn() as c:
        rows = c.execute(
            "SELECT report_id AS id, day, kind, title, content, created_at FROM report_sections"
            " WHERE section=? AND stock_code=''"
            " ORDER BY day DESC, " + KIND_SQL.replace("kind", "kind") + " DESC, report_id DESC LIMIT ?",
            (section, max(1, limit)),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["label"] = f"{KIND_LABEL.get(d['kind'], '报告')} {d['day'][5:]}"
        out.append(d)
    return out


def stock_sections(codes: list[str], limit: int = 6) -> dict[str, list[dict]]:
    """每只股的历次个股分析（新的在前，同一天 盘后 > 午间 > 盘前）。"""
    codes = [str(x) for x in (codes or []) if x]
    if not codes:
        return {}
    marks = ",".join("?" for _ in codes)
    with conn() as c:
        rows = c.execute(
            "SELECT report_id AS id, stock_code AS code, day, kind, content, created_at"
            " FROM report_sections WHERE section='stock' AND stock_code IN (" + marks + ")"
            " ORDER BY day DESC, " + KIND_SQL + " DESC, report_id DESC",
            codes,
        ).fetchall()
    out: dict[str, list[dict]] = {c: [] for c in codes}
    for r in rows:
        d = dict(r)
        if len(out[d["code"]]) >= max(1, limit):
            continue
        d["label"] = f"{KIND_LABEL.get(d['kind'], '报告')} {d['day'][5:]}"
        out[d["code"]].append(d)
    return out


def list_manual_focus(limit: int = 200) -> list[dict]:
    """需关注里用户自己加的条目（不含日程；日程单独显示在最上面）。"""
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM news WHERE source='manual' AND category!='日程'"
            " ORDER BY day DESC, id DESC LIMIT ?", (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_news(nid: int) -> dict | None:
    """单条新闻（新闻总结引用跳转用）。"""
    with conn() as c:
        r = c.execute("SELECT * FROM news WHERE id=?", (nid,)).fetchone()
    return dict(r) if r else None


def news_by_ids(ids: list[int]) -> list[dict]:
    """批量取新闻（新闻总结的跨卡故事线用）。"""
    clean: list[int] = []
    for i in ids:
        try:
            clean.append(int(i))
        except (TypeError, ValueError):
            continue
    if not clean:
        return []
    out: list[dict] = []
    with conn() as c:
        for start in range(0, len(clean), 500):
            chunk = clean[start:start + 500]
            marks = ",".join("?" * len(chunk))
            out.extend(dict(r) for r in c.execute(
                f"SELECT * FROM news WHERE id IN ({marks})", chunk))
    return out


def update_news(nid: int, payload: dict) -> dict | None:
    """编辑需关注条目 / 日程 / 收藏新闻的笔记（标题、日期、分类、正文、memo）。"""
    fields, args = [], []
    for key in ("day", "category", "title", "body", "memo", "tag", "stock_code"):
        if key in payload:
            fields.append(f"{key}=?")
            args.append(str(payload.get(key) or ""))
    if not fields:
        return None
    with _lock, conn() as c:
        c.execute(f"UPDATE news SET {', '.join(fields)} WHERE id=?", [*args, nid])
        r = c.execute("SELECT * FROM news WHERE id=?", (nid,)).fetchone()
    return dict(r) if r else None


def hidden_events() -> set[str]:
    try:
        return set(json.loads(get_meta("event_hide", "[]") or "[]"))
    except Exception:
        return set()


def hide_event(day: str, title: str) -> None:
    keys = hidden_events()
    keys.add(f"{day}|{title}")
    set_meta("event_hide", json.dumps(sorted(keys), ensure_ascii=False))



def sync_reports() -> int:
    """扫描 cron 输出目录，把盘前/盘后报告导入数据库。返回新增/更新条数。

    文件按 (mtime_ns, size) 做签名，没变就跳过，避免每 5 分钟重读全部历史报告。
    """
    if not CRON_OUT.exists():
        return 0
    changed = 0
    # Hermes 新版 cron 把每次运行写成 output/<job_id>/YYYY-MM-DD_HH-MM-SS.md，
    # 旧版是顶层的 <job_id>_<时间>.txt。两种都要扫，否则新报告永远导不进来。
    try:
        files = sorted(set(CRON_OUT.glob("*.txt")) | set(CRON_OUT.rglob("*.md")))
    except OSError:
        files = sorted(CRON_OUT.glob("*.txt"))
    for f in files:
        try:
            st = f.stat()
            if not st.st_size:
                continue
        except OSError:
            continue
        sig = (st.st_mtime_ns, st.st_size)
        if _report_sig.get(str(f)) == sig:
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # .md 运行日志 = 头部元信息 + Prompt + "## Response"；只取回复正文。
        # 用 rsplit：prompt 里（比如记忆笔记）也可能出现 "## Response" 字样。
        if "## Response" in text:
            text = text.rsplit("## Response", 1)[1]
        m = REPORT_HEAD.search(text)
        if not m:
            _report_sig[str(f)] = sig
            continue
        kind = KIND_MAP[m.group(1)]
        day = m.group(2)
        if "-------------\n" in text:
            text = text.split("-------------\n", 1)[1]
        text = text.strip()
        text = re.sub(r"\n*✅[^\n]*已发送至微信[^\n]*", "", text)
        text = re.sub(r"\n*To stop or manage this job[^\n]*", "", text)
        text = text.strip()
        with _lock, conn() as c:
            row = c.execute("SELECT id, content FROM reports WHERE day=? AND kind=?", (day, kind)).fetchone()
            if row is None:
                cur = c.execute(
                    "INSERT INTO reports(day,kind,title,content,created_at) VALUES(?,?,?,?,?)",
                    (day, kind, f"{m.group(1)} · {day}", text, now_bj()),
                )
                _index_report(c, cur.lastrowid, day, kind, text, now_bj())
                changed += 1
            elif row["content"] != text:
                c.execute("UPDATE reports SET content=?, created_at=? WHERE id=?", (text, now_bj(), row["id"]))
                _index_report(c, row["id"], day, kind, text, now_bj())
                changed += 1
        _report_sig[str(f)] = sig
    # cron 输出目录会轮转/清理，顺手把已消失文件的签名删掉
    live = {str(f) for f in files}
    for p in [p for p in _report_sig if p not in live]:
        _report_sig.pop(p, None)
    if changed:
        try:
            extract_news()
        except Exception:
            pass
    # 首次上线拆段表或历史报告还没拆过：补一次，否则行情页的「热门分析/大盘分析」是空的
    try:
        with conn() as c:
            has = c.execute("SELECT 1 FROM report_sections LIMIT 1").fetchone()
            reps = c.execute("SELECT 1 FROM reports LIMIT 1").fetchone()
        if reps and not has:
            rebuild_sections()
    except Exception:
        pass
    return changed


def list_reports(kind: str | None = None, limit: int = 60) -> list[dict]:
    sql = "SELECT id,day,kind,title,created_at,length(content) AS size FROM reports"
    args: list = []
    if kind:
        sql += " WHERE kind=?"
        args.append(kind)
    sql += f" ORDER BY day DESC, {KIND_SQL} DESC LIMIT ?"
    args.append(limit)
    with conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def get_report(rid: int) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
    return dict(r) if r else None


def latest_report() -> dict | None:
    with conn() as c:
        r = c.execute(
            f"SELECT * FROM reports ORDER BY day DESC, {KIND_SQL} DESC LIMIT 1"
        ).fetchone()
    return dict(r) if r else None


def mark_read(rid: int) -> None:
    with _lock, conn() as c:
        c.execute("INSERT INTO report_reads(report_id, read_at) VALUES(?,?)"
                  " ON CONFLICT(report_id) DO UPDATE SET read_at=excluded.read_at", (rid, now_bj()))


def is_read(rid: int) -> bool:
    with conn() as c:
        return c.execute("SELECT 1 FROM report_reads WHERE report_id=?", (rid,)).fetchone() is not None


# ---------- news ----------
CATS = [
    ("战事", r"战事|冲突|导弹|无人机|袭击|空袭|开战|制裁|地缘|俄乌|乌克兰|俄罗斯|中东|以色列|伊朗|红海|霍尔木兹|军事|停火|谈判"),
    ("油价", r"油价|原油|布伦特|WTI|OPEC|欧佩克|成品油|汽油|柴油|天然气|能源价格|页岩油|炼厂"),
    ("政策", r"美联储|降息|加息|央行|LPR|降准|关税|财政部|证监会|国务院|发改委|非农|CPI|PPI|PMI|国债|财政"),
    ("行业", r"台积电|英伟达|算力|液冷|机器人|固态电池|储能|半导体|光模块|稀土|覆铜板|PCB|订单|中标"),
    ("市场", r"上证|深证|深成|创业板指|科创50|沪深300|成交额|涨跌家数|两市|大盘|北向|龙虎榜|指数|涨停家数|封板率"),
]
CAT_ORDER = {"热门板块": 0, "建议": 1, "战事": 2, "油价": 3, "政策": 4, "行业": 5, "市场": 6}
# 实时新闻正文上限：财联社电报常 200~1000 字，不要短截断（CLI/前端都按这个上限）
MAX_LIVE_TITLE = 4000
# 实时新闻库上限：约 1.5 个月（600~700 条/交易日），超了就按最旧删；收藏的永不删
LIVE_MAX_ROWS = 30000
MAX_PER_CAT = {"热门板块": 12, "战事": 6, "油价": 5, "政策": 6, "行业": 4, "市场": 4}
HOT_SEC = re.compile(r"(涨停|情绪|板块|主线|热门|题材|梯队|连板)")
HOT_LINE = re.compile(r"(涨停\s*\d|涨停\s*家|\d+\s*[天]?\s*\d*\s*板|连板|封板率|炸板|首板|封单|晋级率|空间高度|最高板)")
ADVICE_SEC = re.compile(r"(建议|策略|观察|结论|明日|应对|计划|风险|操作)")
HEADING = re.compile(r"^([一二三四五六七八九十]+[、.]|\d{1,2}[、.]|第[一二三四五六七八九十]+[、章节])")
BULLET = re.compile(r"^\s*([-*•·]|\d+[.)])\s*")
NUMISH = re.compile(r"\d")


def _clean(line: str) -> str:
    s = line.strip()
    s = BULLET.sub("", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"`(.+?)`", r"\1", s)
    s = s.replace("**", "").strip()
    return s.strip(" -—|*")


def _is_heading(s: str) -> bool:
    if not s or len(s) > 28:
        return False
    if HEADING.match(s):
        return True
    return s.endswith(("：", ":")) and len(s) <= 18


def extract_news() -> int:
    """从最近几天报告抽取：热门板块 / 战事 / 油价 / 政策 / 行业 / 建议。
    同一天以最新一份报告为准（午间 → 盘后覆盖），按天重建，幂等。"""
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM reports ORDER BY day DESC,"
            " CASE kind WHEN 'post' THEN 2 WHEN 'mid' THEN 1 ELSE 0 END DESC LIMIT 9"
        ).fetchall()]
    best: dict[str, dict] = {}
    for r in rows:
        best.setdefault(r["day"], r)

    added = 0
    for day in sorted(best):
        rep = best[day]
        picks: dict[str, list[tuple[int, str]]] = {}
        advice: list[str] = []
        in_advice = False
        in_hot = False
        for raw in rep["content"].splitlines():
            line = raw.strip()
            if not line:
                continue
            h = _clean(line)
            if _is_heading(h):
                in_advice = bool(ADVICE_SEC.search(h))
                in_hot = bool(HOT_SEC.search(h)) and not in_advice
                continue
            body = _clean(line)
            if len(body) < 10 or len(body) > 180:
                continue
            if body.startswith(("【", "数据源", "数据说明")) or "reason_type 聚合" in body:
                continue
            if re.search(r"非投资建议|风险自担|仅供参考|据此操作", body):
                continue
            if in_advice:
                if len(advice) < 8:
                    advice.append(body)
                continue
            # 热门板块：涨停梯队、封板/连板、板块家数与龙头
            if "映射" in body or "能不能持续" in body or body[:1] in "①②③④⑤":
                continue
            elif in_hot and HOT_LINE.search(body):
                w = 4 + (2 if re.search(r"\d+\s*板|封单|涨停\s*\d+", body) else 0)
                picks.setdefault("热门板块", []).append((w, body))
                continue
            best_cat, best_hits = "", 0
            for cat, pat in CATS:
                hits = len(re.findall(pat, body, re.I))
                if hits > best_hits:
                    best_hits, best_cat = hits, cat
            if best_cat:
                w = 2 + (1 if NUMISH.search(body) else 0) + (2 if "%" in body or "美元" in body else 0)
                picks.setdefault(best_cat, []).append((w, body))

        with _lock, conn() as c:
            # 只重建没收藏的抽取条目：收藏过的要留在收藏夹里
            c.execute("DELETE FROM news WHERE day=? AND source='report' AND saved=0", (day,))
            for cat, arr in picks.items():
                seen: set[str] = set()
                arr.sort(key=lambda x: -x[0])
                for w, body in arr:
                    key = body[:24]
                    if key in seen:
                        continue
                    seen.add(key)
                    if len(seen) > MAX_PER_CAT.get(cat, 4):
                        break
                    cur = c.execute(
                        "INSERT OR IGNORE INTO news(day,category,title,body,weight,source,created_at)"
                        " VALUES(?,?,?,?,?,?,?)",
                        (day, cat, body, rep["title"], min(w, 9), "report", now_bj()),
                    )
                    added += cur.rowcount
            for i, a in enumerate(advice):
                cur = c.execute(
                    "INSERT OR IGNORE INTO news(day,category,title,body,weight,source,created_at)"
                    " VALUES(?,?,?,?,?,?,?)",
                    (day, "建议", a, rep["title"], 9 - min(i, 4), "report", now_bj()),
                )
                added += cur.rowcount
            c.execute("DELETE FROM news WHERE source='report' AND saved=0 AND day < date('now','-14 day')")
    # 注意：报告摘录是「复盘/涨停梯队」类长句，里面常顺手提到个股，自动匹配会刷屏；
    # 报告里的个股公告由定时任务用 scripts/flag_push.py 显式推送，见 cron prompt。
    return added


def list_news(day: str | None = None, limit: int = 120,
              start: str | None = None, end: str | None = None) -> list[dict]:
    """需关注（报告抽取 + 人工），不含实时新闻。start/end 为闭区间 YYYY-MM-DD。"""
    sql = "SELECT * FROM news WHERE source!='live'"
    args: list = []
    if day:
        sql += " AND day=?"
        args.append(day)
    if start:
        sql += " AND day>=?"
        args.append(start)
    if end:
        sql += " AND day<=?"
        args.append(end)
    sql += " ORDER BY day DESC, weight DESC, id ASC LIMIT ?"
    args.append(limit)
    with conn() as c:
        rows = [dict(r) for r in c.execute(sql, args).fetchall()]
    rows.sort(key=lambda r: (r["day"], -CAT_ORDER.get(r["category"], 9), -r["weight"]))
    return rows


def news_inbox(page: int = 1, size: int = 50, max_id: int | None = None,
               only: str = "unread", level: str | None = None) -> dict:
    """新闻收件箱（未读/已读）。

    - only="unread"：read_at IS NULL，按发布时间**从新到旧**排，分页；条目带
      `seq`＝它是未读队列里第几条（最旧=1，最新=总数），删行不重排。
      max_id 是本次阅读会话的边界（打开时的最大 id），传了以后新进来的电报不会
      挤进当前页。
    - level="A"|"B"|"C"：只出该级别的未读（财联社 level，缺省=全部）。
    - only="read"：今天已读过的，按 read_at 倒序，不分页（回看用）。
    """
    size = max(10, min(int(size or 50), 200))
    page = max(1, int(page or 1))
    lv = (level or "").strip().upper()
    lv = lv if lv in ("A", "B", "C") else ""
    with conn() as c:
        if only == "read":
            since = (datetime.now(BJ) - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
            rows = c.execute(
                "SELECT * FROM news WHERE read_at IS NOT NULL AND read_at >= ? AND source='live'"
                " ORDER BY read_at DESC, id DESC LIMIT 200", (since,)
            ).fetchall()
            return {"items": [dict(r) for r in rows], "total": len(rows),
                    "page": 1, "pages": 1, "size": size, "max_id": max_id,
                    "unread_total": 0, "newer": 0, "level": "", "levels": {"A": 0, "B": 0, "C": 0}}
        if only == "all":
            # 「资讯」全量时间流：已读的和未读的在同一条时间线上，不再单独开一页
            where0 = "source='live'"
            args0: list = []
            lv_where0, lv_args0 = where0, list(args0)
            if lv:
                lv_where0 += " AND UPPER(COALESCE(NULLIF(level,''),'C')) = ?"
                lv_args0.append(lv)
            total = c.execute(f"SELECT COUNT(*) FROM news WHERE {lv_where0}", lv_args0).fetchone()[0]
            pages = max(1, (int(total) + size - 1) // size)
            page = min(page, pages)
            rows = c.execute(
                f"SELECT * FROM news WHERE {lv_where0}"
                " ORDER BY COALESCE(NULLIF(published_at,''), created_at) DESC, id DESC LIMIT ? OFFSET ?",
                lv_args0 + [size, (page - 1) * size],
            ).fetchall()
            unread_total = c.execute(
                "SELECT COUNT(*) FROM news WHERE read_at IS NULL AND source='live'").fetchone()[0]
            newer = c.execute(
                "SELECT COUNT(*) FROM news WHERE read_at IS NULL AND source='live' AND id > ?",
                (int(max_id or 0),)
            ).fetchone()[0] if max_id else 0
            levels = {"A": 0, "B": 0, "C": 0}
            for k, n in c.execute(
                    f"SELECT CASE WHEN UPPER(COALESCE(level,'')) IN ('A','B') THEN UPPER(level) ELSE 'C' END,"
                    f" COUNT(*) FROM news WHERE {where0} GROUP BY 1", args0).fetchall():
                levels[str(k)] = int(n)
            base0 = (page - 1) * size
            items0 = []
            for i, r in enumerate(rows):
                d0 = dict(r)
                d0["seq"] = int(total) - (base0 + i)
                items0.append(d0)
            return {"items": items0, "total": int(total), "page": page,
                    "pages": pages, "size": size, "max_id": int(max_id or total),
                    "unread_total": int(unread_total), "newer": int(newer),
                    "level": lv, "levels": levels}
        where = "read_at IS NULL AND source='live'"
        args: list = []
        if max_id:
            where += " AND id <= ?"
            args.append(int(max_id))
        lv_where, lv_args = where, list(args)
        if lv:
            # 缺 level 的行（金十兜底源）显示和统计都当 C 级，筛选也必须一致，否则
            # 标签写 133 条、点进去只剩 1 条
            lv_where += " AND UPPER(COALESCE(NULLIF(level,''),'C')) = ?"
            lv_args.append(lv)
        total = c.execute(f"SELECT COUNT(*) FROM news WHERE {lv_where}", lv_args).fetchone()[0]
        newest = c.execute(f"SELECT MAX(id) FROM news WHERE {where}", args).fetchone()[0] or 0
        pages = max(1, (int(total) + size - 1) // size)
        page = min(page, pages)
        rows = c.execute(
            f"SELECT * FROM news WHERE {lv_where}"
            " ORDER BY COALESCE(NULLIF(published_at,''), created_at) DESC, id DESC LIMIT ? OFFSET ?",
            lv_args + [size, (page - 1) * size],
        ).fetchall()
        unread_total = c.execute(
            "SELECT COUNT(*) FROM news WHERE read_at IS NULL AND source='live'").fetchone()[0]
        newer = c.execute(
            "SELECT COUNT(*) FROM news WHERE read_at IS NULL AND source='live' AND id > ?",
            (int(max_id or 0),)
        ).fetchone()[0] if max_id else 0
        levels = {"A": 0, "B": 0, "C": 0}
        for k, n in c.execute(
                f"SELECT CASE WHEN UPPER(COALESCE(level,'')) IN ('A','B') THEN UPPER(level) ELSE 'C' END,"
                f" COUNT(*) FROM news WHERE {where} GROUP BY 1", args).fetchall():
            levels[str(k)] = int(n)
    base = (page - 1) * size
    items = []
    for i, r in enumerate(rows):
        d = dict(r)
        d["seq"] = int(total) - (base + i)     # 最旧=1，最新=总数；删行不重排
        items.append(d)
    return {"items": items, "total": int(total), "page": page,
            "pages": pages, "size": size, "max_id": int(newest),
            "unread_total": int(unread_total), "newer": int(newer),
            "level": lv, "levels": levels}


def mark_read_before(day: str) -> int:
    """次日自动已读：把发布日期早于 day（北京时间 YYYY-MM-DD）的实时资讯批量标已读。

    过了 00:00 之后，昨天的资讯对新一天已经没有时效价值，自动沉到「已读」，
    未读角标只留给今天的内容。幂等，重复调用只会命中新出现的旧条目。
    """
    day = (day or "")[:10]
    if len(day) != 10:
        return 0
    day = day.replace("/", "-")
    ts = now_bj()
    with _lock, conn() as c:
        return c.execute(
            "UPDATE news SET read_at=? WHERE read_at IS NULL AND source='live'"
            " AND substr(COALESCE(NULLIF(published_at,''), created_at),1,10) < ?",
            (ts, day)).rowcount


def mark_news_read(ids: list[int]) -> int:
    """把若干条新闻标成已读（幂等）。返回本次新标已读的条数。"""
    ids = [int(i) for i in (ids or []) if str(i).strip().isdigit()][:200]
    if not ids:
        return 0
    ts = now_bj()
    with _lock, conn() as c:
        n = 0
        for i in ids:
            n += c.execute("UPDATE news SET read_at=? WHERE id=? AND read_at IS NULL",
                           (ts, i)).rowcount
    return n


def mark_pages_read(pages: list, size: int = 50, max_id: int | None = None,
                    level: str | None = None) -> dict:
    """按页把未读新闻标成已读：一次请求内先按同一快照取页、再统一写 read_at。

    页序与 news_inbox 完全一致（新→旧、可选 max_id 会话边界与 level 级别筛选），
    所以「第 3 页」和收件箱里点下一页看到的第 3 页是同一条边界。
    """
    size = max(10, min(int(size or 50), 200))
    clean: list[int] = []
    for p in (pages or []):
        try:
            v = int(p)
        except (TypeError, ValueError):
            continue
        if v > 0 and v not in clean:
            clean.append(v)
    clean = sorted(clean)[:200]
    lv = (level or "").strip().upper()
    lv = lv if lv in ("A", "B", "C") else ""
    where, args = "read_at IS NULL AND source='live'", []
    if max_id:
        where += " AND id <= ?"
        args.append(int(max_id))
    if lv:
        where += " AND UPPER(COALESCE(NULLIF(level,''),'C')) = ?"
        args.append(lv)
    order = " ORDER BY COALESCE(NULLIF(published_at,''), created_at) DESC, id DESC"
    ts = now_bj()
    n = 0
    with _lock, conn() as c:
        for p in clean:
            ids = [r[0] for r in c.execute(
                f"SELECT id FROM news WHERE {where}{order} LIMIT ? OFFSET ?",
                args + [size, (p - 1) * size]).fetchall()]
            for i in ids:
                n += c.execute("UPDATE news SET read_at=? WHERE id=? AND read_at IS NULL",
                               (ts, i)).rowcount
    return {"read": n, "pages": len(clean)}


def unread_newer(max_id: int | None = None) -> dict:
    """收件箱提示条用：还有多少条未读、其中比 max_id 新的有几条。"""
    with conn() as c:
        total = c.execute(
            "SELECT COUNT(*) FROM news WHERE read_at IS NULL AND source='live'").fetchone()[0]
        newer = 0
        if max_id:
            newer = c.execute(
                "SELECT COUNT(*) FROM news WHERE read_at IS NULL AND source='live' AND id > ?",
                (int(max_id),)).fetchone()[0]
    return {"unread_total": int(total), "newer": int(newer)}


def search_news(q: str, limit: int = 500) -> list[dict]:
    """全库新闻标题搜索：实时新闻 + 报告抽取/人工，按发布时间倒序。"""
    q = (q or "").strip()
    if not q:
        return []
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    sql = (
        "SELECT id, day, category, title, source, published_at, level, alert, saved, created_at FROM news"
        " WHERE title LIKE ? ESCAPE '\\'"
        " ORDER BY COALESCE(published_at, day || ' 00:00') DESC, id DESC LIMIT ?"
    )
    with conn() as c:
        return [dict(r) for r in c.execute(sql, (like, limit)).fetchall()]


def _tomb_hash(title: str) -> str:
    """标题指纹（压空白后全文哈希）：用于判断一条新闻是否被用户删过。"""
    norm = re.sub(r"\s+", "", title or "")
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()


def add_live(items: list[dict]) -> int:
    """写入实时新闻（source='live'），按 天+类+标题 去重；用户删过的标题不再写回。"""
    added = 0
    hits: list[tuple[str, str, str]] = []
    with _lock, conn() as c:
        c.execute("DELETE FROM news_tomb WHERE del_at < datetime('now','-30 day')")
        tomb = {r["hash"] for r in c.execute("SELECT hash FROM news_tomb").fetchall()}
        for it in items:
            title = (it.get("title") or "").strip()
            if not title:
                continue
            if _tomb_hash(title) in tomb:
                continue
            cur = c.execute(
                "INSERT OR IGNORE INTO news(day,category,title,body,weight,source,created_at,published_at,level,alert)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (it.get("day") or today_bj(), it.get("category") or "宏观", title[:MAX_LIVE_TITLE],
                 (it.get("body") or "")[:80], int(it.get("weight") or 5), "live", now_bj(),
                 it.get("published_at") or now_bj(),
                 (it.get("level") or ("B" if int(it.get("weight") or 5) >= 8 else "C")),
                 1 if it.get("alert") else 0),
            )
            added += cur.rowcount
            if cur.rowcount and (int(it.get("weight") or 5) >= 8
                                 or (it.get("level") or "").upper() in ("A", "B")):
                hits.append((title, it.get("published_at") or "", it.get("body") or ""))
        # 时间兜底：留 90 天；真正生效的是下面的条数上限（LIVE_MAX_ROWS）
        c.execute("DELETE FROM news WHERE source='live' AND saved=0 AND day < date('now','-90 day')")
        # 条数上限：超过就删最旧的（收藏的 saved=1 不删；只清 live，报告/公告不受影响）
        extra = c.execute(
            "SELECT COUNT(*) FROM news WHERE source='live' AND saved=0"
        ).fetchone()[0] - LIVE_MAX_ROWS
        if extra > 0:
            c.execute(
                "DELETE FROM news WHERE id IN ("
                " SELECT id FROM news WHERE source='live' AND saved=0 ORDER BY id ASC LIMIT ?)",
                (int(extra),),
            )
    # 只把 A/B 级（或高权重）电报拿去匹配持仓/关注股：全量电报太杂，逐条匹配等于刷屏
    for title, pub, src in hits:
        try:
            flag_scan(title, source=src or "实时新闻", kind="news", published_at=pub)
        except Exception:
            pass
    return added


def _live_filters(day: str | None = None, start: str | None = None,
                  end: str | None = None) -> tuple[str, list]:
    """实时快讯的 WHERE 条件（day 与 start/end 可组合）。"""
    where = "source='live'"
    args: list = []
    if day:
        where += " AND day=?"
        args.append(day)
    if start:
        where += " AND day>=?"
        args.append(start)
    if end:
        where += " AND day<=?"
        args.append(end)
    return where, args


def list_live(limit: int = 200, day: str | None = None,
              start: str | None = None, end: str | None = None,
              before: str | None = None,
              before_id: int | None = None) -> list[dict]:
    """实时快讯，按发布时间倒序分页。

    before/before_id 是翻页游标（上一条的 published_at + id），
    新新闻插到最前面也不会让后续页重复或漏条。"""
    where, args = _live_filters(day, start, end)
    if before and before_id is not None:
        where += " AND (published_at < ? OR (published_at = ? AND id < ?))"
        args += [before, before, int(before_id)]
    sql = f"SELECT * FROM news WHERE {where} ORDER BY published_at DESC, id DESC LIMIT ?"
    with conn() as c:
        return [dict(r) for r in c.execute(sql, [*args, limit]).fetchall()]


def live_stats(day: str | None = None, start: str | None = None,
               end: str | None = None) -> dict:
    """当前时间范围的准确条数：总数 + A/B/C 级 + 各分类（均为全量统计，不是已加载部分）。

    一条 UNION ALL 查询取齐，保证总数、分级、分类看到的是同一个快照。"""
    where, args = _live_filters(day, start, end)
    sql = (
        f"SELECT 'total' kind, '' key, COUNT(*) n FROM news WHERE {where}"
        " UNION ALL "
        "SELECT 'level', CASE WHEN UPPER(COALESCE(level,'')) IN ('A','B')"
        f" THEN UPPER(COALESCE(level,'')) ELSE 'C' END, COUNT(*) FROM news WHERE {where} GROUP BY 2"
        " UNION ALL "
        f"SELECT 'cat', COALESCE(category,'综合'), COUNT(*) FROM news WHERE {where} GROUP BY 2"
    )
    levels = {"A": 0, "B": 0, "C": 0}
    cats: dict[str, int] = {}
    total = 0
    with conn() as c:
        for kind, key, n in c.execute(sql, args * 3).fetchall():
            if kind == "total":
                total = int(n)
            elif kind == "level":
                levels[key] = int(n)
            else:
                cats[key] = int(n)
    return {"total": total, "levels": levels, "cats": cats}


def live_days(limit: int = 10) -> list[str]:
    with conn() as c:
        return [r[0] for r in c.execute(
            "SELECT DISTINCT day FROM news WHERE source='live' ORDER BY day DESC LIMIT ?", (limit,)
        ).fetchall()]


ALERT_WHERE = (
    "source='live' AND (UPPER(COALESCE(level,''))='A'"
    " OR (UPPER(COALESCE(level,''))='B' AND COALESCE(alert,0)=1))"
)


def max_alert_id() -> int:
    """当前最新可推送新闻 id（A 级 + B 级重点），供 APK 通知服务初始化游标。"""
    with conn() as c:
        r = c.execute(f"SELECT COALESCE(MAX(id),0) FROM news WHERE {ALERT_WHERE}").fetchone()
    return int(r[0] or 0)


def list_alerts(after: int = 0, limit: int = 20) -> list[dict]:
    """id 游标之后的可推送新闻（A 级 + B 级重点，按插入顺序），供 Android 通知服务轮询。"""
    with conn() as c:
        rows = c.execute(
            "SELECT id,title,category,published_at,level FROM news"
            f" WHERE {ALERT_WHERE} AND id>?"
            " ORDER BY id ASC LIMIT ?",
            (int(after), int(limit)),
        ).fetchall()
    return [dict(r) for r in rows]


def get_meta(k: str, default: str = "") -> str:
    with conn() as c:
        r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def set_meta(k: str, v: str) -> None:
    with _lock, conn() as c:
        c.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, v))


def get_tag_order(bucket: str) -> list[str]:
    """标签筛选条的手动顺序（按 持仓/关注 分开存）。不存在的标签自动忽略。"""
    try:
        rows = json.loads(get_meta(f"tag_order:{bucket}", "[]") or "[]")
    except Exception:
        return []
    return [str(t) for t in rows if isinstance(t, str) and t]


def set_tag_order(bucket: str, names: list[str]) -> list[str]:
    clean: list[str] = []
    for n in names or []:
        n = str(n).strip()
        if n and n not in clean:
            clean.append(n[:20])
    set_meta(f"tag_order:{bucket}", json.dumps(clean[:200], ensure_ascii=False))
    return clean


def toggle_save(nid: int, saved: int = 1) -> dict | None:
    with _lock, conn() as c:
        c.execute("UPDATE news SET saved=? WHERE id=?", (1 if saved else 0, nid))
        try:
            _sync_saved_note(c, nid)   # 收藏的新闻同时作为一条「新闻记录」写进 notes
        except sqlite3.OperationalError:
            pass
        r = c.execute("SELECT * FROM news WHERE id=?", (nid,)).fetchone()
    return dict(r) if r else None


def count_saved() -> int:
    with conn() as c:
        return int(c.execute("SELECT COUNT(*) FROM news WHERE saved=1").fetchone()[0])


def list_saved(limit: int = 500) -> list[dict]:
    """收藏夹：所有收藏条目，不分来源/日期。"""
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM news WHERE saved=1"
            " ORDER BY COALESCE(published_at, created_at, day) DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()]
    return rows


def last_live_at() -> str | None:
    with conn() as c:
        r = c.execute("SELECT MAX(created_at) FROM news WHERE source='live'").fetchone()
    return r[0] if r else None


def add_news(day: str, category: str, title: str, body: str = "", weight: int = 5,
             source: str = "manual", tag: str = "") -> dict:
    with _lock, conn() as c:
        c.execute(
            "INSERT INTO news(day,category,title,body,weight,source,created_at,tag) VALUES(?,?,?,?,?,?,?,?)"
            " ON CONFLICT(day,category,title) DO UPDATE SET weight=excluded.weight, body=excluded.body, tag=excluded.tag",
            (day, category, title, body, weight, source, now_bj(), tag or ""),
        )
        r = c.execute("SELECT * FROM news WHERE day=? AND category=? AND title=?", (day, category, title)).fetchone()
    return dict(r)


def bulk_delete(kind: str, ids: list, with_notes: bool = False) -> dict:
    """多选删除：stock=代码，note/news=id。逐条走原来的删除逻辑（含回收站/墓碑）。

    with_notes 只对 stock 生效：把「显式关联」这些个股的笔记一起进回收站；
    仅在正文里提到名字、没有关联的笔记保留。
    """
    n = 0
    notes_removed = 0
    for x in ids:
        try:
            if kind == "stock":
                notes_removed += delete_stock(str(x), with_notes=with_notes)
            elif kind == "note":
                delete_note(int(x))
            elif kind == "news":
                if not delete_news(int(x)):
                    continue
            else:
                raise ValueError("未知类型")
            n += 1
        except (ValueError, TypeError, sqlite3.Error):
            continue
    return {"deleted": n, "notes_removed": notes_removed}


def delete_news(nid: int) -> bool:
    """真删：实时新闻额外写墓碑，保证下次拉取不会又冒出来。"""
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM news WHERE id=?", (nid,)).fetchone()
        if not r:
            return False
        _trash_add(c, "news", r)
        c.execute("DELETE FROM notes WHERE news_id=? AND deleted=0", (nid,))
        if (r["source"] or "") == "live":
            c.execute(
                "INSERT OR IGNORE INTO news_tomb(hash,title,del_at) VALUES(?,?,?)",
                (_tomb_hash(r["title"]), (r["title"] or "")[:200], now_bj()),
            )
        c.execute("DELETE FROM news WHERE id=?", (nid,))
        return True


def news_days(limit: int = 8) -> list[str]:
    """需关注有内容的日子（实时新闻不算，避免周末空日期）。"""
    with conn() as c:
        return [r[0] for r in c.execute(
            "SELECT DISTINCT day FROM news WHERE source!='live' ORDER BY day DESC LIMIT ?", (limit,)
        ).fetchall()]


def upcoming_events(days: int = 14) -> list[dict]:
    """用户自己加的「日程」条目（未来 N 天），与 calendar.py 的固定日程一起展示。"""
    today = today_bj()
    end = (datetime.strptime(today, "%Y-%m-%d") + timedelta(days=max(1, days))).strftime("%Y-%m-%d")
    with conn() as c:
        rows = c.execute(
            "SELECT id, day, title, body, source, tag FROM news"
            " WHERE source!='live' AND category='日程' AND day>=? AND day<=?"
            " ORDER BY day ASC, id ASC", (today, end),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- 个股红标（新闻/公告命中持仓或关注股） ----------
def purge_past_events() -> int:
    """手工日程过了当天自动删除（当天仍显示，第二天起清掉）。"""
    with _lock, conn() as c:
        rows = c.execute(
            "SELECT id FROM news WHERE category='日程' AND source!='live' AND day < ?",
            (today_bj(),),
        ).fetchall()
        for r in rows:
            c.execute("DELETE FROM news WHERE id=?", (r["id"],))
    return len(rows)


FLAG_KEEP_DAYS = 14    # 红标保留天数（已读也保留，方便个股页回看）
FLAG_MAX_UNREAD = 8    # 单只股最多同时挂 8 条未读，超出把最早的标为已读，避免刷屏
FLAG_RED_HOURS = 24    # 红标只算最近 24 小时：和「最新新闻」同一个窗口，看过就白、没消息就不红

# 名称之外的匹配词：ETF 简称、银行习惯简称等（2 字词只在这里显式开，避免「黄金」这类词刷屏）
FLAG_ALIASES = {
    "159148": ["石油ETF"],
    "601398": ["工行"],
    "601811": ["文轩"],
    "300014": ["亿纬"],
}


_FULL2HALF = str.maketrans(
    "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
)


def flag_keywords(code: str, name: str) -> set[str]:
    """一只股的匹配词：全名、去 -W/-U 后缀的主体名、半角全角变体、代码、ETF 前缀、显式别名。"""
    kw = {name or "", str(code), (name or "").translate(_FULL2HALF)}
    # 科创板/未盈利标的常带 -W / -U / -UW 后缀，新闻里一般只写主体名
    base = re.split(r"[-－＿_]", name or "")[0].strip()
    if base and base != name:
        kw.add(base)
    kw |= set(FLAG_ALIASES.get(str(code), []))
    if re.search(r"ETF", name or "", re.I):
        head = re.split(r"ETF", name, flags=re.I)[0].strip()
        if len(head) >= 3:
            kw.add(head)
    return {k for k in kw if len(k) >= 2}


# ---- 红标匹配的“主位”规则（2026-10-29 用户反馈“没啥消息个股还是红的”后加的）----
# 汇编/综述类电报一条里塞十几条消息，个股往往在第 8 条才被顺带提一句，点开看不出为什么红。
# 这类只认标题前 30 字；普通新闻认前 40 字。纯代码命中一律不算（长文里 6 位数字容易撞）。
FLAG_AGG_RE = re.compile(
    r"^\s*[【\[]?\s*(?:财联社\s*\d+\s*月\s*\d+\s*日\s*)?"
    r"(?:新闻精选|早间新闻|晚间新闻|午间新闻|收评|午评|盘前|盘中|收盘|投资日历|"
    r"涨停分析|跌停分析|竞价看龙头|公告速递|业绩汇总|早知道|复盘|异动|快照)"
)


def _flag_lead(text: str, n: int) -> str:
    """取标题的“主位区”：去掉【】和「财联社X月X日」前缀后的前 n 个字。"""
    t = re.sub(r"[【】\[\]]", "", (text or "").strip())
    t = re.sub(r"^财联社\s*\d+\s*月\s*\d+\s*日\s*", "", t)
    return t[:n]


def flag_match(title: str, code: str, name: str) -> bool:
    """这条标题算不算这只股的消息：名字要出现在主位区，光有代码不算。"""
    t = (title or "").strip()
    if len(t) < 4:
        return False
    lead = _flag_lead(t, 30 if FLAG_AGG_RE.match(t) else 40)
    hay = [lead, lead.translate(_FULL2HALF)]
    words = {k for k in flag_keywords(code, name) if not k.isdigit()}
    return any(w and any(w in h for h in hay) for w in words)


def stock_codes_in(text: str) -> list[str]:
    """文本里命中的持仓/关注股代码（按主位规则，汇编类只认开头）。"""
    t = (text or "").strip()
    if len(t) < 4:
        return []
    with conn() as c:
        rows = c.execute("SELECT code,name FROM stocks ORDER BY sort").fetchall()
    return [r["code"] for r in rows if flag_match(t, r["code"], r["name"])]


def flag_push(items: list[dict]) -> int:
    """写入红标。items 每项：code/title/kind/source/url/published_at。按 (代码,标题) 去重，只收持仓/关注里的股。"""
    ts = now_bj()
    n = 0
    items = [it for it in (items or []) if isinstance(it, dict)]
    if not items:
        return 0
    with _lock, conn() as c:
        names = {r["code"]: (r["name"] or "") for r in c.execute("SELECT code,name FROM stocks")}
        tomb = {(r["code"], r["title"]) for r in c.execute("SELECT code,title FROM stock_flag_tomb")}
        for it in items:
            code = str(it.get("code") or "").strip()
            title = re.sub(r"\s+", " ", str(it.get("title") or "")).strip()
            if code not in names or len(title) < (1 if it.get("kind") == "note" else 6):
                continue
            if (code, title[:300]) in tomb:
                continue
            # read=True：直接落成已读（笔记关联个股就是这种，挂在个股消息里但不标红）
            cur = c.execute(
                "INSERT OR IGNORE INTO stock_flags(code,name,title,kind,source,url,published_at,created_at,read_at,ref)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (code, names[code], title[:300], (str(it.get("kind") or "news"))[:16],
                 (str(it.get("source") or ""))[:40], (str(it.get("url") or ""))[:400],
                 (str(it.get("published_at") or ts))[:19], ts,
                 ts if it.get("read") else None, (str(it.get("ref") or ""))[:64]),
            )
            n += cur.rowcount
        for code in {str(it.get("code") or "").strip() for it in items}:
            ids = [r["id"] for r in c.execute(
                "SELECT id FROM stock_flags WHERE code=? AND read_at IS NULL ORDER BY id DESC", (code,)
            ).fetchall()]
            for fid in ids[FLAG_MAX_UNREAD:]:
                c.execute("UPDATE stock_flags SET read_at=? WHERE id=?", (ts, fid))
        cutoff = (datetime.now(BJ) - timedelta(days=FLAG_KEEP_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
        # 笔记关联是对个股的长期标注，不随红标一起过期
        c.execute("DELETE FROM stock_flags WHERE created_at < ? AND kind != 'note'", (cutoff,))
    return n


def flag_scan(text: str, source: str = "", kind: str = "news", published_at: str | None = None,
              title: str | None = None, url: str = "") -> int:
    """把一段新闻/公告文本匹配到个股并写红标；title 只作展示，匹配用全文。"""
    body = text or ""
    codes = stock_codes_in(body)
    if not codes:
        return 0
    shown = (title or body).strip()
    return flag_push([
        {"code": code, "title": shown, "kind": kind, "source": source,
         "url": url, "published_at": published_at} for code in codes
    ])


def sync_live_news(hours: int = 2) -> int:
    """把近 N 小时（默认 2h）的实时新闻匹配到持仓/关注股，写进 stock_live_news。

    个股详情页的「公司 · 消息」只读这张表：不再回查笔记 / 日报 / 历史新闻，
    就是「最近两小时、跟这只股有关的实时快讯」。后台每小时刷一次。
    """
    h = max(1, int(hours or 2))
    since = (datetime.now(BJ) - timedelta(hours=h)).strftime("%Y-%m-%d %H:%M:%S")
    with conn() as c:
        stocks = [(r["code"], r["name"] or "") for r in c.execute("SELECT code,name FROM stocks")]
        rows = c.execute(
            "SELECT id,title,published_at,created_at FROM news"
            " WHERE source='live' AND COALESCE(NULLIF(published_at,''),created_at) >= ?",
            (since,),
        ).fetchall()
    if not stocks or not rows:
        return 0
    kws = [(code, name) for code, name in stocks]
    ts = now_bj()
    added = 0
    with _lock, conn() as c:
        for r in rows:
            title = (r["title"] or "").strip()
            if len(title) < 4:
                continue
            pub = (r["published_at"] or r["created_at"] or "")[:16]
            for code, name in kws:
                # 主位规则：汇编类只认标题开头，纯代码命中不算（见 flag_match）
                if not flag_match(title, code, name):
                    continue
                n = c.execute(
                    "INSERT OR IGNORE INTO stock_live_news(code,name,news_id,title,published_at,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (code, name, int(r["id"]), title[:300], pub, ts),
                ).rowcount
                added += n
        # 页面只需要近 2h；留 1 天方便跨小时回看和排查
        cutoff = (datetime.now(BJ) - timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
        c.execute("DELETE FROM stock_live_news WHERE published_at < ?", (cutoff,))
        # 匹配规则改过之后，把不合规的旧行和已不在持仓/关注里的股清掉
        valid = {code for code, _ in kws}
        for old in c.execute("SELECT id,code,name,title FROM stock_live_news").fetchall():
            if old["code"] not in valid or not flag_match(old["title"] or "", old["code"], old["name"]):
                c.execute("DELETE FROM stock_live_news WHERE id=?", (old["id"],))
    # 每小时这一轮同时上红标（用户要求：个股每小时检索一次，有相关消息就标红）
    # 以 stock_live_news 里近 N 小时的命中为准，保证「个股消息有几条，名字就红」
    try:
        with conn() as c:
            pairs = c.execute(
                "SELECT code,title,published_at FROM stock_live_news WHERE published_at >= ?",
                (since[:16],),
            ).fetchall()
        flag_push([{"code": r["code"], "title": r["title"], "kind": "news",
                    "source": "实时新闻", "published_at": r["published_at"]} for r in pairs])
    except Exception as e:  # 红标失败不影响个股消息
        log.warning("flag push from live news failed: %s", e)
    return added


def list_live_news(code: str, hours: int = 2, limit: int = 20) -> list[dict]:
    """个股详情「公司 · 消息」：只返回近 N 小时的实时新闻（不含笔记/日报/公告）。"""
    h = max(1, int(hours or 2))
    since = (datetime.now(BJ) - timedelta(hours=h)).strftime("%Y-%m-%d %H:%M")
    with conn() as c:
        rows = c.execute(
            "SELECT news_id,title,published_at FROM stock_live_news"
            " WHERE code=? AND published_at >= ?"
            " ORDER BY published_at DESC, news_id DESC LIMIT ?",
            (str(code), since, max(1, min(int(limit or 20), 50))),
        ).fetchall()
    return [{"id": r["news_id"], "title": r["title"], "published_at": r["published_at"],
             "kind": "news", "source": "实时新闻"} for r in rows]


def search_live_recent(terms: list[str], hours: int = 24, limit: int = 20) -> list[dict]:
    """在近 N 小时实时新闻标题里匹配一组关键词（ETF 名称 + 前十大成分股名）。

    ETF 详情「最新新闻」用：不依赖 stock_live_news（未关注的 ETF 没有后台扫描），
    直接扫新闻库，返回命中的标题和命中的词。
    """
    cleaned = []
    for t in terms or []:
        t = str(t or "").strip()
        if len(t) >= 2 and t not in cleaned:
            cleaned.append(t)
    if not cleaned:
        return []
    h = max(1, min(int(hours or 24), 72))
    since = (datetime.now(BJ) - timedelta(hours=h)).strftime("%Y-%m-%d %H:%M")
    with conn() as c:
        rows = c.execute(
            "SELECT id,title,published_at FROM news WHERE source='live' AND published_at>=?"
            " ORDER BY published_at DESC, id DESC LIMIT 3000",
            (since,),
        ).fetchall()
    out, seen = [], set()
    cap = max(1, min(int(limit or 20), 50))
    for r in rows:
        title = r["title"] or ""
        hit = next((t for t in cleaned if t in title), "")
        if not hit:
            continue
        key = (title, r["published_at"])
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": r["id"], "title": title, "published_at": r["published_at"],
                    "kind": "news", "source": "实时新闻", "match": hit})
        if len(out) >= cap:
            break
    return out


def list_flags(code: str | None = None, unread_only: bool = True, limit: int = 200) -> list[dict]:
    sql = "SELECT * FROM stock_flags WHERE 1=1"
    args: list = []
    if code:
        sql += " AND code=?"
        args.append(str(code))
    if unread_only:
        sql += " AND read_at IS NULL"
    sql += " ORDER BY COALESCE(NULLIF(published_at,''), created_at) DESC, id DESC LIMIT ?"
    args.append(int(limit))
    with conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def get_flag(fid: int) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM stock_flags WHERE id=?", (int(fid),)).fetchone()
    return dict(r) if r else None


def delete_flag(fid: int) -> bool:
    """删除一条个股消息红标，并写墓碑，防止定时任务下次又扫回来。"""
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM stock_flags WHERE id=?", (int(fid),)).fetchone()
        if not r:
            return False
        c.execute("DELETE FROM stock_flags WHERE id=?", (int(fid),))
        c.execute(
            "INSERT OR REPLACE INTO stock_flag_tomb(code,title,del_at) VALUES(?,?,?)",
            (r["code"], r["title"], now_bj()),
        )
        cutoff = (datetime.now(BJ) - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("DELETE FROM stock_flag_tomb WHERE del_at < ?", (cutoff,))
        return True


def note_content_by_ref(ref: str) -> str:
    """笔记关联产生的红标：用 ref=note:<id> 取回完整正文。"""
    m = re.match(r"note:(\d+)$", (ref or "").strip())
    if not m:
        return ""
    with conn() as c:
        r = c.execute("SELECT content FROM notes WHERE id=?", (int(m.group(1)),)).fetchone()
    return (r["content"] or "").strip() if r else ""


def live_news_by_prefix(prefix: str) -> dict | None:
    """实时新闻红标的标题被截到 300 字，用它反查新闻库里的完整正文。"""
    p = re.sub(r"\s+", " ", (prefix or "")).strip()
    if len(p) < 10:
        return None
    like = p.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    with conn() as c:
        r = c.execute(
            "SELECT title, published_at, category FROM news"
            " WHERE source='live' AND title LIKE ? ESCAPE '\\'"
            " ORDER BY id DESC LIMIT 1",
            (like,),
        ).fetchone()
    return dict(r) if r else None


def flag_summary(hours: int = FLAG_RED_HOURS) -> dict:
    """未读红标汇总：{代码: {n, name, title(最新一条), last, kind}}，给 /board 用。

    只统计最近 hours 小时（默认 24h）的未读红标——和个股「最新新闻」同一个窗口，
    避免出现“最新新闻空的、名字还红着”。更早的红标仍留在库里，方便个股页回看。
    """
    since = (datetime.now(BJ) - timedelta(hours=max(1, int(hours or FLAG_RED_HOURS)))).strftime("%Y-%m-%d %H:%M")
    out: dict[str, dict] = {}
    with conn() as c:
        rows = c.execute(
            "SELECT code,name,title,kind,published_at,created_at FROM stock_flags"
            " WHERE read_at IS NULL AND COALESCE(NULLIF(published_at,''), created_at) >= ?"
            " ORDER BY COALESCE(NULLIF(published_at,''), created_at) DESC, id DESC",
            (since,),
        ).fetchall()
    for r in rows:
        d = out.setdefault(r["code"], {"n": 0, "name": r["name"] or "", "title": "", "last": "", "kind": r["kind"]})
        d["n"] += 1
        if not d["title"]:
            d["title"] = r["title"]
            d["last"] = r["published_at"] or r["created_at"]
    return out


def flag_scan_note(nid: int, content: str, stock_code: str | None = None,
                   created_at: str | None = None) -> int:
    """笔记只在「显式关联了个股」时，在那只股的消息列表里挂一条「笔记」。

    - 不再按正文关键词自动匹配个股（持仓/关注只吃新闻库 + 三次定时任务的报告）；
    - 写入即已读 read_at，所以不会标红、不计入 📰 未读数；
    - ref=note:<id>，改笔记/删笔记时先按 ref 清掉旧的重建。
    """
    code = str(stock_code or "").strip()
    if not code:
        return 0
    text = re.sub(r"\s+", " ", (content or "")).strip()
    if not text:
        return 0
    return flag_push([{
        "code": code, "title": text[:160], "kind": "note", "source": "笔记",
        "published_at": (created_at or now_bj())[:16], "ref": f"note:{nid}", "read": True,
    }])


def flag_clear_ref(ref: str) -> int:
    with _lock, conn() as c:
        return c.execute("DELETE FROM stock_flags WHERE ref=?", (str(ref),)).rowcount


def flag_mark_read(codes: list | None = None, ids: list | None = None) -> int:
    """标已读（颜色恢复）；按代码或按条目 id。"""
    ts = now_bj()
    n = 0
    with _lock, conn() as c:
        for code in codes or []:
            n += c.execute("UPDATE stock_flags SET read_at=? WHERE code=? AND read_at IS NULL",
                           (ts, str(code))).rowcount
        for fid in ids or []:
            n += c.execute("UPDATE stock_flags SET read_at=? WHERE id=? AND read_at IS NULL",
                           (ts, int(fid))).rowcount
    return n


# ---------- 回收站 ----------
TRASH_TABLE = {"stock": "stocks", "note": "notes", "news": "news", "report": "reports", "group": "groups"}
TRASH_KIND = {"stock": "个股", "note": "笔记", "news": "新闻", "report": "日报", "group": "分组"}
TRASH_DAYS = 7


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _trash_title(kind: str, row: dict) -> str:
    if kind == "stock":
        return f"{row.get('name') or ''} {row.get('code') or ''}".strip()
    if kind == "note":
        return (row.get("content") or "").strip().replace("\n", " ")[:60] or "笔记"
    if kind == "group":
        return row.get("name") or "分组"
    if kind == "report":
        return f"{row.get('day') or ''} {row.get('title') or ''}".strip()
    return (row.get("title") or "").strip()[:80] or kind


def _trash_add(c, kind: str, row) -> None:
    """把要删除的整行塞进回收站（调用方负责真正删除）。"""
    d = dict(row)
    c.execute(
        "INSERT INTO trash(kind,title,payload,deleted_at) VALUES(?,?,?,?)",
        (kind, _trash_title(kind, d), json.dumps(d, ensure_ascii=False), _utc_now()),
    )


def purge_trash(days: int = TRASH_DAYS) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    with _lock, conn() as c:
        # 想法里的笔记只能由用户手动永久删除/清空，回收站里也不自动过期
        cur = c.execute(
            "DELETE FROM trash WHERE deleted_at < ? AND kind != 'note'", (cutoff,)
        )
        return cur.rowcount


def list_trash(days: int = TRASH_DAYS) -> list[dict]:
    purge_trash(days)
    with conn() as c:
        rows = c.execute("SELECT id,kind,title,deleted_at FROM trash ORDER BY deleted_at DESC, id DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["kind_label"] = TRASH_KIND.get(d["kind"], d["kind"])
        out.append(d)
    return out


def restore_trash(tid: int) -> dict | None:
    with _lock, conn() as c:
        r = c.execute("SELECT * FROM trash WHERE id=?", (tid,)).fetchone()
        if not r:
            return None
        kind = r["kind"]
        table = TRASH_TABLE.get(kind)
        if not table:
            return None
        d = json.loads(r["payload"])
        cols = list(d.keys())
        vals = [d[k] for k in cols]
        sql = f"INSERT OR REPLACE INTO {table}({','.join(cols)}) VALUES({','.join(['?'] * len(cols))})"
        try:
            c.execute(sql, vals)
        except sqlite3.IntegrityError:
            # 主键/唯一键撞了：去掉 id 重来，已有的就不覆盖
            if "id" not in cols:
                raise
            cols2 = [k for k in cols if k != "id"]
            sql2 = f"INSERT OR IGNORE INTO {table}({','.join(cols2)}) VALUES({','.join(['?'] * len(cols2))})"
            c.execute(sql2, [d[k] for k in cols2])
        if kind == "news":
            c.execute("DELETE FROM news_tomb WHERE hash=?", (_tomb_hash(d.get("title") or ""),))
        c.execute("DELETE FROM trash WHERE id=?", (tid,))
    return {"ok": True, "kind": kind, "title": r["title"]}


def drop_trash(tid: int) -> bool:
    with _lock, conn() as c:
        return c.execute("DELETE FROM trash WHERE id=?", (tid,)).rowcount > 0


def clear_trash() -> int:
    with _lock, conn() as c:
        return c.execute("DELETE FROM trash").rowcount


# ---- 工作台：工作类型 + 带时间的日程 ----

def _wk_rep_fill(c, tasks: list) -> None:
    """条目（head>0）本身存 days='[]'，把所属规则行的周几带出来，编辑器/列表才知道这是重复日程。"""
    heads = {int(t["head"]) for t in tasks if int(t.get("head") or 0)}
    rules = {}
    if heads:
        for r in c.execute("SELECT id,days FROM work_tasks WHERE id IN (%s)" % ",".join("?" * len(heads)),
                           tuple(heads)):
            rules[int(r["id"])] = _wk_days(r["days"])
    for t in tasks:
        h = int(t.get("head") or 0)
        t["days"] = rules.get(h) if h else _wk_days(t["days"])


def work_list() -> dict:
    with _lock, conn() as c:
        _shift_seed(c)
        _wk_roll(c)                     # 重复日程往后补齐，读到的永远是排好的真实条目
        types = [dict(r) for r in c.execute("SELECT id,name,sort FROM work_types ORDER BY sort, id")]
        tasks = [dict(r) for r in c.execute(
            "SELECT id,type_id,title,note,due_at,done,notified_at,snooze_at,created_at,days,head FROM work_tasks"
            " ORDER BY due_at, id")]
        _wk_rep_fill(c, tasks)
        counts: dict[int, int] = {}
        for t in tasks:
            counts[t["type_id"]] = counts.get(t["type_id"], 0) + 1
        for ty in types:
            ty["count"] = counts.get(ty["id"], 0)
        return {"types": types, "tasks": tasks,
                "focus": _focus_rows(c), "shift": _shift_rows(c),
                "today": today_bj()}


def ai_context_data(start: str, end: str, limit: int = 40) -> dict:
    """只取 AI 这次可能要改的那一小段：日期窗口内的日程 + 规则行，外加专注/班次配置。
    以前是把整库 work_list 塞给模型，读得多、提示词也长，改错率还高。"""
    with _lock, conn() as c:
        _shift_seed(c)
        types = [dict(r) for r in c.execute("SELECT id,name,sort FROM work_types ORDER BY sort,id")]
        tasks = [dict(r) for r in c.execute(
            "SELECT id,type_id,title,note,due_at,done,days,head FROM work_tasks"
            " WHERE (substr(due_at,1,10) BETWEEN ? AND ?)"
            "    OR (days IS NOT NULL AND days NOT IN ('','[]'))"
            " ORDER BY due_at, id LIMIT ?", (start, end, limit))]
        _wk_rep_fill(c, tasks)
        done = [dict(r) for r in c.execute(
            "SELECT day, mode_id, step_idx, done_at FROM focus_step_done"
            " WHERE day BETWEEN ? AND ? ORDER BY day, mode_id, step_idx", (start, end))]
        return {"today": today_bj(), "types": types, "tasks": tasks,
                "focus": _focus_rows(c), "shift": _shift_rows(c),
                "done": done, "win": [start, end]}


def work_add_type(name: str) -> dict:
    name = (name or "").strip()[:24]
    if not name:
        raise ValueError("名称不能为空")
    with _lock, conn() as c:
        base = c.execute("SELECT COALESCE(MAX(sort),0) FROM work_types").fetchone()[0]
        c.execute("INSERT INTO work_types(name,sort,created_at) VALUES(?,?,?)",
                  (name, base + 1, now_bj()))
        rid = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    return {"ok": True, "id": rid}


def work_update_type(tid: int, name: str) -> bool:
    name = (name or "").strip()[:24]
    if not name:
        raise ValueError("名称不能为空")
    with _lock, conn() as c:
        return c.execute("UPDATE work_types SET name=? WHERE id=?", (name, tid)).rowcount > 0


def work_del_type(tid: int) -> int:
    """删类型连它的日程一起删，返回删掉的日程条数。"""
    with _lock, conn() as c:
        n = c.execute("DELETE FROM work_tasks WHERE type_id=?", (tid,)).rowcount
        c.execute("DELETE FROM work_types WHERE id=?", (tid,))
    return n


def _wk_days(raw) -> list:
    """把「周几」读成 [1..7]；空数组 = 不重复（每天）。"""
    try:
        ds = json.loads(raw) if isinstance(raw, str) else list(raw or [])
    except Exception:
        ds = []
    out = set()
    for x in ds:
        try:
            n = int(x)
        except Exception:
            continue
        if 1 <= n <= 7:
            out.add(n)
    return sorted(out)


def _wk_roll(c, ahead: int = 35) -> None:
    """把带「重复」的日程按规则铺成真实条目（都是 work_tasks 的行，done/提醒照旧）。
    规则行 = days 非空且 head=0；由它铺出来的条目 head 指向规则行。
    滚动窗口：今天 … +35 天，每次读列表都往后补齐一次，所以不用定时任务。"""
    today = today_bj()[:10]
    # 「晚点 10 分钟」只算当天这一条：过了一天就作废，别让昨天的推迟把明天的提醒也推后
    c.execute("UPDATE work_tasks SET snooze_at='' WHERE snooze_at<>'' AND substr(snooze_at,1,10)<>?", (today,))
    t0 = datetime.strptime(today, "%Y-%m-%d").date()
    span = [(t0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(0, ahead + 1)]
    rules = [dict(r) for r in c.execute(
        "SELECT id,type_id,title,note,due_at,done,days FROM work_tasks WHERE head=0 AND days<>'[]'")]
    alive = {int(r["id"]) for r in rules}
    # 规则行被删掉后，它铺出来的未来条目（还没做的）跟着清掉
    for row in c.execute("SELECT id,head FROM work_tasks WHERE head>0 AND done=0 AND substr(due_at,1,10)>=?",
                         (today,)).fetchall():
        if int(row["head"]) not in alive:
            c.execute("DELETE FROM work_tasks WHERE id=?", (row["id"],))
    for r in rules:
        days = _wk_days(r["days"])
        want = [d for d in span if not days or ((datetime.strptime(d, "%Y-%m-%d").weekday() + 1) in days)]
        have = {str(x["due_at"])[:10]: x for x in c.execute(
            "SELECT id,due_at FROM work_tasks WHERE head=? AND done=0 AND substr(due_at,1,10)>=?",
            (r["id"], today))}
        # 规则改了（周几变了 / 时间变了 / 内容变了）：先把不合规的条目删掉，再统一刷新
        for k, x in have.items():
            if k not in want or str(x["due_at"])[11:16] != str(r["due_at"])[11:16]:
                c.execute("DELETE FROM work_tasks WHERE id=?", (x["id"],))
        c.execute("UPDATE work_tasks SET type_id=?,title=?,note=?,due_at=substr(due_at,1,10)||' '||?"
                  " WHERE head=? AND done=0 AND substr(due_at,1,10)>=?",
                  (r["type_id"], r["title"], r["note"], str(r["due_at"])[11:16], r["id"], today))
        have2 = {str(x["due_at"])[:10] for x in c.execute(
            "SELECT due_at FROM work_tasks WHERE head=? AND substr(due_at,1,10)>=?", (r["id"], today))}
        self_day = str(r["due_at"])[:10]      # 规则行自己就代表那一天，别再铺一条同日的出来
        for d in want:
            if d in have2 or d == self_day:
                continue
            c.execute("INSERT INTO work_tasks(type_id,title,note,due_at,done,created_at,sort,days,head)"
                      " VALUES(?,?,?,?,0,?,0,'[]',?)",
                      (r["type_id"], r["title"], r["note"], f"{d} {str(r['due_at'])[11:16]}",
                       now_bj(), r["id"]))


def work_add_task(type_id: int, title: str, note: str, due_at: str, days=None) -> dict:
    title = (title or "").strip()[:120]
    if not title:
        raise ValueError("内容不能为空")
    due_at = (due_at or "").strip()[:16]
    ds = _wk_days(days)
    with _lock, conn() as c:
        c.execute("INSERT INTO work_tasks(type_id,title,note,due_at,done,created_at,sort,days,head)"
                  " VALUES(?,?,?,?,0,?,0,?,0)",
                  (type_id, title, (note or "")[:200], due_at, now_bj(), json.dumps(ds)))
        rid = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        if ds:
            _wk_roll(c)
    return {"ok": True, "id": rid}


def work_update_task(tid: int, fields: dict) -> bool:
    allow = {"title", "note", "due_at", "type_id", "done", "notified_at", "snooze_at"}
    patch = {k: v for k, v in (fields or {}).items() if k in allow}
    if "done" in patch:
        patch["done_at"] = now_bj() if patch["done"] else ""
    # 改期了就要能再提醒一次：旧时间点已经通知过，不清掉的话新时间永远不响
    if "due_at" in patch and "notified_at" not in patch:
        patch["notified_at"] = ""
    # 推迟这一次也要能再响一次；而 due_at 本身不动，重复规则不会连带被改
    if "snooze_at" in patch and "notified_at" not in patch:
        patch["notified_at"] = ""
    ds = _wk_days(fields.get("days")) if "days" in (fields or {}) else None
    if not patch and ds is None:
        return False
    with _lock, conn() as c:
        cur = c.execute("SELECT head,days FROM work_tasks WHERE id=?", (tid,)).fetchone()
        if not cur:
            return False
        head = int(cur["head"] or 0)
        rule_id = head or tid                       # 改条目就是改整组：落到规则行上
        ok = True
        if patch:
            cols = ",".join(f"{k}=?" for k in patch)
            ok = c.execute(f"UPDATE work_tasks SET {cols} WHERE id=?",
                           (*patch.values(), tid)).rowcount > 0
            if head:                                # 条目上加的改动也写回规则行，后面几天才对得上
                # done / done_at 只属于这一天的那条，规则行不能跟着打勾
                cols2 = ",".join(f"{k}=?" for k in patch if k not in ("done", "done_at", "snooze_at"))
                if cols2:
                    c.execute(f"UPDATE work_tasks SET {cols2} WHERE id=?",
                              (*[patch[k] for k in patch if k not in ("done", "done_at", "snooze_at")], head))
        if ds is not None:
            if ds:
                c.execute("UPDATE work_tasks SET days=? WHERE id=?", (json.dumps(ds), rule_id))
            else:
                # 关掉重复：规则行留着当普通日程，铺出来的未来条目清掉
                c.execute("UPDATE work_tasks SET days='[]' WHERE id=?", (rule_id,))
                c.execute("DELETE FROM work_tasks WHERE head=? AND done=0 AND substr(due_at,1,10)>=?",
                          (rule_id, today_bj()[:10]))
        _wk_roll(c)
        return ok


def work_del_task(tid: int) -> bool:
    with _lock, conn() as c:
        cur = c.execute("SELECT head FROM work_tasks WHERE id=?", (tid,)).fetchone()
        if not cur:
            return False
        head = int(cur["head"] or 0)
        if head:
            # 删的是一条重复日程 → 整组一起删（和专注模式的删除语义一致，避免删完又被补回来）
            n = c.execute("DELETE FROM work_tasks WHERE head=? OR id=?", (head, head)).rowcount
            c.execute("DELETE FROM work_tasks WHERE id=?", (tid,))
            return n > 0
        n = c.execute("DELETE FROM work_tasks WHERE id=? OR head=?", (tid, tid)).rowcount
        return n > 0


# ===================== 工作台 v2：专注模式 / 值班模式 =====================

def _fill_anchors(steps: list) -> list:
    """每步都要有开始时刻：老模板只有分钟数，按 09:00 起累计折算。"""
    cur = None
    for s in steps:
        a = str(s.get("anchor") or "").strip()
        if a:
            cur = a
        else:
            cur = cur or "09:00"
        s["anchor"] = cur
        cur = _add_min(cur, int(s.get("minutes") or 0))[0]
    return steps


def _run_expired(run: dict) -> bool:
    """跨日运行只有真正跑完（再留 6 小时）才算过期；不再用「日期变了」当过期。"""
    total = sum(int(s.get("minutes") or 0) for s in (run.get("snapshot") or []))
    start = str(run.get("cur_start") or run.get("started_at") or "")
    try:
        st = datetime.strptime(start, "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJ)
    except ValueError:
        return False
    return datetime.now(BJ) > st + timedelta(minutes=total + 360)


def _shift_day(day: str, n: int) -> str:
    try:
        d = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        return day
    return (d + timedelta(days=n)).strftime("%Y-%m-%d")

def _focus_rows(c: sqlite3.Connection) -> dict:
    """专注模式模板 + 最新一条进行中的运行（含快照）。"""
    modes = [dict(r) for r in c.execute(
        "SELECT id,name,note,ring_each_step,sort,auto,days,shifts,dkind FROM focus_modes ORDER BY sort, id")]
    for m in modes:
        for k in ("days", "shifts"):
            try:
                m[k] = json.loads(m.get(k) or "[]")
            except Exception:
                m[k] = []
        m["auto"] = 1 if m.get("auto") else 0
        m["dkind"] = str(m.get("dkind") or "")
    steps = [dict(r) for r in c.execute(
        "SELECT id,mode_id,title,minutes,anchor,note,sort FROM focus_steps ORDER BY mode_id,sort,id")]
    by: dict[int, list] = {}
    for s in steps:
        by.setdefault(s["mode_id"], []).append(s)
    for m in modes:
        m["steps"] = _fill_anchors(by.get(m["id"], []))
        m["total"] = sum(int(x["minutes"] or 0) for x in m["steps"])
        if m["steps"]:
            last = m["steps"][-1]
            m["start"] = m["steps"][0]["anchor"]
            m["end"] = _add_min(last["anchor"], int(last["minutes"] or 0))[0]
    run = c.execute("SELECT * FROM focus_runs WHERE status='running' ORDER BY id DESC LIMIT 1").fetchone()
    run = dict(run) if run else None
    if run:
        try:
            run["snapshot"] = json.loads(run.get("snapshot") or "[]")
        except Exception:
            run["snapshot"] = []
        # 跨日的运行不该在零点被强杀：只有「开始 + 总时长」都过完了才收掉
        if _run_expired(run):
            c.execute("UPDATE focus_runs SET status='quit', ended_at=? WHERE id=?",
                      (now_bj(), run["id"]))
            run = None
    return {"modes": modes, "run": run}


def _dt_min(a: str, b: str) -> int:
    """两个「YYYY-MM-DD HH:MM[:SS]」之间差多少分钟；解析不了算 0。"""
    def _p(x):
        x = str(x or "").strip()[:19]
        for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(x, f)
            except ValueError:
                continue
        return None
    d1, d2 = _p(a), _p(b)
    if not d1 or not d2:
        return 0
    return max(0, int((d2 - d1).total_seconds() // 60))


_OV_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _run_plan_min(snapshot: str) -> int:
    """这一场的计划总时长（快照里各步分钟数之和）；解析不了算 0。"""
    try:
        snap = json.loads(snapshot or "[]")
    except ValueError:
        return 0
    return sum(max(0, int(s.get("minutes") or 0)) for s in snap if isinstance(s, dict))


_HOL_PATH = Path(__file__).resolve().parent / "static" / "data" / "holidays.json"


def _holidays() -> dict:
    try:
        d = json.loads(_HOL_PATH.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _day_kind(day: str, hol: dict) -> str:
    """工作日 / 休息日：节假日表优先，其次周一~五 / 周末。和前端 wkDayKind 同一套。"""
    h = hol.get(day)
    if h and h.get("off"):
        return "off"
    if h and h.get("work"):
        return "work"
    return "off" if datetime.strptime(day, "%Y-%m-%d").weekday() >= 5 else "work"


def _dow_no(day: str) -> int:
    """周几：1=周一 … 7=周日（前端 wkDowNo 同口径）"""
    return datetime.strptime(day, "%Y-%m-%d").weekday() + 1


def _break_len(a: str, b: str) -> int:
    try:
        h1, m1 = (int(x) for x in str(a)[:5].split(":"))
        h2, m2 = (int(x) for x in str(b)[:5].split(":"))
    except (ValueError, AttributeError):
        return 0
    d = (h2 * 60 + m2) - (h1 * 60 + m1)
    return d if d > 0 else d + 24 * 60


def _shift_min_map(c: sqlite3.Connection, days: list[str]) -> dict:
    """每天「在岗分钟」：班次 dur_min − 休息段，跨日班整段归到开始那天。

    规则和前端 shiftTypeIdOf / wkRosterOn / wkShiftRunsOn 完全一致：手调覆盖优先，
    其次最新一段生效的轮转表按天推，班次绑了专注模式时只在这些模式跑的日子上班。
    """
    types: dict[int, dict] = {}
    for r in c.execute("SELECT id,name,short,start,end,cross_day,kind,dur_min,breaks,modes"
                       " FROM shift_types"):
        d = dict(r)
        d["kind"] = d.get("kind") or "shift"
        try:
            br = json.loads(d.get("breaks") or "[]")
        except ValueError:
            br = []
        d["break_min"] = sum(_break_len(a, b) for a, b in br) if d["kind"] != "off" else 0
        dur = int(d.get("dur_min") or 0)
        if not dur and d["kind"] != "off" and d.get("start") and d.get("end"):
            dur = _break_len(d["start"], d["end"])
        d["dur_min"] = dur
        d["work_min"] = max(0, dur - int(d["break_min"] or 0))
        try:
            d["modes"] = [int(x) for x in json.loads(d.get("modes") or "[]")]
        except ValueError:
            d["modes"] = []
        types[int(d["id"])] = d
    rosters = []
    for r in c.execute("SELECT id,name,pattern,start_date,effective_from,end_date"
                       " FROM shift_rosters ORDER BY effective_from, id"):
        d = dict(r)
        d["end_date"] = (d.get("end_date") or "")[:10] or None
        try:
            d["pattern"] = [int(x) for x in json.loads(d.get("pattern") or "[]")]
        except ValueError:
            d["pattern"] = []
        rosters.append(d)
    overrides = {r["day"]: int(r["shift_id"] or 0)
                 for r in c.execute("SELECT day,shift_id FROM shift_overrides")}
    modes = {}
    for r in c.execute("SELECT id,days,dkind FROM focus_modes"):
        d = dict(r)
        try:
            d["days"] = [int(x) for x in json.loads(d.get("days") or "[]")]
        except ValueError:
            d["days"] = []
        d["dkind"] = str(d.get("dkind") or "")
        modes[int(d["id"])] = d
    hol = _holidays()
    out: dict[str, int] = {}
    for day in days:
        sid = overrides.get(day)
        if sid is None:
            roster = None
            for r in rosters:                     # 最新一段「生效日期 <= 这天」的轮转表
                if str(r["effective_from"])[:10] <= day and (not r["end_date"] or r["end_date"] >= day):
                    roster = r                      # 已按 effective_from 升序，取最后一个
            sid = 0
            if roster and roster["pattern"]:
                off = (datetime.strptime(day, "%Y-%m-%d") - datetime.strptime(str(roster["start_date"])[:10], "%Y-%m-%d")).days
                sid = int(roster["pattern"][off % len(roster["pattern"])]) or 0
            t = types.get(sid)
            if sid and t and t["modes"]:
                mids = t["modes"]
                bound = [modes[m] for m in mids if m in modes]
                if bound and not any(_mode_days_ok(m, day, hol) for m in bound):
                    sid = 0                          # 班次绑的模式这天不跑 → 不上班
        t = types.get(sid or 0)
        out[day] = int(t["work_min"]) if t and t["kind"] != "off" else 0
    return out


def _mode_days_ok(m: dict, day: str, hol: dict) -> bool:
    days = [int(x) for x in (m.get("days") or [])]
    if days and _dow_no(day) not in days:
        return False
    if m.get("dkind") and _day_kind(day, hol) != m["dkind"]:
        return False
    return True


def work_overview(start: str, end: str, mode_id: int | None = None) -> dict:
    """按天汇总成一张表，给「数据总览」的热力图用。

    这里只算前端拿不到历史的两项：专注（focus_runs 全在库里，接口只回进行中的那条）
    和任务完成（work_tasks 只回当前清单）。值班工时前端有自己的轮转表 + 手调覆盖，
    由前端按同一条口径（班次 dur_min - 休息）本地算，避免两处各维护一套排班解析。
    """
    start = str(start or "").strip()[:10]
    end = str(end or "").strip()[:10]
    if not _OV_DAY.match(start) or not _OV_DAY.match(end):
        raise ValueError("日期要 YYYY-MM-DD")
    if start > end:
        start, end = end, start
    days: dict[str, dict] = {}
    # 按模式筛：只影响专注那几项（任务/值班跟模式无关），mode_stats 给前端排「最常用的几个」
    mid_flt = int(mode_id) if mode_id not in (None, "", 0) else None
    mstats: dict[int, dict] = {}

    def _row(d: str) -> dict:
        return days.setdefault(d, {"focus_min": 0, "focus_runs": 0, "focus_steps": 0,
                                   "task_done": 0, "task_all": 0, "shift_min": 0})

    with _lock, conn() as c:
        rows = c.execute("SELECT day,mode_id,mode_name,started_at,ended_at,status,step_idx,snapshot"
                         " FROM focus_runs WHERE day>=? AND day<=?", (start, end))
        for r in rows:
            d = str(r["day"] or "")[:10]
            if not (start <= d <= end):
                continue
            it = _row(d)
            try:
                snap = json.loads(r["snapshot"] or "[]")
            except ValueError:
                snap = []
            idx = max(0, int(r["step_idx"] or 0))
            # 放弃的场次也按实际坐了多久算：真的坐了一会儿，不该抹掉。
            # 但要封顶在这场的计划时长：有人开着不管（跨夜放了一整天的 863 分钟）会把当天涂成黑色。
            mins = _dt_min(r["started_at"], r["ended_at"] or now_bj())
            if r["status"] != "done":
                plan = _run_plan_min(r["snapshot"])
                if plan:
                    mins = min(mins, plan)
            mid = int(r["mode_id"] or 0)
            # 模式被删了也要能认出来：用这场的 mode_name 快照，别显示成「已删除的模式」
            ms = mstats.setdefault(mid, {"runs": 0, "min": 0, "days": set(),
                                         "name": str(r["mode_name"] or "").strip()})
            ms["runs"] += 1
            ms["min"] += mins
            ms["days"].add(d)
            if mid_flt is not None and mid != mid_flt:
                continue
            it["focus_runs"] += 1
            # 做完的 = 全快照；放弃 / 在跑的 = 已经走到第几步
            it["focus_steps"] += (len(snap) if r["status"] == "done" and snap else idx)
            it["focus_min"] += mins
        for t in c.execute("SELECT due_at,done,done_at FROM work_tasks"):
            due = str(t["due_at"] or "")[:10]
            if not (start <= due <= end):
                continue
            _row(due)["task_all"] += 1
        for t in c.execute("SELECT due_at,done,done_at FROM work_tasks WHERE done=1"):
            done_at = str(t["done_at"] or "")[:10]
            d = done_at if _OV_DAY.match(done_at) else str(t["due_at"] or "")[:10]
            if start <= d <= end:
                _row(d)["task_done"] += 1
        since = c.execute("SELECT MIN(day) AS d FROM focus_runs").fetchone()["d"]
        # 值班工时：排班在库里（轮转 + 手调 + 班次时长），这里算好后端只给一份，前端不再自己算一遍
        day_list = []
        dd = datetime.strptime(start, "%Y-%m-%d")
        dto = datetime.strptime(end, "%Y-%m-%d")
        while dd <= dto and len(day_list) <= 400:
            day_list.append(dd.strftime("%Y-%m-%d"))
            dd += timedelta(days=1)
        smap = _shift_min_map(c, day_list)
        for day, mins in smap.items():
            _row(day)["shift_min"] = mins
        modes_list = [{"id": int(r["id"]), "name": r["name"]}
                      for r in c.execute("SELECT id,name FROM focus_modes ORDER BY sort,id")]
    # 场次排序给前端挑「最常用的 3 个」；没跑过的模式排在后面，靠「全部模式」按钮进去看
    mname = {m["id"]: m["name"] for m in modes_list}
    stats = [{"id": mid, "name": mname.get(mid) or v.get("name") or "未命名模式",
              "runs": v["runs"], "min": v["min"], "days": len(v["days"])}
             for mid, v in mstats.items()]
    stats.sort(key=lambda x: (-x["runs"], -x["min"], x["name"]))
    for m in modes_list:
        if m["id"] not in mstats:
            stats.append({"id": m["id"], "name": m["name"], "runs": 0, "min": 0, "days": 0})
    return {"days": days, "start": start, "end": end, "since": str(since or "")[:10],
            "modes": modes_list, "mode_stats": stats, "mode_id": mid_flt or 0}


def work_day_brief(day: str) -> dict:
    """某一天的全部工作内容：日程（含已完成）+ 专注运行记录（含快照步骤）。"""
    day = str(day or "").strip()[:10]
    if not day:
        raise ValueError("缺少日期")
    with _lock, conn() as c:
        _wk_roll(c)
        tasks = [dict(r) for r in c.execute(
            "SELECT id,type_id,title,note,due_at,done,created_at,days,head FROM work_tasks"
            " WHERE substr(due_at,1,10)=? ORDER BY due_at, id", (day,))]
        _wk_rep_fill(c, tasks)
        runs = [dict(r) for r in c.execute(
            "SELECT id,mode_id,mode_name,day,started_at,cur_start,step_idx,status,ended_at,snapshot"
            " FROM focus_runs WHERE day=? OR substr(ended_at,1,10)=? OR (status='running' AND day<?)"
            " ORDER BY started_at, id", (day, day, day))]
        # 跨午夜的那场 day 是开始日：它续到哪天，哪天也要能看到（否则「今天」里凭空少一场进行中的）
        seen, uniq = set(), []
        for r in runs:
            if r["id"] in seen: continue
            seen.add(r["id"]); uniq.append(r)
        for r in uniq:
            try:
                r["snapshot"] = json.loads(r.get("snapshot") or "[]")
            except Exception:
                r["snapshot"] = []
        # 这一天的批注（kind=mark）：总览点开某天时直接列出来，整条链路跟「记录 · 批注」是同一份数据
        marks = [dict(r) for r in c.execute(
            "SELECT id,content,tags,created_at,updated_at FROM notes"
            " WHERE deleted=0 AND kind='mark' AND substr(created_at,1,10)=? ORDER BY created_at, id", (day,))]
        return {"day": day, "tasks": tasks, "focus": uniq, "marks": marks}


def focus_list() -> dict:
    with _lock, conn() as c:
        return _focus_rows(c)


def _clean_steps(steps: list) -> list[tuple]:
    clean: list[tuple] = []
    for s in (steps or []):
        title = str(s.get("title") or "").strip()[:60]
        if not title:
            continue
        try:
            minutes = int(s.get("minutes") or 0)
        except Exception:
            minutes = 0
        if minutes < 1 or minutes > 1440:
            raise ValueError("每步时长要在 1–1440 分钟之间")
        anchor = str(s.get("anchor") or "").strip()
        if anchor and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", anchor):
            raise ValueError("每步都要填开始时间（HH:MM）")
        clean.append((title, minutes, anchor, str(s.get("note") or "")[:100]))
    if not clean:
        raise ValueError("至少要有一步")
    if len(clean) > 24:
        raise ValueError("步骤最多 24 个")
    if sum(x[1] for x in clean) > 2880:
        raise ValueError("总时长超过 48 小时")
    return clean


def focus_step_done_list(day: str, days: int = 3) -> dict:
    """某一天（以及往后 days 天内含当天）已勾掉的步骤。跨午夜的步骤会落在次日，所以多取几天。"""
    day = str(day or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
        raise ValueError("日期要用 YYYY-MM-DD")
    end = day
    try:
        d = date.fromisoformat(day) + timedelta(days=max(0, min(int(days), 7)))
        end = d.isoformat()
    except Exception:
        end = day
    with _lock, conn() as c:
        rows = c.execute(
            "SELECT day, mode_id, step_idx, done_at FROM focus_step_done "
            "WHERE day>=? AND day<=? ORDER BY day, mode_id, step_idx",
            (day, end)).fetchall()
    return {"ok": True, "day": day, "items": [dict(r) for r in rows]}


def focus_set_step_done(day: str, mode_id: int, step_idx: int, done: bool, by: str = "") -> dict:
    day = str(day or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
        raise ValueError("日期要用 YYYY-MM-DD")
    try:
        mid, idx = int(mode_id), int(step_idx)
    except Exception:
        raise ValueError("模式 / 步骤编号不对")
    if mid <= 0 or idx < 0 or idx > 23:
        raise ValueError("模式 / 步骤编号不对")
    with _lock, conn() as c:
        if done:
            c.execute("INSERT INTO focus_step_done(day, mode_id, step_idx, done_at, done_by) "
                      "VALUES(?,?,?,?,?) ON CONFLICT(day, mode_id, step_idx) DO UPDATE SET "
                      "done_at=excluded.done_at, done_by=excluded.done_by",
                      (day, mid, idx, now_bj(), str(by or "")[:24]))
        else:
            c.execute("DELETE FROM focus_step_done WHERE day=? AND mode_id=? AND step_idx=?",
                      (day, mid, idx))
        # 只留最近 30 天：这个表是「今天别重复响」的账，不是历史记录
        try:
            c.execute("DELETE FROM focus_step_done WHERE day < ?",
                      ((date.fromisoformat(day) - timedelta(days=30)).isoformat(),))
        except Exception:
            pass
    return {"ok": True, "day": day, "mode_id": mid, "step_idx": idx, "done": bool(done)}


def focus_save_mode(mode_id: int | None, payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()[:20]
    if not name:
        raise ValueError("名称不能为空")
    note = str(payload.get("note") or "").strip()[:120]
    ring = 1 if payload.get("ring_each_step", 1) else 0
    auto = 1 if payload.get("auto") else 0
    days = sorted({int(x) for x in (payload.get("days") or []) if 1 <= int(x) <= 7})
    # 班次是唯一真源：页面保存时不再传 shifts，这里缺字段就别动这一列，
    # 否则每编辑一次专注都会把镜像清空，到点自动就丢了「只在某班次跑」的限制。
    has_shifts = "shifts" in payload
    shifts = sorted({int(x) for x in (payload.get("shifts") or []) if int(x) >= 0})
    dkind = str(payload.get("dkind") or "").strip()
    if dkind not in ("", "work", "off"):
        raise ValueError("日类型只能是工作日 / 休息日 / 不限")
    steps = _clean_steps(payload.get("steps") or [])
    with _lock, conn() as c:
        if mode_id:
            row = c.execute("SELECT id FROM focus_modes WHERE id=?", (mode_id,)).fetchone()
            if not row:
                raise ValueError("没有这个模式")
            if has_shifts:
                c.execute("UPDATE focus_modes SET name=?,note=?,ring_each_step=?,auto=?,days=?,shifts=?,dkind=?"
                          " WHERE id=?",
                          (name, note, ring, auto, json.dumps(days), json.dumps(shifts), dkind, mode_id))
            else:
                c.execute("UPDATE focus_modes SET name=?,note=?,ring_each_step=?,auto=?,days=?,dkind=?"
                          " WHERE id=?", (name, note, ring, auto, json.dumps(days), dkind, mode_id))
            c.execute("DELETE FROM focus_steps WHERE mode_id=?", (mode_id,))
            rid = mode_id
        else:
            base = c.execute("SELECT COALESCE(MAX(sort),0) FROM focus_modes").fetchone()[0]
            c.execute("INSERT INTO focus_modes(name,note,ring_each_step,sort,created_at,auto,days,shifts,dkind)"
                      " VALUES(?,?,?,?,?,?,?,?,?)",
                      (name, note, ring, base + 1, now_bj(), auto, json.dumps(days), json.dumps(shifts), dkind))
            rid = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        for i, (title, minutes, anchor, s_note) in enumerate(steps):
            c.execute("INSERT INTO focus_steps(mode_id,title,minutes,anchor,note,sort)"
                      " VALUES(?,?,?,?,?,?)", (rid, title, minutes, anchor, s_note, i))
        # 保存完按班次真源把镜像重新灌一遍，任何入口（AI / 老脚本）都不会留脏数据
        _sync_mode_shifts(c)
    return {"ok": True, "id": rid}


def focus_del_mode(mode_id: int) -> bool:
    with _lock, conn() as c:
        if not c.execute("SELECT id FROM focus_modes WHERE id=?", (mode_id,)).fetchone():
            return False
        c.execute("DELETE FROM focus_steps WHERE mode_id=?", (mode_id,))
        c.execute("DELETE FROM focus_modes WHERE id=?", (mode_id,))
        c.execute("UPDATE focus_runs SET status='quit', ended_at=? WHERE mode_id=? AND status='running'",
                  (now_bj(), mode_id))
        # 班次上如果挂了这套模式，一并摘掉
        for r in c.execute("SELECT id,modes FROM shift_types"):
            try:
                mids = [int(x) for x in json.loads(r["modes"] or "[]")]
            except Exception:
                mids = []
            if mode_id in mids:
                c.execute("UPDATE shift_types SET modes=? WHERE id=?",
                          (json.dumps([m for m in mids if m != mode_id]), r["id"]))
        return True


def focus_start_run(mode_id: int, plan: str = "auto") -> dict:
    """plan：shift=从现在顺延（各步时长不变）；plan=按原时刻（已过的步骤跳过）。"""
    with _lock, conn() as c:
        mode = c.execute("SELECT id,name FROM focus_modes WHERE id=?", (mode_id,)).fetchone()
        if not mode:
            raise ValueError("没有这个模式")
        steps = _fill_anchors([dict(r) for r in c.execute(
            "SELECT title,minutes,anchor FROM focus_steps WHERE mode_id=? ORDER BY sort,id",
            (mode_id,))])
        if not steps:
            raise ValueError("这个模式还没有步骤")
        now = now_bj()
        day = today_bj()
        idx = 0
        plan = (plan or "auto").strip().lower()

        def _at(i: int, anchor: str) -> str:
            return f"{day} {anchor}:00"

        if plan == "shift":
            # 从现在开始，保持每步时长，锚点整体平移到今天
            hm = now[11:16]
            for st in steps:
                st["anchor"] = hm
                hm = _add_min(hm, int(st["minutes"] or 0))[0]
            cur = now
        elif plan == "plan":
            # 按原时刻：落在「已开始、还没结束」的那一步，不能按「下一段的开始时间」往后跳。
            # 例：09:00 的 150 分钟段，11:18 点开始，仍是这一段（还剩 12 分钟），不该直接进 11:30 的下一段。
            now_hm = now[11:16]
            idx = None
            start_day = day
            for i, st in enumerate(steps):
                start = st["anchor"]
                end, cross = _add_min(start, int(st["minutes"] or 0))
                inside = (now_hm >= start or now_hm < end) if cross else (start <= now_hm < end)
                if inside:
                    idx = i
                    # 跨午夜、且现在是凌晨：这一段是昨天开的，开始时间要落回昨天，
                    # 否则 cur_start 会被写成「今天 22:00」这种未来时间。
                    if cross and now_hm < end:
                        start_day = _shift_day(day, -1)
                    break
            if idx is None:
                if now_hm < steps[0]["anchor"]:
                    idx = 0          # 还没到第一段：就从第一段开始
                else:
                    raise ValueError("今天的步骤都已经过点，选「从现在顺延」再开始")
            day = start_day
            cur = f"{day} {steps[idx]['anchor']}:00"
        else:
            cur = now
            first = steps[0]
            at = _at(0, first["anchor"])
            if at > cur:
                cur = at
        # 同一时间只允许一场：老的开着的直接结掉
        c.execute("UPDATE focus_runs SET status='quit', ended_at=? WHERE status='running'", (now,))
        c.execute("INSERT INTO focus_runs(mode_id,mode_name,day,started_at,cur_start,step_idx,status,ended_at,snapshot)"
                  " VALUES(?,?,?,?,?,?,'running','',?)",
                  (mode_id, mode["name"], day, now, cur, idx,
                   json.dumps(steps, ensure_ascii=False)))
        rid = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    return focus_get_run(rid)


def focus_get_run(run_id: int) -> dict:
    with _lock, conn() as c:
        row = c.execute("SELECT * FROM focus_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise ValueError("没有这场专注")
        d = dict(row)
        try:
            d["snapshot"] = json.loads(d.get("snapshot") or "[]")
        except Exception:
            d["snapshot"] = []
        return {"ok": True, "run": d}


def focus_update_run(run_id: int, fields: dict) -> dict:
    allow = {"step_idx", "status", "cur_start", "ended_at"}
    patch = {k: v for k, v in (fields or {}).items() if k in allow}
    if "status" in patch and patch["status"] not in ("running", "done", "quit"):
        raise ValueError("状态不合法")
    if patch.get("status") in ("done", "quit") and not patch.get("ended_at"):
        patch["ended_at"] = now_bj()
    with _lock, conn() as c:
        if not c.execute("SELECT id FROM focus_runs WHERE id=?", (run_id,)).fetchone():
            raise ValueError("没有这场专注")
        if patch:
            cols = ",".join(f"{k}=?" for k in patch)
            c.execute(f"UPDATE focus_runs SET {cols} WHERE id=?", (*patch.values(), run_id))
        row = c.execute("SELECT * FROM focus_runs WHERE id=?", (run_id,)).fetchone()
        d = dict(row)
        try:
            d["snapshot"] = json.loads(d.get("snapshot") or "[]")
        except Exception:
            d["snapshot"] = []
    return {"ok": True, "run": d}


def _span_min(start: str, end: str) -> int:
    """两个 HH:MM 之间隔了多少分钟；end<=start 视为跨天。"""
    try:
        sh, sm = int(start[:2]), int(start[3:5])
        eh, em = int(end[:2]), int(end[3:5])
    except Exception:
        return 0
    a = sh * 60 + sm
    b = eh * 60 + em
    return (b - a) if b > a else (b + 1440 - a)


def _add_min(hhmm: str, minutes: int) -> tuple[str, int]:
    """从 HH:MM 往后推 minutes，返回 (HH:MM, 是否跨天)。"""
    m = int(hhmm[:2]) * 60 + int(hhmm[3:5]) + int(minutes)
    return f"{(m % 1440) // 60:02d}:{m % 60:02d}", (1 if m >= 1440 else 0)


# ---------- AI 改库的存档 / 回滚 ----------
# AI 直接写库以后，总得有条退路：每次动手前把「工作台那几张表」整份抄成一份 JSON，
# 只抄这些表（几 KB），不抄 18MB 的行情库，快且够用；行情数据 AI 不碰，没必要跟着存。
AI_CHAT_LOG = BASE / "data" / "ai_chats.json"


def _ai_log_read() -> list:
    try:
        items = json.loads(AI_CHAT_LOG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [x for x in items if isinstance(x, dict)]


def ai_log_add(item: dict, keep: int = 200) -> dict:
    """记一条 AI 对话（用户原话 + 它回的 + 实际改了什么）。查历史、复盘误改都靠这个。"""
    with _lock:
        items = _ai_log_read()
        item = dict(item)
        item["id"] = max([int(x.get("id") or 0) for x in items] or [0]) + 1
        items.append(item)
        AI_CHAT_LOG.write_text(json.dumps(items[-keep:], ensure_ascii=False, indent=1), encoding="utf-8")
    return item


def ai_log_list(limit: int = 80) -> list:
    return _ai_log_read()[-max(1, min(int(limit or 80), 200)):][::-1]   # 最新的在前


def ai_log_clear() -> None:
    with _lock:
        AI_CHAT_LOG.write_text("[]", encoding="utf-8")


def ai_log_mark_undone(snapshot: str) -> int:
    """某次改动被回滚了：把对应那几条历史标上，免得历史里还写着「已改」。"""
    with _lock:
        items = _ai_log_read()
        n = 0
        for x in items:
            if snapshot and x.get("snapshot") == snapshot:
                x["undone"] = True
                n += 1
        if n:
            AI_CHAT_LOG.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    return n


AI_TABLES = ("work_types", "work_tasks", "focus_modes", "focus_steps",
             "shift_types", "shift_rosters", "shift_overrides", "focus_step_done")
BK_DIR = BASE / "data" / "backups"
BK_KEEP = 30


# ---- AI 直写 SQL 的受控通道 ------------------------------------------------
# AI 自己写 INSERT/UPDATE/DELETE，这里只做三件事：表白名单、单事务、失败整体回滚。
# 不做任何「op 解析」「关键词归类」——那是把 AI 当表单填，追不上真实需求。
_SQL_FORBIDDEN = re.compile(
    r"\b(drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|replace|into\s+sqlite_)\b", re.I)


def _sql_tables(stmt: str) -> set[str]:
    """粗解析一条语句碰到的表名（够用来做白名单校验，不求完备）。"""
    t = re.sub(r"--[^\n]*", " ", stmt)
    t = re.sub(r"/\*.*?\*/", " ", t, flags=re.S)
    tabs = set()
    for m in re.finditer(r"\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update|delete\s+from|from|join)\s+([A-Za-z_][\w]*)", t, re.I):
        tabs.add(m.group(1).lower())
    return tabs


def ai_sql_exec(script: str) -> dict:
    """执行 AI 给的一段 SQL（多条用 ; 分隔）。只许写白名单表，整体一个事务。"""
    stmts = _sql_split(str(script or ""))
    if not stmts:
        raise ValueError("没有可执行的 SQL")
    if len(stmts) > 60:
        raise ValueError("SQL 条数太多（>60），拆开再来")
    allowed = {t.lower() for t in AI_TABLES}
    affects: set[str] = set()
    selects: list[str] = []
    for st in stmts:
        # INSERT OR REPLACE 是主键表的标准 upsert，不是 REPLACE INTO，别误杀
        if _SQL_FORBIDDEN.search(re.sub(r"insert\s+or\s+replace", "insert", st, flags=re.I)):
            raise ValueError("只允许 INSERT / UPDATE / DELETE 工作台相关的表")
        head = re.match(r"\s*(\w+)", st)
        kw = head.group(1).lower() if head else ""
        tabs = _sql_tables(st)
        bad = tabs - allowed
        if bad:
            raise ValueError(f"不能动这些表：{'、'.join(sorted(bad))}")
        if kw == "select":
            selects.append(st)
            continue
        if kw not in ("insert", "update", "delete", "with"):
            raise ValueError(f"不支持的语句：{st[:40]}")
        affects |= tabs
    with _lock, conn() as c:
        total = 0
        rows_seen: list[list] = []
        per_stmt: list[tuple[str, int]] = []
        # 写之前预演：DELETE/UPDATE 的 WHERE 若一行都匹配不到，多半是模型看错了范围——整单拒绝，不动库
        misses = []
        for st in stmts:
            if st in selects:
                continue
            m = re.match(r"\s*(delete\s+from|update)\s+(\w+)(.*?)\s+where\s+(.+)$", st, re.I | re.S)
            if m:
                table, where = m.group(2), m.group(4).strip().rstrip(";")
                try:
                    hit = c.execute("SELECT COUNT(*) FROM %s WHERE %s" % (table, where)).fetchone()[0]
                except Exception:
                    hit = -1
                if hit == 0:
                    misses.append(st[:80])
        if misses:
            raise ValueError("这些语句在库里一行都匹配不到（范围可能看错了）：%s" % " ｜ ".join(misses))
        for st in stmts:
            if st in selects:
                cur = c.execute(st)
                rows_seen.append([dict(r) for r in cur.fetchmany(50)])
                continue
            cur = c.execute(st)
            n = max(1, cur.rowcount if cur.rowcount is not None else 0)
            total += n
            per_stmt.append((st, n))
        # 写完立刻自检：这几张表还能被正常读出来，否则整单回滚
        for t in affects:
            c.execute(f"SELECT * FROM {t} LIMIT 1").fetchone()
        # 排班不变量：模型喜欢用「改 effective_from」来截断，结果留下 effective_from > end_date 的空壳行。
        # 这种行在页面上不显示，但会让「删干净了吗」变得说不清——直接清掉，让库和用户看到的一致。
        if "shift_rosters" in affects:
            gone = c.execute("DELETE FROM shift_rosters WHERE end_date IS NOT NULL AND effective_from > end_date").rowcount
            if gone:
                per_stmt.append(("[系统] 清理 effective_from > end_date 的空区间轮转表", gone))
                total += gone
    return {"ok": True, "n": len(stmts) - len(selects), "n_select": len(selects), "rows": total,
            "tables": sorted(affects), "select_results": rows_seen,
            "per_stmt": per_stmt}


def _sql_split(script: str) -> list[str]:
    """按分号拆句，但不拆引号里的分号。模型给的 SQL 往往一行多条，不能只认 `;\n`。"""
    out, buf, q = [], [], None
    i, n = 0, len(script)
    while i < n:
        ch = script[i]
        if q:
            buf.append(ch)
            if ch == q:
                if i + 1 < n and script[i + 1] == q:   # 转义的 ''
                    buf.append(q); i += 1
                else:
                    q = None
        elif ch in "'\"":
            q = ch; buf.append(ch)
        elif ch == ";" :
            st = "".join(buf).strip()
            if st: out.append(st)
            buf = []
        else:
            buf.append(ch)
        i += 1
    st = "".join(buf).strip()
    if st: out.append(st)
    return out


def work_snapshot(tag: str = "ai", extra: dict | None = None) -> dict:
    """把工作台相关的表拍一份快照，extra 里放 daily.json 这类库外数据。"""
    BK_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(BJ).strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r"[^a-z0-9]+", "", str(tag or "ai").lower())[:6] or "ai"
    name = f"{ts}-{safe}"
    data: dict = {"at": now_bj(), "tables": {}, "extra": extra or {}}
    with _lock, conn() as c:
        for t in AI_TABLES:
            rows = [dict(r) for r in c.execute(f"SELECT * FROM {t}")]
            data["tables"][t] = rows
    path = BK_DIR / f"{name}.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    _bk_prune()
    return {"id": name, "at": data["at"], "rows": sum(len(v) for v in data["tables"].values()),
            "per_table": {k: len(v) for k, v in data["tables"].items()}}


def _bk_prune() -> None:
    files = sorted(BK_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for f in files[BK_KEEP:]:
        try:
            f.unlink()
        except OSError:
            pass


def work_snapshots(limit: int = 12) -> list:
    if not BK_DIR.exists():
        return []
    out = []
    for f in sorted(BK_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": f.stem, "at": d.get("at") or "", "tag": f.stem.split("-")[-1],
                    "rows": sum(len(v) for v in (d.get("tables") or {}).values())})
    return out


def work_restore(name: str) -> dict:
    """按快照把工作台那几张表整份换回去，返回 extra（daily.json 由调用方写回）。"""
    name = str(name or "").strip()
    if not re.match(r"^\d{8}-\d{6}-[a-z0-9]+$", name):
        raise ValueError("快照名不对")
    path = BK_DIR / f"{name}.json"
    if not path.exists():
        raise ValueError("找不到这份快照：可能已经轮转清掉了")
    d = json.loads(path.read_text(encoding="utf-8"))
    tables = d.get("tables") or {}
    with _lock, conn() as c:
        for t in AI_TABLES:
            if not isinstance(tables.get(t), list):
                continue
            c.execute(f"DELETE FROM {t}")
            rows = tables[t] or []
            if not rows:
                continue
            cols = list(rows[0].keys())
            placeholders = ",".join("?" for _ in cols)
            c.executemany(
                f"INSERT INTO {t}({','.join(cols)}) VALUES({placeholders})",
                [[r.get(k) for k in cols] for r in rows])
    return {"id": name, "extra": d.get("extra") or {},
            "per_table": {k: len(v or []) for k, v in tables.items()}}


def _shift_rows(c: sqlite3.Connection) -> dict:
    types = []
    for r in c.execute("SELECT id,name,short,start,end,cross_day,kind,dur_min,breaks,sort,modes"
                       " FROM shift_types ORDER BY sort,id"):
        d = dict(r)
        d["kind"] = d.get("kind") or "shift"
        d["dur_min"] = int(d.get("dur_min") or 0)
        try:
            raw = json.loads(d.get("breaks") or "[]")
            d["breaks"] = [[str(a)[:5], str(b)[:5]] for a, b in raw]
            if len(d["breaks"]) != len(raw):
                raise ValueError("休息段格式不对")
        except Exception as e:
            # 解析失败不能静默成「没有休息」：至少留一条日志，别让页面上看起来像从没设过
            log.warning("班次 %s(%s) 的休息段解析失败，按无休息处理：%s", d.get("id"), d.get("name"), e)
            d["breaks"] = []
        try:
            d["modes"] = [int(x) for x in json.loads(d.get("modes") or "[]")]
        except Exception:
            d["modes"] = []
        if not d["dur_min"] and d["kind"] != "off" and d["start"] and d["end"]:
            # 老数据 / 长日班没填时长时，用起止补一个，避免前端拿到 0
            d["dur_min"] = _span_min(d["start"], d["end"])
        d["break_min"] = sum(_break_len(a, b) for a, b in d["breaks"]) if d["kind"] != "off" else 0
        d["work_min"] = max(0, int(d["dur_min"]) - d["break_min"])
        types.append(d)
    rosters = []
    for r in c.execute("SELECT id,name,pattern,start_date,effective_from,end_date,days FROM shift_rosters"
                       " ORDER BY effective_from, id"):
        d = dict(r)
        d["end_date"] = (d.get("end_date") or "")[:10] or None
        try:
            d["pattern"] = [int(x) for x in json.loads(d["pattern"] or "[]")]
        except Exception:
            d["pattern"] = []
        try:
            d["days"] = sorted({int(x) for x in json.loads(d.get("days") or "[]")}) or None
        except Exception:
            log.warning("轮转表 %s(%s) 的在岗日解析失败，按每天处理：%s", d.get("id"), d.get("name"), d.get("days"))
            d["days"] = None
        if d["days"] and any(x < 1 or x > 7 for x in d["days"]):
            d["days"] = None
        rosters.append(d)
    ov = {r["day"]: int(r["shift_id"]) for r in c.execute("SELECT day,shift_id FROM shift_overrides")}
    return {"types": types, "rosters": rosters, "overrides": ov}


def _shift_seed(c: sqlite3.Connection) -> None:
    """第一次打开：给两套最常见的班次和一张四班两倒的轮转表，用户随时可改可删。"""
    if c.execute("SELECT COUNT(*) FROM shift_types").fetchone()[0]:
        return
    day = today_bj()
    c.execute("INSERT INTO shift_types(name,short,start,end,cross_day,sort)"
              " VALUES('白班','白','08:00','20:00',0,1)")
    c.execute("INSERT INTO shift_types(name,short,start,end,cross_day,sort)"
              " VALUES('夜班','夜','20:00','08:00',1,2)")
    rows = {r["short"]: r["id"] for r in c.execute("SELECT id,short FROM shift_types")}
    pat = [rows.get("白", 0), rows.get("夜", 0), 0, 0]
    c.execute("INSERT INTO shift_rosters(name,pattern,start_date,effective_from) VALUES(?,?,?,?)",
              ("白夜休休", json.dumps(pat), day, day))


def _sync_mode_shifts(c: sqlite3.Connection) -> None:
    """班次是唯一真源；把结果镜像回 focus_modes.shifts，仅供页面展示与老逻辑兜底。"""
    per: dict[int, list] = {}
    for r in c.execute("SELECT id,modes FROM shift_types"):
        try:
            mids = [int(x) for x in json.loads(r["modes"] or "[]")]
        except Exception:
            mids = []
        for m in mids:
            per.setdefault(m, []).append(int(r["id"]))
    for r in c.execute("SELECT id FROM focus_modes"):
        mid = int(r["id"])
        c.execute("UPDATE focus_modes SET shifts=? WHERE id=?", (json.dumps(sorted(per.get(mid, []))), mid))


def shift_list() -> dict:
    with _lock, conn() as c:
        _shift_seed(c)
        return _shift_rows(c)


def _break_len(a: str, b: str) -> int:
    """休息区间长度（分钟），跨午夜按顺延算。"""
    try:
        return (_hm2min(b) - _hm2min(a)) % 1440 or 0
    except Exception:
        return 0


def _hm2min(hm: str) -> int:
    return int(str(hm)[:2]) * 60 + int(str(hm)[3:5])


def _clean_breaks(raw, start: str, dur: int) -> list:
    """休息段：都落在班次区间内、互不重叠、每段 ≥5 分钟。返回 [["12:00","13:00"], ...]。"""
    if not raw:
        return []
    out = []
    for it in raw:
        a = b = ""
        if isinstance(it, (list, tuple)) and len(it) >= 2:
            a, b = it[0], it[1]
        elif isinstance(it, dict):
            a, b = it.get("s"), it.get("e")
        try:
            a, b = _nice_time(a), _nice_time(b)
        except Exception:
            raise ValueError("休息时间格式要 HH:MM")
        n = _break_len(a, b)
        if n < 5:
            raise ValueError("每段休息至少 5 分钟")
        off = (_hm2min(a) - _hm2min(start)) % 1440
        if off + n > dur:
            raise ValueError("休息区间要在上班时间内")
        out.append((off, n, a, b))
    out.sort()
    for i in range(1, len(out)):
        if out[i][0] < out[i - 1][0] + out[i - 1][1]:
            raise ValueError("休息区间不能重叠")
    if sum(x[1] for x in out) >= dur:
        raise ValueError("休息不能占满整个班次")
    return [[x[2], x[3]] for x in out]


def _nice_time(v: str) -> str:
    v = str(v or "").strip()[:5]
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", v):
        raise ValueError("时间格式要 HH:MM")
    return v


def shift_save_type(tid: int | None, payload: dict) -> dict:
    """班次三型：常规(起止) / 长日(上班+时长) / 不值班(无时间)。"""
    name = str(payload.get("name") or "").strip()[:12]
    short = str(payload.get("short") or "").strip()[:2] or name[:1]
    if not name:
        raise ValueError("名称不能为空")
    if not short:
        raise ValueError("简称不能为空")
    kind = str(payload.get("kind") or "shift").strip()
    if kind not in ("shift", "long", "off"):
        raise ValueError("班次类型只能是常规 / 长日 / 不值班")
    if kind == "off":
        # 不值班：不设时间，日历上只有「不」
        start = end = ""
        cross = 0
        dur = 0
    elif kind == "long":
        start = _nice_time(payload.get("start"))
        try:
            dur = int(payload.get("dur_min") or 0)
        except Exception:
            dur = 0
        if dur < 60 or dur > 1440:
            raise ValueError("长日班时长要在 1–24 小时之间")
        end, cross = _add_min(start, dur)
    else:
        start = _nice_time(payload.get("start"))
        end = _nice_time(payload.get("end"))
        cross = 1 if end <= start else 0
        dur = _span_min(start, end)
    # 休息区间：只有常规班 / 长日班有；不值班一律清空
    brks = _clean_breaks(payload.get("breaks"), start, dur) if kind != "off" else []
    modes = []
    for x in (payload.get("modes") or []):
        try:
            modes.append(int(x))
        except Exception:
            continue
    with _lock, conn() as c:
        mids = {int(r["id"]) for r in c.execute("SELECT id FROM focus_modes")}
        modes = sorted({m for m in modes if m in mids})
        if tid:
            if not c.execute("SELECT id FROM shift_types WHERE id=?", (tid,)).fetchone():
                raise ValueError("没有这个班次")
            c.execute("UPDATE shift_types SET name=?,short=?,start=?,end=?,cross_day=?,kind=?,dur_min=?,breaks=?,modes=?"
                      " WHERE id=?", (name, short, start, end, cross, kind, dur, json.dumps(brks), json.dumps(modes), tid))
            rid = tid
        else:
            base = c.execute("SELECT COALESCE(MAX(sort),0) FROM shift_types").fetchone()[0]
            c.execute("INSERT INTO shift_types(name,short,start,end,cross_day,kind,dur_min,breaks,sort,modes)"
                      " VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (name, short, start, end, cross, kind, dur, json.dumps(brks), base + 1, json.dumps(modes)))
            rid = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        _sync_mode_shifts(c)
    return {"ok": True, "id": rid, "cross_day": cross, "kind": kind, "start": start, "end": end,
            "breaks": brks}


def shift_del_type(tid: int) -> dict:
    """删班次：被轮转表引用的位置替换成「休」。"""
    with _lock, conn() as c:
        if not c.execute("SELECT id FROM shift_types WHERE id=?", (tid,)).fetchone():
            return {"ok": False, "used": 0}
        used = 0
        for r in c.execute("SELECT id,pattern FROM shift_rosters"):
            try:
                pat = [int(x) for x in json.loads(r["pattern"] or "[]")]
            except Exception:
                continue
            if tid in pat:
                used += 1
                c.execute("UPDATE shift_rosters SET pattern=? WHERE id=?",
                          (json.dumps([0 if x == tid else x for x in pat]), r["id"]))
        c.execute("UPDATE shift_overrides SET shift_id=0 WHERE shift_id=?", (tid,))
        c.execute("DELETE FROM shift_types WHERE id=?", (tid,))
        _sync_mode_shifts(c)
        return {"ok": True, "used": used}


def _day_before(day: str) -> str:
    return (datetime.fromisoformat(day) - timedelta(days=1)).date().isoformat()


def _relayout_rosters(c: sqlite3.Connection, keep_id: int, eff: str, end: str | None) -> str | None:
    """同一时刻只允许一套轮转生效：
    - 比这套早生效的旧表，一律截到 eff 前一天（它们没写结束日、或写得比这还晚的话）；
    - 这套自己要是有更晚的一套在等，结束日也不能越过它生效的前一天。
    返回修正后属于这套的 end_date。"""
    cut = _day_before(eff)
    nxt = None
    for r in c.execute("SELECT id,effective_from,end_date FROM shift_rosters WHERE id<>?", (keep_id,)):
        r_eff = (r["effective_from"] or "")[:10]
        r_end = (r["end_date"] or "")[:10]
        if r_eff < eff:
            # 只给「没写结束日」的旧表补一个截止日；用户自己写过的结束日不动（两套重叠时按生效日新的优先）
            if not r_end:
                c.execute("UPDATE shift_rosters SET end_date=? WHERE id=?", (cut, r["id"]))
        elif r_eff > eff:
            if nxt is None or r_eff < nxt:
                nxt = r_eff
    if nxt and (not end or end >= nxt):
        end = _day_before(nxt)
    return end


def shift_save_roster(rid: int | None, payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()[:16]
    if not name:
        raise ValueError("名称不能为空")
    pattern = payload.get("pattern") or []
    try:
        pattern = [int(x) for x in pattern]
    except Exception:
        raise ValueError("序列不合法")
    if not pattern:
        raise ValueError("序列至少要有一天")
    if len(pattern) > 30:
        raise ValueError("一轮最多 30 天")
    start_date = _nice_day(payload.get("start_date"))
    eff = _nice_day(payload.get("effective_from") or start_date)
    end = str(payload.get("end_date") or "").strip()[:10]
    end = _nice_day(end) if end else None
    raw_days = payload.get("days")
    days: list[int] | None = None
    if raw_days:
        try:
            days = sorted({int(x) for x in raw_days})
        except Exception:
            raise ValueError("在岗日不合法")
        if any(x < 1 or x > 7 for x in days):
            raise ValueError("在岗日只能是周一到周日")
        if len(days) >= 7:
            days = None
    days_json = json.dumps(days) if days else None
    if eff < start_date:
        raise ValueError("生效日不能早于开始日：开始日是这一轮的第 1 天，生效日才是从哪天起用这套")
    if end and end < eff:
        raise ValueError("结束日不能早于生效日")
    with _lock, conn() as c:
        ids = {r["id"] for r in c.execute("SELECT id FROM shift_types")}
        if any(x and int(x) not in ids for x in pattern):
            raise ValueError("序列里有不存在的班次")
        if rid:
            if not c.execute("SELECT id FROM shift_rosters WHERE id=?", (rid,)).fetchone():
                raise ValueError("没有这张轮转表")
            end = _relayout_rosters(c, rid, eff, end)
            c.execute("UPDATE shift_rosters SET name=?,pattern=?,start_date=?,effective_from=?,end_date=?,days=?"
                      " WHERE id=?", (name, json.dumps(pattern), start_date, eff, end, days_json, rid))
            return {"ok": True, "id": rid, "end_date": end}
        c.execute("INSERT INTO shift_rosters(name,pattern,start_date,effective_from,end_date,days)"
                  " VALUES(?,?,?,?,?,?)", (name, json.dumps(pattern), start_date, eff, None, days_json))
        new_id = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        end = _relayout_rosters(c, new_id, eff, end)
        c.execute("UPDATE shift_rosters SET end_date=? WHERE id=?", (end, new_id))
    return {"ok": True, "id": new_id, "end_date": end}


def shift_del_roster(rid: int) -> bool:
    with _lock, conn() as c:
        if not c.execute("SELECT id FROM shift_rosters WHERE id=?", (rid,)).fetchone():
            return False
        c.execute("DELETE FROM shift_rosters WHERE id=?", (rid,))
        return True


def _nice_day(day) -> str:
    d = str(day or "").strip()[:10]
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        raise ValueError("日期格式要 YYYY-MM-DD")
    return d


def shift_clear_overrides(start: str, end: str) -> int:
    """把一段日期里的手动调班清掉（恢复轮转），返回清掉的条数。"""
    s0 = str(start or "").strip()[:10]
    s1 = str(end or "").strip()[:10] or s0
    if not s0:
        raise ValueError("缺开始日期")
    if s1 < s0:
        s0, s1 = s1, s0
    with _lock, conn() as c:
        n = c.execute("DELETE FROM shift_overrides WHERE day>=? AND day<=?", (s0, s1)).rowcount
    return n


def shift_set_override(day: str, shift_id) -> dict:
    day = _nice_day(day)
    with _lock, conn() as c:
        if shift_id is None or shift_id == "":
            c.execute("DELETE FROM shift_overrides WHERE day=?", (day,))
            return {"ok": True, "day": day, "shift_id": None}
        sid = int(shift_id)
        if sid and not c.execute("SELECT id FROM shift_types WHERE id=?", (sid,)).fetchone():
            raise ValueError("没有这个班次")
        c.execute("INSERT INTO shift_overrides(day,shift_id) VALUES(?,?)"
                  " ON CONFLICT(day) DO UPDATE SET shift_id=excluded.shift_id", (day, sid))
    return {"ok": True, "day": day, "shift_id": sid}
