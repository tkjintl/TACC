// _lib/bot-handlers.js — Thin admin op handlers for the bot harness.
// Imported by api/v2.js handleAdmin switch. Keeps v2.js modest.

import { getBotState, saveBotState, SCENARIOS, runTick } from './bot.js';

function ok(res, data) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}
function bad(res, msg) {
  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: msg }));
}
function methodNotAllowed(res) {
  res.statusCode = 405;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

export async function botStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const state = await getBotState();
  return ok(res, { ok: true, state, scenarios: Object.keys(SCENARIOS).map((k) => ({ key: k, ...SCENARIOS[k], apply: undefined })) });
}

export async function botPause(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const state = await getBotState();
  state.paused = true;
  state.last_action_at = Date.now();
  await saveBotState(state);
  return ok(res, { ok: true, state });
}

export async function botResume(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const state = await getBotState();
  state.paused = false;
  if (!state.started_at) state.started_at = Date.now();
  state.last_action_at = Date.now();
  await saveBotState(state);
  return ok(res, { ok: true, state });
}

export async function botAudit(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const state = await getBotState();
  const dailyFree = 10000;
  return ok(res, {
    ok: true,
    state,
    upstash: {
      estimated_today: state.estimated_upstash_cmds || 0,
      daily_free_tier: dailyFree,
      pct_used: Math.min(100, ((state.estimated_upstash_cmds || 0) / dailyFree) * 100),
    },
  });
}

export async function botScenario(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }
  const name = String((body && body.name) || '').trim();
  const scenario = SCENARIOS[name];
  if (!scenario) return bad(res, `unknown scenario: ${name}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
  const state = await getBotState();
  if (state.paused) return bad(res, 'bot is paused — resume first');

  const result = await scenario.apply(session);
  state.scenarios_applied = (state.scenarios_applied || 0) + 1;
  state.events_generated = (state.events_generated || 0) + (result.mutations || 0);
  state.estimated_upstash_cmds = (state.estimated_upstash_cmds || 0) + (result.mutations || 0) * 4 + 5;
  state.last_action_at = Date.now();
  if (!state.started_at) state.started_at = Date.now();
  await saveBotState(state);
  return ok(res, { ok: true, state, applied: result });
}

export async function botTick(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const state = await getBotState();
  if (state.paused) return bad(res, 'bot is paused — resume first');
  const result = await runTick(session);
  state.ticks_run = (state.ticks_run || 0) + 1;
  state.events_generated = (state.events_generated || 0) + (result.mutations || 0);
  state.estimated_upstash_cmds = (state.estimated_upstash_cmds || 0) + (result.mutations || 0) * 5 + 3;
  state.last_action_at = Date.now();
  if (!state.started_at) state.started_at = Date.now();
  await saveBotState(state);
  return ok(res, { ok: true, state, advanced: result.advanced, mutations: result.mutations });
}

export async function botReset(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  // Delegate to the existing wipe + seed flow but call once each — the user
  // already pays the cost of those ops. We just track and reset state.
  const state = {
    started_at: Date.now(),
    paused: false,
    last_action_at: Date.now(),
    ticks_run: 0,
    scenarios_applied: 0,
    events_generated: 0,
    estimated_upstash_cmds: 0,
    note: 'Run wipe-demo + seed-demo separately to clear test data',
  };
  await saveBotState(state);
  return ok(res, { ok: true, state, note: 'Bot state reset. Run wipe-demo + seed-demo from header buttons to refresh fixtures.' });
}
