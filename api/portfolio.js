// api/portfolio.js — Member portfolio aggregation.
// GET /api/portfolio              — requires aurum_access cookie.
// GET /api/portfolio?preview_lead=ID — requires aurum_admin cookie (admin preview mode).
// Returns full member financial view for funded members, or LIMBO state for earlier stages.

import {
  ok, unauthorized, notFound, serverError, methodNotAllowed, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER, COOKIE_ADMIN } from './_lib/auth.js';
import { getLead, listLeads } from './_lib/storage.js';
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
    // Wire status string for renderer:
    //   awaiting  — no receipt yet
    //   received  — operator marked received but not cleared
    //   processing — cleared / in flight to gold purchase
    let wireStatus = 'awaiting';
    if (wire.cleared_at)       wireStatus = 'processing';
    else if (wire.received_at) wireStatus = 'received';

    const subKg     = lead.subscription ? lead.subscription.kg_requested : null;
    const subSubmit = lead.subscription ? (lead.subscription.submitted_at || null) : null;
    // Subscription amount: prefer wire amount on file (already calculated by ops),
    // else best-effort estimate at $108k/kg LBMA reference (placeholder; UI shows '—' if 0).
    const subUsd    = wire.amount_usd || (subKg ? subKg * 108000 : null);

    const flatWire = wire.reference ? {
      reference:   wire.reference,
      issued_at:   wire.instructions_sent_at || null,
      received_at: wire.received_at          || null,
      cleared_at:  wire.cleared_at           || null,
    } : null;

    return ok(res, {
      ok:           true,
      stage,
      // Nested (canonical, new code paths)
      member: {
        name:          lead.name          || null,
        email:         lead.email         || null,
        member_number: lead.member_number || null,
      },
      nda_state: lead.nda_state || 'awaiting',
      wire: flatWire,
      subscription: lead.subscription ? {
        kg_requested: subKg,
        submitted_at: subSubmit,
      } : null,
      next_action:       resolveNextAction(lead),
      vault_mode:        getVaultMode(),
      cash_reserve_pct:  20,
      cash_deployed_pct: 0,

      // Flat (legacy renderer compatibility — _pages/portfolio.html)
      full_name:               lead.name || null,
      kilos:                   subKg || null,
      subscription_amount_usd: subUsd,
      subscription_date:       subSubmit,
      wire_status:             wireStatus,
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

    if (kg && xau && krwPerUsd) {
      // Use member-facing (marked-up) price_usd_per_kg for current NAV
      const valueUsd  = kg * xau.price_usd_per_kg;
      const valueSgd  = sgdPerUsd ? valueUsd * sgdPerUsd : null;
      const valueKrw  = valueUsd * krwPerUsd;

      // Entry price: wire amount, 80% allocated to gold, divided by kg
      const wirePaid  = wire.amount_usd;
      const entryUsd  = wirePaid ? (wirePaid * 0.80) / kg : null;
      const entrySgd  = (entryUsd && sgdPerUsd) ? entryUsd * sgdPerUsd : null;
      const changePct = entryUsd ? ((valueUsd - entryUsd) / entryUsd) * 100 : null;

      goldSection = {
        kg,
        value_usd:       Math.round(valueUsd),
        value_sgd:       valueSgd ? Math.round(valueSgd) : null,
        value_krw:       Math.round(valueKrw),
        entry_price_usd: entryUsd ? Math.round(entryUsd) : null,
        entry_price_sgd: entrySgd ? Math.round(entrySgd) : null,
        entry_value_usd: entryUsd ? Math.round(entryUsd * kg) : null,
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

    // LTV section — always shown for funded members with a gold position.
    // approved_pct: admin sets this at wire-issue (lead.ltv_approved_pct); structural minimum is 50%.
    let ltvSection = null;
    if (goldSection) {
      const creditOutstanding  = lead.credit_outstanding_usd || 0;
      const approvedPct        = lead.ltv_approved_pct || 50;
      const creditCeilingUsd   = Math.round((approvedPct / 100) * goldSection.value_usd);
      const ltv                = creditOutstanding > 0 ? (creditOutstanding / goldSection.value_usd) * 100 : 0;
      ltvSection = {
        ltv_pct:            Math.round(ltv * 100) / 100,
        credit_outstanding: creditOutstanding,
        credit_ceiling_usd: creditCeilingUsd,
        approved_pct:       approvedPct,
        ceiling:            0.75,   // fraction — portal bar: barFrac / ceiling
        alert_threshold:    70,
        margin_call:        80,
        status:             ltv >= 80 ? 'margin_call' : ltv >= 75 ? 'breach' : ltv >= 70 ? 'alert' : ltv > 0 ? 'ok' : 'undrawn',
      };
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

    // ── Founding cohort count for seat-grid (renderer reads `founding_count`).
    let foundingCount = 0;
    try {
      const fundedAll = await listLeads({ status: 'funded', limit: 200 });
      foundingCount = (fundedAll || []).length;
    } catch (e) {
      console.warn('[portfolio] listLeads(funded) failed:', e && e.message);
    }

    // ── Bar registry for renderer: first bar shown as the canonical entry.
    //    Renderer expects { serial, assayer, weight, fineness } keys.
    const firstBar = (lead.bars && lead.bars[0]) || null;
    const flatBar = firstBar ? {
      serial:   firstBar.serial   || null,
      assayer:  firstBar.refiner  || firstBar.assayer || 'LBMA Approved Refiner',
      weight:   firstBar.weight_kg ? `${(firstBar.weight_kg * 1000).toFixed(2)}g fine gold` : '1000.00g fine gold',
      fineness: firstBar.fineness || '999.9',
    } : null;

    // ── Notices for renderer.
    //    The renderer's overview card builds the active-call card from
    //    `d.capital_calls` (and merges any `notices` of type=capital_call).
    //    To avoid duplicate rendering we keep capital calls out of `notices`
    //    here — `d.capital_calls` is the single source for that card.
    //    `notices` is reserved for general operator-issued banners.
    const generalNotices = (lead.notices || []);

    // ── Flat field projections for legacy renderer (_pages/portfolio.html).
    const subKg     = (lead.subscription && lead.subscription.kg_requested) || null;
    const kilos     = subKg || (lead.bars || []).reduce((s, b) => s + (Number(b.weight_kg) || 0), 0) || null;
    const fundedAtMs = typeof lead.funded_at === 'number'
      ? lead.funded_at
      : (lead.funded_at ? new Date(lead.funded_at).getTime() : null);
    const activeSince = fundedAtMs
      ? new Date(fundedAtMs).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
      : null;
    const nextActionObj = resolveNextAction(lead);
    const subUsd      = wire.amount_usd || (subKg ? subKg * 108000 : null);
    const entryPrice    = goldSection ? goldSection.entry_price_usd : null;
    const entryPriceSgd = goldSection ? goldSection.entry_price_sgd : null;
    const entryValue    = goldSection ? goldSection.entry_value_usd : null;
    const entryValueSgd = (entryPriceSgd && kilos) ? Math.round(entryPriceSgd * kilos) : null;

    res.setHeader('Cache-Control', 'no-store');
    return ok(res, {
      ok: true,
      stage: 'funded',
      // ── Nested (canonical, used by newer code paths) ─────────────────────
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
      messages:      messages,
      unread_count:  unreadCount,
      audit:       (lead.audit || []).slice(-50),
      // Full structured next-action (type/label/url) for new code paths.
      next_action_meta: nextActionObj,
      vault_mode:  getVaultMode(),

      // ── Flat fields — used directly by portal-v4-wired.html renderers ──────
      // Identity
      full_name:               lead.name          || null,
      name:                    lead.name          || null,
      email:                   lead.email         || null,
      member_number:           lead.member_number || null,
      tier:                    lead.tier          || 'Founding Member',
      active_since:            activeSince,
      member_since:            lead.funded_at     || lead.created_at || null,
      last_login:              lead.last_login_at || null,
      // Holdings — portal reads gold_kg, committed_usd, vault_location + vault details
      kilos:                   kilos,
      gold_kg:                 kilos,
      committed_usd:           wire.amount_usd    || subUsd || null,
      cost_basis_usd:          lead.cost_basis_usd || wire.amount_usd || null,
      liquidity_reserve_usd:   lead.liquidity_reserve_usd || null,
      vault_location:          lead.vault_location || 'Singapore Freeport',
      lot_ref:                 lead.lot_ref        || lead.lot_reference || null,
      custodian:               lead.custodian      || null,
      insurance:               lead.insurance      || null,
      purity:                  lead.purity         || null,
      bar_standard:            lead.bar_standard   || null,
      last_audit_date:         lead.last_audit_date || null,
      gold_purchases:          lead.gold_purchases  || [],
      current_value_usd:       goldSection ? goldSection.value_usd : null,
      current_value_sgd:       goldSection ? goldSection.value_sgd : null,
      current_value_krw:       goldSection ? goldSection.value_krw : null,
      entry_price_usd:         entryPrice,
      entry_price_sgd:         entryPriceSgd,
      entry_value_usd:         entryValue,
      entry_value_sgd:         entryValueSgd,
      // Subscription / wire
      subscription_amount_usd: subUsd,
      subscription_date:       (lead.subscription && lead.subscription.submitted_at) || null,
      wire_date:               wire.cleared_at || wire.received_at || null,
      wire_status:             wire.cleared_at ? 'processing' : wire.received_at ? 'received' : 'awaiting',
      // Activity feed — portal reads member.activity
      activity:                lead.activity      || [],
      // Cohort grid
      founding_count:          foundingCount,
      member_seat_index:       (typeof lead.member_number === 'number' && lead.member_number > 0)
                                 ? lead.member_number - 1
                                 : -1,
      // Fund metadata
      fund_period:             'Q3 2026',
      next_action:             nextActionObj ? nextActionObj.label : null,
      next_action_sub:         null,
      bar:                     flatBar,
      notices:                 generalNotices,
      cash_reserve_pct:        lead.cash_reserve_pct  !== undefined ? lead.cash_reserve_pct  : 20,
      cash_deployed_pct:       lead.cash_deployed_pct !== undefined ? lead.cash_deployed_pct : 0,
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
