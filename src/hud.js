// Region HUD: compass, coordinates/elevation readout, map controls, minimap (tap to jump), place card,
// first-person controls (virtual joystick, look, altitude buttons, walk/drone switch, speed), navigation arrow.
import { escapeHTML, fmtDist, fmtLL, dirName, bearingXZ, angDiff, clamp } from './geo.js';

const KIND = { poi: '見どころ', peak: '山', village: '村', town: '町', lake: '湖', waterfall: '滝', pass: '峠' };

export function createHUD({ region, r, icons, toast, closePanel, speeds }) {
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = `
    <div class="compass" role="button" tabindex="0" aria-label="北を上にする"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="none" stroke="rgba(38,52,60,.15)"/><g class="needle"><path d="M20 5l4 15h-8z" fill="${r.accent}"/><path d="M20 35l4-15h-8z" fill="rgba(38,52,60,.25)"/><text x="20" y="4.4" font-size="6" text-anchor="middle" fill="#26343c" font-weight="700">N</text></g></svg></div>
    <div class="readout glass"><b class="ro-elev">—</b><span class="ro-ll"></span><span class="ro-alt"></span><i class="ro-load" title="読み込み中"></i></div>
    <div class="mapctl map-only">
      <button class="icon-btn" data-z="in" aria-label="ズームイン">${icons.plus}</button>
      <button class="icon-btn" data-z="out" aria-label="ズームアウト">${icons.minus}</button>
      <button class="icon-btn" data-act="home" aria-label="全体表示">${icons.home}</button>
    </div>
    <button class="walk-btn map-only" data-act="walk">${icons.walk}<span>地上を歩く</span></button>
    <div class="minimap glass" aria-label="ミニマップ（タップで移動）"><img src="/${r.assets.overviewSmall}" alt="" draggable="false"><i class="mm-view"></i><i class="mm-me"></i><i class="mm-dest"></i></div>
    <div class="card3 glass hidden" role="dialog"></div>
    <div class="fp-only fpctl">
      <div class="joy" aria-label="移動スティック"><i class="knob"></i></div>
      <div class="fp-right">
        <div class="seg modesw"><button class="chip on" data-m="walk">🚶 徒歩</button><button class="chip" data-m="fly">🚁 ドローン</button></div>
        <button class="chip spd" data-act="speed"></button>
        <div class="lift fly-only"><button class="icon-btn" data-lift="1" aria-label="上昇">▲</button><button class="icon-btn" data-lift="-1" aria-label="下降">▼</button></div>
      </div>
      <button class="chip exitfp" data-act="exitfp">${icons.map}<span>地図に戻る</span></button>
      <div class="navbar glass hidden"><i class="arrow">➤</i><span class="nv-name"></span><b class="nv-dist"></b><button class="chip nv-auto" data-act="auto">自動で進む</button><button class="nv-x" data-act="navx" aria-label="案内を終了">×</button></div>
      <div class="xhair"></div>
    </div>`;
  const $ = (s) => el.querySelector(s), $$ = (s) => [...el.querySelectorAll(s)];
  const card = $('.card3');
  let cardL = null;

  // ---- map controls
  $('[data-z=in]').addEventListener('click', () => region.zoom(0.5));
  $('[data-z=out]').addEventListener('click', () => region.zoom(2));
  $('[data-act=home]').addEventListener('click', () => region.resetView());
  $('.compass').addEventListener('click', () => region.northUp());
  $('[data-act=walk]').addEventListener('click', () => {
    closeCard();
    region.enterFirstPerson();
    toast('地上に降りました。左スティックで移動、画面ドラッグで見回せます', 3800);
  });

  // ---- minimap: tap to jump (map) / set destination (first person)
  const mm = $('.minimap');
  mm.addEventListener('click', (e) => {
    const rc = mm.getBoundingClientRect();
    const u = clamp((e.clientX - rc.left) / rc.width, 0.01, 0.99), v = clamp((e.clientY - rc.top) / rc.height, 0.01, 0.99);
    const [x, z] = region.F.uvToXZ([u, v]);
    if (region.mode === 'map') region.map.flyTo(x, z, { dist: Math.min(region.map.dist, 9000) });
    else { region.fp.setNav({ x, z, name: '選んだ地点', auto: false }); showNav(); }
  });
  mm.addEventListener('dblclick', (e) => e.preventDefault());

  // ---- place card
  function showCard(L) {
    cardL = L;
    const p = L.p, fp = region.mode === 'fp';
    const d = fp ? Math.hypot(L.x - region.fp.pos.x, L.z - region.fp.pos.z) : null;
    card.innerHTML = `<button class="c3x" aria-label="閉じる">×</button>
      <small>${KIND[L.kind] || ''}${p.ele ? ` · 標高 ${p.ele.toLocaleString()} m` : ''}${d != null ? ` · ${fmtDist(d)}` : ''}</small>
      <b>${escapeHTML(p.name)}</b>${p.local ? `<em>${escapeHTML(p.local)}</em>` : ''}
      ${p.desc ? `<p>${escapeHTML(p.desc)}</p>` : ''}
      <div class="c3a">${fp ? `<button class="chip on" data-c="nav">ここへ向かう</button><button class="chip" data-c="tp">ワープ</button>` : `<button class="chip on" data-c="walk">ここを歩く</button><button class="chip" data-c="fly">近づく</button>`}</div>`;
    card.classList.remove('hidden');
    card.querySelector('.c3x').onclick = closeCard;
    card.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => {
      const c = b.dataset.c;
      if (c === 'walk') { closeCard(); walkNear(L); }
      else if (c === 'fly') region.goTo(L);
      else if (c === 'nav') { region.fp.setNav({ x: L.x, z: L.z, name: p.name, auto: true }); showNav(); closeCard(); }
      else if (c === 'tp') { const [x, z] = standoff(L); region.fp.place(x, z, bearingXZ(L.x - x, L.z - z)); region.fp.setNav({ x: L.x, z: L.z, name: p.name, auto: false }); showNav(); closeCard(); }
    }));
    el.classList.add('has-card');
  }
  function closeCard() { card.classList.add('hidden'); cardL = null; el.classList.remove('has-card'); }
  /** a point ~250 m (walk) before the place, on land, facing it */
  function standoff(L) {
    const E = region.engine;
    for (const d of [260, 160, 420, 90, 700]) for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2, x = L.x + Math.cos(ang) * d, z = L.z + Math.sin(ang) * d;
      if (!region.F.inExtent(x, z, 80)) continue;
      const hgt = E.heightAt(x, z);
      if (region.hasSea && hgt < 1) continue;
      if (Math.abs(hgt - E.heightAt(L.x, L.z)) < 250) return [x, z];
    }
    return [L.x, L.z];
  }
  function walkNear(L) {
    const [x, z] = standoff(L);
    region.enterFirstPerson(x, z, bearingXZ(L.x - x, L.z - z));
    region.fp.setNav({ x: L.x, z: L.z, name: L.p.name, auto: false });
    showNav();
    toast(`${L.p.name} の近くに降り立ちました`, 3000);
  }

  // ---- first-person controls
  const joy = $('.joy'), knob = $('.knob');
  let joyId = null, jc = null;
  const joyR = () => joy.offsetWidth * 0.42;
  joy.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); joyId = e.pointerId; joy.setPointerCapture(e.pointerId);
    const rc = joy.getBoundingClientRect(); jc = { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
    moveJoy(e);
  });
  const moveJoy = (e) => {
    if (e.pointerId !== joyId) return;
    let dx = e.clientX - jc.x, dy = e.clientY - jc.y; const R = joyR(), l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const dz = 0.12, nx = dx / R, ny = dy / R, m = Math.hypot(nx, ny);
    const k = m < dz ? 0 : (m - dz) / (1 - dz) / m;
    region.fp.joy.x = nx * k; region.fp.joy.y = ny * k;
  };
  joy.addEventListener('pointermove', moveJoy);
  const endJoy = (e) => { if (e.pointerId !== joyId) return; joyId = null; knob.style.transform = ''; region.fp.joy.x = region.fp.joy.y = 0; };
  joy.addEventListener('pointerup', endJoy); joy.addEventListener('pointercancel', endJoy); joy.addEventListener('lostpointercapture', endJoy);

  $$('[data-m]').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.m;
    if (m === region.fp.mode) return;
    region.fp.setMode(m);
    syncFP();
    toast(m === 'fly' ? 'ドローンモード：▲▼で高度、スティックで移動' : '徒歩モード：地面に降ります', 2600);
  }));
  $('[data-act=speed]').addEventListener('click', () => { const S = region.fp.speeds(); region.fp.speedIdx = (region.fp.speedIdx + 1) % S.length; syncFP(); });
  $$('[data-lift]').forEach((b) => {
    const v = +b.dataset.lift;
    const on = (e) => { e.preventDefault(); e.stopPropagation(); b.setPointerCapture?.(e.pointerId); region.fp.lift = v; };
    const off = () => { if (region.fp) region.fp.lift = 0; };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('lostpointercapture', off);
  });
  $('[data-act=exitfp]').addEventListener('click', () => region.exitFirstPerson());
  $('[data-act=navx]').addEventListener('click', () => { region.fp.setNav(null); hideNav(); });
  $('[data-act=auto]').addEventListener('click', () => { const N = region.fp.nav; if (!N) return; N.auto = !N.auto; N.arrived = false; syncNav(); });
  const showNav = () => { $('.navbar').classList.remove('hidden'); syncNav(); };
  const hideNav = () => $('.navbar').classList.add('hidden');
  const syncNav = () => { const N = region.fp?.nav; if (!N) return hideNav(); $('.nv-name').textContent = N.name; $('.nv-auto').classList.toggle('on', !!N.auto); $('.nv-auto').textContent = N.auto ? '自動移動中' : '自動で進む'; };
  const syncFP = () => {
    const fp = region.fp; if (!fp) return;
    $$('[data-m]').forEach((x) => x.classList.toggle('on', x.dataset.m === fp.mode));
    el.classList.toggle('flying', fp.mode === 'fly');
    $('[data-act=speed]').textContent = `速さ: ${fp.speeds()[fp.speedIdx].label}`;
  };

  // ---- per-frame
  const needle = $('.needle'), roE = $('.ro-elev'), roL = $('.ro-ll'), roA = $('.ro-alt'), roLoad = $('.ro-load');
  const mmMe = $('.mm-me'), mmView = $('.mm-view'), mmDest = $('.mm-dest');
  let acc = 0;
  function update(dt) {
    if (!region.engine) return;
    const I = region.info();
    needle.setAttribute('transform', `rotate(${(-I.heading * 180) / Math.PI} 20 20)`);
    acc += dt;
    const fp = region.mode === 'fp';
    // minimap markers (every frame; cheap)
    const focus = fp ? region.fp.pos : region.map.target;
    const [u, v] = region.F.xzToUV(focus.x, focus.z);
    const mmS = mm.offsetWidth;
    const place = (e, uu, vv) => { e.style.transform = `translate(${(clamp(uu, 0, 1) * mmS).toFixed(1)}px, ${(clamp(vv, 0, 1) * mmS).toFixed(1)}px)`; };
    place(mmMe, u, v); mmMe.style.setProperty('--rot', `${(I.heading * 180) / Math.PI}deg`);
    if (!fp) {
      const span = clamp(region.map.dist * 1.1 / region.F.size, 0.02, 1);
      mmView.style.width = mmView.style.height = `${span * mmS}px`;
      place(mmView, u, v); mmView.style.display = '';
    } else mmView.style.display = 'none';
    const N = fp && region.fp.nav;
    if (N) { const [du, dv] = region.F.xzToUV(N.x, N.z); place(mmDest, du, dv); mmDest.style.display = ''; } else mmDest.style.display = 'none';
    if (N) {
      const dx = N.x - region.fp.pos.x, dz = N.z - region.fp.pos.z;
      const rel = angDiff(region.fp.heading, bearingXZ(dx, dz));
      $('.arrow').style.transform = `rotate(${(rel * 180) / Math.PI - 90}deg)`;
      if (acc > 0.2) $('.nv-dist').textContent = N.arrived ? '到着' : fmtDist(Math.hypot(dx, dz));
    }
    if (acc < 0.2) return;
    acc = 0;
    roE.textContent = `標高 ${I.elev.toLocaleString()} m`;
    roL.textContent = fmtLL(I.lat, I.lon);
    roA.textContent = fp
      ? (region.fp.mode === 'fly' ? `対地 ${fmtDist(I.alt)} · ${Math.round(region.fp.speedKmh())} km/h · ${dirName(I.heading)}` : `${Math.round(region.fp.speedKmh())} km/h · ${dirName(I.heading)}向き`)
      : `視点 ${fmtDist(I.alt)}`;
    roLoad.classList.toggle('on', I.loading > 0);
    if (cardL && fp) { const s = card.querySelector('small'); if (s) s.textContent = `${KIND[cardL.kind] || ''}${cardL.p.ele ? ` · 標高 ${cardL.p.ele.toLocaleString()} m` : ''} · ${fmtDist(Math.hypot(cardL.x - region.fp.pos.x, cardL.z - region.fp.pos.z))}`; }
    if (N) syncNav();
  }

  function onMode(m) {
    el.classList.toggle('fp', m === 'fp');
    closeCard();
    if (m === 'fp') { syncFP(); if (region.fp.nav) showNav(); else hideNav(); }
    else { hideNav(); knob.style.transform = ''; }
    void closePanel;
  }
  function onArrive() { syncNav(); }

  return { el, update, onMode, showCard, closeCard, cardOpen: () => !!cardL, onArrive, destroy: () => el.remove(), speeds };
}
