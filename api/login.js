// /api/login — multi-op auth dispatcher.
//
// Routes by ?op= query param:
//   (no op)                    POST — admin login
//   ?op=member-login           POST — member email + password
//   ?op=admin-login            POST — admin login (explicit)
//   ?op=password-reset-request POST — send 6-digit code to email
//   ?op=password-reset-confirm POST — verify code + set new password
//   ?op=password-setup         POST — first-time password from setup JWT

import {
  ok, bad, unauthorized, methodNotAllowed, serverError,
  readBody, getQuery, setCookie,
} from './_lib/http.js';
import {
  signToken, verifyToken, hashPassword, verifyPassword,
  generateResetCode, cookieOptions, COOKIE_MEMBER, COOKIE_ADMIN,
} from './_lib/auth.js';
import { findLeadByEmail, getLead, saveLead } from './_lib/storage.js';
import { sendPasswordReset } from './_lib/email.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Admin roster ──────────────────────────────────────────────────────────────
// ADMIN_USERS env var: "email:password,email:password"
// Falls back to ADMIN_PASSWORD as shared password with default roster.
const DEFAULT_ADMIN_ROSTER = [
  { email: 'jwc@theaurumcc.com', id: 'jwc' },
  { email: 'tkj@theaurumcc.com', id: 'tkj' },
  { email: 'wsl@theaurumcc.com', id: 'wsl' },
];

function loadAdminRoster() {
  const raw    = (process.env.ADMIN_USERS   || '').trim();
  const shared = (process.env.ADMIN_PASSWORD || '1234');

  if (!raw) {
    return DEFAULT_ADMIN_ROSTER.map((u) => ({ ...u, password: shared }));
  }

  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    if (colon > 0) {
      return { email: part.slice(0, colon).trim().toLowerCase(), password: part.slice(colon + 1), id: part.slice(0, colon).split('@')[0].trim() };
    }
    return { email: part.trim().toLowerCase(), password: shared, id: part.split('@')[0].trim() };
  });
}

function checkAdminCredentials(email, password) {
  const roster = loadAdminRoster();
  const normEmail = email.trim().toLowerCase();
  const inEmail = Buffer.from(normEmail);
  const inPw    = Buffer.from(password);
  let matched = null;
  for (const u of roster) {
    const eBuf = Buffer.from(u.email || '');
    const pBuf = Buffer.from(u.password || '');
    const eEq  = eBuf.length === inEmail.length && timingSafeEqual(eBuf, inEmail);
    const pEq  = pBuf.length === inPw.length && pBuf.length > 0 && timingSafeEqual(pBuf, inPw);
    if (eEq && pEq && !matched) matched = { email: u.email, id: u.id };
  }
  return matched;
}

// Single-password admin login (no email required)
function checkAdminPassword(password) {
  const roster = loadAdminRoster();
  const inPw   = Buffer.from(password);
  for (const u of roster) {
    const pBuf = Buffer.from(u.password || '');
    if (pBuf.length === inPw.length && pBuf.length > 0 && timingSafeEqual(pBuf, inPw)) {
      return { email: u.email, id: u.id };
    }
  }
  return null;
}

function hmacCode(code) {
  const secret = process.env.AURUM_SECRET || 'aurum-dev-secret-change-in-prod';
  return createHmac('sha256', secret).update(code).digest('hex');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Dispatcher ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const op = String(getQuery(req).op || '').toLowerCase();

  switch (op) {
    case 'member-login':           return opMemberLogin(req, res);
    case 'admin-login':            return opAdminLogin(req, res);
    case 'password-reset-request': return opPasswordResetRequest(req, res);
    case 'password-reset-confirm': return opPasswordResetConfirm(req, res);
    case 'password-setup':         return opPasswordSetup(req, res);
    default:                       return opAdminLogin(req, res);
  }
}

// ── op: admin-login ───────────────────────────────────────────────────────────

async function opAdminLogin(req, res) {
  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const email    = String((body && body.email)    || '').trim();
  const password = String((body && body.password) || '').trim();

  if (!password) {
    await sleep(600);
    return unauthorized(res, 'password required');
  }

  let match = null;
  if (email) {
    match = checkAdminCredentials(email, password);
  } else {
    match = checkAdminPassword(password);
  }

  if (!match) {
    await sleep(600);
    return unauthorized(res, 'The credential you entered was not recognised.');
  }

  const ttl   = 60 * 60 * 12; // 12 hours
  const token = await signToken({ sub: 'admin', email: match.email, id: match.id }, `${ttl}s`);
  setCookie(res, COOKIE_ADMIN, token, cookieOptions(ttl));
  return ok(res, { ok: true, email: match.email, id: match.id });
}

// ── op: member-login ──────────────────────────────────────────────────────────

async function opMemberLogin(req, res) {
  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const email    = String((body && body.email)    || '').trim().toLowerCase();
  const password = String((body && body.password) || '');

  if (!email || !password) {
    await sleep(400);
    return unauthorized(res, 'email and password required');
  }

  let lead = null;
  try { lead = await findLeadByEmail(email); } catch {}

  if (!lead || !lead.password_hash) {
    await sleep(600);
    return unauthorized(res, 'The credential you entered was not recognised.');
  }

  const valid = await verifyPassword(password, lead.password_hash);
  if (!valid) {
    await sleep(600);
    return unauthorized(res, 'The credential you entered was not recognised.');
  }

  const now = Date.now();
  const ttl = 60 * 60 * 24 * 30; // 30 days

  const token = await signToken(
    { sub: 'member', leadId: lead.id, code: lead.code || '', login: 'pw' },
    `${ttl}s`
  );
  setCookie(res, COOKIE_MEMBER, token, cookieOptions(ttl));

  try {
    lead.last_login_at = now;
    lead.audit = lead.audit || [];
    lead.audit.push({ at: now, actor: 'member', action: 'pw_login' });
    await saveLead(lead);
  } catch {}

  return ok(res, { ok: true });
}

// ── op: password-reset-request ────────────────────────────────────────────────

async function opPasswordResetRequest(req, res) {
  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const email = String((body && body.email) || '').trim().toLowerCase();

  // Always return ok — never reveal whether email exists
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await sleep(400);
    return ok(res, { ok: true });
  }

  let lead = null;
  try { lead = await findLeadByEmail(email); } catch {}

  if (lead && lead.password_hash) {
    const code      = generateResetCode();
    const expiresAt = Date.now() + 15 * 60 * 1000;

    lead.reset_code_hash    = hmacCode(code);
    lead.reset_code_expires = expiresAt;
    lead.reset_attempts     = 0;
    lead.audit = lead.audit || [];
    lead.audit.push({ at: Date.now(), actor: 'system', action: 'password_reset_requested' });

    try { await saveLead(lead); } catch (e) {
      console.warn('[login/reset-request] saveLead error:', e && e.message);
    }

    sendPasswordReset(lead, code).catch((e) =>
      console.warn('[login/reset-request] sendPasswordReset error:', e && e.message)
    );
  } else {
    await sleep(400);
  }

  return ok(res, { ok: true });
}

// ── op: password-reset-confirm ────────────────────────────────────────────────

async function opPasswordResetConfirm(req, res) {
  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const email    = String((body && body.email)    || '').trim().toLowerCase();
  const code     = String((body && body.code)     || '').trim();
  const password = String((body && body.password) || '');

  if (!email || !code || !password) return bad(res, 'email, code, and password required');
  if (password.length < 8) return bad(res, 'password must be at least 8 characters');

  let lead = null;
  try { lead = await findLeadByEmail(email); } catch {}

  if (!lead || !lead.reset_code_hash || !lead.reset_code_expires) {
    await sleep(600);
    return unauthorized(res, 'No pending reset — request a new code.');
  }
  if (Date.now() > lead.reset_code_expires) {
    await sleep(400);
    return unauthorized(res, 'Reset code has expired — request a new one.');
  }
  if ((lead.reset_attempts || 0) >= 5) {
    await sleep(400);
    return unauthorized(res, 'Too many failed attempts — request a new code.');
  }

  // Timing-safe compare
  const expectedHash = hmacCode(code);
  const a = Buffer.from(lead.reset_code_hash);
  const b = Buffer.from(expectedHash);
  const codeMatches = a.length === b.length && timingSafeEqual(a, b);

  if (!codeMatches) {
    lead.reset_attempts = (lead.reset_attempts || 0) + 1;
    try { await saveLead(lead); } catch {}
    await sleep(600);
    return unauthorized(res, 'Incorrect reset code.');
  }

  const now = Date.now();
  lead.password_hash     = await hashPassword(password);
  lead.password_set_at   = now;
  lead.reset_code_hash   = null;
  lead.reset_code_expires = null;
  lead.reset_attempts    = null;
  lead.audit = lead.audit || [];
  lead.audit.push({ at: now, actor: 'member', action: 'password_reset_completed' });

  try { await saveLead(lead); } catch (e) {
    console.error('[login/reset-confirm] saveLead error:', e && e.stack);
    return bad(res, 'Could not save password — please try again.');
  }

  const ttl   = 60 * 60 * 24 * 30;
  const token = await signToken(
    { sub: 'member', leadId: lead.id, code: lead.code || '', login: 'pw' },
    `${ttl}s`
  );
  setCookie(res, COOKIE_MEMBER, token, cookieOptions(ttl));
  return ok(res, { ok: true });
}

// ── op: password-setup ────────────────────────────────────────────────────────
// Body: { token: <setup JWT>, password }
// The setup JWT is signed with sub='pw-setup' and contains the leadId.

async function opPasswordSetup(req, res) {
  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const setupToken = String((body && body.token)    || '').trim();
  const password   = String((body && body.password) || '');

  if (!setupToken) return bad(res, 'missing setup token');
  if (!password || password.length < 8) return bad(res, 'password must be at least 8 characters');

  const session = await verifyToken(setupToken);
  if (!session || session.sub !== 'pw-setup' || !session.leadId) {
    return unauthorized(res, 'Setup link is invalid or expired — request a new one from a partner.');
  }

  let lead = null;
  try { lead = await getLead(session.leadId); } catch {}
  if (!lead) return unauthorized(res, 'Member not found.');

  // One-time consumption check
  const jti = `${session.iat}:${session.exp}`;
  lead.consumed_setup_tokens = lead.consumed_setup_tokens || [];
  if (lead.consumed_setup_tokens.includes(jti)) {
    return unauthorized(res, 'Setup link already used — sign in at /login.');
  }
  lead.consumed_setup_tokens.push(jti);
  if (lead.consumed_setup_tokens.length > 20) {
    lead.consumed_setup_tokens = lead.consumed_setup_tokens.slice(-20);
  }

  const now = Date.now();
  lead.password_hash   = await hashPassword(password);
  lead.password_set_at = now;
  lead.audit = lead.audit || [];
  lead.audit.push({ at: now, actor: 'member', action: 'password_set' });

  try { await saveLead(lead); } catch (e) {
    console.error('[login/password-setup] saveLead error:', e && e.stack);
    return bad(res, 'Could not save password — please try again.');
  }

  const ttl   = 60 * 60 * 24 * 30;
  const token = await signToken(
    { sub: 'member', leadId: lead.id, code: lead.code || '', login: 'pw' },
    `${ttl}s`
  );
  setCookie(res, COOKIE_MEMBER, token, cookieOptions(ttl));
  return ok(res, { ok: true });
}
