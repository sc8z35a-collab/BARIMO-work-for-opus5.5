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
  const places = readJSON(path.join(dir, 'places.json'), []);
  const hasSat = fs.existsSync(path.join(dir, 'overview.jpg')) && fs.existsSync(path.join(dir, 'dem.png'));
  const issues = [];
  if (!terrain) issues.push('terrain missing');
  if (!hasSat) issues.push('satellite missing');
  if (photos.length < 4) issues.push(`only ${photos.length} photos`);
  if (!climate) issues.push('climate missing');
  if (places.length < 5) issues.push(`only ${places.length} OSM places`);
  if (terrain && terrain.n !== 5) issues.push('terrain.json is v1.0 (not 5x extent) — rerun terrain agent');
  qa.push({ id: r.id, ok: issues.length === 0, issues });
  if (!terrain || !hasSat) { log(A, `${r.id}: SKIPPED (${issues.join(', ')})`); continue; }

  // snap POIs to verified geocodes when research agent confirmed them
  const rp = research.report?.[r.id]?.pois || [];
  const { bbox } = terrain || {};
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  // local UV in [0,1] within the explorable window (mercator-y, v grows southwards)
  const toUV = (ll) => [+((ll[1] - bbox.west) / (bbox.east - bbox.west)).toFixed(5), +((merc(bbox.north) - merc(ll[0])) / (merc(bbox.north) - merc(bbox.south))).toFixed(5)];
  const inside = (uv) => uv[0] > 0.01 && uv[0] < 0.99 && uv[1] > 0.01 && uv[1] < 0.99;
  const pois = !terrain ? [] : r.pois.map((p) => {
    const v = rp.find((x) => x.name === p.name && x.status === 'verified');
    const ll = v ? v.geocoded : p.ll;
    return { name: p.name, desc: p.desc, ll, uv: toUV(ll) };
  }).filter((p) => inside(p.uv));
  if (terrain && pois.length < r.pois.length) issues.push(`${r.pois.length - pois.length} POIs outside extent`);
  // OSM places minus those duplicating a curated POI (same name or < 1.5% of extent away)
  const placesUV = !terrain ? [] : places.map((p) => ({ ...p, uv: toUV(p.ll) })).filter((p) => inside(p.uv)
    && !pois.some((q) => q.name === p.name || Math.hypot(q.uv[0] - p.uv[0], q.uv[1] - p.uv[1]) < 0.015));

  const R = r.ratings;
  // "Hidden-gem index": scenery × remoteness, and an overall ease-of-trip score
  const gem = Math.round(((R.scenery + R.remoteness) / 10) * 100);
  const ease = Math.round(((5 - R.crime) + (5 - R.danger) + (5 - R.access) + (5 - R.physical)) / 16 * 100);
  out.push({
    ...r, pois, gem, ease,
    places: placesUV,
    terrain: { minElev: terrain.minElev, maxElev: terrain.maxElev, widthM: Math.round(terrain.widthM), bbox: terrain.bbox, z: terrain.z, x0: terrain.x0, y0: terrain.y0, n: terrain.n, world: terrain.world, demSize: terrain.size },
    climate, photos,
    assets: { dem: `regions/${r.id}/dem.png`, overview: `regions/${r.id}/overview.jpg`, overviewSmall: `regions/${r.id}/overview_s.jpg` },
  });
  log(A, `${r.id}: ✔ ${photos.length} photos, ${pois.length} POIs, ${placesUV.length} places, gem ${gem}, ease ${ease}${issues.length ? '  ⚠ ' + issues.join(', ') : ''}`);
}
writeJSON(path.join(PUB, 'data/regions.json'), out);
writeJSON(path.join(OUT, 'qa-report.json'), { generatedAt: new Date().toISOString(), regions: out.length, qa });
log(A, `emitted ${out.length} regions → public/data/regions.json`);
if (out.length < 10) { log(A, 'QA FAIL: fewer than 10 regions'); process.exitCode = 1; }
