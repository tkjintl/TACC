// POST /api/submit — public interest form intake.
// Validates, deduplicates, stores the lead, fires inquiry emails.

import { ok, bad, serverError, methodNotAllowed, readBody, clientIp } from './_lib/http.js';
import { generateLeadId } from './_lib/auth.js';
import { saveLead, findLeadByEmail, isRateLimited } from './_lib/storage.js';
import { sendInquiryAck, sendPartnerNotice } from './_lib/email.js';
import { extractGeo } from './_lib/geo.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  // Rate limit: max 3 submissions per IP per hour
  const ip = clientIp(req);
  if (ip) {
    let limited = false;
    try { limited = await isRateLimited(ip); } catch {}
    if (limited) {
      return bad(res, 'Too many submissions from this address. Please try again later.', 429);
    }
  }

  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  // Validate required fields. Accept both new and legacy field names.
  const name    = String(body.name    || body.full_name || '').trim();
  const email   = String(body.email   || '').trim().toLowerCase();
  const country = String(body.country || '').trim();
  const wealth  = String(body.wealth  || body.investable_assets || '').trim();
  const referral = String(body.referral || body.referral_source || '').trim();

  if (!name)                                       return bad(res, 'missing field: name');
  if (!email)                                      return bad(res, 'missing field: email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))  return bad(res, 'invalid email');
  if (!country)                                    return bad(res, 'missing field: country');

  // Deduplication — treat as success to avoid form errors on legitimate re-submissions
  try {
    const existing = await findLeadByEmail(email);
    if (existing) {
      return ok(res, { ok: true, message: 'Your enquiry is already on file.' });
    }
  } catch (e) {
    console.warn('[submit] findLeadByEmail failed:', e && e.message);
    // Don't block — proceed to save
  }

  const now  = Date.now();
  const id   = generateLeadId();
  const geo  = extractGeo(req);

  const lead = {
    id,
    email,
    name,
    country,
    wealth:     wealth || null,
    occupation: String(body.occupation || '').trim() || null,
    referral:   referral || null,
    reverse_solicitation_ack: body.reverse_solicitation_ack === true,
    status:     'inquiry',
    member_number: null,
    code:            null,
    code_issued_at:  null,
    nda_state:       'awaiting',
    nda_file_url:    null,
    nda_approved_at: null,
    kyc: { status: 'pending', ref: null, verified_at: null },
    subscription: {
      kg_requested:       null,
      wire_usd:           null,
      ltv_acknowledged:   false,
      source_of_wealth:   null,
      signature:          null,
      submitted_at:       null,
      agreement_sent_at:  null,
    },
    wire: {
      instructions_sent_at: null,
      received_at:          null,
      cleared_at:           null,
      amount_usd:           null,
    },
    bars:          [],
    positions:     [],
    capital_calls: [],
    docs:          [],
    messages:      [],
    password_hash:     null,
    password_set_at:   null,
    reset_code_hash:   null,
    reset_code_expires: null,
    audit: [{ at: now, actor: 'system', action: 'inquiry_submitted', ip: geo.ip || ip || null }],
    created_at:   now,
    last_login_at: null,
    last_seen_at:  null,
    geo,
  };

  let saved = false;
  try {
    await saveLead(lead);
    saved = true;
  } catch (e) {
    console.error('[submit] saveLead failed:', e && e.stack);
  }

  // Fire emails in background — never block the response on email delivery
  // If storage failed, emails become the only record — partner notice is critical
  if (lead.email) {
    sendInquiryAck(lead).catch((e) => console.warn('[submit] sendInquiryAck error:', e && e.message));
  }
  sendPartnerNotice(lead).catch((e) => console.warn('[submit] sendPartnerNotice error:', e && e.message));

  if (!saved) {
    // Storage failed but emails may still reach partners — return 500 so user retries
    return serverError(res, new Error('storage error — please try again'));
  }

  return ok(res, { ok: true, message: 'Your enquiry has been received.' });
}
