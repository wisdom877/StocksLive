"""新闻总结：事件级去重 / 主分类 / 必看多样化（不联网、不写库）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import news_digest as nd  # noqa: E402


def item(title: str, at: str = "2026-10-31 10:00", level: str = "B") -> dict:
    return {"title": title, "at": at, "level": level}


class EventDedupeTest(unittest.TestCase):
    def test_same_document_fragments_merge(self):
        items = [
            item("北京：力争到2030年全市氢能产业链规模突破400亿元："
                 "北京市经信局印发《北京市氢能产业发展实施方案（2026—2030年）》。"),
            item("北京：做强燃料电池汽车全产业链："
                 "北京市经信局印发《北京市氢能产业发展实施方案（2026—2030年）》。"),
        ]
        self.assertEqual(len(nd._dedupe_events(items)), 1)

    def test_same_wire_story_merges(self):
        items = [
            item("巴拿马南部地区发生6.1级地震：金十数据11月1日讯，根据巴拿马大学地球科学研究所发布的初步报告，"
                 "当地时间10月31日10时50分，巴拿马南部发生6.1级地震，震源深度10公里。"),
            item("巴拿马南部地区发生6.1级地震：根据巴拿马大学地球科学研究所发布的初步报告，"
                 "当地时间10月31日10时50分，巴拿马南部发生6.1级地震，震源深度10公里。"),
        ]
        self.assertEqual(len(nd._dedupe_events(items)), 1)

    def test_source_boilerplate_does_not_merge_unrelated(self):
        items = [
            item("长鑫科技：已与多家头部客户协商长期供货协议：《科创板日报》31日讯，记者获悉，"
                 "长鑫科技管理层表示，目前公司已与多家头部客户协商长期供货协议，锁定中长期确定性需求。"),
            item("苹果和阿里巴巴达成合作千问集成到Apple智能：《科创板日报》31日讯，"
                 "苹果和阿里巴巴宣布达成合作，将千问集成至Apple智能，中国用户可以在Siri中直接调用。"),
        ]
        self.assertEqual(len(nd._dedupe_events(items)), 2)


class SectionTest(unittest.TestCase):
    def test_policy_wins_over_energy_and_car(self):
        title = "国务院印发《氢能产业发展实施方案》：推动燃料电池汽车产业发展"
        self.assertEqual(nd._section_for(title), "政策")

    def test_module_is_not_duplicated_in_ai(self):
        self.assertEqual(nd._section_for("中际旭创：800G光模块订单增长"), "光模块(易中天)")

    def test_unmatched_is_empty(self):
        self.assertEqual(nd._section_for("某地举办城市马拉松比赛"), "")


class SlotTest(unittest.TestCase):
    def test_slot_boundaries(self):
        from datetime import datetime
        self.assertEqual(nd.slot_for(datetime(2026, 11, 11, 8, 0, tzinfo=nd.BJ)), "am")
        self.assertEqual(nd.slot_for(datetime(2026, 11, 11, 20, 0, tzinfo=nd.BJ)), "pm")

    def test_auto_hours_from_previous_window_end(self):
        from datetime import datetime
        from unittest import mock
        prev = [{"day": "2026-11-11", "slot": "pm", "window_end": "2026-11-11 20:24",
                 "updated_at": "2026-11-11 20:25:36"}]
        end = datetime(2026, 11, 12, 8, 0, tzinfo=nd.BJ)
        with mock.patch.object(nd.store, "list_digests", return_value=prev):
            self.assertAlmostEqual(nd.auto_hours(end, "am"), 11.6, places=2)

    def test_auto_hours_same_slot_rerun_is_12h(self):
        from datetime import datetime
        from unittest import mock
        prev = [{"day": "2026-11-11", "slot": "pm", "window_end": "2026-11-11 20:24"}]
        end = datetime(2026, 11, 11, 20, 30, tzinfo=nd.BJ)
        with mock.patch.object(nd.store, "list_digests", return_value=prev):
            self.assertEqual(nd.auto_hours(end, "pm"), 12.0)


class PortfolioKeyTest(unittest.TestCase):
    def test_generic_etf_prefix_is_not_an_alias(self):
        keys = nd._stock_keys({"name": "机器人ETF汇添富", "code": "159213"})
        self.assertNotIn("机器人", keys)
        self.assertIn("机器人ETF汇添富", keys)
        self.assertIn("159213", keys)

    def test_specific_etf_prefix_is_an_alias(self):
        keys = nd._stock_keys({"name": "科创100ETF富国", "code": "589950"})
        self.assertIn("科创100", keys)


class PreviousDigestTest(unittest.TestCase):
    def test_parse_sections_and_must(self):
        from unittest import mock
        content = ("结论\n## 必看 · 2 条\n- 甲\n- 乙\n## 政策 · 3 条\n- 丙\n")
        prev = [{"day": "2026-11-11", "slot": "am", "window_end": "2026-11-11 08:00",
                 "updated_at": "2026-11-11 08:01", "total": 3, "content": content}]
        with mock.patch.object(nd.store, "list_digests", return_value=prev):
            got = nd._previous_digest()
        self.assertEqual(got["must"], ["甲", "乙"])
        self.assertIn({"name": "政策", "count": 3}, got["sections"])


class RadarTest(unittest.TestCase):
    def test_sector_keys_bank_and_etf(self):
        bank = nd._sector_keys({"name": "工商银行", "tags": ["国有大型银行"]})
        self.assertIn("LPR", bank)
        self.assertIn("社融", bank)
        comm = nd._sector_keys({"name": "通信ETF国泰", "tags": []})
        self.assertIn("光模块", comm)
        self.assertIn("CPO", comm)

    def test_radar_covers_every_stock_and_related_driver(self):
        from unittest import mock
        portfolio = [{"code": "601398", "name": "工商银行", "bucket": "hold",
                      "priority": "A", "tags": [], "ext_tags": ["国有大型银行"]}]
        items = [
            {"id": 1, "title": "工商银行：定增申请获上交所审核通过",
             "at": "2026-11-11 16:46", "level": "B"},
            {"id": 2, "title": "央行开展1870亿元逆回购操作",
             "at": "2026-11-11 09:20", "level": "B"},
        ]
        with mock.patch("quotes.fetch", return_value={"601398": {"price": 8.53, "pct": -0.81}}):
            radar = nd._portfolio_radar(items, portfolio)
        self.assertEqual(len(radar), 1)          # 无消息也要保留这只股
        self.assertEqual(radar[0]["direct"][0]["id"], 1)
        self.assertEqual(radar[0]["related"][0]["id"], 2)


class SortDigestTest(unittest.TestCase):
    def test_bullets_sorted_newest_first(self):
        from unittest import mock
        text = ("lead\n## 今日主线 · 2 条\n- 20:00 old {{n1}}\n- 22:00 new {{n2}}\n"
                "## 接下来关注 · 1 条\n- 11-12 20:00 later\n")
        news = [{"id": 1, "published_at": "2026-11-11 20:00"},
                {"id": 2, "published_at": "2026-11-11 22:00"}]
        with mock.patch.object(nd.store, "news_by_ids", return_value=news):
            out = nd.sort_digest_by_time(text)
        self.assertLess(out.index("22:00 new"), out.index("20:00 old"))

    def test_radar_keeps_stock_order(self):
        from unittest import mock
        text = ("## 持仓/关注雷达 · 2 条\n- 甲(1) 20:00 old {{n1}}\n- 乙(2) 22:00 new {{n2}}\n")
        news = [{"id": 1, "published_at": "2026-11-11 20:00"},
                {"id": 2, "published_at": "2026-11-11 22:00"}]
        with mock.patch.object(nd.store, "news_by_ids", return_value=news):
            out = nd.sort_digest_by_time(text)
        self.assertLess(out.index("甲(1)"), out.index("乙(2)"))


class TimeCheckTest(unittest.TestCase):
    def test_check_times_flags_missing_time(self):
        text = ("## 必看 · 2 条\n- 20:43 有时间的条目\n- 没有时间的条目\n"
                "## 较上期 · 1 条\n- 政策 24→40\n")
        bad = nd.check_times(text)
        self.assertEqual(len(bad), 1)
        self.assertIn("没有时间的条目", bad[0])

    def test_check_citations_flags_missing_source(self):
        text = ("## 今日主线 · 2 条\n- 20:43 有来源 {{n1}}\n- 21:00 没有来源\n"
                "## 较上期 · 1 条\n- 政策 24→40\n")
        bad = nd.check_citations(text)
        self.assertEqual(len(bad), 1)
        self.assertIn("没有来源", bad[0])


class StoryTest(unittest.TestCase):
    def test_stock_story_key(self):
        key, label = nd._story_key("工商银行：向特定对象发行A股股票申请获上交所审核通过",
                                   ["工商银行"])
        self.assertEqual(key, "stock:工商银行:定增")
        self.assertIn("工商银行", label)

    def test_topic_story_key(self):
        key, _ = nd._story_key("伊朗革命卫队称两艘油轮夜间在霍尔木兹海峡触雷爆炸")
        self.assertEqual(key, "topic:霍尔木兹/油轮")

    def test_company_name_not_mistaken_for_satellite_topic(self):
        key, _ = nd._story_key("卫星化学：拟投资约207亿元建设丙烯及下游高端新材料项目")
        self.assertNotEqual(key, "topic:军工/航天")

    def test_story_history_marks_ongoing(self):
        from unittest import mock
        prev = [{"day": "2026-11-11", "slot": "am", "content": "## 必看 · 1 条\n- 旧 {{n1}}",
                 "total": 1}]
        old = [{"id": 1, "title": "伊朗革命卫队称两艘油轮在霍尔木兹海峡触雷爆炸",
                "published_at": "2026-11-11 09:00"}]
        current = [{"id": 2, "title": "霍尔木兹油轮事件后布伦特原油涨2%",
                    "at": "2026-11-11 20:00", "level": "B"}]
        with mock.patch.object(nd.store, "list_digests", return_value=prev), \
             mock.patch.object(nd.store, "news_by_ids", return_value=old):
            stories, changes = nd._story_history(current, [], "2026-11-11", "pm")
        self.assertEqual(current[0]["story_status"], "ongoing")
        self.assertEqual(stories[0]["status"], "ongoing")
        self.assertEqual(stories[0]["prev_items"][0]["id"], 1)
        self.assertIn("霍尔木兹/油轮", changes["ongoing"])

    def test_story_history_uses_full_retention_window(self):
        """用户 2026-11-13：故事线天数要更长，按 30 天（最多 60 张卡）反查。"""
        from unittest import mock
        with mock.patch.object(nd.store, "list_digests", return_value=[]) as m:
            nd._story_history([], [], "2026-11-13", "pm")
        m.assert_called_once_with(limit=nd.store.DIGEST_KEEP_DAYS * 2)
        self.assertGreaterEqual(nd.store.DIGEST_KEEP_DAYS, 30)


class MustTest(unittest.TestCase):
    def test_must_covers_multiple_themes(self):
        items = [
            {**item("国务院印发氢能产业发展规划"), "section": "政策"},
            {**item("美国宣布对伊朗实施新一轮制裁"), "section": "海外与地缘"},
            {**item("WTI原油突破104美元，霍尔木兹油轮遇袭"), "section": "能源"},
            {**item("中际旭创发布1.6T光模块新品"), "section": "光模块(易中天)"},
            {**item("42家上市银行三季报营收增长"), "section": "金融与市场"},
            {**item("OpenAI下调融资目标"), "section": "AI与算力"},
        ]
        got = nd._pick_must(items)
        # 必看候选不设 5 条硬上限：6 个不同主题各一条
        self.assertEqual(len(got), 6)
        sections = {x["section"] for x in got}
        self.assertEqual(len(sections), 6)
        self.assertTrue({"光模块(易中天)", "AI与算力"} & sections)

    def test_render_keeps_count_wording(self):
        data = {
            "window": ["2026-10-31 07:00", "2026-11-01 07:00"],
            "raw_total": 10, "deduped_total": 8,
            "total": 5, "uncategorized": 3,
            "must": [], "sections": [{"name": "政策", "count": 5, "items": []}],
        }
        text = nd.render(data)
        self.assertIn("原始 10 条", text)
        self.assertIn("事件去重后 8 条", text)
        self.assertIn("5 条归入重点领域", text)
        self.assertIn("3 条未归入重点领域", text)

    def test_render_default_lists_every_item(self):
        """用户要求新闻总结不设字数/条数上限：不传 --bullets 时领域段不截断。"""
        data = {
            "window": ["2026-11-13 08:00", "2026-11-13 20:00"],
            "raw_total": 20, "deduped_total": 20,
            "total": 20, "uncategorized": 0,
            "must": [],
            "sections": [{"name": "政策", "count": 20,
                          "items": [f"{i:02d}:00 政策条目 {i}" for i in range(20)]}],
        }
        text = nd.render(data)
        self.assertEqual(sum(1 for line in text.splitlines() if line.startswith("- ")), 20)


if __name__ == "__main__":
    unittest.main()
