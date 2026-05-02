// api/nda.js — NDA upload, status, approval, and template serving.
// All ops require aurum_access cookie.
// POST/GET /api/nda?op=template|upload|status|mine

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ok, bad, unauthorized, notFound, serverError, methodNotAllowed, getCookie, getQuery,
} from './_lib/http.js';
import { verifyToken, COOKIE_MEMBER } from './_lib/auth.js';
import { getLead, saveLead } from './_lib/storage.js';
import { putBlob, getBlob } from './_lib/blob.js';
import { watermarkPdf } from './_lib/watermark.js';
import { sendPartnerNotice } from './_lib/email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Auth helper ───────────────────────────────────────────────────────────────

async function requireMember(req) {
  const token = getCookie(req, COOKIE_MEMBER);
  const session = await verifyToken(token);
  if (!session || !session.leadId) return null;
  const lead = await getLead(session.leadId);
  if (!lead) return null;
  return lead;
}

// ── Multipart parser ──────────────────────────────────────────────────────────
// Pure Node boundary parser — no formidable dependency.
// Returns { files: [{ fieldname, filename, contentType, data: Buffer }], fields: {} }

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) throw new Error('No boundary in Content-Type');
  const boundary = boundaryMatch[1];

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 10 * 1024 * 1024; // 10 MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('upload too large (max 10 MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const boundaryBuf = Buffer.from(`--${boundary}`);
  const files  = [];
  const fields = {};

  // Split the raw body on boundary markers
  const parts = [];
  let start = 0;
  while (start < raw.length) {
    const idx = raw.indexOf(boundaryBuf, start);
    if (idx === -1) break;
    const end = idx;
    if (end > start) parts.push(raw.slice(start, end));
    start = idx + boundaryBuf.length;
    // Skip \r\n after boundary
    if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
    // Terminal boundary ends with --
    if (raw[start] === 0x2d && raw[start + 1] === 0x2d) break;
  }

  for (const part of parts) {
    if (!part.length) continue;
    // Find the blank line separating headers from body
    const sep = part.indexOf(Buffer.from('\r\n\r\n'));
    if (sep === -1) continue;
    const headerBlock = part.slice(0, sep).toString('utf8');
    // Body excludes the trailing \r\n before the next boundary
    let body = part.slice(sep + 4);
    if (body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.slice(0, body.length - 2);
    }

    // Parse headers
    const headers = {};
    for (const line of headerBlock.split('\r\n')) {
      const ci = line.indexOf(':');
      if (ci === -1) continue;
      headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }

    const disp = headers['content-disposition'] || '';
    const nameMatch     = disp.match(/name="([^"]+)"/);
    const filenameMatch = disp.match(/filename="([^"]+)"/);
    const fieldname = nameMatch ? nameMatch[1] : 'unknown';

    if (filenameMatch) {
      files.push({
        fieldname,
        filename:    filenameMatch[1],
        contentType: headers['content-type'] || 'application/octet-stream',
        data:        body,
      });
    } else {
      fields[fieldname] = body.toString('utf8');
    }
  }

  return { files, fields };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const { op } = getQuery(req);

  switch (op) {
    case 'template': return handleTemplate(req, res);
    case 'upload':   return handleUpload(req, res);
    case 'status':   return handleStatus(req, res);
    case 'mine':     return handleMine(req, res);
    default:         return bad(res, `unknown op: ${op || '(none)'}`);
  }
}

// ── op=template — serve NDA PDF template ─────────────────────────────────────

async function handleTemplate(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  // Try Blob first, fall back to _docs/
  let pdfBuffer;
  try {
    pdfBuffer = await getBlob('nda-template.pdf');
  } catch {
    try {
      pdfBuffer = await readFile(join(__dirname, '..', '_docs', 'nda-template.pdf'));
    } catch {
      return notFound(res);
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="TACC_NDA_Template.pdf"');
  res.setHeader('Cache-Control', 'no-store');
  res.end(pdfBuffer);
}

// ── op=upload — accept signed NDA ─────────────────────────────────────────────

async function handleUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  let parsed;
  try {
    parsed = await parseMultipart(req);
  } catch (e) {
    return bad(res, e.message || 'multipart parse error');
  }

  const file = parsed.files[0];
  if (!file) return bad(res, 'no file uploaded');

  // Validate MIME — accept PDF only
  const ct = (file.contentType || '').toLowerCase();
  if (!ct.includes('pdf') && !ct.includes('application/octet-stream')) {
    // Also check filename extension as fallback
    if (!file.filename.toLowerCase().endsWith('.pdf')) {
      return bad(res, 'only PDF files are accepted');
    }
  }

  if (file.data.length > 10 * 1024 * 1024) {
    return bad(res, 'file exceeds 10 MB limit');
  }

  // PDF magic bytes check: %PDF
  if (file.data[0] !== 0x25 || file.data[1] !== 0x50 || file.data[2] !== 0x44 || file.data[3] !== 0x46) {
    return bad(res, 'file does not appear to be a valid PDF');
  }

  const timestamp = Date.now();
  const pathname  = `ndas/${lead.id}/signed-${timestamp}.pdf`;

  let blobUrl;
  try {
    const result = await putBlob(pathname, file.data, 'application/pdf');
    blobUrl = result.url;
  } catch (e) {
    console.error('[nda/upload] putBlob failed:', e);
    return serverError(res, e);
  }

  const now = Date.now();
  lead.nda_state       = 'uploaded';
  lead.nda_file_url    = blobUrl;
  lead.nda_uploaded_at = now;
  lead.audit = lead.audit || [];
  lead.audit.push({ at: now, actor: lead.id, action: 'nda_uploaded', meta: { url: blobUrl } });

  try {
    await saveLead(lead);
  } catch (e) {
    console.error('[nda/upload] saveLead failed:', e);
    return serverError(res, e);
  }

  // Notify partners — extend sendPartnerNotice with a custom message approach.
  // The email.js sendPartnerNotice signature takes a lead and uses its fields.
  // We piggyback the notification by temporarily annotating the lead object.
  try {
    await sendPartnerNotice({
      ...lead,
      _notice: `NDA submitted by ${lead.name || lead.email}, ready for review.`,
    });
  } catch (e) {
    console.warn('[nda/upload] partner notice failed:', e && e.message);
  }

  return ok(res, { ok: true });
}

// ── op=status — NDA status for the authenticated member ───────────────────────

async function handleStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  return ok(res, {
    ok:              true,
    nda_state:       lead.nda_state    || 'awaiting',
    nda_uploaded_at: lead.nda_uploaded_at || null,
    nda_approved_at: lead.nda_approved_at || null,
  });
}

// ── op=mine — stream member's signed NDA (watermarked) ────────────────────────

async function handleMine(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const lead = await requireMember(req);
  if (!lead) return unauthorized(res);

  if (!lead.nda_state || lead.nda_state === 'awaiting') {
    return bad(res, 'NDA not yet submitted', 403);
  }

  if (!lead.nda_file_url) {
    return notFound(res);
  }

  let pdfBuffer;
  try {
    // Derive pathname from URL or use the known pattern
    const pathname = `ndas/${lead.id}/signed-${lead.nda_uploaded_at || ''}.pdf`;
    try {
      pdfBuffer = await getBlob(pathname);
    } catch {
      // If pathname doesn't match exactly (e.g. timestamp differs), fetch by URL
      const r = await fetch(lead.nda_file_url);
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      pdfBuffer = Buffer.from(await r.arrayBuffer());
    }
  } catch (e) {
    console.error('[nda/mine] getBlob error:', e);
    return serverError(res, e);
  }

  // Apply watermark
  const memberNum = lead.member_number || '—';
  const dateStr   = new Date().toISOString().slice(0, 10);
  try {
    pdfBuffer = await watermarkPdf(pdfBuffer, lead.name || lead.email, memberNum, dateStr);
  } catch (e) {
    console.warn('[nda/mine] watermark failed (serving unwatermarked):', e && e.message);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="TACC_NDA_Signed.pdf"');
  res.setHeader('Cache-Control', 'no-store');
  res.end(pdfBuffer);
}
