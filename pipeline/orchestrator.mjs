// BARIMO build orchestrator v2 — dependency-driven scheduler for the agent pipeline.
//
//   lane 1  research ──► places          (OSM services, polite rate limits → sequential)
//   lane 2  terrain                      (AWS DEM)
//   lane 3  imagery ──► photos           (libvips-heavy → serialised to fit a 1 GB sandbox)
//   lane 4  climate                      (Open-Meteo ERA5)
//   lane 5  review  (6-agent LLM swarm, waits for research+climate+photos+places)
//   lane 6  assembler / QA (waits for everything)
//
// Each agent runs as its own OS process. Every finished agent is committed immediately (work is never lost if the
// sandbox resets) and a machine-readable run report is written to pipeline/out/run-report.json.
//
//   node pipeline/orchestrator.mjs [--region=id] [--only=agent,agent] [--skip=agent] [--no-commit] [--no-push] [--offline]
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, OUT, log, writeJSON } from './lib/common.mjs';
import { probe, MODEL } from './lib/llm.mjs';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = (k) => process.argv.includes(`--${k}`);
const AUTO_COMMIT = !flag('no-commit'), PUSH = AUTO_COMMIT && !flag('no-push');
const region = arg('region');
const onlySet = arg('only')?.split(',');
const skipSet = new Set(arg('skip')?.split(',') || []);
if (flag('offline')) process.env.BARIMO_OFFLINE = '1';

const DAG = {
  research: [], places: ['research'], terrain: [], imagery: [], photos: ['imagery'], climate: [],
  review: ['research', 'climate', 'photos', 'places'],
  assembler: ['research', 'places', 'terrain', 'imagery', 'photos', 'climate', 'review'],
};
const enabled = (a) => (!onlySet || onlySet.includes(a)) && !skipSet.has(a);
const report = { startedAt: new Date().toISOString(), region: region || 'all', agents: {} };

let lock = Promise.resolve();
function commit(msg) {
  if (!AUTO_COMMIT) return lock;
  lock = lock.then(() => { try { execSync(`git add -A public pipeline/out && git commit -qm "${msg}"`, { cwd: ROOT, stdio: 'ignore' }); } catch { /* nothing to commit */ } });
  return lock;
}

function run(name) {
  return new Promise((res) => {
    const t = Date.now();
    report.agents[name] = { status: 'running', startedAt: new Date().toISOString() };
    const p = spawn(process.execPath, [path.join(ROOT, 'pipeline/agents', name + '.mjs'), ...(region ? [region] : [])], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '2' },
    });
    p.on('exit', async (code) => {
      const s = (Date.now() - t) / 1000;
      report.agents[name] = { ...report.agents[name], status: code === 0 ? 'ok' : 'failed', code, seconds: +s.toFixed(1) };
      log('orchestrator', `agent ${name} exited ${code} in ${s.toFixed(1)}s`);
      writeJSON(path.join(OUT, 'run-report.json'), report);
      await commit(`chore(pipeline): ${name} agent artifacts${region ? ` (${region})` : ''}`);
      res(code);
    });
  });
}

// ---- scheduler: start every agent as soon as its dependencies have settled
const llm = flag('offline') ? { ok: false, reason: 'offline flag' } : await probe();
report.llm = { model: MODEL, ...llm };
log('orchestrator', `LLM (${MODEL}) ${llm.ok ? 'ONLINE → review swarm uses 6 parallel AI agents' : 'UNAVAILABLE → swarm runs deterministic reviewers'} — ${llm.reason.slice(0, 100)}`);
const done = {};
const start = (a) => (done[a] ??= (async () => {
  await Promise.all(DAG[a].map((d) => start(d)));
  if (!enabled(a)) { report.agents[a] = { status: 'skipped' }; return 0; }
  return run(a);
})());
const t0 = Date.now();
const lanes = Object.keys(DAG).filter(enabled);
log('orchestrator', `scheduling ${lanes.length} agents: ${lanes.join(', ')}`);
await Promise.all(Object.keys(DAG).map(start));
await lock;
report.finishedAt = new Date().toISOString(); report.seconds = +((Date.now() - t0) / 1000).toFixed(1);
report.ok = Object.values(report.agents).every((x) => x.status !== 'failed');
writeJSON(path.join(OUT, 'run-report.json'), report);
await commit('chore(pipeline): run report');
log('orchestrator', `pipeline finished in ${report.seconds}s — ${report.ok ? 'OK' : 'WITH FAILURES'}`);
if (PUSH) { try { execSync('git push -q', { cwd: ROOT, stdio: 'ignore' }); log('orchestrator', 'pushed'); } catch { log('orchestrator', 'push failed'); } }
process.exitCode = report.ok ? 0 : 1;
