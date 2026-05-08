// api/messages.js — Member message inbox.
// GET  /api/messages          — list messages, mark all as read
// POST /api/messages?op=read  — mark specific message as read

import {
  ok, bad, unauthorized, serverError, methodNotAllowed, getCookie, getQuery, readBody,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER, COOKIE_ADMIN } from './_lib/auth.js';
import { getLead, saveLead, markMessageRead } from './_lib/storage.js';

async function requireMember(req) {
  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (session && session.leadId) {
    const lead = await getLead(session.leadId);
    if (lead) return lead;
  }
  // Admin preview fallback
  const adminToken = getCookie(req, COOKIE_ADMIN);
  const adminSession = await verifyToken(adminToken);
  if (adminSession && adminSession.sub === 'admin') {
    const previewId = String(getQuery(req).preview_lead || '').trim();
    if (previewId) {
      const lead = await getLead(previewId);
      if (lead) return lead;
    }
    return { id: '_admin_browse', messages: [], _adminPreview: true };
  }
  return null;
}

export default async function handler(req, res) {
  const { op } = getQuery(req);

  if (req.method === 'GET' && !op) return handleInbox(req, res);
  if (req.method === 'POST' && op === 'read') return handleMarkRead(req, res);

  return methodNotAllowed(res);
}

// ── GET /api/messages — inbox ─────────────────────────────────────────────────

async function handleInbox(req, res) {
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  const messages = (lead.messages || []).slice().sort((a, b) => {
    return new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime();
  });

  // Mark all unread messages as read on first fetch
  let mutated = false;
  const now = new Date().toISOString();
  for (const msg of lead.messages || []) {
    if (!msg.read_at) {
      msg.read_at = now;
      mutated = true;
    }
  }
  if (mutated) {
    try { await saveLead(lead); } catch (e) {
      console.warn('[messages] auto-read saveLead failed:', e && e.message);
    }
  }

  const unreadCount = messages.filter((m) => !m.read_at).length;

  return ok(res, {
    ok:           true,
    items:        messages,
    unread_count: unreadCount,
  });
}

// ── POST /api/messages?op=read — mark one message as read ────────────────────

async function handleMarkRead(req, res) {
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  let body;
  try { body = await readBody(req); }
  catch { return bad(res, 'invalid body'); }

  const messageId = String(body.message_id || '').trim();
  if (!messageId) return bad(res, 'message_id required');

  try {
    await markMessageRead(lead.id, messageId);
  } catch (e) {
    if (e.message && e.message.includes('not found')) return bad(res, e.message, 404);
    return serverError(res, e);
  }

  return ok(res, { ok: true });
}
