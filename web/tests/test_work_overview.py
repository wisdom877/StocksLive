"""数据总览聚合的口径测试：不联网，用临时库跑真实 SQL。"""
import tempfile
import unittest
from pathlib import Path

import store


class OverviewTest(unittest.TestCase):
    def setUp(self):
        self._orig = store.DB_PATH
        self.tmp = Path(tempfile.mkdtemp()) / "t.db"
        store.DB_PATH = self.tmp
        store.init()

    def tearDown(self):
        store.DB_PATH = self._orig

    def _run(self, **kw):
        run = {"mode_id": 1, "mode_name": "司法预审", "day": "2026-11-24",
               "started_at": "2026-11-24 09:10:00", "cur_start": "", "step_idx": 0,
               "status": "running", "ended_at": "", "snapshot": "[]"}
        run.update(kw)
        with store.conn() as c:
            c.execute("INSERT INTO focus_runs(mode_id,mode_name,day,started_at,cur_start,step_idx,"
                      "status,ended_at,snapshot) VALUES(?,?,?,?,?,?,?,?,?)",
                      (run["mode_id"], run["mode_name"], run["day"], run["started_at"],
                       run["cur_start"], run["step_idx"], run["status"], run["ended_at"],
                       run["snapshot"]))

    def test_focus_min_counts_quit_and_done(self):
        """做完的按起止算全量，放弃的也按实际坐了多久算，步数各自不同。"""
        self._run(status="done", started_at="2026-11-24 09:10:00",
                  ended_at="2026-11-24 11:40:00", step_idx=5,
                  snapshot='[{"title":"a","minutes":150},{"title":"b","minutes":120}]')
        self._run(day="2026-11-25", status="quit", started_at="2026-11-25 13:00:00",
                  ended_at="2026-11-25 13:25:00", step_idx=1)
        d = store.work_overview("2026-11-24", "2026-11-25")["days"]
        self.assertEqual(d["2026-11-24"]["focus_min"], 150)      # 2h30
        self.assertEqual(d["2026-11-24"]["focus_steps"], 2)       # 快照里的两步全做完
        self.assertEqual(d["2026-11-25"]["focus_min"], 25)        # 放弃的那场坐了 25 分钟
        self.assertEqual(d["2026-11-25"]["focus_steps"], 1)
        self.assertEqual(d["2026-11-24"]["focus_runs"], 1)

    def test_abandoned_run_capped_by_plan(self):
        """放着不管的一场（跨夜 14 小时）按计划时长封顶，别把当天涂黑。"""
        self._run(day="2026-11-25", status="quit", started_at="2026-11-25 01:00:00",
                  ended_at="2026-11-25 15:23:00",
                  snapshot='[{"title":"a","minutes":40},{"title":"b","minutes":35}]')
        d = store.work_overview("2026-11-25", "2026-11-25")["days"]
        self.assertEqual(d["2026-11-25"]["focus_min"], 75)       # 计划 40+35，不是 863
        # 做完的那场不封顶：中途歇了也算真实投入
        self._run(day="2026-11-26", status="done", started_at="2026-11-26 09:00:00",
                  ended_at="2026-11-26 12:00:00", snapshot='[{"title":"a","minutes":60}]')
        d2 = store.work_overview("2026-11-26", "2026-11-26")["days"]
        self.assertEqual(d2["2026-11-26"]["focus_min"], 180)

    def test_mode_filter_counts_only_that_mode(self):
        """选了某个专注模式：只算那个模式的场次和时长，另给一份各模式汇总挑「常用的几个」。"""
        self._run(mode_id=21, mode_name="司法预审", day="2026-11-24",
                  status="done", started_at="2026-11-24 09:10:00",
                  ended_at="2026-11-24 11:40:00", snapshot='[{"title":"a","minutes":150}]')
        self._run(mode_id=25, mode_name="白班", day="2026-11-24",
                  status="done", started_at="2026-11-24 15:05:00",
                  ended_at="2026-11-24 16:05:00", snapshot='[{"title":"b","minutes":60}]')
        allm = store.work_overview("2026-11-24", "2026-11-24")
        self.assertEqual(allm["days"]["2026-11-24"]["focus_min"], 210)
        self.assertEqual(allm["days"]["2026-11-24"]["focus_runs"], 2)
        one = store.work_overview("2026-11-24", "2026-11-24", 25)
        self.assertEqual(one["days"]["2026-11-24"]["focus_min"], 60)
        self.assertEqual(one["days"]["2026-11-24"]["focus_runs"], 1)
        self.assertEqual(one["mode_id"], 25)
        stats = {x["id"]: x for x in one["mode_stats"]}
        self.assertEqual(stats[21]["runs"], 1)
        self.assertEqual(stats[25]["min"], 60)

    def test_day_marks_come_from_annotations(self):
        """当天明细里的批注就是记录页 kind=mark 那批，按那天归日。"""
        store.add_note("这天复盘一下", ["批注"], None, "mark", when="2026-11-24 12:00:00")
        store.add_note("别的日子", ["批注"], None, "mark", when="2026-11-23 12:00:00")
        d = store.work_day_brief("2026-11-24")
        self.assertEqual(len(d["marks"]), 1)
        self.assertIn("复盘", d["marks"][0]["content"])

    def test_task_done_uses_done_at_day(self):
        """补勾旧日程：按真正勾上的那天归日，而不是原计划日。"""
        store.work_add_task(1, "旧的事", "", "2026-11-24 09:00")
        tid = store.work_list()["tasks"][-1]["id"]
        store.work_update_task(tid, {"done": 1})
        d = store.work_overview("2026-11-26", "2026-11-26")["days"]
        today = store.today_bj()[:10]
        self.assertEqual(d.get(today, {}).get("task_done"), 1)
        # 原计划日只算「有安排」，不算完成
        d2 = store.work_overview("2026-11-24", "2026-11-24")["days"]
        self.assertEqual(d2["2026-11-24"]["task_all"], 1)
        self.assertEqual(d2["2026-11-24"]["task_done"], 0)
        # 取消勾选要把完成时刻清掉
        store.work_update_task(tid, {"done": 0})
        d3 = store.work_overview(today, today)["days"]
        self.assertEqual(d3.get(today, {}).get("task_done", 0), 0)

    def test_shift_min_counts_on_start_day(self):
        """值班工时：在岗 = 总时长 − 休息；跨日班整段归到开始那天，第二天是 0。"""
        with store.conn() as c:
            c.execute("INSERT INTO shift_types(name,short,start,end,cross_day,kind,dur_min,breaks,sort)"
                      " VALUES('夜','夜','22:00','08:00',1,'shift',540,'[[\"23:00\",\"00:00\"]]',1)")
            tid = c.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            # 2 天一循环：11-23 休、11-24 上夜班；22:00 上班次日 08:00 下班，整段 540 − 60 分钟休息
            c.execute("INSERT INTO shift_rosters(name,pattern,start_date,effective_from)"
                      " VALUES('轮转','[0,%d]','2026-11-23','2026-11-01')" % tid)
        d = store.work_overview("2026-11-23", "2026-11-25")["days"]
        self.assertEqual(d["2026-11-24"]["shift_min"], 480)     # 跨日班归开始那天
        self.assertEqual(d["2026-11-25"]["shift_min"], 0)       # 第二天的零点是同一场的下半段，不重复计
        self.assertEqual(d["2026-11-23"]["shift_min"], 0)
        # 手调成「休」的那天不算工时
        with store.conn() as c:
            c.execute("INSERT OR REPLACE INTO shift_overrides(day,shift_id) VALUES('2026-11-25',0)")
        d2 = store.work_overview("2026-11-24", "2026-11-25")["days"]
        self.assertEqual(d2["2026-11-25"]["shift_min"], 0)
        self.assertEqual(d2["2026-11-24"]["shift_min"], 480)

    def test_payload_has_shift_and_modes(self):
        d = store.work_overview("2026-11-25", "2026-11-26")
        self.assertIn("shift_min", d["days"]["2026-11-25"])
        self.assertIsInstance(d["modes"], list)

    def test_bad_range_rejected(self):
        with self.assertRaises(ValueError):
            store.work_overview("2026-11", "2026-11-26")


if __name__ == "__main__":
    unittest.main()
