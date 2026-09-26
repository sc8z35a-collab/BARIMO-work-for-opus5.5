// Shared helpers for all BARIMO pipeline agents
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PUB = path.join(ROOT, 'public');
export const OUT = path.join(ROOT, 'pipeline/out');
export const UA = 'BARIMO/1.0 (hidden-places research pipeline; https://github.com/sc8z35a-collab)';

export const regions = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline/config/regions.json'), 'utf8'));
export const ensure = (p) => (fs.mkdirSync(p, { recursive: true }), p);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(agent, ...msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] [${agent}] ${msg.join(' ')}`;
  console.log(line);
  ensure(OUT);
  fs.appendFileSync(path.join(OUT, 'pipeline.log'), line + '\n');
}

export async function fetchRetry(url, opts = {}, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 45000) });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) { err = e; await sleep(800 * (i + 1) ** 2); }
  }
  throw err;
}
export const fetchJSON = async (u, o) => (await fetchRetry(u, o)).json();
export const fetchBuf = async (u, o) => {
  const r = await fetchRetry(u, o);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u);
  return Buffer.from(await r.arrayBuffer());
};

// Concurrency-limited map
export async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  }));
  return res;
}

// Web-mercator tile math
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { x, y };
}
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}
// Tile window (GRID x GRID tiles at demZoom) centered on region.center
export const GRID = 4;
export function tileWindow(r) {
  const z = r.demZoom;
  const c = lonLatToTile(r.center[1], r.center[0], z);
  const x0 = Math.round(c.x - GRID / 2), y0 = Math.round(c.y - GRID / 2);
  const nw = tileToLonLat(x0, y0, z), se = tileToLonLat(x0 + GRID, y0 + GRID, z);
  const midLat = (nw.lat + se.lat) / 2;
  const widthM = ((se.lon - nw.lon) / 360) * 40075016 * Math.cos((midLat * Math.PI) / 180);
  const heightM = widthM; // mercator tiles are square on the ground at local scale
  return { z, x0, y0, bbox: { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat }, widthM, heightM };
}
export function writeJSON(p, obj) { ensure(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
export function readJSON(p, d = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
export const regionDir = (id) => ensure(path.join(PUB, 'regions', id));
export const workDir = (id) => ensure(path.join(OUT, id));

// ---- BARIMO 1.1: 5x wider explorable extent + low-detail "world" ring to the horizon ----------
// Explorable area = 5x5 tiles at L0 = demZoom-2 (= 20 tiles at demZoom; v1.0 used 4 -> 5x wider).
// World ring = 5x5 tiles at L0-2 around it (coarse terrain out to the horizon, not explorable).
export const EXTENT_N = 5;
export function extentWindow(r) {
  const z = r.demZoom - 2;
  const c = lonLatToTile(r.center[1], r.center[0], z);
  const x0 = Math.round(c.x - EXTENT_N / 2), y0 = Math.round(c.y - EXTENT_N / 2);
  const nw = tileToLonLat(x0, y0, z), se = tileToLonLat(x0 + EXTENT_N, y0 + EXTENT_N, z);
  const midLat = (nw.lat + se.lat) / 2;
  const widthM = ((se.lon - nw.lon) / 360) * 40075016.686 * Math.cos((midLat * Math.PI) / 180);
  const cx = (x0 + EXTENT_N / 2) / 4, cy = (y0 + EXTENT_N / 2) / 4;
  const world = { z: z - 2, x0: Math.floor(cx) - 2, y0: Math.floor(cy) - 2, n: 5 };
  return { z, x0, y0, n: EXTENT_N, bbox: { west: nw.lon, north: nw.lat, east: se.lon, south: se.lat }, widthM, world };
}
