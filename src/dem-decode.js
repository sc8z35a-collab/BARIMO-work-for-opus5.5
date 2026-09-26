// Pure DEM decoding helpers — shared by the worker, the main-thread fallback and unit tests.
// Terrarium encoding: h = R*256 + G + B/256 - 32768 (metres).
// Cleaning mirrors pipeline/lib/dem.mjs: isolated spikes/pits (> SPIKE m off the 3×3 median) are replaced by the
// median, and deep bathymetry is clamped.
export const SPIKE = 350, SEA_FLOOR = -300;

export function decodeTerrarium(rgba, n) {
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return h;
}

/** 16-bit normalised (R = hi byte, G = lo byte) → metres */
export function decode16(rgba, n, lo, hi) {
  const h = new Float32Array(n), k = (hi - lo) / 65535;
  for (let i = 0; i < n; i++) h[i] = lo + (rgba[i * 4] * 256 + rgba[i * 4 + 1]) * k;
  return h;
}

export function cleanDEM(h, w, hgt = w) {
  const out = new Float32Array(h.length), nb = new Float32Array(8);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < hgt) nb[n++] = h[yy * w + xx];
    }
    const s = nb.subarray(0, n).sort(), med = n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
    let v = h[y * w + x];
    if (!(Math.abs(v - med) <= SPIKE)) v = med; // also catches NaN
    out[y * w + x] = v < SEA_FLOOR ? SEA_FLOOR : v;
  }
  return out;
}

export function minMax(h) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < h.length; i++) { const v = h[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return [mn, mx];
}

/** RGBA pixels of a blob without colour management (exact bytes). Works in workers and on the main thread. */
export async function blobPixels(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const w = bmp.width, hh = bmp.height;
  let ctx;
  if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(w, hh).getContext('2d', { willReadFrequently: true });
  else { const c = document.createElement('canvas'); c.width = w; c.height = hh; ctx = c.getContext('2d', { willReadFrequently: true }); }
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { data: ctx.getImageData(0, 0, w, hh).data, w, h: hh };
}

export async function decodeBlob(blob, kind, lo, hi) {
  const { data, w, h } = await blobPixels(blob);
  const raw = kind === 'terrarium' ? decodeTerrarium(data, w * h) : decode16(data, w * h, lo, hi);
  const clean = kind === 'terrarium' ? cleanDEM(raw, w, h) : raw; // base DEM was already cleaned by the pipeline
  const [mn, mx] = minMax(clean);
  return { h: clean, w, hgt: h, min: mn, max: mx };
}
