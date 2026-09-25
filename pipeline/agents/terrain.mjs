// AGENT 2 — TERRAIN: stitches AWS Terrarium DEM tiles into a 1024² heightmap per region
import sharp from 'sharp';
import path from 'node:path';
import { regions, tileWindow, GRID, fetchBuf, pool, log, regionDir, writeJSON } from '../lib/common.mjs';
const A = 'terrain';

async function build(r) {
  const w = tileWindow(r);
  const tiles = [];
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) tiles.push({ i, j });
  const bufs = await pool(tiles, 8, async ({ i, j }) => ({
    input: await fetchBuf(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${w.z}/${w.x0 + i}/${w.y0 + j}.png`),
    left: i * 256, top: j * 256,
  }));
  const size = GRID * 256;
  const raw = await sharp({ create: { width: size, height: size, channels: 3, background: '#000' } })
    .composite(bufs).removeAlpha().raw().toBuffer();
  let min = 1e9, max = -1e9;
  const h = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const v = raw[k * 3] * 256 + raw[k * 3 + 1] + raw[k * 3 + 2] / 256 - 32768;
    h[k] = v; if (v < min) min = v; if (v > max) max = v;
  }
  // Re-encode normalized 16-bit into R(hi)/G(lo) of an 8-bit PNG → lossless & compact
  const out = Buffer.alloc(size * size * 3);
  for (let k = 0; k < size * size; k++) {
    const q = Math.round(((h[k] - min) / Math.max(1, max - min)) * 65535);
    out[k * 3] = q >> 8; out[k * 3 + 1] = q & 255; out[k * 3 + 2] = 0;
  }
  const dir = regionDir(r.id);
  await sharp(out, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 9 }).toFile(path.join(dir, 'height.png'));
  const meta = { size, minElev: Math.round(min), maxElev: Math.round(max), ...w };
  writeJSON(path.join(dir, 'terrain.json'), meta);
  log(A, `${r.id}: ${size}px DEM z${w.z}  ${meta.minElev}–${meta.maxElev} m  span ${(w.widthM / 1000).toFixed(1)} km`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
await pool(list, 4, (r) => build(r).catch((e) => log(A, `${r.id} FAILED ${e.message}`)));
log(A, 'done');
