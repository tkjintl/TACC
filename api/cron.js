// api/cron.js — Vercel cron entry point.
// Vercel injects Authorization: Bearer ${CRON_SECRET} on scheduled invocations.
// We accept the request if either:
//   - CRON_SECRET is unset (dev), OR
//   - the header matches.
// Routes by ?job= query.

import { ok, bad, unauthorized, getQuery } from './_lib/http.js';
import { scanForExceptions } from './_lib/exceptions.js';
import {
  listLeads,
  addMessage,
  globalAuditAppend,
  recountStages,
} from './_lib/storage.js';

const DAY = 86400 * 1000;

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.authorization || req.headers.Authorization || '';
  return header === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (!authorized(req)) return unauthorized(res);
  const job = String(getQuery(req).job || '').trim();

  try {
    switch (job) {
      case 'bot-daily-burst': {
        // Overnight insurance — if auto mode is on but no browser open, run a
        // small batch of auto-ticks once per day. Costs ~150-200 Upstash cmds total.
        const { getBotState, runAutoTick } = await import('./_lib/bot.js');
        const state = await getBotState();
        if (!state.auto_mode || state.auto_mode === 'off' || state.paused) {
          return ok(res, { ok: true, job, skipped: 'auto mode off or paused' });
        }
        const N = 25;
        const results = [];
        for (let i = 0; i < N; i++) {
          const r = await runAutoTick({ email: 'cron@bot' });
          results.push(r);
        }
        return ok(res, { ok: true, job, ran: N, results });
      }

      case 'scan-exceptions': {
        const r = await scanForExceptions();
        await globalAuditAppend({
          actor: 'cron', action: 'scan_exceptions',
          target_type: 'system', target_id: 'exceptions',
          target_name: 'Compliance scan',
          next: r,
        });
        return ok(res, { ok: true, job, ...r });
      }

      case 'capital-call-reminders': {
        const now = Date.now();
        const leads = await listLeads({ status: 'funded', limit: 500 });
        let reminded = 0;
        for (const lead of leads) {
          if (lead.deleted_at) continue;
          for (const c of (lead.capital_calls || [])) {
            if (c.status === 'paid' || c.acknowledged_at) continue;
            const due = c.due_date ? new Date(c.due_date).getTime() : null;
            if (!due) continue;
            const daysToDue = Math.floor((due - now) / DAY);
            // Remind 7d before, 1d before, and on overdue (every 3d)
            const send = daysToDue === 7 || daysToDue === 1 ||
                         (daysToDue < 0 && Math.abs(daysToDue) % 3 === 0);
            if (!send) continue;
            try {
              await addMessage(lead.id, {
                id: `cc_remind_${c.id}_${now}`,
                type: 'amber',
                subject: `Reminder: Capital Call ${c.ref}`,
                body: daysToDue >= 0
                  ? `Capital call ${c.ref} is due in ${daysToDue} day(s).`
                  : `Capital call ${c.ref} is overdue by ${Math.abs(daysToDue)} day(s).`,
                sent_at: new Date(now).toISOString(),
                read_at: null,
                sender:  'system',
              });
              reminded++;
            } catch (e) {
              console.warn('[cron/cc-reminders]', lead.id, e && e.message);
            }
          }
        }
        await globalAuditAppend({
          actor: 'cron', action: 'capital_call_reminders',
          target_type: 'system', target_id: 'capital_calls',
          target_name: 'Capital call reminders',
          next: { reminded },
        });
        return ok(res, { ok: true, job, reminded });
      }

      case 'stale-data-audit': {
        // Recount stage counters and emit a heartbeat audit.
        const counts = await recountStages();
        await globalAuditAppend({
          actor: 'cron', action: 'stale_data_audit',
          target_type: 'system', target_id: 'counters',
          target_name: 'Counter recount',
          next: counts,
        });
        return ok(res, { ok: true, job, counts });
      }

      default:
        return bad(res, `unknown cron job: ${job || '(none)'}`);
    }
  } catch (e) {
    console.error('[cron]', job, e && e.stack);
    return bad(res, `cron job '${job}' failed: ${e.message}`, 500);
  }
}
