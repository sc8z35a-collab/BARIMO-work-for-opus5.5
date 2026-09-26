// AGENT — REVIEW (LLM swarm): runs the 6 parallel AI reviewer agents (see lib/swarm.mjs) over every region,
// using the artifacts produced by research / climate / photos / places as context.
// Output: pipeline/out/swarm-report.json (advisory; the assembler applies only validated suggestions).
import path from 'node:path';
import { regions, log, OUT, PUB, readJSON, writeJSON } from '../lib/common.mjs';
import { runSwarm } from '../lib/swarm.mjs';
const A = 'review';

const only = process.argv[2];
const research = readJSON(path.join(OUT, 'research-report.json'), { report: {} });
const contexts = regions().filter((r) => !only || r.id === only).map((r) => {
  const dir = path.join(PUB, 'regions', r.id);
  return {
    r,
    wiki: research.report?.[r.id]?.wiki,
    pois: research.report?.[r.id]?.pois,
    climate: readJSON(path.join(dir, 'climate.json')),
    photos: readJSON(path.join(dir, 'photos.json'), []).length,
    places: readJSON(path.join(dir, 'places.json'), []).length,
  };
});
const t = Date.now();
const rep = await runSwarm(contexts, { log: (m) => log(A, m), forceOffline: process.env.BARIMO_OFFLINE === '1' });
const prev = only ? readJSON(path.join(OUT, 'swarm-report.json'), { result: {} }).result : {};
writeJSON(path.join(OUT, 'swarm-report.json'), { generatedAt: new Date().toISOString(), ms: Date.now() - t, ...rep, result: { ...prev, ...rep.result } });
const scores = Object.entries(rep.result).map(([id, x]) => `${id}:${x['qa-critic']?.score}`).join(' ');
log(A, `done in ${((Date.now() - t) / 1000).toFixed(1)}s · mode=${rep.mode} · QA scores ${scores}`);
