# Visual QA: renders the app at a flagship-Android landscape viewport and captures screenshots.
# usage: python3 tools/shot.py [url] [regionId]
import asyncio, sys, os
from playwright.async_api import async_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
REGION = sys.argv[2] if len(sys.argv) > 2 else 'tusheti'
OUT = '/tmp/shots'
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 915, 'height': 412}, device_scale_factor=1, is_mobile=True, has_touch=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        await pg.goto(URL + '?qa=1', wait_until='networkidle', timeout=90000)
        await pg.wait_for_timeout(2500)
        await pg.screenshot(timeout=120000, path=f'{OUT}/1_intro.png')
        await pg.click('.start'); await pg.wait_for_timeout(2500)
        await pg.click(f'.card[data-id="{REGION}"]'); await pg.wait_for_timeout(3500)
        await pg.screenshot(timeout=120000, path=f'{OUT}/2_globe.png')
        await pg.click('.preview .go')
        await pg.wait_for_selector('.region-ui', state='attached', timeout=240000)
        await pg.wait_for_timeout(12000)
        await pg.screenshot(timeout=120000, path=f'{OUT}/3_region.png')
        await pg.click('[data-tab=rt]'); await pg.wait_for_timeout(800)
        await pg.screenshot(timeout=120000, path=f'{OUT}/4_ratings.png')
        await pg.click('[data-tab=gl]'); await pg.wait_for_timeout(1500)
        await pg.screenshot(timeout=120000, path=f'{OUT}/5_gallery.png')
        await pg.click('[data-act=panel]'); await pg.click('[data-t=golden]'); await pg.wait_for_timeout(4000)
        await pg.screenshot(timeout=120000, path=f'{OUT}/6_golden.png')
        print('\n'.join(l for l in logs if 'GPU stall' not in l and 'swiftshader' not in l.lower())[:3000])
        await b.close()
asyncio.run(main())
