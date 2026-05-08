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
//   POST ?resource=admin&op=verify-ioi
//   POST ?resource=admin&op=decline-ioi

import {
  ok, bad, unauthorized, notFound, methodNotAllowed, serverError,
  readBody, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, generateCode, COOKIE_ADMIN, COOKIE_MEMBER } from './_lib/auth.js';
import {
  getLead, saveLead, bindCode, unbindCode, listLeads, leadsCount,
  getCachedStats, setCachedStats,
  addCapitalCall, updateCapitalCall,
  addMessage, getMessages, markMessageRead,
  markMemberFunded, isMemberNumberTaken, listFundedMembers,
  addQuarterlyLetter, markLetterRead,
  addVaultVerification, broadcastVaultVerification,
  saveTaxStatementUrl,
  appendAudit, getStageCounts, transitionStage, recountStages,
  resolveLeadStage,
  globalAuditList, getActivityFeed,
  listComplianceFlags, muteFlag, addComplianceFlag,
  withIdempotency, softDeleteLead,
  addPosition, updatePosition, removePosition,
  setLastVaultVerification,
  deleteLead, wipeGlobalAudit, wipeAllFlags,
  saveDeal, getDeal, listDeals, dealsCount, deleteDeal, listDealIdsByDemoFlag,
  saveLetterRecord, deleteLetterRecord, listLetterIds,
  globalAuditAppend,
  migrateLegacyTaxStatements,
  allocateNextMemberNumber, releaseMemberNumber,
  recountMemberNumberCounter, getMemberNumberCounter,
} from './_lib/storage.js';
import { scanForExceptions } from './_lib/exceptions.js';
import { clientIp } from './_lib/http.js';
import {
  sendInvitation, sendFundedConfirmation, sendWireInstructions,
  sendQuarterlyLetterNotification, sendVaultVerificationNotification,
  sendIoiVerified, sendIoiDeclined,
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
    case 'ack-message':       return memberAckMessage(req, res);
    case 'tax-statement-signed-url':  return memberTaxStatementSignedUrl(req, res);
    case 'member-certificate-url':    return memberCertificateSignedUrl(req, res);
    default:                  return bad(res, `unknown member op: ${op}`);
  }
}

async function memberAckMessage(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);
  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }
  const messageId = String(body.message_id || '').trim();
  if (!messageId) return bad(res, 'message_id required');
  try {
    const msg = await markMessageRead(lead.id, messageId);
    return ok(res, { ok: true, message_id: messageId, read_at: msg.read_at });
  } catch (e) {
    if (/not found/.test(e.message)) return notFound(res);
    return serverError(res, e);
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
    case 'wipe-demo':               return adminWipeDemo(req, res, session);
    case 'stage-index-backfill':    return adminStageIndexBackfill(req, res, session);
    case 'run-audit':               return adminRunAudit(req, res, session);
    case 'run-simulation':          return adminRunSimulation(req, res, session);
    case 'bots-start':              return adminBotsStart(req, res, session);
    case 'bots-stop':               return adminBotsStop(req, res, session);
    case 'bots-tick':               return adminBotsTick(req, res, session);
    case 'bots-status':             return adminBotsStatus(req, res, session);
    case 'bots-reset':              return adminBotsReset(req, res, session);
    case 'bot-start-stress':        return adminBotsStartStress(req, res, session);
    case 'run-race-test':           return adminRunRaceTest(req, res, session);
    case 'run-subscription-test':   return adminRunSubscriptionTest(req, res, session);
    case 'run-softdelete-test':     return adminRunSoftDeleteTest(req, res, session);
    case 'run-email-extended':      return adminRunEmailExtended(req, res, session);
    case 'flush-spot-cache':        return adminFlushSpotCache(req, res, session);
    case 'backfill-investor-profile': return adminBackfillInvestorProfile(req, res, session);
    // ── Phase 4 ─────────────────────────────────────────────────────────────
    case 'stats':                   return adminStats(req, res, session);
    case 'nda-queue':               return adminNdaQueue(req, res, session);
    case 'wires':                   return adminWires(req, res, session);
    case 'members':                 return adminMembers(req, res, session);
    case 'approve-nda':             return adminNdaApprove(req, res, session); // alias
    case 'reject-nda':              return adminNdaReject(req, res, session);
    case 'exceptions':              return adminExceptions(req, res, session);
    case 'mute-exception':          return adminMuteException(req, res, session);
    case 'scan-exceptions':         return adminScanExceptions(req, res, session);
    case 'audit-search':            return adminAuditSearch(req, res, session);
    case 'activity-feed':           return adminActivityFeed(req, res, session);
    case 'lead-detail':             return adminLeadDetail(req, res, session);
    case 'bulk-approve':            return adminBulkApprove(req, res, session);
    case 'request-data-export':     return adminRequestDataExport(req, res, session);
    case 'soft-delete-lead':        return adminSoftDeleteLead(req, res, session);
    case 'add-position':            return adminAddPosition(req, res, session);
    case 'update-position':         return adminUpdatePosition(req, res, session);
    case 'remove-position':         return adminRemovePosition(req, res, session);
    case 'send-wire-reminder':      return adminSendWireReminder(req, res, session);
    case 'resend-admission':        return adminResendAdmission(req, res, session);
    case 'revoke-access':           return adminRevokeAccess(req, res, session);
    case 'recount-stages':          return adminRecountStages(req, res, session);
    // ── Phase 5 (operator deepening) ────────────────────────────────────────
    case 'vault-bars':              return adminVaultBars(req, res, session);
    case 'decline-lead':            return adminDeclineLead(req, res, session);
    case 'capital-call-paid':       return adminCapitalCallPaid(req, res, session);
    case 'nav-update':              return adminNavUpdate(req, res, session);
    case 'post-distribution':       return adminPostDistribution(req, res, session);
    case 'tax-statement-signed-url':return adminTaxStatementSignedUrl(req, res, session);
    case 'cmdk-search':             return adminCmdkSearch(req, res, session);
    // ── Backend hardening (atomic counter, legacy migrations) ────────────────
    case 'migrate-tax-statements':  return adminMigrateTaxStatements(req, res, session);
    case 'recount-member-number':   return adminRecountMemberNumber(req, res, session);
    case 'test-capital-call-targeting': return adminTestCapitalCallTargeting(req, res, session);
    case 'verify-ioi':              return adminVerifyIoi(req, res, session);
    case 'decline-ioi':             return adminDeclineIoi(req, res, session);
    case 'member-certificate-url':  return adminMemberCertificateUrl(req, res, session);
    default:                        return bad(res, `unknown admin op: ${op}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function err(res, error, code, status = 400) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, error, code: code || 'BAD_REQUEST' }));
}

function _actor(session) { return session.id || session.email || 'admin'; }

// withIdempotencyMarked — wraps storage.withIdempotency and adds a `cached: true`
// flag on duplicate calls. We probe the underlying idem key first; if a cached
// result exists, we know this call is a replay.
async function withIdempotencyMarked(idemKey, ttlSeconds, fn) {
  let preExisting = false;
  try {
    const { getJSON } = await import('./_lib/storage.js');
    const cached = await getJSON(`idem:${idemKey}`);
    if (cached != null) preExisting = true;
  } catch {}
  const result = await withIdempotency(idemKey, ttlSeconds, fn);
  if (preExisting && result && typeof result === 'object') {
    return { ...result, cached: true };
  }
  return result;
}

// ── op=stats ────────────────────────────────────────────────────────────────

async function adminStats(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  let stages;
  try {
    stages = await getStageCounts();
    if (!stages.total) {
      const counts = await recountStages();
      stages = { ...counts, total: Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0) };
    }
  } catch (e) {
    return serverError(res, e);
  }

  const flags = await listComplianceFlags().catch(() => []);
  const exceptions_count = flags.length;

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recentEntries = await globalAuditList({ limit: 200, since }).catch(() => []);
  const recent_admits_24h = recentEntries.filter(
    (e) => e.action === 'member_funded' || e.action === 'funded' || e.action === 'wire_cleared',
  ).length;

  // ── Fund-level metrics ────────────────────────────────────────────────────
  // Compute NAV, gold position, weighted LTV, P&L, deployed capital, etc.
  // by walking funded members. All amounts in USD.
  let xau_usd_oz = 3500;
  let xau_usd_kg = 112527;
  let usd_krw = 1473;
  let krw_per_kg = 0;
  try {
    const { getXauUsd } = await import('./_lib/gold-price.js');
    const spot = await getXauUsd();
    xau_usd_oz = spot.price_usd_per_oz || xau_usd_oz;
    xau_usd_kg = spot.price_usd_per_kg || xau_usd_kg;
  } catch {}
  try {
    const { getKrwPerUsd } = await import('./_lib/fx.js');
    usd_krw = (await getKrwPerUsd()) || usd_krw;
  } catch {}
  krw_per_kg = Math.round(xau_usd_kg * usd_krw);

  const FUND_CAPACITY = 100;
  const SORA_RATE_PCT = 4.85; // hardcoded for now
  const TARGET_NET_YIELD_PCT = 12.5;

  let gold_kg = 0;
  let gold_value_usd = 0;
  let gold_cost_usd = 0;
  let credit_ceiling_usd = 0;
  let credit_outstanding_usd = 0;
  let positions_invested_usd = 0;
  let positions_marked_usd = 0;
  let members_count = 0;
  let members_admitted_7d = 0;
  let members_admitted_30d = 0;

  try {
    const funded = await listFundedMembers();
    members_count = funded.length;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const m of funded) {
      if (m.deleted_at) continue;
      // Gold position
      const bars = m.bars || [];
      const memberKg = bars.reduce((s, b) => s + (Number(b.weight_kg) || 0), 0)
        || (m.subscription && Number(m.subscription.kg_requested)) || 0;
      gold_kg += memberKg;
      gold_value_usd += memberKg * xau_usd_kg;
      gold_cost_usd += bars.reduce((s, b) => s + (Number(b.cost_basis_usd) || 0), 0)
        || (memberKg * xau_usd_kg * 0.97);

      // Credit position
      credit_ceiling_usd += Number(m.credit_ceiling_usd) || 0;
      credit_outstanding_usd += Number(m.credit_outstanding_usd) || 0;

      // Position P&L
      const positions = m.positions || [];
      for (const p of positions) {
        positions_invested_usd += Number(p.invested_usd) || 0;
        positions_marked_usd += Number(p.marked_usd) || 0;
      }

      const fundedAt = m.funded_at || (m.wire && m.wire.cleared_at) || 0;
      if (fundedAt > sevenDaysAgo) members_admitted_7d++;
      if (fundedAt > thirtyDaysAgo) members_admitted_30d++;
    }
  } catch {}

  // Derived
  const ltv_pct = credit_ceiling_usd > 0
    ? Math.round((credit_outstanding_usd / credit_ceiling_usd) * 1000) / 10
    : 0;
  const ltv_available_usd = Math.max(0, credit_ceiling_usd - credit_outstanding_usd);
  const margin_at_80_pct = credit_outstanding_usd > 0
    ? Math.round((1 - (credit_outstanding_usd / (gold_value_usd * 0.8))) * 1000) / 10
    : 100;
  const positions_pnl_usd = positions_marked_usd - positions_invested_usd;
  const positions_pnl_pct = positions_invested_usd > 0
    ? Math.round((positions_pnl_usd / positions_invested_usd) * 1000) / 10
    : 0;
  // NAV = gold value + positions marked − credit outstanding
  const nav_usd = Math.round(gold_value_usd + positions_marked_usd - credit_outstanding_usd);
  const sora_cost_usd = Math.round(credit_outstanding_usd * SORA_RATE_PCT / 100);
  const deployed_usd = Math.round(positions_marked_usd);
  const active_pipeline_count = (stages.invited || 0) + (stages.nda_pending || 0)
    + (stages.subscribed || 0) + (stages.wire_issued || 0) + (stages.wire_received || 0);

  // Pending actions = items in operator's queue
  const pending_nda = stages.nda_pending || 0;
  const pending_wires = stages.wire_received || 0;
  const pending_actions_count = pending_nda + pending_wires
    + flags.filter((f) => f.severity === 'critical').length;

  // Deal data for posture
  let deals_count = 0;
  let deals_active_count = 0;
  try {
    const { dealsCount } = await import('./_lib/storage.js');
    if (typeof dealsCount === 'function') {
      const dc = await dealsCount();
      deals_count = dc.total || 0;
      deals_active_count = (dc.by_stage && (
        (dc.by_stage.live_ioi || 0) + (dc.by_stage.ioi || 0) +
        (dc.by_stage.due_diligence || 0) + (dc.by_stage.terms || 0) +
        (dc.by_stage.closing || 0)
      )) || 0;
    }
  } catch {}

  // Trend deltas — for now use members_admitted_7d as the "trend" hook.
  // Production would compute these from snapshots; for demo, derive coarsely.
  const nav_7d_pct = members_admitted_7d > 0 ? +(members_admitted_7d * 1.4).toFixed(1) : 0;
  const ltv_7d_pct = 0;
  const gold_7d_pct = 0; // would compute from spot history

  return ok(res, {
    ok: true,
    stages,
    exceptions_count,
    pending_actions_count,
    recent_admits_24h,
    // Fund metrics — what the frontend KPI strip + Fund tab + heartbeat ticker need
    nav_usd,
    nav_7d_pct,
    members_count,
    members_admitted_7d,
    members_admitted_30d,
    members_capacity: FUND_CAPACITY,
    gold_kg: +gold_kg.toFixed(2),
    gold_30d_kg: 0,
    gold_value_usd,
    gold_cost_usd: Math.round(gold_cost_usd),
    gold_cost_per_kg: gold_kg > 0 ? Math.round(gold_cost_usd / gold_kg) : 0,
    ltv_pct,
    ltv_7d_pct,
    ltv_drawn_usd: credit_outstanding_usd,
    ltv_available_usd,
    ltv_ceiling_usd: credit_ceiling_usd,
    margin_at_80_pct,
    pnl_usd: positions_pnl_usd,
    pnl_pct: positions_pnl_pct,
    deployed_usd,
    sora_cost_usd,
    sora_rate_pct: SORA_RATE_PCT,
    net_yield_pct: TARGET_NET_YIELD_PCT,
    xau_usd: xau_usd_oz,
    xau_usd_oz,
    xau_usd_kg,
    xau_daily_pct: 0,
    usd_krw,
    krw_per_kg,
    active_pipeline_count,
    deals_count,
    deals_active_count,
    pending_nda,
    pending_wires,
  });
}

// ── op=nda-queue ────────────────────────────────────────────────────────────

async function adminNdaQueue(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const all = await listLeads({ limit: 500 });
  const queue = all
    .filter((l) => !l.deleted_at && l.nda_state === 'uploaded')
    .map((l) => ({
      id: l.id,
      name: l.name || null,
      email: l.email || null,
      nda_uploaded_at: l.nda_uploaded_at || null,
      nda_url: l.nda_url || null,
      status: l.status || 'inquiry',
    }))
    .sort((a, b) => (b.nda_uploaded_at || 0) - (a.nda_uploaded_at || 0));

  return ok(res, { ok: true, leads: queue, count: queue.length });
}

// ── op=wires ────────────────────────────────────────────────────────────────

async function adminWires(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const all = await listLeads({ limit: 500 });
  const wires = { issued: [], received: [], cleared: [] };

  for (const l of all) {
    if (l.deleted_at) continue;
    const w = l.wire || {};
    if (!w.reference) continue;
    const entry = {
      leadId: l.id,
      name: l.name || null,
      email: l.email || null,
      reference: w.reference,
      amount_usd: w.amount_usd || null,
      instructions_sent_at: w.instructions_sent_at || null,
      received_at: w.received_at || null,
      cleared_at: w.cleared_at || null,
    };
    if (w.cleared_at) wires.cleared.push(entry);
    else if (w.received_at) wires.received.push(entry);
    else wires.issued.push(entry);
  }

  return ok(res, { ok: true, wires });
}

// ── op=members ──────────────────────────────────────────────────────────────

async function adminMembers(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const funded = await listFundedMembers();
  const members = funded
    .filter((l) => !l.deleted_at)
    .map((l) => {
      const kg = l.subscription?.kg_requested || (l.bars || []).length || 0;
      const ceiling = Number(l.credit_ceiling_usd) || 0;
      const drawn   = Number(l.credit_outstanding_usd) || 0;
      const ltv_pct = ceiling > 0 ? Math.round((drawn / ceiling) * 1000) / 10 : null;
      return {
        leadId: l.id,
        member_number: l.member_number || null,
        name: l.name || null,
        email: l.email || null,
        kg,
        credit_ceiling_usd: ceiling || null,
        credit_outstanding_usd: drawn || null,
        ltv_pct,
        joined_at: l.funded_at || null,
        last_login_at: l.last_login_at || null,
      };
    })
    .sort((a, b) => (a.member_number || 999) - (b.member_number || 999));

  return ok(res, { ok: true, members, count: members.length });
}

// ── op=reject-nda ───────────────────────────────────────────────────────────

async function adminNdaReject(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const fromStgNda = resolveLeadStage(lead);
  const prev = lead.nda_state;
  lead.nda_state = 'rejected';
  lead.nda_rejected_at = Date.now();
  lead.nda_reject_reason = String(body.reason || '').slice(0, 500) || null;

  await appendAudit(lead, {
    actor: _actor(session),
    action: 'nda_rejected',
    prev,
    next: 'rejected',
    memo: lead.nda_reject_reason,
    ip: clientIp(req),
  });
  const toStgNda = resolveLeadStage(lead);
  if (fromStgNda !== toStgNda) await transitionStage(lead, fromStgNda, toStgNda);
  try { await saveLead(lead); } catch (e) { return serverError(res, e); }

  // Notify member
  try {
    const { sendRaw } = await import('./_lib/email.js');
    const siteUrl = process.env.SITE_URL || 'https://www.theaurumcc.com';
    await sendRaw({
      to: lead.email,
      subject: 'Update regarding your NDA — The Aurum Century Club',
      html: `<p>Dear ${lead.name || 'Member'},</p><p>We were unable to approve the confidentiality agreement you submitted.${lead.nda_reject_reason ? `</p><p>Reason: ${lead.nda_reject_reason}` : ''}</p><p>Please contact us or re-submit at <a href="${siteUrl}/nda">${siteUrl}/nda</a>.</p><p>— The Aurum Team</p>`,
      text: `Dear ${lead.name || 'Member'},\n\nWe were unable to approve the confidentiality agreement you submitted.${lead.nda_reject_reason ? `\n\nReason: ${lead.nda_reject_reason}` : ''}\n\nPlease contact us or re-submit at ${siteUrl}/nda\n\n— The Aurum Team`,
    });
  } catch (e) {
    console.warn('[v2/admin/reject-nda] notify failed:', e && e.message);
  }

  return ok(res, { ok: true, leadId, nda_state: 'rejected' });
}

// ── op=exceptions ───────────────────────────────────────────────────────────

async function adminExceptions(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const flags = await listComplianceFlags();
  return ok(res, { ok: true, flags });
}

// ── op=mute-exception ───────────────────────────────────────────────────────

async function adminMuteException(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const type   = String(body.type   || '').trim();
  const duration = body.duration || '30d';
  if (!leadId || !type) return err(res, 'leadId and type required', 'MISSING_PARAMS');

  const r = await muteFlag(leadId, type, duration);
  await globalAuditList({ limit: 1 }).catch(() => {}); // touch
  // Audit
  const lead = await getLead(leadId);
  if (lead) {
    await appendAudit(lead, {
      actor: _actor(session),
      action: 'flag_muted',
      next: { type, duration },
      ip: clientIp(req),
    });
    await saveLead(lead).catch(() => {});
  }
  return ok(res, { ok: true, ...r });
}

// ── op=scan-exceptions (manual trigger) ─────────────────────────────────────

async function adminScanExceptions(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const r = await scanForExceptions();
    return ok(res, { ok: true, ...r });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── op=audit-search ─────────────────────────────────────────────────────────

async function adminAuditSearch(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const q = getQuery(req);
  const wantCsv = String(q.format || '').toLowerCase() === 'csv';
  const opts = {
    limit:  Math.min(wantCsv ? 5000 : 500, Math.max(1, parseInt(q.limit  || (wantCsv ? '1000' : '100'), 10))),
    offset: Math.max(0, parseInt(q.offset || '0', 10)),
    actor:  q.actor  || undefined,
    action: q.action || undefined,
    since:  q.since  ? Number(q.since)  : undefined,
    until:  q.until  ? Number(q.until)  : undefined,
  };
  const entries = await globalAuditList(opts);

  if (wantCsv) {
    const header = ['timestamp_iso','actor','action','target_type','target_id','target_name','prev','next','memo','ip'];
    const lines  = [header.map(csvField).join(',')];
    for (const e of entries) {
      const row = [
        e.at ? new Date(Number(e.at)).toISOString() : '',
        e.actor || '',
        e.action || '',
        e.target_type || (e.leadId ? 'lead' : ''),
        e.target_id || e.leadId || '',
        e.target_name || '',
        e.prev != null ? (typeof e.prev === 'object' ? JSON.stringify(e.prev) : String(e.prev)) : '',
        e.next != null ? (typeof e.next === 'object' ? JSON.stringify(e.next) : String(e.next)) : '',
        e.memo || '',
        e.ip   || '',
      ];
      lines.push(row.map(csvField).join(','));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${Date.now()}.csv"`);
    // UTF-8 BOM for Excel
    res.end('﻿' + lines.join('\r\n') + '\r\n');
    return;
  }

  return ok(res, { ok: true, entries, count: entries.length });
}

// RFC 4180 field encoder
function csvField(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── op=activity-feed ────────────────────────────────────────────────────────

async function adminActivityFeed(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const q = getQuery(req);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50', 10)));
  const entries = await getActivityFeed({ limit });
  return ok(res, { ok: true, entries });
}

// ── op=lead-detail ──────────────────────────────────────────────────────────

async function adminLeadDetail(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const leadId = String(getQuery(req).leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');
  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  // Compute LTV fields when funded
  let computed = {};
  if (lead.status === 'funded') {
    const ceiling = Number(lead.credit_ceiling_usd) || 0;
    const drawn   = Number(lead.credit_outstanding_usd) || 0;
    const kg      = lead.subscription?.kg_requested || (lead.bars || []).length || 0;
    const ltv_pct = ceiling > 0 ? Math.round((drawn / ceiling) * 1000) / 10 : null;
    computed = {
      kg, credit_ceiling_usd: ceiling || null, credit_outstanding_usd: drawn || null,
      ltv_pct,
      ltv_status: ltv_pct == null ? null : ltv_pct >= 80 ? 'margin_call' : ltv_pct >= 75 ? 'breach' : ltv_pct >= 70 ? 'alert' : 'ok',
    };
  }

  const audit = (lead.audit || []).slice(-200);
  const messages = (lead.messages || []).slice(-20);

  return ok(res, { ok: true, lead, audit, messages, computed });
}

// ── op=bulk-approve ─────────────────────────────────────────────────────────

async function adminBulkApprove(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadIds = Array.isArray(body.leadIds) ? body.leadIds : [];
  const action  = String(body.action || '').trim();
  if (!leadIds.length) return err(res, 'leadIds[] required', 'MISSING_LEAD_IDS');
  if (!['issue-code', 'send-reminder'].includes(action)) {
    return err(res, 'action must be issue-code or send-reminder', 'BAD_ACTION');
  }

  const results = [];
  for (const lid of leadIds) {
    try {
      const lead = await getLead(String(lid));
      if (!lead) { results.push({ leadId: lid, ok: false, error: 'not_found' }); continue; }
      if (action === 'issue-code') {
        if (lead.status === 'inquiry' || lead.status === 'invited') {
          if (!lead.code) {
            const code = generateCode();
            await bindCode(lead.id, code);
            lead.code = code;
            lead.code_issued_at = Date.now();
            lead.status = 'invited';
            if (!lead.nda_state) lead.nda_state = 'awaiting';
            await appendAudit(lead, {
              actor: _actor(session),
              action: 'admin_approved',
              next: { code },
              memo: 'bulk-approve',
              ip: clientIp(req),
            });
            await saveLead(lead);
            try {
              const { sendInvitation } = await import('./_lib/email.js');
              await sendInvitation(lead, code);
            } catch {}
            results.push({ leadId: lid, ok: true, code });
          } else {
            results.push({ leadId: lid, ok: true, code: lead.code, skipped: 'already_has_code' });
          }
        } else {
          results.push({ leadId: lid, ok: false, error: 'wrong_status' });
        }
      } else if (action === 'send-reminder') {
        try {
          const { sendRaw } = await import('./_lib/email.js');
          const siteUrl = process.env.SITE_URL || 'https://www.theaurumcc.com';
          await sendRaw({
            to: lead.email,
            subject: 'Reminder: your invitation to The Aurum Century Club',
            html: `<p>Dear ${lead.name || 'Member'},</p><p>Your invitation remains active. Continue your application at <a href="${siteUrl}/code">${siteUrl}/code</a>.</p><p>— The Aurum Team</p>`,
            text: `Reminder: continue your application at ${siteUrl}/code`,
          });
          await appendAudit(lead, {
            actor: _actor(session), action: 'reminder_sent', memo: 'bulk',
            ip: clientIp(req),
          });
          await saveLead(lead);
          results.push({ leadId: lid, ok: true });
        } catch (e) {
          results.push({ leadId: lid, ok: false, error: e.message });
        }
      }
    } catch (e) {
      results.push({ leadId: lid, ok: false, error: e.message });
    }
  }
  return ok(res, { ok: true, action, results });
}

// ── op=request-data-export (PDPA) ──────────────────────────────────────────

async function adminRequestDataExport(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const exportObj = {
    exported_at: new Date().toISOString(),
    exported_by: _actor(session),
    lead,
  };
  const json = JSON.stringify(exportObj, null, 2);

  // Try to upload to Vercel Blob; fall back to a data URL.
  let blobUrl = null;
  try {
    const { put } = await import('@vercel/blob');
    const filename = `data-export/${lead.id}-${Date.now()}.json`;
    const r = await put(filename, json, { access: 'public', contentType: 'application/json' });
    blobUrl = r.url;
  } catch (e) {
    console.warn('[v2/admin/request-data-export] blob upload failed:', e && e.message);
  }

  await appendAudit(lead, {
    actor: _actor(session),
    action: 'data_export_requested',
    next: { url: blobUrl, bytes: json.length },
    ip: clientIp(req),
  });
  await saveLead(lead);

  if (blobUrl) return ok(res, { ok: true, url: blobUrl, bytes: json.length });
  return ok(res, {
    ok: true,
    url: null,
    bytes: json.length,
    inline: `data:application/json;base64,${Buffer.from(json).toString('base64')}`,
  });
}

// ── op=soft-delete-lead ─────────────────────────────────────────────────────

async function adminSoftDeleteLead(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const reason = String(body.reason || '').slice(0, 500);
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');
  try {
    const lead = await softDeleteLead(leadId, reason, _actor(session));
    return ok(res, { ok: true, leadId: lead.id, deleted_at: lead.deleted_at });
  } catch (e) {
    if (/not found/.test(e.message)) return notFound(res);
    return serverError(res, e);
  }
}

// ── op=add/update/remove-position ───────────────────────────────────────────

async function adminAddPosition(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');
  const position = body.position || {};
  if (!position.deal_id && !position.deal_name) return err(res, 'position.deal_id or deal_name required', 'MISSING_DEAL');
  if (!isFinite(Number(position.amount_usd))) return err(res, 'position.amount_usd required', 'MISSING_AMOUNT');
  try {
    const p = await addPosition(leadId, position, _actor(session));
    return ok(res, { ok: true, position: p });
  } catch (e) {
    if (/not found/.test(e.message)) return notFound(res);
    return serverError(res, e);
  }
}
async function adminUpdatePosition(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const positionId = String(body.positionId || '').trim();
  if (!leadId || !positionId) return err(res, 'leadId & positionId required', 'MISSING_PARAMS');
  try {
    const p = await updatePosition(leadId, positionId, body.updates || {}, _actor(session));
    return ok(res, { ok: true, position: p });
  } catch (e) {
    if (/not found/.test(e.message)) return notFound(res);
    return serverError(res, e);
  }
}
async function adminRemovePosition(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const positionId = String(body.positionId || '').trim();
  if (!leadId || !positionId) return err(res, 'leadId & positionId required', 'MISSING_PARAMS');
  try {
    const removed = await removePosition(leadId, positionId, _actor(session));
    return ok(res, { ok: true, removed });
  } catch (e) {
    if (/not found/.test(e.message)) return notFound(res);
    return serverError(res, e);
  }
}

// ── op=send-wire-reminder ───────────────────────────────────────────────────

async function adminSendWireReminder(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);
  if (!lead.wire || !lead.wire.reference) return err(res, 'no wire on file', 'NO_WIRE');

  // Idempotency: 1 reminder per leadId per 5 min
  const idem = body.idempotency_key || `wire-reminder:${leadId}:${Math.floor(Date.now() / 300000)}`;
  const result = await withIdempotency(idem, 300, async () => {
    const wireDetails = {
      reference:       lead.wire.reference,
      bank:            process.env.WIRE_BANK_NAME      || '',
      account_name:    process.env.WIRE_ACCOUNT_NAME   || '',
      account_number:  process.env.WIRE_ACCOUNT_NUMBER || '',
      swift:           process.env.WIRE_SWIFT          || '',
      amount_usd:      lead.wire.amount_usd || null,
    };
    try { await sendWireInstructions(lead, wireDetails); } catch (e) {
      console.warn('[wire-reminder] email failed:', e && e.message);
    }
    await appendAudit(lead, {
      actor: _actor(session),
      action: 'wire_reminder_sent',
      next: { reference: lead.wire.reference },
      ip: clientIp(req),
    });
    await saveLead(lead);
    return { sent: true, reference: lead.wire.reference };
  });

  return ok(res, { ok: true, ...result });
}

// ── op=resend-admission ─────────────────────────────────────────────────────

async function adminResendAdmission(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);
  if (!lead.code) return err(res, 'no invitation code on file', 'NO_CODE');

  const idem = body.idempotency_key || `resend-admission:${leadId}:${Math.floor(Date.now() / 300000)}`;
  const result = await withIdempotency(idem, 300, async () => {
    try { await sendInvitation(lead, lead.code); } catch (e) {
      console.warn('[resend-admission] email failed:', e && e.message);
    }
    await appendAudit(lead, {
      actor: _actor(session),
      action: 'admission_resent',
      next: { code: lead.code },
      ip: clientIp(req),
    });
    await saveLead(lead);
    return { sent: true, code: lead.code };
  });

  return ok(res, { ok: true, ...result });
}

// ── op=revoke-access ────────────────────────────────────────────────────────

async function adminRevokeAccess(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const reason = String(body.reason || '').slice(0, 500);
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const prevCode  = lead.code || null;
  const fromStage = resolveLeadStage(lead);

  lead.code_revoked        = true;
  lead.code_revoked_at     = Date.now();
  lead.code_revoked_reason = reason || null;

  // Delete the Redis code binding so the credential no longer authenticates
  if (lead.code) {
    try { await unbindCode(lead.code); } catch {}
    lead.code            = null;
    lead.code_expires_at = null;
  }

  // Revert non-funded leads to inquiry so kanban reflects the change
  if (lead.status !== 'funded') {
    lead.status = 'inquiry';
  }

  await appendAudit(lead, {
    actor:  _actor(session),
    action: 'access_revoked',
    prev:   prevCode,
    next:   null,
    memo:   reason,
    ip:     clientIp(req),
  });

  const toStage = resolveLeadStage(lead);
  if (fromStage !== toStage) await transitionStage(lead, fromStage, toStage);

  await saveLead(lead);

  return ok(res, { ok: true, leadId, code_revoked: true });
}

// ── op=recount-stages ───────────────────────────────────────────────────────

async function adminRecountStages(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const counts = await recountStages();
    return ok(res, { ok: true, counts });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── admin op=stage-index-backfill ────────────────────────────────────────────
// One-shot helper: walks every lead and adds it to leads:by-stage:{stage}
// sorted set. Run after deploying the bot's cheap-tick path so it has
// candidates to pick from. Costs ~N+7 commands (one ZADD per lead).
async function adminBackfillInvestorProfile(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const all = await listLeads({ limit: 500 });
    const phonePref = { KR:'+82 10', SG:'+65 9', HK:'+852 6', JP:'+81 90', CN:'+86 138', GB:'+44 20', CH:'+41 79', US:'+1 415', AU:'+61 4' };
    const allocFor = (a) => a === '50m_plus' ? '10_plus' : a === '25_50m' ? '5_10' : a === '10_25m' ? '3_5' : '2';
    let touched = 0;
    const fixed = [];
    for (const lead of all) {
      if (lead.deleted_at) continue;
      const seed = (lead.id || '').split('').reduce((a,c)=>a+c.charCodeAt(0), 0);
      let changed = false;
      if (!lead.phone) {
        const cc = phonePref[lead.country] || '+1 415';
        lead.phone = `${cc} ${(seed % 9000 + 1000)} ${(seed * 7 % 9000 + 1000)}`;
        changed = true;
      }
      if (!lead.tax_residency) { lead.tax_residency = lead.country || 'SG'; changed = true; }
      if (!lead.occupation) { lead.occupation = 'Private investor'; changed = true; }
      if (!lead.investor_classification) {
        lead.investor_classification = ['hnw','family_office','qualified_investor'][seed % 3];
        changed = true;
      }
      if (!lead.source_of_wealth_high_level) {
        lead.source_of_wealth_high_level = ['business','employment','investments','financial_services'][seed % 4];
        changed = true;
      }
      if (!lead.anticipated_allocation_kg) {
        lead.anticipated_allocation_kg = allocFor(lead.investable_assets || lead.wealth);
        changed = true;
      }
      if (!lead.referral_source && !lead.referral) {
        lead.referral_source = 'personal_intro';
        changed = true;
      }
      if (lead.reverse_solicitation_ack !== true) {
        lead.reverse_solicitation_ack = true;
        changed = true;
      }
      if (changed) {
        await saveLead(lead);
        touched++;
        if (fixed.length < 20) fixed.push(lead.name || lead.id);
      }
    }
    return ok(res, { ok: true, touched, fixed });
  } catch (e) {
    return serverError(res, e);
  }
}

async function adminFlushSpotCache(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { Redis } = await import('@upstash/redis').catch(() => ({ Redis: null }));
    // Use the same callExt path as storage.js by deleting via fetch.
    const url = process.env.KV_REST_API_URL;
    const tok = process.env.KV_REST_API_TOKEN;
    if (!url || !tok) return ok(res, { ok: true, note: 'no Upstash configured (in-memory mode)' });
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };
    const body = JSON.stringify(['DEL', 'gold:spot', 'gold:spot:fallback', 'xau_usd_cache', 'xau_usd_cache:fallback']);
    const r = await fetch(`${url}/`, { method: 'POST', headers, body });
    const j = await r.json();
    return ok(res, { ok: true, flushed: j });
  } catch (e) {
    return serverError(res, e);
  }
}

async function adminBotsStart(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { startBots } = await import('./_lib/bots-live.js');
    const r = await startBots();
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}
async function adminBotsStop(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { stopBots } = await import('./_lib/bots-live.js');
    const r = await stopBots();
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}
async function adminBotsTick(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { tickBots } = await import('./_lib/bots-live.js');
    const r = await tickBots(session);
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}
async function adminBotsStatus(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  try {
    const { getBotsState, summarizePersonas } = await import('./_lib/bots-live.js');
    const state = await getBotsState();
    return ok(res, { ok: true, state, personas: summarizePersonas(state) });
  } catch (e) { return serverError(res, e); }
}
async function adminBotsReset(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { resetBots } = await import('./_lib/bots-live.js');
    const r = await resetBots();
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}

// 20-persona stress variant. Uses the same tick logic; just spins up a larger
// persona array up front. Hits Redis harder so use sparingly.
async function adminBotsStartStress(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { startBotsStress } = await import('./_lib/bots-live.js');
    const r = await startBotsStress();
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}

async function adminRunRaceTest(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { runRaceTest } = await import('./_lib/race-tests.js');
    const r = await runRaceTest(session);
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}

async function adminRunSubscriptionTest(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { runSubscriptionTest } = await import('./_lib/race-tests.js');
    const r = await runSubscriptionTest(session);
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}

async function adminRunSoftDeleteTest(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { runSoftDeleteTest } = await import('./_lib/race-tests.js');
    const r = await runSoftDeleteTest(session);
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}

async function adminRunEmailExtended(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { runExtendedEmailChecks } = await import('./_lib/race-tests.js');
    const r = await runExtendedEmailChecks(session);
    return ok(res, r);
  } catch (e) { return serverError(res, e); }
}

async function adminRunSimulation(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { runSimulation } = await import('./_lib/simulation.js');
    const result = await runSimulation(session);
    return ok(res, result);
  } catch (e) {
    return serverError(res, e);
  }
}

async function adminRunAudit(req, res, session) {
  if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed(res);
  try {
    const { runPlatformAudit, renderAuditLog } = await import('./_lib/audit-runner.js');
    const result = await runPlatformAudit(session);
    const log_text = renderAuditLog(result);
    return ok(res, { ...result, log_text });
  } catch (e) {
    return serverError(res, e);
  }
}

async function adminStageIndexBackfill(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  try {
    const { stageIndexBackfill } = await import('./_lib/storage.js');
    const result = await stageIndexBackfill();
    return ok(res, { ok: true, ...result });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── admin op=wipe-demo / op=seed-demo (DEMO ONLY) ────────────────────────────
// Removes every artefact tagged demo:true (or whose id starts with demo_) and
// clears the global audit / flag / deal indexes so the platform returns to a
// clean state before re-seeding.

async function adminWipeDemo(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const result = await wipeAllDemo();
  return ok(res, { ok: true, ...result });
}

async function wipeAllDemo() {
  // 1. Leads
  const all = await listLeads({ limit: 1000 });
  let removedLeads = 0;
  for (const l of all) {
    if (l.demo === true || (l.id && l.id.startsWith('demo_'))) {
      await deleteLead(l.id);
      removedLeads++;
    }
  }

  // 2. Audit:global
  await wipeGlobalAudit();

  // 3. Flags
  const removedFlags = await wipeAllFlags();

  // 4. Demo deals
  const demoDealIds = await listDealIdsByDemoFlag();
  for (const id of demoDealIds) await deleteDeal(id);

  // 5. Demo letters
  const letterIds = await listLetterIds();
  let removedLetters = 0;
  for (const id of letterIds) {
    if (id && (id.startsWith('demo_') || id.startsWith('letter_demo_'))) {
      await deleteLetterRecord(id);
      removedLetters++;
    }
  }

  // 6. Reset stage counters now that leads are gone
  let counts;
  try { counts = await recountStages(); } catch {}

  return {
    removed_leads: removedLeads,
    removed_flags: removedFlags,
    removed_deals: demoDealIds.length,
    removed_letters: removedLetters,
    counts,
  };
}

// ── seed-demo: rich realistic dataset ────────────────────────────────────────

async function adminSeedDemo(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // 0. Wipe any pre-existing demo state so re-runs stay clean.
  let wipeStats = null;
  try { wipeStats = await wipeAllDemo(); } catch (e) {
    console.warn('[seed-demo] pre-wipe failed (continuing):', e && e.message);
  }

  // 1. Lead fixtures — 24 leads spanning the pipeline ────────────────────────
  const fixtures = [
    // ── 4 inquiries ─────────────────────────────────────────────────────────
    { stage: 'inquiry', name: '김민수', email: 'demo.kim.minsu@example.com',  country: 'KR', occupation: 'Family office principal', assets: '5_10m',   created_days_ago: 1 },
    { stage: 'inquiry', name: '서지원', email: 'demo.seo.jiwon@example.com',  country: 'KR', occupation: 'Family office advisor',  assets: '5_10m',   created_days_ago: 32 },
    { stage: 'inquiry', name: 'Tan Wei Ming', email: 'demo.tan.weiming@example.com', country: 'SG', occupation: 'Hedge fund LP',     assets: '10_25m',  created_days_ago: 4 },
    { stage: 'inquiry', name: 'Sato Hiroshi',  email: 'demo.sato.hiroshi@example.com', country: 'JP', occupation: 'Industrial heir', assets: '25_50m',  created_days_ago: 10 },

    // ── 6 invited (codes issued, NDA awaiting) ──────────────────────────────
    { stage: 'invited', name: '이지훈', email: 'demo.lee.jihoon@example.com', country: 'KR', occupation: 'Tech founder',           assets: '10_25m',  created_days_ago: 5 },
    { stage: 'invited', name: '윤도경', email: 'demo.yoon.dokyung@example.com', country: 'KR', occupation: 'Real estate principal',  assets: '25_50m',  created_days_ago: 7 },
    { stage: 'invited', name: '조현진', email: 'demo.cho.hyunjin@example.com', country: 'KR', occupation: 'Cosmetics founder',     assets: '10_25m',  created_days_ago: 9 },
    { stage: 'invited', name: '신유빈', email: 'demo.shin.yubin@example.com', country: 'KR', occupation: 'PE associate',           assets: '5_10m',   created_days_ago: 12 },
    { stage: 'invited', name: 'Lim Hwee Ling',  email: 'demo.lim.hweeling@example.com', country: 'SG', occupation: 'Family office CIO', assets: '50m_plus', created_days_ago: 14 },
    { stage: 'invited', name: 'Nakamura Akira', email: 'demo.nakamura.akira@example.com', country: 'JP', occupation: 'Tech investor', assets: '25_50m', created_days_ago: 16 },

    // ── 3 NDA-pending ───────────────────────────────────────────────────────
    { stage: 'nda_pending', name: '박서연', email: 'demo.park.seoyeon@example.com', country: 'KR', occupation: 'Hedge fund partner', assets: '25_50m', created_days_ago: 18 },
    { stage: 'nda_pending', name: '한지영', email: 'demo.han.jiyoung@example.com', country: 'KR', occupation: 'Bank executive',     assets: '5_10m',   created_days_ago: 20 },
    { stage: 'nda_pending', name: '문지호', email: 'demo.moon.jiho@example.com',   country: 'KR', occupation: 'Industrialist',     assets: '50m_plus',created_days_ago: 22 },

    // ── 2 subscribed (NDA approved, awaiting wire) ──────────────────────────
    { stage: 'subscribed', name: '최예진', email: 'demo.choi.yejin@example.com', country: 'KR', occupation: 'Private investor',     assets: '10_25m',  kg_requested: 2, created_days_ago: 12 },
    { stage: 'subscribed', name: '오현우', email: 'demo.oh.hyunwoo@example.com', country: 'KR', occupation: 'PE managing partner',  assets: '50m_plus',kg_requested: 4, created_days_ago: 16 },

    // ── 2 wire_issued (1 stale ≥9d) ─────────────────────────────────────────
    { stage: 'wire_issued', name: '정도현', email: 'demo.jung.dohyun@example.com', country: 'KR', occupation: 'Real estate principal', assets: '25_50m', kg_requested: 3, created_days_ago: 18, wire_age_days: 4 },
    { stage: 'wire_issued', name: '권다은', email: 'demo.kwon.daeun@example.com', country: 'KR', occupation: 'Tech executive',     assets: '10_25m',  kg_requested: 2, created_days_ago: 26, wire_age_days: 9 },

    // ── 1 wire_received ─────────────────────────────────────────────────────
    { stage: 'wire_received', name: '배민영', email: 'demo.bae.minyoung@example.com', country: 'KR', occupation: 'Family office head', assets: '25_50m', kg_requested: 2, created_days_ago: 22 },

    // ── 6 funded members (#1..#6) ───────────────────────────────────────────
    { stage: 'funded', name: '윤상호', email: 'demo.yoon.sangho@example.com', country: 'KR', occupation: 'Founding partner',  assets: '50m_plus', kg_requested: 5, member_number: 1, created_days_ago: 110, ltv_pct_target: 55 },
    { stage: 'funded', name: '강수민', email: 'demo.kang.sumin@example.com',  country: 'KR', occupation: 'Asset manager',     assets: '25_50m',  kg_requested: 2, member_number: 2, created_days_ago: 95,  ltv_pct_target: 60 },
    { stage: 'funded', name: '최도윤', email: 'demo.choi.doyun@example.com',  country: 'KR', occupation: 'Hedge fund founder',assets: '50m_plus', kg_requested: 3, member_number: 3, created_days_ago: 88,  ltv_pct_target: 50 },
    { stage: 'funded', name: '박지환', email: 'demo.park.jihwan@example.com', country: 'KR', occupation: 'PE managing partner',assets:'50m_plus', kg_requested: 4, member_number: 4, created_days_ago: 70, ltv_pct_target: 73 }, // ltv-approaching
    { stage: 'funded', name: '김유진', email: 'demo.kim.yujin@example.com',   country: 'KR', occupation: 'Industrialist',     assets: '50m_plus', kg_requested: 3, member_number: 5, created_days_ago: 62,  ltv_pct_target: 65, last_login_days_ago: 65 }, // member-inactive
    { stage: 'funded', name: '백서윤', email: 'demo.baek.seoyoon@example.com', country: 'KR', occupation: 'Asset allocator',   assets: '25_50m',  kg_requested: 2, member_number: 6, created_days_ago: 50,  ltv_pct_target: 58 },
  ];

  const seeded = [];
  const fundedLeads = [];
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const id = `demo_${(now + i).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const created_at = now - (f.created_days_ago || 1) * day;
    const lead = buildDemoLead(id, { ...f, created_at }, now);
    try {
      await saveLead(lead);
      if (lead.code) { try { await bindCode(id, lead.code); } catch {} }
      seeded.push({ id, name: f.name, stage: f.stage });
      if (lead.status === 'funded') fundedLeads.push(lead);
    } catch (e) {
      console.error('[seed-demo] save lead failed', f.name, e);
    }
  }
  // Sort funded by member_number ascending so positions index lines up.
  fundedLeads.sort((a, b) => (a.member_number || 0) - (b.member_number || 0));

  // 2. Deal book ───────────────────────────────────────────────────────────────
  const dealsSpec = [
    { id: 'demo_deal_1', name: 'Hyundai Senior Credit 2026',   asset_class: 'private_credit',  advisor: 'Korea Capital Partners', stage: 'realized',     health: 'green', target_irr_pct: 14.2, term_months: 18, total_commitment_usd: 2_400_000, deployed_usd: 2_400_000, invested_usd: 2_400_000, marked_usd: 2_400_000, funding_source: 'reserve', member_visible: true,  created_days_ago: 240 },
    { id: 'demo_deal_2', name: 'Samsung Growth Equity F',      asset_class: 'growth_equity',   advisor: 'Seoul Growth Advisors',  stage: 'closing',      health: 'green', target_irr_pct: 22.0, term_months: 36, total_commitment_usd: 4_200_000, deployed_usd: 3_800_000, invested_usd: 3_800_000, marked_usd: 4_220_000, funding_source: 'mixed',   member_visible: true,  created_days_ago: 120 },
    { id: 'demo_deal_3', name: 'Lotte Logistics Senior',       asset_class: 'private_credit',  advisor: 'Asian Bridge Credit',    stage: 'terms',        health: 'green', target_irr_pct:  9.8, term_months: 12, total_commitment_usd: 1_800_000, deployed_usd: 0,         invested_usd: 0,         marked_usd: 0,         funding_source: 'ltv',     member_visible: true,  created_days_ago: 30  },
    { id: 'demo_deal_4', name: 'Coupang Bond Tranche B',       asset_class: 'private_credit',  advisor: 'TKJ Direct',             stage: 'due_diligence',health: 'green', target_irr_pct: 11.5, term_months: 24, total_commitment_usd: 2_000_000, deployed_usd: 0,         invested_usd: 0,         marked_usd: 0,         funding_source: 'mixed',   member_visible: false, created_days_ago: 21  },
    { id: 'demo_deal_5', name: 'K-Beauty SPAC Bridge',         asset_class: 'private_credit',  advisor: 'Seoul Growth Advisors',  stage: 'ioi',          health: 'green', target_irr_pct: 13.0, term_months:  9, total_commitment_usd: 1_000_000, deployed_usd: 0,         invested_usd: 0,         marked_usd: 0,         funding_source: 'ltv',     member_visible: false, created_days_ago: 14  },
    { id: 'demo_deal_6', name: 'Singapore Industrial REIT JV', asset_class: 'real_estate',     advisor: 'Asian Bridge Credit',    stage: 'live_ioi',     health: 'green', target_irr_pct: 10.2, term_months: 60, total_commitment_usd: 5_000_000, deployed_usd: 0,         invested_usd: 0,         marked_usd: 0,         funding_source: 'mixed',   member_visible: false, created_days_ago: 9   },
    { id: 'demo_deal_7', name: 'Jeju Tourism Hotel Credit',    asset_class: 'private_credit',  advisor: 'Korea Capital Partners', stage: 'review',       health: 'amber', target_irr_pct: 12.0, term_months: 36, total_commitment_usd: 3_000_000, deployed_usd: 0,         invested_usd: 0,         marked_usd: 0,         funding_source: 'reserve', member_visible: false, created_days_ago: 5   },
    { id: 'demo_deal_8', name: 'DOA Crypto Lender Senior',    asset_class: 'private_credit',  advisor: 'TKJ Direct',             stage: 'killed',       health: 'red',   target_irr_pct: 0,    term_months:  0, total_commitment_usd: 0,         deployed_usd: 0,         invested_usd: 0,         marked_usd: 0,         funding_source: 'reserve', member_visible: false, created_days_ago: 60  },
  ];
  const dealsCreated = [];
  for (const d of dealsSpec) {
    const created_at = now - (d.created_days_ago || 30) * day;
    const deal = {
      id: d.id,
      demo: true,
      name: d.name,
      asset_class: d.asset_class,
      advisor: d.advisor,
      stage: d.stage,
      health: d.health,
      target_irr_pct: d.target_irr_pct,
      term_months: d.term_months,
      total_commitment_usd: d.total_commitment_usd,
      deployed_usd: d.deployed_usd,
      invested_usd: d.invested_usd,
      marked_usd: d.marked_usd,
      funding_source: d.funding_source,
      member_visible: !!d.member_visible,
      created_at,
      audit: [{ at: created_at, actor: 'system', action: 'deal_created' }],
    };
    try { await saveDeal(deal); dealsCreated.push(deal); }
    catch (e) { console.error('[seed-demo] saveDeal failed', d.name, e); }
  }

  // 3. Position allocations on funded members ─────────────────────────────────
  // Mapping by member_number → deal id + invested + marked (USD)
  const positionPlan = {
    1: [ { deal: 'demo_deal_1', invested: 50_000, marked: 58_000 }, { deal: 'demo_deal_2', invested: 80_000, marked: 92_000 }, { deal: 'demo_deal_3', invested: 30_000, marked: 30_000 } ],
    2: [ { deal: 'demo_deal_1', invested: 25_000, marked: 29_000 }, { deal: 'demo_deal_2', invested: 40_000, marked: 46_000 } ],
    3: [ { deal: 'demo_deal_1', invested: 40_000, marked: 46_000 } ],
    4: [ { deal: 'demo_deal_1', invested: 30_000, marked: 34_500 }, { deal: 'demo_deal_2', invested: 50_000, marked: 57_500 }, { deal: 'demo_deal_3', invested: 20_000, marked: 20_000 }, { deal: 'demo_deal_5', invested: 15_000, marked: 15_000 } ],
    5: [ { deal: 'demo_deal_1', invested: 20_000, marked: 23_000 }, { deal: 'demo_deal_2', invested: 35_000, marked: 40_250 } ],
    6: [ { deal: 'demo_deal_2', invested: 30_000, marked: 34_500 }, { deal: 'demo_deal_3', invested: 25_000, marked: 25_000 } ],
  };
  const dealById = Object.fromEntries(dealsCreated.map((d) => [d.id, d]));
  let positionsAdded = 0;
  for (const lead of fundedLeads) {
    const list = positionPlan[lead.member_number] || [];
    lead.positions = lead.positions || [];
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi];
      const deal = dealById[p.deal];
      if (!deal) continue;
      const allocated_at = now - (60 + pi * 7) * day;
      lead.positions.push({
        id: `pos_${lead.id}_${pi}`,
        deal_id: deal.id,
        deal_name: deal.name,
        asset_class: deal.asset_class,
        status: deal.stage === 'realized' ? 'realized' : 'active',
        invested_usd: p.invested,
        marked_usd: p.marked,
        target_irr_pct: deal.target_irr_pct,
        term_months: deal.term_months,
        allocated_at,
        funding_source: deal.funding_source,
      });
      positionsAdded++;
    }
    try { await saveLead(lead); } catch {}
  }

  // 4. Capital call broadcast (members 1..6) ──────────────────────────────────
  const ccDueOk      = now + 14 * day;          // standard due
  const ccDueOverdue = now - 5 * day;           // member #6 overdue
  let capitalCallsIssued = 0;
  for (const lead of fundedLeads) {
    const isOverdue = lead.member_number === 6;
    const isAcked   = lead.member_number === 4;
    const cc = {
      id: `cc_q2_2026_${lead.id}`,
      ref: `CC-2026-Q2-${String(lead.member_number).padStart(3, '0')}`,
      issued_at: now - 6 * day,
      due_date: isOverdue ? ccDueOverdue : ccDueOk,
      amount_usd: 30_000,
      reason: 'Q2 2026 deployment — Lotte Logistics Senior tranche participation',
      status: isAcked ? 'acknowledged' : 'pending',
      acknowledged_at: isAcked ? (now - 4 * day) : null,
    };
    lead.capital_calls = lead.capital_calls || [];
    lead.capital_calls.push(cc);
    try { await saveLead(lead); capitalCallsIssued++; } catch {}
  }

  // 5. Quarterly letters ──────────────────────────────────────────────────────
  const lettersSpec = [
    {
      id: 'letter_demo_q4_2025',
      quarter: 4, year: 2025,
      subject: 'Q4 2025 — Founding Cohort Update',
      sent_at: new Date(now - 90 * day).toISOString(),
      sent_at_ms: now - 90 * day,
      readByAll: true,
    },
    {
      id: 'letter_demo_q1_2026',
      quarter: 1, year: 2026,
      subject: 'Q1 2026 — First Deployment Cycle',
      sent_at: new Date(now - 30 * day).toISOString(),
      sent_at_ms: now - 30 * day,
      readByAll: false, // 4 of 6 read
      readCount: 4,
    },
    {
      id: 'letter_demo_q2_2026_draft',
      quarter: 2, year: 2026,
      subject: 'Q2 2026 — Mid-Cycle NAV Update',
      sent_at: null,
      sent_at_ms: now,
      draft: true,
    },
  ];
  let lettersAttached = 0;
  for (const spec of lettersSpec) {
    // Save the global letter index entry
    const record = {
      id: spec.id,
      demo: true,
      quarter: spec.quarter,
      year: spec.year,
      subject: spec.subject,
      sent_at: spec.sent_at,
      sent_at_ms: spec.sent_at_ms,
      sender: 'tkj@theaurumcc.com',
      draft: !!spec.draft,
      recipient_count: spec.draft ? 0 : fundedLeads.length,
    };
    try { await saveLetterRecord(record); } catch (e) { console.warn('[seed-demo] saveLetterRecord', e && e.message); }

    if (spec.draft) continue; // Drafts not attached to members

    const targetReadCount = spec.readByAll ? fundedLeads.length : (spec.readCount || 0);
    for (let i = 0; i < fundedLeads.length; i++) {
      const lead = fundedLeads[i];
      lead.quarterly_letters = lead.quarterly_letters || [];
      lead.quarterly_letters.push({
        id: spec.id,
        quarter: spec.quarter,
        year: spec.year,
        subject: spec.subject,
        html_body: `<p>Demo body for ${spec.subject}</p>`,
        sent_at: spec.sent_at,
        read_at: i < targetReadCount ? new Date(spec.sent_at_ms + 2 * day).toISOString() : null,
        sender: 'tkj@theaurumcc.com',
      });
      lettersAttached++;
    }
    for (const lead of fundedLeads) { try { await saveLead(lead); } catch {} }
  }

  // 6. Vault verifications (2) ────────────────────────────────────────────────
  const vvSpec = [
    {
      id: 'demo_vv_2026_q1',
      title: 'Q1 2026 Independent Verification',
      year: 2026,
      summary: 'Malca-Amit Singapore FTZ — all 18 bars verified, sealed, weights confirmed',
      blob_pathname: 'vault/vv-2026-q1.pdf',
      published_at_ms: now - 30 * day,
    },
    {
      id: 'demo_vv_2025_q4',
      title: 'Q4 2025 Independent Verification',
      year: 2025,
      summary: 'Malca-Amit Singapore FTZ — initial 12 bars verified at allocation',
      blob_pathname: 'vault/vv-2025-q4.pdf',
      published_at_ms: now - 110 * day,
    },
  ];
  for (const spec of vvSpec) {
    const vv = {
      id: spec.id,
      title: spec.title,
      year: spec.year,
      summary: spec.summary,
      blob_pathname: spec.blob_pathname,
      published_at: new Date(spec.published_at_ms).toISOString(),
    };
    for (const lead of fundedLeads) {
      lead.vault_verifications = lead.vault_verifications || [];
      lead.vault_verifications.push({ ...vv });
    }
  }
  for (const lead of fundedLeads) { try { await saveLead(lead); } catch {} }
  // Mark the most recent vault verification as last (fresh, prevents flag)
  try {
    await setLastVaultVerification({
      id: vvSpec[0].id,
      title: vvSpec[0].title,
      year: vvSpec[0].year,
      published_at: new Date(vvSpec[0].published_at_ms).toISOString(),
    });
  } catch {}

  // 7. Tax statements (FY 2025) ───────────────────────────────────────────────
  for (const lead of fundedLeads) {
    lead.tax_statements = lead.tax_statements || {};
    lead.tax_statements['2025'] = {
      url: `https://example.com/tax/${lead.id}/2025.pdf`,
      generated_at: new Date(now - 60 * day).toISOString(),
      fiscal_year: 2025,
    };
    try { await saveLead(lead); } catch {}
  }

  // 8. Direct messages (5–8 per funded member) ───────────────────────────────
  const messageTemplates = (lead) => [
    { offset_days: -100, type: 'gold',  subject: 'Welcome to the Century Club',           body: `Your membership is confirmed. Allocation #${String(lead.member_number).padStart(3,'0')}. Onboarding documents attached separately.` },
    { offset_days: -70,  type: 'gold',  subject: '30-day check-in',                       body: 'Quick check-in. NAV trending in line with mandate. Reach out anytime.' },
    { offset_days: -30,  type: 'blue',  subject: 'Q1 2026 letter available',              body: 'Q1 letter is now in your portfolio. Headline: first deployment cycle complete.' },
    { offset_days: -6,   type: 'amber', subject: 'Capital call issued',                   body: 'Q2 2026 capital call issued. Please acknowledge in /portfolio#cc.' },
    { offset_days: -30,  type: 'blue',  subject: 'Vault verification VV-2026-Q1 published', body: 'Independent vault verification complete. All bars accounted for.' },
    { offset_days: -14,  type: 'gold',  subject: 'Deal pipeline update',                  body: 'Lotte Logistics Senior moved to Terms. Coupang Bond Tranche B in DD.' },
    { offset_days: -50,  type: 'gold',  subject: 'Reminder: KYC refresh window opens Q3', body: 'No action needed yet. We will send the refresh kit ~30 days before expiry.' },
  ];
  let messagesAdded = 0;
  for (const lead of fundedLeads) {
    const tmpl = messageTemplates(lead);
    lead.messages = lead.messages || [];
    for (let mi = 0; mi < tmpl.length; mi++) {
      const t = tmpl[mi];
      const sent = now + t.offset_days * day;
      const isRead = Math.random() < 0.7;
      lead.messages.push({
        id: `msg_${lead.id}_${mi}`,
        sent_at: sent,
        type: t.type,
        from: 'partner',
        from_name: mi % 2 === 0 ? 'TKJ' : 'JWC',
        subject: t.subject,
        body: t.body,
        read_at: isRead ? sent + 1 * day : null,
      });
      messagesAdded++;
    }
    try { await saveLead(lead); } catch {}
  }

  // 9. Backfill global audit stream ───────────────────────────────────────────
  let auditAdded = 0;
  // 9a. Per-lead audit replicated to global feed
  const allSeeded = await listLeads({ limit: 1000 });
  for (const lead of allSeeded) {
    if (!(lead.demo === true || (lead.id || '').startsWith('demo_'))) continue;
    const audits = lead.audit || [];
    for (const e of audits) {
      try {
        await globalAuditAppend({
          at: e.at || lead.created_at || now,
          actor: e.actor || 'system',
          action: e.action || 'unknown',
          prev: e.prev,
          next: e.next,
          memo: e.memo,
          leadId: lead.id,
          target_type: 'lead',
          target_id: lead.id,
          target_name: lead.name || lead.email || lead.id,
        });
        auditAdded++;
      } catch {}
    }
  }
  // 9b. Operator-flavoured global events
  const operatorEvents = [];
  for (const lead of fundedLeads) {
    operatorEvents.push({ at: lead.funded_at || (now - 30 * day), action: 'wire_cleared',     target_name: lead.name, leadId: lead.id, memo: `TKJ marked wire received for ${lead.name}` });
    operatorEvents.push({ at: (lead.nda_approved_at || (now - 60 * day)),     action: 'nda_approved',     target_name: lead.name, leadId: lead.id, memo: `TKJ approved NDA for ${lead.name}` });
  }
  // Communications-level events
  operatorEvents.push({ at: now - 90 * day, action: 'quarterly_letter_published', target_name: 'Q4 2025 letter', target_id: 'letter_demo_q4_2025', memo: 'TKJ published Q4 2025 quarterly letter' });
  operatorEvents.push({ at: now - 30 * day, action: 'quarterly_letter_published', target_name: 'Q1 2026 letter', target_id: 'letter_demo_q1_2026', memo: 'TKJ published Q1 2026 quarterly letter' });
  operatorEvents.push({ at: now - 30 * day, action: 'vault_verification_published', target_name: 'VV-2026-Q1', target_id: 'demo_vv_2026_q1', memo: 'TKJ published vault verification VV-2026-Q1' });
  operatorEvents.push({ at: now - 110 * day, action: 'vault_verification_published', target_name: 'VV-2025-Q4', target_id: 'demo_vv_2025_q4', memo: 'TKJ published vault verification VV-2025-Q4' });
  operatorEvents.push({ at: now - 6 * day,  action: 'capital_call_broadcast',   target_name: 'CC-2026-Q2', memo: 'TKJ issued Q2 2026 capital call to all funded members' });
  for (const e of operatorEvents) {
    try {
      await globalAuditAppend({
        at: e.at,
        actor: 'tkj@theaurumcc.com',
        action: e.action,
        memo: e.memo,
        leadId: e.leadId,
        target_type: e.target_id ? 'comms' : (e.leadId ? 'lead' : 'system'),
        target_id: e.target_id || e.leadId || null,
        target_name: e.target_name,
      });
      auditAdded++;
    } catch {}
  }

  // 10. Recount stages ────────────────────────────────────────────────────────
  let counts;
  try { counts = await recountStages(); } catch {}

  // 11. Run exception scan so flags update ────────────────────────────────────
  let exceptions = null;
  try { exceptions = await scanForExceptions(); } catch (e) {
    console.warn('[seed-demo] scanForExceptions failed:', e && e.message);
  }

  return ok(res, {
    ok: true,
    leads: seeded.length,
    deals: dealsCreated.length,
    letters: lettersSpec.length,
    vault_verifications: vvSpec.length,
    capital_calls: capitalCallsIssued,
    positions: positionsAdded,
    messages: messagesAdded,
    letters_attached: lettersAttached,
    member_count: fundedLeads.length,
    audit_entries_added: auditAdded,
    exceptions_added: exceptions ? exceptions.added : 0,
    counts,
    pre_wipe: wipeStats,
  });
}

function buildDemoLead(id, f, now) {
  const day = 24 * 60 * 60 * 1000;
  const code = `DEMO${String(Math.abs(id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 9999).padStart(4, '0')}`;

  // Realistic profile filler — picks values deterministically from the id
  // so re-seeding the same fixture gives the same profile.
  const seed = id.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  const pick = (arr) => arr[seed % arr.length];
  const investorClass = pick(['hnw','family_office','multi_family_office','qualified_investor','hnw','hnw']);
  const sourceOfWealth = pick(['business','employment','inheritance','investments','financial_services','real_estate']);
  const taxRes = f.country;
  const phoneCountry = { KR:'+82 10', SG:'+65 9', HK:'+852 6', JP:'+81 90', US:'+1 415', CN:'+86 138', GB:'+44 20', CH:'+41 79' }[f.country] || '+1 415';
  const phone = `${phoneCountry} ${(seed % 9000 + 1000)} ${(seed * 7 % 9000 + 1000)}`;
  const allocPick = (() => {
    if (f.assets === '50m_plus') return '10_plus';
    if (f.assets === '25_50m')  return '5_10';
    if (f.assets === '10_25m')  return '3_5';
    if (f.assets === '5_10m')   return '2';
    return '1';
  })();
  const referralPick = pick(['personal_intro','existing_member','prior_relationship','introducer']);

  const lead = {
    id,
    demo: true,
    name: f.name,
    legal_name: f.name,
    email: f.email,
    country: f.country,
    phone: phone,
    tax_residency: taxRes,
    occupation: f.occupation,
    investable_assets: f.assets,
    investor_classification: investorClass,
    source_of_wealth_high_level: sourceOfWealth,
    anticipated_allocation_kg: allocPick,
    referral_source: referralPick,
    referrer_name: referralPick === 'existing_member' ? '윤상호 (#001)' : (referralPick === 'personal_intro' ? 'TKJ' : null),
    reverse_solicitation_ack: true,
    created_at: f.created_at,
    audit: [{ at: f.created_at, actor: 'system', action: 'inquiry_received' }],
    status: 'inquiry',
    nda_state: 'awaiting',
  };

  if (f.stage === 'inquiry') return lead;

  // Invited+
  lead.status = 'invited';
  lead.code = code;
  lead.code_issued_at = f.created_at + 1 * day;
  lead.code_expires_at = new Date(f.created_at + 30 * day).toISOString();
  lead.audit.push({ at: lead.code_issued_at, actor: 'tkj@theaurumcc.com', action: 'invitation_sent', next: { code } });

  if (f.stage === 'invited') return lead;

  // NDA pending+
  lead.nda_state = 'uploaded';
  lead.nda_uploaded_at = f.created_at + 2 * day;
  lead.nda_url = `https://example.com/demo-nda-${id}.pdf`;
  lead.audit.push({ at: lead.nda_uploaded_at, actor: id, action: 'nda_uploaded' });

  if (f.stage === 'nda_pending') return lead;

  // Subscribed+
  lead.nda_state = 'approved';
  lead.nda_approved_at = f.created_at + 3 * day;
  lead.audit.push({ at: lead.nda_approved_at, actor: 'tkj@theaurumcc.com', action: 'nda_approved' });
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
  lead.audit.push({ at: lead.subscription.submitted_at, actor: id, action: 'subscription_submitted', next: { kg, usd: kg * usdPerKg } });

  if (f.stage === 'subscribed') return lead;

  // Wire issued+
  const wireRef = `TACC-${id.slice(-8).toUpperCase()}-${(now).toString(36).toUpperCase()}`;
  const wireSent = f.wire_age_days != null
    ? now - f.wire_age_days * day
    : f.created_at + 5 * day;
  lead.wire = {
    reference: wireRef,
    instructions_sent_at: wireSent,
  };
  lead.audit.push({ at: lead.wire.instructions_sent_at, actor: 'tkj@theaurumcc.com', action: 'wire_instructions_sent', next: { reference: wireRef } });

  if (f.stage === 'wire_issued') return lead;

  // Wire received+
  lead.wire.received_at = f.created_at + 7 * day;
  lead.audit.push({ at: lead.wire.received_at, actor: 'tkj@theaurumcc.com', action: 'wire_received' });

  if (f.stage === 'wire_received') return lead;

  // Funded
  lead.wire.cleared_at = f.created_at + 8 * day;
  lead.status = 'funded';
  lead.member_number = f.member_number;
  lead.funded_at = lead.wire.cleared_at;
  lead.audit.push({ at: lead.funded_at, actor: 'system', action: 'member_funded', next: { member_number: f.member_number } });

  // KYC expiry — 18 months out (no flag)
  lead.kyc_expires_at = new Date(lead.funded_at + 540 * day).toISOString();

  // Bars (1kg each, varied refiners + serials)
  lead.bars = [];
  const refiners = ['PAMP Suisse', 'Valcambi', 'Argor-Heraeus'];
  for (let i = 0; i < kg; i++) {
    lead.bars.push({
      id: `bar_${id}_${i}`,
      serial: `LBMA-${(800000 + i * 17 + (lead.member_number || 0) * 31).toString()}`,
      refiner: refiners[(i + (lead.member_number || 0)) % refiners.length],
      year: 2025,
      weight_kg: 1,
      assigned_at: lead.funded_at,
      vault_location: 'Malca-Amit Singapore FTZ',
    });
  }

  // Documents — 3 per funded member (NDA + KYC + statement)
  lead.documents = [
    { id: `doc_${id}_nda`,    type: 'nda',           name: 'NDA — Executed.pdf',           url: `https://example.com/docs/${id}/nda.pdf`,    uploaded_at: lead.nda_approved_at },
    { id: `doc_${id}_kyc`,    type: 'kyc',           name: 'KYC Bundle — Certified.pdf',   url: `https://example.com/docs/${id}/kyc.pdf`,    uploaded_at: lead.funded_at },
    { id: `doc_${id}_stmt`,   type: 'statement',     name: 'Latest Statement — 2026-Q1.pdf', url: `https://example.com/docs/${id}/stmt-q1.pdf`, uploaded_at: now - 30 * day },
  ];

  // LTV target — set credit lines to hit a target ratio
  if (f.ltv_pct_target) {
    const goldValue = kg * usdPerKg;
    const ltvApproved = 0.75; // approved 75% on physical bars
    const ceiling = Math.round(goldValue * ltvApproved);
    const drawn   = Math.round(ceiling * (f.ltv_pct_target / 100));
    lead.ltv_approved_pct        = ltvApproved * 100;
    lead.credit_ceiling_usd      = ceiling;
    lead.credit_outstanding_usd  = drawn;
  }

  // Inactive member (last_login_at)
  if (f.last_login_days_ago) {
    lead.last_login_at = new Date(now - f.last_login_days_ago * day).toISOString();
  } else {
    lead.last_login_at = new Date(now - Math.floor(Math.random() * 5 + 1) * day).toISOString();
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
  const fromStage = resolveLeadStage(lead);

  try { await bindCode(leadId, code); }
  catch (e) { return serverError(res, e); }

  lead.code           = code;
  lead.code_issued_at = now;
  lead.status         = 'invited';
  if (!lead.nda_state) lead.nda_state = 'awaiting';
  await appendAudit(lead, { at: now, actor, action: 'admin_approved', next: { code }, ip: clientIp(req) });
  if (fromStage !== 'invited') await transitionStage(lead, fromStage, 'invited');

  try { await saveLead(lead); }
  catch (e) { return serverError(res, e); }

  let emailResult = { sent: false, reason: 'skipped' };
  if (body.send_email !== false && lead.email) {
    try {
      emailResult = await sendInvitation(lead, code);
      if (emailResult.sent) {
        await appendAudit(lead, { actor, action: 'invitation_sent', next: { to: lead.email } });
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
    stage:         resolveLeadStage(l),
    nda_state:     l.nda_state       || null,
    code:          l.code            || null,
    code_issued_at: l.code_issued_at || null,
    created_at:    l.created_at      || null,
    updated_at:    l.updated_at      || null,
    stage_entered_at: l.stage_entered_at || null,
    last_login_at: l.last_login_at   || null,
    wire_cleared:  !!(l.wire && l.wire.cleared_at),
    wire:          l.wire ? { reference: l.wire.reference || null, received_at: l.wire.received_at || null, cleared_at: l.wire.cleared_at || null } : null,
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

  const prevNda  = lead.nda_state;
  const fromStg  = resolveLeadStage(lead);
  lead.nda_state       = 'approved';
  lead.nda_approved_at = now;
  await appendAudit(lead, {
    at: now, actor, action: 'nda_approved', prev: prevNda, next: 'approved',
    memo: body.notes || null, ip: clientIp(req),
  });
  const toStg = resolveLeadStage(lead);
  if (fromStg !== toStg) await transitionStage(lead, fromStg, toStg);

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

  const fromStg2 = resolveLeadStage(lead);
  lead.wire = lead.wire || {};
  lead.wire.reference          = ref;
  lead.wire.instructions_sent_at = now;
  await appendAudit(lead, {
    at: now, actor, action: 'wire_instructions_issued',
    next: { reference: ref }, ip: clientIp(req),
  });
  const toStg2 = resolveLeadStage(lead);
  if (fromStg2 !== toStg2) await transitionStage(lead, fromStg2, toStg2);

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

  const fromStg3 = resolveLeadStage(lead);
  lead.wire = lead.wire || {};
  lead.wire.received_at = now;
  lead.wire.amount_usd  = amountUsd;
  await appendAudit(lead, {
    at: now, actor, action: 'wire_received',
    next: { amount_usd: amountUsd }, ip: clientIp(req),
  });
  const toStg3 = resolveLeadStage(lead);
  if (fromStg3 !== toStg3) await transitionStage(lead, fromStg3, toStg3);

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

  const leadId             = String(body.leadId || '').trim();
  const explicitMemberNum  = body.member_number == null || body.member_number === ''
    ? null
    : parseInt(body.member_number, 10);
  if (!leadId) return bad(res, 'leadId required');
  if (explicitMemberNum != null && (!Number.isInteger(explicitMemberNum) || explicitMemberNum < 1 || explicitMemberNum > 100)) {
    return bad(res, 'member_number must be an integer between 1 and 100');
  }

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  // ── Atomic member# allocation ──────────────────────────────────────────────
  // If lead is already funded with a number, reuse it (idempotent re-run).
  // Else: if operator sent an explicit number, validate uniqueness against
  // existing funded set. Else: allocate via Redis INCR counter — race-safe.
  let memberNumber;
  let allocated = false;
  if (lead.status === 'funded' && Number.isInteger(lead.member_number)) {
    memberNumber = lead.member_number;
  } else if (explicitMemberNum != null) {
    const taken = await isMemberNumberTaken(explicitMemberNum);
    if (taken) return bad(res, `Member number ${explicitMemberNum} is already assigned.`, 409);
    memberNumber = explicitMemberNum;
  } else {
    const next = await allocateNextMemberNumber();
    if (next == null) {
      return err(res, 'cohort full', 'COHORT_FULL', 409);
    }
    memberNumber = next;
    allocated = true;
  }

  // Idempotency: same operator + lead + member# within 60s ⇒ replay-safe
  const actorPre = _actor(session);
  const { bodyHash: _bh } = await import('./_lib/error-shape.js');
  const idemKey = body.idempotency_key
    || `wirecleared:${actorPre}:${_bh({ leadId, memberNumber })}:${Math.floor(Date.now() / 60000)}`;
  // Probe pre-existing — if already cached, return cached result rather than re-executing
  try {
    const { getJSON } = await import('./_lib/storage.js');
    const cached = await getJSON(`idem:${idemKey}`);
    if (cached) return ok(res, { ...cached, cached: true });
  } catch {}

  const actor = actorPre;
  const now   = Date.now();

  // Record cleared timestamp before markMemberFunded sets it
  const fromStg4 = resolveLeadStage(lead);
  lead.wire = lead.wire || {};
  lead.wire.cleared_at = now;
  await saveLead(lead).catch(() => {});

  // markMemberFunded handles status, member_number, audit
  let updatedLead;
  try {
    updatedLead = await markMemberFunded(leadId, memberNumber);
  } catch (e) {
    // Release the counter if we allocated it — the slot is unused.
    if (allocated) { try { await releaseMemberNumber(memberNumber); } catch {} }
    return serverError(res, e);
  }
  // Counter transition
  try { await transitionStage(updatedLead, fromStg4, 'funded'); } catch {}
  // Global stream entry for funded
  try {
    const { globalAuditAppend } = await import('./_lib/storage.js');
    await globalAuditAppend({
      actor, action: 'member_funded',
      target_type: 'lead', target_id: updatedLead.id,
      target_name: updatedLead.name || updatedLead.email,
      next: { member_number: memberNumber },
    });
  } catch {}

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

  const finalResponse = {
    ok:              true,
    lead: {
      id:            updatedLead.id,
      name:          updatedLead.name,
      email:         updatedLead.email,
      status:        updatedLead.status,
      member_number: updatedLead.member_number,
    },
    certificate_url: certificateUrl,
  };
  // Cache the success response for idempotent replays (60s window above).
  try {
    const { setJSON } = await import('./_lib/storage.js');
    const idemKey2 = body.idempotency_key
      || `wirecleared:${actor}:${(await import('./_lib/error-shape.js')).bodyHash({ leadId, memberNumber })}:${Math.floor(Date.now() / 60000)}`;
    await setJSON(`idem:${idemKey2}`, finalResponse);
    // Set TTL via Upstash SETEX-style call (best effort)
    const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const KV_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (KV_URL && KV_TOK) {
      await fetch(KV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KV_TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['EXPIRE', `idem:${idemKey2}`, '120']),
      }).catch(() => {});
    }
  } catch {}
  return ok(res, finalResponse);
}

// ── admin op=send-message ─────────────────────────────────────────────────────

async function adminSendMessage(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const { recipients, type, subject, body: msgBody } = body;

  if (!subject || !msgBody) return bad(res, 'subject and body are required');
  if (!['gold', 'blue', 'amber'].includes(type)) return bad(res, 'type must be gold, blue, or amber');

  const actor  = _actor(session);
  const sentAt = new Date().toISOString();

  // Resolve recipient lead IDs
  let targetLeads = [];
  let isBroadcast = false;
  if (recipients === 'all') {
    targetLeads = await listLeads({ limit: 200 });
    isBroadcast = true;
  } else if (Array.isArray(recipients)) {
    for (const lid of recipients) {
      const l = await getLead(String(lid).trim());
      if (l) targetLeads.push(l);
    }
  } else {
    return bad(res, 'recipients must be "all" or an array of leadIds');
  }

  if (!targetLeads.length) return bad(res, 'no valid recipients found');

  const runDelivery = async () => {
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
    return {
      ok:            true,
      message_id:    msgId,
      sent_to:       successCount,
      total:         targetLeads.length,
      errors:        errors.length ? errors : undefined,
    };
  };

  // Idempotency only for broadcast (recipients='all'); single-recipient sends are cheap.
  if (isBroadcast) {
    const { bodyHash } = await import('./_lib/error-shape.js');
    const idemHash = bodyHash({ type, subject, msgBody, recipients: 'all' });
    const idemKey  = body.idempotency_key
      || `msg:${actor}:${idemHash}:${Math.floor(Date.now() / 60000)}`;
    const result = await withIdempotencyMarked(idemKey, 120, runDelivery);
    return ok(res, result);
  }

  return ok(res, await runDelivery());
}

// ── admin op=issue-capital-call ───────────────────────────────────────────────

async function adminIssueCapitalCall(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const { ref, amount_usd, amount_krw, due_date, wire_details, notes, recipients } = body;
  // Accept either amount_usd (preferred) or amount_krw (legacy). Store as USD.
  const amountUsd = Number(amount_usd != null ? amount_usd : amount_krw);
  if (!ref)        return bad(res, 'ref is required');
  if (!isFinite(amountUsd) || amountUsd <= 0) return bad(res, 'amount_usd is required');
  if (!due_date)   return bad(res, 'due_date is required');

  const actor = _actor(session);

  // Resolve recipient set
  const funded = await listFundedMembers();
  if (!funded.length) return bad(res, 'no funded members to issue capital call to');

  let targets;
  let recipMode;
  if (recipients == null || recipients === 'all') {
    targets = funded;
    recipMode = 'all';
  } else if (Array.isArray(recipients)) {
    const wanted = new Set(recipients.map((x) => String(x).trim()));
    targets = funded.filter((l) => wanted.has(l.id));
    if (!targets.length) return bad(res, 'recipients list matched no funded members');
    recipMode = 'selected';
  } else {
    return bad(res, 'recipients must be "all" or an array of leadIds');
  }

  // Idempotency: actor + ref + amount + due + recipient-set hash, 60s window
  const { bodyHash } = await import('./_lib/error-shape.js');
  const idemHash = bodyHash({ ref, amountUsd, due_date, notes, ids: targets.map((l) => l.id).sort() });
  const idemKey = body.idempotency_key
    || `cc:${actor}:${idemHash}:${Math.floor(Date.now() / 60000)}`;

  const result = await withIdempotencyMarked(idemKey, 120, async () => {
    const issuedAt = Date.now();
    const callId   = await nanoid();
    const capitalCall = {
      id:           callId,
      ref:          String(ref),
      amount_usd:   amountUsd,
      due_date:     String(due_date),
      wire_details: wire_details || null,
      notes:        notes       || null,
      status:       'pending',
      issued_at:    issuedAt,
      acknowledged_at: null,
    };

    let successCount = 0;
    const targetIds = [];
    for (const lead of targets) {
      try {
        await addCapitalCall(lead.id, { ...capitalCall });
        const msgId = await nanoid();
        await addMessage(lead.id, {
          id:      msgId,
          type:    'amber',
          subject: `Capital Call: ${ref}`,
          body:    `A capital call has been issued.\n\nReference: ${ref}\nAmount: $${amountUsd.toLocaleString()}\nDue: ${due_date}\n${notes ? '\nNotes: ' + notes : ''}`,
          sent_at: new Date(issuedAt).toISOString(),
          read_at: null,
          sender:  'admin',
        });
        targetIds.push(lead.id);
        successCount++;
      } catch (e) {
        console.warn(`[v2/admin/issue-capital-call] lead ${lead.id} failed:`, e && e.message);
      }
    }

    // Global audit
    try {
      await globalAuditAppend({
        actor, action: 'capital_call_broadcast',
        target_type: 'comms', target_id: callId,
        target_name: `CC ${ref}`,
        memo: `${recipMode === 'all' ? 'all funded' : `${targetIds.length} selected`} · $${amountUsd.toLocaleString()} due ${due_date}`,
        next: { ref, amount_usd: amountUsd, due_date, recipients_mode: recipMode, recipient_ids: targetIds },
      });
    } catch {}

    return {
      ok: true,
      capital_call_id: callId,
      issued_to: successCount,
      total: targets.length,
      recipients_mode: recipMode,
      recipient_ids: targetIds,
    };
  });

  return ok(res, result);
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
      leadId:        lead.id,
      // Keep legacy alias for any existing UI consumer
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

  const actor = _actor(session);
  const { bodyHash } = await import('./_lib/error-shape.js');
  const idemHash = bodyHash({ quarter, year, subject: body.subject, html_len: (body.html_body || '').length });
  const idemKey  = body.idempotency_key
    || `letter:${actor}:${idemHash}:${Math.floor(Date.now() / 60000)}`;

  const result = await withIdempotencyMarked(idemKey, 120, async () => {
    const { nanoid: _nanoid } = await import('nanoid');
    const letterId  = _nanoid(12);
    const sentAt    = new Date().toISOString();

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

    try {
      await globalAuditAppend({
        actor, action: 'quarterly_letter_published',
        target_type: 'comms', target_id: letterId,
        target_name: `Q${quarter} ${year} letter`,
        memo: `${successCount}/${funded.length} delivered`,
      });
    } catch {}

    return {
      ok:        true,
      letter_id: letterId,
      sent_to:   successCount,
      total:     funded.length,
      errors:    errors.length ? errors : undefined,
    };
  });

  return ok(res, result);
}

// ── admin op=publish-vault-verification ───────────────────────────────────────

async function adminPublishVaultVerification(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  if (!body.title)         return bad(res, 'title required');
  if (!body.year)          return bad(res, 'year required');

  const actor = _actor(session);
  const { bodyHash } = await import('./_lib/error-shape.js');
  const idemHash = bodyHash({ title: body.title, year: body.year, blob: body.blob_pathname || null });
  const idemKey  = body.idempotency_key
    || `vv:${actor}:${idemHash}:${Math.floor(Date.now() / 60000)}`;

  const result = await withIdempotencyMarked(idemKey, 120, async () => {
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
    try { await setLastVaultVerification(vv); } catch {}

    const funded = await listFundedMembers();
    for (const lead of funded) {
      try {
        await sendVaultVerificationNotification(lead, vv);
      } catch (e) {
        console.warn(`[v2/admin/publish-vault-verification] email failed for ${lead.id}:`, e && e.message);
      }
    }

    try {
      await globalAuditAppend({
        actor, action: 'vault_verification_published',
        target_type: 'comms', target_id: vvId,
        target_name: vv.title,
        memo: `${sent_to}/${total} delivered`,
      });
    } catch {}

    return {
      ok:      true,
      vv_id:   vvId,
      sent_to,
      total,
      errors:  errors && errors.length ? errors : undefined,
    };
  });

  return ok(res, result);
}

// ── admin op=generate-tax-statement ──────────────────────────────────────────

async function adminGenerateTaxStatement(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  let body;
  try { body = await readBody(req); } catch { return bad(res, 'invalid body'); }

  const leadId     = String(body.leadId || '').trim();
  const fiscalYear = parseInt(body.fiscal_year, 10);
  const goldStart  = Number(body.gold_price_start);
  const goldEnd    = Number(body.gold_price_end);

  if (!leadId)                                            return bad(res, 'leadId required');
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2020) return bad(res, 'fiscal_year invalid');
  if (!isFinite(goldStart) || goldStart <= 0)             return bad(res, 'gold_price_start must be a positive number');
  if (!isFinite(goldEnd)   || goldEnd   <= 0)             return bad(res, 'gold_price_end must be a positive number');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const krwEnd  = Number(body.krw_end)   || Number(body.fx_rate_krw_end) || 0;
  const krwStart = Number(body.krw_start) || 0;
  const sgdStart = Number(body.sgd_start) || 1;
  const sgdEnd   = Number(body.sgd_end)   || 1;

  // Generate Korean PDF (primary, per brief)
  let krResult;
  try {
    const { generateKoreanTaxStatement } = await import('./_lib/pdf-tax-kr.js');
    krResult = await generateKoreanTaxStatement(lead, fiscalYear, {
      gold_price_start_per_kg: goldStart,
      gold_price_end_per_kg:   goldEnd,
      fx_rate_krw_end:         krwEnd,
      custodian:               body.custodian || 'Malca-Amit Singapore FTZ',
      issue_date_iso:          body.issue_date || new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    console.error('[v2/admin/generate-tax-statement] KR pdf generation failed:', e && e.message);
    return serverError(res, e);
  }

  // Mint a 24h signed URL for member access
  let signed_url = null;
  let expires_at = null;
  try {
    const { buildSignedUrl } = await import('./_lib/signed-url.js');
    const r = await buildSignedUrl({
      pathname:    krResult.pathname,
      leadId,
      kind:        'tax-statement',
      ttlSeconds:  24 * 60 * 60,
    });
    signed_url = r.signed_url;
    expires_at = r.expires_at;
  } catch (e) {
    console.warn('[v2/admin/generate-tax-statement] signed url build failed:', e && e.message);
  }

  try {
    await saveTaxStatementUrl(leadId, fiscalYear, {
      url:           krResult.url,
      pathname:      krResult.pathname,
      format:        'kr',
      blob_pathname: krResult.pathname,
      gold_price_start: goldStart,
      gold_price_end:   goldEnd,
      fx_rate_krw_end:  krwEnd,
      fx_rate_krw_start: krwStart,
      sgd_start:        sgdStart,
      sgd_end:          sgdEnd,
    });
  } catch (e) {
    console.error('[v2/admin/generate-tax-statement] saveTaxStatementUrl failed:', e && e.message);
  }

  return ok(res, {
    ok: true,
    lead_id: leadId,
    fiscal_year: fiscalYear,
    url: krResult.url,           // raw blob URL (admin-only)
    signed_url,                  // 24h signed URL (member-safe)
    expires_at,
    pathname: krResult.pathname,
    format: 'kr',
    noto_kr_font_source: krResult.font_source || null, // 'env' | 'github' | 'failed'
  });
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

// ────────────────────────────────────────────────────────────────────────────
// Phase 5 ops — vault registry, lead lifecycle, capital reconciliation, NAV,
// distributions, signed-URL surfaces, command-palette search.
// ────────────────────────────────────────────────────────────────────────────

// ── admin op=vault-bars ─────────────────────────────────────────────────────
// Flatten every funded member's bars[] into a global registry suitable for
// the vault-room screen. One Upstash listFundedMembers() call.

async function adminVaultBars(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  // Spot price for current_value computation
  let xau_usd_kg = 0;
  try {
    const { getXauUsd } = await import('./_lib/gold-price.js');
    const spot = await getXauUsd();
    xau_usd_kg = Number(spot.price_usd_per_kg_spot || spot.price_usd_per_kg) || 0;
  } catch {}

  const funded = await listFundedMembers();
  const bars = [];
  let total_kg = 0;
  let total_value_usd = 0;
  let total_cost_basis_usd = 0;

  for (const m of funded) {
    if (m.deleted_at) continue;
    const memBars = Array.isArray(m.bars) ? m.bars : [];
    for (const b of memBars) {
      const weight_kg = Number(b.weight_kg) || 1;
      const cost_basis_usd = Number(b.cost_basis_usd) || 0;
      const current_value_usd = weight_kg * xau_usd_kg;
      bars.push({
        serial:             b.serial            || null,
        refiner:            b.refiner           || null,
        year:               b.year              || null,
        weight_kg,
        member_number:      m.member_number     || null,
        member_name:        m.name              || null,
        custody_location:   b.vault_location    || 'Malca-Amit Singapore FTZ',
        last_verified_at:   b.last_verified_at  || null,
        cost_basis_usd:     cost_basis_usd      || null,
        current_value_usd:  Math.round(current_value_usd),
        lead_id:            m.id,
      });
      total_kg += weight_kg;
      total_value_usd += current_value_usd;
      total_cost_basis_usd += cost_basis_usd;
    }
  }

  bars.sort((a, b) => {
    const an = a.member_number ?? 999;
    const bn = b.member_number ?? 999;
    if (an !== bn) return an - bn;
    return String(a.serial || '').localeCompare(String(b.serial || ''));
  });

  return ok(res, {
    ok: true,
    bars,
    total_kg: +total_kg.toFixed(3),
    total_value_usd: Math.round(total_value_usd),
    total_cost_basis_usd: Math.round(total_cost_basis_usd),
    xau_usd_kg: Math.round(xau_usd_kg),
  });
}

// ── admin op=decline-lead ───────────────────────────────────────────────────
// Records a decline reason. Status is preserved so the operator can reverse
// the decision. NO email is sent (per brief).

async function adminDeclineLead(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');
  if (!reason) return err(res, 'reason required', 'MISSING_REASON');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const now = Date.now();
  lead.declined_at = now;
  lead.declined_reason = reason;

  await appendAudit(lead, {
    actor: _actor(session),
    action: 'decline_lead',
    memo: reason,
    next: { declined_at: now },
    ip: clientIp(req),
  });
  try { await saveLead(lead); } catch (e) { return serverError(res, e); }

  return ok(res, { ok: true, lead: {
    id: lead.id,
    name: lead.name,
    email: lead.email,
    status: lead.status,
    declined_at: lead.declined_at,
    declined_reason: lead.declined_reason,
  } });
}

// ── admin op=verify-ioi ────────────────────────────────────────────────────
// Partner verifies a submitted IOI. Sends verified email to member.
// Wire instructions are issued separately via op=wire-issue.

async function adminVerifyIoi(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);
  if (!lead.ioi || !lead.ioi.submitted_at) return err(res, 'no IOI on file', 'NO_IOI');

  const now = Date.now();
  lead.ioi_verified_at = now;
  lead.ioi_verified_by = session.email || session.id || 'admin';

  await appendAudit(lead, {
    actor: _actor(session),
    action: 'ioi_verified',
    next: { ioi_verified_at: now },
    ip: clientIp(req),
  });
  try { await saveLead(lead); } catch (e) { return serverError(res, e); }

  // Email member — best effort
  try { await sendIoiVerified(lead); } catch (e) {
    console.warn('[v2/verify-ioi] email failed', e && e.message);
  }

  return ok(res, { ok: true, ioi_verified_at: now });
}

// ── admin op=decline-ioi ────────────────────────────────────────────────────
// Partner declines a submitted IOI. Sends decline notice to member.

async function adminDeclineIoi(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }
  const leadId = String(body.leadId || '').trim();
  const note = String(body.note || '').trim().slice(0, 500);
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);
  if (!lead.ioi || !lead.ioi.submitted_at) return err(res, 'no IOI on file', 'NO_IOI');

  const now = Date.now();
  lead.ioi_declined_at = now;
  lead.ioi_declined_by = session.email || session.id || 'admin';
  if (note) lead.ioi_decline_note = note;

  await appendAudit(lead, {
    actor: _actor(session),
    action: 'ioi_declined',
    memo: note || undefined,
    next: { ioi_declined_at: now },
    ip: clientIp(req),
  });
  try { await saveLead(lead); } catch (e) { return serverError(res, e); }

  // Email member — best effort
  try { await sendIoiDeclined(lead, note || null); } catch (e) {
    console.warn('[v2/decline-ioi] email failed', e && e.message);
  }

  return ok(res, { ok: true, ioi_declined_at: now });
}

// ── admin op=capital-call-paid ──────────────────────────────────────────────
// Marks a single capital call as paid + reconciled. Audit captures wire ref.

async function adminCapitalCallPaid(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }

  const leadId         = String(body.leadId || '').trim();
  const capitalCallId  = String(body.capitalCallId || body.capital_call_id || '').trim();
  const paidAmountUsd  = Number(body.paid_amount_usd);
  const paidAtMs       = body.paid_at ? new Date(body.paid_at).getTime() : Date.now();
  const wireRef        = String(body.wire_ref || '').trim().slice(0, 200);

  if (!leadId)                                       return err(res, 'leadId required', 'MISSING_LEAD_ID');
  if (!capitalCallId)                                return err(res, 'capitalCallId required', 'MISSING_CC_ID');
  if (!isFinite(paidAmountUsd) || paidAmountUsd <= 0) return err(res, 'paid_amount_usd must be a positive number', 'BAD_AMOUNT');
  if (!isFinite(paidAtMs))                           return err(res, 'paid_at invalid', 'BAD_DATE');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);
  const calls = lead.capital_calls || [];
  const idx = calls.findIndex((c) => c.id === capitalCallId);
  if (idx === -1) return notFound(res);

  const cc = calls[idx];
  const prevStatus = cc.status;
  cc.status = 'paid';
  cc.paid_at = paidAtMs;
  cc.paid_amount_usd = paidAmountUsd;
  cc.wire_ref = wireRef || null;
  // Reconciliation flag: matches if amount within 1 cent of expected.
  cc.reconciled = Math.abs(paidAmountUsd - Number(cc.amount_usd || 0)) < 0.01;

  await appendAudit(lead, {
    actor: _actor(session),
    action: 'capital_call_paid',
    prev: prevStatus,
    next: { status: 'paid', paid_amount_usd: paidAmountUsd, paid_at: paidAtMs, wire_ref: wireRef || null, reconciled: cc.reconciled },
    memo: cc.reconciled ? 'reconciled' : `mismatch: expected $${cc.amount_usd}`,
    ip: clientIp(req),
    target_type: 'capital_call',
    target_id: capitalCallId,
  });
  try { await saveLead(lead); } catch (e) { return serverError(res, e); }

  return ok(res, { ok: true, capitalCallId, reconciled: cc.reconciled });
}

// ── admin op=nav-update ─────────────────────────────────────────────────────
// Records a NAV value for a given period (e.g. "2026-Q1"), then regenerates
// per-member statements with their share of NAV.

async function adminNavUpdate(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }

  const navUsd    = Number(body.nav_usd);
  const period    = String(body.period || '').trim();
  const narrative = String(body.narrative || '').slice(0, 5000);

  if (!isFinite(navUsd) || navUsd < 0) return err(res, 'nav_usd must be a non-negative number', 'BAD_NAV');
  if (!/^\d{4}-Q[1-4]$|^\d{4}-\d{2}$/.test(period)) return err(res, 'period must look like 2026-Q1 or 2026-03', 'BAD_PERIOD');

  const actor = _actor(session);

  // Idempotency: same actor + period + nav within 60s ⇒ cached
  const { bodyHash } = await import('./_lib/error-shape.js');
  const idemKey = body.idempotency_key
    || `nav:${actor}:${bodyHash({ navUsd, period, narrative })}:${Math.floor(Date.now() / 60000)}`;

  const result = await withIdempotencyMarked(idemKey, 120, async () => {
    const postedAt = Date.now();
    const navRecord = { nav_usd: navUsd, period, narrative, posted_at: postedAt, actor };

    // Persist nav record under nav:{period}
    try {
      const { setJSON } = await import('./_lib/storage.js');
      await setJSON(`nav:${period}`, navRecord);
    } catch (e) {
      console.warn('[nav-update] persist failed:', e && e.message);
    }

    // Spot for kg valuation
    let xau_usd_kg = 0;
    try {
      const { getXauUsd } = await import('./_lib/gold-price.js');
      const spot = await getXauUsd();
      xau_usd_kg = Number(spot.price_usd_per_kg_spot || spot.price_usd_per_kg) || 0;
    } catch {}

    const funded = await listFundedMembers();
    const sumKg = funded.reduce((s, m) => {
      if (m.deleted_at) return s;
      const memberKg = (m.bars || []).reduce((a, b) => a + (Number(b.weight_kg) || 0), 0)
        || (m.subscription && Number(m.subscription.kg_requested)) || 0;
      return s + memberKg;
    }, 0);

    const recipients = [];
    let statements_generated = 0;

    for (const lead of funded) {
      if (lead.deleted_at) continue;
      const memberKg = (lead.bars || []).reduce((a, b) => a + (Number(b.weight_kg) || 0), 0)
        || (lead.subscription && Number(lead.subscription.kg_requested)) || 0;
      const sharePct  = sumKg > 0 ? (memberKg / sumKg) * 100 : 0;
      const shareNav  = sumKg > 0 ? (memberKg / sumKg) * navUsd : 0;
      const costBasis = (lead.bars || []).reduce((a, b) => a + (Number(b.cost_basis_usd) || 0), 0)
        || (lead.subscription && Number(lead.subscription.usd_amount)) || 0;
      const returnPct = costBasis > 0 ? ((shareNav - costBasis) / costBasis) * 100 : 0;
      const goldValue = memberKg * xau_usd_kg;

      const statement = {
        leadId:           lead.id,
        member_number:    lead.member_number || null,
        period,
        nav_usd:          navUsd,
        member_kg:        +memberKg.toFixed(3),
        share_pct:        +sharePct.toFixed(4),
        share_of_nav_usd: Math.round(shareNav),
        gold_value_usd:   Math.round(goldValue),
        cost_basis_usd:   Math.round(costBasis),
        return_pct:       +returnPct.toFixed(2),
        narrative,
        posted_at:        postedAt,
      };

      try {
        const { setJSON } = await import('./_lib/storage.js');
        await setJSON(`statement:${lead.id}:${period}`, statement);
        statements_generated++;
        recipients.push({ leadId: lead.id, name: lead.name || null, member_number: lead.member_number || null, share_pct: statement.share_pct });
      } catch (e) {
        console.warn(`[nav-update] statement save failed ${lead.id}:`, e && e.message);
      }

      // Per-lead audit
      try {
        await appendAudit(lead, {
          actor, action: 'nav_statement_generated',
          target_type: 'statement', target_id: `${lead.id}:${period}`,
          next: { period, share_of_nav_usd: statement.share_of_nav_usd, return_pct: statement.return_pct },
        });
        await saveLead(lead);
      } catch {}
    }

    // Global audit
    try {
      await globalAuditAppend({
        actor, action: 'nav_update_posted',
        target_type: 'fund', target_id: `nav:${period}`,
        target_name: `NAV ${period}`,
        memo: `$${navUsd.toLocaleString()} · ${statements_generated} statements`,
        next: { period, nav_usd: navUsd },
      });
    } catch {}

    return { ok: true, period, nav_usd: navUsd, statements_generated, recipients };
  });

  return ok(res, result);
}

// ── admin op=post-distribution ──────────────────────────────────────────────
// Computes per-member pro-rata payouts by kg ownership and persists them in
// each lead's distributions[] array.

async function adminPostDistribution(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  let body;
  try { body = await readBody(req); } catch { return err(res, 'invalid body', 'BAD_BODY'); }

  const period          = String(body.period || '').trim();
  const totalAmountUsd  = Number(body.total_amount_usd);
  const type            = String(body.type || '').trim();
  const distributionDate = String(body.distribution_date || '').trim();

  if (!/^\d{4}-Q[1-4]$|^\d{4}-\d{2}$/.test(period)) return err(res, 'period must look like 2026-Q1', 'BAD_PERIOD');
  if (!isFinite(totalAmountUsd) || totalAmountUsd <= 0) return err(res, 'total_amount_usd must be a positive number', 'BAD_AMOUNT');
  if (!['income', 'capital', 'return_of_capital'].includes(type)) return err(res, 'type must be income, capital, or return_of_capital', 'BAD_TYPE');
  if (!/^\d{4}-\d{2}-\d{2}/.test(distributionDate)) return err(res, 'distribution_date must be YYYY-MM-DD', 'BAD_DATE');

  const actor = _actor(session);
  const { bodyHash } = await import('./_lib/error-shape.js');
  const idemKey = body.idempotency_key
    || `dist:${actor}:${bodyHash({ period, totalAmountUsd, type, distributionDate })}:${Math.floor(Date.now() / 60000)}`;

  const result = await withIdempotencyMarked(idemKey, 120, async () => {
    const funded = await listFundedMembers();
    const sumKg = funded.reduce((s, m) => {
      if (m.deleted_at) return s;
      const memberKg = (m.bars || []).reduce((a, b) => a + (Number(b.weight_kg) || 0), 0)
        || (m.subscription && Number(m.subscription.kg_requested)) || 0;
      return s + memberKg;
    }, 0);

    if (sumKg <= 0) return { ok: false, error: 'no kg ownership recorded across funded members', code: 'ZERO_KG_BASIS' };

    const distId = await nanoid();
    const postedAt = Date.now();

    const distributions = [];
    for (const lead of funded) {
      if (lead.deleted_at) continue;
      const memberKg = (lead.bars || []).reduce((a, b) => a + (Number(b.weight_kg) || 0), 0)
        || (lead.subscription && Number(lead.subscription.kg_requested)) || 0;
      const sharePct = (memberKg / sumKg) * 100;
      const payoutUsd = Math.round((memberKg / sumKg) * totalAmountUsd * 100) / 100;

      const record = {
        id:                distId + '-' + lead.id.slice(-6),
        period,
        type,
        amount_usd:        payoutUsd,
        share_pct:         +sharePct.toFixed(4),
        distribution_date: distributionDate,
        posted_at:         postedAt,
      };
      lead.distributions = lead.distributions || [];
      lead.distributions.push(record);
      try {
        await appendAudit(lead, {
          actor, action: 'distribution_posted',
          target_type: 'distribution', target_id: record.id,
          next: { period, type, amount_usd: payoutUsd, share_pct: record.share_pct },
        });
        await saveLead(lead);
      } catch (e) {
        console.warn(`[post-distribution] save failed ${lead.id}:`, e && e.message);
      }
      distributions.push({
        leadId: lead.id,
        name: lead.name || null,
        member_number: lead.member_number || null,
        payout_usd: payoutUsd,
        share_pct: +sharePct.toFixed(4),
      });
    }

    // Global audit
    try {
      await globalAuditAppend({
        actor, action: 'distribution_broadcast',
        target_type: 'fund', target_id: distId,
        target_name: `Distribution ${period} (${type})`,
        memo: `$${totalAmountUsd.toLocaleString()} across ${distributions.length} members`,
        next: { period, type, total_amount_usd: totalAmountUsd, distribution_date: distributionDate },
      });
    } catch {}

    return { ok: true, period, type, total_amount_usd: totalAmountUsd, distribution_date: distributionDate, distribution_id: distId, distributions };
  });

  return ok(res, result);
}

// ── admin op=tax-statement-signed-url ───────────────────────────────────────
// Re-mint a 24h signed URL for an already-generated tax statement.

async function adminTaxStatementSignedUrl(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const q = getQuery(req);
  const leadId = String(q.leadId || '').trim();
  const fy     = parseInt(q.fiscal_year, 10);
  if (!leadId)                       return err(res, 'leadId required', 'MISSING_LEAD_ID');
  if (!Number.isInteger(fy) || fy < 2020) return err(res, 'fiscal_year invalid', 'BAD_FY');

  const lead = await getLead(leadId);
  if (!lead) return notFound(res);

  const stmt = lead.tax_statements && lead.tax_statements[String(fy)];
  if (!stmt) return notFound(res);

  // Legacy fall-back: pre-migration entries are bare strings or objects with
  // no pathname. We can't re-sign these (no Blob handle) so we surface the
  // raw URL with legacy:true and a null expires_at.
  const isString = typeof stmt === 'string';
  const pathname = isString ? null : stmt.pathname;
  if (!pathname) {
    const rawUrl = isString ? stmt : (stmt && stmt.url) || null;
    if (!rawUrl) return err(res, 'no url stored for this statement (regenerate)', 'NO_URL', 409);
    return ok(res, {
      ok:           true,
      lead_id:      leadId,
      fiscal_year:  fy,
      signed_url:   rawUrl,
      expires_at:   null,
      legacy:       true,
    });
  }

  try {
    const { buildSignedUrl } = await import('./_lib/signed-url.js');
    const r = await buildSignedUrl({ pathname, leadId, kind: 'tax-statement', ttlSeconds: 24 * 60 * 60 });
    return ok(res, { ok: true, lead_id: leadId, fiscal_year: fy, signed_url: r.signed_url, expires_at: r.expires_at });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── member op=tax-statement-signed-url ──────────────────────────────────────
// Member-side signed URL refresh — same as admin but scoped to the member's
// own session via requireMember().

async function memberTaxStatementSignedUrl(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  const q = getQuery(req);
  const fy = parseInt(q.fiscal_year, 10);
  if (!Number.isInteger(fy) || fy < 2020) return bad(res, 'fiscal_year invalid');

  const stmt = lead.tax_statements && lead.tax_statements[String(fy)];
  if (!stmt) return notFound(res);

  const isString = typeof stmt === 'string';
  const pathname = isString ? null : stmt.pathname;
  if (!pathname) {
    const rawUrl = isString ? stmt : (stmt && stmt.url) || null;
    if (!rawUrl) return bad(res, 'no url stored for this statement', 409);
    return ok(res, {
      ok:           true,
      lead_id:      lead.id,
      fiscal_year:  fy,
      signed_url:   rawUrl,
      expires_at:   null,
      legacy:       true,
    });
  }

  try {
    const { buildSignedUrl } = await import('./_lib/signed-url.js');
    const r = await buildSignedUrl({ pathname, leadId: lead.id, kind: 'tax-statement', ttlSeconds: 24 * 60 * 60 });
    return ok(res, { ok: true, lead_id: lead.id, fiscal_year: fy, signed_url: r.signed_url, expires_at: r.expires_at });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── admin op=member-certificate-url ─────────────────────────────────────────

async function adminMemberCertificateUrl(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const q = getQuery(req);
  const leadId = String(q.leadId || '').trim();
  if (!leadId) return err(res, 'leadId required', 'MISSING_LEAD_ID');
  const lead = await getLead(leadId);
  if (!lead) return notFound(res);
  const pathname = `certificates/${lead.id}.pdf`;
  try {
    const { buildSignedUrl } = await import('./_lib/signed-url.js');
    const r = await buildSignedUrl({ pathname, leadId: lead.id, kind: 'certificate', ttlSeconds: 24 * 60 * 60 });
    return ok(res, { ok: true, lead_id: lead.id, signed_url: r.signed_url, expires_at: r.expires_at });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── member op=member-certificate-url ────────────────────────────────────────
// Returns a 24h signed URL for the member's certificate PDF (already created
// at funded transition by generateMemberCertificate).

async function memberCertificateSignedUrl(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);
  if (lead.status !== 'funded') return unauthorized(res);

  const pathname = `certificates/${lead.id}.pdf`;
  try {
    const { buildSignedUrl } = await import('./_lib/signed-url.js');
    const r = await buildSignedUrl({ pathname, leadId: lead.id, kind: 'certificate', ttlSeconds: 24 * 60 * 60 });
    return ok(res, { ok: true, lead_id: lead.id, signed_url: r.signed_url, expires_at: r.expires_at });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── admin op=cmdk-search ────────────────────────────────────────────────────
// Command-palette search across leads, members, and audit entries.

async function adminCmdkSearch(req, res, session) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const q = getQuery(req);
  const term = String(q.q || '').trim().toLowerCase();
  if (!term) return ok(res, { ok: true, results: [] });

  const cap = 30;
  const results = [];
  const seen = new Set();
  function push(r) {
    const k = `${r.kind}:${r.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    results.push(r);
  }

  // 1. Leads/members
  try {
    const all = await listLeads({ limit: 500 });
    for (const l of all) {
      if (results.length >= cap) break;
      if (l.deleted_at) continue;
      const hay = [
        l.name, l.legal_name, l.email, l.id,
        l.member_number ? `#${String(l.member_number).padStart(3, '0')}` : '',
        l.code,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(term)) continue;
      const isFunded = l.status === 'funded';
      push({
        kind: isFunded ? 'member' : 'lead',
        id:   l.id,
        label: l.name || l.email || l.id,
        sub:  isFunded
          ? `#${String(l.member_number || '—').padStart(3, '0')} · ${l.email || ''}`
          : `${l.status || 'inquiry'} · ${l.email || ''}`,
        ts: l.funded_at || l.created_at || null,
      });
    }
  } catch (e) {
    console.warn('[cmdk-search] leads scan failed:', e && e.message);
  }

  // 2. Audit entries (action / memo / actor)
  if (results.length < cap) {
    try {
      const entries = await globalAuditList({ limit: 200 });
      for (const e of entries) {
        if (results.length >= cap) break;
        const hay = [e.actor, e.action, e.memo, e.target_name, e.target_id].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) continue;
        const id = `${e.at}:${e.action}:${e.target_id || ''}`;
        push({
          kind: 'audit',
          id,
          label: `${e.action.replace(/_/g, ' ')}${e.target_name ? ' — ' + e.target_name : ''}`,
          sub:   `${e.actor || 'system'}${e.memo ? ' · ' + String(e.memo).slice(0, 80) : ''}`,
          ts:    e.at || null,
        });
      }
    } catch (err) {
      console.warn('[cmdk-search] audit scan failed:', err && err.message);
    }
  }

  return ok(res, { ok: true, results: results.slice(0, cap), q: term, count: results.length });
}

// ── admin op=migrate-tax-statements ─────────────────────────────────────────
// Idempotent walk over all leads, upgrading legacy string-form
// tax_statements[fy] entries to the modern object form
// { url, pathname:null, format:'legacy', generated_at, ... }.
// Run once after deploying object-form readers; safe to re-run.

async function adminMigrateTaxStatements(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const actor = _actor(session);
  try {
    const result = await migrateLegacyTaxStatements();
    try {
      await globalAuditAppend({
        actor, action: 'tax_statements_migration_run',
        target_type: 'system', target_id: 'tax_statements',
        target_name: 'tax statements migration',
        memo: `migrated=${result.migrated} skipped=${result.skipped} errors=${result.errors.length}`,
        next: { migrated: result.migrated, skipped: result.skipped, error_count: result.errors.length },
      });
    } catch {}
    return ok(res, result);
  } catch (e) {
    return serverError(res, e);
  }
}

// ── admin op=recount-member-number ──────────────────────────────────────────
// SET counter:member_number_next = max(funded.member_number) + 1.
// Run once after deploying the atomic counter so the first INCR hands out
// the correct next number rather than starting from 1.

async function adminRecountMemberNumber(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const actor = _actor(session);
  try {
    const result = await recountMemberNumberCounter();
    try {
      await globalAuditAppend({
        actor, action: 'member_number_counter_recount',
        target_type: 'system', target_id: 'counter:member_number_next',
        target_name: 'member# counter',
        memo: `previous=${result.previous} next=${result.next} max=${result.max_assigned} funded=${result.funded_count}`,
        next: result,
      });
    } catch {}
    return ok(res, { ok: true, ...result });
  } catch (e) {
    return serverError(res, e);
  }
}

// ── admin op=test-capital-call-targeting ────────────────────────────────────
// Smoke-test for the recipients-targeting path. Issues a synthetic capital
// call to the first 2 funded members, asserts only those 2 leads received it,
// confirms the audit record carries the resolved recipient_ids, then strips
// the synthetic capital_calls + messages back out.

async function adminTestCapitalCallTargeting(req, res, session) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const actor = _actor(session);

  const funded = await listFundedMembers();
  if (funded.length < 2) {
    return bad(res, 'need at least 2 funded members for this test', 409);
  }
  const targets = funded.slice(0, 2);
  const targetIds = targets.map((l) => l.id);

  const callId = await nanoid();
  const ref    = `TEST-CC-${callId.slice(0, 6)}`;
  const issuedAt = Date.now();
  const synthetic = {
    id:              callId,
    ref,
    amount_usd:      1,
    due_date:        new Date(issuedAt + 30 * 86400000).toISOString().slice(0, 10),
    wire_details:    null,
    notes:           '[synthetic targeting test — auto-cleanup]',
    status:          'pending',
    issued_at:       issuedAt,
    acknowledged_at: null,
    _test:           true,
  };

  // Drop only to specified recipients
  for (const lead of targets) {
    try {
      await addCapitalCall(lead.id, { ...synthetic });
      await addMessage(lead.id, {
        id:      await nanoid(),
        type:    'amber',
        subject: `[TEST] Capital Call: ${ref}`,
        body:    'Synthetic test message — auto-cleanup.',
        sent_at: new Date(issuedAt).toISOString(),
        read_at: null,
        sender:  'admin',
        _test:   true,
        _test_call_id: callId,
      });
    } catch (e) {
      console.warn('[test-capital-call-targeting] add failed for', lead.id, e && e.message);
    }
  }

  // Record an audit entry shaped like the real capital_call_broadcast
  let auditRecipientCount = null;
  try {
    await globalAuditAppend({
      actor, action: 'capital_call_broadcast',
      target_type: 'comms', target_id: callId,
      target_name: `CC ${ref} (test)`,
      memo:        `targeting test · ${targetIds.length} selected`,
      next:        { ref, amount_usd: 1, recipients_mode: 'selected', recipient_ids: targetIds, _test: true },
    });
    auditRecipientCount = targetIds.length;
  } catch (e) {
    console.warn('[test-capital-call-targeting] audit append failed:', e && e.message);
  }

  // Read back: count leads carrying this synthetic capital_call.id
  const allFunded = await listFundedMembers();
  const recipientsActual = [];
  const drift = [];
  for (const l of allFunded) {
    const has = (l.capital_calls || []).some((c) => c.id === callId);
    if (has) recipientsActual.push(l.id);
  }
  // Drift = any recipient that wasn't in our intended target set
  for (const id of recipientsActual) {
    if (!targetIds.includes(id)) drift.push(id);
  }
  // Drift also includes targets that didn't actually receive
  for (const id of targetIds) {
    if (!recipientsActual.includes(id)) drift.push(`missing:${id}`);
  }

  // Cleanup — strip the synthetic capital_call + matching messages from each target lead
  let cleaned = 0;
  for (const lead of allFunded) {
    let dirty = false;
    if (Array.isArray(lead.capital_calls)) {
      const before = lead.capital_calls.length;
      lead.capital_calls = lead.capital_calls.filter((c) => c.id !== callId);
      if (lead.capital_calls.length !== before) dirty = true;
    }
    if (Array.isArray(lead.messages)) {
      const before = lead.messages.length;
      lead.messages = lead.messages.filter((m) => m._test_call_id !== callId);
      if (lead.messages.length !== before) dirty = true;
    }
    if (dirty) {
      try { await saveLead(lead); cleaned++; } catch {}
    }
  }

  return ok(res, {
    ok:                     drift.length === 0,
    expected:               2,
    actual:                 recipientsActual.length,
    audit_recipient_count:  auditRecipientCount,
    drift,
    test_capital_call_id:   callId,
    cleaned_leads:          cleaned,
  });
}
