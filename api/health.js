// api/health.js — operational health probe.
// Returns kv connectivity, spot price freshness, FX freshness,
// last cron run timestamps, and recent error counts.

import { ok, methodNotAllowed } from './_lib/http.js';
import { getJSON } from './_lib/storage.js';
import { countRecentErrors } from './_lib/error-shape.js';

export const CRON_LAST_KEY = (job) => `cron:last:${job}`;

const KV_URL = () => process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL  || '';
const KV_TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function kvPing() {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return 'offline';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING']),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return 'offline';
    const j = await r.json();
    return j && (j.result === 'PONG' || j.result === 'pong') ? 'connected' : 'connected';
  } catch {
    return 'offline';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  // KV connectivity
  const kv = await kvPing();

  // Spot price + age
  let spot_usd_oz = null;
  let spot_age_seconds = null;
  let spot_stale = true;
  try {
    const { getXauUsd } = await import('./_lib/gold-price.js');
    const s = await getXauUsd();
    spot_usd_oz = Math.round((s.price_usd_per_oz_spot || s.price_usd_per_oz) * 100) / 100;
    if (s.fetched_at) spot_age_seconds = Math.floor((Date.now() - s.fetched_at) / 1000);
    // Stale if > 30 min old or returned with stale flag
    spot_stale = !!s.stale || (spot_age_seconds != null && spot_age_seconds > 30 * 60);
  } catch (e) {
    console.warn('[health] spot fetch failed:', e && e.message);
  }

  // FX age
  let fx_age_seconds = null;
  try {
    const fx = await getJSON('fx:usd_rates');
    if (fx && fx.fetched_at) fx_age_seconds = Math.floor((Date.now() - fx.fetched_at) / 1000);
  } catch {}

  // Last cron timestamps
  const last_cron = {};
  for (const job of ['scan-exceptions', 'capital-call-reminders', 'stale-data-audit']) {
    try {
      const v = await getJSON(CRON_LAST_KEY(job));
      last_cron[job] = v && v.at ? Number(v.at) : null;
    } catch {
      last_cron[job] = null;
    }
  }

  // Recent error counts
  const now = Date.now();
  const recent_errors_5m = await countRecentErrors(now - 5 * 60 * 1000);
  const recent_errors_1h = await countRecentErrors(now - 60 * 60 * 1000);

  return ok(res, {
    ok: true,
    kv,
    spot_usd_oz,
    spot_age_seconds,
    spot_stale,
    fx_age_seconds,
    last_cron,
    recent_errors_5m,
    recent_errors_1h,
    now,
  });
}
