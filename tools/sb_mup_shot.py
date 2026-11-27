import asyncio, sys
from playwright.async_api import async_playwright
ROOT=str(__import__("pathlib").Path(__file__).resolve().parent.parent)
URL = __import__("os").environ.get("SK_URL", "http://127.0.0.1:8099/")
MODE=sys.argv[1] if len(sys.argv)>1 else "light"
async def main():
    css=open(f"{ROOT}/web/static/style.css").read()
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path="/usr/local/bin/chromium",args=["--no-sandbox"])
        pg=await b.new_page(viewport={"width":852,"height":393},device_scale_factor=3)
        await pg.route("**/style.css*", lambda r: r.fulfill(status=200,content_type="text/css",body=css))
        await pg.goto(URL, wait_until="domcontentloaded"); await pg.wait_for_timeout(5000)
        await pg.evaluate(f"applyTheme('{MODE}')"); await pg.wait_for_timeout(400)
        await pg.evaluate("""sbOpen(); sbGo(4); sbMuPaneOpen('list');
          SB_MUP.cur='demo'; SB_MUP.curName='2025年度歌单';
          SB_MUP.tracks=[{id:'1',title:'这条小鱼在乎',artist:'王OK & 洪佩瑜',album:'这条小鱼在乎 - Single',dur:280},
                         {id:'2',title:'你就不要想起我',artist:'田馥甄',album:'渺小',dur:290},
                         {id:'3',title:'爱情转移',artist:'陈奕迅',album:'认了吧 (台湾版)',dur:260},
                         {id:'4',title:'唯一',artist:'王力宏',album:'唯一',dur:250},
                         {id:'5',title:'晴天',artist:'周杰伦',album:'叶惠美',dur:269}];
          sbMuPanePaint();""")
        await pg.wait_for_timeout(1000)
        await pg.evaluate("sbIdleReset && sbIdleReset()"); await pg.wait_for_timeout(200)
        await pg.screenshot(path=f"{ROOT}/web/static/shots/sb-mup-{MODE}.png")
        await b.close()
asyncio.run(main())
