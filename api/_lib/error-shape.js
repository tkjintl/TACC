// _lib/error-shape.js — standard error response shape with correlation IDs
// and recent-error tracking for the /api/health probe.
//
// Shape:
//   success: { ok: true, ...data }
//   error:   { ok: false, error, code, correlation_id }

import { randomBytes } from 'node:crypto';

const KV_URL = () => process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL  || '';
const KV_TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const ERRORS_KEY = 'errors:recent';

export function makeCorrelationId() {
  // 8 chars, base32-ish (no easily-confused glyphs)
  const bytes = randomBytes(6);
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = 'cid_';
  for (let i = 0; i < 8; i++) out += ALPHA[bytes[i % bytes.length] % ALPHA.length];
  return out;
}

/**
 * trackError({ status, op, message, correlation_id })
 * Appends an entry to the `errors:recent` Upstash sorted set (score=ts ms).
 * Best-effort — never throws.
 */
export async function trackError({ status, op, message, correlation_id }) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return;
  try {
    const member = JSON.stringify({
      at: Date.now(),
      status,
      op: op || null,
      message: String(message || '').slice(0, 200),
      correlation_id: correlation_id || null,
    }) + '|' + Math.random().toString(36).slice(2, 8); // keep entries unique
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['ZADD', ERRORS_KEY, String(Date.now()), member]),
    });
  } catch {}
}

/**
 * countRecentErrors(sinceMs) → number of entries with score >= sinceMs
 */
export async function countRecentErrors(sinceMs) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return 0;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['ZCOUNT', ERRORS_KEY, String(sinceMs), '+inf']),
    });
    if (!r.ok) return 0;
    const j = await r.json();
    return Number(j.result) || 0;
  } catch {
    return 0;
  }
}

/**
 * trimErrorsOlderThan(beforeMs)
 * Removes entries scored below beforeMs. Run from stale-data-audit cron.
 */
export async function trimErrorsOlderThan(beforeMs) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return 0;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['ZREMRANGEBYSCORE', ERRORS_KEY, '-inf', String(beforeMs)]),
    });
    if (!r.ok) return 0;
    const j = await r.json();
    return Number(j.result) || 0;
  } catch {
    return 0;
  }
}

/**
 * sendErr(res, { status, error, code, op })
 * Writes the standard error shape, logs with cid, tracks for /api/health.
 */
export async function sendErr(res, { status = 400, error = 'bad request', code = 'BAD_REQUEST', op = null } = {}) {
  const correlation_id = makeCorrelationId();
  console.error(`[aurum/err] cid=${correlation_id} op=${op || '?'} status=${status} code=${code} msg=${error}`);
  // Track only 5xx + 4xx (>=400) errors
  if (status >= 400) {
    trackError({ status, op, message: error, correlation_id }).catch(() => {});
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, error, code, correlation_id }));
  return correlation_id;
}

/**
 * Hash arbitrary body to a short stable key (used for idempotency).
 */
export function bodyHash(obj) {
  try {
    const s = JSON.stringify(obj || {});
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  } catch {
    return '0';
  }
}
