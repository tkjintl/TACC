// api/_lib/prism-bridge.js — Prism deal feed bridge client.
// Fetches curated deal feed from Prism's /api/deals/tacc-feed
// Auth: HMAC-SHA256 of timestamp in X-TACC-Sig header
// Cached in Redis for 15 minutes (key: prism:feed)

import { createHmac } from 'node:crypto';
import { getJSON, setJSON } from './storage.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CACHE_KEY = 'prism:feed';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Mock data (local dev / bridge disabled) ───────────────────────────────────

const MOCK_DEALS = [
  {
    id: 'mock-001',
    name: 'Private Credit — Consumer Finance (SEA)',
    stage: 'dd',        // review | live | dd | terms | close | realized | killed
    type: 'credit',     // credit | equity | hybrid
    geography: 'Southeast Asia',
    vintage: 'Q2 2026',
    target_return: null, // never show projected returns — fund rule
    status_note: 'Due diligence in progress. Expected close Q3 2026.',
    updated_at: new Date().toISOString(),
  },
  {
    id: 'mock-002',
    name: 'Pre-IPO Equity — Korean Fintech',
    stage: 'terms',
    type: 'equity',
    geography: 'Korea',
    vintage: 'Q1 2026',
    target_return: null,
    status_note: 'Term sheet under negotiation.',
    updated_at: new Date().toISOString(),
  },
];

// ── HMAC signing ──────────────────────────────────────────────────────────────

function signRequest(secret, ts) {
  return createHmac('sha256', secret).update(ts).digest('hex');
}

// ── Fetch with retry ──────────────────────────────────────────────────────────

async function fetchWithRetry(url, options, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Simple exponential back-off: 300ms, 600ms
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchPrismFeed() {
  const enabled = process.env.PRISM_BRIDGE_ENABLED === 'true';

  // ── Disabled / dev mode ──────────────────────────────────────────────────
  if (!enabled) {
    const isLocalDev = process.env.NODE_ENV !== 'production';
    const deals = isLocalDev ? MOCK_DEALS : [];
    return {
      ok: true,
      bridge_active: false,
      deals,
      cached: false,
    };
  }

  // ── Cache check ──────────────────────────────────────────────────────────
  try {
    const cached = await getJSON(CACHE_KEY);
    if (cached && typeof cached._cached_at === 'number') {
      const ageMs = Date.now() - cached._cached_at;
      if (ageMs < CACHE_TTL_MS) {
        console.log(`[prism-bridge] cache hit (age ${Math.round(ageMs / 1000)}s)`);
        return {
          ok: true,
          bridge_active: true,
          deals: cached.deals || [],
          cached: true,
          fetched_at: new Date(cached._cached_at).toISOString(),
        };
      }
    }
  } catch (cacheErr) {
    console.warn('[prism-bridge] cache read failed:', cacheErr && cacheErr.message);
  }

  // ── Live fetch ───────────────────────────────────────────────────────────
  const secret = process.env.PRISM_TACC_BRIDGE_SECRET;
  if (!secret) {
    console.error('[prism-bridge] PRISM_TACC_BRIDGE_SECRET is not set');
    return { ok: true, bridge_active: true, deals: [], error: 'feed_unavailable', cached: false };
  }

  const baseUrl = process.env.PRISM_SITE_URL || 'https://prism.theaurumcc.com';
  const endpoint = `${baseUrl}/api/deals/tacc-feed`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signRequest(secret, ts);

  console.log(`[prism-bridge] fetching ${endpoint} ts=${ts}`);

  let rawData;
  try {
    const res = await fetchWithRetry(endpoint, {
      method: 'GET',
      headers: {
        'X-TACC-Ts': ts,
        'X-TACC-Sig': sig,
        'Accept': 'application/json',
        'User-Agent': 'TACC-Bridge/1.0',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[prism-bridge] HTTP ${res.status} from Prism:`, body.slice(0, 200));
      return { ok: true, bridge_active: true, deals: [], error: 'feed_unavailable', cached: false };
    }

    rawData = await res.json();
  } catch (fetchErr) {
    console.error('[prism-bridge] fetch error:', fetchErr && fetchErr.message);
    return { ok: true, bridge_active: true, deals: [], error: 'feed_unavailable', cached: false };
  }

  // Normalise — Prism must return { deals: [...] } or an array directly
  const deals = Array.isArray(rawData) ? rawData : (Array.isArray(rawData.deals) ? rawData.deals : []);

  // ── Cache result ─────────────────────────────────────────────────────────
  const fetchedAt = Date.now();
  try {
    await setJSON(CACHE_KEY, { deals, _cached_at: fetchedAt });
  } catch (cacheWriteErr) {
    console.warn('[prism-bridge] cache write failed:', cacheWriteErr && cacheWriteErr.message);
  }

  return {
    ok: true,
    bridge_active: true,
    deals,
    cached: false,
    fetched_at: new Date(fetchedAt).toISOString(),
  };
}
