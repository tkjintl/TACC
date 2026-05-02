// _lib/geo.js — Extract geo from Vercel request headers.
// On Vercel, every request carries free geo metadata as headers.
// Returns {} gracefully when headers are absent (local dev).

export function extractGeo(req) {
  const h = req.headers || {};

  const fwd = String(h['x-forwarded-for'] || '');
  const ip  = (fwd.split(',')[0] || '').trim() || h['x-real-ip'] || null;

  const country = h['x-vercel-ip-country']        || null;
  const region  = h['x-vercel-ip-country-region'] || null;
  const cityRaw = h['x-vercel-ip-city']           || null;

  let city = null;
  if (cityRaw) {
    try { city = decodeURIComponent(cityRaw); } catch { city = String(cityRaw); }
  }

  return {
    ip:      ip      ? maskIp(ip) : null,
    country: country || null,
    region:  region  || null,
    city:    city    || null,
  };
}

function maskIp(ip) {
  if (!ip) return null;
  // IPv4: mask last octet
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, '.0');
  // IPv6: keep first 3 groups
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
  return ip;
}
