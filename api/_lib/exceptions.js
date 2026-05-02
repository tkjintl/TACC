// _lib/exceptions.js — Compliance exception detector.
// Scans every lead and emits flag entries via storage.addComplianceFlag().
// Each flag is keyed flag:{leadId}:{type} with a 32-day TTL so stale flags
// disappear automatically if not refreshed by the next scan.

import {
  listLeads,
  addComplianceFlag,
  getLastVaultVerification,
} from './storage.js';

const DAY = 86400 * 1000;

export async function scanForExceptions() {
  const now = Date.now();
  const leads = await listLeads({ limit: 1000 });
  let added = 0;

  for (const lead of leads) {
    if (lead.deleted_at) continue;
    const isFunded = lead.status === 'funded';

    // 1. KYC expiring within 30 days
    if (lead.kyc_expires_at) {
      const exp = new Date(lead.kyc_expires_at).getTime();
      if (exp - now <= 30 * DAY && exp > now) {
        await addComplianceFlag(lead.id, 'kyc-expiring',
          `KYC expires ${new Date(exp).toISOString().slice(0, 10)}`);
        added++;
      }
    }

    // 2. NDA missing for subscribed
    if (lead.status === 'subscribed' && lead.nda_state !== 'approved') {
      await addComplianceFlag(lead.id, 'nda-missing',
        `Subscribed but NDA state is '${lead.nda_state || 'awaiting'}'`);
      added++;
    }

    // 3. Code expiring within 7 days
    if (lead.code_expires_at) {
      const exp = new Date(lead.code_expires_at).getTime();
      if (exp - now <= 7 * DAY && exp > now) {
        await addComplianceFlag(lead.id, 'code-expiring',
          `Invitation code expires ${new Date(exp).toISOString().slice(0, 10)}`);
        added++;
      }
    }

    // 4 & 5. LTV thresholds (funded only)
    if (isFunded) {
      const ceiling = Number(lead.credit_ceiling_usd) || 0;
      const drawn   = Number(lead.credit_outstanding_usd) || 0;
      if (ceiling > 0 && drawn > 0) {
        const ratio = drawn / ceiling;
        if (ratio > 0.75) {
          await addComplianceFlag(lead.id, 'ltv-near-ceiling',
            `Credit drawn ${(ratio * 100).toFixed(1)}% of ceiling`);
          added++;
        } else if (ratio > 0.70) {
          await addComplianceFlag(lead.id, 'ltv-approaching',
            `Credit drawn ${(ratio * 100).toFixed(1)}% of ceiling`);
          added++;
        }
      }
    }

    // 6. Capital call overdue
    for (const c of (lead.capital_calls || [])) {
      if (c.status === 'paid') continue;
      const due = c.due_date ? new Date(c.due_date).getTime() : null;
      if (due && due < now) {
        await addComplianceFlag(lead.id, 'capital-call-overdue',
          `Capital call ${c.ref || c.id} overdue since ${new Date(due).toISOString().slice(0, 10)}`);
        added++;
        break;
      }
    }

    // 7. Member inactive 60d (funded only)
    if (isFunded && lead.last_login_at) {
      const last = new Date(lead.last_login_at).getTime();
      if (now - last > 60 * DAY) {
        await addComplianceFlag(lead.id, 'member-inactive',
          `No login in ${Math.floor((now - last) / DAY)} days`);
        added++;
      }
    }

    // 8. Wire pending stale (>7d since instructions sent, not cleared)
    if (lead.wire && lead.wire.instructions_sent_at && !lead.wire.cleared_at) {
      const sent = typeof lead.wire.instructions_sent_at === 'number'
        ? lead.wire.instructions_sent_at
        : new Date(lead.wire.instructions_sent_at).getTime();
      if (now - sent > 7 * DAY) {
        await addComplianceFlag(lead.id, 'wire-pending-stale',
          `Wire ${lead.wire.reference} pending ${Math.floor((now - sent) / DAY)} days`);
        added++;
      }
    }
  }

  // 9. Vault verification overdue (global)
  try {
    const last = await getLastVaultVerification();
    const lastTs = last && last.published_at ? new Date(last.published_at).getTime() : 0;
    if (!lastTs || now - lastTs > 90 * DAY) {
      await addComplianceFlag('global', 'vault-verification-overdue',
        lastTs
          ? `Last vault verification ${Math.floor((now - lastTs) / DAY)} days ago`
          : 'No vault verification on record');
      added++;
    }
  } catch (e) {
    console.warn('[exceptions] vault check failed:', e && e.message);
  }

  return { added, scanned: leads.length };
}
