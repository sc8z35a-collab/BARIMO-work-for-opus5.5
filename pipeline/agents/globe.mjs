// (part of AGENT 3 — IMAGERY) builds an equirectangular 4096x2048 globe texture from Esri z4 mercator tiles
import sharp from 'sharp';
import path from 'node:path';
import { fetchBuf, pool, log, PUB, ensure } from '../lib/common.mjs';
const Z = 4, N = 2 ** Z, T = 256, M = N * T;
const jobs = []; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) jobs.push({ x, y });
const comps = await pool(jobs, 12, async ({ x, y }) => ({ input: await fetchBuf(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${y}/${x}`), left: x * T, top: y * T }));
const merc = await sharp({ create: { width: M, height: M, channels: 3, background: '#1d4f7a' }, limitInputPixels: false }).composite(comps).removeAlpha().raw().toBuffer();
const W = 4096, H = 2048, out = Buffer.alloc(W * H * 3);
for (let j = 0; j < H; j++) {
  const lat = 90 - ((j + 0.5) / H) * 180;
  const cl = Math.max(-85.05, Math.min(85.05, lat));
  const my = ((1 - Math.log(Math.tan(Math.PI / 4 + (cl * Math.PI) / 360)) / Math.PI) / 2) * M;
  const sy = Math.min(M - 1, Math.max(0, Math.floor(my)));
  const polar = Math.abs(lat) > 84 ? Math.min(1, (Math.abs(lat) - 84) / 4) : 0;
  for (let i = 0; i < W; i++) {
    const sx = Math.min(M - 1, Math.floor(((i + 0.5) / W) * M));
    const s = (sy * M + sx) * 3, d = (j * W + i) * 3;
    for (let c = 0; c < 3; c++) out[d + c] = merc[s + c] * (1 - polar) + 236 * polar;
  }
}
ensure(path.join(PUB, 'textures'));
await sharp(out, { raw: { width: W, height: H, channels: 3 } }).modulate({ saturation: 1.15, brightness: 1.12 }).gamma(1.15)
  .jpeg({ quality: 86, mozjpeg: true }).toFile(path.join(PUB, 'textures/globe.jpg'));
log('imagery', 'globe texture 4096x2048 done');
