// api/v2.js — Unified dispatcher (Phase 1 + Phase 2).
// Routes by ?resource= and ?op= query params.
//
// Phase 1:
//   GET  ?resource=public&op=stats          — public member count
//   POST ?resource=admin&op=approve         — issue invite code + send email
//   GET  ?resource=admin&op=leads           — list all leads
//
// Phase 2 additions:
//   GET  ?resource=member&op=me             — full portfolio (delegates to portfolio.js)
//   POST ?resource=member&op=ack-capital-call
//   GET  ?resource=public&op=spot           — live gold spot (cached 15 min)
//   POST ?resource=admin&op=nda-approve
//   POST ?resource=admin&op=wire-issue
//   POST ?resource=admin&op=wire-received
//   POST ?resource=admin&op=wire-cleared    → triggers funded flow
//   POST ?resource=admin&op=send-message
//   POST ?resource=admin&op=issue-capital-call
//   GET  ?resource=admin&op=read-receipt
//   GET  ?resource=member&op=deals          — Prism bridge deal feed

import {
  ok, bad, unauthorized, notFound, methodNotAllowed, serverError,
  readBody, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, generateCode, COOKIE_ADMIN, COOKIE_MEMBER } from './_lib/auth.js';
import {
  getLead, saveLead, bindCode, listLeads, leadsCount,
  getCachedStats, setCachedStats,
  addCapitalCall, updateCapitalCall,
  addMessage, getMessages,
  markMemberFunded, isMemberNumberTaken, listFundedMembers,
  addQuarterlyLetter, markLetterRead,
  addVaultVerification, broadcastVaultVerification,
  saveTaxStatementUrl,
} from './_lib/storage.js';
import {
  sendInvitation, sendFundedConfirmation, sendWireInstructions,
  sendQuarterlyLetterNotification, sendVaultVerificationNotification,
} from './_lib/email.js';
import { generateMemberCertificate } from './_lib/pdf.js';

// Lazy import nanoid (ESM-only package)
async function nanoid() {
  const { nanoid: _nanoid } = await import('nanoid');
  return _nanoid(12);
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const q        = getQuery(req);
  const resource = String(q.resource || '').trim();
  const op       = String(q.op       || '').trim();

  switch (resource) {
    case 'public': return handlePublic(req, res, op);
    case 'member': return handleMember(req, res, op);
    case 'admin':  return handleAdmin(req, res, op);
    default:       return bad(res, `unknown resource: ${resource || '(none)'}`);
  }
}

// ── resource=public ───────────────────────────────────────────────────────────

async function handlePublic(req, res, op) {
  switch (op) {
    case 'stats':     return publicStats(req, res);
    case 'spot':      return publicSpot(req, res);
    case 'countdown': return publicCountdown(req, res);
    default:          return bad(res, `unknown public op: ${op}`);
  }
}

async function publicStats(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  try {
    const cached = await getCachedStats();
    if (cached) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      return ok(res, { ok: true, ...cached, cached: true });
    }
  } catch {}

  let stats;
  try {
    stats = await leadsCount();
  } catch (e) {
    console.error('[v2/public/stats]', e && e.message);
    return ok(res, { ok: true, admitted: 0, capacity: 100, remaining: 100 });
  }

  const payload = {
    admitted:  stats.admitted,
    capacity:  stats.capacity,
    remaining: Math.max(0, stats.capacity - stats.admitted),
  };

  try { await setCachedStats(payload); } catch {}
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  return ok(res, { ok: true, ...payload });
}

async function publicSpot(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  // Delegate to gold.js handler
  const goldHandler = (await import('./gold.js')).default;
  return goldHandler(req, res);
}

async function publicCountdown(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const targetEnv = process.env.TARGET_CLOSE_DATE;
  if (!targetEnv) {
    return ok(res, { ok: true, target_date: null });
  }

  const target = new Date(targetEnv);
  if (isNaN(target.getTime())) {
    return ok(res, { ok: true, target_date: null });
  }

  const now         = new Date();
  const msRemaining = target.getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
  const closed      = msRemaining <= 0;

  return ok(res, {
    ok:             true,
    target_date:    target.toISOString().slice(0, 10),
    days_remaining: closed ? 0 : daysRemaining,
    closed,
  });
}

// ── resource=member ───────────────────────────────────────────────────────────

async function requireMember(req) {
  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (!session || !session.leadId) return null;
  const lead = await getLead(session.leadId);
  if (!lead) return null;
  return lead;
}

async function handleMember(req, res, op) {
  switch (op) {
    case 'me':                return memberMe(req, res);
    case 'ack-capital-call':  return memberAckCapitalCall(req, res);
    case 'history':           return memberHistory(req, res);
    case 'letters':           return memberLetters(req, res);
    case 'vault-verifications': return memberVaultVerifications(req, res);
    case 'mark-letter-read':  return memberMarkLetterRead(req, res);
    case 'deals':             return memberDeals(req, res);
    default:                  return bad(res, `unknown member op: ${op}`);
  }
}

async function memberDeals(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  // Delegate to bridge.js handler
  const bridgeHandler = (await import('./bridge.js')).default;
  return bridgeHandler(req, res);
}

async function memberMe(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  // Delegate to portfolio.js
  const portfolioHandler = (await import('./portfolio.js')).default;
  return portfolioHandler(req, res);
}

async function memberAckCapitalCall(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const callId = String(body.capital_call_id || '').trim();
  if (!callId) return bad(res, 'capital_call_id required');

  const calls = lead.capital_calls || [];
  const idx   = calls.findIndex((c) => c.id === callId);
  if (idx === -1) return notFound(res);

  if (calls[idx].status === 'acknowledged') {
    return ok(res, { ok: true, message: 'already acknowledged' });
  }

  const now = Date.now();
  calls[idx].status        = 'acknowledged';
  calls[idx].acknowledged_at = now;

  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     now,
    actor:  lead.id,
    action: 'capital_call_acknowledged',
    meta:   { capital_call_id: callId },
  });

  try {
    await saveLead(lead);
  } catch (e) {
    return serverError(res, e);
  }

  return ok(res, { ok: true, capital_call_id: callId, acknowledged_at: now });
}

// ── member op=history ─────────────────────────────────────────────────────────

async function memberHistory(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  const entries = [];

  // System events from audit trail
  for (const a of (lead.audit || [])) {
    entries.push({
      type:     'system_event',
      date_iso: new Date(a.at).toISOString(),
      label:    a.action,
      meta:     a.meta || null,
    });
  }

  // Quarterly letters
  for (const l of (lead.quarterly_letters || [])) {
    entries.push({
      type:     'quarterly_letter',
      date_iso: l.sent_at,
      label:    l.subject || `Q${l.quarter} ${l.year} Fund Update`,
      meta:     { id: l.id, quarter: l.quarter, year: l.year, read_at: l.read_at || null },
    });
  }

  // Vault verifications
  for (const v of (lead.vault_verifications || [])) {
    entries.push({
      type:     'vault_verification',
      date_iso: v.published_at,
      label:    v.title || `Vault Verification ${v.year}`,
      meta:     { id: v.id, year: v.year, summary: v.summary || null },
    });
  }

  // Capital calls
  for (const c of (lead.capital_calls || [])) {
    entries.push({
      type:     'capital_call',
      date_iso: new Date(c.issued_at).toISOString(),
      label:    `Capital Call: ${c.ref}`,
      meta:     { id: c.id, ref: c.ref, amount_krw: c.amount_krw, due_date: c.due_date, status: c.status },
    });
  }

  // Sort descending by date
  entries.sort((a, b) => new Date(b.date_iso).getTime() - new Date(a.date_iso).getTime());

  return ok(res, { ok: true, history: entries });
}

// ── member op=letters ─────────────────────────────────────────────────────────

async function memberLetters(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  const letters = (lead.quarterly_letters || []).slice().sort(
    (a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()
  );

  return ok(res, { ok: true, letters });
}

// ── member op=vault-verifications ─────────────────────────────────────────────

async function memberVaultVerifications(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  const vvs = (lead.vault_verifications || []).map((v) => ({
    id:           v.id,
    title:        v.title,
    year:         v.year,
    summary:      v.summary || null,
    published_at: v.published_at,
    blob_pathname: v.blob_pathname || null,
    // Surface a stable doc URL for the member to download
    download_url: `/api/doc?id=vault-verification-${v.id}`,
  }));

  vvs.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  return ok(res, { ok: true, vault_verifications: vvs });
}

// ── member op=mark-letter-read ────────────────────────────────────────────────

async function memberMarkLetterRead(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const letterId = String(body.letter_id || '').trim();
  if (!letterId) return bad(res, 'letter_id required');

  try {
    const letter = await markLetterRead(lead.id, letterId);
    return ok(res, { ok: true, letter_id: letterId, read_at: letter.read_at });
  } catch (e) {
    if (e.message.includes('not found')) return notFound(res);
    return serverError(res, e);
  }
}

// ── resource=admin ────────────────────────────────────────────────────────────

async function handleAdmin(req, res, op) {
  const session = await verifyToken(getCookie(req, COOKIE_ADMIN));
  if (!session || session.sub !== 'admin') return unauthorized(res);

  switch (op) {
    case 'approve':                 return adminApprove(req, res, session);
    case 'leads':                   return adminLeads(req, res, session);
    case 'nda-approve':             return adminNdaApprove(req, res, session);
    case 'wire-issue':              return adminWireIssue(req, res, session);
    case 'wire-received':           return adminWireReceived(req, res, session);
    case 'wire-cleared':            return adminWireCleared(req, res, session);
    case 'send-message':            return adminSendMessage(req, res, session);
    case 'issue-capital-call':      return adminIssueCapitalCall(req, res, session);
    case 'read-receipt':            return adminReadReceipt(req, res, session);
    case 'send-quarterly-letter':   return adminSendQuarterlyLetter(req, res, session);
    case 'publish-vault-verification': return adminPublishVaultVerification(req, res, session);
    case 'generate-tax-statement':  return adminGenerateTaxStatement(req, res, session);
    case 'letters':                 return adminLetters(req, res, session);
    case 'tax-statements':          return adminTaxStatements(req, res, session);
    case 'seed-demo':               return adminSeedDemo(req, res, session);
    default:                        return bad(res, `unknown admin op: ${op}`);
  }
}

// ── admin op=seed-demo (DEMO ONLY) ───────────────────────────────────────────
// Populates fake leads spanning all 6 pipeline stages so the admin and
// portfolio screens render with realistic content. No emails sent. No PDFs.

async function adminSeedDemo(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const fixtures = [
    // 1. Inquiry — just submitted
    {
      stage: 'inquiry',
      name: '김민수',                                // Kim Min-su
      email: 'demo.kim@example.com',
      country: 'KR',
      occupation: 'Family office principal',
      assets: '5_10m',
      created_at: now - 1 * day,
    },
    // 2. Invited — code issued, NDA awaiting
    {
      stage: 'invited',
      name: '이지훈',                                // Lee Ji-hoon
      email: 'demo.lee@example.com',
      country: 'KR',
      occupation: 'Tech founder',
      assets: '10_25m',
      created_at: now - 5 * day,
    },
    // 3. NDA pending review
    {
      stage: 'nda_pending',
      name: '박서연',                                // Park Seo-yeon
      email: 'demo.park@example.com',
      country: 'KR',
      occupation: 'Hedge fund partner',
      assets: '25_50m',
      created_at: now - 8 * day,
    },
    // 4. Subscribed — awaiting wire
    {
      stage: 'subscribed',
      name: '최예진',                                // Choi Ye-jin
      email: 'demo.choi@example.com',
      country: 'KR',
      occupation: 'Private investor',
      assets: '10_25m',
      kg_requested: 2,
      created_at: now - 12 * day,
    },
    // 5. Wire issued — instructions sent
    {
      stage: 'wire_issued',
      name: '정도현',                                // Jung Do-hyun
      email: 'demo.jung@example.com',
      country: 'KR',
      occupation: 'Real estate principal',
      assets: '25_50m',
      kg_requested: 3,
      created_at: now - 18 * day,
    },
    // 6. Wire received — pending clearance
    {
      stage: 'wire_received',
      name: '한지영',                                // Han Ji-young
      email: 'demo.han@example.com',
      country: 'KR',
      occupation: 'Bank executive',
      assets: '5_10m',
      kg_requested: 1,
      created_at: now - 22 * day,
    },
    // 7. Funded — full member, member #001
    {
      stage: 'funded',
      name: '윤상호',                                // Yoon Sang-ho
      email: 'demo.yoon@example.com',
      country: 'KR',
      occupation: 'Founding partner',
      assets: '50m_plus',
      kg_requested: 5,
      member_number: 1,
      created_at: now - 35 * day,
      with_capital_call: true,
    },
    // 8. Funded — member #002, with messages
    {
      stage: 'funded',
      name: '강수민',                                // Kang Su-min
      email: 'demo.kang@example.com',
      country: 'KR',
      occupation: 'Asset manager',
      assets: '25_50m',
      kg_requested: 2,
      member_number: 2,
      created_at: now - 30 * day,
      with_messages: true,
    },
  ];

  const seeded = [];
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const id = `demo_${(now + i).toString(36)}`;
    const lead = buildDemoLead(id, f, now);
    try { await saveLead(lead); seeded.push({ id, name: f.name, stage: f.stage }); } catch (e) {
      console.error('[seed-demo]', f.name, e);
    }
  }

  return ok(res, { ok: true, seeded: seeded.length, leads: seeded });
}

function buildDemoLead(id, f, now) {
  const day = 24 * 60 * 60 * 1000;
  const code = `DEMO${String(Math.abs(id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 9999).padStart(4, '0')}`;

  const lead = {
    id,
    demo: true,
    name: f.name,
    legal_name: f.name,
    email: f.email,
    country: f.country,
    occupation: f.occupation,
    investable_assets: f.assets,
    referral_source: 'personal_intro',
    reverse_solicitation_ack: true,
    created_at: f.created_at,
    audit: [{ at: f.created_at, actor: 'system', action: 'demo_seed' }],
    status: 'inquiry',
    nda_state: 'awaiting',
  };

  if (f.stage === 'inquiry') return lead;

  // Invited+
  lead.status = 'invited';
  lead.code = code;
  lead.code_issued_at = f.created_at + 1 * day;
  lead.audit.push({ at: lead.code_issued_at, actor: 'admin', action: 'invitation_sent' });

  if (f.stage === 'invited') return lead;

  // NDA pending+
  lead.nda_state = 'uploaded';
  lead.nda_uploaded_at = f.created_at + 2 * day;
  lead.nda_url = 'https://example.com/demo-nda.pdf';

  if (f.stage === 'nda_pending') return lead;

  // Subscribed+
  lead.nda_state = 'approved';
  lead.nda_approved_at = f.created_at + 3 * day;
  lead.status = 'subscribed';
  const kg = f.kg_requested || 1;
  const usdPerKg = 112000; // ~spot $3500/oz × 32.15 oz/kg
  lead.subscription = {
    kg_requested: kg,
    usd_amount: kg * usdPerKg,
    submitted_at: f.created_at + 4 * day,
    signature: f.name.toLowerCase(),
    ltv_acknowledged: true,
  };
  lead.audit.push({ at: lead.subscription.submitted_at, actor: 'member', action: 'subscription_submitted' });

  if (f.stage === 'subscribed') return lead;

  // Wire issued+
  const wireRef = `TACC-${id.slice(-8).toUpperCase()}-${(now).toString(36).toUpperCase()}`;
  lead.wire = {
    reference: wireRef,
    instructions_sent_at: f.created_at + 5 * day,
  };
  lead.audit.push({ at: lead.wire.instructions_sent_at, actor: 'admin', action: 'wire_instructions_sent' });

  if (f.stage === 'wire_issued') return lead;

  // Wire received+
  lead.wire.received_at = f.created_at + 7 * day;
  lead.audit.push({ at: lead.wire.received_at, actor: 'admin', action: 'wire_received' });

  if (f.stage === 'wire_received') return lead;

  // Funded
  lead.wire.cleared_at = f.created_at + 8 * day;
  lead.status = 'funded';
  lead.member_number = f.member_number;
  lead.funded_at = lead.wire.cleared_at;
  lead.audit.push({ at: lead.funded_at, actor: 'system', action: 'funded' });

  // Bars (1kg each)
  lead.bars = [];
  for (let i = 0; i < kg; i++) {
    lead.bars.push({
      id: `bar_${id}_${i}`,
      serial: `LBMA-${(800000 + i * 17 + lead.member_number * 31).toString()}`,
      refiner: ['PAMP Suisse', 'Valcambi', 'Argor-Heraeus'][i % 3],
      year: 2025,
      weight_kg: 1,
      assigned_at: lead.funded_at,
      vault_location: 'Malca-Amit Singapore FTZ',
    });
  }

  // Capital call (member 1)
  if (f.with_capital_call) {
    lead.capital_calls = [{
      id: `cc_${id}_1`,
      issued_at: now - 5 * day,
      due_date: now + 10 * day,
      amount_usd: 50000,
      reason: 'Q1 2026 private credit deployment — Tier 1 facility',
      status: 'pending',
      acknowledged_at: null,
    }];
  }

  // Messages (member 2)
  if (f.with_messages) {
    lead.messages = [
      {
        id: `msg_${id}_1`,
        sent_at: now - 14 * day,
        from: 'partner',
        from_name: 'TKJ',
        subject: 'Welcome to the Century Club',
        body: 'Your membership is confirmed. Allocation #002. Onboarding documents attached separately.',
        read_at: now - 13 * day,
      },
      {
        id: `msg_${id}_2`,
        sent_at: now - 3 * day,
        from: 'partner',
        from_name: 'JWC',
        subject: 'Q2 2026 Quarterly Update',
        body: 'Letter is now available in Documents. NAV up 3.4% quarter-over-quarter.',
        read_at: null,
      },
    ];
  }

  return lead;
}

// ── admin op=approve (Phase 1) ────────────────────────────────────────────────

async function adminApprove(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId = String(body.leadId || body.id || '').trim();
  if (!leadId) return bad(res, 'leadId required');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  if (lead.status !== 'inquiry' && lead.status !== 'invited') {
    return bad(res, `Lead status is '${lead.status}' — cannot approve.`);
  }

  const actor = session.id || session.email || 'admin';
  const now   = Date.now();
  const code  = generateCode();

  try { await bindCode(leadId, code); }
  catch (e) { return serverError(res, e); }

  lead.code           = code;
  lead.code_issued_at = now;
  lead.status         = 'invited';
  if (!lead.nda_state) lead.nda_state = 'awaiting';
  lead.audit = lead.audit || [];
  lead.audit.push({ at: now, actor, action: 'admin_approved', code });

  try { await saveLead(lead); }
  catch (e) { return serverError(res, e); }

  let emailResult = { sent: false, reason: 'skipped' };
  if (body.send_email !== false && lead.email) {
    try {
      emailResult = await sendInvitation(lead, code);
      if (emailResult.sent) {
        lead.audit.push({ at: Date.now(), actor, action: 'invitation_sent', to: lead.email });
        await saveLead(lead).catch(() => {});
      }
    } catch (e) {
      console.warn('[v2/admin/approve] sendInvitation error:', e && e.message);
      emailResult = { sent: false, reason: 'send-error' };
    }
  }

  return ok(res, {
    ok: true, code,
    lead:  { id: lead.id, name: lead.name, email: lead.email, status: lead.status },
    email: emailResult,
  });
}

// ── admin op=leads (Phase 1) ──────────────────────────────────────────────────

async function adminLeads(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const q      = getQuery(req);
  const status = q.status || undefined;
  const limit  = Math.min(200, Math.max(1, parseInt(q.limit  || '100', 10)));
  const offset = Math.max(0, parseInt(q.offset || '0', 10));

  let leads;
  try { leads = await listLeads({ status, limit, offset }); }
  catch (e) { return serverError(res, e); }

  const safeLeads = leads.map((l) => ({
    id:            l.id,
    name:          l.name            || null,
    email:         l.email           || null,
    country:       l.country         || null,
    wealth:        l.wealth          || null,
    referral:      l.referral        || null,
    status:        l.status          || 'inquiry',
    nda_state:     l.nda_state       || null,
    code:          l.code            || null,
    code_issued_at: l.code_issued_at || null,
    created_at:    l.created_at      || null,
    last_login_at: l.last_login_at   || null,
    wire_cleared:  !!(l.wire && l.wire.cleared_at),
    member_number: l.member_number   || null,
    subscription:  l.subscription ? { kg_requested: l.subscription.kg_requested, submitted_at: l.subscription.submitted_at } : null,
  }));

  return ok(res, { ok: true, leads: safeLeads, count: safeLeads.length });
}

// ── admin op=nda-approve ──────────────────────────────────────────────────────

async function adminNdaApprove(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId = String(body.leadId || '').trim();
  if (!leadId) return bad(res, 'leadId required');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const actor = session.id || session.email || 'admin';
  const now   = Date.now();

  lead.nda_state       = 'approved';
  lead.nda_approved_at = now;
  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     now,
    actor,
    action: 'nda_approved',
    meta:   { notes: body.notes || null },
  });

  try { await saveLead(lead); }
  catch (e) { return serverError(res, e); }

  // Notify member
  try {
    const { sendRaw } = await import('./_lib/email.js');
    const siteUrl = process.env.SITE_URL || 'https://www.theaurumcc.com';
    await sendRaw({
      to:      lead.email,
      subject: 'Your NDA has been approved — The Aurum Century Club',
      html:    `<p>Dear ${lead.name || 'Member'},</p><p>Your confidentiality agreement has been reviewed and approved. You may now proceed to complete your subscription.</p><p><a href="${siteUrl}/subscription">Complete Subscription →</a></p><p>— The Aurum Team</p>`,
      text:    `Dear ${lead.name || 'Member'},\n\nYour confidentiality agreement has been reviewed and approved. You may now proceed to complete your subscription at ${siteUrl}/subscription\n\n— The Aurum Team`,
    });
  } catch (e) {
    console.warn('[v2/admin/nda-approve] member notification failed:', e && e.message);
  }

  return ok(res, {
    ok:  true,
    lead: { id: lead.id, name: lead.name, email: lead.email, nda_state: lead.nda_state },
  });
}

// ── admin op=wire-issue ───────────────────────────────────────────────────────

async function adminWireIssue(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId = String(body.leadId || '').trim();
  if (!leadId) return bad(res, 'leadId required');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const actor = session.id || session.email || 'admin';
  const now   = Date.now();

  const prefix   = process.env.WIRE_REFERENCE_PREFIX || 'TACC';
  const ref      = `${prefix}-${lead.id.slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  lead.wire = lead.wire || {};
  lead.wire.reference          = ref;
  lead.wire.instructions_sent_at = now;
  lead.audit = lead.audit || [];
  lead.audit.push({ at: now, actor, action: 'wire_instructions_issued', meta: { ref } });

  try { await saveLead(lead); }
  catch (e) { return serverError(res, e); }

  const wireDetails = {
    reference:       ref,
    bank:            process.env.WIRE_BANK_NAME      || '',
    account_name:    process.env.WIRE_ACCOUNT_NAME   || '',
    account_number:  process.env.WIRE_ACCOUNT_NUMBER || '',
    swift:           process.env.WIRE_SWIFT          || '',
    amount_usd:      body.amount_usd || null,
  };

  try {
    await sendWireInstructions(lead, wireDetails);
  } catch (e) {
    console.warn('[v2/admin/wire-issue] sendWireInstructions failed:', e && e.message);
  }

  return ok(res, { ok: true, wire: wireDetails });
}

// ── admin op=wire-received ────────────────────────────────────────────────────

async function adminWireReceived(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId    = String(body.leadId || '').trim();
  const amountUsd = Number(body.amount_usd);
  if (!leadId)                         return bad(res, 'leadId required');
  if (!isFinite(amountUsd) || amountUsd <= 0) return bad(res, 'amount_usd must be a positive number');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const actor = session.id || session.email || 'admin';
  const now   = Date.now();

  lead.wire = lead.wire || {};
  lead.wire.received_at = now;
  lead.wire.amount_usd  = amountUsd;
  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     now,
    actor,
    action: 'wire_received',
    meta:   { amount_usd: amountUsd },
  });

  try { await saveLead(lead); }
  catch (e) { return serverError(res, e); }

  return ok(res, {
    ok:   true,
    lead: { id: lead.id, name: lead.name, email: lead.email, wire: { received_at: now, amount_usd: amountUsd } },
  });
}

// ── admin op=wire-cleared → funded flow ───────────────────────────────────────

async function adminWireCleared(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId       = String(body.leadId || '').trim();
  const memberNumber = parseInt(body.member_number, 10);
  if (!leadId)                                          return bad(res, 'leadId required');
  if (!Number.isInteger(memberNumber) || memberNumber < 1 || memberNumber > 100) {
    return bad(res, 'member_number must be an integer between 1 and 100');
  }

  // Check uniqueness
  const taken = await isMemberNumberTaken(memberNumber);
  if (taken) return bad(res, `Member number ${memberNumber} is already assigned.`, 409);

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const actor = session.id || session.email || 'admin';
  const now   = Date.now();

  // Record cleared timestamp before markMemberFunded sets it
  lead.wire = lead.wire || {};
  lead.wire.cleared_at = now;
  await saveLead(lead).catch(() => {});

  // markMemberFunded handles status, member_number, audit
  let updatedLead;
  try {
    updatedLead = await markMemberFunded(leadId, memberNumber);
  } catch (e) {
    return serverError(res, e);
  }

  // Generate member certificate
  let certificateUrl = null;
  try {
    const result = await generateMemberCertificate(updatedLead);
    certificateUrl = result.url;
    updatedLead.certificate_url = certificateUrl;
    updatedLead.audit = updatedLead.audit || [];
    updatedLead.audit.push({
      at:     Date.now(),
      actor:  'system',
      action: 'certificate_generated',
      meta:   { url: certificateUrl },
    });
    await saveLead(updatedLead);
  } catch (e) {
    console.error('[v2/admin/wire-cleared] certificate generation failed:', e && e.message);
  }

  // Send funded confirmation email
  try {
    await sendFundedConfirmation(updatedLead);
  } catch (e) {
    console.warn('[v2/admin/wire-cleared] sendFundedConfirmation failed:', e && e.message);
  }

  return ok(res, {
    ok:              true,
    lead: {
      id:            updatedLead.id,
      name:          updatedLead.name,
      email:         updatedLead.email,
      status:        updatedLead.status,
      member_number: updatedLead.member_number,
    },
    certificate_url: certificateUrl,
  });
}

// ── admin op=send-message ─────────────────────────────────────────────────────

async function adminSendMessage(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const { recipients, type, subject, body: msgBody } = body;

  if (!subject || !msgBody) return bad(res, 'subject and body are required');
  if (!['gold', 'blue', 'amber'].includes(type)) return bad(res, 'type must be gold, blue, or amber');

  const actor  = session.id || session.email || 'admin';
  const sentAt = new Date().toISOString();

  // Resolve recipient lead IDs
  let targetLeads = [];
  if (recipients === 'all') {
    targetLeads = await listLeads({ limit: 200 });
  } else if (Array.isArray(recipients)) {
    for (const lid of recipients) {
      const l = await getLead(String(lid).trim());
      if (l) targetLeads.push(l);
    }
  } else {
    return bad(res, 'recipients must be "all" or an array of leadIds');
  }

  if (!targetLeads.length) return bad(res, 'no valid recipients found');

  const msgId  = await nanoid();
  const message = {
    id:      msgId,
    type,
    subject: String(subject),
    body:    String(msgBody),
    sent_at: sentAt,
    read_at: null,
    sender:  'admin',
  };

  let successCount = 0;
  const errors = [];
  for (const lead of targetLeads) {
    try {
      await addMessage(lead.id, { ...message });
      successCount++;
    } catch (e) {
      errors.push({ leadId: lead.id, error: e.message });
    }
  }

  return ok(res, {
    ok:            true,
    message_id:    msgId,
    sent_to:       successCount,
    total:         targetLeads.length,
    errors:        errors.length ? errors : undefined,
  });
}

// ── admin op=issue-capital-call ───────────────────────────────────────────────

async function adminIssueCapitalCall(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const { ref, amount_krw, due_date, wire_details, notes } = body;
  if (!ref)        return bad(res, 'ref is required');
  if (!amount_krw) return bad(res, 'amount_krw is required');
  if (!due_date)   return bad(res, 'due_date is required');

  const actor    = session.id || session.email || 'admin';
  const issuedAt = Date.now();
  const callId   = await nanoid();

  const capitalCall = {
    id:           callId,
    ref:          String(ref),
    amount_krw:   Number(amount_krw),
    due_date:     String(due_date),
    wire_details: wire_details || null,
    notes:        notes       || null,
    status:       'pending',
    issued_at:    issuedAt,
    acknowledged_at: null,
  };

  // Issue to all funded members
  const funded = await listFundedMembers();
  if (!funded.length) return bad(res, 'no funded members to issue capital call to');

  let successCount = 0;
  for (const lead of funded) {
    try {
      await addCapitalCall(lead.id, { ...capitalCall });

      // Send amber in-portal message
      const msgId = await nanoid();
      await addMessage(lead.id, {
        id:      msgId,
        type:    'amber',
        subject: `Capital Call: ${ref}`,
        body:    `A capital call has been issued.\n\nReference: ${ref}\nAmount: ₩${Number(amount_krw).toLocaleString()}\nDue: ${due_date}\n${notes ? '\nNotes: ' + notes : ''}`,
        sent_at: new Date(issuedAt).toISOString(),
        read_at: null,
        sender:  'admin',
      });

      successCount++;
    } catch (e) {
      console.warn(`[v2/admin/issue-capital-call] lead ${lead.id} failed:`, e && e.message);
    }
  }

  return ok(res, {
    ok:          true,
    capital_call_id: callId,
    issued_to:   successCount,
    total:       funded.length,
  });
}

// ── admin op=read-receipt ─────────────────────────────────────────────────────

async function adminReadReceipt(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const q         = getQuery(req);
  const messageId = String(q.message_id || '').trim();
  if (!messageId) return bad(res, 'message_id query param required');

  const allLeads = await listLeads({ limit: 200 });
  const receipts = [];

  for (const lead of allLeads) {
    const messages = lead.messages || [];
    const msg = messages.find((m) => m.id === messageId);
    if (!msg) continue;
    receipts.push({
      lead_id:       lead.id,
      member_number: lead.member_number || null,
      name:          lead.name          || null,
      email:         lead.email         || null,
      read_at:       msg.read_at        || null,
    });
  }

  return ok(res, {
    ok:           true,
    message_id:   messageId,
    recipients:   receipts,
    total:        receipts.length,
    read_count:   receipts.filter((r) => r.read_at).length,
  });
}

// ── admin op=send-quarterly-letter ────────────────────────────────────────────

async function adminSendQuarterlyLetter(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const quarter = parseInt(body.quarter, 10);
  const year    = parseInt(body.year,    10);

  if (![1, 2, 3, 4].includes(quarter)) return bad(res, 'quarter must be 1, 2, 3, or 4');
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return bad(res, 'year is invalid');
  if (!body.subject)   return bad(res, 'subject required');
  if (!body.html_body) return bad(res, 'html_body required');

  const funded = await listFundedMembers();
  if (!funded.length) return bad(res, 'no funded members to send letter to');

  const { nanoid: _nanoid } = await import('nanoid');
  const letterId  = _nanoid(12);
  const sentAt    = new Date().toISOString();
  const actor     = session.id || session.email || 'admin';

  const letter = {
    id:        letterId,
    quarter,
    year,
    subject:   String(body.subject),
    html_body: String(body.html_body),
    sent_at:   sentAt,
    read_at:   null,
    sender:    actor,
  };

  let successCount = 0;
  const errors = [];

  for (const lead of funded) {
    try {
      await addQuarterlyLetter(lead.id, { ...letter });
      successCount++;
      // Email notification — failures must not abort the loop
      try {
        await sendQuarterlyLetterNotification(lead, letter);
      } catch (emailErr) {
        console.warn(`[v2/admin/send-quarterly-letter] email failed for ${lead.id}:`, emailErr && emailErr.message);
      }
    } catch (e) {
      console.warn(`[v2/admin/send-quarterly-letter] store failed for ${lead.id}:`, e && e.message);
      errors.push({ leadId: lead.id, error: e.message });
    }
  }

  return ok(res, {
    ok:        true,
    letter_id: letterId,
    sent_to:   successCount,
    total:     funded.length,
    errors:    errors.length ? errors : undefined,
  });
}

// ── admin op=publish-vault-verification ───────────────────────────────────────

async function adminPublishVaultVerification(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  if (!body.title)         return bad(res, 'title required');
  if (!body.year)          return bad(res, 'year required');

  const { nanoid: _nanoid } = await import('nanoid');
  const vvId       = _nanoid(12);
  const publishedAt = new Date().toISOString();

  const vv = {
    id:           vvId,
    title:        String(body.title),
    year:         parseInt(body.year, 10),
    summary:      body.summary   ? String(body.summary)   : null,
    blob_pathname: body.blob_pathname ? String(body.blob_pathname) : null,
    published_at: publishedAt,
  };

  const { sent_to, total, errors } = await broadcastVaultVerification(vv);

  // Send email notifications — failures logged, do not abort
  const funded = await listFundedMembers();
  for (const lead of funded) {
    try {
      await sendVaultVerificationNotification(lead, vv);
    } catch (e) {
      console.warn(`[v2/admin/publish-vault-verification] email failed for ${lead.id}:`, e && e.message);
    }
  }

  return ok(res, {
    ok:      true,
    vv_id:   vvId,
    sent_to,
    total,
    errors:  errors && errors.length ? errors : undefined,
  });
}

// ── admin op=generate-tax-statement ──────────────────────────────────────────

async function adminGenerateTaxStatement(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId       = String(body.leadId || '').trim();
  const fiscalYear   = parseInt(body.fiscal_year, 10);
  const goldStart    = Number(body.gold_price_start);
  const goldEnd      = Number(body.gold_price_end);

  if (!leadId)                                     return bad(res, 'leadId required');
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2020) return bad(res, 'fiscal_year invalid');
  if (!isFinite(goldStart) || goldStart <= 0)      return bad(res, 'gold_price_start must be a positive number');
  if (!isFinite(goldEnd)   || goldEnd   <= 0)      return bad(res, 'gold_price_end must be a positive number');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const fxRates = {
    krw_start: Number(body.krw_start) || 1,
    krw_end:   Number(body.krw_end)   || 1,
    sgd_start: Number(body.sgd_start) || 1,
    sgd_end:   Number(body.sgd_end)   || 1,
  };

  let result;
  try {
    const { generateTaxStatement } = await import('./_lib/pdf.js');
    result = await generateTaxStatement(lead, fiscalYear, goldStart, goldEnd, fxRates);
  } catch (e) {
    console.error('[v2/admin/generate-tax-statement] pdf generation failed:', e && e.message);
    return serverError(res, e);
  }

  try {
    await saveTaxStatementUrl(leadId, fiscalYear, result.url);
  } catch (e) {
    console.error('[v2/admin/generate-tax-statement] saveTaxStatementUrl failed:', e && e.message);
    // Non-fatal — PDF was generated successfully; return url anyway
  }

  return ok(res, { ok: true, url: result.url, fiscal_year: fiscalYear });
}

// ── admin op=letters ──────────────────────────────────────────────────────────

async function adminLetters(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const funded = await listFundedMembers();
  if (!funded.length) return ok(res, { ok: true, letters: [] });

  // Collect unique letters by id, accumulating read/recipient counts
  const byId = new Map();

  for (const lead of funded) {
    for (const l of (lead.quarterly_letters || [])) {
      if (byId.has(l.id)) {
        const entry = byId.get(l.id);
        entry.recipient_count++;
        if (l.read_at) entry.read_count++;
      } else {
        byId.set(l.id, {
          id:              l.id,
          quarter:         l.quarter,
          year:            l.year,
          subject:         l.subject,
          sent_at:         l.sent_at,
          recipient_count: 1,
          read_count:      l.read_at ? 1 : 0,
        });
      }
    }
  }

  // Sort by sent_at descending
  const letters = [...byId.values()].sort(
    (a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()
  );

  return ok(res, { ok: true, letters });
}

// ── admin op=tax-statements ───────────────────────────────────────────────────

async function adminTaxStatements(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const funded = await listFundedMembers();

  const results = funded.map((l) => ({
    leadId:        l.id,
    name:          l.name          || null,
    member_number: l.member_number || null,
    statements:    l.tax_statements || {},
  }));

  return ok(res, { ok: true, tax_statements: results });
}
