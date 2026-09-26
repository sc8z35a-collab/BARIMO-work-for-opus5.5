# Quick first-person ground-cover check: enter walk mode, let tiles settle, screenshot a few viewing angles.
# usage: python3 tools/grassqa.py [url] [region]
import asyncio, sys, os
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
REGION = sys.argv[2] if len(sys.argv) > 2 else 'tusheti'
OUT = '/tmp/qa'
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':915,'height':412}, is_mobile=True, has_touch=True)
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await pg.goto(URL + '?qa=1' + (sys.argv[3] if len(sys.argv) > 3 else ''), wait_until='networkidle', timeout=120000)
        await pg.wait_for_timeout(1500)
        await pg.evaluate(f'__barimo.openRegion("{REGION}")')
        await pg.wait_for_selector('.region-ui', state='attached', timeout=240000)
        await pg.evaluate('window.__barimoPause = true')
        ev = pg.evaluate
        async def settle(frames=30, rounds=5):
            for _ in range(rounds):
                await ev(f'__barimo.step({frames}, 1/30, false)'); await pg.wait_for_timeout(1200)
            await ev('__barimo.step(1, 1/30, true)')
        await settle(60, 3)
        await ev('document.querySelector("[data-act=walk]").click()')
        await settle(30, 7)
        print('ground', await ev('JSON.stringify({vis: __barimo.region.ground?.group.visible, ready: __barimo.region.ground?.ready, agl: __barimo.region.fp.agl().toFixed(2)})'))
        await pg.screenshot(path=f'{OUT}/g1.png', timeout=180000)
        await ev("(()=>{const G=__barimo.region.ground; G._saved=G.layers; G.layers=[]; G.group.visible=false;})()"); await settle(5, 2)
        await pg.screenshot(path=f"{OUT}/g0_nograss.png", timeout=180000)
        await ev("(()=>{const G=__barimo.region.ground; G.layers=G._saved;})()")
        await ev('__barimo.region.fp.pitch = -0.35'); await settle(5, 2)
        await pg.screenshot(path=f'{OUT}/g2_down.png', timeout=180000)
        await ev('__barimo.region.fp.pitch = -0.05; __barimo.region.fp.yaw += 2.2'); await settle(10, 3)
        await pg.screenshot(path=f'{OUT}/g3_turn.png', timeout=180000)
        print('errors', errs[:5])
        await b.close()
asyncio.run(main())
