// /api/verify-code — invite code consumption + session cookie.
//
// GET  /api/verify-code?code=XXXXXX  — code from query string → JSON + cookie
// POST /api/verify-code { code }     — code from body → JSON + cookie
//
// On success: sets aurum_access cookie, returns { ok, next_path }.
// The caller (code.html) reads next_path and performs the redirect client-side,
// or the response can be a 302 if the caller prefers.

import { ok, bad, unauthorized, methodNotAllowed, readBody, getQuery } from './_lib/http.js';
import { signToken, COOKIE_MEMBER, cookieOptions } from './_lib/auth.js';
import { getLead, leadIdForCode, saveLead, transitionStage } from './_lib/storage.js';
import { extractGeo } from './_lib/geo.js';
import { setCookie } from './_lib/http.js';

const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export default async function handler(req, res) {
  let code = '';

  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch { return bad(res, 'invalid body'); }
    code = String(body.code || '').trim().toUpperCase();
  } else if (req.method === 'GET') {
    code = String(getQuery(req).code || '').trim().toUpperCase();
  } else {
    return methodNotAllowed(res);
  }

  if (!code) return bad(res, 'missing code');

  // Artificial delay on miss to make brute-force slow
  const leadId = await leadIdForCode(code);
  if (!leadId) {
    await delay(400);
    return unauthorized(res, 'The access credential was not recognised.');
  }

  const lead = await getLead(leadId);
  if (!lead) {
    await delay(400);
    return unauthorized(res, 'The access credential was not recognised.');
  }

  if (lead.code !== code) {
    await delay(400);
    return unauthorized(res, 'The access credential was not recognised.');
  }

  // Advance status on first use
  const now = Date.now();
  if (lead.status === 'invited') {
    lead.status = 'accessed';
    lead.audit  = lead.audit || [];
    lead.audit.push({ at: now, actor: 'member', action: 'code_consumed', geo: extractGeo(req) });
    lead.last_seen_at = now;
    try {
      await transitionStage(lead, 'invited', 'accessed');
      await saveLead(lead);
    } catch (e) {
      console.warn('[verify-code] saveLead failed:', e && e.message);
    }
  } else {
    // Already accessed — still update last_seen and audit without failing
    try {
      lead.last_seen_at = now;
      lead.audit = lead.audit || [];
      lead.audit.push({ at: now, actor: 'member', action: 'code_reused', geo: extractGeo(req) });
      await saveLead(lead);
    } catch {}
  }

  // Sign JWT
  const token = await signToken(
    { sub: 'member', leadId: lead.id, code },
    `${ACCESS_TTL_SECONDS}s`
  );

  const opts = cookieOptions(ACCESS_TTL_SECONDS);
  setCookie(res, COOKIE_MEMBER, token, opts);

  // Determine redirect target based on lead state
  let nextPath = '/main';
  if (lead.wire && lead.wire.cleared_at)  nextPath = '/portfolio';
  else if (lead.nda_state === 'approved') nextPath = '/memo';

  return ok(res, {
    ok: true,
    next_path: nextPath,
    lead: {
      name:  lead.name  || null,
      email: lead.email || null,
    },
  });
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
