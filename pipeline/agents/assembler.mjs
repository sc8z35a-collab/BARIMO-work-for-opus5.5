// AGENT 6 — ASSEMBLER / QA: validates every artifact, derives scores, emits public/data/regions.json
import fs from 'node:fs';
import path from 'node:path';
import { regions, log, PUB, OUT, readJSON, writeJSON } from '../lib/common.mjs';
const A = 'assembler';

const research = readJSON(path.join(OUT, 'research-report.json'), { report: {} });
const out = [], qa = [];
for (const r of regions()) {
  const dir = path.join(PUB, 'regions', r.id);
  const terrain = readJSON(path.join(dir, 'terrain.json'));
  const photos = readJSON(path.join(dir, 'photos.json'), []);
  const climate = readJSON(path.join(dir, 'climate.json'));
  const hasSat = fs.existsSync(path.join(dir, 'sat.jpg'));
  const issues = [];
  if (!terrain) issues.push('terrain missing');
  if (!hasSat) issues.push('satellite missing');
  if (photos.length < 4) issues.push(`only ${photos.length} photos`);
  if (!climate) issues.push('climate missing');
  qa.push({ id: r.id, ok: issues.length === 0, issues });
  if (!terrain || !hasSat) { log(A, `${r.id}: SKIPPED (${issues.join(', ')})`); continue; }

  // snap POIs to verified geocodes when research agent confirmed them
  const rp = research.report?.[r.id]?.pois || [];
  const pois = r.pois.map((p) => {
    const v = rp.find((x) => x.name === p.name && x.status === 'verified');
    const ll = v ? v.geocoded : p.ll;
    const { bbox } = terrain;
    // local UV in [0,1] within the tile window (mercator-y)
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const u = (ll[1] - bbox.west) / (bbox.east - bbox.west);
    const vv = (merc(bbox.north) - merc(ll[0])) / (merc(bbox.north) - merc(bbox.south));
    return { name: p.name, desc: p.desc, ll, uv: [+u.toFixed(4), +vv.toFixed(4)] };
  }).filter((p) => p.uv[0] > 0.02 && p.uv[0] < 0.98 && p.uv[1] > 0.02 && p.uv[1] < 0.98);

  const R = r.ratings;
  // "Hidden-gem index": scenery × remoteness, and an overall ease-of-trip score
  const gem = Math.round(((R.scenery + R.remoteness) / 10) * 100);
  const ease = Math.round(((5 - R.crime) + (5 - R.danger) + (5 - R.access) + (5 - R.physical)) / 16 * 100);
  out.push({
    ...r, pois, gem, ease,
    terrain: { minElev: terrain.minElev, maxElev: terrain.maxElev, widthM: Math.round(terrain.widthM), bbox: terrain.bbox },
    climate, photos,
    assets: { height: `regions/${r.id}/height.png`, sat: `regions/${r.id}/sat.jpg`, sat1k: `regions/${r.id}/sat_1k.jpg` },
  });
  log(A, `${r.id}: ✔ ${photos.length} photos, ${pois.length} POIs, gem ${gem}, ease ${ease}${issues.length ? '  ⚠ ' + issues.join(', ') : ''}`);
}
writeJSON(path.join(PUB, 'data/regions.json'), out);
writeJSON(path.join(OUT, 'qa-report.json'), { generatedAt: new Date().toISOString(), regions: out.length, qa });
log(A, `emitted ${out.length} regions → public/data/regions.json`);
if (out.length < 10) { log(A, 'QA FAIL: fewer than 10 regions'); process.exitCode = 1; }
