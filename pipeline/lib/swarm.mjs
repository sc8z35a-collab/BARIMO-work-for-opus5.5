// LLM SWARM — 6 specialised AI agents that run fully in parallel over the curated dataset.
//
//   1 fact-checker     : cross-checks overview/highlights against the Wikipedia extract
//   2 safety-analyst   : audits crime/danger/access/physical ratings (1-5)
//   3 copy-editor      : polishes Japanese tagline/overview (natural, concise, no history)
//   4 geo-verifier     : judges POI drift reported by the research agent (keep curated vs snap)
//   5 season-advisor   : checks bestMonths against the measured ERA5 climate
//   6 qa-critic        : reviews the whole region record and scores it 0-100
//
// Each role has a deterministic fallback so the build never depends on the LLM proxy being reachable.
// Output of every role is *advisory* (written to pipeline/out/swarm-report.json); the assembler only applies
// suggestions that pass strict validation (e.g. ratings within ±1 of the curated value).
import { probe, askJSON, MODEL } from './llm.mjs';

export const ROLES = ['fact-checker', 'safety-analyst', 'copy-editor', 'geo-verifier', 'season-advisor', 'qa-critic'];

const SYS = {
  'fact-checker': 'You are a meticulous travel fact-checker. Compare the Japanese overview/highlights with the English reference extract. Return JSON {"ok":bool,"issues":[string]} (issues in Japanese, max 3).',
  'safety-analyst': 'You are a travel-safety analyst. Return JSON {"suggestedRatings":{"crime":n,"danger":n,"access":n,"physical":n},"issues":[string]} on a 1-5 scale (5 = worst/hardest). Only deviate from the given ratings with clear reason.',
  'copy-editor': 'You are a Japanese travel copy editor. Improve naturalness without adding historical content. Return JSON {"tagline":string,"overview":string,"changed":bool}. Keep tagline <= 28 chars and overview <= 180 chars.',
  'geo-verifier': 'You are a GIS analyst. For each POI with geocode drift, decide whether the curated coordinate or the geocoder is more plausible. Return JSON {"decisions":[{"name":string,"use":"curated"|"geocoded","why":string}]}.',
  'season-advisor': 'You are a climate-aware trip planner. Given monthly tmax/tmin/rain/sun and the proposed best months, return JSON {"bestMonths":[int],"issues":[string]}.',
  'qa-critic': 'You are a demanding product QA lead for a travel app. Score the region record 0-100 for completeness, clarity and accuracy. Return JSON {"score":int,"issues":[string]}.',
};

// ---------------------------------------------------------------- deterministic fallbacks
const clampR = (v) => Math.max(1, Math.min(5, Math.round(v)));
const FALLBACK = {
  'fact-checker': ({ r, wiki }) => {
    const issues = [];
    if (!wiki?.extract) issues.push('参照用のWikipedia抜粋が取得できませんでした');
    if ((r.overview || '').length < 60) issues.push('概要が短すぎます');
    if ((r.highlights || []).length < 3) issues.push('「ここがすごい」が3項目未満です');
    return { ok: issues.length === 0, issues };
  },
  'safety-analyst': ({ r }) => {
    const R = r.ratings, issues = [];
    // heuristic consistency: remote places are rarely easy to reach
    if (R.remoteness >= 4 && R.access <= 2) issues.push('秘境度が高いのにアクセスが容易すぎる評価です');
    if (R.physical >= 4 && R.danger <= 1) issues.push('体力難度が高いのに自然の危険が最低評価です');
    return { suggestedRatings: { crime: R.crime, danger: clampR(R.danger), access: clampR(R.access), physical: clampR(R.physical) }, issues };
  },
  'copy-editor': ({ r }) => {
    const tidy = (s) => (s || '').replace(/\s+/g, ' ').replace(/。。/g, '。').trim();
    const tagline = tidy(r.tagline), overview = tidy(r.overview);
    return { tagline, overview, changed: tagline !== r.tagline || overview !== r.overview };
  },
  'geo-verifier': ({ pois }) => ({
    decisions: (pois || []).filter((p) => p.driftKm != null).map((p) => ({ name: p.name, use: p.driftKm < 8 ? 'geocoded' : 'curated', why: `drift ${p.driftKm} km ${p.driftKm < 8 ? '< 8 km threshold' : '≥ 8 km: geocoder likely matched a namesake'}` })),
  }),
  'season-advisor': ({ r, climate }) => {
    if (!climate?.months) return { bestMonths: r.bestMonths, issues: ['気候データなし'] };
    const score = climate.months.map((m) => (m.tmax >= 12 && m.tmax <= 29 ? 2 : m.tmax > 6 ? 1 : 0) + (m.rain < 90 ? 1 : 0) + (m.sun > 6 ? 1 : 0));
    const issues = [];
    for (const k of r.bestMonths) if (score[k - 1] <= 1) issues.push(`${k}月は実測気候（最高${climate.months[k - 1].tmax}°C・降水${climate.months[k - 1].rain}mm）ではベストとは言いにくい`);
    return { bestMonths: r.bestMonths, issues };
  },
  'qa-critic': ({ r, photos, places }) => {
    let s = 100; const issues = [];
    if ((photos || 0) < 8) { s -= 15; issues.push(`写真が${photos}枚しかありません`); }
    if ((places || 0) < 10) { s -= 10; issues.push(`地名ラベルが${places}件しかありません`); }
    if ((r.pois || []).length < 4) { s -= 10; issues.push('見どころが4件未満'); }
    if (!r.access || !r.stay || !r.tips) { s -= 15; issues.push('旅の情報が不足'); }
    return { score: Math.max(0, s), issues };
  },
};

function payload(role, ctx) {
  const { r, wiki, pois, climate } = ctx;
  switch (role) {
    case 'fact-checker': return { name: r.nameLocal, overview: r.overview, highlights: r.highlights, reference: wiki?.extract || '' };
    case 'safety-analyst': return { region: r.nameLocal, country: r.country, ratings: r.ratings, notes: r.ratingNotes, context: wiki?.extract || '' };
    case 'copy-editor': return { tagline: r.tagline, overview: r.overview };
    case 'geo-verifier': return { region: r.nameLocal, pois: (pois || []).filter((p) => p.driftKm != null) };
    case 'season-advisor': return { region: r.nameLocal, bestMonths: r.bestMonths, months: climate?.months };
    case 'qa-critic': return { ...r, photoQueries: undefined };
  }
}

/** validate/clean an LLM answer; anything malformed falls back to the deterministic result */
function validate(role, out, ctx) {
  const fb = FALLBACK[role](ctx);
  if (!out || typeof out !== 'object') return null;
  if (role === 'safety-analyst') {
    const s = out.suggestedRatings || {}, R = ctx.r.ratings, ok = {};
    for (const k of ['crime', 'danger', 'access', 'physical']) ok[k] = Number.isFinite(+s[k]) && Math.abs(+s[k] - R[k]) <= 1 ? clampR(+s[k]) : R[k];
    return { suggestedRatings: ok, issues: (out.issues || []).slice(0, 5).map(String) };
  }
  if (role === 'copy-editor') {
    const tg = String(out.tagline || ''), ov = String(out.overview || '');
    if (!tg || tg.length > 36 || ov.length < 40 || ov.length > 260) return fb;
    return { tagline: tg, overview: ov, changed: tg !== ctx.r.tagline || ov !== ctx.r.overview };
  }
  if (role === 'season-advisor') {
    const bm = (out.bestMonths || []).map(Number).filter((m) => m >= 1 && m <= 12);
    return { bestMonths: bm.length >= 2 ? [...new Set(bm)].sort((a, b) => a - b) : ctx.r.bestMonths, issues: (out.issues || []).slice(0, 4).map(String) };
  }
  if (role === 'qa-critic') return { score: Math.max(0, Math.min(100, Math.round(+out.score || 0))), issues: (out.issues || []).slice(0, 6).map(String) };
  return out;
}

/**
 * Run the 6-agent swarm over all region contexts. Roles run as 6 concurrent workers; each worker pulls
 * regions from its own queue, so at any moment up to 6 LLM requests are in flight.
 * @param contexts [{ r, wiki, pois, climate, photos, places }]
 */
export async function runSwarm(contexts, { log = console.log, concurrency = 6, forceOffline = false } = {}) {
  const status = forceOffline ? { ok: false, reason: 'forced offline' } : await probeWithRetry(log);
  const mode = status.ok ? 'llm' : 'deterministic';
  log(`swarm: ${ROLES.length} agents · mode=${mode} · model=${MODEL} · ${status.reason.slice(0, 90)}`);
  const result = {}; const stats = Object.fromEntries(ROLES.map((k) => [k, { llm: 0, fallback: 0, failed: 0, ms: 0 }]));
  for (const c of contexts) result[c.r.id] = {};
  let llmAlive = status.ok;
  await Promise.all(ROLES.slice(0, concurrency).map(async (role) => {
    for (const ctx of contexts) {
      const t = Date.now(); let out = null, source = 'fallback';
      if (llmAlive) {
        try { out = validate(role, await askJSON(SYS[role], JSON.stringify(payload(role, ctx))), ctx); if (out) { stats[role].llm++; source = 'llm'; } }
        catch (e) { stats[role].failed++; if (/LLM_BLOCKED|401|403/.test(e.message)) { llmAlive = false; log(`swarm: LLM went offline (${e.message.slice(0, 60)}) → deterministic`); } }
      }
      if (!out) { out = FALLBACK[role](ctx); stats[role].fallback++; }
      stats[role].ms += Date.now() - t;
      result[ctx.r.id][role] = { ...out, source };
    }
    log(`swarm: agent ${role} finished (${stats[role].llm} llm / ${stats[role].fallback} fallback)`);
  }));
  return { mode, model: MODEL, probe: status, stats, result };
}

async function probeWithRetry(log) {
  let s;
  for (let i = 0; i < 2; i++) {
    s = await probe();
    if (s.ok || /free-plan|credits/i.test(s.reason)) return s; // account-level block: retrying won't help
    log(`swarm: probe attempt ${i + 1} failed (${s.reason.slice(0, 60)}), retrying`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return s;
}
