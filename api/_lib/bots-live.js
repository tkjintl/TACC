// _lib/bots-live.js — Live bot personas. Each persona is a distinct
// fictional investor that advances through the pipeline at their own pace.
// Designed to feel like real activity: not a batch sim, individuals moving.
//
// State: ONE Redis key `bots:live:state` holds personas + auto_mode + counters.
// Each tick advances ~3 personas by one logical step. ~20 Upstash cmds/tick.
// Browser timer (60s default) drives ticks while modal open; cron picks up overnight.

import {
  saveLead,
  appendAudit,
  transitionStage,
  getStageCounts,
  getJSON,
  setJSON,
  listLeads,
  resolveLeadStage,
  getLead,
} from './storage.js';

const STATE_KEY = 'bots:live:state';

// 10 distinct personas with realistic backstories. The simulation creates
// them on first start and walks them through individually.
const PERSONA_TEMPLATES = [
  { name: 'Choi Eun-mi',     country: 'KR', occ: 'Hedge fund LP',         class: 'qualified_investor', sow: 'investments',  wealth: '25_50m',  pace: 'fast',   referrer: 'TKJ' },
  { name: 'Park Joon-ho',    country: 'KR', occ: 'PE managing partner',   class: 'family_office',      sow: 'business',     wealth: '50m_plus',pace: 'medium', referrer: 'JWC' },
  { name: 'Lim Tae-young',   country: 'SG', occ: 'Family office CIO',     class: 'family_office',      sow: 'inheritance',  wealth: '50m_plus',pace: 'slow',   referrer: 'TKJ' },
  { name: 'Wong Ka-Ho',      country: 'HK', occ: 'Tech founder',          class: 'hnw',                sow: 'business',     wealth: '10_25m',  pace: 'fast',   referrer: 'WSL' },
  { name: '김재훈',           country: 'KR', occ: 'Industrial heir',       class: 'hnw',                sow: 'inheritance',  wealth: '25_50m',  pace: 'medium', referrer: 'TKJ' },
  { name: 'Tanaka Kenji',    country: 'JP', occ: 'Cosmetics founder',     class: 'hnw',                sow: 'business',     wealth: '10_25m',  pace: 'fast',   referrer: 'JWC' },
  { name: 'Goh Wei Ming',    country: 'SG', occ: 'Bank executive',        class: 'qualified_investor', sow: 'employment',   wealth: '5_10m',   pace: 'medium', referrer: 'WSL' },
  { name: '이서영',           country: 'KR', occ: 'Pre-IPO investor',      class: 'family_office',      sow: 'investments',  wealth: '25_50m',  pace: 'fast',   referrer: 'TKJ' },
  { name: 'Sato Mika',       country: 'JP', occ: 'Real estate principal', class: 'hnw',                sow: 'real_estate',  wealth: '10_25m',  pace: 'slow',   referrer: 'JWC' },
  { name: '윤민철',           country: 'KR', occ: 'PE associate',          class: 'qualified_investor', sow: 'employment',   wealth: '5_10m',   pace: 'fast',   referrer: 'WSL' },
];

const ALLOC_BY_WEALTH = { '5_10m':'2', '10_25m':'3_5', '25_50m':'5_10', '50m_plus':'10_plus' };
const PHONE_PREFIX = { KR:'+82 10', SG:'+65 9', HK:'+852 6', JP:'+81 90' };

// How many ticks each persona spends at each stage before advancing.
// Pace 'fast' = aggressive (1-2 ticks per stage), slow = cautious (3-5 ticks).
const PACE_DELAY = {
  fast:   { min: 1, max: 2 },
  medium: { min: 2, max: 3 },
  slow:   { min: 3, max: 5 },
};

function _delay(pace) {
  const d = PACE_DELAY[pace] || PACE_DELAY.medium;
  return d.min + Math.floor(Math.random() * (d.max - d.min + 1));
}

export async function getBotsState() {
  const state = await getJSON(STATE_KEY);
  return state || {
    auto_mode: 'off',
    started_at: null,
    last_tick_at: null,
    tick_count: 0,
    actions_count: 0,
    estimated_upstash_cmds: 0,
    personas: [], // [{ slot, name, leadId, current_stage, ticks_remaining_at_stage, last_action_at, last_action_text }]
  };
}

export async function saveBotsState(state) {
  await setJSON(STATE_KEY, state);
}

async function _createPersonaLead(template, now) {
  const id = 'demo_persona_' + (now + Math.floor(Math.random() * 1e6)).toString(36);
  const phonePref = PHONE_PREFIX[template.country] || '+1 415';
  const lead = {
    id,
    demo: true,
    bot_generated: true,
    bot_persona: true,
    name: template.name,
    legal_name: template.name,
    email: `bot.${id.slice(-8)}@example.com`,
    country: template.country,
    phone: `${phonePref} ${1000 + Math.floor(Math.random()*8999)} ${1000 + Math.floor(Math.random()*8999)}`,
    tax_residency: template.country,
    occupation: template.occ,
    investable_assets: template.wealth,
    investor_classification: template.class,
    source_of_wealth_high_level: template.sow,
    anticipated_allocation_kg: ALLOC_BY_WEALTH[template.wealth] || '2',
    referral_source: 'personal_intro',
    referrer_name: template.referrer,
    reverse_solicitation_ack: true,
    status: 'inquiry',
    nda_state: 'awaiting',
    created_at: now,
    audit: [],
  };
  await saveLead(lead);
  await transitionStage(lead, null, 'inquiry');
  await appendAudit(lead, { actor: 'bot', action: 'inquiry_received', memo: `${template.name} submitted /interest form` });
  return lead;
}

export async function startBots() {
  const state = await getBotsState();
  const now = Date.now();
  // Reset state, spin up fresh personas.
  state.auto_mode = 'on';
  state.started_at = now;
  state.last_tick_at = now;
  state.tick_count = 0;
  state.actions_count = 0;
  state.estimated_upstash_cmds = 0;

  // Create 6 fresh personas at the inquiry stage, plus 2 already mid-flow
  // (so the user sees some at later stages immediately).
  state.personas = [];
  let cmds = 0;
  for (let i = 0; i < 6; i++) {
    const tpl = PERSONA_TEMPLATES[i];
    const lead = await _createPersonaLead(tpl, now - i * 1000);
    state.personas.push({
      slot: i,
      name: tpl.name,
      country: tpl.country,
      pace: tpl.pace,
      leadId: lead.id,
      current_stage: 'inquiry',
      ticks_remaining_at_stage: _delay(tpl.pace),
      last_action_at: now,
      last_action_text: `submitted /interest form`,
    });
    cmds += 5;
  }
  state.estimated_upstash_cmds += cmds;

  await saveBotsState(state);
  return { ok: true, state, started: state.personas.length };
}

export async function stopBots() {
  const state = await getBotsState();
  state.auto_mode = 'off';
  state.last_tick_at = Date.now();
  await saveBotsState(state);
  return { ok: true, state };
}

const PIPELINE = ['inquiry','invited','nda_pending','subscribed','wire_issued','wire_received','funded'];
const POST_FUND_ACTIONS = ['login','read_message','ack_capital_call','read_letter'];

async function _advancePersona(persona, session) {
  const lead = await getLead(persona.leadId);
  if (!lead || lead.deleted_at) {
    return { advanced: false, reason: 'lead missing' };
  }
  const stage = persona.current_stage;
  const next = PIPELINE[PIPELINE.indexOf(stage) + 1];

  // Pre-fund stages: simulate the appropriate action
  if (stage === 'inquiry') {
    // Operator approves
    lead.status = 'invited';
    lead.code = 'BOT' + Math.random().toString(36).slice(2, 6).toUpperCase();
    lead.code_issued_at = Date.now();
    await saveLead(lead);
    await transitionStage(lead, 'inquiry', 'invited');
    await appendAudit(lead, { actor: (session && session.email) || 'tkj', action: 'approve', memo: `${persona.name} approved by partner` });
    return { advanced: true, from: 'inquiry', to: 'invited', text: 'partner approved · code issued' };
  }
  if (stage === 'invited') {
    // Member uploads NDA
    lead.nda_state = 'uploaded';
    lead.nda_uploaded_at = Date.now();
    lead.nda_url = 'https://example.com/persona-nda.pdf';
    lead.code_redeemed_at = Date.now();
    lead.last_login_at = Date.now();
    await saveLead(lead);
    await transitionStage(lead, 'invited', 'nda_pending');
    await appendAudit(lead, { actor: lead.id, action: 'nda_uploaded', memo: `${persona.name} uploaded NDA at /nda` });
    return { advanced: true, from: 'invited', to: 'nda_pending', text: 'redeemed code · NDA uploaded' };
  }
  if (stage === 'nda_pending') {
    // Operator approves NDA
    lead.nda_state = 'approved';
    lead.nda_approved_at = Date.now();
    lead.status = 'subscribed';
    await saveLead(lead);
    await transitionStage(lead, 'nda_pending', 'subscribed');
    await appendAudit(lead, { actor: (session && session.email) || 'tkj', action: 'nda_approved' });
    return { advanced: true, from: 'nda_pending', to: 'subscribed', text: 'NDA approved by partner' };
  }
  if (stage === 'subscribed') {
    // Member submits subscription, operator issues wire
    const kg = parseFloat((lead.anticipated_allocation_kg === '10_plus' ? '10' : (lead.anticipated_allocation_kg || '2').split('_')[0])) || 2;
    lead.subscription = lead.subscription || {
      kg_requested: kg, usd_amount: Math.round(kg * 112000),
      submitted_at: Date.now(), ltv_acknowledged: true, capital_call_acknowledged: true,
      signature: lead.name.toLowerCase(),
    };
    lead.wire = lead.wire || {};
    lead.wire.reference = `TACC-${lead.id.slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    lead.wire.instructions_sent_at = Date.now();
    lead.wire.amount_usd = lead.subscription.usd_amount;
    await saveLead(lead);
    await transitionStage(lead, 'subscribed', 'wire_issued');
    await appendAudit(lead, { actor: (session && session.email) || 'tkj', action: 'wire_instructions_sent', memo: `${kg} kg · $${lead.wire.amount_usd.toLocaleString()}` });
    return { advanced: true, from: 'subscribed', to: 'wire_issued', text: `subscription submitted · wire issued ($${lead.wire.amount_usd.toLocaleString()})` };
  }
  if (stage === 'wire_issued') {
    lead.wire.received_at = Date.now();
    await saveLead(lead);
    await transitionStage(lead, 'wire_issued', 'wire_received');
    await appendAudit(lead, { actor: (session && session.email) || 'tkj', action: 'wire_received' });
    return { advanced: true, from: 'wire_issued', to: 'wire_received', text: 'wire received at bank' };
  }
  if (stage === 'wire_received') {
    lead.wire.cleared_at = Date.now();
    lead.status = 'funded';
    lead.funded_at = lead.wire.cleared_at;
    const counts = await getStageCounts();
    let mn = (counts.funded || 0) + 1;
    if (mn > 100) mn = 1;
    lead.member_number = mn;
    await saveLead(lead);
    await transitionStage(lead, 'wire_received', 'funded');
    await appendAudit(lead, { actor: (session && session.email) || 'tkj', action: 'wire_cleared', memo: `member #${String(mn).padStart(3,'0')} admitted` });
    return { advanced: true, from: 'wire_received', to: 'funded', text: `cleared & admitted · member #${String(mn).padStart(3,'0')}`, member_number: mn };
  }
  // Funded — pick a post-fund action (member behaviour)
  if (stage === 'funded') {
    const action = POST_FUND_ACTIONS[Math.floor(Math.random() * POST_FUND_ACTIONS.length)];
    if (action === 'login') {
      lead.last_login_at = Date.now();
      await saveLead(lead);
      await appendAudit(lead, { actor: lead.id, action: 'portfolio_visited', memo: 'opened /portfolio' });
      return { advanced: false, stayed: 'funded', text: 'logged in to /portfolio' };
    }
    if (action === 'read_message') {
      const unread = (lead.messages || []).find((m) => !m.read_at);
      if (unread) {
        unread.read_at = Date.now();
        await saveLead(lead);
        await appendAudit(lead, { actor: lead.id, action: 'message_read', memo: unread.subject });
        return { advanced: false, stayed: 'funded', text: `read message: "${unread.subject}"` };
      }
      return { advanced: false, stayed: 'funded', text: 'inbox empty (no unread)' };
    }
    if (action === 'ack_capital_call') {
      const pending = (lead.capital_calls || []).find((c) => c.status === 'pending' && !c.acknowledged_at);
      if (pending) {
        pending.acknowledged_at = Date.now();
        pending.status = 'acknowledged';
        await saveLead(lead);
        await appendAudit(lead, { actor: lead.id, action: 'capital_call_acknowledged', memo: pending.ref });
        return { advanced: false, stayed: 'funded', text: `ack'd capital call ${pending.ref}` };
      }
      return { advanced: false, stayed: 'funded', text: 'no pending capital calls' };
    }
    if (action === 'read_letter') {
      const unread = (lead.quarterly_letters || []).find((l) => l.sent_at && !l.read_at);
      if (unread) {
        unread.read_at = Date.now();
        await saveLead(lead);
        await appendAudit(lead, { actor: lead.id, action: 'letter_read', memo: unread.subject || `Q${unread.quarter} ${unread.year}` });
        return { advanced: false, stayed: 'funded', text: `read letter: ${unread.subject || ''}` };
      }
      return { advanced: false, stayed: 'funded', text: 'no unread letters' };
    }
  }
  return { advanced: false, reason: 'no transition' };
}

export async function tickBots(session) {
  const state = await getBotsState();
  if (state.auto_mode !== 'on') return { ok: false, error: 'bots are stopped — call bot-start first' };
  if (!state.personas || !state.personas.length) return { ok: false, error: 'no personas; call bot-start' };

  const now = Date.now();
  state.tick_count = (state.tick_count || 0) + 1;
  state.last_tick_at = now;

  // Pick up to 3 personas that are due for advancement.
  const due = [];
  for (const p of state.personas) {
    p.ticks_remaining_at_stage = (p.ticks_remaining_at_stage == null ? 1 : p.ticks_remaining_at_stage) - 1;
    if (p.ticks_remaining_at_stage <= 0) due.push(p);
  }
  // If no one is due, advance the most-stale persona regardless.
  if (!due.length && state.personas.length) {
    const oldest = state.personas.slice().sort((a,b) => (a.last_action_at || 0) - (b.last_action_at || 0))[0];
    if (oldest) due.push(oldest);
  }

  const advanced = [];
  for (const p of due.slice(0, 3)) {
    const result = await _advancePersona(p, session);
    if (result.advanced) {
      p.current_stage = result.to;
      p.ticks_remaining_at_stage = _delay(p.pace);
    } else if (result.stayed) {
      p.ticks_remaining_at_stage = _delay(p.pace);
    } else {
      p.ticks_remaining_at_stage = 1; // try again next tick
    }
    p.last_action_at = now;
    p.last_action_text = result.text || result.reason || '—';
    advanced.push({ slot: p.slot, name: p.name, stage: p.current_stage, action: p.last_action_text });
  }

  // Occasionally spawn a new persona if all existing ones are funded
  const allFunded = state.personas.every((p) => p.current_stage === 'funded');
  if (allFunded && state.personas.length < 10 && Math.random() < 0.3) {
    const used = new Set(state.personas.map((p) => p.name));
    const tpl = PERSONA_TEMPLATES.find((t) => !used.has(t.name));
    if (tpl) {
      const lead = await _createPersonaLead(tpl, now);
      state.personas.push({
        slot: state.personas.length,
        name: tpl.name,
        country: tpl.country,
        pace: tpl.pace,
        leadId: lead.id,
        current_stage: 'inquiry',
        ticks_remaining_at_stage: _delay(tpl.pace),
        last_action_at: now,
        last_action_text: 'submitted /interest form',
      });
      advanced.push({ slot: state.personas.length - 1, name: tpl.name, stage: 'inquiry', action: 'new signup' });
    }
  }

  state.actions_count = (state.actions_count || 0) + advanced.length;
  state.estimated_upstash_cmds = (state.estimated_upstash_cmds || 0) + advanced.length * 6 + 2;

  await saveBotsState(state);
  return { ok: true, state, advanced };
}

export function summarizePersonas(state) {
  return (state.personas || []).map((p) => ({
    slot: p.slot,
    name: p.name,
    country: p.country,
    pace: p.pace,
    stage: p.current_stage,
    last_action_at: p.last_action_at,
    last_action_text: p.last_action_text,
  }));
}
