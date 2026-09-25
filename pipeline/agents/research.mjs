// AGENT 1 — RESEARCH: verifies & enriches the curated dataset.
//  • geocodes every POI via OSM Nominatim and snaps coordinates when the curated value drifts
//  • pulls Wikipedia (en) extracts & coordinates as fact-check context
//  • if the LLM proxy is available, asks the model to audit ratings/overview for each region in parallel
import path from 'node:path';
import { regions, fetchJSON, log, OUT, writeJSON, sleep, pool } from '../lib/common.mjs';
import { probe, askJSON } from '../lib/llm.mjs';
const A = 'research';

const haversine = (a, b) => {
  const R = 6371, t = (d) => (d * Math.PI) / 180;
  const dLa = t(b[0] - a[0]), dLo = t(b[1] - a[1]);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(dLo / 2) ** 2));
};

const list = regions();
const llm = await probe();
log(A, `LLM proxy: ${llm.ok ? 'ONLINE' : 'OFFLINE → deterministic mode'} (${llm.reason.slice(0, 90)})`);

const report = {};
for (const r of list) {
  const rep = { pois: [], wiki: null, llm: null };
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

if (llm.ok) {
  await pool(list, 6, async (r) => {
    try {
      report[r.id].llm = await askJSON(
        'You are a meticulous travel-safety analyst. Return JSON {"issues":[string],"suggestedRatings":{crime,danger,access,physical}} on a 1-5 scale (5 = worst/hardest).',
        JSON.stringify({ region: r.nameLocal, country: r.country, ratings: r.ratings, notes: r.ratingNotes, context: report[r.id].wiki?.extract })
      );
      log(A, `${r.id}: LLM audit OK (${report[r.id].llm.issues?.length || 0} issues)`);
    } catch (e) { log(A, `${r.id}: LLM audit failed ${e.message.slice(0, 80)}`); }
  });
}
writeJSON(path.join(OUT, 'research-report.json'), { llm, generatedAt: new Date().toISOString(), report });
log(A, 'done');
