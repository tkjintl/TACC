// _lib/simulation.js — Simple one-shot platform simulation.
// Click "Start Simulation" → runs ~20 events server-side in one call → returns log.
// No timers. No modes. No background work. ~150 Upstash cmds per run.

import {
  saveLead,
  appendAudit,
  transitionStage,
  pickOneByStage,
  getStageCounts,
  stageIndexBackfill,
  listLeads,
  listFundedMembers,
  resolveLeadStage,
} from './storage.js';

const PROFILES = [
  { name: 'Choi Eun-mi',     country: 'KR', occ: 'Hedge fund LP',         class: 'qualified_investor', sow: 'investments' },
  { name: 'Park Joon-ho',    country: 'KR', occ: 'PE managing partner',   class: 'family_office',      sow: 'business' },
  { name: 'Lim Tae-young',   country: 'SG', occ: 'Family office CIO',     class: 'family_office',      sow: 'inheritance' },
  { name: 'Wong Ka-Ho',      country: 'HK', occ: 'Tech founder',          class: 'hnw',                sow: 'business' },
  { name: '김재훈',           country: 'KR', occ: 'Industrial heir',       class: 'hnw',                sow: 'inheritance' },
  { name: 'Tanaka Kenji',    country: 'JP', occ: 'Cosmetics founder',     class: 'hnw',                sow: 'business' },
  { name: 'Goh Wei Ming',    country: 'SG', occ: 'Bank executive',        class: 'qualified_investor', sow: 'employment' },
  { name: '이서영',           country: 'KR', occ: 'Pre-IPO investor',     class: 'family_office',      sow: 'investments' },
];
const ALLOC_BY_WEALTH = { '5_10m':'2', '10_25m':'3_5', '25_50m':'5_10', '50m_plus':'10_plus' };
const PHONE_PREFIX = { KR:'+82 10', SG:'+65 9', HK:'+852 6', JP:'+81 90' };

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function createSignup(now, log) {
  const profile = pickRandom(PROFILES);
  const wealth = pickRandom(['5_10m','10_25m','25_50m','50m_plus']);
  const id = 'demo_sim_' + (now + Math.floor(Math.random() * 1e6)).toString(36);
  const phonePref = PHONE_PREFIX[profile.country] || '+1 415';
  const lead = {
    id,
    demo: true,
    bot_generated: true,
    name: profile.name,
    legal_name: profile.name,
    email: `sim.${id.slice(-8)}@example.com`,
    country: profile.country,
    phone: `${phonePref} ${1000 + Math.floor(Math.random()*8999)} ${1000 + Math.floor(Math.random()*8999)}`,
    tax_residency: profile.country,
    occupation: profile.occ,
    investable_assets: wealth,
    investor_classification: profile.class,
    source_of_wealth_high_level: profile.sow,
    anticipated_allocation_kg: ALLOC_BY_WEALTH[wealth] || '2',
    referral_source: pickRandom(['personal_intro','existing_member','prior_relationship']),
    referrer_name: 'TKJ',
    reverse_solicitation_ack: true,
    status: 'inquiry',
    nda_state: 'awaiting',
    created_at: now,
    audit: [],
  };
  await saveLead(lead);
  await transitionStage(lead, null, 'inquiry');
  await appendAudit(lead, { actor: 'sim', action: 'inquiry_received' });
  log.push(`+ signup · ${lead.name} (${lead.country})`);
  return lead;
}

// One-time listLeads cache shared across the simulation run so advanceOne
// has a fallback when stage indexes are out of sync.
let _allCache = null;
const _advancedIds = new Set();

async function _candidatesForStage(stage) {
  if (!_allCache) _allCache = await listLeads({ limit: 200 });
  return _allCache.filter((l) => !l.deleted_at && resolveLeadStage(l) === stage);
}

async function advanceOne(stage, kind, session, log) {
  let candidate = null;
  // First try the cheap stage-index path
  for (let skip = 0; skip < 6 && !candidate; skip++) {
    const c = await pickOneByStage(stage, { skip });
    if (!c) break;
    if (c.deleted_at) continue;
    candidate = c;
  }
  // Fallback — scan in-memory cache if index returned nothing
  if (!candidate) {
    const list = await _candidatesForStage(stage);
    candidate = list.find((l) => !_advancedIds.has(l.id)) || null;
  }
  if (!candidate) return false;
  _advancedIds.add(candidate.id);

  const actor = (session && session.email) || 'sim';
  if (kind === 'approve') {
    candidate.status = 'invited';
    candidate.code = 'SIM' + Math.random().toString(36).slice(2, 6).toUpperCase();
    candidate.code_issued_at = Date.now();
    await saveLead(candidate);
    await transitionStage(candidate, 'inquiry', 'invited');
    await appendAudit(candidate, { actor, action: 'approve' });
    log.push(`→ invited · ${candidate.name}`);
    return true;
  }
  if (kind === 'upload_nda') {
    if (candidate.nda_state !== 'awaiting') return false;
    candidate.nda_state = 'uploaded';
    candidate.nda_uploaded_at = Date.now();
    candidate.nda_url = 'https://example.com/sim-nda.pdf';
    await saveLead(candidate);
    await transitionStage(candidate, 'invited', 'nda_pending');
    await appendAudit(candidate, { actor: 'sim', action: 'nda_uploaded' });
    log.push(`→ NDA uploaded · ${candidate.name}`);
    return true;
  }
  if (kind === 'approve_nda') {
    candidate.nda_state = 'approved';
    candidate.nda_approved_at = Date.now();
    if (candidate.status === 'invited') candidate.status = 'subscribed';
    await saveLead(candidate);
    await transitionStage(candidate, 'nda_pending', 'subscribed');
    await appendAudit(candidate, { actor, action: 'nda_approved' });
    log.push(`→ NDA approved · ${candidate.name}`);
    return true;
  }
  if (kind === 'wire_issue') {
    if (candidate.wire && candidate.wire.reference) return false;
    const kg = parseFloat((candidate.anticipated_allocation_kg === '10_plus' ? '10' : (candidate.anticipated_allocation_kg || '2').split('_')[0])) || 2;
    candidate.subscription = candidate.subscription || {
      kg_requested: kg, usd_amount: Math.round(kg * 112000),
      submitted_at: Date.now(), ltv_acknowledged: true, capital_call_acknowledged: true,
      signature: candidate.name.toLowerCase(),
    };
    candidate.wire = candidate.wire || {};
    candidate.wire.reference = `TACC-${candidate.id.slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    candidate.wire.instructions_sent_at = Date.now();
    candidate.wire.amount_usd = candidate.subscription.usd_amount;
    await saveLead(candidate);
    await transitionStage(candidate, 'subscribed', 'wire_issued');
    await appendAudit(candidate, { actor, action: 'wire_instructions_sent' });
    log.push(`→ wire issued · ${candidate.name} ($${candidate.wire.amount_usd.toLocaleString()})`);
    return true;
  }
  if (kind === 'wire_received') {
    if (!candidate.wire || candidate.wire.received_at) return false;
    candidate.wire.received_at = Date.now();
    await saveLead(candidate);
    await transitionStage(candidate, 'wire_issued', 'wire_received');
    await appendAudit(candidate, { actor, action: 'wire_received' });
    log.push(`→ wire received · ${candidate.name}`);
    return true;
  }
  if (kind === 'wire_cleared') {
    if (!candidate.wire || candidate.wire.cleared_at) return false;
    candidate.wire.cleared_at = Date.now();
    candidate.status = 'funded';
    candidate.funded_at = candidate.wire.cleared_at;
    const counts = await getStageCounts();
    let mn = (counts.funded || 0) + 1;
    if (mn > 100) mn = 1;
    candidate.member_number = mn;
    await saveLead(candidate);
    await transitionStage(candidate, 'wire_received', 'funded');
    await appendAudit(candidate, { actor, action: 'wire_cleared' });
    log.push(`✓ FUNDED · ${candidate.name} (member #${String(mn).padStart(3,'0')})`);
    return true;
  }
  return false;
}

// ─── Member-side simulation helpers ──────────────────────────────────────────
// These simulate what happens when an actual investor visits the portal:
// /code, /nda, /subscription, /portfolio. Each action triggers the same state
// changes that the real handler would.

async function runMemberCodeRedemptions(maxCount, log) {
  const all = _allCache || (_allCache = await listLeads({ limit: 200 }));
  const candidates = all.filter((l) =>
    !l.deleted_at && l.status === 'invited' && l.code && !l.code_redeemed_at && !_advancedIds.has(l.id)
  ).slice(0, maxCount);
  if (!candidates.length) {
    log.push('  (no invited members eligible for code redemption)');
    return;
  }
  for (const lead of candidates) {
    lead.code_redeemed_at = Date.now();
    lead.last_login_at = Date.now();
    await saveLead(lead);
    await appendAudit(lead, { actor: lead.id, action: 'code_redeemed', memo: 'opened /code, entered access code' });
    log.push(`✓ ${lead.name} entered code at /code → session issued`);
    _advancedIds.add(lead.id);
  }
}

async function runMemberLogins(log) {
  const funded = await listFundedMembers();
  if (!funded.length) { log.push('  (no funded members yet)'); return; }
  // 60% of funded members "log in" this run
  const subset = funded.filter((_, i) => i % 5 < 3).slice(0, 5);
  for (const lead of subset) {
    if (lead.deleted_at) continue;
    lead.last_login_at = Date.now();
    await saveLead(lead);
    await appendAudit(lead, { actor: lead.id, action: 'portfolio_visited', memo: 'opened /portfolio' });
    log.push(`✓ #${String(lead.member_number || '?').padStart(3,'0')} ${lead.name} logged in → /portfolio rendered`);
  }
}

async function runMemberMessageReads(log) {
  const funded = await listFundedMembers();
  if (!funded.length) { log.push('  (no funded members)'); return; }
  let reads = 0;
  for (const lead of funded.slice(0, 4)) {
    if (lead.deleted_at) continue;
    const msgs = lead.messages || [];
    const unread = msgs.find((m) => !m.read_at);
    if (unread) {
      unread.read_at = Date.now();
      await saveLead(lead);
      await appendAudit(lead, { actor: lead.id, action: 'message_read', memo: unread.subject });
      log.push(`✓ ${lead.name} read message: "${unread.subject}"`);
      reads++;
    }
  }
  if (!reads) log.push('  (no unread messages on the inbox top)');
}

async function runMemberCapitalCallAcks(log) {
  const funded = await listFundedMembers();
  if (!funded.length) { log.push('  (no funded members)'); return; }
  let acks = 0;
  for (const lead of funded) {
    if (lead.deleted_at) continue;
    const calls = lead.capital_calls || [];
    const pending = calls.find((c) => c.status === 'pending' && !c.acknowledged_at);
    if (pending) {
      pending.acknowledged_at = Date.now();
      pending.status = 'acknowledged';
      await saveLead(lead);
      await appendAudit(lead, { actor: lead.id, action: 'capital_call_acknowledged', memo: pending.ref });
      log.push(`✓ ${lead.name} ack'd capital call ${pending.ref}`);
      acks++;
      if (acks >= 3) break;
    }
  }
  if (!acks) log.push('  (no pending capital calls to acknowledge)');
}

async function runMemberLetterReads(log) {
  const funded = await listFundedMembers();
  if (!funded.length) { log.push('  (no funded members)'); return; }
  let reads = 0;
  for (const lead of funded.slice(0, 4)) {
    if (lead.deleted_at) continue;
    const letters = lead.quarterly_letters || [];
    const unread = letters.find((l) => l.sent_at && !l.read_at);
    if (unread) {
      unread.read_at = Date.now();
      await saveLead(lead);
      await appendAudit(lead, { actor: lead.id, action: 'letter_read', memo: unread.subject || `Q${unread.quarter} ${unread.year}` });
      log.push(`✓ ${lead.name} read quarterly letter ${unread.subject || ''}`);
      reads++;
    }
  }
  if (!reads) log.push('  (no unread quarterly letters)');
}

export async function runSimulation(session) {
  const start = Date.now();
  const log = [];
  log.push(`AURUM TACC — SIMULATION RUN`);
  log.push(`Started: ${new Date(start).toISOString()}`);
  log.push(``);

  // 0. Reset per-run state
  _allCache = null;
  _advancedIds.clear();

  // 0. Self-heal stage indexes — ensures pickOneByStage finds candidates
  // from legacy seeded data that pre-dates the indexed transitionStage path.
  try {
    const r = await stageIndexBackfill();
    log.push(`(index sync · ${r.added} leads · indexed)`);
    log.push(``);
  } catch {}

  // 1. Create 5 new signups
  log.push('STAGE 1 · NEW SIGNUPS');
  for (let i = 0; i < 5; i++) {
    await createSignup(Date.now(), log);
  }
  log.push('');

  // 2. Advance 4 inquiries → invited
  log.push('STAGE 2 · OPERATOR APPROVALS (inquiry → invited)');
  for (let i = 0; i < 4; i++) {
    if (!(await advanceOne('inquiry', 'approve', session, log))) break;
  }
  log.push('');

  // 3. Members upload NDAs (3 invited → nda_pending)
  log.push('STAGE 3 · MEMBER NDA UPLOADS (invited → nda_pending)');
  for (let i = 0; i < 3; i++) {
    if (!(await advanceOne('invited', 'upload_nda', session, log))) break;
  }
  log.push('');

  // 4. Approve NDAs (3 nda_pending → subscribed)
  log.push('STAGE 4 · NDA REVIEWS (nda_pending → subscribed)');
  for (let i = 0; i < 3; i++) {
    if (!(await advanceOne('nda_pending', 'approve_nda', session, log))) break;
  }
  log.push('');

  // 5. Issue wires (2 subscribed → wire_issued)
  log.push('STAGE 5 · WIRE ISSUE (subscribed → wire_issued)');
  for (let i = 0; i < 2; i++) {
    if (!(await advanceOne('subscribed', 'wire_issue', session, log))) break;
  }
  log.push('');

  // 6. Wires received (1 wire_issued → wire_received)
  log.push('STAGE 6 · WIRE RECEIVED (wire_issued → wire_received)');
  if (await advanceOne('wire_issued', 'wire_received', session, log)) {
    // ok
  }
  log.push('');

  // 7. Wires cleared & funded (1 wire_received → funded)
  log.push('STAGE 7 · ADMISSION (wire_received → funded)');
  if (await advanceOne('wire_received', 'wire_cleared', session, log)) {
    // ok
  }
  log.push('');

  // 8. MEMBER-SIDE actions — invited members redeem access codes
  log.push('STAGE 8 · MEMBER ACCESS (invited members redeem codes)');
  await runMemberCodeRedemptions(3, log);
  log.push('');

  // 9. MEMBER-SIDE — funded members log in to /portfolio
  log.push('STAGE 9 · MEMBER PORTFOLIO ACCESS (funded members log in)');
  await runMemberLogins(log);
  log.push('');

  // 10. MEMBER-SIDE — read in-portal messages
  log.push('STAGE 10 · MEMBER MESSAGE READS');
  await runMemberMessageReads(log);
  log.push('');

  // 11. MEMBER-SIDE — acknowledge pending capital calls
  log.push('STAGE 11 · MEMBER CAPITAL CALL ACKNOWLEDGEMENTS');
  await runMemberCapitalCallAcks(log);
  log.push('');

  // 12. MEMBER-SIDE — mark quarterly letters as read
  log.push('STAGE 12 · MEMBER QUARTERLY LETTER READS');
  await runMemberLetterReads(log);
  log.push('');

  const elapsedMs = Date.now() - start;
  const counts = await getStageCounts();
  log.push('FINAL PIPELINE');
  log.push(`  Inquiry:        ${counts.inquiry}`);
  log.push(`  Invited:        ${counts.invited}`);
  log.push(`  NDA Pending:    ${counts.nda_pending}`);
  log.push(`  Subscribed:     ${counts.subscribed}`);
  log.push(`  Wire Issued:    ${counts.wire_issued}`);
  log.push(`  Wire Received:  ${counts.wire_received}`);
  log.push(`  Funded:         ${counts.funded}`);
  log.push(`  TOTAL:          ${counts.total}`);
  log.push('');
  log.push(`Elapsed: ${elapsedMs}ms`);
  log.push(`Events emitted: ${log.filter((l)=>l.startsWith('+')||l.startsWith('→')||l.startsWith('✓')).length}`);
  log.push(`Estimated Upstash cmds: ~150`);
  log.push('');
  log.push('END OF SIMULATION');

  return {
    ok: true,
    started_at: start,
    elapsed_ms: elapsedMs,
    counts,
    log_text: log.join('\n'),
  };
}
