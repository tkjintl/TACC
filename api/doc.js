// api/doc.js — Gated page + document server.
// GET /api/doc?id=[page-id|doc-id]
// Serves HTML pages and PDFs after auth gate checks.
// Injects window.__AURUM__ context into HTML pages.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  unauthorized, notFound, serverError, methodNotAllowed, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER, COOKIE_ADMIN } from './_lib/auth.js';
import { getLead } from './_lib/storage.js';
import { getBlob } from './_lib/blob.js';
import { watermarkPdf } from './_lib/watermark.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Status ordering ───────────────────────────────────────────────────────────

const STATUS_RANK = {
  inquiry:    0,
  invited:    1,
  accessed:   2,
  subscribed: 3,
  funded:     4,
};

function rank(status) {
  return STATUS_RANK[status] ?? 0;
}

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getSession(req) {
  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (!session || !session.leadId) return null;
  const lead = await getLead(session.leadId);
  if (!lead) return null;
  return lead;
}

// Admin preview: if the request has an aurum_admin cookie, allow access.
// With ?preview_lead=ID it loads that specific lead (so "View as Member" works).
// Without preview_lead, returns a synthetic full-access lead so admin can browse
// any portal page without being caught in the member-auth redirect loop.
async function getAdminPreview(req) {
  const token = getCookie(req, COOKIE_ADMIN);
  if (!token) return null;
  const session = await verifyToken(token);
  if (!session || session.sub !== 'admin') return null;
  const previewId = String(getQuery(req).preview_lead || '').trim();
  if (previewId) {
    const lead = await getLead(previewId);
    if (!lead) return null;
    lead._adminPreview = { actor: session.email || 'admin' };
    return lead;
  }
  // No preview_lead — return a synthetic funded lead so admin can navigate
  // all portal pages without hitting the member-auth redirect loop.
  return {
    id:            '_admin_browse',
    name:          session.email || 'Admin',
    email:         session.email || 'admin',
    member_number: null,
    status:        'funded',
    nda_state:     'approved',
    _adminPreview: { actor: session.email || 'admin' },
  };
}

function authFail(res, req) {
  // For HTML page requests (browser navigation), 302 to /login so the visitor
  // lands on the login page instead of seeing JSON. For API/fetch callers
  // that explicitly request JSON, keep the legacy 401 + JSON shape.
  const accept = (req && req.headers && req.headers.accept) || '';
  const wantsJson = accept.includes('application/json') && !accept.includes('text/html');
  if (!wantsJson) {
    res.statusCode = 302;
    res.setHeader('Location', '/login');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok: false, redirect: '/login' }));
}

// ── Page gate table ───────────────────────────────────────────────────────────

const PAGE_GATES = {
  'program-page':      { file: 'main.html',         gate: (l) => rank(l.status) >= rank('accessed') },
  'nda-page':          { file: 'nda.html',           gate: (l) => rank(l.status) >= rank('accessed') },
  'memo-page':         { file: 'memo.html',          gate: (l) => l.nda_state === 'approved' },
  'subscription-page': { file: 'subscription.html',  gate: (l) => l.nda_state === 'approved' },
  'portfolio-page':    { file: 'portfolio.html',     gate: (l) => l.status === 'funded' },
  'documents-page':    { file: 'documents.html',     gate: (l) => rank(l.status) >= rank('subscribed') },
  'messages-page':     { file: 'messages.html',      gate: (l) => rank(l.status) >= rank('accessed') },
  'deals-page':        { file: 'deals.html',         gate: (l) => l.status === 'funded' },
  'ioi-page':          { file: 'ioi.html',           gate: (l) => l.nda_state === 'approved' },
};

// ── Document gate table ───────────────────────────────────────────────────────

const DOC_GATES = {
  'package': {
    file:      '_docs/TACC_Onboarding_May_2026.pdf',
    gate:      (l) => l.nda_state === 'approved',
    watermark: true,
    name:      'TACC_Onboarding_Package.pdf',
  },
  'structural': {
    file:      '_docs/TACC_Structural_Memo.pdf',
    gate:      (l) => l.nda_state === 'approved',
    watermark: true,
    name:      'TACC_Structural_Memo.pdf',
  },
  'faq': {
    file:      '_docs/TACC_Member_FAQ.pdf',
    gate:      (l) => rank(l.status) >= rank('accessed'),
    watermark: false,
    name:      'TACC_Member_FAQ.pdf',
  },
  'nda-template': {
    file:      '_docs/nda-template.pdf',
    gate:      (l) => rank(l.status) >= rank('accessed'),
    watermark: false,
    name:      'TACC_NDA_Template.pdf',
  },
  'certificate': {
    blobPath:  (l) => `certificates/${l.id}.pdf`,
    gate:      (l) => l.status === 'funded',
    watermark: false,
    name:      'TACC_Membership_Certificate.pdf',
  },
};

// ── window.__AURUM__ injection ────────────────────────────────────────────────

function buildAurumContext(lead) {
  return {
    member: {
      name:          lead.name          || null,
      email:         lead.email         || null,
      member_number: lead.member_number || null,
      status:        lead.status        || 'inquiry',
    },
    nda_state: lead.nda_state || 'awaiting',
    preview: lead._adminPreview ? { actor: lead._adminPreview.actor || 'admin' } : null,
    meta: {
      served_at: Date.now(),
    },
  };
}

function injectContext(html, lead) {
  const context  = buildAurumContext(lead);
  const scriptTag = `<script>\nwindow.__AURUM__ = ${JSON.stringify(context)};\n</script>`;

  // Inject after <body ...> opening tag
  let injected = html.replace(/<body([^>]*)>/, (match) => {
    return match + '\n' + scriptTag;
  });

  // For nda.html: also inject data-nda-state on <body>
  injected = injected.replace(/<body([^>]*)>/, (match, attrs) => {
    if (attrs.includes('data-nda-state')) return match;
    return `<body${attrs} data-nda-state="${lead.nda_state || 'awaiting'}">`;
  });

  return injected;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const q = getQuery(req);

  // Signed-blob op: short-lived JWT-protected access to private blobs.
  // Query: ?op=signed-blob&token=<JWT>
  if (q.op === 'signed-blob') {
    return handleSignedBlob(req, res, q);
  }

  const { id } = q;
  if (!id) return authFail(res, req);

  // Try admin preview first (admin cookie + ?preview_lead=ID), then member session.
  let lead = await getAdminPreview(req);
  if (!lead) lead = await getSession(req);
  if (!lead) return authFail(res, req);

  // Check page gates first
  if (PAGE_GATES[id]) {
    return handlePage(req, res, id, lead);
  }

  // Then document gates
  if (DOC_GATES[id]) {
    return handleDocument(req, res, id, lead);
  }

  // Dynamic: quarterly-letter-{letterId}
  if (id.startsWith('quarterly-letter-')) {
    return handleQuarterlyLetter(req, res, id, lead);
  }

  // Dynamic: vault-verification-{vvId}
  if (id.startsWith('vault-verification-')) {
    return handleVaultVerification(req, res, id, lead);
  }

  return notFound(res);
}

// ── Page handler ──────────────────────────────────────────────────────────────

async function handlePage(req, res, id, lead) {
  const gate = PAGE_GATES[id];

  // Admin preview bypasses per-stage gates — operator can preview any page.
  if (!lead._adminPreview && !gate.gate(lead)) {
    return authFail(res, req);
  }

  const filePath = join(__dirname, '..', '_pages', gate.file);
  let html;
  try {
    html = await readFile(filePath, 'utf8');
  } catch {
    // Page file not yet created — return a minimal scaffold with context injected
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aurum Century Club</title></head><body></body></html>`;
  }

  const injected = injectContext(html, lead);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(injected);
}

// ── Document handler ──────────────────────────────────────────────────────────

async function handleDocument(req, res, id, lead) {
  const gate = DOC_GATES[id];

  if (!gate.gate(lead)) {
    return authFail(res, req);
  }

  let pdfBuffer;

  if (gate.blobPath) {
    // Served from Blob (e.g. certificate)
    const pathname = gate.blobPath(lead);
    try {
      pdfBuffer = await getBlob(pathname);
    } catch {
      return notFound(res);
    }
  } else {
    // Served from _docs/ filesystem
    const filePath = join(__dirname, '..', gate.file);
    try {
      pdfBuffer = await readFile(filePath);
    } catch {
      return notFound(res);
    }
  }

  // Apply watermark if required
  if (gate.watermark) {
    const memberNum = lead.member_number || '—';
    const dateStr   = new Date().toISOString().slice(0, 10);
    try {
      pdfBuffer = await watermarkPdf(pdfBuffer, lead.name || lead.email || 'Member', memberNum, dateStr);
    } catch (e) {
      console.warn(`[doc/${id}] watermark failed, serving clean copy:`, e && e.message);
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${gate.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(pdfBuffer);
}

// ── Quarterly letter handler ───────────────────────────────────────────────────

async function handleQuarterlyLetter(req, res, id, lead) {
  // Only funded members can read letters
  if (lead.status !== 'funded') return authFail(res, req);

  const letterId = id.replace(/^quarterly-letter-/, '');
  const letters  = lead.quarterly_letters || [];
  const letter   = letters.find((l) => l.id === letterId);

  if (!letter) return notFound(res);

  // Mark as read (fire-and-forget — do not block response)
  if (!letter.read_at) {
    import('./_lib/storage.js')
      .then(({ markLetterRead }) => markLetterRead(lead.id, letterId))
      .catch((e) => console.warn('[doc/quarterly-letter] markLetterRead failed:', e && e.message));
  }

  // Render the html_body wrapped in a minimal branded shell
  const memberNum = lead.member_number ? String(lead.member_number).padStart(3, '0') : null;
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(letter.subject || `Q${letter.quarter} ${letter.year} Fund Update`)} — Aurum Century Club</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e8e3d8; font-family: Georgia, serif; }
    .shell { max-width: 760px; margin: 0 auto; padding: 48px 28px 80px; }
    .kicker { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; letter-spacing: .34em; color: #C5A572; margin-bottom: 10px; }
    .subject { font-size: 28px; font-weight: 500; color: #e8e3d8; line-height: 1.25; margin-bottom: 8px; }
    .meta { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 9px; letter-spacing: .28em; color: #4a4540; margin-bottom: 36px; }
    .rule { border: none; border-top: 1px solid #1a1815; margin-bottom: 36px; }
    .body { font-size: 16px; line-height: 1.8; color: #b0a99e; }
    .body p { margin-bottom: 1.2em; }
    .body h2 { font-size: 18px; color: #e8e3d8; margin: 1.6em 0 .6em; }
    .footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid #1a1815; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 8.5px; letter-spacing: .24em; color: #3a3530; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="kicker">Q${letter.quarter} ${letter.year} · FUND UPDATE</div>
    <div class="subject">${escHtml(letter.subject || `Q${letter.quarter} ${letter.year} Fund Update`)}</div>
    <div class="meta">${new Date(letter.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}${memberNum ? ' · MEMBER #' + memberNum : ''}</div>
    <hr class="rule">
    <div class="body">${letter.html_body}</div>
    <div class="footer">AURUM CENTURY CLUB · TACC PTE LTD · SINGAPORE · CONFIDENTIAL</div>
  </div>
</body>
</html>`;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(html);
}

// ── Vault verification handler ────────────────────────────────────────────────

async function handleVaultVerification(req, res, id, lead) {
  // Only funded members can access vault verifications
  if (lead.status !== 'funded') return authFail(res, req);

  const vvId = id.replace(/^vault-verification-/, '');
  const vvs  = lead.vault_verifications || [];
  const vv   = vvs.find((v) => v.id === vvId);

  if (!vv) return notFound(res);

  // If a blob_pathname is set, serve the PDF from Blob (with watermark)
  if (vv.blob_pathname) {
    let pdfBuffer;
    try {
      pdfBuffer = await getBlob(vv.blob_pathname);
    } catch {
      return notFound(res);
    }

    // Attempt watermark with member identity
    const { watermarkPdf } = await import('./_lib/watermark.js').catch(() => ({ watermarkPdf: null }));
    if (watermarkPdf) {
      const memberNum = lead.member_number || '—';
      const dateStr   = new Date().toISOString().slice(0, 10);
      try {
        pdfBuffer = await watermarkPdf(pdfBuffer, lead.name || lead.email || 'Member', memberNum, dateStr);
      } catch (e) {
        console.warn('[doc/vault-verification] watermark failed, serving clean copy:', e && e.message);
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="TACC_VaultVerification_${vv.year}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdfBuffer);
    return;
  }

  // No blob — render a summary HTML page
  const memberNum = lead.member_number ? String(lead.member_number).padStart(3, '0') : null;
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escHtml(vv.title || `Vault Verification ${vv.year}`)} — Aurum Century Club</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e8e3d8; font-family: Georgia, serif; }
    .shell { max-width: 760px; margin: 0 auto; padding: 48px 28px 80px; }
    .kicker { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 10px; letter-spacing: .34em; color: #C5A572; margin-bottom: 10px; }
    .title { font-size: 28px; font-weight: 500; color: #e8e3d8; line-height: 1.25; margin-bottom: 8px; }
    .meta { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 9px; letter-spacing: .28em; color: #4a4540; margin-bottom: 36px; }
    .rule { border: none; border-top: 1px solid #1a1815; margin-bottom: 36px; }
    .summary { font-size: 16px; line-height: 1.8; color: #b0a99e; }
    .footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid #1a1815; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 8.5px; letter-spacing: .24em; color: #3a3530; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="kicker">VAULT VERIFICATION · ${escHtml(String(vv.year))}</div>
    <div class="title">${escHtml(vv.title || `Vault Verification ${vv.year}`)}</div>
    <div class="meta">${new Date(vv.published_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}${memberNum ? ' · MEMBER #' + memberNum : ''}</div>
    <hr class="rule">
    ${vv.summary ? `<div class="summary">${escHtml(vv.summary)}</div>` : '<div class="summary" style="color:#4a4540;font-style:italic">No summary available. Please contact the fund administrator.</div>'}
    <div class="footer">AURUM CENTURY CLUB · TACC PTE LTD · SINGAPORE · CONFIDENTIAL</div>
  </div>
</body>
</html>`;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(html);
}

// ── Signed-blob handler ──────────────────────────────────────────────────────
// Verifies a short-lived JWT (from _lib/signed-url.js) and proxies the blob.
// No cookie auth required — possession of the unexpired token is the auth.

async function handleSignedBlob(req, res, q) {
  const token = String(q.token || '').trim();
  if (!token) return notFound(res);

  let claims;
  try {
    const { verifySignedBlobToken } = await import('./_lib/signed-url.js');
    claims = await verifySignedBlobToken(token);
  } catch (e) {
    console.warn('[doc/signed-blob] verify failed:', e && e.message);
  }
  if (!claims || !claims.pathname) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ ok: false, error: 'invalid or expired token', code: 'EXPIRED_TOKEN' }));
  }

  // Pathname allowlist — only blobs under known prefixes can be served.
  const allowed = [
    /^certificates\//,
    /^tax-statements\//,
    /^vault\//,
    /^data-export\//,
  ];
  if (!allowed.some((r) => r.test(claims.pathname))) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ ok: false, error: 'pathname not allowed', code: 'FORBIDDEN_PATHNAME' }));
  }

  let buf;
  try {
    buf = await getBlob(claims.pathname);
  } catch (e) {
    console.warn('[doc/signed-blob] getBlob failed:', e && e.message);
    return notFound(res);
  }

  // Filename for browser save dialog
  const base = claims.pathname.split('/').pop() || 'document.pdf';
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${base}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(buf);
}

// ── HTML escape helper (for doc.js templates) ─────────────────────────────────

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
