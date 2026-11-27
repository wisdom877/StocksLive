"""批量报价路径的回归测试：普通股票不能被「猜场外基金」的联想请求拖住。

历史 bug：fetch() 在抓行情「之前」逐只打腾讯联想判断是不是场外基金（每只 5 秒），
两只普通股票就能让 /api/v1/quotes 冷启动耗时 10 秒（2026-11-26 实测）。
现在只在 A 股源确实没有这个代码时才探，且探完就缓存。
"""
from __future__ import annotations

import unittest

import quotes


def _fake(symbols: list[str]) -> dict[str, dict]:
    return {s: {"code": s[2:], "name": "测试", "price": 10.0, "pct": 1.0} for s in symbols}


class BatchQuoteTest(unittest.TestCase):
    def setUp(self):
        quotes._cache.clear()
        quotes._fund_cache.clear()
        quotes._offsite_cache.clear()
        quotes._fail_until = 0.0
        quotes._tencent_fail_until = 0.0
        self._orig = (quotes._tencent_fetch, quotes._sina_fetch, quotes._em_fetch,
                      quotes._is_offsite_fund, quotes._fund_fetch)

    def tearDown(self):
        (quotes._tencent_fetch, quotes._sina_fetch, quotes._em_fetch,
         quotes._is_offsite_fund, quotes._fund_fetch) = self._orig

    def test_normal_stocks_never_probe_funds(self):
        quotes._tencent_fetch = _fake
        quotes._sina_fetch = lambda syms: {}
        quotes._em_fetch = lambda syms: {}

        def boom(code):                       # 只要被调用就说明走回了慢路径
            raise AssertionError(f"不该为 {code} 打联想请求")
        quotes._is_offsite_fund = boom
        out = quotes.fetch(["600519", "000001"])
        self.assertEqual(set(out), {"600519", "000001"})
        self.assertEqual(out["600519"]["price"], 10.0)

    def test_missing_fund_code_still_gets_nav(self):
        quotes._tencent_fetch = lambda syms: {}
        quotes._sina_fetch = lambda syms: {}
        quotes._em_fetch = lambda syms: {}
        quotes._offsite_cache["017894"] = (0.0, True)          # 已知是场外基金
        quotes._is_offsite_fund = lambda code: True
        quotes._fund_fetch = lambda codes: {c: {"code": c, "price": 1.5, "source": "fund_nav"}
                                            for c in codes}
        out = quotes.fetch(["017894"])
        self.assertEqual(out["017894"]["source"], "fund_nav")
        self.assertEqual(out["017894"]["price"], 1.5)


if __name__ == "__main__":
    unittest.main()
