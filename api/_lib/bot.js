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
      const names = [
        { name: 'Tan Wei Hsien', email: 'demo.tan.wh@example.com', country: 'SG' },
        { name: '오민준', email: 'demo.oh.minjun@example.com', country: 'KR' },
        { name: 'Yamamoto Shun', email: 'demo.yamamoto.s@example.com', country: 'JP' },
        { name: '서지윤', email: 'demo.seo.jiyoon@example.com', country: 'KR' },
        { name: 'Chan Wai Lung', email: 'demo.chan.wl@example.com', country: 'HK' },
        { name: '윤하늘', email: 'demo.yoon.haneul@example.com', country: 'KR' },
      ];
      let mutations = 0;
      const now = Date.now();
      for (let i = 0; i < names.length; i++) {
        const f = names[i];
        const id = 'demo_bot_' + (now + i).toString(36);
        const lead = {
          id,
          demo: true,
          bot_generated: true,
          name: f.name,
          email: f.email,
          country: f.country,
          investable_assets: ['5_10m', '10_25m', '25_50m'][i % 3],
          referral_source: 'introduction',
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
