// _lib/http.js — request / response helpers for Vercel serverless functions.

// ── Response helpers ──────────────────────────────────────────────────────────

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function ok(res, data = { ok: true }, status = 200) {
  return json(res, status, data);
}

export function bad(res, message = 'bad request', status = 400) {
  return json(res, status, { ok: false, error: message });
}

export function unauthorized(res, message = 'Unauthorized') {
  return json(res, 401, { ok: false, error: message });
}

export function notFound(res) {
  return json(res, 404, { ok: false, error: 'not found' });
}

export function serverError(res, err) {
  const message = err instanceof Error ? err.message : (err || 'internal server error');
  // Never expose stack traces — log server-side
  if (err instanceof Error) console.error('[aurum] server error:', err.stack || err);
  return json(res, 500, { ok: false, error: 'internal server error' });
}

export function methodNotAllowed(res) {
  return json(res, 405, { ok: false, error: 'method not allowed' });
}

// ── Request helpers ───────────────────────────────────────────────────────────

export async function readBody(req) {
  // Vercel may pre-parse JSON; if so, return it directly.
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 512_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

export function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    if (trimmed.slice(0, i) === name) {
      try { return decodeURIComponent(trimmed.slice(i + 1)); } catch { return trimmed.slice(i + 1); }
    }
  }
  return null;
}

export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  parts.push('HttpOnly');
  if (opts.secure !== false && process.env.NODE_ENV === 'production') parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearCookie(res, name) {
  const base = `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  res.setHeader('Set-Cookie', base);
}

export function getQuery(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const out = {};
    for (const [k, v] of url.searchParams) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}
