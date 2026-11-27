"""AI 改库通道要不要碰 focus_step_done：白名单、真实性、快照回滚。"""
import tempfile
import unittest
from pathlib import Path

import store


class AiStepDoneTest(unittest.TestCase):
    def setUp(self):
        self._orig_db, self._orig_bk = store.DB_PATH, store.BK_DIR
        tmp = Path(tempfile.mkdtemp())
        store.DB_PATH = tmp / "t.db"
        store.BK_DIR = tmp / "bk"
        store.init()

    def tearDown(self):
        store.DB_PATH, store.BK_DIR = self._orig_db, self._orig_bk

    def test_insert_into_whitelist(self):
        r = store.ai_sql_exec("INSERT OR REPLACE INTO focus_step_done(day, mode_id, step_idx, done_at, done_by)"
                              " VALUES('2026-11-26', 21, 2, '2026-11-26 15:00:00', 'ai')")
        self.assertEqual(r["rows"], 1)
        self.assertIn("focus_step_done", r["tables"])
        self.assertEqual(store.focus_step_done_list("2026-11-26")["items"][0]["step_idx"], 2)

    def test_delete_and_zero_match_guard(self):
        store.focus_set_step_done("2026-11-26", 21, 2, True)
        r = store.ai_sql_exec("DELETE FROM focus_step_done WHERE day='2026-11-26' AND mode_id=21 AND step_idx=2")
        self.assertEqual(r["rows"], 1)
        # 已经不存在的行再删：宁可不改，也不假装改过
        with self.assertRaises(ValueError):
            store.ai_sql_exec("DELETE FROM focus_step_done WHERE day='2026-11-26' AND mode_id=21 AND step_idx=2")

    def test_rejects_other_tables(self):
        with self.assertRaises(ValueError):
            store.ai_sql_exec("DELETE FROM market_cache WHERE 1=1")

    def test_snapshot_restore_round_trip(self):
        store.focus_set_step_done("2026-11-26", 21, 0, True)
        snap = store.work_snapshot("ai")
        store.focus_set_step_done("2026-11-26", 21, 1, True)
        self.assertEqual(len(store.focus_step_done_list("2026-11-26")["items"]), 2)
        store.work_restore(snap["id"])
        rows = store.focus_step_done_list("2026-11-26")["items"]
        self.assertEqual([(r["mode_id"], r["step_idx"]) for r in rows], [(21, 0)])

    def test_context_lists_done_rows(self):
        store.focus_set_step_done("2026-11-26", 21, 4, True)
        d = store.ai_context_data("2026-11-26", "2026-11-26")
        self.assertEqual([(x["day"], x["mode_id"], x["step_idx"]) for x in d["done"]],
                         [("2026-11-26", 21, 4)])


if __name__ == "__main__":
    unittest.main()
