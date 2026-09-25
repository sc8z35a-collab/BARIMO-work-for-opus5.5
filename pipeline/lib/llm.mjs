// LLM client shared by agents. Uses the OpenAI-compatible Genspark proxy.
// Detects account-level blocks (e.g. free-plan) and degrades gracefully.
import OpenAI from 'openai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';

let cfg = {};
try { cfg = yaml.load(fs.readFileSync(path.join(os.homedir(), '.genspark_llm.yaml'), 'utf8')) || {}; } catch {}
const client = new OpenAI({
  apiKey: cfg?.openai?.api_key || process.env.OPENAI_API_KEY || 'missing',
  baseURL: cfg?.openai?.base_url || process.env.OPENAI_BASE_URL,
});
export const MODEL = process.env.BARIMO_MODEL || 'gpt-5-mini';
const BLOCK_PATTERNS = [/free-plan/i, /credits? can'?t be used/i, /purchase credits/i, /insufficient/i];

export async function probe() {
  try {
    const r = await client.chat.completions.create({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: READY' }] });
    const txt = r.choices?.[0]?.message?.content || '';
    if (BLOCK_PATTERNS.some((p) => p.test(txt))) return { ok: false, reason: txt.slice(0, 200) };
    return { ok: /READY/i.test(txt), reason: txt.slice(0, 80) };
  } catch (e) { return { ok: false, reason: `${e.status || ''} ${e.message}`.slice(0, 200) }; }
}

export async function askJSON(system, user, { model = MODEL } = {}) {
  const r = await client.chat.completions.create({
    model, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const txt = r.choices?.[0]?.message?.content || '';
  if (BLOCK_PATTERNS.some((p) => p.test(txt))) throw new Error('LLM_BLOCKED: ' + txt.slice(0, 120));
  return JSON.parse(txt);
}
