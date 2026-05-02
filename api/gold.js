// api/gold.js — Public gold spot price endpoint.
// GET /api/gold?type=spot
// No auth required. Aggregates XAU/USD + KRW + SGD.

import { ok, bad, serverError, methodNotAllowed, getQuery } from './_lib/http.js';
import { getXauUsd, getVaultMode } from './_lib/gold-price.js';
import { getKrwPerUsd, getSgdPerUsd } from './_lib/fx.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const { type } = getQuery(req);
  if (type && type !== 'spot') return bad(res, `unknown type: ${type}`);

  try {
    const [xau, krwPerUsd, sgdPerUsd] = await Promise.all([
      getXauUsd(),
      getKrwPerUsd(),
      getSgdPerUsd(),
    ]);

    // Member-facing (marked-up) prices
    const xauSgdKg      = xau.price_usd_per_kg * sgdPerUsd;
    const xauKrwKg      = xau.price_usd_per_kg * krwPerUsd;
    // Raw spot prices (audit / admin use)
    const xauSgdKgSpot  = xau.price_usd_per_kg_spot * sgdPerUsd;
    const xauKrwKgSpot  = xau.price_usd_per_kg_spot * krwPerUsd;

    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=840');
    return ok(res, {
      ok:               true,
      // Member-facing prices (markup included)
      xau_usd_oz:       Math.round(xau.price_usd_per_oz * 100) / 100,
      xau_usd_kg:       Math.round(xau.price_usd_per_kg * 100) / 100,
      xau_sgd_kg:       Math.round(xauSgdKg * 100) / 100,
      xau_krw_kg:       Math.round(xauKrwKg),
      // Raw spot prices (for transparency / audit)
      xau_usd_oz_spot:  Math.round(xau.price_usd_per_oz_spot * 100) / 100,
      xau_usd_kg_spot:  Math.round(xau.price_usd_per_kg_spot * 100) / 100,
      xau_sgd_kg_spot:  Math.round(xauSgdKgSpot * 100) / 100,
      xau_krw_kg_spot:  Math.round(xauKrwKgSpot),
      markup_pct:       xau.markup_pct,
      usd_sgd:          Math.round(sgdPerUsd * 10000) / 10000,
      usd_krw:          Math.round(krwPerUsd * 100) / 100,
      fetched_at:       xau.fetched_at,
      stale:            xau.stale || false,
      vault_mode:       getVaultMode(),
    });
  } catch (e) {
    console.error('[gold] fetch error:', e && e.message);
    return serverError(res, e);
  }
}
