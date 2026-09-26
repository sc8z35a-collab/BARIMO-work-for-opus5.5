// AGENT 5 — CLIMATE: builds a monthly climate profile (temp/precip/sun) from Open-Meteo ERA5 archive
import path from 'node:path';
import { regions, fetchJSON, log, regionDir, writeJSON, pool, sleep } from '../lib/common.mjs';
const A = 'climate';

async function build(r) {
  const [lat, lon] = r.center;
  const u = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=2021-01-01&end_date=2024-12-31&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration&timezone=auto`;
  const d = await fetchJSON(u, { timeout: 90000 });
  const m = Array.from({ length: 12 }, () => ({ tmax: 0, tmin: 0, rain: 0, sun: 0, n: 0 }));
  d.daily.time.forEach((t, i) => {
    const k = +t.slice(5, 7) - 1, o = m[k];
    o.tmax += d.daily.temperature_2m_max[i] ?? 0; o.tmin += d.daily.temperature_2m_min[i] ?? 0;
    o.rain += d.daily.precipitation_sum[i] ?? 0; o.sun += (d.daily.sunshine_duration[i] ?? 0) / 3600; o.n++;
  });
  const years = 4;
  const months = m.map((o) => ({
    tmax: +(o.tmax / o.n).toFixed(1), tmin: +(o.tmin / o.n).toFixed(1),
    rain: Math.round(o.rain / years), sun: +(o.sun / o.n).toFixed(1),
  }));
  writeJSON(path.join(regionDir(r.id), 'climate.json'), { elevation: d.elevation, months });
  log(A, `${r.id}: elev ${d.elevation} m, Jul ${months[6].tmax}°/${months[6].tmin}°`);
}
await pool(regions().filter((r) => !process.argv[2] || r.id === process.argv[2]), 2, async (r) => {
  for (let t = 0; t < 3; t++) { try { await build(r); return; } catch (e) { log(A, `${r.id} retry ${t} ${e.message}`); await sleep(3000); } }
});
log(A, 'done');
