"""weather.get() 必须永远快返回：上游不通时用旧缓存 + 后台刷新。不联网测试。"""
import json, time, unittest
from pathlib import Path
import weather

STALE = {"ok": True, "place": "上海浦东新区", "updated": "11-26 09:07", "text": "晴 13.7℃", "_ts": 0}


class WeatherFastTest(unittest.TestCase):
    def setUp(self):
        self._orig_fetch = weather._fetch
        self._orig_cache = weather.CACHE
        weather._mem.update({"data": None, "fail_at": 0.0})
        self.tmp = Path("/tmp/weather-test.json")

    def tearDown(self):
        weather._fetch = self._orig_fetch
        weather.CACHE = self._orig_cache

    def _use(self, payload):
        weather.CACHE = self.tmp
        self.tmp.write_text(json.dumps(payload, ensure_ascii=False))

    def test_stale_cache_returns_immediately(self):
        """过期缓存：立即返回旧值（stale=True），不阻塞在网络上。"""
        self._use(STALE)
        weather._fetch = lambda: time.sleep(10) or None      # 模拟上游挂住
        t = time.time(); out = weather.get()
        self.assertLess(time.time() - t, 0.5)
        self.assertTrue(out["stale"])
        self.assertEqual(out["text"], "晴 13.7℃")

    def test_fresh_cache_no_network(self):
        self._use({**STALE, "_ts": time.time()})
        weather._fetch = lambda: (_ for _ in ()).throw(AssertionError("不该联网"))
        out = weather.get()
        self.assertEqual(out["text"], "晴 13.7℃")

    def test_no_cache_fails_fast_with_placeholder(self):
        weather.CACHE = Path("/tmp/weather-none.json"); weather.CACHE.unlink(missing_ok=True)
        weather._fetch = lambda: None                        # 上游不通
        t = time.time(); out = weather.get()
        self.assertLess(time.time() - t, 0.2)
        self.assertFalse(out["ok"])
        self.assertIn("天气暂时取不到", out["text"])

    def test_failure_keeps_old_file(self):
        self._use(STALE)
        weather._fetch = lambda: None
        weather.get()
        self.assertEqual(json.loads(self.tmp.read_text())["text"], "晴 13.7℃")


if __name__ == "__main__":
    unittest.main()
