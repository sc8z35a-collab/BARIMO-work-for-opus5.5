// Globe scene — bright satellite earth, soft atmosphere, HTML pins.
// v1.1: deep zoom (≈ 25 km above ground) with streamed high-res imagery: a quadtree of Web-Mercator tile
// patches (z4…z12) draped over the base texture where the camera looks; inertia; pinch/wheel zoom-to-cursor;
// pins are real buttons (a drag that ends on a pin no longer selects it); pin label declutter.
import * as THREE from 'three';
import { llToXYZ, xyzToLL, clamp, lerp, damp, angDiff, easeInOut, myToLat } from './geo.js';
import { PointerInput } from './controls.js';
import { TileStore, tkey } from './tiles.js';

const R = 1, MIN_ALT = 0.004, MAX_ALT = 5.2, PATCH_SEG = 16, MAX_PATCH_Z = 12;
const D2R = Math.PI / 180;
const lonStep = (from, to) => (angDiff(from * D2R, to * D2R) / D2R);

export class Globe {
  constructor(renderer, labelsEl) {
    this.renderer = renderer; this.labelsEl = labelsEl;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.001, 100);
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.patches = new THREE.Group(); this.group.add(this.patches);
    this.pins = []; this.selected = null;
    this.rot = { lon: 40, lat: 20, alt: 3.2 }; this.target = { ...this.rot };
    this.vel = { lon: 0, lat: 0 }; this.autoSpin = true; this.shift = 0;
    this.onSelect = () => {}; this.onOpen = () => {}; this.onZoom = null; this.onBackgroundTap = null;
    this.store = new TileStore(renderer, { texBudget: 180, demBudget: 0 });
    this.patchMap = new Map();
    this.w = innerWidth; this.h = innerHeight;
    this._build();
    this.input = new PointerInput(renderer.domElement, {
      start: () => { this.autoSpin = false; this.vel.lon = this.vel.lat = 0; this.anim = null; this._dragT = performance.now(); },
      drag: (dx, dy) => this._drag(dx, dy),
      rotate: (dx, dy) => this._drag(dx, dy),
      pinch: ({ scale, dx, dy, cx, cy }) => { this._drag(dx, dy); this._zoomAt(1 / Math.max(0.2, scale), cx, cy); },
      wheel: (d, x, y) => { this.anim = null; this.autoSpin = false; this._zoomAt(Math.exp(d * 0.0015), x, y); },
      tap: () => this.onBackgroundTap?.(),
      doubleTap: (x, y) => { this.autoSpin = false; this._zoomAt(0.45, x, y, true); },
    });
  }

  async _build() {
    const tex = await new THREE.TextureLoader().loadAsync(import.meta.env.BASE_URL + 'textures/globe.jpg');
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
    mat.onBeforeCompile = (s) => { s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${GRADE}`); };
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(R, 256, 160), mat);
    this.group.add(this.earth);
    const cloudTex = new THREE.CanvasTexture(this._cloudCanvas()); cloudTex.colorSpace = THREE.SRGBColorSpace;
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.008, 128, 96), new THREE.MeshStandardMaterial({ map: cloudTex, alphaMap: cloudTex, transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 }));
    this.group.add(this.clouds);
    this.atm = new THREE.Mesh(new THREE.SphereGeometry(R * 1.14, 96, 64), new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, uniforms: { c: { value: new THREE.Color('#bfe0f2') } },
      vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform vec3 c; varying vec3 vN; void main(){ float i = pow(max(0., 0.72 - dot(vN, vec3(0,0,1.))), 2.2); gl_FragColor = vec4(c, clamp(i*1.6, 0., 0.85)); }`,
    }));
    this.group.add(this.atm);
    this.rim = new THREE.Mesh(new THREE.SphereGeometry(R * 1.003, 96, 64), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { c: { value: new THREE.Color('#e8f5fb') }, k: { value: 0.75 } },
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 p = modelViewMatrix*vec4(position,1.); vV = normalize(-p.xyz); gl_Position = projectionMatrix*p; }`,
      fragmentShader: `uniform vec3 c; uniform float k; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.), 3.0); gl_FragColor = vec4(c, f*k); }`,
    }));
    this.group.add(this.rim);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#cfe3ee', 1.25));
    this.sun = new THREE.DirectionalLight('#fff6e8', 2.4); this.scene.add(this.sun);
    this.ready = true;
  }

  _cloudCanvas() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    const rnd = mulberry(7);
    const blob = (x, y, r, a) => {
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(255,255,255,${a})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.beginPath(); g.ellipse(x, y, r * 2.2, r, 0, 0, Math.PI * 2); g.fill();
    };
    for (let i = 0; i < 900; i++) {
      const lat = (rnd() - 0.5) * 150, y = (0.5 - lat / 180) * c.height;
      const band = Math.abs(lat) > 40 && Math.abs(lat) < 65 ? 1.6 : Math.abs(lat) < 10 ? 1.3 : 0.7;
      const x = rnd() * c.width, r = (10 + rnd() * 50) * band, a = 0.16 * band;
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); blob(x, y, r, a); g.restore();
      // wrap across the texture seam so no vertical line appears on the sphere
      if (x + r * 2.2 > c.width) { g.save(); g.translate(-c.width, 0); blob(x, y, r, a); g.restore(); }
      if (x - r * 2.2 < 0) { g.save(); g.translate(c.width, 0); blob(x, y, r, a); g.restore(); }
    }
    return c;
  }

  setRegions(regions) {
    this.labelsEl.querySelectorAll('.pin').forEach((e) => e.remove());
    this.pins = regions.map((r) => {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'pin'; el.style.setProperty('--c', r.accent);
      el.setAttribute('aria-label', r.name);
      el.innerHTML = `<span class="lb">${r.name}</span><span class="dot"></span><span class="pulse"></span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); if (this.selected === r) this.onOpen(r); else this.select(r); });
      this.labelsEl.appendChild(el);
      return { r, el, pos: new THREE.Vector3(...llToXYZ(r.center[0], r.center[1], R * 1.002)), w: 0 };
    });
    requestAnimationFrame(() => this.pins.forEach((p) => { p.w = p.el.querySelector('.lb').offsetWidth; }));
  }

  select(r, fly = true) {
    this.selected = r; this.autoSpin = false;
    this.pins.forEach((p) => p.el.classList.toggle('sel', p.r === r));
    if (fly) this.flyTo(r.center[0], r.center[1], clamp(this.target.alt, 0.35, 2.1));
    this.onSelect(r);
  }
  deselect() { this.selected = null; this.pins.forEach((p) => p.el.classList.remove('sel')); }

  flyTo(lat, lon, alt, dur) {
    const from = { ...this.rot }, to = { lat: clamp(lat, -80, 80), lon: from.lon + lonStep(from.lon, lon), alt: clamp(alt, MIN_ALT, MAX_ALT) };
    const ang = Math.hypot(to.lat - from.lat, (to.lon - from.lon) * Math.cos(to.lat * D2R));
    const d = dur ?? clamp(1 + ang / 90 + Math.abs(Math.log(to.alt / from.alt)) * 0.25, 1.1, 3.2);
    this.anim = { t: 0, d, from, to, hop: clamp(ang / 60, 0, 1.4) * Math.max(0, 1.6 - Math.min(from.alt, to.alt)) * 0.6 };
    this.vel.lon = this.vel.lat = 0;
  }
  zoomBy(f) { this.autoSpin = false; this._zoomAt(f, this.w / 2, this.h / 2, true); }

  _radPerPx() { return (this.rot.alt * Math.tan((this.camera.fov * D2R) / 2) * 2) / this.h; }
  _drag(dx, dy) {
    this.anim = null;
    const k = this._radPerPx() / D2R;
    const dLon = (-dx * k) / Math.max(0.25, Math.cos(this.rot.lat * D2R)), dLat = dy * k;
    this.target.lon += dLon; this.target.lat = clamp(this.target.lat + dLat, -80, 80);
    const now = performance.now(), dt = Math.max(0.008, (now - (this._dragT || now)) / 1000); this._dragT = now;
    this.vel.lon = lerp(this.vel.lon, dLon / dt, 0.4); this.vel.lat = lerp(this.vel.lat, dLat / dt, 0.4);
  }
  _pick(sx, sy) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1), this.camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), R), p) ? p : null;
  }
  _zoomAt(f, sx, sy, animate = false) {
    const base = animate && this.anim ? this.anim.to.alt : this.target.alt;
    const nAlt = clamp(base * f, MIN_ALT, MAX_ALT);
    const p = sx != null ? this._pick(sx, sy) : null;
    let lat = this.target.lat, lon = this.target.lon;
    if (p && nAlt < base) { // keep the point under the cursor roughly in place while zooming in
      const [pl, po] = xyzToLL(p.x, p.y, p.z), k = (1 - nAlt / base) * 0.9;
      lat = lerp(lat, pl, k); lon += lonStep(lon, po) * k;
    }
    if (animate) this.flyTo(lat, lon, nAlt, 0.6);
    else { this.target.alt = nAlt; this.target.lat = clamp(lat, -80, 80); this.target.lon = lon; }
    this.onZoom?.(nAlt);
  }

  resize(w, h) { this.w = w; this.h = h; this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  update(dt, t) {
    if (!this.ready) return;
    if (this.anim) {
      const A = this.anim; A.t += dt; const k = easeInOut(Math.min(1, A.t / A.d));
      this.target.lat = lerp(A.from.lat, A.to.lat, k); this.target.lon = lerp(A.from.lon, A.to.lon, k);
      this.target.alt = Math.exp(lerp(Math.log(A.from.alt), Math.log(A.to.alt), k)) + A.hop * Math.sin(Math.PI * k);
      Object.assign(this.rot, this.target);
      if (A.t >= A.d) { this.anim = null; this.target.alt = A.to.alt; this.rot.alt = A.to.alt; }
    } else {
      if (this.autoSpin) this.target.lon += dt * 4;
      else if (!this.input.pts.size && Math.abs(this.vel.lon) + Math.abs(this.vel.lat) > 0.001) {
        this.target.lon += this.vel.lon * dt; this.target.lat = clamp(this.target.lat + this.vel.lat * dt, -80, 80);
        const f = Math.exp(-4 * dt); this.vel.lon *= f; this.vel.lat *= f;
      }
      const s = damp(12, dt);
      this.rot.lon += lonStep(this.rot.lon, this.target.lon) * s;
      this.rot.lat += (this.target.lat - this.rot.lat) * s;
      this.rot.alt = Math.exp(lerp(Math.log(this.rot.alt), Math.log(this.target.alt), s));
    }
    const dist = R + this.rot.alt;
    const cam = new THREE.Vector3(...llToXYZ(this.rot.lat, this.rot.lon, dist));
    this.camera.position.copy(cam); this.camera.up.set(0, 1, 0); this.camera.lookAt(0, 0, 0); this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const upV = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    // shift globe left when a preview panel is open (zoomed out only) + gentle horizon tilt near the ground
    const want = this.selected && this.rot.alt > 0.8 ? 0.42 * Math.min(1, this.rot.alt / 3.2) : 0;
    this.shift = lerp(this.shift, want, damp(6, dt));
    const tiltK = clamp(1 - this.rot.alt / 0.25, 0, 1) * 0.5;
    this.camera.position.addScaledVector(right, this.shift);
    this.camera.lookAt(right.clone().multiplyScalar(this.shift).addScaledVector(upV, tiltK * this.rot.alt * 1.2));
    this.camera.near = Math.max(0.0002, this.rot.alt * 0.3); this.camera.far = dist + 2; this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.sun.position.copy(cam).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).add(new THREE.Vector3(0, 1.5, 0));
    this.clouds.rotation.y = t * 0.004;
    const high = clamp((this.rot.alt - 0.05) / 0.4, 0, 1);
    this.clouds.material.opacity = 0.5 * high; this.clouds.visible = high > 0.01;
    this.atm.visible = this.rot.alt > 0.08;
    this.rim.material.uniforms.k.value = 0.75 * clamp(this.rot.alt / 0.5, 0.15, 1);
    this._updatePatches();
    this.store.pump();
    this._updatePins();
  }

  // ---------------- streamed hi-res tile patches (quadtree over the visible cap)
  _updatePatches() {
    const alt = this.rot.alt;
    for (const m of this.patches.children) m.visible = false;
    if (alt > 1.6) return;
    const camN = this.camera.position.clone().normalize(), camD = this.camera.position.length();
    const horizon = Math.acos(clamp(R / camD, -1, 1));
    const maxZ = Math.min(MAX_PATCH_Z, Math.round(4 + Math.log2(1.6 / Math.max(alt, MIN_ALT))));
    const out = [];
    const visit = (z, x, y) => {
      const n = 2 ** z;
      const lat0 = myToLat(y / n), lat1 = myToLat((y + 1) / n), lon0 = (x / n) * 360 - 180, lon1 = ((x + 1) / n) * 360 - 180;
      const cLat = (lat0 + lat1) / 2, cLon = (lon0 + lon1) / 2;
      const c = new THREE.Vector3(...llToXYZ(cLat, cLon, 1));
      const ang = Math.acos(clamp(c.dot(camN), -1, 1));
      const size = Math.max((lat0 - lat1) * D2R, (lon1 - lon0) * D2R * Math.cos(cLat * D2R));
      if (ang - size * 0.75 > horizon + 0.02) return;
      const surf = Math.hypot(Math.max(0, ang - size * 0.7) * R, alt);
      if (z < maxZ && surf < size * R * 2.4) { for (let k = 0; k < 4; k++) visit(z + 1, x * 2 + (k & 1), y * 2 + (k >> 1)); return; }
      if (z >= 4) out.push({ z, x, y, pri: surf / (size * R) });
    };
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) visit(3, x, y);
    // most urgent first (the store caps concurrency; nearest patches must win)
    out.sort((a, b) => a.pri - b.pri);
    for (const p of out) {
      this.store.want('img', p.z, p.x, p.y, p.pri);
      let tz = p.z, tx = p.x, ty = p.y, tex = null;
      while (tz >= 4) { tex = this.store.getTex(tz, tx, ty); if (tex) break; tz--; tx >>= 1; ty >>= 1; }
      if (!tex) continue;
      const m = this._patch(p.z, p.x, p.y); m.visible = true;
      const k = tkey(tz, tx, ty);
      if (m.userData.tk !== k) {
        const s = 2 ** (p.z - tz), f = 1 / s;
        m.material.map = tex; m.material.userData.rect.value.set((p.x - tx * s) * f, (p.y - ty * s) * f, f, f); m.material.needsUpdate = m.userData.tk === undefined;
        m.userData.tk = k;
      }
    }
    if (this.patchMap.size > 420) {
      for (const [k, m] of this.patchMap) {
        if (m.visible) continue;
        this.patches.remove(m); m.geometry.dispose(); m.material.dispose(); this.patchMap.delete(k);
        if (this.patchMap.size < 260) break;
      }
    }
  }
  _patch(z, x, y) {
    const k = tkey(z, x, y);
    let m = this.patchMap.get(k);
    if (m) return m;
    const n = 2 ** z, S = PATCH_SEG, pos = new Float32Array((S + 1) ** 2 * 3), nor = new Float32Array((S + 1) ** 2 * 3), uv = new Float32Array((S + 1) ** 2 * 2), idx = [];
    const r = R * (1 + 0.000015 * (z - 3)); // finer levels sit a hair above coarser ones
    let q = 0;
    for (let j = 0; j <= S; j++) {
      const lat = myToLat((y + j / S) / n);
      for (let i = 0; i <= S; i++, q++) {
        const v = llToXYZ(lat, ((x + i / S) / n) * 360 - 180, 1);
        pos[q * 3] = v[0] * r; pos[q * 3 + 1] = v[1] * r; pos[q * 3 + 2] = v[2] * r;
        nor[q * 3] = v[0]; nor[q * 3 + 1] = v[1]; nor[q * 3 + 2] = v[2];
        uv[q * 2] = i / S; uv[q * 2 + 1] = j / S;
      }
    }
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) { const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 * (z - 2) });
    mat.userData.rect = { value: new THREE.Vector4(0, 0, 1, 1) };
    mat.onBeforeCompile = (s) => {
      s.uniforms.uTexRect = mat.userData.rect;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform vec4 uTexRect;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = uv * uTexRect.zw + uTexRect.xy;');
      s.fragmentShader = s.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${GRADE}`);
    };
    mat.customProgramCacheKey = () => 'globe-patch-1';
    m = new THREE.Mesh(g, mat);
    m.renderOrder = z; m.visible = false;
    this.patches.add(m); this.patchMap.set(k, m);
    return m;
  }

  _updatePins() {
    const v = new THREE.Vector3(), camDir = this.camera.position.clone().normalize(), placed = [];
    const order = this.pins.slice().sort((a, b) => (b.r === this.selected) - (a.r === this.selected));
    for (const p of order) {
      const facing = p.pos.clone().normalize().dot(camDir);
      const behind = p.pos.clone().sub(this.camera.position).dot(p.pos) > 0; // exact limb test for a sphere
      v.copy(p.pos).project(this.camera);
      const x = (v.x * 0.5 + 0.5) * this.w, y = (-v.y * 0.5 + 0.5) * this.h;
      const vis = !behind && v.z < 1 && x > -40 && x < this.w + 40 && y > -40 && y < this.h + 40;
      p.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      p.el.style.opacity = vis ? clamp(facing * 6, 0, 1) : 0;
      p.el.style.pointerEvents = vis && facing > 0.08 ? 'auto' : 'none';
      let showLabel = vis && (p.r === this.selected || (this.rot.alt < 3.4 && facing > 0.45));
      if (showLabel) {
        const w = (p.w || 80) + 10, rc = { x0: x - w / 2, x1: x + w / 2, y0: y - 46, y1: y - 18 };
        if (placed.some((q) => rc.x0 < q.x1 && rc.x1 > q.x0 && rc.y0 < q.y1 && rc.y1 > q.y0)) showLabel = p.r === this.selected;
        if (showLabel) placed.push(rc);
      }
      p.el.classList.toggle('nolabel', !showLabel);
    }
  }

  show(on) {
    this.active = on; this.input.setEnabled(on); this.store.paused = !on;
    this.pins.forEach((p) => (p.el.style.display = on ? '' : 'none'));
  }
  render() { this.renderer.render(this.scene, this.camera); }
  get altitudeKm() { return this.rot.alt * 6371; }
}

const GRADE = `
  float oc = smoothstep(0.08, 0.02, diffuseColor.r - diffuseColor.b * 0.55);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.75, 1.05, 1.18) + vec3(0.03, 0.10, 0.16), oc * 0.8);
  diffuseColor.rgb = pow(diffuseColor.rgb, vec3(0.92));`;

export function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
