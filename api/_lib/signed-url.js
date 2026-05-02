// _lib/signed-url.js — short-lived signed URLs for private blobs.
//
// We don't use Vercel Blob's native private+signed URLs (the installed
// @vercel/blob version doesn't expose them as a stable API on this account),
// so we layer our own JWT over public-but-unguessable blob pathnames.
//
// The blob itself lives at a hard-to-guess pathname (includes leadId + nanoid).
// The signed URL points at /api/doc?op=signed-blob&token=<JWT> which verifies
// the JWT and proxies the blob bytes through. TTL is enforced by JWT exp.

import { signToken, verifyToken } from './auth.js';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h per brief

/**
 * mintSignedBlobToken({ pathname, leadId, kind, ttlSeconds })
 *   → { token, expires_at (ms epoch) }
 */
export async function mintSignedBlobToken({ pathname, leadId, kind, ttlSeconds }) {
  if (!pathname) throw new Error('mintSignedBlobToken: pathname required');
  const ttl = Number(ttlSeconds) || DEFAULT_TTL_SECONDS;
  const expires_at = Date.now() + ttl * 1000;
  const token = await signToken(
    {
      typ:  'blob',
      pn:   pathname,
      lid:  leadId || null,
      kind: kind   || 'doc',
    },
    `${ttl}s`,
  );
  return { token, expires_at };
}

/**
 * buildSignedUrl({ pathname, leadId, kind, ttlSeconds, baseUrl })
 *   → { signed_url, expires_at }
 */
export async function buildSignedUrl(opts) {
  const { token, expires_at } = await mintSignedBlobToken(opts);
  const base = opts.baseUrl || process.env.SITE_URL || '';
  const signed_url = `${base}/api/doc?op=signed-blob&token=${encodeURIComponent(token)}`;
  return { signed_url, expires_at, token };
}

/**
 * verifySignedBlobToken(token)
 *   → { pathname, leadId, kind } | null
 */
export async function verifySignedBlobToken(token) {
  const payload = await verifyToken(token);
  if (!payload || payload.typ !== 'blob' || !payload.pn) return null;
  return {
    pathname: String(payload.pn),
    leadId:   payload.lid ? String(payload.lid) : null,
    kind:     payload.kind ? String(payload.kind) : 'doc',
    exp_ms:   payload.exp ? Number(payload.exp) * 1000 : null,
  };
}
