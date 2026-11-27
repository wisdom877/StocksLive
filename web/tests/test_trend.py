"""趋势选股纯函数测试（不联网）。"""
from __future__ import annotations

import unittest
from unittest import mock

import trend


def bars(closes, start_day: int = 1):
    return [(f"2026-{(start_day + i) // 28 + 1:02d}-{(start_day + i) % 28 + 1:02d}", float(c))
            for i, c in enumerate(closes)]


class MainBoardTest(unittest.TestCase):
    def test_include_sh_sz_main(self):
        for code in ("600000", "601318", "603366", "605001",
                     "000001", "001219", "002415", "003001"):
            self.assertTrue(trend.is_main_board(code), code)

    def test_exclude_other_boards(self):
        for code in ("300750", "301001", "688981", "689009",
                     "920001", "830799", "430047", "510300", "159915"):
            self.assertFalse(trend.is_main_board(code), code)

    def test_normalize_filters_and_dedupes(self):
        rows = [
            {"code": "600000", "name": "浦发银行", "trade": "10.02", "settlement": "9.99",
             "changepercent": "0.3", "pricechange": "0.03"},
            {"code": "300750", "name": "宁德时代", "trade": "1", "settlement": "1",
             "changepercent": "1", "pricechange": "0.01"},
            {"code": "600000", "name": "重复", "trade": "1", "settlement": "1",
             "changepercent": "1", "pricechange": "0.01"},
        ]
        out = trend._normalize_universe(rows)
        self.assertEqual([x["code"] for x in out], ["600000"])
        self.assertEqual(out[0]["name"], "浦发银行")
        self.assertAlmostEqual(out[0]["trade"], 10.02)


class CheckTest(unittest.TestCase):
    def test_steady_uptrend_passes(self):
        got = trend.check(bars([10 + i * 0.1 for i in range(60)]))
        self.assertIsNotNone(got)
        self.assertEqual(got["streak"], 59)
        self.assertFalse(got["new_stock"])
        self.assertGreater(got["dist_ma20"], 0)
        self.assertGreater(got["ma20_slope"], 0)
        self.assertEqual(len(got["streak_pcts"]), 59)
        self.assertAlmostEqual(got["streak_total"], 59.0)
        self.assertEqual(len(got["spark"]), 20)

    def test_streak_must_be_two(self):
        series = [10 + i * 0.1 for i in range(40)] + [14.0, 13.8, 13.9]
        self.assertIsNone(trend.check(bars(series)))          # 最后一波只有 1 天
        got = trend.check(bars(series), min_streak=1)
        self.assertIsNotNone(got)
        self.assertEqual(got["streak"], 1)

    def test_below_ma20_fails(self):
        series = [10 + i * 0.1 for i in range(59)] + [9.0]
        self.assertIsNone(trend.check(bars(series)))

    def test_ma20_not_rising_fails(self):
        series = [20 - i * 0.2 for i in range(40)] + [12.0, 12.3, 12.6, 12.9, 13.2, 13.5]
        self.assertIsNone(trend.check(bars(series)))

    def test_bull_alignment_is_strict(self):
        # 收盘在 MA20 上、MA20 向上，但 MA5 == MA10，不算多头排列
        series = [10 + i * 0.1 for i in range(60)] + [15.6, 15.3, 15.5, 15.7]
        self.assertIsNone(trend.check(bars(series)))

    def test_new_stock_relaxes_ma60(self):
        got = trend.check(bars([10 + i * 0.1 for i in range(30)]))
        self.assertIsNotNone(got)
        self.assertTrue(got["new_stock"])
        self.assertIsNone(got["ma60"])

    def test_short_history_fails(self):
        self.assertIsNone(trend.check(bars([10 + i * 0.1 for i in range(24)])))

    def test_min_streak_parameter(self):
        series = [10 + i * 0.1 for i in range(60)]
        self.assertIsNone(trend.check(bars(series), min_streak=60))
        self.assertIsNotNone(trend.check(bars(series), min_streak=59))


class SettleTest(unittest.TestCase):
    def test_matching_previous_close(self):
        b = [("2026-10-29", 10.0), ("2026-10-30", 10.5)]
        self.assertTrue(trend._settle_ok(b, {"settlement": 10.0}))
        self.assertFalse(trend._settle_ok(b, {"settlement": 9.8}))
        self.assertTrue(trend._settle_ok(b, {"settlement": 0}))

    def test_tolerance_for_high_price(self):
        b = [("2026-10-29", 1000.0), ("2026-10-30", 1010.0)]
        self.assertTrue(trend._settle_ok(b, {"settlement": 1001.0}))

    def test_cached_series_ending_prev(self):
        # 缓存止于昨天：offset=0 应比较最后一根，而不是倒数第二根
        b = [("2026-10-27", 9.8), ("2026-10-28", 10.0), ("2026-10-29", 10.5)]
        self.assertFalse(trend._settle_ok(b, {"settlement": 10.5}))
        self.assertTrue(trend._settle_ok(b, {"settlement": 10.5}, offset=0))


class MergeTest(unittest.TestCase):
    def test_append_today(self):
        b = [("2026-10-28", 10), ("2026-10-29", 10.5)]
        out = trend._merge_today(b, ("2026-10-30", 11.0), "2026-10-30", "2026-10-29")
        self.assertEqual(out[-1], ("2026-10-30", 11.0))

    def test_already_has_today(self):
        b = [("2026-10-29", 10.5), ("2026-10-30", 11.0)]
        out = trend._merge_today(b, ("2026-10-30", 11.0), "2026-10-30", "2026-10-29")
        self.assertEqual(out, b)

    def test_gap_is_rejected(self):
        b = [("2026-10-27", 10)]
        with self.assertRaises(trend.FetchError):
            trend._merge_today(b, ("2026-10-30", 11.0), "2026-10-30", "2026-10-29")


class IncrementalTest(unittest.TestCase):
    latest, prev = "2026-10-30", "2026-10-29"

    @mock.patch("trend._fetch_ths_today", return_value=10.6)
    def test_qfq_cache_appends_today(self, today):
        item = {"code": "600000", "settlement": 10.5}
        row = {"source": "ths", "bars": [("2026-10-28", 10.4), ("2026-10-29", 10.5)]}
        bars, src = trend._fetch_incremental(item, row, self.latest, self.prev)
        self.assertEqual(src, "ths+today")
        self.assertEqual(bars[-1], (self.latest, 10.6))
        today.assert_called_once_with("600000", self.latest)

    @mock.patch("trend._fetch_full", return_value=([("2026-10-29", 10.5), ("2026-10-30", 10.6)], "ths"))
    def test_unadjusted_cache_refetches_full(self, full):
        item = {"code": "600000", "settlement": 10.5}
        row = {"source": "sina_unadj", "bars": [("2026-10-28", 10.4), ("2026-10-29", 10.5)]}
        bars, src = trend._fetch_incremental(item, row, self.latest, self.prev)
        self.assertEqual(src, "ths")
        full.assert_called_once()


class EnrichTest(unittest.TestCase):
    def setUp(self):
        # 生产默认已切到 ETF；这组用例验证选股模式的补全逻辑，显式切回 stock。
        self._mode = trend.MODE
        trend._apply_mode("stock")
        self.addCleanup(trend._apply_mode, self._mode)

    def test_clean_tags_filters_noise_and_region(self):
        self.assertEqual(trend._clean_tags(["高速公路", "标准普尔", "央国企改革", "中盘价值"]),
                         ["高速公路"])
        self.assertEqual(trend._clean_tags(["股份制银行", "互联网金融", "金融地产风格", "MSCI中国"]),
                         ["股份制银行", "互联网金融"])
        self.assertEqual(trend._clean_tags(["烘焙食品", "山东", "调味品", "乳业"]),
                         ["烘焙食品", "调味品", "乳业"])

    @mock.patch("trend.tags.auto_tags", return_value=["股份制银行", "互联网金融", "金融地产风格", "MSCI中国"])
    @mock.patch("trend.quotes.fetch", return_value={"600000": {
        "pe": 6.5, "float_cap": 3337.2, "total_cap": 3337.2,
        "vol_ratio": 0.86, "turnover_rate": 0.19, "pb": 0.44}})
    def test_enrich_merges_quote_and_tags(self, _fetch, _tags):
        hits = [{"code": "600000"}]
        items = {"600000": {"pe": 6.59, "float_cap": 3337.24, "turnover": 0.194}}
        trend._enrich_hits(hits, items)
        h = hits[0]
        self.assertAlmostEqual(h["pe"], 6.5)
        self.assertAlmostEqual(h["float_cap"], 3337.2)
        self.assertAlmostEqual(h["vol_ratio"], 0.86)
        self.assertAlmostEqual(h["turnover_rate"], 0.19)
        self.assertEqual(h["tags"], ["股份制银行", "互联网金融"])

    @mock.patch("trend.tags.auto_tags", return_value=[])
    @mock.patch("trend.quotes.fetch", return_value={})
    def test_enrich_falls_back_to_universe(self, _fetch, _tags):
        hits = [{"code": "600000"}]
        items = {"600000": {"pe": 6.59, "float_cap": 3337.24, "turnover": 0.194}}
        trend._enrich_hits(hits, items)
        h = hits[0]
        self.assertAlmostEqual(h["pe"], 6.59)
        self.assertAlmostEqual(h["float_cap"], 3337.24)
        self.assertAlmostEqual(h["turnover_rate"], 0.194)
        self.assertIsNone(h["vol_ratio"])
        self.assertEqual(h["tags"], [])


class ListDaysTest(unittest.TestCase):
    def test_reads_previous_history(self):
        import json
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            (p / "2026-10-29.json").write_text(json.dumps({
                "items": [{"code": "600000", "on_list_days": 3}, {"code": "000001"}]
            }, ensure_ascii=False))
            with mock.patch("trend.HISTORY_DIR", p):
                self.assertEqual(trend._prev_list_days("2026-10-29"),
                                 {"600000": 3, "000001": 1})
                self.assertEqual(trend._prev_list_days("2026-10-28"), {})


class HistoryDatesTest(unittest.TestCase):
    def test_dates_and_latest_history(self):
        import json
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            (p / "2026-10-29.json").write_text(json.dumps({
                "date": "2026-10-29", "items": [], "passed": 0,
            }, ensure_ascii=False))
            (p / "2026-10-30.json").write_text(json.dumps({
                "date": "2026-10-30", "items": [], "passed": 0,
            }, ensure_ascii=False))
            with mock.patch("trend.HISTORY_DIR", p), mock.patch("trend.LATEST_PATH", p / "2026-10-30.json"):
                self.assertEqual(trend.available_dates(), ["2026-10-30", "2026-10-29"])
                d = trend.latest("2026-10-29")
                self.assertTrue(d["available"])
                self.assertTrue(d["is_history"])
                self.assertEqual(d["date"], "2026-10-29")
                self.assertEqual(d["dates"], ["2026-10-30", "2026-10-29"])
                self.assertFalse(trend.latest("bad-date")["available"])
                self.assertFalse(trend.latest("2026-10-28")["available"])


class CleanBarsTest(unittest.TestCase):
    def test_dedupe_sort_and_drop_bad(self):
        raw = [("2026-01-02", "10"), ("2026-01-01", "9"),
               ("2026-01-02", "11"), ("bad", "5"), ("2026-01-03", "0")]
        self.assertEqual(trend._clean_bars(raw),
                         [("2026-01-01", 9.0), ("2026-01-02", 11.0)])


class PrefilterTest(unittest.TestCase):
    def test_up_down(self):
        self.assertTrue(trend._is_up(0.3, 0.03))
        self.assertTrue(trend._is_up(0, 0.01))
        self.assertFalse(trend._is_up(0, 0))
        self.assertTrue(trend._is_down(-0.1, -0.01))
        self.assertFalse(trend._is_down(0, 0))


if __name__ == "__main__":
    unittest.main()
