# Deterministic first-person QA: pauses the rAF loop and steps the simulation manually, waiting for tile streaming
# between steps, so screenshots show converged frames even on ~1 fps software GL.
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
        await pg.goto(URL + '?qa=1', wait_until='networkidle', timeout=120000)
        await pg.wait_for_timeout(2000)
        await pg.click('.start'); await pg.wait_for_timeout(1500)
        await pg.evaluate(f'__barimo.openRegion("{REGION}")')
        await pg.wait_for_selector('.region-ui', state='attached', timeout=240000)
        await pg.evaluate('window.__barimoPause = true')
        ev = pg.evaluate
        async def settle(frames=40, rounds=6, dt=1/30):
            for _ in range(rounds):
                await ev(f'__barimo.step({frames}, {dt}, false)')
                await pg.wait_for_timeout(1500)
            await ev('__barimo.step(1, 1/30, true)')
        async def shot(name):
            await pg.screenshot(timeout=180000, path=f'{OUT}/{name}.png')
        await settle(60, 4)
        await ev('document.querySelector("[data-act=walk]").click()')
        await settle(30, 8)
        info = await ev('JSON.stringify({agl: __barimo.region.fp.agl().toFixed(2), yaw: __barimo.region.fp.yaw.toFixed(2), pitch: __barimo.region.fp.pitch.toFixed(2), stats: __barimo.region.engine.stats, st: __barimo.region.store.stats})')
        print('fp enter', info); await shot('f1_walk_enter')
        # walk forward 20 s simulated
        await ev('__barimo.region.fp.joy.y = -1')
        p0 = await ev('[__barimo.region.fp.pos.x, __barimo.region.fp.pos.z]')
        for _ in range(10):
            await ev('__barimo.step(60, 1/30, false)'); await pg.wait_for_timeout(600)
        await ev('__barimo.region.fp.joy.y = 0')
        p1 = await ev('[__barimo.region.fp.pos.x, __barimo.region.fp.pos.z]')
        print('walked', round(((p1[0]-p0[0])**2 + (p1[1]-p0[1])**2) ** .5, 1), 'm in 20 s; agl', await ev('__barimo.region.fp.agl().toFixed(2)'))
        await settle(20, 5); await shot('f2_walk_after')
        # look around 180°
        await ev('__barimo.region.fp.yaw += Math.PI')
        await settle(20, 5); await shot('f3_walk_turn')
        # drone
        await ev('document.querySelector("[data-m=fly]").click()')
        await ev('__barimo.region.fp.lift = 1'); await ev('__barimo.step(150, 1/30, false)'); await ev('__barimo.region.fp.lift = 0')
        await ev('__barimo.region.fp.pitch = -0.28')
        await settle(20, 6); await shot('f4_drone')
        print('drone agl', await ev('__barimo.region.fp.agl().toFixed(0)'))
        # autopilot to a place
        await ev('(()=>{const R=__barimo.region, L=R.labels.find(l=>l.kind==="village")||R.labels[1]; R.fp.setNav({x:L.x, z:L.z, name:L.p.name, auto:true}); window.__L=L;})()')
        d0 = await ev('Math.hypot(__L.x-__barimo.region.fp.pos.x, __L.z-__barimo.region.fp.pos.z)')
        for _ in range(12):
            await ev('__barimo.step(90, 1/30, false)'); await pg.wait_for_timeout(500)
        d1 = await ev('Math.hypot(__L.x-__barimo.region.fp.pos.x, __L.z-__barimo.region.fp.pos.z)')
        print('autopilot', await ev('__L.p.name'), round(d0), '->', round(d1), 'm; arrived', await ev('__barimo.region.fp.nav?.arrived'))
        await settle(20, 5); await shot('f5_autopilot')
        await ev('document.querySelector("[data-act=back]").click()')
        await settle(30, 4); await shot('f6_back_map')
        print('mode', await ev('__barimo.region.mode'), 'errors', errs)
        await b.close()
asyncio.run(main())
