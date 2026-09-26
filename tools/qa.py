# End-to-end visual QA on a landscape phone viewport (software GL).
# usage: python3 tools/qa.py [base_url] [region] [steps]
#   steps: comma list of: intro,globe,gzoom,region,mapzoom,labels,panel,fp,fly,nav,back,switch  (default: all)
import asyncio, sys, os, json, time
from playwright.async_api import async_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4173/'
REGION = sys.argv[2] if len(sys.argv) > 2 else 'tusheti'
STEPS = (sys.argv[3] if len(sys.argv) > 3 else 'all').split(',')
OUT = '/tmp/qa'
want = lambda s: 'all' in STEPS or s in STEPS

async def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT): os.remove(os.path.join(OUT, f))
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 915, 'height': 412}, device_scale_factor=1, is_mobile=True, has_touch=True)
        logs = []
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        n = [0]
        async def shot(name, wait=0):
            if wait: await pg.wait_for_timeout(wait)
            n[0] += 1
            await pg.screenshot(timeout=180000, path=f'{OUT}/{n[0]:02d}_{name}.png')
        async def ev(js): return await pg.evaluate(js)
        async def drag(x0, y0, x1, y1, steps=8):
            await pg.mouse.move(x0, y0); await pg.mouse.down()
            for i in range(1, steps + 1): await pg.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
            await pg.mouse.up()

        t0 = time.time()
        await pg.goto(URL + '?qa=1', wait_until='networkidle', timeout=120000)
        await pg.wait_for_timeout(2500)
        if want('intro'): await shot('intro')
        await pg.click('.start'); await pg.wait_for_timeout(2000)
        if want('globe'):
            await shot('globe', 1500)
            await drag(450, 200, 300, 230)  # drag that ends somewhere: must not select a pin
            sel = await ev('!!document.querySelector(".preview")')
            print('drag-selected-preview:', sel)
        if want('gzoom'):
            await ev(f'__barimo.globe.flyTo(__barimo.regions().find(r=>r.id=="{REGION}").center[0], __barimo.regions().find(r=>r.id=="{REGION}").center[1], 0.02, 0.5)')
            await pg.wait_for_timeout(9000)
            await shot('globe_zoom_deep', 4000)
            print('globe alt km:', await ev('Math.round(__barimo.globe.altitudeKm)'), 'patches:', await ev('__barimo.globe.patches.children.filter(m=>m.visible).length'), 'tex:', await ev('__barimo.globe.store.tex.size'))
            await ev('__barimo.globe.flyTo(20, 40, 3.2, 0.5)'); await pg.wait_for_timeout(2500)
        await pg.click(f'.card[data-id="{REGION}"]'); await pg.wait_for_timeout(2500)
        if want('globe'): await shot('globe_preview')
        await pg.click('.preview .go')
        await pg.wait_for_selector('.region-ui', state='attached', timeout=240000)
        print('region loaded in', round(time.time() - t0), 's')
        await pg.wait_for_timeout(9000)
        if want('region'):
            await shot('region_open', 6000)
            print('stats:', await ev('JSON.stringify(__barimo.region.engine.stats)'), 'store:', await ev('JSON.stringify(__barimo.region.store.stats)'))
        if want('panel'):
            await pg.click('[data-tab=pl]'); await shot('panel_places', 800)
            await pg.click('[data-tab=rt]'); await shot('panel_ratings', 800)
        if want('mapzoom'):
            await ev('document.querySelector("[data-act=panel]").click()')
            await ev('(()=>{const R=__barimo.region, L=R.labels[0]; R.map.flyTo(L.x, L.z, {dist: 1500, tilt: 1.15, dur: 0.5});})()')
            await pg.wait_for_timeout(4000)
            for i in range(8):
                await pg.wait_for_timeout(2500)
            await shot('map_zoom_1500m', 2000)
            print('zoom stats:', await ev('JSON.stringify(__barimo.region.engine.stats)'), await ev('JSON.stringify(__barimo.region.store.stats)'))
            await ev('(()=>{const R=__barimo.region, L=R.labels[0]; R.map.flyTo(L.x, L.z, {dist: 250, tilt: 0.9, dur: 0.5});})()')
            for i in range(10): await pg.wait_for_timeout(2500)
            await shot('map_zoom_250m', 2000)
            print('deep stats:', await ev('JSON.stringify(__barimo.region.engine.stats)'), await ev('JSON.stringify(__barimo.region.store.stats)'))
            await ev('__barimo.region.resetView()'); await pg.wait_for_timeout(6000)
        if want('labels'):
            await shot('labels_overview', 3000)
            vis = await ev('__barimo.region.labels.filter(l=>l.vis).map(l=>l.p.name).join(", ")')
            print('visible labels:', vis)
            lbl = await ev('(()=>{const l=__barimo.region.labels.find(l=>l.vis); if(!l) return null; const r=l.el.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2, l.p.name];})()')
            if lbl:
                await pg.mouse.click(lbl[0], lbl[1]); await pg.wait_for_timeout(1500)
                await shot('label_card', 3000)
                print('card open:', await ev('!document.querySelector(".card3").classList.contains("hidden")'), lbl[2])
        if want('fp'):
            await ev('document.querySelector(".card3 .c3x")?.click()')
            await pg.click('[data-act=walk]'); await pg.wait_for_timeout(3000)
            for i in range(6): await pg.wait_for_timeout(2500)
            await shot('fp_walk', 2000)
            print('fp:', await ev('JSON.stringify({agl: __barimo.region.fp.agl(), mode: __barimo.region.fp.mode, pos: __barimo.region.fp.pos})'))
            # joystick forward for a few seconds
            jb = await ev('(()=>{const r=document.querySelector(".joy").getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2, r.height];})()')
            await pg.mouse.move(jb[0], jb[1]); await pg.mouse.down(); await pg.mouse.move(jb[0], jb[1] - jb[2] * 0.4)
            p0 = await ev('[__barimo.region.fp.pos.x, __barimo.region.fp.pos.z]')
            await pg.wait_for_timeout(6000)
            p1 = await ev('[__barimo.region.fp.pos.x, __barimo.region.fp.pos.z]')
            await pg.mouse.up()
            print('walked m:', round(((p1[0]-p0[0])**2 + (p1[1]-p0[1])**2) ** 0.5, 1))
            await drag(600, 200, 450, 210)  # look around
            await shot('fp_walk_look', 3000)
        if want('fly'):
            await ev('document.querySelector("[data-m=fly]").click()')
            await ev('__barimo.region.fp.lift = 1'); await pg.wait_for_timeout(8000); await ev('__barimo.region.fp.lift = 0')
            await ev('__barimo.region.fp.pitch = -0.25')
            for i in range(4): await pg.wait_for_timeout(2500)
            await shot('fp_drone', 2000)
            print('drone agl:', await ev('Math.round(__barimo.region.fp.agl())'))
        if want('nav'):
            await ev('(()=>{const R=__barimo.region, L=R.labels.find(l=>l.kind!=="poi")||R.labels[0]; R.fp.setNav({x:L.x, z:L.z, name:L.p.name, auto:true}); document.querySelector(".navbar").classList.remove("hidden");})()')
            await pg.wait_for_timeout(8000)
            await shot('fp_nav', 3000)
            print('nav:', await ev('JSON.stringify(__barimo.region.fp.nav)'))
        if want('back'):
            await ev('document.querySelector("[data-act=back]").click()')  # fp -> map
            await pg.wait_for_timeout(4000)
            await shot('back_to_map', 3000)
            print('mode after back:', await ev('__barimo.region.mode'))
            await ev('document.querySelector("[data-act=back]").click()')  # map -> globe
            await pg.wait_for_timeout(3500)
            await shot('back_to_globe', 1500)
            print('app mode:', await ev('__barimo.mode'), 'labels left:', await ev('document.querySelectorAll(".tl").length'))
        if want('switch'):
            await ev('__barimo.openRegion("ouvea")')
            await pg.wait_for_selector('.region-ui', state='attached', timeout=240000)
            await pg.wait_for_timeout(12000)
            await shot('switch_ouvea', 5000)
        print('\n'.join(l for l in logs if 'GPU stall' not in l and 'swiftshader' not in l.lower() and 'WebGL' not in l)[:4000])
        await b.close()

asyncio.run(main())
