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
  setJSON,
} from './_lib/storage.js';
import { trimErrorsOlderThan } from './_lib/error-shape.js';
import { CRON_LAST_KEY } from './health.js';

const DAY = 86400 * 1000;

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[cron] CRON_SECRET not set in production — denying request');
      return false;
    }
    return true; // dev only
  }
  const header = req.headers.authorization || req.headers.Authorization || '';
  return header === `Bearer ${secret}`;
}

async function recordCronRun(job, payload) {
  try {
    await setJSON(CRON_LAST_KEY(job), { at: Date.now(), ...(payload || {}) });
  } catch (e) {
    console.warn('[cron] recordCronRun failed:', e && e.message);
  }
}

export default async function handler(req, res) {
  if (!authorized(req)) return unauthorized(res);
  const job = String(getQuery(req).job || '').trim();

  try {
    switch (job) {
      case 'scan-exceptions': {
        const r = await scanForExceptions();
        await globalAuditAppend({
          actor: 'cron', action: 'scan_exceptions',
          target_type: 'system', target_id: 'exceptions',
          target_name: 'Compliance scan',
          next: r,
        });
        await recordCronRun(job, { added: r.added, total: r.total });
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
        await recordCronRun(job, { reminded });
        return ok(res, { ok: true, job, reminded });
      }

      case 'stale-data-audit': {
        // Recount stage counters and emit a heartbeat audit.
        const counts = await recountStages();
        // Trim recent-errors set to 7d window so the sorted set doesn't grow unbounded
        const trimmed = await trimErrorsOlderThan(Date.now() - 7 * DAY);
        await globalAuditAppend({
          actor: 'cron', action: 'stale_data_audit',
          target_type: 'system', target_id: 'counters',
          target_name: 'Counter recount',
          next: { counts, errors_trimmed: trimmed },
        });
        await recordCronRun(job, { counts, errors_trimmed: trimmed });
        return ok(res, { ok: true, job, counts, errors_trimmed: trimmed });
      }

      default:
        return bad(res, `unknown cron job: ${job || '(none)'}`);
    }
  } catch (e) {
    console.error('[cron]', job, e && e.stack);
    return bad(res, `cron job '${job}' failed: ${e.message}`, 500);
  }
}
