// POST /api/logout — clear member and admin session cookies.

import { ok, methodNotAllowed } from './_lib/http.js';
import { COOKIE_MEMBER, COOKIE_ADMIN } from './_lib/auth.js';

const CLEAR_OPTS = '; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  // Set both cookie deletions in a single Set-Cookie array so neither overwrites the other
  res.setHeader('Set-Cookie', [
    `${COOKIE_ADMIN}=${CLEAR_OPTS}`,
    `${COOKIE_MEMBER}=${CLEAR_OPTS}`,
    `${COOKIE_ADMIN}=${CLEAR_OPTS}; Secure`,
    `${COOKIE_MEMBER}=${CLEAR_OPTS}; Secure`,
  ]);

  return ok(res, { ok: true });
}
