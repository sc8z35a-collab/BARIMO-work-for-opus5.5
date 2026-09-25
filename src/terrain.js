// Region scene — photoreal 3D terrain: DEM mesh × 4K satellite, sun shadows, bright sky, haze, water, clouds.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mulberry } from './globe.js';

const SIZE = 100; // world units across the tile window
// ?qa=1 → lightweight mode for headless software-GL screenshots only (real devices get full quality)
export const QA = new URLSearchParams(location.search).has('qa');

// Time-of-day presets — all bright & airy (no dark/gloomy palettes)
export const TIMES = {
  morning: { label: '朝', sunEl: 14, sunAz: 110, sun: '#ffe9d6', sunI: 2.6, hemiSky: '#f3e9f2', hemiGnd: '#d9d2c4', hemiI: 1.25, top: '#9cc7e6', hor: '#f4e3dc', glow: '#ffd9c0', exp: 1.08 },
  noon:    { label: '昼', sunEl: 52, sunAz: 150, sun: '#fff8ec', sunI: 3.0, hemiSky: '#e4f1fb', hemiGnd: '#d8d4c6', hemiI: 1.2, top: '#6fa9d8', hor: '#dcecf4', glow: '#fff4dc', exp: 1.0 },
  golden:  { label: '夕', sunEl: 9, sunAz: 245, sun: '#ffcf9a', sunI: 2.8, hemiSky: '#f7e2cf', hemiGnd: '#dccbb4', hemiI: 1.3, top: '#8fb8dc', hor: '#f5e6d6', glow: '#ffc58a', exp: 1.08 },
};

export class Terrain {
  constructor(renderer, labelsEl) {
    this.renderer = renderer;
    this.labelsEl = labelsEl;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.06, rotateSpeed: 0.55, zoomSpeed: 0.9, panSpeed: 0.8,
      minDistance: 8, maxDistance: 150, maxPolarAngle: Math.PI * 0.47, minPolarAngle: 0.12, screenSpacePanning: false,
    });
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.enabled = false;
    this.controls.addEventListener('start', () => { this.idle = 0; this.cine = null; this.autoOrbit = false; });
    this.idle = 0;
    this.autoOrbit = true;
    this.labels = [];
    this._initStatic();
  }

  _initStatic() {
    const s = this.scene;
    // Sky dome with analytic gradient + sun glow; horizon color == fog color for seamless haze
    this.skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() } };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.skyU,
      vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top, hor, glow, sunDir; varying vec3 vD;
        void main(){ float h = clamp(vD.y, -0.2, 1.); float t = pow(max(h,0.), 0.55);
          vec3 c = mix(hor, top, t);
          float sd = max(dot(normalize(vD), normalize(sunDir)), 0.);
          c += glow * (pow(sd, 8.) * 0.35 + pow(sd, 64.) * 0.5 + pow(sd, 1200.) * 2.0);
          c = mix(c, hor * 1.02, smoothstep(0.02, -0.2, h));
          gl_FragColor = vec4(c, 1.); }`,
    }));
    sky.renderOrder = -1;
    s.add(sky);
    s.fog = new THREE.FogExp2('#dcecf4', 0.0032);

    this.hemi = new THREE.HemisphereLight('#fff', '#ddd', 1.2);
    s.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff', 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow;
    sc.mapSize.set(QA ? 1024 : 4096, QA ? 1024 : 4096);
    Object.assign(sc.camera, { left: -62, right: 62, top: 62, bottom: -62, near: 1, far: 400 });
    sc.bias = -0.0004; sc.normalBias = 0.35; sc.radius = 3;
    s.add(this.sun, this.sun.target);

    // soft cumulus clouds (sprites)
    this.cloudTex = new THREE.CanvasTexture(cloudSprite());
    this.cloudTex.colorSpace = THREE.SRGBColorSpace;
    this.clouds = new THREE.Group();
    s.add(this.clouds);
  }

  setTime(key) {
    const T = TIMES[key]; this.time = key;
    const el = T.sunEl * Math.PI / 180, az = T.sunAz * Math.PI / 180;
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    this.sun.position.copy(dir).multiplyScalar(160);
    this.sun.color.set(T.sun); this.sun.intensity = T.sunI;
    this.hemi.color.set(T.hemiSky); this.hemi.groundColor.set(T.hemiGnd); this.hemi.intensity = T.hemiI;
    this.skyU.top.value.set(T.top); this.skyU.hor.value.set(T.hor); this.skyU.glow.value.set(T.glow); this.skyU.sunDir.value.copy(dir);
    this.scene.fog.color.set(T.hor);
    this.renderer.toneMappingExposure = T.exp;
    if (this.waterU) { this.waterU.sunDir.value.copy(dir); this.waterU.skyCol.value.set(T.top); this.waterU.horCol.value.set(T.hor); }
    this.clouds.children.forEach((c) => c.material.color.set(key === 'golden' ? '#fff1e2' : key === 'morning' ? '#fff5f4' : '#ffffff'));
  }

  async load(region, onProgress = () => {}) {
    this.dispose();
    this.region = region;
    const base = '/';
    onProgress(0.1);
    const [hImg, satTex] = await Promise.all([
      loadHeight(base + region.assets.height),
      new THREE.TextureLoader().loadAsync(base + region.assets.sat).then((t) => { onProgress(0.7); return t; }),
    ]);
    onProgress(0.8);
    const { data, w } = hImg;
    const tr = region.terrain;
    const range = Math.max(1, tr.maxElev - tr.minElev);
    this.hScale = (range / tr.widthM) * SIZE * (region.exaggeration || 1);
    this.minElev = tr.minElev; this.range = range;
    this.heights = data; this.hw = w;

    // Geometry: full-res grid (w×w vertices)
    const step = QA ? 4 : 1;
    const seg = Math.floor((w - 1) / step);
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const gx = (i % (seg + 1)) * step, gz = Math.floor(i / (seg + 1)) * step;
      pos.setY(i, data[gz * w + gx] * this.hScale);
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    satTex.colorSpace = THREE.SRGBColorSpace;
    satTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    satTex.generateMipmaps = true;
    satTex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.MeshStandardMaterial({ map: satTex, roughness: 0.94, metalness: 0 });
    const fogCol = this.scene.fog.color;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.edgeCol = { value: fogCol };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vUv2; varying float vH;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUv2 = uv; vH = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vUv2; varying float vH; uniform vec3 edgeCol;')
        // satellite imagery already contains baked shadows — lift them so terrain reads bright & clean
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 sc = diffuseColor.rgb; float l = dot(sc, vec3(.299,.587,.114));
          sc = mix(vec3(l), sc, 1.12); sc = pow(sc, vec3(0.86)) * 1.06;
          diffuseColor.rgb = sc;`)
        .replace('#include <fog_fragment>', `#include <fog_fragment>
          vec2 e = abs(vUv2 - 0.5) * 2.0; float ed = pow(pow(e.x, 6.) + pow(e.y, 6.), 1./6.);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, edgeCol, smoothstep(0.78, 0.99, ed));`);
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);

    // sea / lagoon water
    this.seaY = (0 - tr.minElev) * (this.hScale / range);
    if (tr.minElev < 5) this._addWater(hImg);

    this._addClouds(region);
    this.setTime(this.time || 'noon');
    this._buildLabels(region);

    // camera framing: centered on the area's main POI
    const f = region.pois[0] ? this.uvToWorld(region.pois[0].uv) : new THREE.Vector3();
    this.focus = new THREE.Vector3(f.x * 0.5, this.heightAtWorld(f.x * 0.5, f.z * 0.5), f.z * 0.5);
    this.controls.target.copy(this.focus);
    this.camera.position.set(this.focus.x + 10, this.focus.y + 120, this.focus.z + 150);
    this.cine = { t: 0, dur: 5.5, from: this.camera.position.clone(), to: new THREE.Vector3(this.focus.x - 38, this.focus.y + 30, this.focus.z + 52) };
    this.autoOrbit = true; this.idle = 0;
    onProgress(1);
  }

  _addWater({ w }) {
    // height texture for depth-based color
    const h = new Float32Array(this.heights);
    const ht = new THREE.DataTexture(h, w, w, THREE.RedFormat, THREE.FloatType);
    ht.flipY = false; ht.magFilter = ht.minFilter = THREE.LinearFilter; ht.needsUpdate = true;
    this.waterU = {
      t: { value: 0 }, hTex: { value: ht }, seaN: { value: this.seaY / this.hScale },
      sunDir: { value: new THREE.Vector3() }, skyCol: { value: new THREE.Color() }, horCol: { value: new THREE.Color() },
      fogColor: { value: this.scene.fog.color }, fogDensity: { value: this.scene.fog.density },
    };
    const geo = new THREE.PlaneGeometry(SIZE * 6, SIZE * 6, 1, 1); geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.waterU,
      vertexShader: `varying vec3 vW; varying vec2 vUv; varying float vFogDepth;
        void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; vUv = vec2(w.x/${SIZE.toFixed(1)}+.5, w.z/${SIZE.toFixed(1)}+.5);
          vec4 mv = viewMatrix*w; vFogDepth = -mv.z; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform float t, seaN, fogDensity; uniform sampler2D hTex; uniform vec3 sunDir, skyCol, horCol, fogColor;
        varying vec3 vW; varying vec2 vUv; varying float vFogDepth;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+1.),f.x), f.y); }
        void main(){
          bool inside = all(greaterThan(vUv, vec2(0.))) && all(lessThan(vUv, vec2(1.)));
          float hN = inside ? texture2D(hTex, vUv).r : 0.0;
          float depth = inside ? max(seaN - hN, 0.) : 1.0;
          if (inside && hN > seaN + 0.002) discard;
          vec2 p = vW.xz * 0.9;
          float n1 = noise(p + t*0.35), n2 = noise(p*2.3 - t*0.5), n3 = noise(p*6.1 + vec2(t*0.8, -t*0.6));
          vec3 N = normalize(vec3((n1-.5)*.35 + (n2-.5)*.2 + (n3-.5)*.1, 1., (n2-.5)*.35 + (n3-.5)*.2));
          vec3 V = normalize(cameraPosition - vW);
          float fr = 0.04 + 0.96*pow(1. - max(dot(N, V), 0.), 5.);
          float d = clamp(depth * 18.0, 0., 1.);
          vec3 shallow = vec3(0.47, 0.82, 0.80), mid = vec3(0.24, 0.62, 0.78), deep = vec3(0.17, 0.44, 0.70);
          vec3 col = mix(shallow, mid, smoothstep(0., .35, d)); col = mix(col, deep, smoothstep(.35, 1., d));
          vec3 R = reflect(-V, N);
          vec3 refl = mix(horCol, skyCol, clamp(R.y, 0., 1.));
          col = mix(col, refl, fr * 0.8);
          float sp = pow(max(dot(R, normalize(sunDir)), 0.), 220.) * 3.0 + pow(max(dot(R, normalize(sunDir)), 0.), 24.) * 0.18;
          col += vec3(1., .97, .9) * sp;
          float a = inside ? mix(0.25, 0.94, smoothstep(0.0, 0.5, d)) : 0.94;
          float shore = inside ? smoothstep(0.012, 0.0, depth) : 0.;
          col = mix(col, vec3(1.), shore * (0.5 + 0.5*n3) * 0.6);
          float fogF = 1.0 - exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
          col = mix(col, fogColor, fogF);
          gl_FragColor = vec4(col, max(a, fogF)); }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = this.seaY;
    this.water.renderOrder = 2;
    this.scene.add(this.water);
  }

  _addClouds(region) {
    const rnd = mulberry(region.id.length * 97 + 13);
    const top = this.range * this.hScale / this.range;
    const baseY = (this.range * (this.hScale / this.range)) * 1 + 10;
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.cloudTex, transparent: true, opacity: 0.55 + rnd() * 0.3, depthWrite: false, fog: true }));
      const s = 18 + rnd() * 26;
      m.scale.set(s * 1.8, s, 1);
      m.position.set((rnd() - 0.5) * 180, baseY + rnd() * 18, (rnd() - 0.5) * 180);
      m.userData.v = 0.6 + rnd() * 0.8;
      this.clouds.add(m);
    }
    void top;
  }

  _buildLabels(region) {
    this.labels = region.pois.map((p, i) => {
      const el = document.createElement('div');
      el.className = 'poi-label';
      el.style.setProperty('--c', region.accent);
      el.innerHTML = `<div class="card2"><b>${p.name}</b><small>${p.desc}</small></div><div class="stem"></div><div class="base"></div>`;
      el.addEventListener('pointerup', (e) => { e.stopPropagation(); const open = !el.classList.contains('open'); this.labels.forEach((l) => l.el.classList.remove('open')); el.classList.toggle('open', open); if (open) this.flyTo(i); });
      this.labelsEl.appendChild(el);
      const wpos = this.uvToWorld(p.uv);
      return { el, pos: wpos };
    });
  }

  flyTo(i) {
    const p = this.labels[i].pos;
    const dir = this.camera.position.clone().sub(this.controls.target).setY(0).normalize();
    const to = p.clone().add(dir.multiplyScalar(26)).add(new THREE.Vector3(0, 14, 0));
    this.cine = { t: 0, dur: 2.4, from: this.camera.position.clone(), to, tFrom: this.controls.target.clone(), tTo: p.clone() };
    this.autoOrbit = false;
  }

  uvToWorld([u, v]) {
    const x = (u - 0.5) * SIZE, z = (v - 0.5) * SIZE;
    return new THREE.Vector3(x, this.heightAtWorld(x, z), z);
  }

  heightAtWorld(x, z) {
    if (!this.heights) return 0;
    const w = this.hw;
    const fx = THREE.MathUtils.clamp((x / SIZE + 0.5) * (w - 1), 0, w - 1), fz = THREE.MathUtils.clamp((z / SIZE + 0.5) * (w - 1), 0, w - 1);
    const x0 = Math.floor(fx), z0 = Math.floor(fz), x1 = Math.min(x0 + 1, w - 1), z1 = Math.min(z0 + 1, w - 1);
    const tx = fx - x0, tz = fz - z0, H = this.heights;
    const h = (H[z0 * w + x0] * (1 - tx) + H[z0 * w + x1] * tx) * (1 - tz) + (H[z1 * w + x0] * (1 - tx) + H[z1 * w + x1] * tx) * tz;
    return h * this.hScale;
  }

  elevationAt(x, z) { return Math.round(this.minElev + (this.heightAtWorld(x, z) / this.hScale) * this.range); }

  cinematic() {
    const r = 70, a = Math.random() * Math.PI * 2;
    this.cine = null; this.autoOrbit = true; this.idle = 10;
    const t = this.focus.clone();
    this.cine = { t: 0, dur: 3.2, from: this.camera.position.clone(), to: new THREE.Vector3(t.x + Math.cos(a) * r, t.y + 34, t.z + Math.sin(a) * r), tFrom: this.controls.target.clone(), tTo: t };
  }

  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.w = w; this.h = h; }

  update(dt, t) {
    if (!this.mesh) return;
    const c = this.cine;
    if (c) {
      c.t += dt; const k = easeInOut(Math.min(c.t / c.dur, 1));
      this.camera.position.lerpVectors(c.from, c.to, k);
      if (c.tFrom) this.controls.target.lerpVectors(c.tFrom, c.tTo, k);
      if (c.t >= c.dur) this.cine = null;
    } else {
      this.idle += dt;
      if (this.autoOrbit || this.idle > 8) {
        const tg = this.controls.target, off = this.camera.position.clone().sub(tg);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.045);
        this.camera.position.copy(tg).add(off);
      }
    }
    this.controls.update();
    // keep camera above ground
    const gy = this.heightAtWorld(this.camera.position.x, this.camera.position.z) + 3;
    if (this.camera.position.y < gy) this.camera.position.y = gy;
    // keep within tile
    const lim = SIZE * 0.62;
    this.controls.target.x = THREE.MathUtils.clamp(this.controls.target.x, -SIZE * 0.42, SIZE * 0.42);
    this.controls.target.z = THREE.MathUtils.clamp(this.controls.target.z, -SIZE * 0.42, SIZE * 0.42);
    this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -lim * 2.2, lim * 2.2);
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -lim * 2.2, lim * 2.2);

    // sun shadow follows target
    this.sun.target.position.copy(this.controls.target);
    this.sun.position.copy(this.controls.target).add(this.skyU.sunDir.value.clone().multiplyScalar(160));
    this.sun.target.updateMatrixWorld();

    if (this.waterU) this.waterU.t.value = t;
    for (const cl of this.clouds.children) { cl.position.x += dt * cl.userData.v; if (cl.position.x > 110) cl.position.x = -110; }

    // labels
    const v = new THREE.Vector3();
    const dist = this.camera.position.distanceTo(this.controls.target);
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
      const x = (v.x * 0.5 + 0.5) * this.w, y = (-v.y * 0.5 + 0.5) * this.h;
      l.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      l.el.style.opacity = vis ? THREE.MathUtils.clamp(1.6 - dist / 110, 0.35, 1) : 0;
    }
    this.compassAngle = Math.atan2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z);
  }

  show(on) { this.controls.enabled = on; this.labels.forEach((l) => (l.el.style.display = on ? '' : 'none')); }
  render() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    this.labels.forEach((l) => l.el.remove()); this.labels = [];
    for (const o of [this.mesh, this.water]) if (o) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); this.scene.remove(o); }
    this.waterU?.hTex.value.dispose();
    this.mesh = this.water = this.waterU = null;
    this.clouds.children.slice().forEach((c) => { c.material.dispose(); this.clouds.remove(c); });
  }
}

const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

async function loadHeight(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width;
  const cv = new OffscreenCanvas(w, w);
  const g = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, w, w).data;
  const data = new Float32Array(w * w);
  for (let i = 0; i < w * w; i++) data[i] = (px[i * 4] * 256 + px[i * 4 + 1]) / 65535;
  // light 3×3 smoothing to remove 8-bit terracing artifacts from source tiles
  const out = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= w) continue;
      const k = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1; s += data[yy * w + xx] * k; n += k;
    }
    out[y * w + x] = s / n;
  }
  return { data: out, w };
}

function cloudSprite() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d'); const rnd = mulberry(3);
  for (let i = 0; i < 38; i++) {
    const x = 90 + rnd() * 330, y = 110 + (rnd() - 0.5) * 70 - Math.sin((x - 90) / 330 * Math.PI) * 30, r = 30 + rnd() * 55;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return c;
}
