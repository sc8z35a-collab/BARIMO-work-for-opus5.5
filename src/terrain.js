// Region scene: streamed quadtree terrain (5× wider than v1.0, zoomable to z19 satellite detail) with sky, sun &
// shadows, sea, clouds, map labels — and two camera modes: map (orbit/pan/zoom) and first-person (walk / drone).
import * as THREE from 'three';
import { TileStore, loadBlob } from './tiles.js';
import { TerrainEngine } from './terrain-engine.js';
import { MapController, FirstPerson, PointerInput, EYE } from './controls.js';
import { RegionFrame, clamp, lerp, damp, curvatureDrop, escapeHTML, fmtDist } from './geo.js';
import { decodeBlob } from './dem-decode.js';
import { mulberry } from './globe.js';
import { GroundCover } from './groundcover.js';

export const QA = new URLSearchParams(location.search).has('qa');

// Bright, airy time-of-day presets (no gloomy palettes)
export const TIMES = {
  morning: { label: '朝', sunEl: 13, sunAz: 105, sun: '#ffe6cf', sunI: 1.7, hemiSky: '#f2e8f0', hemiGnd: '#d8d0c2', hemiI: 2.0, top: '#8fc0e4', hor: '#f3e2da', glow: '#ffd4b4', haze: '#e6e4e6', hazeSun: '#fbd9c0', exp: 1.06 },
  noon:    { label: '昼', sunEl: 55, sunAz: 160, sun: '#fff7ea', sunI: 1.8, hemiSky: '#e2f0fa', hemiGnd: '#d6d2c4', hemiI: 1.95, top: '#5e9fd4', hor: '#d6e8f2', glow: '#fff2d8', haze: '#cfe1ec', hazeSun: '#eef0ea', exp: 1.0 },
  golden:  { label: '夕', sunEl: 8, sunAz: 250, sun: '#ffc88f', sunI: 1.8, hemiSky: '#f6e0cc', hemiGnd: '#d9c8b0', hemiI: 2.0, top: '#86b2da', hor: '#f4e2d0', glow: '#ffbf80', haze: '#ecdccc', hazeSun: '#ffcf9c', exp: 1.06 },
};

export class RegionScene {
  constructor(renderer, labelsEl) {
    this.renderer = renderer; this.labelsEl = labelsEl;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 2e6);
    this.store = new TileStore(renderer, { texBudget: QA ? 220 : 480, demBudget: 180 });
    this.U = {
      uHaze: { value: new THREE.Color() }, uHazeSun: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uVis: { value: 60000 }, uFogMax: { value: 0.92 }, uLift: { value: 0.2 }, uSat: { value: 1.1 }, uUnder: { value: new THREE.Color('#5fb3c4') },
      uWorldRect: { value: new THREE.Vector4() }, uEye: { value: new THREE.Vector3() },
    };
    this.mode = 'map'; this.time = 'noon'; this.active = false; this.labels = [];
    this.onModeChange = null; this.onToast = null; this.onArrive = null; this.onSelectLabel = null;
    this._initStatic();
    this.input = new PointerInput(renderer.domElement, {
      start: () => { this.map?.vel.set(0, 0); this._interacted(); },
      drag: (dx, dy, x, y) => (this.mode === 'map' ? this.map.drag(dx, dy, x, y) : this.fp.look(-dx, -dy)),
      rotate: (dx, dy) => (this.mode === 'map' ? this.map.rotate(dx, dy) : this.fp.look(-dx, -dy)),
      tilt: (dy) => this.mode === 'map' && this.map.tiltBy(dy),
      pinch: (p) => { if (this.mode === 'map') this.map.pinch(p); else this.fp.look(-p.dx, -p.dy); },
      wheel: (d, x, y) => { if (this.mode === 'map') this.map.wheel(d, x, y); else this._fov(d); },
      end: () => this.map?.end(),
      tap: (x, y) => this._tap(x, y),
      doubleTap: (x, y) => { if (this.mode === 'map') { const p = this.map.groundAt(x, y); if (p) this.map.flyTo(p.x, p.z, { dist: Math.max(this.map.minDist, this.map.dist * 0.4), dur: 0.9 }); } },
    });
    this._keys = (e) => this._key(e);
    addEventListener('keydown', this._keys); addEventListener('keyup', this._keys);
    addEventListener('blur', () => this.fp?.keys.clear());
  }

  _initStatic() {
    const s = this.scene;
    this.skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, haze: { value: new THREE.Color() } };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, uniforms: this.skyU,
      vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 top, hor, glow, sunDir, haze; varying vec3 vD;
        void main(){ vec3 d = normalize(vD); float h = d.y;
          vec3 c = mix(hor, top, pow(clamp(h, 0., 1.), 0.5));
          float sd = max(dot(d, normalize(sunDir)), 0.);
          c += glow * (pow(sd, 8.) * 0.32 + pow(sd, 64.) * 0.45) + vec3(1.0, 0.97, 0.9) * pow(sd, 1600.) * 2.2;
          c = mix(c, haze, smoothstep(0.03, -0.06, h));
          gl_FragColor = vec4(c, 1.); }`,
    }));
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    s.add(this.sky);
    this.hemi = new THREE.HemisphereLight('#fff', '#ddd', 1.2); s.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff', 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow; sc.mapSize.set(QA ? 1024 : 2048, QA ? 1024 : 2048); sc.bias = -0.0005; sc.normalBias = 0.6; sc.radius = 3;
    s.add(this.sun, this.sun.target);
    this.cloudTex = new THREE.CanvasTexture(cloudSprite()); this.cloudTex.colorSpace = THREE.SRGBColorSpace;
    this.clouds = new THREE.Group(); s.add(this.clouds);
  }

  setTime(key) {
    const T = TIMES[key]; if (!T) return; this.time = key;
    const el = (T.sunEl * Math.PI) / 180, az = (T.sunAz * Math.PI) / 180;
    this.sunDir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize(); // az from north
    this.sun.color.set(T.sun); this.sun.intensity = T.sunI;
    this.hemi.color.set(T.hemiSky); this.hemi.groundColor.set(T.hemiGnd); this.hemi.intensity = T.hemiI;
    this.skyU.top.value.set(T.top); this.skyU.hor.value.set(T.hor); this.skyU.glow.value.set(T.glow); this.skyU.sunDir.value.copy(this.sunDir); this.skyU.haze.value.set(T.haze);
    this.U.uHaze.value.set(T.haze); this.U.uHazeSun.value.set(T.hazeSun); this.U.uSunDir.value.copy(this.sunDir);
    if (this.waterU) { this.waterU.sunDir.value.copy(this.sunDir); this.waterU.skyCol.value.set(T.top); this.waterU.horCol.value.set(T.hor); this.waterU.haze.value.set(T.haze); }
    this.exposure = T.exp;
    if (this.active) this.renderer.toneMappingExposure = T.exp;
    this.clouds.children.forEach((c) => c.material.color.set(key === 'golden' ? '#fff0de' : key === 'morning' ? '#fff4f2' : '#ffffff'));
  }

  // ------------------------------------------------------------------ load
  /** load a region. throws on fatal errors. `signal` aborts (user pressed back during loading). */
  async load(region, onProgress = () => {}, signal) {
    this.unload();
    this.region = region;
    const t = region.terrain;
    this.F = new RegionFrame(t);
    const W = this.F.worldRect; this.U.uWorldRect.value.set(W.x0, W.z0, W.x1, W.z1);
    this.exag = region.exaggeration || 1;
    this.hasSea = t.minElev < 5;
    onProgress(0.05);
    // base DEM (5×5 tiles at z0) + overview imagery (10×10 at z0+1), both shipped with the app
    let got = 0; const tick = () => onProgress(0.1 + 0.75 * (++got / 2));
    const [demBlob, ovBlob] = await Promise.all([
      loadBlob(import.meta.env.BASE_URL + region.assets.dem, signal).then((b) => { tick(); return b; }),
      loadBlob(import.meta.env.BASE_URL + region.assets.overview, signal).then((b) => { tick(); return b; }),
    ]);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const dem = await this.store.decodeDEM(demBlob, '16', t.minElev, t.maxElev);
    this._sliceDEM(dem, t);
    await this._sliceOverview(ovBlob, t);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    onProgress(0.9);

    this.engine = new TerrainEngine({ renderer: this.renderer, store: this.store, frame: this.F, exaggeration: this.exag, uniforms: this.U, quality: this.quality });
    this.scene.add(this.engine.group);
    this.ground = new GroundCover({ renderer: this.renderer, engine: this.engine, uniforms: this.U, density: +(new URLSearchParams(location.search).get('grass') ?? (QA ? 0.5 : (this.quality?.grass ?? 1))) });
    this.scene.add(this.ground.group);
    this.map = new MapController(this.camera, this.engine, this.F);
    this.map.onUser = () => this._interacted();
    this.fp = new FirstPerson(this.camera, this.engine, this.F, { hasSea: this.hasSea });
    this.fp.onEvent = (k) => this.onToast?.({ edge: 'ここが探索エリアの端です', sea: 'この先は海です。ドローンに切り替えると渡れます', 'nav-manual': '自動移動を解除しました' }[k]);
    this.fp.onArrive = (n) => this.onArrive?.(n);
    if (this.hasSea) this._addWater();
    this._addClouds(region);
    this.setTime(this.time);
    this._buildLabels(region);

    // opening shot: wide establishing view that settles on the main POI
    const [px, pz] = region.pois[0] ? this.F.uvToXZ(region.pois[0].uv) : [0, 0];
    this.home = { x: px * 0.6, z: pz * 0.6, dist: this.F.size * 0.42, tilt: 1.02, yaw: 0.35 };
    Object.assign(this.map.target, { x: 0, z: 0 }); this.map.dist = this.F.size * 1.05; this.map.tilt = 0.25; this.map.yaw = -0.3;
    this.map.groundY = this.engine.heightAt(0, 0);
    this.map.flyTo(this.home.x, this.home.z, { dist: this.home.dist, tilt: this.home.tilt, yaw: this.home.yaw, dur: 5 });
    this.mode = 'map'; this.idle = 0; this.autoOrbit = false;
    this.store.clearMissingOnLoad = true;
    onProgress(1);
  }

  _sliceDEM(dem, t) {
    const n = t.n, S = 256;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const h = new Float32Array(S * S);
      for (let y = 0; y < S; y++) h.set(dem.h.subarray((j * S + y) * dem.w + i * S, (j * S + y) * dem.w + i * S + S), y * S);
      this.store.putDEM(t.z, t.x0 + i, t.y0 + j, h, S, true);
    }
    // coarse world ring (z0-2) from the base DEM where it overlaps; ring tiles outside are streamed
    this.baseDEM = dem;
  }

  async _sliceOverview(blob, t) {
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
    const z = t.z + 1, n = t.n * 2, S = bmp.width / n;
    const jobs = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      jobs.push(createImageBitmap(bmp, i * S, j * S, S, S, { premultiplyAlpha: 'none' }).then((b) => this.store.putTex(z, t.x0 * 2 + i, t.y0 * 2 + j, this.store.makeTexture(b), true)));
    }
    // z0 tiles as 2×2 downsamples so the far block has textures immediately too
    for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) {
      jobs.push(createImageBitmap(bmp, i * S * 2, j * S * 2, S * 2, S * 2, { premultiplyAlpha: 'none', resizeWidth: 256, resizeHeight: 256, resizeQuality: 'high' }).then((b) => this.store.putTex(t.z, t.x0 + i, t.y0 + j, this.store.makeTexture(b), true)));
    }
    await Promise.all(jobs);
    bmp.close?.();
  }

  _addWater() {
    this.waterU = {
      t: { value: 0 }, sunDir: { value: new THREE.Vector3() }, skyCol: { value: new THREE.Color() }, horCol: { value: new THREE.Color() },
      haze: { value: new THREE.Color() }, uVis: this.U.uVis, uFogMax: this.U.uFogMax, uWorldRect: this.U.uWorldRect, uEye: this.U.uEye,
    };
    const R = this.F.worldRect, w = R.x1 - R.x0;
    const geo = new THREE.PlaneGeometry(w, w, 160, 160); geo.rotateX(-Math.PI / 2); geo.translate((R.x0 + R.x1) / 2, 0, (R.z0 + R.z1) / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.waterU,
      vertexShader: `uniform vec3 uEye; varying vec3 vW;
        void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec2 d = w.xz - uEye.xz; w.y -= dot(d, d) * ${(1 / (2 * 6371008.8)).toExponential(8)};
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float t, uVis, uFogMax; uniform vec3 sunDir, skyCol, horCol, haze; uniform vec4 uWorldRect; varying vec3 vW;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+1.), f.x), f.y); }
        void main(){
          vec3 dv = vW - cameraPosition; float d = length(dv);
          float sc = 1.0 / clamp(d / 400.0, 1.0, 400.0);
          vec2 p = vW.xz * 0.08;
          float n1 = noise(p + t*0.3), n2 = noise(p*2.7 - t*0.45), n3 = noise(p*7.3 + vec2(t*0.7, -t*0.5));
          float amp = mix(0.02, 0.35, sc);
          vec3 N = normalize(vec3(((n1-.5)*.6 + (n2-.5)*.3 + (n3-.5)*.15) * amp, 1., ((n2-.5)*.6 + (n3-.5)*.3) * amp));
          vec3 V = -dv / max(d, 1.0);
          float fr = 0.02 + 0.98 * pow(1. - max(dot(N, V), 0.), 5.);
          vec3 col = vec3(0.13, 0.42, 0.62);
          vec3 R = reflect(-V, N);
          col = mix(col, mix(horCol, skyCol, clamp(R.y * 2.0, 0., 1.)), fr * 0.85);
          float s = max(dot(R, normalize(sunDir)), 0.);
          col += vec3(1., .96, .88) * (pow(s, 300.) * 2.5 + pow(s, 30.) * 0.12);
          float f = 1.0 - exp(-d / uVis);
          vec2 wc = (uWorldRect.xy + uWorldRect.zw) * 0.5, wh = (uWorldRect.zw - uWorldRect.xy) * 0.5;
          vec2 e = abs(vW.xz - wc) / wh; float edge = smoothstep(0.78, 0.97, max(e.x, e.y));
          col = mix(col, haze, max(f * uFogMax, edge));
          gl_FragColor = vec4(col, mix(0.72, 0.97, clamp(fr * 2. + f, 0., 1.))); }`,
    });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1;
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = 0.0; this.water.renderOrder = 2; this.water.frustumCulled = false;
    this.scene.add(this.water);
  }

  _addClouds(region) {
    const rnd = mulberry(region.id.length * 131 + 7);
    const top = region.terrain.maxElev * this.exag;
    const n = QA ? 10 : 26, R = this.F.size * 0.7;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.cloudTex, transparent: true, opacity: 0.5 + rnd() * 0.3, depthWrite: false, fog: false }));
      const s = this.F.size * (0.05 + rnd() * 0.06);
      m.scale.set(s * 1.9, s * 0.8, 1);
      m.position.set((rnd() - 0.5) * 2 * R, top + 900 + rnd() * 1800, (rnd() - 0.5) * 2 * R);
      m.userData.v = (0.4 + rnd() * 0.8) * this.F.size * 0.0004;
      this.clouds.add(m);
    }
  }

  // ------------------------------------------------------------------ labels
  _buildLabels(region) {
    const mk = (p, i, kind) => {
      const el = document.createElement('button');
      el.className = `tl tl-${kind}`; el.type = 'button';
      el.style.setProperty('--c', region.accent);
      const ele = p.ele ? `<em>${p.ele.toLocaleString()} m</em>` : '';
      el.innerHTML = kind === 'poi'
        ? `<span class="tl-card"><b>${escapeHTML(p.name)}</b><small>${escapeHTML(p.desc)}</small></span><span class="tl-stem"></span><span class="tl-dot"></span>`
        : `<span class="tl-card"><i class="k k-${p.kind}"></i><b>${escapeHTML(p.name)}</b>${ele}</span><span class="tl-dot"></span>`;
      el.setAttribute('aria-label', p.name);
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onSelectLabel?.(this.labels[idx]); });
      this.labelsEl.appendChild(el);
      const [x, z] = this.F.uvToXZ(p.uv);
      const idx = this.labels.length;
      const L = { el, x, z, p, kind, i, prio: kind === 'poi' ? 1000 - i : kind === 'town' ? 500 : kind === 'peak' ? 300 + (p.ele || 0) / 100 : kind === 'lake' ? 350 : 200, vis: false, w: 0, h: 0, occl: false, occT: 0 };
      this.labels.push(L);
    };
    region.pois.forEach((p, i) => mk(p, i, 'poi'));
    (region.places || []).forEach((p, i) => mk(p, i, p.kind));
    requestAnimationFrame(() => this.labels.forEach((l) => { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; }));
  }
  setLabelsVisible(v) { this.labelsOn = v; }

  _updateLabels() {
    const cam = this.camera, W = this.w, H = this.h, v = new THREE.Vector3();
    // UI panels/controls block labels (glass is translucent — labels behind it read as clutter)
    if (!this._uiRects || performance.now() - this._uiT > 300) {
      this._uiT = performance.now();
      this._uiRects = [...document.querySelectorAll('.region-ui .topbar > *, .region-ui .panel:not(.closed), .hud .minimap, .hud .mapctl, .hud .walk-btn, .hud .compass, .hud .card3:not(.hidden), .hud .joy, .hud .fp-right, .hud .lift, .hud .navbar:not(.hidden), .hud .readout')]
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x0: r.left - 4, x1: r.right + 4, y0: r.top - 4, y1: r.bottom + 4 }));
    }
    const placed = this._uiRects.slice();
    const fpMode = this.mode === 'fp';
    const camAlt = this.mode === 'map' ? this.map.dist : this.fp.agl();
    const sorted = this.labels.slice().sort((a, b) => b.prio - a.prio);
    let occChecks = 0;
    for (const L of sorted) {
      const y = this.engine.heightAt(L.x, L.z);
      const d = Math.hypot(L.x - cam.position.x, L.z - cam.position.z);
      v.set(L.x, y - curvatureDrop(d), L.z).project(cam);
      let show = this.labelsOn !== false && v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      // minor labels only when reasonably close
      if (show && L.kind !== 'poi') {
        const range = fpMode ? 30000 : Math.max(8000, camAlt * 2.6);
        if (d > range * (L.kind === 'peak' || L.kind === 'town' ? 1.3 : 0.8)) show = false;
      }
      if (show && fpMode && d < 12) show = false;
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      // terrain occlusion (amortised: a few checks per frame, hysteresis)
      if (show) {
        if (occChecks < 6 && performance.now() - L.occT > 250) {
          occChecks++; L.occT = performance.now();
          L.occl = !this.engine.visible(cam.position, { x: L.x, y: y + (L.kind === 'poi' ? 30 : 10), z: L.z }, 24);
        }
        if (L.occl) show = false;
      }
      if (show) { // declutter: skip if overlapping a higher-priority label
        const w = L.w || 90, h = L.h || 30;
        const r = { x0: sx - w / 2 - 4, x1: sx + w / 2 + 4, y0: sy - h - 4, y1: sy + 4 };
        if (r.x0 < 2 || r.x1 > W - 2 || r.y0 < 2 || r.y1 > H - 2) show = false; // never cut off at screen edges
        else if (placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) show = false;
        else placed.push(r);
      }
      if (show !== L.vis) { L.vis = show; L.el.classList.toggle('on', show); }
      if (show) L.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  // ------------------------------------------------------------------ modes
  enterFirstPerson(x, z, yaw, keepYaw = false) {
    if (!this.engine) return;
    this.map.cancelAnim();
    if (x == null) { x = this.map.target.x; z = this.map.target.z; yaw = this.map.yaw; }
    if (this.hasSea && this.engine.heightAt(x, z) < 0.3) {
      const land = this._nearestLand(x, z); if (land) [x, z] = land;
    }
    const m = this.F.half - 60; x = clamp(x, -m, m); z = clamp(z, -m, m);
    // drop the traveller on walkable ground: search nearby for the flattest spot (cliffs make a poor first view)
    const slopeAt = (px, pz) => { const E = this.engine, d = 12; return Math.hypot(E.heightAt(px + d, pz) - E.heightAt(px - d, pz), E.heightAt(px, pz + d) - E.heightAt(px, pz - d)) / (2 * d); };
    if (slopeAt(x, z) > 0.35) {
      let best = [x, z, slopeAt(x, z)];
      for (const r of [40, 90, 160, 260]) for (let a = 0; a < 12; a++) {
        const px = x + Math.cos((a / 12) * 6.283) * r, pz = z + Math.sin((a / 12) * 6.283) * r;
        if (!this.F.inExtent(px, pz, 80) || (this.hasSea && this.engine.heightAt(px, pz) < 1)) continue;
        const s = slopeAt(px, pz); if (s < best[2]) best = [px, pz, s];
      }
      [x, z] = best;
    }
    this.fp.mode = 'walk'; this.fp.speedIdx = 0; this.fp.setNav(null);
    if (!keepYaw) yaw = this._openView(x, z, yaw);
    this.fp.place(x, z, yaw);
    this.mode = 'fp';
    this.camera.fov = 62; this.camera.near = 0.3; this.camera.updateProjectionMatrix();
    this._trans = { t: 0, d: 1.6, from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone() };
    this.onModeChange?.('fp');
  }
  exitFirstPerson() {
    if (this.mode !== 'fp') return;
    const p = this.fp.pos;
    this.map.target.set(p.x, 0, p.z); this.map.groundY = this.engine.heightAt(p.x, p.z);
    this.map.yaw = this.fp.yaw; this.map.dist = 450; this.map.tilt = 1.1;
    this.map.flyTo(p.x, p.z, { dist: 2500, tilt: 1.0, yaw: this.fp.yaw, dur: 1.6 });
    this.mode = 'map'; this._trans = null;
    this.camera.fov = 50; this.camera.near = 1; this.camera.updateProjectionMatrix();
    this.onModeChange?.('map');
  }
  /** direction (bearing) with the most open view from x,z — lowest max elevation angle, biased to `pref` */
  _openView(x, z, pref = 0) {
    const E = this.engine, h0 = E.heightAt(x, z) + 1.65;
    let best = pref, bestScore = Infinity;
    for (let a = 0; a < 24; a++) {
      const b = (a / 24) * Math.PI * 2, sx = Math.sin(b), sz = -Math.cos(b);
      let maxAng = -1;
      for (const d of [30, 80, 160, 320, 640, 1300, 2600, 5000]) {
        const px = x + sx * d, pz = z + sz * d;
        if (!this.F.inWorld(px, pz)) break;
        maxAng = Math.max(maxAng, (E.heightAt(px, pz) - curvatureDrop(d) - h0) / d);
      }
      const bias = Math.abs(Math.atan2(Math.sin(b - pref), Math.cos(b - pref))) * 0.05;
      const score = maxAng + bias;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }
  _nearestLand(x, z) {
    for (let r = 50; r < this.F.size * 0.5; r *= 1.35) for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r, pz = z + Math.sin((a / 16) * Math.PI * 2) * r;
      if (this.F.inExtent(px, pz, 80) && this.engine.heightAt(px, pz) > 2) return [px, pz];
    }
    return null;
  }
  /** fly the map to a label/POI, or navigate there in first-person */
  goTo(L, { auto = false } = {}) {
    if (this.mode === 'fp') { this.fp.setNav({ x: L.x, z: L.z, name: L.p.name, auto }); return; }
    const dist = L.kind === 'poi' ? 3200 : L.kind === 'peak' ? 5000 : 2800;
    this.map.flyTo(L.x, L.z, { dist, tilt: 1.12 });
  }
  resetView() { if (this.mode === 'map' && this.home) this.map.flyTo(this.home.x, this.home.z, { dist: this.home.dist, tilt: this.home.tilt, yaw: this.home.yaw }); }
  northUp() { if (this.mode === 'map') this.map.flyTo(this.map.target.x, this.map.target.z, { yaw: 0, tilt: this.map.tilt, dur: 0.8 }); else this.fp.yaw = 0; }
  zoom(f) { if (this.mode === 'map') { this.map.cancelAnim(); this.map.flyTo(this.map.target.x, this.map.target.z, { dist: this.map.dist * f, dur: 0.45 }); } else this._fov(f > 1 ? 300 : -300); }
  cinematic() {
    if (this.mode !== 'map') return;
    this.autoOrbit = true; this.idle = 999;
    this.map.flyTo(this.map.target.x, this.map.target.z, { dist: clamp(this.map.dist, 3000, 16000), tilt: 1.18, dur: 1.6 });
  }
  stopCinematic() { this.autoOrbit = false; }
  _fov(d) { this.camera.fov = clamp(this.camera.fov + d * 0.02, 20, 75); this.camera.updateProjectionMatrix(); }
  _interacted() { this.idle = 0; if (this.autoOrbit) { this.autoOrbit = false; this.onCineStop?.(); } }

  _tap(x, y) {
    if (this.mode === 'fp') return;
    // tap on the map: nothing (labels are buttons). Close any open card.
    this.onTapMap?.(x, y);
  }
  _key(e) {
    if (!this.active || !this.fp) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const down = e.type === 'keydown';
    const code = e.code;
    if (this.mode === 'fp') {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE', 'KeyQ', 'ShiftLeft', 'ShiftRight'].includes(code)) {
        e.preventDefault(); down ? this.fp.keys.add(code) : this.fp.keys.delete(code);
      }
    } else if (down) {
      const M = this.map, k = M.dist * 0.08;
      const mv = (fx, fz) => { M.cancelAnim(); const c = Math.cos(M.yaw), s = Math.sin(M.yaw); M.target.x += (fx * c - fz * s) * k; M.target.z += (fx * s + fz * c) * k; M._clampTarget(); this._interacted(); };
      if (code === 'ArrowUp' || code === 'KeyW') mv(0, -1); else if (code === 'ArrowDown' || code === 'KeyS') mv(0, 1);
      else if (code === 'ArrowLeft' || code === 'KeyA') mv(-1, 0); else if (code === 'ArrowRight' || code === 'KeyD') mv(1, 0);
      else if (code === 'Equal' || code === 'NumpadAdd') this.zoom(0.6); else if (code === 'Minus' || code === 'NumpadSubtract') this.zoom(1.6);
      else if (code === 'KeyQ') { M.yaw -= 0.15; this._interacted(); } else if (code === 'KeyE') { M.yaw += 0.15; this._interacted(); }
    }
  }

  // ------------------------------------------------------------------ frame
  resize(w, h) { this.w = w; this.h = h; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.camera.domRect = { left: 0, top: 0, width: w, height: h }; }

  update(dt, t) {
    if (!this.engine) return;
    if (this.mode === 'map') {
      this.idle += dt;
      if (this.autoOrbit && !this.map.anim) this.map.yaw += dt * 0.05;
      this.map.update(dt);
    } else {
      this.fp.update(dt);
      if (this._trans) { // smooth hand-off from the map view into the eyes of the traveller
        const T = this._trans; T.t += dt; const k = Math.min(1, T.t / T.d), e = k * k * (3 - 2 * k);
        const to = this.camera.position.clone(), toQ = this.camera.quaternion.clone();
        this.camera.position.lerpVectors(T.from, to, e); this.camera.quaternion.slerpQuaternions(T.fromQ, toQ, e);
        this.camera.updateMatrixWorld();
        if (k >= 1) this._trans = null;
      }
    }
    const cam = this.camera.position;
    // Hard guarantee (both modes): the eye stays above the rendered surface. The rendered mesh may use a
    // finer/coarser DEM than heightAt() for a moment, so keep a margin that scales with altitude.
    {
      const g = this.engine.groundAt(cam.x, cam.z), minClear = this.mode === 'fp' ? 0.9 : 8;
      if (cam.y < g + minClear) { cam.y = g + minClear; this.camera.updateMatrixWorld(); }
    }
    this.U.uEye.value.copy(cam);
    // near/far adapt to altitude (depth precision)
    const alt = Math.max(1, cam.y - this.engine.heightAt(cam.x, cam.z));
    const near = clamp(alt * 0.1, this.mode === 'fp' ? 0.25 : 1, 400);
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.15) { this.camera.near = near; this.camera.far = 1.6e6; this.camera.updateProjectionMatrix(); }
    // visibility / haze distance grows with altitude so high views stay crisp
    this.U.uVis.value = lerp(this.U.uVis.value, clamp(22000 + alt * 7, 22000, 600000), damp(3, dt));
    this.sky.position.copy(cam); this.sky.scale.setScalar(1e5);

    // shadows around the focus point
    const focus = this.mode === 'map' ? this.map.target : this.fp.pos;
    const span = clamp(this.mode === 'map' ? this.map.dist * 1.3 : Math.max(600, this.fp.agl() * 4), 300, 60000);
    const sc = this.sun.shadow.camera;
    if (Math.abs(sc.right - span) / span > 0.1) { Object.assign(sc, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 8 }); sc.updateProjectionMatrix(); }
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.sun.position.copy(this.sunDir).multiplyScalar(span * 3).add(this.sun.target.position);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.normalBias = span * 0.0012;
    this.engine.shadowBox = { x0: focus.x - span, x1: focus.x + span, z0: focus.z - span, z1: focus.z + span };

    this.engine.update(this.camera, focus);
    this.ground?.update({ on: this.mode === 'fp' && !this._trans && this.fp.agl() < 45, camera: this.camera, scene: this.scene, hide: [this.sky, this.clouds, this.water].filter(Boolean), t, sunColor: this.sun.color });
    this.store.pump();
    if (this.waterU) this.waterU.t.value = t;
    const lim = this.F.size * 0.75;
    for (const c of this.clouds.children) { c.position.x += dt * c.userData.v; if (c.position.x > lim) c.position.x = -lim; }
    this.clouds.visible = this.mode === 'fp' || this.map.dist < this.F.size * 0.6;
    this._updateLabels();
  }

  /** readouts for HUD */
  info() {
    const cam = this.camera.position, focus = this.mode === 'map' ? this.map.target : this.fp.pos;
    const [lat, lon] = this.F.xzToLL(focus.x, focus.z);
    return {
      lat, lon, elev: Math.round(this.engine.heightAt(focus.x, focus.z) / this.exag),
      heading: this.mode === 'map' ? this.map.heading : this.fp.heading,
      alt: this.mode === 'map' ? this.map.dist : this.fp.agl(),
      camAlt: cam.y / this.exag,
      loading: this.store.inflight(),
    };
  }

  render() { this.renderer.render(this.scene, this.camera); }

  show(on) {
    this.active = on;
    this.input.setEnabled(on);
    this.labels.forEach((l) => (l.el.style.display = on ? '' : 'none'));
    if (on) this.renderer.toneMappingExposure = this.exposure || 1;
    this.store.paused = !on;
  }

  unload() {
    this.labels.forEach((l) => l.el.remove()); this.labels = [];
    if (this.ground) { this.scene.remove(this.ground.group); this.ground.dispose(); this.ground = null; }
    if (this.engine) { this.scene.remove(this.engine.group); this.engine.dispose(); this.engine = null; }
    if (this.water) { this.scene.remove(this.water); this.water.geometry.dispose(); this.water.material.dispose(); this.water = null; this.waterU = null; }
    this.clouds.children.slice().forEach((c) => { c.material.dispose(); this.clouds.remove(c); });
    this.store.clear();
    this.map = null; this.fp = null; this.region = null; this.mode = 'map';
  }
}

void fmtDist; void EYE; void decodeBlob;

function cloudSprite() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'); const rnd = mulberry(3);
  for (let i = 0; i < 40; i++) {
    const x = 90 + rnd() * 330, y = 120 + (rnd() - 0.5) * 60 - Math.sin(((x - 90) / 330) * Math.PI) * 30, r = 28 + rnd() * 55;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.5)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.2)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return c;
}
