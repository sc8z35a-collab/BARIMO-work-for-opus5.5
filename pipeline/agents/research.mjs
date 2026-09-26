// AGENT 1 — RESEARCH: verifies & enriches the curated dataset.
//  • geocodes every POI via OSM Nominatim and snaps coordinates when the curated value drifts
//  • pulls Wikipedia (en) extracts & coordinates as fact-check context
//  (LLM auditing moved to the dedicated 6-agent review swarm — agents/review.mjs)
import path from 'node:path';
import { regions, fetchJSON, log, OUT, writeJSON, sleep, readJSON } from '../lib/common.mjs';
const A = 'research';

const haversine = (a, b) => {
  const R = 6371, t = (d) => (d * Math.PI) / 180;
  const dLa = t(b[0] - a[0]), dLo = t(b[1] - a[1]);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(dLo / 2) ** 2));
};

const only = process.argv[2];
const list = regions().filter((r) => !only || r.id === only);
const report = only ? readJSON(path.join(OUT, 'research-report.json'), { report: {} }).report : {};
for (const r of list) {
  const rep = { pois: [], wiki: null };
  for (const p of r.pois) {
    if (!p.q) { rep.pois.push({ name: p.name, status: 'manual' }); continue; }
    try {
      const d = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(p.q)}`);
      if (d[0]) {
        const g = [+d[0].lat, +d[0].lon], km = haversine(g, p.ll);
        rep.pois.push({ name: p.name, geocoded: g, driftKm: +km.toFixed(2), status: km < 8 ? 'verified' : 'kept-curated' });
      } else rep.pois.push({ name: p.name, status: 'not-found' });
    } catch (e) { rep.pois.push({ name: p.name, status: 'error ' + e.message }); }
    await sleep(1100); // Nominatim policy: ≤1 req/s
  }
  try {
    const d = await fetchJSON(`https://en.wikipedia.org/w/api.php?format=json&action=query&prop=extracts|coordinates&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(r.photoQueries[0])}`);
    const pg = Object.values(d.query.pages)[0];
    rep.wiki = { title: pg.title, extract: (pg.extract || '').slice(0, 600), coords: pg.coordinates?.[0] || null };
  } catch {}
  report[r.id] = rep;
  log(A, `${r.id}: ${rep.pois.filter((x) => x.status === 'verified').length}/${r.pois.length} POIs verified, wiki=${rep.wiki?.title || '-'}`);
}

writeJSON(path.join(OUT, 'research-report.json'), { generatedAt: new Date().toISOString(), report });
log(A, 'done');
