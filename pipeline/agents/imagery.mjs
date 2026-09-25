// AGENT 3 — IMAGERY: stitches Esri World Imagery tiles (demZoom+2) into a 4096² satellite texture
sharp.cache(false); sharp.concurrency(1);
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { regions, tileWindow, GRID, fetchBuf, pool, log, regionDir } from '../lib/common.mjs';
const A = 'imagery';
const UP = 2, SUB = 2 ** UP, N = GRID * SUB;

async function build(r) {
  const dir = regionDir(r.id);
  if (fs.existsSync(path.join(dir, 'sat.jpg')) && !process.env.FORCE) return log(A, `${r.id}: cached`);
  const w = tileWindow(r);
  const z = w.z + UP, x0 = w.x0 * SUB, y0 = w.y0 * SUB;
  const jobs = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) jobs.push({ i, j });
  let fails = 0, got = 0;
  const size = N * 256;
  const strips = [];
  // memory-bounded: fetch + stitch one row of tiles at a time (N inputs per composite)
  for (let j = 0; j < N; j++) {
    const row = (await pool([...Array(N).keys()], 6, async (i) => {
      try {
        const b = await fetchBuf(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y0 + j}/${x0 + i}`);
        got++; return { input: b, left: i * 256, top: 0 };
      } catch { fails++; return null; }
    })).filter(Boolean);
    const strip = await sharp({ create: { width: size, height: 256, channels: 3, background: '#8a9a7a' } }).composite(row).jpeg({ quality: 95 }).toBuffer();
    strips.push({ input: strip, left: 0, top: j * 256 });
  }
  const full = await sharp({ create: { width: size, height: size, channels: 3, background: '#8a9a7a' }, limitInputPixels: false })
    .composite(strips).jpeg({ quality: 92 }).toBuffer();
  strips.length = 0;
  const grade = (img) => img.modulate({ saturation: 1.12, brightness: 1.04 }).gamma(1.08);
  await grade(sharp(full, { limitInputPixels: false })).jpeg({ quality: 86, mozjpeg: true, progressive: true }).toFile(path.join(dir, 'sat.jpg'));
  await grade(sharp(full, { limitInputPixels: false }).resize(1024)).jpeg({ quality: 80 }).toFile(path.join(dir, 'sat_1k.jpg'));
  const comps = { length: got };
  log(A, `${r.id}: ${size}px z${z} (${comps.length} tiles, ${fails} failed)`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
await pool(list, 1, (r) => build(r).catch((e) => log(A, `${r.id} FAILED ${e.message}`)));
log(A, 'done');
