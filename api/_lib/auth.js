// _lib/auth.js — JWT (HS256 via jose), password hashing (bcryptjs), code generation.
// Uses jose for standard JWT so tokens are interoperable and carry exp in claims.

import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

// ---------- Secret ----------
let _warnedSecret = false;
function getSecret() {
  const s =
    process.env.AURUM_SECRET ||
    process.env.SESSION_COOKIE_SECRET ||
    'aurum-dev-secret-change-in-prod';
  if (!process.env.AURUM_SECRET && !process.env.SESSION_COOKIE_SECRET && !_warnedSecret) {
    console.warn('[aurum] AURUM_SECRET not set — using fallback. Set before production.');
    _warnedSecret = true;
  }
  return new TextEncoder().encode(s);
}

// ---------- JWT sign / verify ----------
export async function signToken(payload, expiresIn = '12h') {
  // expiresIn: string like '30d', '12h', '15m', or number of seconds
  const ttl = typeof expiresIn === 'number' ? `${expiresIn}s` : expiresIn;
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(getSecret());
}

export async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

// All token verification is async — use verifyToken() in all callers.
// Phase 1 has no sync-only code paths that need cookie parsing outside of async handlers.

// ---------- ID / code generators ----------
// 6-char uppercase alphanumeric, no O/0/I/1/L
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode() {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHA[bytes[i] % CODE_ALPHA.length];
  return out;
}

export function generateMemberId() {
  return 'M_' + randomBytes(8).toString('base64url').slice(0, 10);
}

export function generateLeadId() {
  return 'L_' + randomBytes(8).toString('base64url').slice(0, 10);
}

// 6-digit numeric reset code (1M space — mitigated by 15 min TTL + rate limit)
export function generateResetCode() {
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += String(bytes[i] % 10);
  return out;
}

// ---------- Password hashing (bcrypt cost 12) ----------
export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  if (!hash || typeof hash !== 'string') return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

// ---------- Cookie option factory ----------
export function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

// Cookie names (exported as constants so all callers stay in sync)
export const COOKIE_MEMBER = 'aurum_access';
export const COOKIE_ADMIN  = 'aurum_admin';
