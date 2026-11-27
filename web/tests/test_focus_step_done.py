"""步完成账（focus_step_done）的口径测试：不联网，临时库跑真实 SQL。"""
import tempfile
import unittest
from pathlib import Path

import store


class StepDoneTest(unittest.TestCase):
    def setUp(self):
        self._orig = store.DB_PATH
        self.tmp = Path(tempfile.mkdtemp()) / "t.db"
        store.DB_PATH = self.tmp
        store.init()

    def tearDown(self):
        store.DB_PATH = self._orig

    def test_toggle_and_list(self):
        self.assertEqual(store.focus_step_done_list("2026-11-26")["items"], [])
        store.focus_set_step_done("2026-11-26", 21, 3, True)
        rows = store.focus_step_done_list("2026-11-26")["items"]
        self.assertEqual([(r["mode_id"], r["step_idx"]) for r in rows], [(21, 3)])
        # 同一格重复写不该长出新行
        store.focus_set_step_done("2026-11-26", 21, 3, True)
        self.assertEqual(len(store.focus_step_done_list("2026-11-26")["items"]), 1)
        store.focus_set_step_done("2026-11-26", 21, 3, False)
        self.assertEqual(store.focus_step_done_list("2026-11-26")["items"], [])

    def test_window_keeps_cross_midnight(self):
        store.focus_set_step_done("2026-11-26", 21, 8, True)
        store.focus_set_step_done("2026-11-27", 21, 9, True)   # 跨午夜的下一步算次日
        rows = store.focus_step_done_list("2026-11-26")["items"]
        self.assertEqual([(r["day"], r["step_idx"]) for r in rows],
                         [("2026-11-26", 8), ("2026-11-27", 9)])
        # 明天的查询看不到昨天的账
        self.assertEqual(store.focus_step_done_list("2026-11-27")["items"][0]["day"], "2026-11-27")

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            store.focus_step_done_list("26/11/2026")
        with self.assertRaises(ValueError):
            store.focus_set_step_done("2026-11-26", 0, 3, True)
        with self.assertRaises(ValueError):
            store.focus_set_step_done("2026-11-26", 21, 24, True)

    def test_old_rows_pruned(self):
        store.focus_set_step_done("2026-10-01", 21, 1, True)
        store.focus_set_step_done("2026-11-26", 21, 2, True)   # 写新的一天时清 30 天前
        self.assertEqual(store.focus_step_done_list("2026-10-01")["items"], [])


if __name__ == "__main__":
    unittest.main()
