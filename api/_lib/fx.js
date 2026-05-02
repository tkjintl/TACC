// _lib/fx.js — KRW/USD and SGD/USD exchange rates.
// Source: open.er-api.com/v6/latest/USD (free, no key)
// Cache TTL: 1 hour in Redis

const CACHE_KEY = 'fx:usd_rates';
const CACHE_TTL_SEC = 60 * 60;

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

// In-memory fallback for when Redis is unavailable
let _memRates = null;
let _memRatesAt = 0;

async function getRates() {
  // Check Redis cache
  let cached = null;
  try { cached = await redisGet(CACHE_KEY); } catch {}
  if (cached && cached.KRW && cached.SGD) return cached;

  // Check in-memory (max 1h)
  if (_memRates && (Date.now() - _memRatesAt) < CACHE_TTL_SEC * 1000) return _memRates;

  // Fetch fresh
  const r = await fetch('https://open.er-api.com/v6/latest/USD', {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`FX fetch failed: ${r.status}`);
  const j = await r.json();
  if (!j.rates || !j.rates.KRW || !j.rates.SGD) {
    throw new Error('FX response missing KRW or SGD rates');
  }

  const rates = { KRW: j.rates.KRW, SGD: j.rates.SGD, fetched_at: Date.now() };

  try { await redisSetEx(CACHE_KEY, CACHE_TTL_SEC, rates); } catch {}
  _memRates = rates;
  _memRatesAt = Date.now();

  return rates;
}

export async function getKrwPerUsd() {
  const r = await getRates();
  return r.KRW;
}

export async function getSgdPerUsd() {
  const r = await getRates();
  return r.SGD;
}

export async function convertUsdToKrw(usd) {
  const rate = await getKrwPerUsd();
  return usd * rate;
}

export async function convertUsdToSgd(usd) {
  const rate = await getSgdPerUsd();
  return usd * rate;
}

/**
 * convertKgToSgd(kg, xauUsdPerKg)
 * kg: kilograms of gold
 * xauUsdPerKg: USD price per kg
 */
export async function convertKgToSgd(kg, xauUsdPerKg) {
  const rate = await getSgdPerUsd();
  return kg * xauUsdPerKg * rate;
}

/**
 * convertKgToKrw(kg, xauUsdPerKg)
 */
export async function convertKgToKrw(kg, xauUsdPerKg) {
  const rate = await getKrwPerUsd();
  return kg * xauUsdPerKg * rate;
}
