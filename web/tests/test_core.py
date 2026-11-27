"""核心纯函数测试：不联网、不依赖数据库。运行：

    /root/stock-site/venv/bin/python -m unittest discover -s tests -v
"""
from __future__ import annotations

import unittest
from datetime import datetime

import market_calendar
import quotes

BJ = quotes.BJ


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


class SecidTest(unittest.TestCase):
    def test_markets(self):
        self.assertEqual(quotes.secid("600519"), "sh600519")
        self.assertEqual(quotes.secid("000001"), "sz000001")
        self.assertEqual(quotes.secid("300750"), "sz300750")
        self.assertEqual(quotes.secid("159148"), "sz159148")
        self.assertEqual(quotes.secid("510300"), "sh510300")
        self.assertEqual(quotes.secid("920001"), "bj920001")
        self.assertEqual(quotes.secid("830799"), "bj830799")
        self.assertEqual(quotes.secid("430047"), "bj430047")


class TradingDayTest(unittest.TestCase):
    def test_weekend_and_holiday(self):
        self.assertFalse(quotes.is_trading_day("2026-10-24"))   # 周六
        self.assertFalse(quotes.is_trading_day("2026-10-25"))   # 周日
        self.assertFalse(quotes.is_trading_day("2026-10-01"))   # 国庆
        self.assertTrue(quotes.is_trading_day("2026-10-26"))    # 周一
        self.assertFalse(quotes.is_trading_day("bad-date"))


class NextOpenTest(unittest.TestCase):
    def at(self, text: str) -> datetime:
        return datetime.fromisoformat(text).replace(tzinfo=BJ)

    def test_pre_open_boundary(self):
        # 9:14 旧逻辑会把下一次算到明天；现在应指向今天 9:15
        self.assertEqual(quotes.next_open_at(self.at("2026-10-26 09:14:00")),
                         _ms(self.at("2026-10-26 09:15:00")))
        # 9:15 起进入集合竞价，不再需要唤醒时刻
        self.assertEqual(quotes.next_open_at(self.at("2026-10-26 09:15:00")), 0)

    def test_lunch(self):
        self.assertEqual(quotes.next_open_at(self.at("2026-10-26 11:30:00")),
                         _ms(self.at("2026-10-26 13:00:00")))
        self.assertEqual(quotes.next_open_at(self.at("2026-10-26 13:00:00")), 0)

    def test_after_close_and_holiday(self):
        # 周一收盘 -> 周二 9:15
        self.assertEqual(quotes.next_open_at(self.at("2026-10-26 15:00:00")),
                         _ms(self.at("2026-10-27 09:15:00")))
        # 周五收盘 -> 下周一 9:15
        self.assertEqual(quotes.next_open_at(self.at("2026-10-23 15:00:00")),
                         _ms(self.at("2026-10-26 09:15:00")))
        # 国庆假期内 -> 10/8 9:15
        self.assertEqual(quotes.next_open_at(self.at("2026-10-02 10:00:00")),
                         _ms(self.at("2026-10-08 09:15:00")))

    def test_naive_is_beijing(self):
        naive = datetime(2026, 10, 26, 9, 14)
        self.assertEqual(quotes.next_open_at(naive),
                         _ms(self.at("2026-10-26 09:15:00")))


class MarketCalendarTest(unittest.TestCase):
    def test_key_dates_this_week(self):
        got = {(e["day"], e["title"], e["time"]) for e in market_calendar.upcoming(14, "2026-10-27")}
        self.assertIn(("2026-10-28", "ETF 期权到期日", ""), got)
        self.assertIn(("2026-10-29", "美联储公布利率决议", "02:00"), got)
        self.assertIn(("2026-10-31", "三季报披露截止日", ""), got)

    def test_fourth_wednesday(self):
        self.assertEqual(market_calendar._nth_weekday(2026, 10, 2, 4).isoformat(), "2026-10-28")


class ParseTest(unittest.TestCase):
    def test_tencent_line(self):
        f = [""] * 55
        vals = {
            1: "贵州茅台", 2: "600519", 3: "1349.98", 4: "1335.00", 5: "1325.40",
            30: "20261026161450", 31: "14.98", 32: "1.12", 33: "1350.00", 34: "1324.79",
            36: "41599", 37: "557429", 38: "0.33", 39: "20.72",
            44: "16875.00", 45: "16875.00", 46: "8.1", 49: "1.05",
        }
        for i, v in vals.items():
            f[i] = v
        line = 'v_sh600519="' + "~".join(f) + '";'
        d = quotes._parse(line)
        self.assertIsNotNone(d)
        self.assertEqual(d["code"], "600519")
        self.assertEqual(d["name"], "贵州茅台")
        self.assertAlmostEqual(d["price"], 1349.98)
        self.assertAlmostEqual(d["pct"], 1.12)
        self.assertAlmostEqual(d["change"], 14.98)
        self.assertAlmostEqual(d["turnover_rate"], 0.33)
        self.assertAlmostEqual(d["vol_ratio"], 1.05)
        self.assertEqual(d["source"], "tx")

    def test_bad_line(self):
        self.assertIsNone(quotes._parse("not a quote"))


if __name__ == "__main__":
    unittest.main()
