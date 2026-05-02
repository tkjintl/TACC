// GET /api/me — admin session check.
// Returns { email, sub, exp } from admin JWT payload, or 401.

import { ok, unauthorized, methodNotAllowed, getCookie } from './_lib/http.js';
import { verifyToken, COOKIE_ADMIN } from './_lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const token   = getCookie(req, COOKIE_ADMIN);
  const session = await verifyToken(token);

  if (!session || session.sub !== 'admin') {
    return unauthorized(res, 'No active admin session.');
  }

  return ok(res, {
    ok:    true,
    email: session.email || null,
    sub:   session.sub,
    id:    session.id    || null,
    exp:   session.exp,
  });
}
