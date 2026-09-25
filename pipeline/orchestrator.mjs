// BARIMO build orchestrator — launches 6 agents.
// Stage 1: research · terrain · imagery · photos · climate run IN PARALLEL (5 processes)
// Stage 2: assembler/QA consumes their artifacts. Optional: auto-commit after each agent.
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, log } from './lib/common.mjs';
import { probe, MODEL } from './lib/llm.mjs';

const AUTO_COMMIT = !process.argv.includes('--no-commit');
const only = process.argv.find((a) => a.startsWith('--region='))?.split('=')[1];
const run = (name) => new Promise((res) => {
  const t = Date.now();
  const p = spawn(process.execPath, [path.join(ROOT, 'pipeline/agents', name + '.mjs'), ...(only ? [only] : [])], { cwd: ROOT, stdio: 'inherit', env: process.env });
  p.on('exit', (code) => {
    log('orchestrator', `agent ${name} exited ${code} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    if (AUTO_COMMIT) commit(`chore(pipeline): ${name} agent artifacts`);
    res(code);
  });
});
let lock = Promise.resolve();
function commit(msg) {
  lock = lock.then(() => { try { execSync(`git add -A public pipeline/out && git commit -qm "${msg}"`, { cwd: ROOT, stdio: 'ignore' }); } catch {} });
  return lock;
}

const llm = await probe();
log('orchestrator', `LLM (${MODEL}) status: ${llm.ok ? 'ONLINE' : 'UNAVAILABLE'} — ${llm.reason.slice(0, 100)}`);
log('orchestrator', 'Stage 1: launching 5 agents in parallel');
const codes = await Promise.all(['research', 'terrain', 'imagery', 'photos', 'climate'].map(run));
log('orchestrator', 'Stage 2: assembler / QA');
const qa = await run('assembler');
await lock;
log('orchestrator', `pipeline finished — stage1 ${JSON.stringify(codes)} qa ${qa}`);
if (AUTO_COMMIT) { try { execSync('git push -q', { cwd: ROOT, stdio: 'ignore' }); log('orchestrator', 'pushed'); } catch {} }
