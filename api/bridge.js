// api/bridge.js — GET /api/bridge
// Returns Prism deal feed for authenticated TACC members.
// Auth: aurum_access cookie (COOKIE_MEMBER from auth.js)

import {
  ok, unauthorized, methodNotAllowed, serverError, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER, COOKIE_ADMIN } from './_lib/auth.js';
import { getLead } from './_lib/storage.js';
import { fetchPrismFeed } from './_lib/prism-bridge.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  // ── Auth ─────────────────────────────────────────────────────────────────
  let lead = null;

  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (session && session.leadId) {
    lead = await getLead(session.leadId);
  }

  if (!lead) {
    const adminToken = getCookie(req, COOKIE_ADMIN);
    const adminSession = await verifyToken(adminToken);
    if (adminSession && adminSession.sub === 'admin') {
      const previewId = String(getQuery(req).preview_lead || '').trim();
      if (previewId) lead = await getLead(previewId);
      if (!lead) lead = { id: '_admin_browse', status: 'funded' };
    }
  }

  if (!lead) return unauthorized(res);
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
