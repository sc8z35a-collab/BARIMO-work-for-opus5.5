// Streaming tile store: satellite imagery (Esri World Imagery) + elevation (AWS Terrarium).
//  • priority queue re-evaluated every frame (want() → pump()); stale in-flight requests are aborted
//  • host sharding (HTTP/1.1 ≈ 6 connections per host)
//  • failures: HTTP 404 ⇒ permanently missing; opaque CORS/network failures (Esri 404s carry no CORS header)
//    ⇒ retried with backoff, then "missing" with an expiry so a flaky network never blacklists tiles forever
//  • textures decoded off-thread via createImageBitmap; DEM PNGs decoded + cleaned in a worker
//  • LRU eviction under a budget; tiles touched in the last frames are never evicted
import * as THREE from 'three';
import { decodeBlob } from './dem-decode.js';

const IMG_HOSTS = ['https://server.arcgisonline.com', 'https://services.arcgisonline.com'];
const DEM_HOSTS = ['https://s3.amazonaws.com/elevation-tiles-prod', 'https://elevation-tiles-prod.s3.amazonaws.com'];
export const IMG_MAX_Z = 19;
export const DEM_MAX_Z = 15;
const PER_HOST = 6;

export const tkey = (z, x, y) => (z * 1048576 + y) * 1048576 + x; // unique numeric key (z ≤ 20)
export const imgURL = (z, x, y) => `${IMG_HOSTS[(x + y) & 1]}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?blankTile=false`;
export const demURL = (z, x, y) => `${DEM_HOSTS[(x + y) & 1]}/terrarium/${z}/${x}/${y}.png`;

export class HttpError extends Error { constructor(s) { super('HTTP ' + s); this.status = s; } }

export class TileStore {
  constructor(renderer, { texBudget = 420, demBudget = 160 } = {}) {
    this.renderer = renderer;
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.texBudget = texBudget; this.demBudget = demBudget;
    this.tex = new Map();      // key -> { t, used, pinned }
    this.dem = new Map();      // key -> { h, w, used, min, max, pinned }
    this.pending = new Map();  // job key -> job
    this.missing = new Map();  // job key -> expiry ms (Infinity = permanent)
    this.fails = new Map();
    this.wanted = new Map();
    this.active = new Map();
    this.frame = 0;
    this.onLoad = null;
    this.paused = false;
    this.stats = { img: 0, dem: 0, failed: 0, aborted: 0 };
    this._initWorkers();
  }

  _initWorkers() {
    this.workers = []; this.wseq = 0; this.wjobs = new Map();
    this.workerOK = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
    if (!this.workerOK) return;
    const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('./dem-worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => { const j = this.wjobs.get(e.data.id); if (!j) return; this.wjobs.delete(e.data.id); e.data.ok ? j.res(e.data) : j.rej(new Error(e.data.error)); };
        w.onerror = () => { this.workerOK = false; };
        this.workers.push(w);
      } catch { this.workerOK = false; }
    }
  }
  async decodeDEM(blob, kind, lo, hi) {
    if (this.workerOK && this.workers.length) {
      try {
        return await new Promise((res, rej) => {
          const id = ++this.wseq; this.wjobs.set(id, { res, rej });
          this.workers[id % this.workers.length].postMessage({ id, blob, kind, lo, hi });
          setTimeout(() => { if (this.wjobs.has(id)) { this.wjobs.delete(id); rej(new Error('worker timeout')); } }, 20000);
        });
      } catch { this.workerOK = false; } // e.g. no 2D OffscreenCanvas in workers → main-thread fallback from now on
    }
    return decodeBlob(blob, kind, lo, hi);
  }

  getTex(z, x, y) { const e = this.tex.get(tkey(z, x, y)); if (e) e.used = this.frame; return e ? e.t : null; }
  getDEM(z, x, y) { const e = this.dem.get(tkey(z, x, y)); if (e) e.used = this.frame; return e || null; }
  isMissing(k) { const m = this.missing.get(k); if (m === undefined) return false; if (m < performance.now()) { this.missing.delete(k); return false; } return true; }
  isMissingImg(z, x, y) { return this.isMissing(tkey(z, x, y) + 0.5); }
  isMissingDEM(z, x, y) { return this.isMissing(tkey(z, x, y)); }

  putDEM(z, x, y, h, w, pinned = true) {
    let min = Infinity, max = -Infinity; for (let i = 0; i < h.length; i++) { const v = h[i]; if (v < min) min = v; if (v > max) max = v; }
    this.dem.set(tkey(z, x, y), { h, w, used: this.frame, min, max, pinned });
  }
  putTex(z, x, y, t, pinned = true) { this.tex.set(tkey(z, x, y), { t, used: this.frame, pinned }); }

  /** declare interest this frame. lower priority value = more urgent */
  want(kind, z, x, y, priority) {
    const k = tkey(z, x, y) + (kind === 'img' ? 0.5 : 0);
    if ((kind === 'img' ? this.tex : this.dem).has(tkey(z, x, y)) || this.isMissing(k)) return;
    const w = this.wanted.get(k);
    if (!w || w.priority > priority) this.wanted.set(k, { kind, z, x, y, k, priority });
  }

  pump() {
    this.frame++;
    const now = performance.now();
    for (const [k, j] of this.pending) {
      const w = this.wanted.get(k);
      if (w) { j.priority = w.priority; j.seen = now; this.wanted.delete(k); }
      else if (now - j.seen > 1500 && j.ctrl && !j.ctrl.signal.aborted) { j.ctrl.abort(); this.stats.aborted++; }
    }
    if (this.wanted.size && !this.paused) {
      const list = [...this.wanted.values()].sort((a, b) => a.priority - b.priority);
      for (const w of list) {
        const host = (w.kind === 'img' ? 'i' : 'd') + ((w.x + w.y) & 1);
        if ((this.active.get(host) || 0) >= PER_HOST) continue;
        this._start(w, host);
      }
    }
    this.wanted.clear();
    if ((this.frame & 31) === 0) this._evict();
  }

  async _start(w, host) {
    const ctrl = new AbortController();
    const gen = this.gen;
    this.pending.set(w.k, { ...w, ctrl, seen: performance.now() });
    this.active.set(host, (this.active.get(host) || 0) + 1);
    const url = w.kind === 'img' ? imgURL(w.z, w.x, w.y) : demURL(w.z, w.x, w.y);
    try {
      const r = await fetch(url, { signal: ctrl.signal, mode: 'cors', credentials: 'omit' });
      if (!r.ok) throw new HttpError(r.status);
      const blob = await r.blob();
      if (w.kind === 'img') {
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
        if (ctrl.signal.aborted || gen !== this.gen) { bmp.close?.(); throw new DOMException('aborted', 'AbortError'); }
        this.tex.set(tkey(w.z, w.x, w.y), { t: this.makeTexture(bmp), used: this.frame });
        this.stats.img++;
      } else {
        const d = await this.decodeDEM(blob, 'terrarium');
        if (gen !== this.gen) throw new DOMException('aborted', 'AbortError');
        this.dem.set(tkey(w.z, w.x, w.y), { h: d.h, w: d.w, used: this.frame, min: d.min, max: d.max });
        this.stats.dem++;
      }
      this.fails.delete(w.k);
      this.onLoad?.(w.kind, w.z, w.x, w.y);
    } catch (e) {
      if (e?.name !== 'AbortError' && gen === this.gen) {
        this.stats.failed++;
        const n = (this.fails.get(w.k) || 0) + 1; this.fails.set(w.k, n);
        const now = performance.now();
        if (e instanceof HttpError && (e.status === 404 || e.status === 400)) this.missing.set(w.k, Infinity);
        else if (w.kind === 'img' && w.z >= 17) this.missing.set(w.k, now + 120000); // opaque failure at deep zoom ≈ Esri 404
        else this.missing.set(w.k, now + (n >= 3 ? 30000 : 1000 * n * n));
      }
    } finally {
      this.pending.delete(w.k);
      this.active.set(host, Math.max(0, (this.active.get(host) || 1) - 1));
    }
  }

  makeTexture(src) {
    const t = new THREE.Texture(src);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false; // ImageBitmaps ignore UNPACK_FLIP_Y; geometry UVs are north-down to match
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = this.maxAniso;
    t.needsUpdate = true;
    if (src.close) t.onUpdate = () => { src.close(); t.onUpdate = null; }; // free the CPU copy once uploaded
    return t;
  }

  _evict() {
    const drop = (map, budget, dispose) => {
      if (map.size <= budget) return;
      const cand = [...map.entries()].filter(([, e]) => !e.pinned && e.used < this.frame - 3).sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < cand.length && map.size > budget; i++) { dispose?.(cand[i][1]); map.delete(cand[i][0]); }
    };
    drop(this.tex, this.texBudget, (e) => e.t.dispose());
    drop(this.dem, this.demBudget);
  }

  inflight() { return this.pending.size; }

  /** drop everything (leaving a region). In-flight results from the old generation are discarded. */
  clear() {
    this.gen = (this.gen || 0) + 1;
    for (const j of this.pending.values()) j.ctrl?.abort();
    for (const e of this.tex.values()) e.t.dispose();
    this.tex.clear(); this.dem.clear(); this.missing.clear(); this.fails.clear(); this.wanted.clear();
  }
  dispose() { this.clear(); this.workers.forEach((w) => w.terminate()); this.workers = []; }
}

export async function loadBlob(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new HttpError(r.status);
  return r.blob();
}
