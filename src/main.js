import * as THREE from 'three';
import { Globe } from './globe.js';
import { RegionScene, QA, TIMES } from './terrain.js';
import { ratingsHTML, climateSVG } from './ui.js';
import { WALK_SPEEDS, FLY_SPEEDS } from './controls.js';
import { escapeHTML, fmtDist, fmtLL, dirName, bearingXZ, clamp } from './geo.js';
import { createHUD } from './hud.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const ui = $('#ui'), labels = $('#labels');

// ---------- renderer ----------
const canvas = $('#gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false, logarithmicDepthBuffer: false });
} catch (e) {
  fatal('この端末ではWebGLが使えないため、3D表示ができません。', e); throw e;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor('#dcecf4');
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('描画がリセットされました。再読み込みします…', 4000); setTimeout(() => location.reload(), 1800); });

// ---------- adaptive quality ----------
const QUALITY = {
  high: { label: '高画質', dpr: 2, K: 2.3, maxLeaves: 420, buildMs: 6, shadow: 2048 },
  std: { label: '標準', dpr: 1.5, K: 1.9, maxLeaves: 320, buildMs: 5, shadow: 2048 },
  eco: { label: '省電力', dpr: 1, K: 1.5, maxLeaves: 220, buildMs: 4, shadow: 1024 },
};
let qKey = localStorage.getItem('barimo.quality') || (Math.min(screen.width, screen.height) * (devicePixelRatio || 1) > 900 ? 'high' : 'std');
if (!QUALITY[qKey]) qKey = 'std';
let dprScale = 1;
const applyDPR = () => renderer.setPixelRatio(QA ? 1 : Math.min(devicePixelRatio || 1, QUALITY[qKey].dpr) * dprScale);
applyDPR();

const globe = new Globe(renderer, labels);
const region = new RegionScene(renderer, labels);
region.quality = QUALITY[qKey];
let mode = 'globe', regions = [], current = null, loadingRegion = null, loadCtl = null;

function resize() {
  const w = innerWidth, hh = innerHeight;
  renderer.setSize(w, hh, false);
  globe.resize(w, hh); region.resize(w, hh);
}
addEventListener('resize', resize);
screen.orientation?.addEventListener?.('change', () => setTimeout(resize, 150));
resize();

// ---------- toast ----------
let toastEl, toastT;
function toast(msg, ms = 2600) {
  if (!msg) return;
  if (!toastEl) { toastEl = h('<div class="toast" role="status" aria-live="polite"></div>'); document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), ms);
}
region.onToast = (m) => toast(m);

// ---------- loader ----------
const loader = h(`<div id="loader"><div class="brand">BARIMO</div><div class="bar"><i></i></div><p>LOADING THE WORLD</p><button class="ld-cancel hidden">キャンセル</button></div>`);
document.body.appendChild(loader);
const setLoad = (p, txt) => { $('.bar i', loader).style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`; if (txt) $('p', loader).textContent = txt; };
const hideLoader = () => { loader.style.opacity = 0; loader.style.pointerEvents = 'none'; setTimeout(() => { if (loader.style.opacity === '0') loader.classList.add('hidden'); }, 900); };
const showLoader = (txt, cancellable = false) => { loader.classList.remove('hidden'); loader.style.pointerEvents = ''; loader.style.opacity = 1; setLoad(0, txt); $('.ld-cancel', loader).classList.toggle('hidden', !cancellable); };
$('.ld-cancel', loader).addEventListener('click', () => loadCtl?.abort());

function fatal(msg, err) {
  console.error(err);
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = `<div class="brand">BARIMO</div><p>${msg}</p><button onclick="location.reload()">再読み込み</button>`;
  document.body.appendChild(el);
}

// ---------- boot ----------
(async () => {
  try {
    setLoad(0.15);
    const r = await fetch('/data/regions.json');
    if (!r.ok) throw new Error('regions.json HTTP ' + r.status);
    regions = await r.json();
    setLoad(0.5);
    globe.setRegions(regions);
    globe.show(true);
    const t0 = performance.now();
    await new Promise((res, rej) => { const iv = setInterval(() => { if (globe.ready) { clearInterval(iv); res(); } else if (performance.now() - t0 > 30000) { clearInterval(iv); rej(new Error('globe texture timeout')); } }, 50); });
    setLoad(1);
    renderer.compile(globe.scene, globe.camera);
    setTimeout(hideLoader, 300);
    const deep = new URLSearchParams(location.search).get('r');
    const target = deep && regions.find((x) => x.id === deep);
    if (target) { showGlobeUI(); globe.select(target); }
    else showIntro();
  } catch (e) {
    fatal('データの読み込みに失敗しました。通信環境を確認して再読み込みしてください。', e);
  }
})();

// ---------- fullscreen + landscape lock ----------
async function goFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    await screen.orientation?.lock?.('landscape');
  } catch { /* desktop / unsupported (iOS) */ }
}
const syncFS = () => $$('[data-act=fs]').forEach((b) => b.classList.toggle('on', !!document.fullscreenElement));
document.addEventListener('fullscreenchange', syncFS);
const toggleFS = () => (document.fullscreenElement ? document.exitFullscreen?.() : goFullscreen());

// ---------- INTRO ----------
function showIntro() {
  const el = h(`<section id="intro" class="fade-in">
    <div class="kicker">HIDDEN PLACES OF THE WORLD</div>
    <h1>BARIMO<small>1.1</small></h1>
    <p class="lead">まだ誰も知らない、<br/>息をのむほど美しい場所へ。</p>
    <p class="sub">観光客のいない世界の秘境 ${regions.length} か所を、実測標高と衛星写真の3Dで。上空から眺めて、地上に降りて歩いて旅する。</p>
    <button class="start">はじめる</button>
  </section>`);
  ui.appendChild(el);
  $('.start', el).addEventListener('click', () => {
    goFullscreen();
    el.classList.add('out');
    setTimeout(() => el.remove(), 1000);
    showGlobeUI();
  }, { once: true });
}

// ---------- GLOBE UI ----------
let globeUI, sortKey = null;
const ICON = {
  fs: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7M6 10v10h12V10"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v4M9 12l2-4 3 2 3 1M11 8l-2 4-3 1"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/></svg>',
};
function showGlobeUI() {
  globeUI?.remove();
  document.documentElement.style.removeProperty('--accent');
  globeUI = h(`<div class="globe-ui">
    <div class="topbar fade-in">
      <div class="logo">BARIMO<small>1.1</small></div>
      <div class="spacer"></div>
      <button class="chip" data-sort="gem" aria-pressed="false">秘境度順</button>
      <button class="chip" data-sort="ease" aria-pressed="false">行きやすさ順</button>
      <button class="icon-btn" data-act="fs" aria-label="全画面">${ICON.fs}</button>
    </div>
    <div class="zoom-ctrl fade-in"><button class="icon-btn" data-z="in" aria-label="ズームイン">${ICON.plus}</button><button class="icon-btn" data-z="out" aria-label="ズームアウト">${ICON.minus}</button></div>
    <div class="alt-read glass fade-in"></div>
    <div class="strip fade-in" role="list"></div>
  </div>`);
  ui.appendChild(globeUI);
  renderStrip();
  $$('[data-sort]', globeUI).forEach((b) => b.addEventListener('click', () => {
    sortKey = sortKey === b.dataset.sort ? null : b.dataset.sort;
    $$('[data-sort]', globeUI).forEach((x) => { x.classList.toggle('on', x.dataset.sort === sortKey); x.setAttribute('aria-pressed', x.dataset.sort === sortKey); });
    renderStrip();
    $('.strip', globeUI).scrollTo({ left: 0, behavior: 'smooth' });
  }));
  $('[data-act=fs]', globeUI).addEventListener('click', toggleFS);
  $('[data-z=in]', globeUI).addEventListener('click', () => globe.zoomBy(0.4));
  $('[data-z=out]', globeUI).addEventListener('click', () => globe.zoomBy(2.4));
  syncFS();
}

function renderStrip() {
  const strip = $('.strip', globeUI); if (!strip) return;
  const list = sortKey ? [...regions].sort((a, c) => c[sortKey] - a[sortKey] || a.name.localeCompare(c.name, 'ja')) : regions;
  strip.innerHTML = '';
  for (const r of list) {
    const c = h(`<button class="card${current === r ? ' active' : ''}" data-id="${r.id}" role="listitem" style="--accent:${r.accent}">
      <img loading="lazy" decoding="async" src="/regions/${r.id}/${r.photos[0]?.thumb || 'overview_s.jpg'}" alt="">
      <span class="gem">${sortKey === 'ease' ? `行きやすさ ${r.ease}` : `秘境度 ${r.gem}`}</span>
      <span class="meta"><span class="nm">${r.flag} ${escapeHTML(r.name)}</span><span class="ct">${escapeHTML(r.country)}</span></span>
    </button>`);
    c.addEventListener('click', () => { if (current === r && $('.preview')) openRegion(r); else globe.select(r); });
    strip.appendChild(c);
  }
}

globe.onBackgroundTap = () => { if ($('.preview')) closePreview(); };
function closePreview() {
  $('.preview')?.remove(); globe.deselect(); current = null;
  $$('.card').forEach((c) => c.classList.remove('active'));
  $('.strip', globeUI)?.classList.remove('away');
}
globe.onSelect = (r) => {
  current = r;
  $$('.card').forEach((c) => c.classList.toggle('active', c.dataset.id === r.id));
  $(`.card[data-id="${r.id}"]`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  $('.preview')?.remove();
  $('.strip', globeUI)?.classList.add('away');
  const idx = regions.indexOf(r);
  const p = h(`<div class="preview glass fade-in" style="--accent:${r.accent}" role="dialog" aria-label="${escapeHTML(r.name)}">
    <div class="pv-nav"><span>${idx + 1} / ${regions.length}</span><button data-nav="-1" aria-label="前へ">‹</button><button data-nav="1" aria-label="次へ">›</button><button data-nav="x" aria-label="閉じる">×</button></div>
    <div class="country">${r.flag} ${escapeHTML(r.country)}</div>
    <h2>${escapeHTML(r.name)}</h2>
    <div class="local">${escapeHTML(r.nameLocal)}</div>
    <div class="tag">${escapeHTML(r.tagline)}</div>
    <div class="mini-scores">
      <div><b>${r.gem}</b><span>秘境度</span></div>
      <div><b>${r.ease}</b><span>行きやすさ</span></div>
      <div><b>${(r.terrain.widthM / 1000).toFixed(0)}<small>km</small></b><span>探索エリア幅</span></div>
    </div>
    <button class="go">3Dで旅する <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
  </div>`);
  $('.go', p).addEventListener('click', () => openRegion(r));
  $$('[data-nav]', p).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = b.dataset.nav;
    if (k === 'x') return closePreview();
    globe.select(regions[(idx + +k + regions.length) % regions.length]);
  }));
  globeUI.appendChild(p);
};
globe.onOpen = (r) => openRegion(r);
globe.onZoom = () => {};

// ---------- REGION ----------
let regionUI, hud;
async function openRegion(r) {
  if (loadingRegion) return; // ignore double taps while loading
  loadingRegion = r; current = r;
  loadCtl = new AbortController();
  showLoader(`${r.name} へ移動中…`, true);
  try {
    await new Promise((res) => setTimeout(res, 250));
    globe.show(false);
    globeUI?.classList.add('hidden');
    await region.load(r, (p) => setLoad(p), loadCtl.signal);
    renderer.compile(region.scene, region.camera);
    mode = 'region';
    region.show(true);
    hideLoader();
    buildRegionUI(r);
    history.replaceState(null, '', `?r=${r.id}${QA ? '&qa=1' : ''}`);
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    if (!aborted) console.error(e);
    region.unload(); region.show(false);
    mode = 'globe'; globe.show(true); globeUI?.classList.remove('hidden');
    hideLoader();
    if (!aborted) toast('地域データの読み込みに失敗しました。通信環境を確認してください。', 4000);
  } finally {
    loadingRegion = null; loadCtl = null;
  }
}

function buildRegionUI(r) {
  regionUI?.remove(); hud?.destroy();
  document.documentElement.style.setProperty('--accent', r.accent);
  const bm = new Set(r.bestMonths);
  regionUI = h(`<div class="region-ui" style="--accent:${r.accent}">
    <div class="hero"><div class="country">${r.flag} ${escapeHTML(r.country)}</div><h1>${escapeHTML(r.name)}</h1><div class="local">${escapeHTML(r.nameLocal)}</div><div class="tag">${escapeHTML(r.tagline)}</div></div>
    <div class="topbar">
      <button class="icon-btn" data-act="back" aria-label="地球儀に戻る">${ICON.back}</button>
      <div class="logo rlogo">${escapeHTML(r.name)}</div>
      <div class="spacer"></div>
      <div class="seg map-only" role="group" aria-label="時間帯">${Object.entries(TIMES).map(([k, T]) => `<button class="chip" data-t="${k}">${T.label}</button>`).join('')}</div>
      <button class="chip map-only" data-act="cine">🎥 空撮</button>
      <button class="chip map-only on" data-act="panel" aria-pressed="true">ガイド</button>
      <button class="icon-btn" data-act="settings" aria-label="設定">${ICON.gear}</button>
    </div>
    <div class="panel glass closed">
      <div class="tabs" role="tablist"><button class="on" data-tab="ov" role="tab">概要</button><button data-tab="pl" role="tab">行き先</button><button data-tab="rt" role="tab">評価</button><button data-tab="gl" role="tab">写真</button><button data-tab="tr" role="tab">旅の情報</button></div>
      <div class="pbody"></div>
    </div>
  </div>`);
  ui.appendChild(regionUI);

  const body = $('.pbody', regionUI);
  const kindLabel = { poi: '見どころ', peak: '山', village: '村', town: '町', lake: '湖', waterfall: '滝', pass: '峠' };
  const tabs = {
    ov: () => `
      <h3>概要</h3><p class="overview-lead">${escapeHTML(r.overview)}</p>
      <div class="facts">
        <div><b>${r.gem}</b><span>秘境度</span></div>
        <div><b>${r.ease}</b><span>行きやすさ</span></div>
        <div><b>${r.climate?.elevation != null ? r.climate.elevation.toLocaleString() + 'm' : '—'}</b><span>中心標高</span></div>
      </div>
      <h3>ここがすごい</h3>
      <ul class="hl">${r.highlights.map((x, i) => `<li><i>${i + 1}</i>${escapeHTML(x)}</li>`).join('')}</ul>
      <h3>ベストシーズン</h3>
      <div class="months">${Array.from({ length: 12 }, (_, i) => `<span class="${bm.has(i + 1) ? 'on' : ''}">${i + 1}</span>`).join('')}</div>
      ${r.climate ? `<h3>気候（2021–24 実測平均）</h3><div class="climate">${climateSVG(r.climate.months, r.accent, bm)}</div>` : ''}`,
    pl: () => `
      <h3>見どころ <span class="cnt">${r.pois.length}</span></h3>
      <ul class="hl places">${r.pois.map((p, i) => `<li><button data-go="poi:${i}"><i>${i + 1}</i><span><b>${escapeHTML(p.name)}</b><br>${escapeHTML(p.desc)}</span></button></li>`).join('')}</ul>
      <h3>地図上の地名 <span class="cnt">${r.places.length}</span></h3>
      <div class="plist">${r.places.map((p, i) => `<button data-go="pl:${i}"><i class="k k-${p.kind}"></i><b>${escapeHTML(p.name)}</b><em>${kindLabel[p.kind] || ''}${p.ele ? ' · ' + p.ele.toLocaleString() + 'm' : ''}</em></button>`).join('')}</div>
      <p class="credit-note">タップで上空から移動。地上モード中はそこへ向かって案内します。地名: © OpenStreetMap contributors</p>`,
    rt: () => ratingsHTML(r),
    gl: () => `
      <h3>写真 <span class="cnt">${r.photos.length}枚</span></h3>
      <div class="gal">${r.photos.map((p, i) => `<button data-i="${i}" aria-label="写真 ${i + 1}"><img loading="lazy" decoding="async" src="/regions/${r.id}/${p.thumb}" alt=""></button>`).join('')}</div>
      <p class="credit-note">写真: Wikimedia Commons（各撮影者・CCライセンス）。タップで拡大・クレジット表示。</p>`,
    tr: () => `
      <h3>旅の情報</h3>
      <div class="info-row"><b>アクセス</b><span>${escapeHTML(r.access)}</span></div>
      <div class="info-row"><b>滞在</b><span>${escapeHTML(r.stay)}</span></div>
      <div class="info-row"><b>ヒント</b><span>${escapeHTML(r.tips)}</span></div>
      <h3>3Dマップについて</h3>
      <p>探索エリアは約 ${(r.terrain.widthM / 1000).toFixed(0)} km 四方。ズームすると衛星写真と標高データが自動で高精細になります。「地上を歩く」で一人称視点に切り替わります。</p>
      <p class="credit-note">3D地形: AWS Terrain Tiles (Mapzen / SRTM ほか) · 衛星画像: Esri, Maxar, Earthstar Geographics · 地名: © OpenStreetMap contributors · 気候: Open-Meteo (ERA5)</p>`,
  };
  const setTab = (k) => {
    $$('[data-tab]', regionUI).forEach((b) => { b.classList.toggle('on', b.dataset.tab === k); b.setAttribute('aria-selected', b.dataset.tab === k); });
    body.innerHTML = tabs[k](); body.scrollTop = 0;
    $$('.gal button', body).forEach((b) => b.addEventListener('click', () => openViewer(r, +b.dataset.i)));
    $$('[data-go]', body).forEach((b) => b.addEventListener('click', () => {
      const [t, i] = b.dataset.go.split(':');
      const L = region.labels.find((l) => (t === 'poi' ? l.kind === 'poi' && l.i === +i : l.kind !== 'poi' && l.p === r.places[+i]));
      if (!L) return;
      if (matchMedia('(max-height: 520px)').matches) closePanel();
      selectLabel(L);
    }));
  };
  $$('[data-tab]', regionUI).forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  setTab('ov');

  const panel = $('.panel', regionUI), hero = $('.hero', regionUI), pBtn = $('[data-act=panel]', regionUI);
  const openPanel = () => { panel.classList.remove('closed'); pBtn.classList.add('on'); pBtn.setAttribute('aria-pressed', 'true'); hero.style.opacity = 0; };
  const closePanel = () => { panel.classList.add('closed'); pBtn.classList.remove('on'); pBtn.setAttribute('aria-pressed', 'false'); };
  regionUI._closePanel = closePanel;
  const heroT = setTimeout(() => { hero.style.opacity = 0; if (region.mode === 'map') openPanel(); }, 3600);
  regionUI._timers = [heroT];
  pBtn.addEventListener('click', () => (panel.classList.contains('closed') ? openPanel() : closePanel()));
  $$('[data-t]', regionUI).forEach((b) => b.addEventListener('click', () => { region.setTime(b.dataset.t); syncTime(); }));
  const syncTime = () => $$('[data-t]', regionUI).forEach((x) => x.classList.toggle('on', x.dataset.t === region.time));
  syncTime();
  const cineBtn = $('[data-act=cine]', regionUI);
  cineBtn.addEventListener('click', () => {
    if (region.autoOrbit) { region.stopCinematic(); cineBtn.classList.remove('on'); return; }
    closePanel(); region.cinematic(); cineBtn.classList.add('on');
  });
  region.onCineStop = () => cineBtn.classList.remove('on');
  $('[data-act=back]', regionUI).addEventListener('click', () => (region.mode === 'fp' ? region.exitFirstPerson() : backToGlobe()));
  $('[data-act=settings]', regionUI).addEventListener('click', openSettings);

  hud = createHUD({ region, r, icons: ICON, toast, closePanel, openPanel, speeds: { WALK_SPEEDS, FLY_SPEEDS } });
  regionUI.appendChild(hud.el);
  region.onModeChange = (m) => {
    regionUI.classList.toggle('fp', m === 'fp');
    if (m === 'fp') { closePanel(); hero.style.opacity = 0; }
    hud.onMode(m);
  };
  region.onSelectLabel = (L) => selectLabel(L);
  region.onArrive = (n) => { toast(`${n.name} に到着しました`, 3200); hud.onArrive(n); };
  region.onTapMap = () => hud.closeCard();
}

function selectLabel(L) {
  hud?.showCard(L);
  region.goTo(L);
}

function backToGlobe() {
  closeViewer();
  regionUI?._timers?.forEach(clearTimeout);
  regionUI?.remove(); regionUI = null; hud?.destroy(); hud = null;
  region.show(false); region.unload();
  mode = 'globe';
  globe.show(true);
  globeUI?.classList.remove('hidden');
  renderer.toneMappingExposure = 1.0;
  document.documentElement.style.removeProperty('--accent');
  history.replaceState(null, '', QA ? '?qa=1' : location.pathname);
  if (current) globe.select(current, false);
}

// ---------- settings ----------
function openSettings() {
  if ($('#settings')) return;
  const s = h(`<div id="settings" class="sheet-wrap fade-in"><div class="sheet glass" role="dialog" aria-label="設定">
    <h3>設定</h3>
    <div class="row"><span>画質</span><div class="seg">${Object.entries(QUALITY).map(([k, q]) => `<button class="chip ${k === qKey ? 'on' : ''}" data-q="${k}">${q.label}</button>`).join('')}</div></div>
    <div class="row"><span>地名ラベル</span><div class="seg"><button class="chip ${region.labelsOn !== false ? 'on' : ''}" data-l="1">表示</button><button class="chip ${region.labelsOn === false ? 'on' : ''}" data-l="0">非表示</button></div></div>
    <div class="row"><span>全画面</span><div class="seg"><button class="chip" data-act="fs2">${document.fullscreenElement ? '解除' : '全画面にする'}</button></div></div>
    <p class="credit-note">操作: ドラッグで移動 · 2本指でズーム/回転 · 2本指を上下で傾き · ダブルタップで拡大。PCは右ドラッグで回転、WASD/矢印で移動。地上モードは左スティックで移動・画面ドラッグで視点。</p>
    <button class="chip close">閉じる</button></div></div>`);
  document.body.appendChild(s);
  const close = () => s.remove();
  s.addEventListener('click', (e) => { if (e.target === s) close(); });
  $('.close', s).addEventListener('click', close);
  $$('[data-q]', s).forEach((b) => b.addEventListener('click', () => {
    qKey = b.dataset.q; localStorage.setItem('barimo.quality', qKey); dprScale = 1; applyDPR(); resize();
    region.quality = QUALITY[qKey]; region.engine?.setQuality(QUALITY[qKey]);
    $$('[data-q]', s).forEach((x) => x.classList.toggle('on', x === b));
  }));
  $$('[data-l]', s).forEach((b) => b.addEventListener('click', () => { region.setLabelsVisible(b.dataset.l === '1'); $$('[data-l]', s).forEach((x) => x.classList.toggle('on', x === b)); }));
  $('[data-act=fs2]', s).addEventListener('click', () => { toggleFS(); close(); });
}

// ---------- photo viewer ----------
let viewer = null;
function closeViewer() { if (!viewer) return; viewer.remove(); removeEventListener('keydown', viewer._key); viewer = null; }
function openViewer(r, i) {
  closeViewer();
  const v = h(`<div id="viewer" class="fade-in" role="dialog" aria-label="写真"><div class="frame"></div>
    <div class="count"></div><div class="cap"></div>
    <button class="icon-btn nav prev" aria-label="前の写真"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <button class="icon-btn nav next" aria-label="次の写真"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="icon-btn close" aria-label="閉じる"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`);
  const n = r.photos.length;
  const show = (k) => {
    i = ((k % n) + n) % n; const p = r.photos[i];
    $('.frame', v).innerHTML = `<img src="/regions/${r.id}/${p.file}" alt="${escapeHTML(p.title)}">`;
    $('.count', v).textContent = `${i + 1} / ${n}`;
    $('.cap', v).innerHTML = `<b>${escapeHTML(r.name)}</b>${escapeHTML(p.title)}<br>📷 ${escapeHTML(p.author)} · ${escapeHTML(p.license)} · <a href="${escapeHTML(p.source)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
    [i + 1, i - 1].forEach((j) => { const q = r.photos[((j % n) + n) % n]; if (q) new Image().src = `/regions/${r.id}/${q.file}`; });
  };
  $('.prev', v).onclick = (e) => { e.stopPropagation(); show(i - 1); };
  $('.next', v).onclick = (e) => { e.stopPropagation(); show(i + 1); };
  $('.close', v).onclick = (e) => { e.stopPropagation(); closeViewer(); };
  let sx = null, sy = null;
  const frame = $('.frame', v);
  frame.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; });
  frame.addEventListener('pointerup', (e) => {
    if (sx !== null && Math.abs(e.clientX - sx) > 50 && Math.abs(e.clientX - sx) > Math.abs(e.clientY - sy)) show(i + (e.clientX < sx ? 1 : -1));
    sx = sy = null;
  });
  v._key = (e) => { if (e.key === 'Escape') closeViewer(); else if (e.key === 'ArrowRight') show(i + 1); else if (e.key === 'ArrowLeft') show(i - 1); };
  addEventListener('keydown', v._key);
  document.body.appendChild(v); viewer = v; show(i);
}

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || viewer) return;
  if ($('#settings')) { $('#settings').remove(); return; }
  if (mode === 'region') { if (region.mode === 'fp') region.exitFirstPerson(); else if (hud?.cardOpen()) hud.closeCard(); }
  else if ($('.preview')) closePreview();
});

// ---------- loop + adaptive resolution ----------
let last = performance.now(), t = 0, fAcc = 0, fN = 0;
function loop(now = performance.now()) {
  requestAnimationFrame(loop);
  if (QA && now - last < 400) return; // headless software GL
  if (document.hidden) { last = now; return; }
  const raw = (now - last) / 1000;
  const dt = Math.min(raw, QA ? 0.5 : 0.05); last = now; t += dt;
  if (mode === 'globe') { globe.update(dt, t); globe.render(); }
  else if (region.engine) { region.update(dt, t); region.render(); hud?.update(dt); }
  // dynamic resolution: keep ~50fps on phones
  if (!QA && raw < 0.5) {
    fAcc += raw; fN++;
    if (fN >= 90) {
      const fps = fN / fAcc;
      if (fps < 40 && dprScale > 0.6) { dprScale = Math.max(0.6, dprScale - 0.1); applyDPR(); resize(); }
      else if (fps > 57 && dprScale < 1) { dprScale = Math.min(1, dprScale + 0.05); applyDPR(); resize(); }
      fAcc = 0; fN = 0;
    }
  }
}
loop();

// debug hook for automated QA
window.__barimo = { globe, region, get mode() { return mode; }, regions: () => regions, openRegion: (id) => openRegion(regions.find((x) => x.id === id)) };
void fmtDist; void fmtLL; void dirName; void bearingXZ;
