// AGENT 3 — IMAGERY: stitches Esri World Imagery at L0+1 over the 5x explorable extent into a 2560² overview.
// The client slices it into virtual tiles (instant textures for coarse LOD + offline fallback) and uses the small
// version for the minimap / travel map. Fine imagery (up to z19) is streamed at runtime.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { regions, extentWindow, fetchBuf, pool, log, regionDir } from '../lib/common.mjs';
sharp.cache(false); sharp.concurrency(1);
const A = 'imagery';

async function build(r) {
  const dir = regionDir(r.id);
  if (fs.existsSync(path.join(dir, 'overview.jpg')) && !process.env.FORCE) return log(A, `${r.id}: cached`);
  const w = extentWindow(r);
  const z = w.z + 1, N = w.n * 2, x0 = w.x0 * 2, y0 = w.y0 * 2, size = N * 256;
  let fails = 0;
  const strips = [];
  for (let j = 0; j < N; j++) { // memory-bounded: one row of tiles at a time
    const row = (await pool([...Array(N).keys()], 6, async (i) => {
      try {
        const b = await fetchBuf(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y0 + j}/${x0 + i}`);
        return { input: b, left: i * 256, top: 0 };
      } catch { fails++; return null; }
    })).filter(Boolean);
    strips.push({ input: await sharp({ create: { width: size, height: 256, channels: 3, background: '#8a9a7a' } }).composite(row).png().toBuffer(), left: 0, top: j * 256 });
  }
  const full = await sharp({ create: { width: size, height: size, channels: 3, background: '#8a9a7a' }, limitInputPixels: false }).composite(strips).png().toBuffer();
  // No colour grading here: the client grades in-shader so streamed tiles and overview tiles match exactly.
  await sharp(full, { limitInputPixels: false }).jpeg({ quality: 84, mozjpeg: true, progressive: true }).toFile(path.join(dir, 'overview.jpg'));
  await sharp(full, { limitInputPixels: false }).resize(768).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(dir, 'overview_s.jpg'));
  log(A, `${r.id}: overview ${size}px z${z} (${N * N - fails}/${N * N} tiles)`);
  if (fails > N * N * 0.1) throw new Error(`${fails} tiles failed`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
await pool(list, 1, (r) => build(r).catch((e) => { log(A, `${r.id} FAILED ${e.message}`); process.exitCode = 1; }));
log(A, 'done');
