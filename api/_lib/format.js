// _lib/format.js — Number formatting helpers for backend use (email templates, API responses).

/**
 * fmKrw(n)
 * Formats a KRW value in Korean number notation:
 *   >= 1억 (100M):   ₩12.3억
 *   >= 1만 (10K):    ₩1,234만
 *   Below:           ₩1,234
 */
export function fmKrw(n) {
  if (!n || isNaN(n)) return '—';
  if (n >= 1e8) return '₩' + (n / 1e8).toFixed(1) + '억';
  if (n >= 1e4) return '₩' + Math.round(n / 1e4).toLocaleString() + '만';
  return '₩' + Math.round(n).toLocaleString();
}

/**
 * fmUsd(n, decimals)
 * Formats a USD value: "USD 1,234,567"
 */
export function fmUsd(n, decimals = 0) {
  if (!n || isNaN(n)) return '—';
  return 'USD ' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * fmKg(n)
 * Formats a kilogram value: "32.150 kg"
 */
export function fmKg(n) {
  if (!n || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }) + ' kg';
}

/**
 * fmSgd(n, decimals)
 * @deprecated Alias for fmUsd — all display is now USD.
 */
export function fmSgd(n, decimals = 0) {
  return fmUsd(n, decimals);
}

/**
 * fmPct(n, decimals)
 * Formats a percentage: "3.00%"
 */
export function fmPct(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(decimals) + '%';
}
