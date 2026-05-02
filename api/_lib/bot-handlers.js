// _lib/bot-handlers.js — Thin admin op handlers for the bot harness.
// Imported by api/v2.js handleAdmin switch. Keeps v2.js modest.

import { getBotState, saveBotState, SCENARIOS, runTick, runAutoTick, AUTO_INTERVALS_MS } from './bot.js';
import { globalAuditList } from './storage.js';

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
  // CHEAP — only reads bot:state. ~1 Upstash cmd. No audit fetch here.
  const state = await getBotState();
  return ok(res, {
    ok: true,
    state,
    scenarios: Object.keys(SCENARIOS).map((k) => ({ key: k, ...SCENARIOS[k], apply: undefined })),
    intervals_ms: AUTO_INTERVALS_MS,
  });
}

export async function botRecent(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  // Separate explicit op so the audit panel only hits Redis on demand.
  let recent = [];
  try {
    const all = await globalAuditList({ limit: 60 });
    recent = (all || []).filter((e) => e && [
      'inquiry_received','approve','nda_uploaded','nda_approved','subscription_submitted',
      'wire_instructions_sent','wire_received','wire_cleared'
    ].indexOf(e.action) >= 0).slice(0, 30);
  } catch {}
  return ok(res, { ok: true, recent });
}

export async function botSetAuto(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }
  const mode = String((body && body.mode) || 'off').toLowerCase();
  if (!(mode in AUTO_INTERVALS_MS)) return bad(res, 'mode must be off|slow|medium|fast');
  const state = await getBotState();
  state.auto_mode = mode;
  state.auto_started_at = mode === 'off' ? null : (state.auto_started_at || Date.now());
  state.last_action_at = Date.now();
  if (mode !== 'off' && !state.started_at) state.started_at = Date.now();
  await saveBotState(state);
  return ok(res, { ok: true, state, interval_ms: AUTO_INTERVALS_MS[mode] });
}

export async function botAutoTick(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const state = await getBotState();
  if (state.paused) return bad(res, 'bot is paused');
  if (!state.auto_mode || state.auto_mode === 'off') return bad(res, 'auto mode is off');
  const result = await runAutoTick(session);
  state.auto_actions_count = (state.auto_actions_count || 0) + 1;
  state.events_generated = (state.events_generated || 0) + (result && result.kind !== 'noop' ? 1 : 0);
  state.estimated_upstash_cmds = (state.estimated_upstash_cmds || 0) + (result && result.kind === 'new_signup' ? 6 : 5);
  state.last_action_at = Date.now();
  state.last_auto_action = result;
  await saveBotState(state);
  return ok(res, { ok: true, state, action: result });
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
