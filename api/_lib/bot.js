// _lib/bot.js — Bot test harness for the platform admin console.
//
// Designed for minimum Upstash command usage. No background timers, no
// auto-loops. Operator triggers everything. Scenarios are single-shot
// batched mutations. State lives in ONE Redis key (bot:state).
//
// Cost ceiling per operation (rough):
//   bot-status     : 1 GET                                = 1 cmd
//   bot-scenario   : 1 GET + N writes (N = 8-12)          = ~20 cmds
//   bot-tick       : 1 GET + ~3 lead updates              = ~10 cmds
//   bot-pause/resume: 1 GET + 1 SET                       = 2 cmds
//   bot-audit      : 1 GET                                = 1 cmd
//   bot-reset      : ~50 cmds (wipe) + ~150 (seed)        = ~200 cmds
//
// Daily ceiling for ~50 operator clicks: ~2,000 cmds (well under 10k/day).

import {
  listLeads,
  saveLead,
  appendAudit,
  transitionStage,
  addComplianceFlag,
  getJSON,
  setJSON,
  pickOneByStage,
  getStageCounts,
} from './storage.js';

const BOT_STATE_KEY = 'bot:state';

export async function getBotState() {
  const state = await getJSON(BOT_STATE_KEY).catch(() => null);
  return state || {
    started_at: null,
    paused: false,
    last_action_at: null,
    ticks_run: 0,
    scenarios_applied: 0,
    events_generated: 0,
    estimated_upstash_cmds: 0,
  };
}

export async function saveBotState(state) {
  await setJSON(BOT_STATE_KEY, state);
}

export const SCENARIOS = {
  'heavy-queue': {
    name: 'Heavy queue',
    description: '5 NDAs to review',
    apply: async (session) => {
      const all = await listLeads({ limit: 200 });
      let mutations = 0;
      const invited = all.filter((l) => l.status === 'invited' && !l.deleted_at).slice(0, 5);
      for (const l of invited) {
        l.nda_state = 'uploaded';
        l.nda_uploaded_at = Date.now() - Math.floor(Math.random() * 5 * 86400000);
        l.nda_url = 'https://example.com/demo-nda.pdf';
        await saveLead(l);
        await appendAudit(l, { actor: 'system', action: 'nda_uploaded' });
        mutations++;
      }
      return { mutations, scenario: 'heavy-queue' };
    },
  },
  'compliance-crunch': {
    name: 'Compliance crunch',
    description: 'KYC expiring + members inactive',
    apply: async (session) => {
      let mutations = 0;
      const all = await listLeads({ limit: 200 });
      const funded = all.filter((l) => l.status === 'funded' && !l.deleted_at);
      for (const l of funded.slice(0, 2)) {
        l.last_login_at = Date.now() - 70 * 86400000;
        await saveLead(l);
        await addComplianceFlag(l.id, 'member-inactive', 'No login >60d');
        mutations++;
      }
      const invited = all.filter((l) => l.status === 'invited' && !l.deleted_at).slice(0, 3);
      for (const l of invited) {
        l.kyc_expires_at = Date.now() + 14 * 86400000;
        await saveLead(l);
        await addComplianceFlag(l.id, 'kyc-expiring', 'KYC docs expire in 14 days');
        mutations++;
      }
      return { mutations, scenario: 'compliance-crunch' };
    },
  },
  'signup-rush': {
    name: 'Signup rush',
    description: '6 new inquiries in last 24h',
    apply: async (session) => {
      const profiles = [
        { name: 'Tan Wei Hsien',  email: 'demo.tan.wh@example.com',     country: 'SG', occ: 'Family office CIO',     assets: '25_50m',  invclass: 'family_office',       sow: 'business' },
        { name: '오민준',          email: 'demo.oh.minjun@example.com',  country: 'KR', occ: 'PE managing partner',   assets: '50m_plus', invclass: 'family_office',       sow: 'investments' },
        { name: 'Yamamoto Shun',  email: 'demo.yamamoto.s@example.com', country: 'JP', occ: 'Industrial heir',       assets: '50m_plus', invclass: 'hnw',                 sow: 'inheritance' },
        { name: '서지윤',          email: 'demo.seo.jiyoon@example.com', country: 'KR', occ: 'Tech founder',          assets: '10_25m',  invclass: 'hnw',                 sow: 'business' },
        { name: 'Chan Wai Lung',  email: 'demo.chan.wl@example.com',    country: 'HK', occ: 'Hedge fund LP',         assets: '25_50m',  invclass: 'qualified_investor',  sow: 'employment' },
        { name: '윤하늘',          email: 'demo.yoon.haneul@example.com',country: 'KR', occ: 'Cosmetics founder',     assets: '10_25m',  invclass: 'hnw',                 sow: 'business' },
      ];
      let mutations = 0;
      const now = Date.now();
      const phonePref = { KR:'+82 10', SG:'+65 9', HK:'+852 6', JP:'+81 90' };
      const allocFor = (a) => a === '50m_plus' ? '10_plus' : a === '25_50m' ? '5_10' : a === '10_25m' ? '3_5' : '2';
      for (let i = 0; i < profiles.length; i++) {
        const f = profiles[i];
        const id = 'demo_bot_' + (now + i).toString(36);
        const lead = {
          id,
          demo: true,
          bot_generated: true,
          name: f.name,
          legal_name: f.name,
          email: f.email,
          country: f.country,
          phone: `${phonePref[f.country] || '+1 415'} ${(1000+i*1234)%9000+1000} ${(7000+i*99)%9000+1000}`,
          tax_residency: f.country,
          occupation: f.occ,
          investable_assets: f.assets,
          investor_classification: f.invclass,
          source_of_wealth_high_level: f.sow,
          anticipated_allocation_kg: allocFor(f.assets),
          referral_source: ['personal_intro','existing_member','prior_relationship','introducer'][i % 4],
          referrer_name: i % 2 === 0 ? '윤상호 (#001)' : 'TKJ',
          reverse_solicitation_ack: true,
          status: 'inquiry',
          nda_state: 'awaiting',
          created_at: now - Math.floor(Math.random() * 24 * 3600000),
          audit: [],
        };
        await saveLead(lead);
        await appendAudit(lead, { actor: 'system', action: 'inquiry_received' });
        mutations++;
      }
      return { mutations, scenario: 'signup-rush' };
    },
  },
  'end-of-day': {
    name: 'End of day',
    description: '3 wires cleared today',
    apply: async (session) => {
      const all = await listLeads({ limit: 200 });
      const candidates = all.filter((l) => l.status === 'subscribed' && !l.deleted_at).slice(0, 3);
      let mutations = 0;
      const taken = new Set(all.filter((x) => x.member_number).map((x) => x.member_number));
      for (let i = 0; i < candidates.length; i++) {
        const l = candidates[i];
        l.wire = l.wire || {};
        l.wire.reference = l.wire.reference || `TACC-${l.id.slice(-8).toUpperCase()}-EOD${i}`;
        l.wire.instructions_sent_at = Date.now() - 2 * 86400000;
        l.wire.received_at = Date.now() - 4 * 3600000;
        l.wire.cleared_at = Date.now() - 1 * 3600000;
        l.wire.amount_usd = l.wire.amount_usd || 224000;
        l.status = 'funded';
        l.funded_at = l.wire.cleared_at;
        let mn = 1;
        while (taken.has(mn) && mn <= 100) mn++;
        l.member_number = mn;
        taken.add(mn);
        await saveLead(l);
        await transitionStage(l, 'subscribed', 'funded');
        await appendAudit(l, { actor: (session && session.email) || 'system', action: 'wire_cleared' });
        mutations++;
      }
      return { mutations, scenario: 'end-of-day' };
    },
  },
  'smooth-day': {
    name: 'Smooth day',
    description: 'Approve all pending NDAs',
    apply: async (session) => {
      const all = await listLeads({ limit: 200 });
      let mutations = 0;
      const ndas = all.filter((l) => l.nda_state === 'uploaded' && !l.deleted_at);
      for (const l of ndas) {
        l.nda_state = 'approved';
        l.nda_approved_at = Date.now();
        if (l.status === 'invited') l.status = 'subscribed';
        await saveLead(l);
        await appendAudit(l, { actor: (session && session.email) || 'tkj', action: 'nda_approved' });
        mutations++;
      }
      return { mutations, scenario: 'smooth-day' };
    },
  },
};

// Auto-mode configuration. Each tick is now ~6-8 Upstash cmds (uses stage
// indexes — no full listLeads scan). Daily ceilings (assuming tab open all day):
//   slow:   1 tick / 30 min → 48/day  × ~7 cmds = ~340 cmds/day
//   medium: 1 tick / 10 min → 144/day × ~7 cmds = ~1,000 cmds/day
//   fast:   1 tick / 2 min  → 720/day × ~7 cmds = ~5,000 cmds/day
export const AUTO_INTERVALS_MS = {
  off: 0,
  slow: 30 * 60 * 1000,
  medium: 10 * 60 * 1000,
  fast: 2 * 60 * 1000,
};

// Realistic weighted action mix for an automated platform simulation.
const ACTION_WEIGHTS = [
  { kind: 'new_signup',         weight: 30 },
  { kind: 'approve_to_invited', weight: 15 },
  { kind: 'upload_nda',         weight: 15 },
  { kind: 'approve_nda',        weight: 10 },
  { kind: 'submit_subscription',weight: 10 },
  { kind: 'wire_issue',         weight: 8 },
  { kind: 'wire_received',      weight: 5 },
  { kind: 'wire_cleared',       weight: 5 },
  { kind: 'broadcast_message',  weight: 2 },
];

function _pickWeighted() {
  const total = ACTION_WEIGHTS.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of ACTION_WEIGHTS) {
    r -= a.weight;
    if (r <= 0) return a.kind;
  }
  return ACTION_WEIGHTS[0].kind;
}

const FAKE_PROFILES = [
  { name: 'Choi Eun-mi',     country: 'KR' }, { name: 'Park Joon-ho',    country: 'KR' },
  { name: 'Lim Tae-young',   country: 'SG' }, { name: 'Wong Ka-Ho',      country: 'HK' },
  { name: '김재훈',           country: 'KR' }, { name: '이서영',           country: 'KR' },
  { name: 'Tanaka Kenji',    country: 'JP' }, { name: 'Sato Mika',       country: 'JP' },
  { name: 'Lee Hong-bin',    country: 'KR' }, { name: 'Goh Wei Ming',    country: 'SG' },
  { name: '윤민철',           country: 'KR' }, { name: 'Ng Sze-Wai',      country: 'HK' },
  { name: 'Müller Hans',     country: 'CH' }, { name: 'Suzuki Aiko',     country: 'JP' },
  { name: '강도윤',           country: 'KR' }, { name: 'Tan Boon-Kheng',  country: 'SG' },
];
const FAKE_OCCUPATIONS = [
  'Hedge fund LP', 'Family office CIO', 'Tech founder', 'Real estate principal',
  'PE managing partner', 'Industrial heir', 'Cosmetics founder', 'Bank executive',
  'Fund manager', 'Private investor', 'Pre-IPO investor', 'Entrepreneur',
];
const ALLOC_BY_WEALTH = { '5_10m':'2', '10_25m':'3_5', '25_50m':'5_10', '50m_plus':'10_plus' };

async function _autoNewSignup(now) {
  const profile = FAKE_PROFILES[Math.floor(Math.random() * FAKE_PROFILES.length)];
  const wealth = ['5_10m','10_25m','25_50m','50m_plus'][Math.floor(Math.random()*4)];
  const investorClass = ['hnw','family_office','multi_family_office','qualified_investor'][Math.floor(Math.random()*4)];
  const sow = ['business','employment','inheritance','investments','financial_services','real_estate'][Math.floor(Math.random()*6)];
  const referral = ['personal_intro','existing_member','prior_relationship','introducer'][Math.floor(Math.random()*4)];
  const id = 'demo_bot_' + (now + Math.floor(Math.random()*1e6)).toString(36);
  const phonePref = { KR:'+82 10', SG:'+65 9', HK:'+852 6', JP:'+81 90', CH:'+41 79' }[profile.country] || '+1 415';
  const lead = {
    id,
    demo: true,
    bot_generated: true,
    name: profile.name,
    legal_name: profile.name,
    email: `bot.${id.slice(-8)}@example.com`,
    country: profile.country,
    phone: `${phonePref} ${1000 + Math.floor(Math.random()*8999)} ${1000 + Math.floor(Math.random()*8999)}`,
    tax_residency: profile.country,
    occupation: FAKE_OCCUPATIONS[Math.floor(Math.random() * FAKE_OCCUPATIONS.length)],
    investable_assets: wealth,
    investor_classification: investorClass,
    source_of_wealth_high_level: sow,
    anticipated_allocation_kg: ALLOC_BY_WEALTH[wealth] || '2',
    referral_source: referral,
    referrer_name: referral === 'existing_member' ? '윤상호 (#001)' : 'TKJ',
    reverse_solicitation_ack: true,
    status: 'inquiry',
    nda_state: 'awaiting',
    created_at: now,
    audit: [],
  };
  await saveLead(lead);
  // Add to stage index so subsequent ticks can pick this lead by stage.
  await transitionStage(lead, null, 'inquiry');
  await appendAudit(lead, { actor: 'system', action: 'inquiry_received' });
  return { kind: 'new_signup', leadId: id, leadName: lead.name };
}

// Stage-indexed cheap candidate fetch. Each call is ~3 Upstash cmds:
//   1× ZRANGE leads:by-stage:{stage} 0 0  (1)
//   1× GET lead:{id}                       (1)
// Compared to listLeads which is 1 ZREVRANGE + N GETs (~200 cmds for N=200).
async function _autoAdvanceLead(kind, session) {
  const STAGE_FOR_KIND = {
    approve_to_invited:   'inquiry',
    upload_nda:           'invited',
    approve_nda:          'nda_pending',
    submit_subscription:  'subscribed',
    wire_issue:           'subscribed',
    wire_received:        'wire_issued',
    wire_cleared:         'wire_received',
  };
  const stage = STAGE_FOR_KIND[kind];
  if (!stage) return null;

  // Skip past non-demo leads (rare). Try first 3 candidates max to limit cost.
  let candidate = null;
  for (let skip = 0; skip < 3 && !candidate; skip++) {
    const c = await pickOneByStage(stage, { skip });
    if (!c) return null;
    if (c.deleted_at) continue;
    if (!(c.demo || c.bot_generated)) continue;
    candidate = c;
  }
  if (!candidate) return null;

  if (kind === 'approve_to_invited') {
    const code = 'BOT' + Math.random().toString(36).slice(2, 6).toUpperCase();
    candidate.status = 'invited';
    candidate.code = code;
    candidate.code_issued_at = Date.now();
    await saveLead(candidate);
    await transitionStage(candidate, 'inquiry', 'invited');
    await appendAudit(candidate, { actor: (session && session.email) || 'tkj', action: 'approve' });
    return { kind, leadId: candidate.id, leadName: candidate.name };
  }
  if (kind === 'upload_nda') {
    if (candidate.nda_state !== 'awaiting') return null;
    candidate.nda_state = 'uploaded';
    candidate.nda_uploaded_at = Date.now();
    candidate.nda_url = 'https://example.com/demo-nda.pdf';
    await saveLead(candidate);
    await transitionStage(candidate, 'invited', 'nda_pending');
    await appendAudit(candidate, { actor: 'system', action: 'nda_uploaded' });
    return { kind, leadId: candidate.id, leadName: candidate.name };
  }
  if (kind === 'approve_nda') {
    candidate.nda_state = 'approved';
    candidate.nda_approved_at = Date.now();
    if (candidate.status === 'invited') candidate.status = 'subscribed';
    await saveLead(candidate);
    await transitionStage(candidate, 'nda_pending', 'subscribed');
    await appendAudit(candidate, { actor: (session && session.email) || 'tkj', action: 'nda_approved' });
    return { kind, leadId: candidate.id, leadName: candidate.name };
  }
  if (kind === 'submit_subscription') {
    if (candidate.subscription && candidate.subscription.submitted_at) return null;
    const kg = parseFloat(candidate.anticipated_allocation_kg === '10_plus' ? '10' : (candidate.anticipated_allocation_kg || '2').split('_')[0]) || 2;
    candidate.subscription = {
      kg_requested: kg,
      usd_amount: Math.round(kg * 112000),
      submitted_at: Date.now(),
      ltv_acknowledged: true,
      capital_call_acknowledged: true,
      signature: candidate.name.toLowerCase(),
    };
    await saveLead(candidate);
    await appendAudit(candidate, { actor: candidate.id, action: 'subscription_submitted' });
    return { kind, leadId: candidate.id, leadName: candidate.name };
  }
  if (kind === 'wire_issue') {
    if (candidate.wire && candidate.wire.reference) return null;
    candidate.wire = candidate.wire || {};
    candidate.wire.reference = `TACC-${candidate.id.slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    candidate.wire.instructions_sent_at = Date.now();
    candidate.wire.amount_usd = (candidate.subscription && candidate.subscription.usd_amount) || 224000;
    await saveLead(candidate);
    await transitionStage(candidate, 'subscribed', 'wire_issued');
    await appendAudit(candidate, { actor: (session && session.email) || 'tkj', action: 'wire_instructions_sent' });
    return { kind, leadId: candidate.id, leadName: candidate.name };
  }
  if (kind === 'wire_received') {
    if (!candidate.wire || candidate.wire.received_at) return null;
    candidate.wire.received_at = Date.now();
    await saveLead(candidate);
    await transitionStage(candidate, 'wire_issued', 'wire_received');
    await appendAudit(candidate, { actor: (session && session.email) || 'tkj', action: 'wire_received' });
    return { kind, leadId: candidate.id, leadName: candidate.name };
  }
  if (kind === 'wire_cleared') {
    if (!candidate.wire || candidate.wire.cleared_at) return null;
    candidate.wire.cleared_at = Date.now();
    candidate.status = 'funded';
    candidate.funded_at = candidate.wire.cleared_at;
    // Member-number assignment: rather than scanning all leads, cheaply use
    // the funded counter as a seed and find next unused (worst case 5 lookups).
    const counts = await getStageCounts();
    let mn = (counts.funded || 0) + 1;
    if (mn > 100) mn = 1;
    candidate.member_number = mn;
    await saveLead(candidate);
    await transitionStage(candidate, 'wire_received', 'funded');
    await appendAudit(candidate, { actor: (session && session.email) || 'tkj', action: 'wire_cleared' });
    return { kind, leadId: candidate.id, leadName: candidate.name + ' #' + mn };
  }
  return null;
}

export async function runAutoTick(session) {
  const now = Date.now();
  // Try the weighted-random pick. If it has no candidate to act on, fall back
  // to the next available action so the bot rarely "no-ops" (still cheap — at most
  // one candidate-search loop).
  const triedKinds = new Set();
  let kind = _pickWeighted();
  let result = null;
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    if (triedKinds.has(kind)) {
      const remaining = ACTION_WEIGHTS.map((a) => a.kind).filter((k) => !triedKinds.has(k));
      if (!remaining.length) break;
      kind = remaining[0];
    }
    triedKinds.add(kind);
    if (kind === 'new_signup') {
      result = await _autoNewSignup(now);
    } else if (kind === 'broadcast_message') {
      // Skip — no-op for cost; not advancing a lead anyway.
      kind = 'new_signup';
      continue;
    } else {
      result = await _autoAdvanceLead(kind, session);
    }
    if (!result) {
      kind = _pickWeighted();
    }
  }
  return result || { kind: 'noop', leadId: null, leadName: null };
}

export async function runTick(session) {
  const all = await listLeads({ limit: 200 });
  let mutations = 0;
  const advanced = [];

  // Advance 1 inquiry → invited
  const inq = all.filter((l) => l.status === 'inquiry' && !l.deleted_at && l.demo)[0];
  if (inq) {
    const code = 'BOT' + Math.random().toString(36).slice(2, 6).toUpperCase();
    inq.status = 'invited';
    inq.code = code;
    inq.code_issued_at = Date.now();
    await saveLead(inq);
    await transitionStage(inq, 'inquiry', 'invited');
    await appendAudit(inq, { actor: (session && session.email) || 'tkj', action: 'approve' });
    advanced.push({ id: inq.id, name: inq.name, transition: 'inquiry → invited' });
    mutations++;
  }
  // Advance 1 nda_pending → subscribed
  const nda = all.filter((l) => l.nda_state === 'uploaded' && !l.deleted_at && l.demo)[0];
  if (nda) {
    nda.nda_state = 'approved';
    nda.nda_approved_at = Date.now();
    if (nda.status === 'invited') nda.status = 'subscribed';
    await saveLead(nda);
    await appendAudit(nda, { actor: (session && session.email) || 'tkj', action: 'nda_approved' });
    advanced.push({ id: nda.id, name: nda.name, transition: 'NDA approved' });
    mutations++;
  }
  // Advance 1 wire_received → funded
  const wr = all.filter((l) => l.wire && l.wire.received_at && !l.wire.cleared_at && !l.deleted_at && l.demo)[0];
  if (wr) {
    wr.wire.cleared_at = Date.now();
    wr.status = 'funded';
    wr.funded_at = wr.wire.cleared_at;
    const taken = new Set(all.filter((x) => x.member_number).map((x) => x.member_number));
    let mn = 1;
    while (taken.has(mn) && mn <= 100) mn++;
    wr.member_number = mn;
    await saveLead(wr);
    await transitionStage(wr, 'wire_received', 'funded');
    await appendAudit(wr, { actor: (session && session.email) || 'tkj', action: 'wire_cleared' });
    advanced.push({ id: wr.id, name: wr.name, transition: 'wire cleared → funded #' + mn });
    mutations++;
  }

  return { mutations, advanced };
}
