import * as THREE from 'three';
import { Globe } from './globe.js';
import { Terrain, QA } from './terrain.js';
import { ratingsHTML, climateSVG, RATING_DEFS } from './ui.js';

const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const ui = $('#ui');
const labels = $('#labels');
const MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

// ---------- renderer (no compromise: high DPR, shadows, ACES) ----------
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
renderer.setPixelRatio(QA ? 1 : Math.min(window.devicePixelRatio || 1, 3));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor('#dcecf4');

const globe = new Globe(renderer, labels);
const terrain = new Terrain(renderer, labels);
let mode = 'globe';
let regions = [];
let current = null;

function resize() {
  const w = window.innerWidth, hh = window.innerHeight;
  renderer.setSize(w, hh, false);
  globe.resize(w, hh); terrain.resize(w, hh);
}
window.addEventListener('resize', resize);
resize();

// ---------- loader ----------
const loader = h(`<div id="loader"><div class="brand">BARIMO</div><div class="bar"><i></i></div><p>LOADING THE WORLD</p></div>`);
document.body.appendChild(loader);
const setLoad = (p, txt) => { $('.bar i', loader).style.width = `${Math.round(p * 100)}%`; if (txt) $('p', loader).textContent = txt; };
const hideLoader = () => { loader.style.opacity = 0; setTimeout(() => loader.classList.add('hidden'), 900); };
const showLoader = (txt) => { loader.classList.remove('hidden'); loader.style.opacity = 1; setLoad(0, txt); };

// ---------- boot ----------
(async () => {
  setLoad(0.2);
  regions = await (await fetch('/data/regions.json')).json();
  setLoad(0.5);
  globe.setRegions(regions);
  globe.show(true);
  await new Promise((r) => { const iv = setInterval(() => { if (globe.ready) { clearInterval(iv); r(); } }, 50); });
  setLoad(1);
  // precompile to avoid first-frame jank
  renderer.compile(globe.scene, globe.camera);
  setTimeout(hideLoader, 300);
  showIntro();
})();

// ---------- fullscreen + landscape lock ----------
async function goFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await screen.orientation?.lock?.('landscape');
  } catch { /* desktop / unsupported */ }
}

// ---------- INTRO ----------
function showIntro() {
  const el = h(`<section id="intro" class="fade-in">
    <div class="kicker">HIDDEN PLACES OF THE WORLD</div>
    <h1>BARIMO<small>1.0</small></h1>
    <p class="lead">まだ誰も知らない、<br/>息をのむほど美しい場所へ。</p>
    <p class="sub">観光客のいない世界の秘境 ${regions.length} か所を、衛星データと実測標高から再現した3Dで旅する。</p>
    <button class="start">はじめる</button>
  </section>`);
  ui.appendChild(el);
  $('.start', el).addEventListener('click', () => {
    goFullscreen();
    el.classList.add('out');
    setTimeout(() => el.remove(), 1000);
    showGlobeUI();
  });
}

// ---------- GLOBE UI ----------
let globeUI;
function showGlobeUI() {
  globeUI?.remove();
  globeUI = h(`<div class="globe-ui">
    <div class="topbar fade-in">
      <div class="logo">BARIMO<small>1.0</small></div>
      <div class="spacer"></div>
      <button class="chip" data-sort="gem">秘境度順</button>
      <button class="chip" data-sort="ease">行きやすさ順</button>
      <button class="icon-btn" data-act="fs" aria-label="全画面"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
    </div>
    <div class="strip fade-in"></div>
  </div>`);
  ui.appendChild(globeUI);
  renderStrip(regions);
  globeUI.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    globeUI.querySelectorAll('[data-sort]').forEach((x) => x.classList.remove('on'));
    b.classList.toggle('on', on);
    const k = b.dataset.sort;
    renderStrip(on ? [...regions].sort((a, c) => c[k] - a[k]) : regions);
  }));
  $('[data-act=fs]', globeUI).addEventListener('click', goFullscreen);
}

function renderStrip(list) {
  const strip = $('.strip', globeUI);
  strip.innerHTML = '';
  for (const r of list) {
    const c = h(`<button class="card" data-id="${r.id}">
      <img loading="lazy" src="/regions/${r.id}/${r.photos[0]?.thumb || 'sat_1k.jpg'}" alt="">
      <span class="gem">秘境度 ${r.gem}</span>
      <div class="meta"><div class="nm">${r.flag} ${r.name}</div><div class="ct">${r.country}</div></div>
    </button>`);
    c.addEventListener('click', () => { if (current === r && $('.preview')) openRegion(r); else globe.select(r); });
    strip.appendChild(c);
  }
}

globe.onSelect = (r) => {
  current = r;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('active', c.dataset.id === r.id));
  document.querySelector(`.card[data-id="${r.id}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  $('.preview')?.remove();
  $('.strip', globeUI)?.classList.add('away');
  const p = h(`<div class="preview glass fade-in" style="--accent:${r.accent}">
    <div class="pv-nav"><button data-nav="-1" aria-label="前へ">‹</button><span>${regions.indexOf(r) + 1} / ${regions.length}</span><button data-nav="1" aria-label="次へ">›</button><button data-nav="x" aria-label="閉じる">×</button></div>
    <div class="country">${r.flag} ${r.country}</div>
    <h2>${r.name}</h2>
    <div class="local">${r.nameLocal}</div>
    <div class="tag">${r.tagline}</div>
    <div class="mini-scores">
      <div><b>${r.gem}</b><span>秘境度</span></div>
      <div><b>${r.ease}</b><span>行きやすさ</span></div>
      <div><b>${(r.terrain.maxElev / 1000).toFixed(1)}<small style="font-size:.5em">km</small></b><span>最高標高</span></div>
    </div>
    <button class="go">3Dで旅する <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
  </div>`);
  $('.go', p).addEventListener('click', () => openRegion(r));
  p.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.nav;
    if (k === 'x') { p.remove(); globe.deselect(); $('.strip', globeUI)?.classList.remove('away'); return; }
    globe.select(regions[(regions.indexOf(r) + +k + regions.length) % regions.length]);
  }));
  globeUI.appendChild(p);
};
globe.onOpen = (r) => openRegion(r);

// ---------- REGION ----------
let regionUI;
async function openRegion(r) {
  current = r;
  showLoader(`${r.name} へ移動中…`);
  await new Promise((res) => setTimeout(res, 350));
  globe.show(false);
  globeUI?.classList.add('hidden');
  await terrain.load(r, (p) => setLoad(p));
  renderer.compile(terrain.scene, terrain.camera);
  mode = 'region';
  terrain.show(true);
  hideLoader();
  buildRegionUI(r);
}

function buildRegionUI(r) {
  regionUI?.remove();
  document.documentElement.style.setProperty('--accent', r.accent);
  const bm = new Set(r.bestMonths);
  regionUI = h(`<div class="region-ui" style="--accent:${r.accent}">
    <div class="hero"><div class="country">${r.flag} ${r.country}</div><h1>${r.name}</h1><div class="local">${r.nameLocal}</div><div class="tag">${r.tagline}</div></div>
    <div class="topbar">
      <button class="icon-btn" data-act="back" aria-label="戻る"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="logo" style="font-size:clamp(14px,4.6dvh,22px)">${r.name}</div>
      <div class="spacer"></div>
      <button class="chip" data-t="morning">朝</button><button class="chip on" data-t="noon">昼</button><button class="chip" data-t="golden">夕</button>
      <button class="chip" data-act="cine">🎥 空撮</button>
      <button class="chip on" data-act="panel">ガイド</button>
    </div>
    <div class="panel glass closed">
      <div class="tabs"><button class="on" data-tab="ov">概要</button><button data-tab="rt">評価</button><button data-tab="gl">写真</button><button data-tab="tr">旅の情報</button></div>
      <div class="pbody"></div>
    </div>
    <div class="compass"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="none" stroke="rgba(38,52,60,.15)"/><g class="needle"><path d="M20 5l4 15h-8z" fill="${r.accent}"/><path d="M20 35l4-15h-8z" fill="rgba(38,52,60,.25)"/><text x="20" y="4" font-size="6" text-anchor="middle" fill="#26343c" font-weight="700">N</text></g></svg></div>
    <div class="elev glass">標高 <b>${r.terrain.minElev.toLocaleString()}–${r.terrain.maxElev.toLocaleString()}</b> m · 幅 ${(r.terrain.widthM / 1000).toFixed(1)} km</div>
  </div>`);
  ui.appendChild(regionUI);

  const body = $('.pbody', regionUI);
  const tabs = {
    ov: () => `
      <h3>概要</h3><p class="overview-lead">${r.overview}</p>
      <div class="facts">
        <div><b>${r.gem}</b><span>秘境度</span></div>
        <div><b>${r.ease}</b><span>行きやすさ</span></div>
        <div><b>${r.climate?.elevation?.toLocaleString() ?? '-'}m</b><span>中心標高</span></div>
      </div>
      <h3>ここがすごい</h3>
      <ul class="hl">${r.highlights.map((x, i) => `<li><i>${i + 1}</i>${x}</li>`).join('')}</ul>
      <h3>ベストシーズン</h3>
      <div class="months">${MONTHS.map((m, i) => `<span class="${bm.has(i + 1) ? 'on' : ''}">${m}</span>`).join('')}</div>
      ${r.climate ? `<h3>気候（2021–24 実測平均）</h3><div class="climate">${climateSVG(r.climate.months, r.accent, bm)}</div>` : ''}`,
    rt: () => ratingsHTML(r),
    gl: () => `
      <h3>写真 <span style="font-weight:400;font-size:.75em;color:var(--ink-3)">${r.photos.length}枚</span></h3>
      <div class="gal">${r.photos.map((p, i) => `<button data-i="${i}"><img loading="lazy" src="/regions/${r.id}/${p.thumb}" alt=""></button>`).join('')}</div>
      <p class="credit-note">写真: Wikimedia Commons（各撮影者・CCライセンス）。タップで拡大・クレジット表示。</p>`,
    tr: () => `
      <h3>旅の情報</h3>
      <div class="info-row"><b>アクセス</b><span>${r.access}</span></div>
      <div class="info-row"><b>滞在</b><span>${r.stay}</span></div>
      <div class="info-row"><b>ヒント</b><span>${r.tips}</span></div>
      <h3>見どころマップ</h3>
      <ul class="hl">${r.pois.map((p, i) => `<li data-poi="${i}" style="cursor:pointer"><i>${i + 1}</i><span><b style="color:var(--ink)">${p.name}</b><br>${p.desc}</span></li>`).join('')}</ul>
      <p class="credit-note">3D地形: AWS Terrain Tiles (Mapzen) · 衛星画像: Esri World Imagery · 気候: Open-Meteo (ERA5)</p>`,
  };
  const setTab = (k) => {
    regionUI.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    body.innerHTML = tabs[k](); body.scrollTop = 0;
    body.querySelectorAll('.gal button').forEach((b) => b.addEventListener('click', () => openViewer(r, +b.dataset.i)));
    body.querySelectorAll('[data-poi]').forEach((b) => b.addEventListener('click', () => terrain.flyTo(+b.dataset.poi)));
  };
  regionUI.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  setTab('ov');

  const panel = $('.panel', regionUI), hero = $('.hero', regionUI), pBtn = $('[data-act=panel]', regionUI);
  setTimeout(() => { hero.style.opacity = 0; panel.classList.remove('closed'); }, 3800);
  pBtn.addEventListener('click', () => { const c = panel.classList.toggle('closed'); pBtn.classList.toggle('on', !c); });
  regionUI.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
    regionUI.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b)); terrain.setTime(b.dataset.t);
  }));
  $('[data-act=cine]', regionUI).addEventListener('click', () => { panel.classList.add('closed'); pBtn.classList.remove('on'); terrain.cinematic(); });
  $('[data-act=back]', regionUI).addEventListener('click', backToGlobe);
  regionUI.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x.dataset.t === (terrain.time || 'noon')));
}

function backToGlobe() {
  regionUI?.remove(); regionUI = null;
  terrain.show(false); terrain.dispose();
  mode = 'globe';
  globe.show(true);
  globeUI?.classList.remove('hidden');
  renderer.toneMappingExposure = 1.0;
}

// ---------- photo viewer ----------
function openViewer(r, i) {
  const v = h(`<div id="viewer" class="fade-in"><div class="frame"></div>
    <div class="count"></div><div class="cap"></div>
    <button class="icon-btn nav prev"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <button class="icon-btn nav next"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="icon-btn close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`);
  const show = (k) => {
    i = (k + r.photos.length) % r.photos.length; const p = r.photos[i];
    $('.frame', v).innerHTML = `<img src="/regions/${r.id}/${p.file}" alt="">`;
    $('.count', v).textContent = `${i + 1} / ${r.photos.length}`;
    $('.cap', v).innerHTML = `<b>${r.name}</b>${escapeHTML(p.title)}<br>📷 ${escapeHTML(p.author)} · ${escapeHTML(p.license)} · Wikimedia Commons`;
  };
  $('.prev', v).onclick = () => show(i - 1); $('.next', v).onclick = () => show(i + 1); $('.close', v).onclick = () => v.remove();
  let sx = null;
  v.addEventListener('pointerdown', (e) => (sx = e.clientX));
  v.addEventListener('pointerup', (e) => { if (sx !== null && Math.abs(e.clientX - sx) > 50) show(i + (e.clientX < sx ? 1 : -1)); sx = null; });
  document.body.appendChild(v); show(i);
}
const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- loop ----------
const clock = new THREE.Clock();
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  if (mode === 'globe') { globe.update(dt, t); globe.render(); }
  else {
    terrain.update(dt, t); terrain.render();
    const n = regionUI && $('.needle', regionUI); if (n) n.setAttribute('transform', `rotate(${(-terrain.compassAngle * 180) / Math.PI + 180} 20 20)`);
  }
  requestAnimationFrame(loop);
}
loop();
void RATING_DEFS;
