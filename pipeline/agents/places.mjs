// AGENT 7 — PLACES: pulls real named places inside the 5x explorable extent from OpenStreetMap (Overpass):
// peaks (with elevation), villages/towns, lakes, waterfalls, passes. Used as terrain map labels and first-person
// navigation targets. Deterministic ranking keeps dense areas readable (per-kind caps + spatial thinning).
import path from 'node:path';
import { regions, extentWindow, log, regionDir, writeJSON, sleep, UA } from '../lib/common.mjs';
const A = 'places';
const EP = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const CAP = { peak: 16, village: 14, town: 4, lake: 8, waterfall: 5, pass: 5 };

async function overpass(q) {
  let err;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(EP[i % EP.length], { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { err = e; await sleep(4000 * (i + 1)); }
  }
  throw err;
}
const pickName = (t) => t['name:ja'] || t['name:en'] || t['int_name'] || t.name;

async function build(r) {
  const b = extentWindow(r).bbox;
  const bb = `(${b.south},${b.west},${b.north},${b.east})`;
  const q = `[out:json][timeout:80];(
    node["natural"="peak"]["name"]${bb}; node["natural"="volcano"]["name"]${bb};
    node["place"~"^(village|town|hamlet)$"]["name"]${bb};
    node["waterway"="waterfall"]["name"]${bb}; node["mountain_pass"="yes"]["name"]${bb};
    way["natural"="water"]["name"]${bb}; relation["natural"="water"]["name"]${bb};
  );out center tags;`;
  const d = await overpass(q);
  const all = [];
  for (const e of d.elements || []) {
    const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    let kind = null, rank = 0;
    if (t.natural === 'peak' || t.natural === 'volcano') { kind = 'peak'; rank = (+t.ele || 0) + (t.wikidata ? 800 : 0); }
    else if (t.place === 'town') { kind = 'town'; rank = 2000 + (+t.population || 0) / 10; }
    else if (t.place === 'village' || t.place === 'hamlet') { kind = 'village'; rank = (t.place === 'village' ? 1000 : 0) + (t.wikidata ? 600 : 0) + (+t.population || 0) / 10; }
    else if (t.waterway === 'waterfall') { kind = 'waterfall'; rank = t.wikidata ? 900 : 100; }
    else if (t.mountain_pass === 'yes') { kind = 'pass'; rank = +t.ele || 0; }
    else if (t.natural === 'water') { if (/reservoir|river|canal|pond|wastewater|basin/.test(t.water || '')) continue; kind = 'lake'; rank = (t.wikidata ? 1000 : 0) + (e.type === 'relation' ? 500 : 0); }
    if (!kind) continue;
    const name = pickName(t); if (!name || name.length > 28) continue;
    const ele = t.ele && Number.isFinite(+t.ele) ? Math.round(+t.ele) : null;
    all.push({ kind, name, local: t.name && t.name !== name ? t.name : '', ll: [+lat.toFixed(5), +lon.toFixed(5)], ele, rank });
  }
  all.sort((a, c) => c.rank - a.rank);
  const seen = new Set(), keep = [], count = {};
  const minD = 0.03 * Math.max(b.east - b.west, b.north - b.south);
  for (const p of all) {
    if (seen.has(p.name) || (count[p.kind] || 0) >= CAP[p.kind]) continue;
    if (keep.some((k) => Math.hypot(k.ll[0] - p.ll[0], k.ll[1] - p.ll[1]) < minD)) continue;
    seen.add(p.name); count[p.kind] = (count[p.kind] || 0) + 1;
    delete p.rank; keep.push(p);
  }
  writeJSON(path.join(regionDir(r.id), 'places.json'), keep);
  log(A, `${r.id}: ${keep.length} places (${Object.entries(count).map(([k, v]) => k + ' ' + v).join(', ')}) from ${all.length}`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
for (const r of list) { await build(r).catch((e) => { log(A, `${r.id} FAILED ${e.message}`); process.exitCode = 1; }); await sleep(2500); }
log(A, 'done');
