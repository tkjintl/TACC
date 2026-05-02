// _lib/gold-price.js — XAU/USD spot price with two-tier fetch and Redis cache.
// Primary:  metals-api.com  (METALS_API_KEY)
// Fallback: goldapi.io      (GOLD_API_KEY)
// Cache TTL: 15 minutes (Redis key: gold:spot)
//
// GOLD_MARKUP_PCT   — procurement markup applied on top of raw spot (default 3.0%)
// VAULT_TRACKING_MODE — 'vault' (bar-level LBMA serial registry) or 'bank' (custodian position)

const TROY_OZ_PER_KG  = 32.1507;
const CACHE_KEY       = 'gold:spot';
const CACHE_TTL_SEC   = 15 * 60;

const MARKUP_PCT = parseFloat(process.env.GOLD_MARKUP_PCT || '3.0');

// Inline Redis helper — reuses the same Upstash REST pattern from storage.js
// so gold-price.js doesn't create a circular import.
const KV_URL = () => process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL  || '';
const KV_TOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function redisGet(key) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const raw = j.result;
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

async function redisSetEx(key, ttlSec, value) {
  const url = KV_URL(); const tok = KV_TOK();
  if (!url || !tok) return;
  await fetch(`${url}/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(JSON.stringify(value))}`, {
    headers: { Authorization: `Bearer ${tok}` },
  }).catch(() => {});
}

// ── Fetchers ──────────────────────────────────────────────────────────────────

async function fetchMetalsApi() {
  const key = process.env.METALS_API_KEY;
  if (!key) return null;
  const url = `https://metals-api.com/api/latest?access_key=${encodeURIComponent(key)}&base=USD&symbols=XAU`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json();
  // metals-api returns { rates: { XAU: <oz_per_1_USD> } } — it's an inverted rate
  // XAU rate = units of XAU per 1 USD → price per oz = 1 / rates.XAU
  if (!j.success || !j.rates || !j.rates.XAU) return null;
  const pricePerOz = 1 / j.rates.XAU;
  if (!isFinite(pricePerOz) || pricePerOz <= 0) return null;
  return pricePerOz;
}

async function fetchGoldApi() {
  const key = process.env.GOLD_API_KEY;
  if (!key) return null;
  const r = await fetch('https://www.goldapi.io/api/XAU/USD', {
    headers: { 'x-access-token': key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const pricePerOz = j.price;
  if (!pricePerOz || !isFinite(pricePerOz) || pricePerOz <= 0) return null;
  return pricePerOz;
}

// ── Core export ───────────────────────────────────────────────────────────────

/**
 * getXauUsd()
 * Returns { price_usd_per_oz, price_usd_per_gram, price_usd_per_kg, fetched_at, stale }
 */
export async function getXauUsd() {
  // 1. Check cache
  let cached = null;
  try { cached = await redisGet(CACHE_KEY); } catch {}
  // Validate cache has the markup fields (added in Phase 4) — if absent, treat as miss
  if (cached && cached.price_usd_per_oz && cached.price_usd_per_kg_spot != null) {
    return { ...cached, stale: false };
  }

  // 2. Try primary
  let pricePerOz = null;
  try { pricePerOz = await fetchMetalsApi(); } catch {}

  // 3. Try fallback
  if (pricePerOz == null) {
    try { pricePerOz = await fetchGoldApi(); } catch {}
  }

  // 4. Both failed — return stale cache if available, else demo fallback
  if (pricePerOz == null) {
    // Try to get any cached value even if expired (stale)
    let staleKey = null;
    try { staleKey = await redisGet(`${CACHE_KEY}:fallback`); } catch {}
    if (staleKey && staleKey.price_usd_per_oz && staleKey.price_usd_per_kg_spot != null) {
      return { ...staleKey, stale: true };
    }
    // Demo fallback: hardcoded spot so the platform renders without API keys.
    // ~May 2026 spot ≈ $3,500/oz. Replace by setting METALS_API_KEY or GOLDAPI_KEY.
    pricePerOz = 3500;
  }

  const spotPerOz = pricePerOz;
  const spotPerKg = pricePerOz * TROY_OZ_PER_KG;

  const result = {
    // Member-facing prices (with markup applied)
    price_usd_per_oz:   spotPerOz * (1 + MARKUP_PCT / 100),
    price_usd_per_gram: (spotPerOz / 31.1035) * (1 + MARKUP_PCT / 100),
    price_usd_per_kg:   Math.round(spotPerKg * (1 + MARKUP_PCT / 100)),
    // Raw spot prices for audit / internal use
    price_usd_per_oz_spot: spotPerOz,
    price_usd_per_kg_spot: spotPerKg,
    markup_pct:         MARKUP_PCT,
    fetched_at:         Date.now(),
    stale:              false,
  };

  // Store in cache + fallback (fallback has no TTL so it survives as stale)
  try {
    await redisSetEx(CACHE_KEY, CACHE_TTL_SEC, result);
    await redisSetEx(`${CACHE_KEY}:fallback`, 60 * 60 * 24 * 7, result); // 7-day stale fallback
  } catch {}

  return result;
}

/**
 * getKgPriceUsd()
 * Returns member-facing (marked-up) price per kg in USD.
 */
export async function getKgPriceUsd() {
  const data = await getXauUsd();
  return data.price_usd_per_kg;
}

/**
 * getXauKrw()
 * Returns KRW per kg (member-facing, marked-up) by combining XAU/USD + KRW/USD.
 */
export async function getXauKrw() {
  const { getKrwPerUsd } = await import('./fx.js');
  const [kgUsd, krwPerUsd] = await Promise.all([getKgPriceUsd(), getKrwPerUsd()]);
  return kgUsd * krwPerUsd;
}

/**
 * getVaultMode()
 * Returns the active custody tracking mode: 'vault' or 'bank'.
 * Controlled by VAULT_TRACKING_MODE env var (default: 'vault').
 *   vault — individual LBMA bar serial numbers, Malca-Amit Singapore FTZ
 *   bank  — custodian bank holds gold as a position, no bar registry
 */
export function getVaultMode() {
  const v = (process.env.VAULT_TRACKING_MODE || 'vault').toLowerCase().trim();
  return v === 'bank' ? 'bank' : 'vault';
}
