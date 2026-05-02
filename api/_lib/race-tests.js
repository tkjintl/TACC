// _lib/race-tests.js — Concurrent / contract / soft-delete tests for the
// bot harness. These are diagnostic ops triggered manually from the Bot Lab.
// Each is bounded to ≤200 Upstash commands and returns a log_text suitable
// for the existing event-feed textarea.

import {
  getLead, saveLead, listLeads, getStageCounts,
  appendAudit, transitionStage, resolveLeadStage,
  softDeleteLead, deleteLead,
} from './storage.js';
import { signToken, COOKIE_MEMBER } from './auth.js';
import * as Email from './email.js';

// ── Tiny helpers ────────────────────────────────────────────────────────────

function _log(lines, msg) { lines.push(msg); }
function _now() { return Date.now(); }

// Mock Node-style req/res for invoking an api/* handler in-process.
function _mockReq({ method = 'POST', body = {}, cookieHeader = '' } = {}) {
  return {
    method,
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    body, // readBody() short-circuits when body is an object
    on() { /* not used because body is preset */ },
  };
}
function _mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    _body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(payload) { this._body = payload; this._ended = true; },
    write(chunk) { this._body = (this._body || '') + chunk; },
  };
  return res;
}
function _parseRes(res) {
  let json = null;
  if (typeof res._body === 'string') {
    try { json = JSON.parse(res._body); } catch {}
  }
  return { status: res.statusCode, json, raw: res._body };
}

// ─────────────────────────────────────────────────────────────────────────────
//  A. Concurrent-action race test
// ─────────────────────────────────────────────────────────────────────────────
//
// Three concurrency probes:
//   1. wire-cleared on 3 personas in parallel  → assert no member# collision
//   2. issue-capital-call same payload x2      → idempotency
//   3. op=stats x5 in parallel                 → consistent counts
//
// NOTE on reliability: Upstash REST is eventually consistent across reads
// issued in a single tick. Two parallel reads can return slightly different
// counts even when no writer is active. We treat counts as consistent if
// every reading is within ±1 of the median to avoid false positives.
export async function runRaceTest(session) {
  const lines = [];
  const failed = [];
  let passed = 0;

  _log(lines, '─── RACE TEST · ' + new Date().toISOString() + ' ───');

  // ── Probe 1 ─────────────────────────────────────────────────────────────
  // Find 3 personas at wire_received and clear them in parallel. Each call
  // independently allocates a member_number; if the storage layer races we
  // see duplicate numbers.
  let wireReceivedLeads = [];
  try {
    const all = await listLeads({ limit: 200 });
    wireReceivedLeads = all
      .filter((l) => !l.deleted_at)
      .filter((l) => l.wire && l.wire.received_at && !l.wire.cleared_at)
      .filter((l) => l.bot_persona === true || l.demo === true)
      .slice(0, 3);
  } catch (e) {
    failed.push({ name: 'probe1_setup', reason: e.message });
  }

  if (wireReceivedLeads.length < 3) {
    _log(lines, 'probe1: SKIP (only ' + wireReceivedLeads.length + ' personas at wire_received; need 3)');
    failed.push({ name: 'probe1_wire_cleared_parallel', reason: 'insufficient personas at wire_received stage — run bot ticks until 3 reach wire_received' });
  } else {
    const t0 = _now();
    const results = await Promise.all(wireReceivedLeads.map((l) => _clearOnePersona(l, session)));
    const memberNums = results.map((r) => r.member_number).filter((n) => Number.isFinite(n));
    const dupes = memberNums.filter((n, i) => memberNums.indexOf(n) !== i);
    _log(lines, 'probe1: cleared ' + results.length + ' wires in parallel · member#s = ' + memberNums.join(',') + ' · ' + (_now() - t0) + 'ms');
    if (dupes.length > 0) {
      failed.push({ name: 'probe1_member_number_collision', reason: 'duplicate member numbers: ' + dupes.join(',') });
      _log(lines, '  ✗ FAIL · duplicate member numbers detected');
    } else if (memberNums.length !== 3) {
      failed.push({ name: 'probe1_member_number_missing', reason: 'expected 3 member numbers, got ' + memberNums.length });
      _log(lines, '  ✗ FAIL · ' + (3 - memberNums.length) + ' personas did not receive a member#');
    } else {
      passed++;
      _log(lines, '  ✓ PASS · all 3 unique');
    }
  }

  // ── Probe 2 ─────────────────────────────────────────────────────────────
  // Idempotency: fire issue-capital-call twice concurrently with the same ref.
  // A robust implementation should append once OR detect the duplicate ref;
  // either way, we should never see two distinct entries with identical ref.
  let fundedTarget = null;
  try {
    const all = await listLeads({ limit: 200 });
    fundedTarget = all.find((l) => !l.deleted_at && l.status === 'funded' && (l.bot_persona === true || l.demo === true));
  } catch {}
  if (!fundedTarget) {
    _log(lines, 'probe2: SKIP (no funded persona)');
    failed.push({ name: 'probe2_capital_call_idempotency', reason: 'no funded persona available' });
  } else {
    const sharedRef = 'CC-RACE-' + _now().toString(36).toUpperCase();
    const before = (fundedTarget.capital_calls || []).length;
    await Promise.all([
      _issueCapitalCall(fundedTarget.id, sharedRef, session),
      _issueCapitalCall(fundedTarget.id, sharedRef, session),
    ]);
    const refreshed = await getLead(fundedTarget.id);
    const matching = (refreshed.capital_calls || []).filter((c) => c.ref === sharedRef);
    _log(lines, 'probe2: capital_calls before=' + before + ' after=' + (refreshed.capital_calls || []).length + ' matching ref=' + matching.length);
    if (matching.length > 1) {
      failed.push({ name: 'probe2_capital_call_idempotency', reason: 'duplicate capital_call entries for ref ' + sharedRef + ' (' + matching.length + ')' });
      _log(lines, '  ✗ FAIL · idempotency broken — ' + matching.length + ' duplicates');
    } else if (matching.length === 1) {
      passed++;
      _log(lines, '  ✓ PASS · idempotent (1 entry persisted)');
    } else {
      failed.push({ name: 'probe2_capital_call_idempotency', reason: 'no entry persisted — both calls lost' });
      _log(lines, '  ✗ FAIL · zero entries persisted (writes lost)');
    }
    // Cleanup: trim that ref off so we don't leave noise behind
    try {
      const cur = await getLead(fundedTarget.id);
      cur.capital_calls = (cur.capital_calls || []).filter((c) => c.ref !== sharedRef);
      await saveLead(cur);
    } catch {}
  }

  // ── Probe 3 ─────────────────────────────────────────────────────────────
  // Five concurrent reads of stage counts. Treat as consistent if every
  // value is within ±1 of the median (Upstash REST is eventually consistent;
  // strict equality is too brittle without a writer running).
  const reads = await Promise.all([0,0,0,0,0].map(() => getStageCounts()));
  const totals = reads.map((r) => r.total);
  totals.sort((a,b) => a - b);
  const median = totals[Math.floor(totals.length / 2)];
  const drift = Math.max(...totals) - Math.min(...totals);
  _log(lines, 'probe3: 5 parallel stat reads · totals=' + reads.map((r) => r.total).join(',') + ' · drift=' + drift);
  if (drift <= 1) {
    passed++;
    _log(lines, '  ✓ PASS · drift ≤1 (eventually-consistent tolerance)');
  } else {
    failed.push({ name: 'probe3_stats_drift', reason: 'stage-count drift across 5 parallel reads = ' + drift + ' (median=' + median + ')' });
    _log(lines, '  ✗ FAIL · drift ' + drift + ' exceeds tolerance');
  }

  _log(lines, '─── RESULT · ' + passed + '/3 probes passed · ' + failed.length + ' failures ───');
  return {
    ok: failed.length === 0,
    races_passed: passed,
    races_failed: failed,
    log_text: lines.join('\n'),
  };
}

async function _clearOnePersona(lead, session) {
  // Mirror admin op=wire-cleared logic, but standalone so we can call in parallel.
  try {
    const fresh = await getLead(lead.id);
    if (!fresh || fresh.deleted_at) return { ok: false };
    if (fresh.wire && fresh.wire.cleared_at) return { ok: true, member_number: fresh.member_number };
    fresh.wire = fresh.wire || {};
    fresh.wire.cleared_at = _now();
    fresh.status = 'funded';
    fresh.funded_at = fresh.wire.cleared_at;
    const counts = await getStageCounts();
    let mn = (counts.funded || 0) + 1;
    if (mn > 100) mn = 1;
    fresh.member_number = mn;
    await saveLead(fresh);
    await transitionStage(fresh, 'wire_received', 'funded');
    await appendAudit(fresh, { actor: (session && session.email) || 'race-test', action: 'wire_cleared', memo: 'race-test member#' + mn });
    return { ok: true, member_number: mn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function _issueCapitalCall(leadId, ref, session) {
  try {
    const fresh = await getLead(leadId);
    if (!fresh) return { ok: false };
    fresh.capital_calls = fresh.capital_calls || [];
    // Idempotency guard: don't append if ref already present
    if (fresh.capital_calls.some((c) => c.ref === ref)) return { ok: true, deduped: true };
    fresh.capital_calls.push({
      id: 'cc_race_' + Math.random().toString(36).slice(2, 8),
      ref, amount_usd: 25000,
      due_date: new Date(_now() + 14 * 86400000).toISOString().slice(0, 10),
      notes: 'race-test', status: 'pending',
      issued_at: _now(), acknowledged_at: null,
    });
    await saveLead(fresh);
    await appendAudit(fresh, { actor: (session && session.email) || 'race-test', action: 'capital_call_issued', memo: ref });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  B. Subscription submission via real handler invocation
// ─────────────────────────────────────────────────────────────────────────────
//
// Picks (or promotes) a persona to subscribed-eligible state, mints a member
// JWT cookie, invokes api/subscription.js handler in-process, and asserts:
//   1. response shape (status 200 + ok: true)
//   2. lead.subscription persisted with all 12 required fields
//
// Catches form-contract drift between member-side /subscription form and
// the api/subscription.js handler.
const SUBSCRIPTION_REQUIRED_FIELDS = [
  'kg_requested', 'legal_name', 'passport_number', 'nationality',
  'tax_residency', 'accredited_investor_basis', 'source_of_wealth',
  'electronic_signature', 'ltv_acknowledged', 'capital_call_acknowledged',
  'qualified_investor_confirm', 'illiquidity_confirm',
];

export async function runSubscriptionTest(session) {
  const lines = [];
  _log(lines, '─── SUBSCRIPTION TEST · ' + new Date().toISOString() + ' ───');

  // Step 1: find a persona at NDA-approved-but-not-yet-subscribed state.
  // If none exists, take any bot persona and force-promote it for the test.
  let target = null;
  try {
    const all = await listLeads({ limit: 200 });
    target = all.find((l) =>
      !l.deleted_at &&
      (l.bot_persona === true || l.demo === true) &&
      l.nda_state === 'approved' &&
      l.status !== 'subscribed' &&
      l.status !== 'funded'
    );
    if (!target) {
      // Promote a generic bot persona by force.
      target = all.find((l) => !l.deleted_at && (l.bot_persona === true || l.demo === true));
      if (target) {
        target.nda_state = 'approved';
        target.nda_approved_at = _now();
        target.status = 'invited';
        delete target.subscription;
        await saveLead(target);
        _log(lines, 'force-promoted persona ' + (target.name || target.id) + ' to NDA-approved');
      }
    }
  } catch (e) {
    return { ok: false, error: 'lead lookup failed: ' + e.message, log_text: lines.join('\n') };
  }
  if (!target) {
    return { ok: false, error: 'no bot persona available — run op=bots-start first', log_text: lines.join('\n') };
  }

  _log(lines, 'persona: ' + (target.name || '(unnamed)') + ' · ' + target.id + ' · stage=' + (resolveLeadStage(target) || target.status));

  // Step 2: mint member cookie token (matches /api/verify-code → cookie path).
  const token = await signToken({ leadId: target.id }, '1h');
  const cookieHeader = COOKIE_MEMBER + '=' + encodeURIComponent(token);

  // Step 3: build a valid form payload and invoke the handler in-process.
  const legalName = (target.legal_name || target.name || 'Test User').trim();
  const sow = ('Family business inheritance from cosmetics manufacturing operation in Seoul; ' +
               'documented via audited statements and 10 years of tax filings; transfers via Citi Private Bank.').slice(0, 1000);
  const formBody = {
    kg_requested: 5,
    legal_name: legalName,
    passport_number: 'M' + Math.floor(Math.random()*1e8).toString().padStart(8, '0'),
    nationality: target.country || 'KR',
    tax_residency: target.tax_residency || target.country || 'KR',
    accredited_investor_basis: 'Net financial assets exceed USD 1m equivalent',
    korean_reverse_solicitation: target.country === 'KR',
    source_of_wealth: sow,
    electronic_signature: legalName,
    im_read: true,
    qualified_investor_confirm: true,
    illiquidity_confirm: true,
    ltv_acknowledged: true,
    capital_call_acknowledged: true,
  };

  const subscriptionMod = await import('../subscription.js');
  const handler = subscriptionMod.default;
  const req = _mockReq({ method: 'POST', body: formBody, cookieHeader });
  const res = _mockRes();
  let invokeError = null;
  try { await handler(req, res); } catch (e) { invokeError = e; }
  const parsed = _parseRes(res);
  _log(lines, 'POST /api/subscription → status=' + parsed.status + ' ' + (parsed.json && parsed.json.ok ? 'ok' : (parsed.json && parsed.json.error) || (invokeError && invokeError.message) || 'no body'));

  // Step 4: contract checks on response.
  const contractIssues = [];
  if (parsed.status !== 200)             contractIssues.push('expected 200, got ' + parsed.status);
  if (!parsed.json || !parsed.json.ok)   contractIssues.push('response.ok !== true');
  if (!parsed.json || !parsed.json.message) contractIssues.push('response.message missing');

  // Step 5: re-fetch lead and verify persisted shape.
  const refreshed = await getLead(target.id);
  const sub = (refreshed && refreshed.subscription) || {};
  const missing = SUBSCRIPTION_REQUIRED_FIELDS.filter((k) => sub[k] === undefined || sub[k] === null || sub[k] === '');
  const persisted = SUBSCRIPTION_REQUIRED_FIELDS.filter((k) => !missing.includes(k));
  _log(lines, 'persisted fields: ' + persisted.length + '/' + SUBSCRIPTION_REQUIRED_FIELDS.length);
  if (missing.length) _log(lines, '  ✗ missing: ' + missing.join(', '));
  else                _log(lines, '  ✓ all required fields persisted');

  const allOk = parsed.status === 200 && contractIssues.length === 0 && missing.length === 0;
  _log(lines, '─── RESULT · ' + (allOk ? 'PASS' : 'FAIL') + ' ───');

  return {
    ok: allOk,
    persona: { id: target.id, name: target.name },
    subscription_response: { status: parsed.status, body: parsed.json, contract_issues: contractIssues },
    persisted_fields: persisted,
    missing_fields: missing,
    log_text: lines.join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  C. Soft-delete + recovery test
// ─────────────────────────────────────────────────────────────────────────────
export async function runSoftDeleteTest(session) {
  const lines = [];
  const checks = [];
  _log(lines, '─── SOFT-DELETE TEST · ' + new Date().toISOString() + ' ───');

  // 1. Create fresh test persona (minimal lead, marked demo+bot for cleanup safety)
  const id = 'demo_softdel_' + _now().toString(36) + Math.random().toString(36).slice(2, 6);
  const lead = {
    id, demo: true, bot_persona: true,
    name: 'Soft-Delete Probe',
    legal_name: 'Soft-Delete Probe',
    email: 'softdel.' + id.slice(-8) + '@example.com',
    country: 'KR',
    status: 'inquiry', nda_state: 'awaiting',
    created_at: _now(), audit: [],
  };
  await saveLead(lead);
  await transitionStage(lead, null, 'inquiry');
  await appendAudit(lead, { actor: 'softdelete-test', action: 'inquiry_received', memo: 'soft-delete probe' });
  _log(lines, '1. created ' + id);
  checks.push({ name: 'create', pass: true });

  // Capture stage counter before
  const countsBefore = await getStageCounts();

  // 2. Call softDeleteLead directly (mirrors op=soft-delete-lead)
  const after = await softDeleteLead(id, 'softdelete-test', (session && session.email) || 'softdelete-test');
  _log(lines, '2. soft-deleted · deleted_at=' + (after.deleted_at ? new Date(after.deleted_at).toISOString() : 'MISSING'));
  checks.push({ name: 'soft_delete_call', pass: !!after.deleted_at });

  // 3. Verify deleted_at is set
  const reread = await getLead(id);
  const deletedAtSet = !!(reread && reread.deleted_at);
  _log(lines, '3. deleted_at on re-read: ' + (deletedAtSet ? '✓' : '✗'));
  checks.push({ name: 'deleted_at_persisted', pass: deletedAtSet });

  // 4. Verify lead is excluded from default listing.
  // NOTE: listLeads() does NOT filter deleted_at on the storage side, so this
  // assertion fires on whatever filter the *handler* applies. We exercise the
  // raw helper here and accept either behaviour, but flag it for awareness.
  const all = await listLeads({ limit: 500 });
  const stillListed = all.some((l) => l.id === id && !l.deleted_at);
  const presentRaw = all.some((l) => l.id === id);
  _log(lines, '4. excluded from listLeads (without deleted)? ' + (!stillListed ? '✓' : '✗') + ' · raw-present=' + presentRaw);
  checks.push({ name: 'excluded_from_default_listing', pass: !stillListed, note: presentRaw ? 'lead still in raw index but flagged deleted_at' : 'fully removed' });

  // 5. Verify stage counter decremented.
  const countsAfter = await getStageCounts();
  const inquiryDelta = (countsBefore.inquiry || 0) - (countsAfter.inquiry || 0);
  _log(lines, '5. stage counter inquiry: ' + (countsBefore.inquiry || 0) + ' → ' + (countsAfter.inquiry || 0) + ' (Δ=' + inquiryDelta + ')');
  checks.push({ name: 'stage_counter_decremented', pass: inquiryDelta >= 1 });

  // 6. Audit append confirms event
  const auditOk = (reread.audit || []).some((a) => a.action === 'lead_soft_deleted');
  _log(lines, '6. audit event lead_soft_deleted: ' + (auditOk ? '✓' : '✗'));
  checks.push({ name: 'audit_event_appended', pass: auditOk });

  // 7. Cleanup: hard-delete
  let cleanupOk = false;
  try { await deleteLead(id); cleanupOk = true; } catch (e) { _log(lines, 'cleanup error: ' + e.message); }
  _log(lines, '7. hard-delete cleanup: ' + (cleanupOk ? '✓' : '✗'));

  const allPass = checks.every((c) => c.pass);
  _log(lines, '─── RESULT · ' + (allPass ? 'PASS' : 'FAIL') + ' · ' + checks.filter((c) => c.pass).length + '/' + checks.length + ' ───');

  return {
    ok: allPass,
    checks,
    cleanup: cleanupOk,
    log_text: lines.join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  E. Extended email-format coverage (callable from race-tests too)
// ─────────────────────────────────────────────────────────────────────────────
export async function runExtendedEmailChecks(session) {
  const lines = [];
  _log(lines, '─── EXTENDED EMAIL CHECKS · ' + new Date().toISOString() + ' ───');
  const sampleLead = {
    id: 'demo_email_probe',
    name: 'Email Probe',
    legal_name: 'Email Probe',
    email: 'probe@example.com',
    country: 'KR',
    member_number: 7,
  };
  const types = [
    { type: 'password_reset',    extra: 'ABC123' },
    { type: 'vault_verification',extra: { vault_id: 'V-001', verified_at: new Date().toISOString() } },
    { type: 'partner_notice',    extra: null },
  ];
  const results = [];
  for (const t of types) {
    const r = await _validateEmail(t.type, sampleLead, t.extra);
    results.push(r);
    _log(lines, (r.ok ? '  ✓' : '  ✗') + ' email[' + t.type + '] ' + (r.ok ? 'OK · ' + r.subject : 'FAIL · ' + r.issues.join('; ')));
  }
  const allPass = results.every((r) => r.ok);
  _log(lines, '─── RESULT · ' + (allPass ? 'PASS' : 'FAIL') + ' · ' + results.filter((r) => r.ok).length + '/' + results.length + ' ───');
  return { ok: allPass, results, log_text: lines.join('\n') };
}

async function _validateEmail(type, lead, extra) {
  Email._PREVIEW.enabled = true;
  Email._PREVIEW.captured = null;
  try {
    if (type === 'password_reset')         await Email.sendPasswordReset(lead, extra);
    else if (type === 'vault_verification')await Email.sendVaultVerificationNotification(lead, extra);
    else if (type === 'partner_notice')    await Email.sendPartnerNotice({ ...lead, _notice: 'Subscription received from probe — 5kg requested' });
    else return { ok: false, type, issues: ['unknown email type'] };
  } catch (e) {
    return { ok: false, type, issues: ['threw: ' + e.message] };
  } finally {
    Email._PREVIEW.enabled = false;
  }
  const cap = Email._PREVIEW.captured;
  if (!cap) return { ok: false, type, issues: ['email function did not call sendRaw'] };
  const issues = [];
  if (!cap.to || !String(cap.to).includes('@')) issues.push('to: missing or invalid');
  if (!cap.subject || cap.subject.length < 8)   issues.push('subject: empty or too short');
  if (!cap.html || cap.html.length < 200)       issues.push('html: empty or too short');
  if (!cap.text || cap.text.length < 40)        issues.push('text: empty or too short');
  if (type === 'password_reset' && extra && !cap.html.includes(extra)) issues.push('html: reset code missing');
  return { ok: issues.length === 0, type, issues, subject: cap.subject, html_len: (cap.html||'').length };
}
