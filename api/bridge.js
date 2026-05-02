// api/bridge.js — GET /api/bridge
// Returns Prism deal feed for authenticated TACC members.
// Auth: aurum_access cookie (COOKIE_MEMBER from auth.js)

import {
  ok, unauthorized, methodNotAllowed, serverError, getCookie,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER } from './_lib/auth.js';
import { getLead } from './_lib/storage.js';
import { fetchPrismFeed } from './_lib/prism-bridge.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  // ── Auth: require valid aurum_access cookie ──────────────────────────────
  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (!session || !session.leadId) return unauthorized(res);

  const lead = await getLead(session.leadId);
  if (!lead) return unauthorized(res);

  // Only funded members see the deal feed
  if (lead.status !== 'funded') return unauthorized(res);

  // ── Fetch feed (cached or live) ──────────────────────────────────────────
  let feed;
  try {
    feed = await fetchPrismFeed();
  } catch (err) {
    console.error('[bridge] unexpected error from fetchPrismFeed:', err && err.message);
    return serverError(res, err);
  }

  // Ensure fetched_at is present on the response
  const fetched_at = feed.fetched_at || new Date().toISOString();

  res.setHeader('Cache-Control', 'no-store');
  return ok(res, {
    ok:            true,
    bridge_active: feed.bridge_active,
    deals:         feed.deals,
    cached:        feed.cached,
    fetched_at,
    ...(feed.error ? { error: feed.error } : {}),
  });
}
