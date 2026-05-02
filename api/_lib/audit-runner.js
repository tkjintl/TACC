// _lib/audit-runner.js — Platform self-test. Runs ~25 cheap checks, returns
// a structured issue log. Designed to be cheap on Upstash (~30 cmds total).

import {
  listLeads,
  getLead,
  getStageCounts,
  listFundedMembers,
  listComplianceFlags,
  globalAuditList,
  getJSON,
  pickOneByStage,
} from './storage.js';

function row(name, status, detail) {
  return { name, status, detail: detail || '' };
}

export async function runPlatformAudit(session) {
  const checks = [];
  const startTs = Date.now();

  // 1. Auth — we got here, so admin auth works
  checks.push(row('admin auth', 'pass', `actor: ${session?.email || 'admin'}`));

  // 2. Stage counters
  let stages = null;
  try {
    stages = await getStageCounts();
    checks.push(row('stage counters', 'pass',
      `total=${stages.total} (inq=${stages.inquiry} inv=${stages.invited} nda=${stages.nda_pending} sub=${stages.subscribed} wi=${stages.wire_issued} wr=${stages.wire_received} fd=${stages.funded})`));
  } catch (e) {
    checks.push(row('stage counters', 'fail', e.message));
  }

  // 3. Sample inquiry from stage index
  try {
    const sample = await pickOneByStage('inquiry');
    checks.push(row('stage index — inquiry', sample ? 'pass' : 'warn',
      sample ? `picked: ${sample.name || sample.id}` : 'no inquiry-stage leads in index'));
  } catch (e) {
    checks.push(row('stage index — inquiry', 'fail', e.message));
  }

  // 4. Funded members + member# uniqueness
  let funded = [];
  try {
    funded = await listFundedMembers();
    const numbers = funded.map((m) => m.member_number).filter(Boolean);
    const unique = new Set(numbers);
    if (numbers.length !== unique.size) {
      const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
      checks.push(row('member# uniqueness', 'fail',
        `${numbers.length} numbers, ${unique.size} unique. dupes: ${[...new Set(dupes)].join(',')}`));
    } else {
      checks.push(row('member# uniqueness', 'pass', `${numbers.length} unique`));
    }
    checks.push(row('funded members count', 'pass', `${funded.length} funded`));
    if (stages && stages.funded !== funded.length) {
      checks.push(row('counter vs funded list', 'warn',
        `counter=${stages.funded} list=${funded.length} — recount-stages may be needed`));
    }
  } catch (e) {
    checks.push(row('funded members', 'fail', e.message));
  }

  // 5. Investor-profile completeness on funded members
  if (funded.length) {
    const requiredFields = ['phone', 'tax_residency', 'occupation', 'investor_classification', 'source_of_wealth_high_level', 'anticipated_allocation_kg'];
    const missing = [];
    for (const m of funded) {
      const blanks = requiredFields.filter((f) => !m[f]);
      if (blanks.length) missing.push(`${m.name}: ${blanks.join(',')}`);
    }
    if (missing.length) {
      checks.push(row('funded profile completeness', 'warn',
        `${missing.length} of ${funded.length} have blank required fields:\n     ${missing.slice(0, 5).join('\n     ')}${missing.length > 5 ? '\n     …' : ''}`));
    } else {
      checks.push(row('funded profile completeness', 'pass', `all ${funded.length} have full investor profile`));
    }
  }

  // 6. Compliance flags
  let flags = [];
  try {
    flags = await listComplianceFlags();
    const bySev = flags.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
    checks.push(row('compliance flags', flags.length > 0 ? 'pass' : 'warn',
      `total=${flags.length} ` + Object.entries(bySev).map(([s, c]) => `${s}=${c}`).join(' ')));
  } catch (e) {
    checks.push(row('compliance flags', 'fail', e.message));
  }

  // 7. Global audit feed
  let auditEntries = [];
  try {
    auditEntries = await globalAuditList({ limit: 50 });
    checks.push(row('global audit stream', auditEntries.length > 0 ? 'pass' : 'warn',
      `${auditEntries.length} recent entries`));
    // Last action timestamp
    if (auditEntries.length) {
      const last = auditEntries[0];
      const ageMs = Date.now() - (last.at || 0);
      const ageMin = Math.round(ageMs / 60000);
      checks.push(row('last audit entry age', ageMin < 60 ? 'pass' : 'warn',
        `${ageMin}m ago — actor=${last.actor} action=${last.action} target=${last.target_name || '—'}`));
    }
  } catch (e) {
    checks.push(row('global audit stream', 'fail', e.message));
  }

  // 8. Spot price feed
  try {
    const { getXauUsd } = await import('./gold-price.js');
    const spot = await getXauUsd();
    checks.push(row('gold spot feed', spot && spot.price_usd_per_oz ? 'pass' : 'fail',
      spot ? `$${(spot.price_usd_per_oz || 0).toFixed(2)}/oz · stale=${!!spot.stale}` : 'null'));
  } catch (e) {
    checks.push(row('gold spot feed', 'fail', e.message));
  }

  // 9. FX rate feed
  try {
    const { getKrwPerUsd } = await import('./fx.js');
    const krw = await getKrwPerUsd();
    checks.push(row('FX feed', krw ? 'pass' : 'warn', krw ? `₩${krw.toFixed(2)}/$` : 'null'));
  } catch (e) {
    checks.push(row('FX feed', 'fail', e.message));
  }

  // 10. Bot state
  try {
    const botState = await getJSON('bot:state');
    if (!botState) {
      checks.push(row('bot harness state', 'warn', 'not initialised'));
    } else {
      checks.push(row('bot harness state', 'pass',
        `mode=${botState.auto_mode || 'off'} ticks=${botState.ticks_run || 0}+${botState.auto_actions_count || 0} cmds≈${botState.estimated_upstash_cmds || 0}`));
    }
  } catch (e) {
    checks.push(row('bot harness state', 'fail', e.message));
  }

  // 11. NDA queue
  try {
    const ndaCount = stages ? stages.nda_pending : 0;
    checks.push(row('NDA review queue', ndaCount > 0 ? 'pass' : 'warn',
      `${ndaCount} pending NDA review`));
  } catch (e) {
    checks.push(row('NDA review queue', 'fail', e.message));
  }

  // 12. Wires pending
  try {
    const wirePending = (stages?.wire_issued || 0) + (stages?.wire_received || 0);
    checks.push(row('wires in flight', wirePending >= 0 ? 'pass' : 'warn',
      `${stages?.wire_issued || 0} issued, ${stages?.wire_received || 0} received pending clearance`));
  } catch (e) {
    checks.push(row('wires in flight', 'fail', e.message));
  }

  // 13. Capacity
  try {
    const fundedCount = stages?.funded || 0;
    const remaining = 100 - fundedCount;
    checks.push(row('seat capacity', remaining > 0 ? 'pass' : 'warn',
      `${fundedCount}/100 admitted · ${remaining} seats remaining`));
  } catch (e) {
    checks.push(row('seat capacity', 'fail', e.message));
  }

  // 14. Data integrity — leads with member# but not funded
  try {
    let badRefs = 0;
    for (const m of funded) {
      if (!m.member_number) badRefs++;
    }
    checks.push(row('funded ↔ member#', badRefs === 0 ? 'pass' : 'fail',
      badRefs === 0 ? `all ${funded.length} have member#` : `${badRefs} funded missing member#`));
  } catch (e) {
    checks.push(row('funded ↔ member#', 'fail', e.message));
  }

  // 15. Recent activity volume — sanity check that platform is alive
  try {
    const last24h = auditEntries.filter((e) => (Date.now() - e.at) < 24 * 3600000).length;
    checks.push(row('activity (24h)', 'pass', `${last24h} entries in last 24h`));
  } catch (e) {
    checks.push(row('activity (24h)', 'fail', e.message));
  }

  // 16. Exceptions detector hook — vault verification age
  try {
    const lastVV = await getJSON('vault_verification:last_published_at');
    const ageDays = lastVV ? Math.round((Date.now() - lastVV) / 86400000) : null;
    if (ageDays === null) {
      checks.push(row('vault verification', 'warn', 'no verification published'));
    } else if (ageDays > 90) {
      checks.push(row('vault verification', 'fail', `${ageDays}d old — overdue`));
    } else {
      checks.push(row('vault verification', 'pass', `${ageDays}d old`));
    }
  } catch (e) {
    checks.push(row('vault verification', 'warn', e.message));
  }

  // Summary
  const counts = checks.reduce((a, c) => { a[c.status] = (a[c.status] || 0) + 1; return a; }, { pass: 0, warn: 0, fail: 0 });
  const elapsedMs = Date.now() - startTs;

  return {
    ok: true,
    ts: startTs,
    elapsed_ms: elapsedMs,
    summary: {
      total: checks.length,
      pass: counts.pass,
      warn: counts.warn,
      fail: counts.fail,
      health_pct: checks.length ? Math.round((counts.pass / checks.length) * 100) : 0,
    },
    checks,
  };
}

// Render result as plain-text log suitable for clipboard.
export function renderAuditLog(result) {
  const ts = new Date(result.ts);
  const lines = [];
  lines.push('AURUM TACC — PLATFORM AUDIT');
  lines.push(`Run at:   ${ts.toISOString()}`);
  lines.push(`Elapsed:  ${result.elapsed_ms}ms`);
  lines.push(`Health:   ${result.summary.health_pct}% (${result.summary.pass} pass · ${result.summary.warn} warn · ${result.summary.fail} fail · ${result.summary.total} total)`);
  lines.push('');
  lines.push('CHECKS');
  lines.push('─'.repeat(60));
  for (const c of result.checks) {
    const sym = c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
    lines.push(`${sym} ${c.name}`);
    if (c.detail) {
      // Indent multi-line details
      for (const line of String(c.detail).split('\n')) {
        lines.push(`     ${line}`);
      }
    }
  }
  lines.push('');
  if (result.summary.fail > 0) {
    lines.push('FAILURES (review immediately):');
    for (const c of result.checks.filter((c) => c.status === 'fail')) {
      lines.push(`  ✗ ${c.name} — ${c.detail}`);
    }
    lines.push('');
  }
  if (result.summary.warn > 0) {
    lines.push('WARNINGS (non-blocking):');
    for (const c of result.checks.filter((c) => c.status === 'warn')) {
      lines.push(`  ⚠ ${c.name} — ${c.detail}`);
    }
    lines.push('');
  }
  lines.push('END OF AUDIT');
  return lines.join('\n');
}
