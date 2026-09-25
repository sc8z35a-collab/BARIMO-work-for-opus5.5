// AGENT 3 — IMAGERY: stitches Esri World Imagery tiles (demZoom+2) into a 4096² satellite texture
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
  let fails = 0;
  const comps = (await pool(jobs, 12, async ({ i, j }) => {
    try {
      const b = await fetchBuf(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y0 + j}/${x0 + i}`);
      return { input: b, left: i * 256, top: j * 256 };
    } catch { fails++; return null; }
  })).filter(Boolean);
  const size = N * 256;
  // composite in horizontal strips to keep memory bounded
  const img = sharp({ create: { width: size, height: size, channels: 3, background: '#7a8a6a' }, limitInputPixels: false }).composite(comps);
  const full = await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  // gentle grading: lift shadows, a touch of saturation for a bright, airy look
  await sharp(full, { limitInputPixels: false }).modulate({ saturation: 1.12, brightness: 1.04 }).gamma(1.08)
    .jpeg({ quality: 86, mozjpeg: true, progressive: true }).toFile(path.join(dir, 'sat.jpg'));
  await sharp(full, { limitInputPixels: false }).resize(1024).modulate({ saturation: 1.12, brightness: 1.04 }).gamma(1.08)
    .jpeg({ quality: 80 }).toFile(path.join(dir, 'sat_1k.jpg'));
  log(A, `${r.id}: ${size}px z${z} (${comps.length} tiles, ${fails} failed)`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
await pool(list, 3, (r) => build(r).catch((e) => log(A, `${r.id} FAILED ${e.message}`)));
log(A, 'done');
