// Quadtree LOD terrain over slippy-map tiles, in the metric region frame (see geo.js).
//
//  • roots: 5×5 "world ring" tiles at z0-2 (coarse horizon); tiles overlapping the explorable block refine down
//    to z19 imagery / z15 elevation, the ring outside stops at z0+1
//  • every node = 33×33 grid + skirts (hide LOD cracks). Heights are sampled across neighbouring DEM tiles so
//    edges are seamless whenever the neighbours are loaded; normals come from central differences on the same
//    sampler (no lighting seams)
//  • fallbacks: a node always renders with the best *available* ancestor imagery (UV sub-rect) and DEM, so the
//    map never shows holes; nodes refine in place when better data arrives (time-budgeted)
//  • vertex shader applies Earth curvature (y -= d²/2R) → real horizons over 100+ km
//  • fragment shader: satellite grading, aerial perspective (distance haze + sun-side glow), world-edge fade
import * as THREE from 'three';
import { DEM_MAX_Z, IMG_MAX_Z, tkey } from './tiles.js';
import { EARTH_R, curvatureDrop } from './geo.js';

const GRID = 32, V = GRID + 1;
const INV_2R = 1 / (2 * EARTH_R);

// ---------- shared topology (grid + double-sided skirts) ----------
let SHARED = null;
function shared() {
  if (SHARED) return SHARED;
  const nGrid = V * V, n = nGrid + 4 * V;
  const uv = new Float32Array(n * 2);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) { const k = j * V + i; uv[k * 2] = i / GRID; uv[k * 2 + 1] = j / GRID; }
  const edge = (e, t) => (e === 0 ? t : e === 1 ? GRID * V + t : e === 2 ? t * V : t * V + GRID); // grid index of edge vertex
  for (let e = 0; e < 4; e++) for (let t = 0; t < V; t++) { const s = nGrid + e * V + t, g = edge(e, t); uv[s * 2] = uv[g * 2]; uv[s * 2 + 1] = uv[g * 2 + 1]; }
  const idx = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  for (let e = 0; e < 4; e++) for (let t = 0; t < GRID; t++) {
    const g0 = edge(e, t), g1 = edge(e, t + 1), s0 = nGrid + e * V + t, s1 = s0 + 1;
    idx.push(g0, g1, s0, g1, s1, s0, g0, s0, g1, g1, s0, s1); // both windings: skirts are visible from any side
  }
  SHARED = { uv: new THREE.BufferAttribute(uv, 2), index: new THREE.BufferAttribute(new Uint32Array(idx), 1), n, nGrid, edge };
  return SHARED;
}

class Node {
  constructor(z, x, y, rect, inExt) {
    this.z = z; this.x = x; this.y = y; this.rect = rect; this.inExt = inExt;
    this.size = rect.x1 - rect.x0;
    this.mesh = null; this.demL = -1; this.texKey = -1; this.minY = 0; this.maxY = 0; this.used = 0; this.kids = null;
  }
}

export class TerrainEngine {
  constructor({ renderer, store, frame, exaggeration = 1, uniforms, quality }) {
    this.renderer = renderer; this.store = store; this.F = frame; this.exag = exaggeration; this.U = uniforms;
    this.group = new THREE.Group();
    this.nodes = new Map();
    this.zw = frame.world.z; this.z0 = frame.z0;
    this.frameNo = 0;
    this.leaves = [];
    this.setQuality(quality || { K: 2.1, maxLeaves: 380, buildMs: 5 });
    this.K = this.q.K;
    this._box = new THREE.Box3(); this._frustum = new THREE.Frustum(); this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this.placeholder = new THREE.DataTexture(new Uint8Array([122, 132, 104, 255]), 1, 1); this.placeholder.colorSpace = THREE.SRGBColorSpace; this.placeholder.needsUpdate = true;
    this.roots = [];
    const W = frame.world;
    for (let j = 0; j < W.n; j++) for (let i = 0; i < W.n; i++) this.roots.push(this._node(W.z, W.x0 + i, W.y0 + j));
    this.shadowBox = null;
  }

  setQuality(q) { this.q = { ...q }; this.K = q.K; }

  _node(z, x, y) {
    const k = tkey(z, x, y);
    let n = this.nodes.get(k);
    if (!n) { n = new Node(z, x, y, this.F.tileRect(z, x, y), this.F.tileInExtent(z, x, y)); this.nodes.set(k, n); }
    return n;
  }
  _kids(n) {
    if (!n.kids) { const z = n.z + 1, x = n.x * 2, y = n.y * 2; n.kids = [this._node(z, x, y), this._node(z, x + 1, y), this._node(z, x, y + 1), this._node(z, x + 1, y + 1)]; }
    return n.kids;
  }
  maxZ(n) { return n.inExt ? IMG_MAX_Z : this.z0 + 1; }

  // ---------------------------------------------------------------- DEM sampling
  _demTile(L, tx, ty) { return this.store.getDEM(L, tx, ty); }
  /** best DEM level available at the centre of node n (≤ desired) */
  _bestDemLevel(n) {
    const want = Math.min(DEM_MAX_Z, Math.max(this.zw, n.z - 3));
    for (let L = want; L >= this.zw; L--) { const s = n.z - L; if (s < 0) continue; if (this.store.dem.has(tkey(L, n.x >> s, n.y >> s))) return L; }
    return -1;
  }
  /** bilinear height (metres, unexaggerated) at global pixel coords of level L; crosses tile borders when loaded */
  _sample(L, gx, gy, home) {
    const p = gx - 0.5, q = gy - 0.5;
    const i0 = Math.floor(p), j0 = Math.floor(q), fx = p - i0, fy = q - j0;
    const h00 = this._px(L, i0, j0, home), h10 = this._px(L, i0 + 1, j0, home), h01 = this._px(L, i0, j0 + 1, home), h11 = this._px(L, i0 + 1, j0 + 1, home);
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }
  _px(L, ix, iy, home) {
    const tx = ix >> 8, ty = iy >> 8;
    let t = (tx === home.tx && ty === home.ty) ? home.t : this._cacheTile(L, tx, ty);
    if (!t) { // neighbour missing → clamp into the home tile
      t = home.t; ix = Math.min(Math.max(ix, home.tx * 256), home.tx * 256 + 255); iy = Math.min(Math.max(iy, home.ty * 256), home.ty * 256 + 255);
    }
    const w = t.w;
    return t.h[(iy - (iy >> 8) * 256) * w + (ix - (ix >> 8) * 256)];
  }
  _cacheTile(L, tx, ty) {
    const c = this._tc; const k = tkey(L, tx, ty);
    if (c.k0 === k) return c.t0; if (c.k1 === k) return c.t1;
    const t = this.store.dem.get(k) || null;
    c.k1 = c.k0; c.t1 = c.t0; c.k0 = k; c.t0 = t;
    return t;
  }

  /** terrain height (metres, exaggerated) at frame x,z using the finest loaded DEM. */
  heightAt(x, z) {
    const mx = this.F.xToM(x), my = this.F.zToM(z);
    this._tc = this._tc || {};
    for (let L = DEM_MAX_Z; L >= this.zw; L--) {
      const N = 2 ** L, gx = mx * N * 256, gy = my * N * 256, tx = Math.floor(mx * N), ty = Math.floor(my * N);
      const t = this.store.dem.get(tkey(L, tx, ty));
      if (t) { t.used = this.store.frame; return this._sample(L, gx, gy, { tx, ty, t }) * this.exag; }
    }
    return 0;
  }
  /** finest DEM level loaded at x,z (diagnostics / HUD) */
  demLevelAt(x, z) {
    const mx = this.F.xToM(x), my = this.F.zToM(z);
    for (let L = DEM_MAX_Z; L >= this.zw; L--) { const N = 2 ** L; if (this.store.dem.has(tkey(L, Math.floor(mx * N), Math.floor(my * N)))) return L; }
    return -1;
  }

  // ---------------------------------------------------------------- node geometry
  _build(n) {
    const L = this._bestDemLevel(n);
    const S = shared();
    const pos = n.mesh ? n.mesh.geometry.attributes.position.array : new Float32Array(S.n * 3);
    const nor = n.mesh ? n.mesh.geometry.attributes.normal.array : new Float32Array(S.n * 3);
    const E = V + 2, H = this._hbuf || (this._hbuf = new Float32Array(E * E));
    const dx = n.size / GRID;
    this._tc = {};
    if (L < 0) H.fill(0);
    else {
      const s = n.z - L, N = 2 ** L;
      const home = { tx: n.x >> s, ty: n.y >> s, t: this.store.dem.get(tkey(L, n.x >> s, n.y >> s)) };
      const inv = 1 / 2 ** n.z;
      for (let j = -1; j <= V; j++) for (let i = -1; i <= V; i++) {
        const mx = (n.x + i / GRID) * inv, my = (n.y + j / GRID) * inv;
        H[(j + 1) * E + (i + 1)] = this._sample(L, mx * N * 256, my * N * 256, home) * this.exag;
      }
    }
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i, h = H[(j + 1) * E + (i + 1)];
      pos[k * 3] = i * dx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = j * dx;
      const hl = H[(j + 1) * E + i], hr = H[(j + 1) * E + i + 2], hu = H[j * E + i + 1], hd = H[(j + 2) * E + i + 1];
      let nx = -(hr - hl) / (2 * dx), nz = -(hd - hu) / (2 * dx);
      const il = 1 / Math.hypot(nx, 1, nz); nor[k * 3] = nx * il; nor[k * 3 + 1] = il; nor[k * 3 + 2] = nz * il;
      if (h < mn) mn = h; if (h > mx) mx = h;
    }
    const skirt = Math.max(15, n.size * 0.015 + (mx - mn) * 0.05);
    for (let e = 0; e < 4; e++) for (let t = 0; t < V; t++) {
      const s = S.nGrid + e * V + t, g = S.edge(e, t);
      pos[s * 3] = pos[g * 3]; pos[s * 3 + 1] = pos[g * 3 + 1] - skirt; pos[s * 3 + 2] = pos[g * 3 + 2];
      nor[s * 3] = nor[g * 3]; nor[s * 3 + 1] = nor[g * 3 + 1]; nor[s * 3 + 2] = nor[g * 3 + 2];
    }
    n.minY = mn; n.maxY = mx; n.demL = L;
    if (!n.mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', S.uv); g.setIndex(S.index);
      const m = this._material();
      n.mesh = new THREE.Mesh(g, m);
      n.mesh.position.set(n.rect.x0, 0, n.rect.z0);
      n.mesh.frustumCulled = false; // own culling (accounts for curvature)
      n.mesh.receiveShadow = true; n.mesh.castShadow = false;
      n.mesh.matrixAutoUpdate = false; n.mesh.updateMatrix();
      n.mesh.visible = false;
      this.group.add(n.mesh);
    } else {
      n.mesh.geometry.attributes.position.needsUpdate = true;
      n.mesh.geometry.attributes.normal.needsUpdate = true;
    }
    n.mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(n.size / 2, (mn + mx) / 2, n.size / 2), Math.hypot(n.size * 0.71, (mx - mn) / 2 + skirt));
    this._assignTex(n);
  }

  _material() {
    const m = new THREE.MeshStandardMaterial({ map: this.placeholder, roughness: 0.96, metalness: 0 });
    m.userData.rect = { value: new THREE.Vector4(0, 0, 1, 1) };
    m.fog = false;
    const U = this.U;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U, { uTexRect: m.userData.rect });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform vec4 uTexRect; varying vec3 vWPos; varying float vH;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vMapUv = uv * uTexRect.zw + uTexRect.xy;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vH = transformed.y;
          vec4 wp0 = modelMatrix * vec4(transformed, 1.0);
          vWPos = wp0.xyz;
          vec2 dxz = wp0.xz - cameraPosition.xz;
          transformed.y -= dot(dxz, dxz) * ${INV_2R.toExponential(8)};`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uHaze, uHazeSun, uSunDir, uUnder; uniform float uVis, uFogMax, uLift, uSat; uniform vec4 uWorldRect;
          varying vec3 vWPos; varying float vH;`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          {
            vec3 sc = diffuseColor.rgb; float l = dot(sc, vec3(.2126,.7152,.0722));
            sc = mix(vec3(l), sc, uSat);                         // gentle saturation
            sc = sc + (1.0 - sc) * uLift * (1.0 - smoothstep(0.0, 0.25, l)); // lift baked shadows in the imagery
            diffuseColor.rgb = sc;
            if (vH < 0.0) { float dep = clamp(-vH / 40.0, 0.0, 1.0); diffuseColor.rgb = mix(diffuseColor.rgb, uUnder, 0.25 + 0.45 * dep); }
          }`)
        .replace('#include <fog_fragment>', `
          {
            vec3 dv = vWPos - cameraPosition; float d = length(dv);
            float f = 1.0 - exp(-d / uVis);
            float sd = pow(max(dot(dv / max(d, 1.0), uSunDir), 0.0), 6.0);
            vec3 hz = mix(uHaze, uHazeSun, sd * 0.75);
            vec2 wc = (uWorldRect.xy + uWorldRect.zw) * 0.5, wh = (uWorldRect.zw - uWorldRect.xy) * 0.5;
            vec2 e = abs(vWPos.xz - wc) / wh; float edge = smoothstep(0.78, 0.97, max(e.x, e.y));
            f = max(f * uFogMax, edge);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, hz, f);
          }`);
    };
    m.customProgramCacheKey = () => 'barimo-terrain-1';
    return m;
  }

  _assignTex(n) {
    // finest loaded imagery covering this node (own tile or ancestor sub-rect)
    for (let tz = n.z; tz >= Math.max(0, this.zw - 3); tz--) {
      const s = n.z - tz, tx = n.x >> s, ty = n.y >> s, k = tkey(tz, tx, ty);
      const e = this.store.tex.get(k);
      if (!e) continue;
      e.used = this.store.frame;
      if (n.texKey !== k) {
        const f = 1 / 2 ** s;
        n.mesh.material.map = e.t;
        n.mesh.material.userData.rect.value.set((n.x - (tx << s)) * f, (n.y - (ty << s)) * f, f, f);
        n.texKey = k; n.texZ = tz;
      }
      return tz;
    }
    if (n.texKey !== -1) { n.mesh.material.map = this.placeholder; n.mesh.material.userData.rect.value.set(0, 0, 1, 1); n.texKey = -1; n.texZ = -1; }
    return -1;
  }

  _disposeNode(n) {
    if (n.mesh) { this.group.remove(n.mesh); n.mesh.geometry.dispose(); n.mesh.material.dispose(); n.mesh = null; }
    n.demL = -1; n.texKey = -1;
  }

  // ---------------------------------------------------------------- per-frame
  /**
   * select LOD leaves for the camera, request tiles, refine geometry within the time budget
   * @param camera THREE.PerspectiveCamera (matrices up to date)
   * @param focus optional THREE.Vector3 — extra-high priority point (FPS position / orbit target)
   */
  update(camera, focus) {
    this.frameNo++;
    const t0 = performance.now();
    const budgetEnd = t0 + this.q.buildMs;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._m);
    const cam = camera.position;
    const leaves = this.leaves; leaves.length = 0;
    this._builds = 0;
    const canBuild = () => performance.now() < budgetEnd || this._builds < 2;
    const ensure = (n) => { if (n.mesh) return true; if (!canBuild()) return false; this._build(n); this._builds++; return true; };

    const visit = (n) => {
      n.used = this.frameNo;
      // conservative Y range before the node is built: use the DEM tile stats
      let mnY = n.minY, mxY = n.maxY;
      if (!n.mesh) { const r = this._demRange(n); mnY = r[0]; mxY = r[1]; }
      const r = n.rect;
      const cx = Math.min(Math.max(cam.x, r.x0), r.x1), cz = Math.min(Math.max(cam.z, r.z0), r.z1);
      const hd = Math.hypot(cx - cam.x, cz - cam.z);
      const drop = curvatureDrop(Math.hypot((r.x0 + r.x1) / 2 - cam.x, (r.z0 + r.z1) / 2 - cam.z));
      const cy = Math.min(Math.max(cam.y, mnY - drop), mxY);
      const dist = Math.hypot(hd, cy - cam.y);
      this._box.min.set(r.x0, mnY - drop - n.size * 0.02 - 30, r.z0); this._box.max.set(r.x1, mxY + 30, r.z1);
      if (!this._frustum.intersectsBox(this._box)) return;
      let split = n.z < this.maxZ(n) && dist < n.size * this.K;
      // stop refining where imagery is known to be missing and elevation is already at max detail
      if (split && n.z >= DEM_MAX_Z + 3 && this.store.isMissingImg(n.z, n.x, n.y)) split = false;
      if (split) {
        const kids = this._kids(n);
        let ok = true; for (const k of kids) if (!ensure(k)) { ok = false; break; }
        if (ok) { for (const k of kids) visit(k); return; }
      }
      if (!ensure(n)) return;
      n.dist = dist; leaves.push(n);
    };
    for (const r of this.roots) visit(r);

    // adaptive LOD factor keeps the leaf count inside the budget
    if (leaves.length > this.q.maxLeaves) this.K = Math.max(1.1, this.K * 0.96);
    else if (leaves.length < this.q.maxLeaves * 0.75 && this.K < this.q.K) this.K = Math.min(this.q.K, this.K * 1.015);

    // visibility + textures + requests
    for (const m of this.group.children) m.visible = false;
    const sb = this.shadowBox;
    for (const n of leaves) {
      n.mesh.visible = true;
      n.mesh.castShadow = !!sb && n.rect.x1 > sb.x0 && n.rect.x0 < sb.x1 && n.rect.z1 > sb.z0 && n.rect.z0 < sb.z1;
      const tz = this._assignTex(n);
      const pri = n.dist / n.size + (n.inExt ? 0 : 2);
      this.store.want('img', n.z, n.x, n.y, pri);
      if (tz < n.z - 2) { const s = 2; this.store.want('img', n.z - s, n.x >> s, n.y >> s, pri - 1.5); } // progressive
      const wantL = Math.min(DEM_MAX_Z, Math.max(this.zw, n.z - 3));
      if (n.demL < wantL) {
        const s = n.z - wantL;
        if (!this.store.isMissingDEM(wantL, n.x >> s, n.y >> s)) this.store.want('dem', wantL, n.x >> s, n.y >> s, pri + 0.2);
      }
    }
    // high-priority elevation right under the focus point (collision / first-person accuracy)
    if (focus) {
      const mx = this.F.xToM(focus.x), my = this.F.zToM(focus.z);
      for (const L of [DEM_MAX_Z, 13, 11]) if (L >= this.zw) this.store.want('dem', L, Math.floor(mx * 2 ** L), Math.floor(my * 2 ** L), -5 + (DEM_MAX_Z - L) * 0.1);
    }
    // refine geometry where finer DEM arrived (closest first, time-budgeted)
    const stale = leaves.filter((n) => this._bestDemLevel(n) > n.demL).sort((a, b) => a.dist - b.dist);
    for (const n of stale) { if (performance.now() > budgetEnd + 2) break; this._build(n); }

    if ((this.frameNo & 63) === 0) this._gc();
    this.stats = { leaves: leaves.length, nodes: this.nodes.size, K: this.K, ms: performance.now() - t0 };
  }

  _demRange(n) {
    for (let L = Math.min(DEM_MAX_Z, n.z); L >= this.zw; L--) {
      const s = n.z - L, t = this.store.dem.get(tkey(L, n.x >> s, n.y >> s));
      if (t) return [t.min * this.exag, t.max * this.exag];
    }
    return [-300, 9000];
  }

  _gc() {
    if (this.nodes.size < 700) return;
    const old = this.frameNo - 240;
    for (const [k, n] of this.nodes) {
      if (n.used < old && n.z > this.zw) {
        this._disposeNode(n);
        this.nodes.delete(k);
        const p = this.nodes.get(tkey(n.z - 1, n.x >> 1, n.y >> 1)); if (p) p.kids = null;
      }
    }
  }

  /** ray-march pick in rendered (curved) space. returns THREE.Vector3 or null */
  pick(origin, dir, maxDist = 400000) {
    let t = 0, step = Math.max(2, (origin.y - this.heightAt(origin.x, origin.z)) * 0.05), prev = 0;
    const p = this._v;
    const below = (tt) => {
      p.copy(dir).multiplyScalar(tt).add(origin);
      const d = Math.hypot(p.x - origin.x, p.z - origin.z);
      return p.y <= this.heightAt(p.x, p.z) - curvatureDrop(d);
    };
    while (t < maxDist) {
      t += step;
      if (below(t)) {
        let a = prev, b = t;
        for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m; }
        p.copy(dir).multiplyScalar(b).add(origin);
        p.y = this.heightAt(p.x, p.z);
        return p.clone();
      }
      prev = t; step *= 1.04;
    }
    return null;
  }

  /** is the straight segment camera→point unobstructed by terrain? (rendered, curved space) */
  visible(from, to, samples = 20) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const dT = Math.hypot(dx, dz);
    const yT = to.y - curvatureDrop(dT);
    for (let i = 1; i < samples; i++) {
      const f = i / samples, x = from.x + dx * f, z = from.z + dz * f;
      const ry = from.y + (yT - from.y) * f;
      if (this.heightAt(x, z) - curvatureDrop(dT * f) > ry + 2) return false;
    }
    return true;
  }

  dispose() {
    for (const n of this.nodes.values()) this._disposeNode(n);
    this.nodes.clear(); this.placeholder.dispose();
  }
}
