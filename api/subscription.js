// api/subscription.js — Subscription form intake.
// POST /api/subscription — requires aurum_access cookie + approved NDA.

import {
  ok, bad, unauthorized, serverError, methodNotAllowed,
  getCookie, readBody,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER } from './_lib/auth.js';
import { getLead, saveLead, transitionStage } from './_lib/storage.js';
import { sendPartnerNotice } from './_lib/email.js';

// ── Auth helper ───────────────────────────────────────────────────────────────

async function requireMember(req) {
  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (!session || !session.leadId) return null;
  const lead = await getLead(session.leadId);
  if (!lead) return null;
  return lead;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  // NDA must be approved
  if (lead.nda_state !== 'approved') {
    return bad(res, 'Your NDA must be approved before submitting a subscription.', 403);
  }

  // Prevent double submission
  if (lead.status === 'subscribed' || lead.status === 'funded') {
    return bad(res, 'A subscription has already been submitted for this account.', 409);
  }

  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid request body'); }

  // ── Validation ──────────────────────────────────────────────────────────────

  const errors = [];

  const kg = Number(body.kg_requested);
  if (!Number.isFinite(kg) || kg < 1) {
    errors.push('kg_requested must be a number ≥ 1');
  }

  if (body.ltv_acknowledged !== true) {
    errors.push('ltv_acknowledged must be true');
  }

  if (body.capital_call_acknowledged !== true) {
    errors.push('capital_call_acknowledged must be true');
  }

  const legalName  = String(body.legal_name || '').trim();
  const eSig       = String(body.electronic_signature || '').trim();
  if (!legalName) {
    errors.push('legal_name is required');
  } else if (legalName.toLowerCase() !== eSig.toLowerCase()) {
    errors.push('electronic_signature must match legal_name exactly');
  }

  const sow = String(body.source_of_wealth || '').trim();
  if (sow.length < 80) {
    errors.push(`source_of_wealth must be at least 80 characters (got ${sow.length})`);
  }

  if (body.im_read !== true) {
    errors.push('im_read must be true');
  }
  if (body.qualified_investor_confirm !== true) {
    errors.push('qualified_investor_confirm must be true');
  }
  if (body.illiquidity_confirm !== true) {
    errors.push('illiquidity_confirm must be true');
  }

  const nationality = String(body.nationality || '').trim().toUpperCase();
  const passportNum = String(body.passport_number || '').trim();
  if (!passportNum) errors.push('passport_number is required');

  if (errors.length) {
    return bad(res, errors.join('; '));
  }

  // ── Persist ─────────────────────────────────────────────────────────────────

  const now = Date.now();

  const subscriptionRecord = {
    kg_requested:                    kg,
    legal_name:                      legalName,
    passport_number:                 passportNum,
    nationality,
    tax_residency:                   String(body.tax_residency || '').trim().toUpperCase(),
    accredited_investor_basis:       String(body.accredited_investor_basis || '').trim(),
    korean_reverse_solicitation:     body.korean_reverse_solicitation === true,
    source_of_wealth:                sow,
    electronic_signature:            eSig,
    im_read:                         true,
    qualified_investor_confirm:      true,
    illiquidity_confirm:             true,
    ltv_acknowledged:                true,
    capital_call_acknowledged:       true,
    submitted_at:                    now,
    // Financial calculations (indicative — confirmed on wire receipt)
    wire_amount_usd_indicative:      null, // set by admin on wire-issue
  };

  const fromStg = lead.status;
  lead.status       = 'subscribed';
  lead.subscription = subscriptionRecord;
  lead.audit = lead.audit || [];
  lead.audit.push({
    at:     now,
    actor:  lead.id,
    action: 'subscription_submitted',
    meta:   { kg },
  });

  try {
    await transitionStage(lead, fromStg, 'subscribed');
    await saveLead(lead);
  } catch (e) {
    console.error('[subscription] saveLead failed:', e);
    return serverError(res, e);
  }

  // Partner notification
  try {
    await sendPartnerNotice({
      ...lead,
      _notice: `Subscription received from ${lead.name || lead.email} — ${kg}kg requested`,
    });
  } catch (e) {
    console.warn('[subscription] partner notice failed:', e && e.message);
  }

  return ok(res, {
    ok:      true,
    message: 'Your subscription has been received. Wire instructions will follow within two business days.',
  });
}
