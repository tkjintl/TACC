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
import * as Email from './email.js';

// ─── Email validation harness ────────────────────────────────────────────────
// Renders an email template via preview mode + checks required tokens are
// present in the body. Returns { ok, type, issues[] }.
async function _validateEmail(type, lead, extra) {
  Email._PREVIEW.enabled = true;
  Email._PREVIEW.captured = null;
  try {
    if (type === 'invitation')               await Email.sendInvitation(lead, extra.code);
    else if (type === 'inquiry_ack')         await Email.sendInquiryAck(lead);
    else if (type === 'wire_instructions')   await Email.sendWireInstructions(lead, extra);
    else if (type === 'funded_confirmation') await Email.sendFundedConfirmation(lead);
    else if (type === 'quarterly_letter')    await Email.sendQuarterlyLetterNotification(lead, extra);
    else if (type === 'vault_verification')  await Email.sendVaultVerificationNotification(lead, extra);
    else return { ok: false, type, issues: [`unknown email type: ${type}`] };
  } finally {
    Email._PREVIEW.enabled = false;
  }
  const cap = Email._PREVIEW.captured;
  if (!cap) return { ok: false, type, issues: ['email function did not call sendRaw'] };
  const issues = [];
  if (!cap.to || !String(cap.to).includes('@'))                 issues.push('to: missing or invalid');
  if (!cap.subject || cap.subject.length < 8)                   issues.push('subject: empty or too short');
  if (!cap.html || cap.html.length < 200)                       issues.push('html: empty or too short');
  if (!cap.text || cap.text.length < 40)                        issues.push('text: empty or too short');
  // Token-presence checks per type
  const html = cap.html || '';
  const text = cap.text || '';
  if (type === 'invitation') {
    if (extra.code && !html.includes(extra.code))               issues.push('html: access code missing');
    if (extra.code && !text.includes(extra.code))               issues.push('text: access code missing');
    if (lead.name && !html.includes(_escapeForCheck(lead.name)))issues.push('html: member name missing');
  }
  if (type === 'wire_instructions') {
    if (extra && extra.reference && !html.includes(extra.reference)) issues.push('html: wire reference missing');
    if (extra && extra.amount_usd != null) {
      const amt = Number(extra.amount_usd);
      if (amt > 0 && !html.includes(amt.toLocaleString())) issues.push('html: wire amount missing');
    }
  }
  if (type === 'funded_confirmation') {
    if (lead.member_number != null && !html.includes(String(lead.member_number))) issues.push('html: member number missing');
  }
  return { ok: issues.length === 0, type, issues, subject: cap.subject, html_len: html.length, text_len: text.length };
}

function _escapeForCheck(s) { return String(s); }
function _emailCheckText(check) {
  if (check.ok) return `✓ email[${check.type}] OK · "${check.subject}" · html=${check.html_len}b text=${check.text_len}b`;
  return `✗ email[${check.type}] FAIL · ${check.issues.join('; ')}`;
}

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

// Ticks each persona spends at each stage before being eligible to advance.
// Tuned so the pipeline visibly moves on a 3-second tick: fast personas land
// in funded in ~1 minute; slow personas in ~3 minutes.
const PACE_DELAY = {
  fast:   { min: 0, max: 1 },
  medium: { min: 1, max: 2 },
  slow:   { min: 1, max: 3 },
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
  // Validate inquiry-acknowledgement email
  try {
    const ec = await _validateEmail('inquiry_ack', lead, {});
    lead._lastEmailCheck = ec;
  } catch {}
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

export async function resetBots() {
  // Soft-delete all persona leads, wipe state, restart fresh
  const state = await getBotsState();
  const personaIds = (state.personas || []).map((p) => p.leadId).filter(Boolean);
  let removed = 0;
  for (const id of personaIds) {
    try {
      const lead = await getLead(id);
      if (lead) {
        const stage = resolveLeadStage(lead);
        lead.deleted_at = Date.now();
        lead.deleted_reason = 'bot_reset';
        await saveLead(lead);
        if (stage) await transitionStage(lead, stage, null);
        removed++;
      }
    } catch {}
  }
  // Wipe state and start fresh (creates 6 new personas)
  await saveBotsState({
    auto_mode: 'off', started_at: null, last_tick_at: null,
    tick_count: 0, actions_count: 0, estimated_upstash_cmds: 0, personas: [],
  });
  const fresh = await startBots();
  return { ok: true, removed, ...fresh };
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
    const ec = await _validateEmail('invitation', lead, { code: lead.code });
    return { advanced: true, from: 'inquiry', to: 'invited', text: 'partner approved · code issued · ' + _emailCheckText(ec), email_check: ec };
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
    const ec = await _validateEmail('wire_instructions', lead, { reference: lead.wire.reference, amount_usd: lead.wire.amount_usd });
    return { advanced: true, from: 'subscribed', to: 'wire_issued', text: `subscription submitted · wire issued ($${lead.wire.amount_usd.toLocaleString()}) · ${_emailCheckText(ec)}`, email_check: ec };
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
    const ec = await _validateEmail('funded_confirmation', lead, {});
    return { advanced: true, from: 'wire_received', to: 'funded', text: `cleared & admitted · member #${String(mn).padStart(3,'0')} · ${_emailCheckText(ec)}`, member_number: mn, email_check: ec };
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

  // ─── Operator-bot broadcasts ─────────────────────────────────────────
  // Periodically inject fresh content so funded personas have something to do
  // (read messages, ack capital calls, mark letters). Drops one event per cadence.
  if (state.tick_count % 6 === 0) {
    // Drop a new in-portal message to one random funded persona
    const fundedPs = state.personas.filter((p) => p.current_stage === 'funded');
    if (fundedPs.length) {
      const target = fundedPs[Math.floor(Math.random() * fundedPs.length)];
      const lead = await getLead(target.leadId);
      if (lead) {
        const msgId = 'msg_' + Date.now().toString(36);
        const subjects = [
          'Q2 NAV update — preliminary',
          'Bank confirmation: facility utilisation',
          'Vault re-verification scheduled',
          'New deal under review — TACC partner brief',
          'Year-end statement availability',
        ];
        const subj = subjects[state.tick_count % subjects.length];
        lead.messages = lead.messages || [];
        lead.messages.unshift({
          id: msgId, type: 'gold', subject: subj,
          body: 'Synthetic operator broadcast for live test simulation.',
          sent_at: new Date().toISOString(), read_at: null, sender: 'admin',
        });
        await saveLead(lead);
        await appendAudit(lead, { actor: 'tkj@theaurumcc.com', action: 'message_sent', memo: subj });
        advanced.push({ slot: target.slot, name: target.name, stage: 'funded', action: `partner sent message: "${subj}"` });
      }
    }
  }
  if (state.tick_count % 12 === 0) {
    // Issue a capital call to one funded persona
    const fundedPs = state.personas.filter((p) => p.current_stage === 'funded');
    if (fundedPs.length) {
      const target = fundedPs[Math.floor(Math.random() * fundedPs.length)];
      const lead = await getLead(target.leadId);
      if (lead) {
        const ccId = 'cc_' + Date.now().toString(36);
        const ref = `CC-${new Date().getFullYear()}-Q${Math.floor((new Date().getMonth())/3)+1}-${String(Math.floor(Math.random()*900)+100)}`;
        lead.capital_calls = lead.capital_calls || [];
        lead.capital_calls.push({
          id: ccId, ref, amount_usd: 50000,
          due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0,10),
          notes: 'Simulated capital call', status: 'pending',
          issued_at: Date.now(), acknowledged_at: null,
        });
        await saveLead(lead);
        await appendAudit(lead, { actor: 'tkj@theaurumcc.com', action: 'capital_call_issued', memo: ref });
        advanced.push({ slot: target.slot, name: target.name, stage: 'funded', action: `partner issued capital call ${ref} ($50K)` });
      }
    }
  }
  if (state.tick_count % 24 === 0) {
    // Publish a quarterly letter to all funded personas
    const fundedPs = state.personas.filter((p) => p.current_stage === 'funded').slice(0, 3);
    const q = Math.floor(new Date().getMonth() / 3) + 1;
    const yr = new Date().getFullYear();
    for (const p of fundedPs) {
      const lead = await getLead(p.leadId);
      if (!lead) continue;
      const lid = 'letter_' + Date.now().toString(36) + '_' + p.slot;
      lead.quarterly_letters = lead.quarterly_letters || [];
      lead.quarterly_letters.push({
        id: lid, quarter: q, year: yr,
        subject: `Q${q} ${yr} — Partner Update`,
        sent_at: new Date().toISOString(), read_at: null,
      });
      await saveLead(lead);
    }
    if (fundedPs.length) {
      // Validate the quarterly-letter notification email format (using one persona)
      const sample = await getLead(fundedPs[0].leadId);
      let ecText = '';
      if (sample) {
        const ec = await _validateEmail('quarterly_letter', sample, { quarter: q, year: yr, subject: `Q${q} ${yr} — Partner Update` });
        ecText = ' · ' + _emailCheckText(ec);
      }
      advanced.push({ slot: -1, name: 'TKJ', stage: 'funded', action: `partner published Q${q} ${yr} letter to ${fundedPs.length} members${ecText}` });
    }
  }

  // ─── Aggressive new-persona spawn ────────────────────────────────────
  // Every 4 ticks, spawn one fresh persona if we're under 10 total. Keeps the
  // pre-fund pipeline visibly active even after early adopters get to funded.
  if (state.tick_count % 4 === 0 && state.personas.length < 10) {
    const used = new Set(state.personas.map((p) => p.name));
    const tpl = PERSONA_TEMPLATES.find((t) => !used.has(t.name));
    if (tpl) {
      const lead = await _createPersonaLead(tpl, now);
      state.personas.push({
        slot: state.personas.length,
        name: tpl.name, country: tpl.country, pace: tpl.pace,
        leadId: lead.id,
        current_stage: 'inquiry',
        ticks_remaining_at_stage: _delay(tpl.pace),
        last_action_at: now,
        last_action_text: 'submitted /interest form',
      });
      advanced.push({ slot: state.personas.length - 1, name: tpl.name, stage: 'inquiry', action: 'new signup arrived' });
    }
  }

  state.actions_count = (state.actions_count || 0) + advanced.length;
  state.estimated_upstash_cmds = (state.estimated_upstash_cmds || 0) + advanced.length * 6 + 2;

  // Roll email-check stats forward (pass / fail counts)
  state.email_checks_total = (state.email_checks_total || 0);
  state.email_checks_pass = (state.email_checks_pass || 0);
  state.email_checks_fail = (state.email_checks_fail || 0);
  state.last_email_failures = state.last_email_failures || [];
  for (const a of advanced) {
    if (a.email_check) {
      state.email_checks_total++;
      if (a.email_check.ok) state.email_checks_pass++;
      else {
        state.email_checks_fail++;
        state.last_email_failures.unshift({
          at: now, persona: a.name, type: a.email_check.type,
          issues: a.email_check.issues,
        });
        if (state.last_email_failures.length > 10) state.last_email_failures = state.last_email_failures.slice(0, 10);
      }
    }
  }

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
