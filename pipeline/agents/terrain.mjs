// AGENT 2 — TERRAIN: stitches AWS Terrarium DEM tiles covering the 5x explorable extent (5x5 tiles at demZoom-2)
// into a lossless 16-bit (R=hi, G=lo) heightmap. The client uses it for instant first paint + synchronous height
// queries (collision, labels, minimap) and then streams finer DEM tiles (up to z15) on demand.
import sharp from 'sharp';
import path from 'node:path';
import { cleanDEM } from '../lib/dem.mjs';
import { regions, extentWindow, fetchBuf, pool, log, regionDir, writeJSON } from '../lib/common.mjs';
const A = 'terrain';

async function build(r) {
  const w = extentWindow(r);
  const tiles = [];
  for (let j = 0; j < w.n; j++) for (let i = 0; i < w.n; i++) tiles.push({ i, j });
  const bufs = await pool(tiles, 8, async ({ i, j }) => ({
    input: await fetchBuf(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${w.z}/${w.x0 + i}/${w.y0 + j}.png`),
    left: i * 256, top: j * 256,
  }));
  const size = w.n * 256;
  const raw = await sharp({ create: { width: size, height: size, channels: 3, background: '#000' } })
    .composite(bufs).removeAlpha().raw().toBuffer();
  const h0 = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) h0[k] = raw[k * 3] * 256 + raw[k * 3 + 1] + raw[k * 3 + 2] / 256 - 32768;
  const { h, fixed } = cleanDEM(h0, size);
  let min = 1e9, max = -1e9;
  for (let k = 0; k < h.length; k++) { const v = h[k]; if (v < min) min = v; if (v > max) max = v; }
  const lo = Math.floor(min), hi = Math.ceil(max), span = Math.max(1, hi - lo);
  const out = Buffer.alloc(size * size * 3);
  for (let k = 0; k < size * size; k++) {
    const q = Math.round(((h[k] - lo) / span) * 65535);
    out[k * 3] = q >> 8; out[k * 3 + 1] = q & 255; out[k * 3 + 2] = 0;
  }
  const dir = regionDir(r.id);
  await sharp(out, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(path.join(dir, 'dem.png'));
  writeJSON(path.join(dir, 'terrain.json'), { size, minElev: lo, maxElev: hi, ...w });
  log(A, `${r.id}: ${size}px DEM z${w.z} ${lo}..${hi} m  span ${(w.widthM / 1000).toFixed(1)} km  (${fixed} spikes removed)`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
await pool(list, 3, (r) => build(r).catch((e) => { log(A, `${r.id} FAILED ${e.message}`); process.exitCode = 1; }));
log(A, 'done');
