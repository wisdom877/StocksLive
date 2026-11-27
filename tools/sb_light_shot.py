"""待机浅色巡检：抓 6 页 + 歌词层。用法：python3 tools/sb_light_shot.py [dark]"""
import asyncio, sys
from playwright.async_api import async_playwright

ROOT = str(__import__("pathlib").Path(__file__).resolve().parent.parent)
URL = __import__("os").environ.get("SK_URL", "http://127.0.0.1:8099/")
MODE = sys.argv[1] if len(sys.argv) > 1 else "light"

async def main():
    css = open(f"{ROOT}/web/static/style.css").read()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/local/bin/chromium", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 852, "height": 393}, device_scale_factor=2)
        await pg.route("**/style.css*", lambda r: r.fulfill(status=200, content_type="text/css", body=css))
        await pg.goto(URL, wait_until="domcontentloaded")
        await pg.wait_for_timeout(5000)
        await pg.evaluate(f"applyTheme('{MODE}')")
        await pg.wait_for_timeout(600)
        for n in range(6):
            await pg.evaluate(f"sbOpen(); sbGo({n})")
            await pg.wait_for_timeout(1000)
            await pg.evaluate("sbIdleReset()")
            await pg.wait_for_timeout(200)
            await pg.screenshot(path=f"{ROOT}/web/static/shots/sb-{MODE}-{n}.png")
        await b.close()

asyncio.run(main())
