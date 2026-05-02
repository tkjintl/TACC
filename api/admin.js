// api/admin.js — Admin operations dispatcher.
// Extends the v2.js admin resource. All routes require aurum_admin cookie.
// This file exists as a named entry-point; logic lives in v2.js handleAdmin().
// Direct POST/GET to /api/admin?op=... is also valid.

import v2Handler from './v2.js';
import { getQuery, bad } from './_lib/http.js';

export default async function handler(req, res) {
  const q = getQuery(req);

  // If resource param is already set, forward to v2
  if (q.resource) return v2Handler(req, res);

  // Allow ?op= shorthand: inject resource=admin and delegate
  if (q.op) {
    // Mutate the URL so v2 routes correctly
    const url = new URL(req.url, 'http://localhost');
    url.searchParams.set('resource', 'admin');
    req.url = url.pathname + '?' + url.searchParams.toString();
    return v2Handler(req, res);
  }

  return bad(res, 'op query param required');
}
