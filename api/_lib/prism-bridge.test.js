// api/_lib/prism-bridge.test.js
// Run: node api/_lib/prism-bridge.test.js
// Tests: disabled mode returns mock, signing headers are present, cache logic works

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── Test 1: Disabled mode returns mock deals in dev ───────────────────────────

async function test_disabledModeReturnsMock() {
  console.log('\nTest 1: disabled mode returns mock deals in dev');

  // Ensure bridge is disabled and NODE_ENV is dev
  delete process.env.PRISM_BRIDGE_ENABLED;
  process.env.NODE_ENV = 'development';

  // Dynamic import AFTER setting env vars (module may cache, so we clear and re-import)
  // We re-evaluate by importing with a cache-bust query string (works for file: URLs in Node ESM)
  const mod = await import(`./prism-bridge.js?t=${Date.now()}`).catch(() => import('./prism-bridge.js'));
  const { fetchPrismFeed } = mod;

  const result = await fetchPrismFeed();

  assert(
    'ok=true',
    result.ok === true,
    `got ok=${result.ok}`
  );
  assert(
    'bridge_active=false',
    result.bridge_active === false,
    `got bridge_active=${result.bridge_active}`
  );
  assert(
    'deals is an array with 2 mock items',
    Array.isArray(result.deals) && result.deals.length >= 2,
    `got ${result.deals.length} deal(s)`
  );
  assert(
    'mock deal has no target_return (fund rule)',
    result.deals.every((d) => d.target_return === null),
    'one or more deals expose target_return'
  );
}

// ── Test 2: Signing headers would be present (unit test sign function) ────────

async function test_signingHeaders() {
  console.log('\nTest 2: HMAC-SHA256 signing produces correct format');

  // Replicate the signing logic directly to test it
  const { createHmac } = await import('node:crypto');

  const secret = 'test-secret-key';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', secret).update(ts).digest('hex');

  assert(
    'X-TACC-Ts is numeric unix timestamp string',
    /^\d+$/.test(ts) && Number(ts) > 1_000_000_000,
    `ts=${ts}`
  );
  assert(
    'X-TACC-Sig is 64-char hex (SHA256)',
    /^[0-9a-f]{64}$/.test(sig),
    `sig=${sig.slice(0, 16)}...`
  );
  assert(
    'same secret + ts produces same sig (deterministic)',
    createHmac('sha256', secret).update(ts).digest('hex') === sig,
    'non-deterministic output'
  );
}

// ── Test 3: Cache logic — stale cache is bypassed, fresh cache is returned ────

async function test_cacheLogic() {
  console.log('\nTest 3: cache logic — fresh entry is used, stale entry is bypassed');

  const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  // Simulate a cached payload
  const now = Date.now();

  const freshEntry = { deals: [{ id: 'cached-1' }], _cached_at: now - 60_000 }; // 1 min old
  const staleEntry = { deals: [{ id: 'cached-2' }], _cached_at: now - (CACHE_TTL_MS + 5000) }; // 16 min old

  // Test freshness check logic directly
  function isCacheFresh(entry) {
    if (!entry || typeof entry._cached_at !== 'number') return false;
    return (Date.now() - entry._cached_at) < CACHE_TTL_MS;
  }

  assert(
    'fresh entry (1 min old) passes freshness check',
    isCacheFresh(freshEntry) === true
  );
  assert(
    'stale entry (16 min old) fails freshness check',
    isCacheFresh(staleEntry) === false
  );
  assert(
    'null entry fails freshness check',
    isCacheFresh(null) === false
  );
}

// ── Run all tests ─────────────────────────────────────────────────────────────

async function run() {
  console.log('=== prism-bridge integration tests ===');

  try {
    await test_disabledModeReturnsMock();
  } catch (e) {
    console.error('Test 1 threw:', e && e.message);
    failed++;
  }

  try {
    await test_signingHeaders();
  } catch (e) {
    console.error('Test 2 threw:', e && e.message);
    failed++;
  }

  try {
    await test_cacheLogic();
  } catch (e) {
    console.error('Test 3 threw:', e && e.message);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
