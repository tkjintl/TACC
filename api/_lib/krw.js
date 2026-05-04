// KRW/kg gold spot fetcher.
//
// Strategy: pull live USD spot per troy ounce from primary source (gold-api.com,
// keyless real-time), fall back to Yahoo XAUUSD=X if primary fails, fall back
// to USD $4,700/oz hard constant if both fail. Then convert USD → KRW via
// Yahoo USDKRW=X with its own fallback constant.
//
// 3% markup applied on top of pure spot to derive AURUM purchase price
// (covers procurement spread + 2-day spot-window risk). Markup is the AURUM
// member-facing rate, not raw spot.
//
// In-process cache: 5 minutes. All callers receive:
//   {
//     krw_per_kg,         ← AURUM purchase price (post-markup)
//     krw_per_kg_spot,    ← raw spot (no markup) — for partner audit
//     usd_per_oz,         ← raw USD spot
//     usd_krw,            ← FX rate used
//     markup_pct,         ← 3.0 always
//     fetched_at_ms,
//     source,             ← 'gold-api' | 'yahoo' | 'cache-stale' | 'fallback'
//   }

const GOLDAPI_URL    = 'https://api.gold-api.com/price/XAU';
const YAHOO_XAU_URL  = 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1d&range=1d';
const YAHOO_FX_URL   = 'https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X?interval=1d&range=1d';
const OZ_PER_KG      = 32.1507466;
const CACHE_TTL_MS   = 5 * 60 * 1000;
const MARKUP_PCT     = 3.0;

// Hard fallbacks — used only if BOTH primary and secondary sources fail.
const USD_PER_OZ_FALLBACK = 4720;
const USD_KRW_FALLBACK    = 1440;

let _cache = null;

async function fetchJson(url, timeoutMs = 4000) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Mozilla/5.0 (Aurum) AppleWebKit/537.36' },
  });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

async function fetchUsdPerOz() {
  // Primary: gold-api.com — keyless, real-time, returns { price: number, ... }
  try {
    const j = await fetchJson(GOLDAPI_URL);
    const price = j?.price;
    if (typeof price === 'number' && price > 0) return { usd_per_oz: price, source: 'gold-api' };
  } catch (e) {
    console.warn('[krw] gold-api failed:', e.message || e);
  }
  // Secondary: Yahoo XAUUSD=X
  try {
    const j = await fetchJson(YAHOO_XAU_URL);
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose;
    if (typeof price === 'number' && price > 0) return { usd_per_oz: price, source: 'yahoo' };
  } catch (e) {
    console.warn('[krw] yahoo XAUUSD failed:', e.message || e);
  }
  return null;
}

async function fetchUsdKrwFx() {
  try {
    const j = await fetchJson(YAHOO_FX_URL);
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose;
    if (typeof price === 'number' && price > 0) return price;
  } catch (e) {
    console.warn('[krw] yahoo USDKRW failed:', e.message || e);
  }
  return null;
}

export async function getKrwPerKg() {
  const now = Date.now();
  if (_cache && now - _cache.fetched_at_ms < CACHE_TTL_MS) return _cache;

  const usdResult = await fetchUsdPerOz();
  const fxLive    = await fetchUsdKrwFx();

  if (usdResult && fxLive) {
    const usd_per_oz       = usdResult.usd_per_oz;
    const usd_krw          = fxLive;
    const krw_per_kg_spot  = Math.round(usd_per_oz * OZ_PER_KG * usd_krw);
    const krw_per_kg       = Math.round(krw_per_kg_spot * (1 + MARKUP_PCT / 100));
    _cache = {
      krw_per_kg,
      krw_per_kg_spot,
      usd_per_oz,
      usd_krw,
      markup_pct: MARKUP_PCT,
      fetched_at_ms: now,
      source: usdResult.source,
    };
    return _cache;
  }

  if (_cache) return { ..._cache, source: 'cache-stale' };

  const usd_per_oz      = USD_PER_OZ_FALLBACK;
  const usd_krw         = fxLive || USD_KRW_FALLBACK;
  const krw_per_kg_spot = Math.round(usd_per_oz * OZ_PER_KG * usd_krw);
  const krw_per_kg      = Math.round(krw_per_kg_spot * (1 + MARKUP_PCT / 100));
  return {
    krw_per_kg,
    krw_per_kg_spot,
    usd_per_oz,
    usd_krw,
    markup_pct: MARKUP_PCT,
    fetched_at_ms: now,
    source: 'fallback',
  };
}
