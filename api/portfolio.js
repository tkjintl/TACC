// api/portfolio.js — Member portfolio aggregation.
// GET /api/portfolio              — requires aurum_access cookie.
// GET /api/portfolio?preview_lead=ID — requires aurum_admin cookie (admin preview mode).
// Returns full member financial view for funded members, or LIMBO state for earlier stages.

import {
  ok, unauthorized, notFound, serverError, methodNotAllowed, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER, COOKIE_ADMIN } from './_lib/auth.js';
import { getLead } from './_lib/storage.js';
import { getXauUsd, getVaultMode } from './_lib/gold-price.js';
import { getKrwPerUsd, getSgdPerUsd } from './_lib/fx.js';

// ── Stage resolver ────────────────────────────────────────────────────────────

/**
 * resolveStage(lead)
 * Maps lead state to a named pipeline stage.
 */
function resolveStage(lead) {
  if (lead.status === 'funded') return 'funded';

  const wire = lead.wire || {};
  if (wire.reference && wire.received_at && !wire.cleared_at) return 'wire_received';
  if (wire.reference && !wire.received_at) return 'wire_issued';

  if (lead.status === 'subscribed') return 'subscribed';

  const ndaState = lead.nda_state || 'awaiting';
  if (ndaState === 'uploaded') return 'nda_pending';

  return 'invited';
}

// ── Status ordering for gate checks ──────────────────────────────────────────

const STATUS_RANK = {
  inquiry:    0,
  invited:    1,
  accessed:   2,
  subscribed: 3,
  funded:     4,
};

// ── next_action resolver ──────────────────────────────────────────────────────

function resolveNextAction(lead) {
  const ndaState = lead.nda_state || 'awaiting';
  const status   = lead.status   || 'inquiry';

  if (ndaState === 'awaiting') {
    return { type: 'nda', label: 'Sign and return your NDA', url: '/nda' };
  }
  if (ndaState === 'uploaded') {
    return { type: 'nda_pending', label: 'NDA under review', url: '/nda' };
  }
  if (status === 'accessed' && ndaState === 'approved') {
    return { type: 'subscribe', label: 'Complete your subscription', url: '/subscription' };
  }
  const pendingCall = (lead.capital_calls || []).find(
    (c) => c.status === 'pending' && !c.acknowledged_at
  );
  if (pendingCall) {
    return { type: 'capital_call', label: 'Capital call requires acknowledgement', url: '/portfolio#gold' };
  }
  return null;
}

// ── Core portfolio builder ────────────────────────────────────────────────────

/**
 * buildPortfolioResponse(res, lead)
 * Assembles and sends the full portfolio response for any lead stage.
 * For pre-funded stages returns a LIMBO response; for funded returns full financial data.
 */
async function buildPortfolioResponse(res, lead) {
  const stage      = resolveStage(lead);
  const wire       = lead.wire || {};

  // ── LIMBO response (pre-funded) ───────────────────────────────────────────
  if (stage !== 'funded') {
    return ok(res, {
      ok:           true,
      stage,
      member: {
        name:          lead.name          || null,
        email:         lead.email         || null,
        member_number: lead.member_number || null,
      },
      nda_state: lead.nda_state || 'awaiting',
      wire: wire.reference ? {
        reference:   wire.reference,
        issued_at:   wire.instructions_sent_at || null,
        received_at: wire.received_at          || null,
        cleared_at:  wire.cleared_at           || null,
      } : null,
      subscription: lead.subscription ? {
        kg_requested: lead.subscription.kg_requested,
        submitted_at: lead.subscription.submitted_at || null,
      } : null,
      next_action: resolveNextAction(lead),
      vault_mode:  getVaultMode(),
    });
  }

  // ── Funded — full portfolio ───────────────────────────────────────────────
  try {
    let xau = null, krwPerUsd = null, sgdPerUsd = null;
    try {
      [xau, krwPerUsd, sgdPerUsd] = await Promise.all([
        getXauUsd(),
        getKrwPerUsd(),
        getSgdPerUsd(),
      ]);
    } catch (e) {
      console.warn('[portfolio] price fetch failed:', e && e.message);
    }

    // Gold position calculations
    const kg = (lead.subscription && lead.subscription.kg_requested) || null;
    let goldSection = null;

    if (kg && xau && sgdPerUsd && krwPerUsd) {
      // Use member-facing (marked-up) price_usd_per_kg for current NAV
      const valueUsd  = kg * xau.price_usd_per_kg;
      const valueSgd  = valueUsd * sgdPerUsd;
      const valueKrw  = valueUsd * krwPerUsd;

      // Entry price: wire amount, 80% allocated to gold, divided by kg
      const wirePaid  = wire.amount_usd;
      const entryUsd  = wirePaid ? (wirePaid * 0.80) / kg : null;
      const entrySgd  = entryUsd ? entryUsd * sgdPerUsd : null;
      const changePct = entrySgd ? ((valueSgd - entrySgd) / entrySgd) * 100 : null;

      goldSection = {
        kg,
        value_sgd:       Math.round(valueSgd),
        value_usd:       Math.round(valueUsd),
        value_krw:       Math.round(valueKrw),
        entry_price_sgd: entrySgd ? Math.round(entrySgd) : null,
        change_pct:      changePct !== null ? Math.round(changePct * 100) / 100 : null,
        spot: {
          xau_usd_oz:      Math.round(xau.price_usd_per_oz * 100) / 100,
          xau_usd_kg:      Math.round(xau.price_usd_per_kg * 100) / 100,
          xau_usd_kg_spot: Math.round(xau.price_usd_per_kg_spot * 100) / 100,
          xau_sgd_kg:      Math.round(xau.price_usd_per_kg * sgdPerUsd * 100) / 100,
          markup_pct:      xau.markup_pct,
          usd_sgd:         Math.round(sgdPerUsd * 10000) / 10000,
          usd_krw:         Math.round(krwPerUsd * 100) / 100,
          updated_at:      new Date(xau.fetched_at).toISOString(),
          stale:           xau.stale || false,
        },
      };
    }

    // LTV calculation if applicable
    let ltvSection = null;
    if (wire.amount_usd && goldSection) {
      const creditOutstanding = lead.credit_outstanding_usd || 0;
      if (creditOutstanding > 0) {
        const ltv = (creditOutstanding / goldSection.value_usd) * 100;
        ltvSection = {
          ltv_pct:            Math.round(ltv * 100) / 100,
          credit_outstanding: creditOutstanding,
          ceiling:            75,
          alert_threshold:    70,
          margin_call:        80,
          status:             ltv >= 80 ? 'margin_call' : ltv >= 75 ? 'breach' : ltv >= 70 ? 'alert' : 'ok',
        };
      }
    }

    // Messages
    const messages = (lead.messages || []).slice().sort(
      (a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()
    );
    const unreadCount = messages.filter((m) => !m.read_at).length;

    // Docs categorisation
    const docs = {
      membership: [],
      fund:       [],
      reporting:  [],
    };
    if (lead.status === 'funded') {
      docs.membership.push({ id: 'certificate', label: 'Membership Certificate', url: '/api/doc?id=certificate' });
    }
    if (lead.nda_state === 'approved') {
      docs.fund.push(
        { id: 'package',    label: 'Onboarding Package',  url: '/api/doc?id=package' },
        { id: 'structural', label: 'Structural Memo',     url: '/api/doc?id=structural' },
      );
    }
    if ((STATUS_RANK[lead.status] || 0) >= STATUS_RANK['accessed']) {
      docs.fund.push(
        { id: 'faq',          label: 'Member FAQ',   url: '/api/doc?id=faq' },
        { id: 'nda-template', label: 'NDA Template', url: '/api/doc?id=nda-template' },
      );
    }

    res.setHeader('Cache-Control', 'no-store');
    return ok(res, {
      ok: true,
      stage: 'funded',
      member: {
        name:          lead.name          || null,
        email:         lead.email         || null,
        member_number: lead.member_number || null,
        status:        lead.status        || 'inquiry',
        joined_at:     lead.funded_at     || lead.created_at || null,
      },
      gold:                goldSection,
      ltv:                 ltvSection,
      fund_status:         'pre_close',
      nda_state:           lead.nda_state     || 'awaiting',
      subscription_status: lead.status        || 'inquiry',
      bars:                lead.bars          || [],
      positions:           lead.positions     || [],
      capital_calls:       lead.capital_calls || [],
      docs,
      messages: {
        items:        messages,
        unread_count: unreadCount,
      },
      audit:       (lead.audit || []).slice(-50),
      next_action: resolveNextAction(lead),
      vault_mode:  getVaultMode(),
    });
  } catch (e) {
    console.error('[portfolio]', e && e.message, e && e.stack);
    return serverError(res, e);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  // Admin preview mode: ?preview_lead=ID — admin session required
  const previewLeadId = String(getQuery(req).preview_lead || '').trim();
  if (previewLeadId) {
    const adminToken   = getCookie(req, COOKIE_ADMIN);
    const adminSession = await verifyToken(adminToken);
    if (!adminSession || adminSession.sub !== 'admin') return unauthorized(res);
    const previewLead = await getLead(previewLeadId);
    if (!previewLead) return notFound(res);
    return buildPortfolioResponse(res, previewLead);
  }

  // Normal member auth
  const token   = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (!session || !session.leadId) return unauthorized(res);

  const lead = await getLead(session.leadId);
  if (!lead) return unauthorized(res);

  return buildPortfolioResponse(res, lead);
}
