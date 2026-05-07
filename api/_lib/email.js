// _lib/email.js — Resend-backed email delivery + HTML templates.
// If RESEND_API_KEY is absent, logs the email to console (graceful degradation).

const RESEND_URL = 'https://api.resend.com/emails';

function fromAddress() {
  return (
    process.env.RESEND_FROM_ADDRESS ||
    'Aurum Century Club <noreply@theaurumcc.com>'
  );
}

function siteUrl() {
  return process.env.SITE_URL || 'https://www.theaurumcc.com';
}

function partnerName() {
  return process.env.PARTNER_NAME || 'The Aurum Team';
}

function notifyEmails() {
  return (process.env.NOTIFY_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Preview mode (for bot email validation) ──────────────────────────────────
// When enabled, sendRaw captures the rendered payload instead of actually
// sending. Lets the live-bot harness verify email format/content without
// burning Resend quota.
export const _PREVIEW = { enabled: false, captured: null };

// ── Core send ─────────────────────────────────────────────────────────────────

export async function sendRaw({ to, subject, html, text, replyTo }) {
  if (_PREVIEW.enabled) {
    _PREVIEW.captured = { to, subject, html: html || '', text: text || '', replyTo: replyTo || null };
    return { sent: false, reason: 'preview-mode', captured: true };
  }
  if (process.env.BOT_MODE) {
    console.log('[aurum/email] BOT_MODE — suppressing send:', { to, subject });
    return { sent: false, reason: 'bot-mode' };
  }
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('[aurum/email] RESEND_API_KEY not set — would send:', { to, subject, text: text?.slice(0, 200) });
    return { sent: false, reason: 'no-api-key' };
  }

  const norm = (v) => {
    if (!v) return undefined;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const clean = arr.map((s) => String(s).trim()).filter(Boolean);
    return clean.length ? clean : undefined;
  };

  const toArr = norm(to);
  if (!toArr) return { sent: false, reason: 'no-recipient' };

  const body = {
    from: fromAddress(),
    to: toArr,
    subject,
    html,
    text,
  };
  if (replyTo) body.reply_to = replyTo;

  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.warn('[aurum/email] Resend error', r.status, detail);
      return { sent: false, reason: `resend-${r.status}`, detail };
    }
    const j = await r.json().catch(() => ({}));
    return { sent: true, id: j.id || null };
  } catch (e) {
    console.warn('[aurum/email] fetch error', e && e.message);
    return { sent: false, reason: 'fetch-error' };
  }
}

// ── HTML shell ────────────────────────────────────────────────────────────────
// Nested bgcolor tables so Outlook/Gmail cannot strip dark theme.

function shellHtml(inner, preheader) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body bgcolor="#0a0a0a" style="margin:0;padding:0;background:#0a0a0a;color:#e8e3d8;font-family:'Cormorant Garamond',Georgia,serif">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#0a0a0a">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="background:#0a0a0a;border-collapse:collapse">
  <tr><td align="center" bgcolor="#0a0a0a" style="background:#0a0a0a;padding:48px 16px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="background:#0a0a0a;max-width:600px;border-collapse:collapse">
  ${inner}
  </table></td></tr>
</table>
</body></html>`;
}

// Brand lockup row used at top of every email
const lockupRow = `<tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:32px 32px 0">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
    <td style="vertical-align:middle;padding-right:14px">
      <div style="border:1px solid #C5A572;width:38px;height:38px;text-align:center;line-height:38px;color:#C5A572;font-style:italic;font-family:Georgia,serif;font-size:18px;letter-spacing:-0.04em">Au</div>
    </td>
    <td style="vertical-align:middle">
      <div style="font-family:'Outfit',Arial,sans-serif;font-weight:600;font-size:14px;letter-spacing:0.34em;color:#ececec;line-height:1">AURUM</div>
      <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:8.5px;letter-spacing:0.36em;color:#8a7d6b;line-height:1;margin-top:6px">CENTURY · CLUB</div>
    </td>
  </tr></table>
</td></tr>`;

function signOffRow() {
  return `<tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:24px 32px 48px;border-top:1px solid rgba(255,255,255,0.08);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.30em;color:#6b655e">
  <div>— ${esc(partnerName()).toUpperCase()}</div>
  <div style="margin-top:6px">AURUM · TACC PTE LTD · SINGAPORE</div>
  <div style="margin-top:14px;color:#3a3733">CONFIDENTIAL · QUALIFIED INVESTORS ONLY</div>
  <div style="margin-top:10px;font-size:8.5px">If you did not request this, you may disregard this message.</div>
</td></tr>`;
}

function dividerRow() {
  return `<tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td height="1" bgcolor="#1a1815" style="background:#1a1815;line-height:1px;font-size:1px">&nbsp;</td>
  </tr></table>
</td></tr>`;
}

// ── HTML escape ───────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 1. Invitation email ───────────────────────────────────────────────────────

export async function sendInvitation(lead, code) {
  const accessUrl = `${siteUrl()}/code`;
  const subject   = 'Your Access Credential — The Aurum Century Club';

  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">INVITATION · 초대장</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:#e8e3d8">
    Dear <span style="font-style:italic;color:#C5A572">${esc(lead.name || 'Member')}.</span>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 18px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    Your introduction has been reviewed, and you have been extended an invitation to The Aurum Century Club — an invite-only vehicle for the physical acquisition and custody of institutional-grade gold, structured for a founding cohort of 100 members.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 26px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    The credential below opens the program. Read at your own pace, then proceed to the confidentiality agreement when ready.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
      <td bgcolor="#0a0a0a" align="center" style="background:#0a0a0a;border:1px solid rgba(197,165,114,0.50);padding:24px">
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.30em;color:#8a7d6b;margin-bottom:12px">YOUR ACCESS CREDENTIAL · 접근 코드</div>
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:32px;letter-spacing:.22em;color:#E3C187;font-weight:500">${esc(code)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" align="left" style="background:#0a0a0a;padding:0 32px 32px">
    <a href="${esc(accessUrl)}" style="display:inline-block;padding:14px 26px;background:#C5A572;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.30em;font-weight:600">ACTIVATE YOUR MEMBERSHIP →</a>
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Dear ${lead.name || 'Member'},`,
    ``,
    `Your introduction has been reviewed and you have been extended an invitation to The Aurum Century Club.`,
    ``,
    `Your Access Credential: ${code}`,
    ``,
    `Activate your membership: ${accessUrl}`,
    ``,
    `— ${partnerName()}`,
    `TACC Pte Ltd, Singapore`,
  ].join('\n');

  return sendRaw({ to: lead.email, subject, html: shellHtml(inner, 'Your access credential to The Aurum Century Club.'), text });
}

// ── 2. Inquiry acknowledgement ────────────────────────────────────────────────

export async function sendInquiryAck(lead) {
  const subject = 'Your enquiry has been received — The Aurum Century Club';
  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">RECEIVED · 접수 완료</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:#e8e3d8">
    Thank you${lead.name ? ', <span style="font-style:italic;color:#C5A572">' + esc(lead.name.split(' ')[0]) + '</span>' : ''}.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    Your enquiry has been received and will be reviewed within two business days. A member of the team will respond from a private address.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 24px;font-family:Georgia,serif;font-style:italic;font-size:14px;line-height:1.7;color:#8a7d6b">
    This message confirms receipt of your enquiry, made on your own initiative. The Aurum Century Club does not solicit publicly.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 32px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:.18em;color:#6b655e;line-height:1.8">
    Reference: <span style="color:#C5A572">${esc(lead.id)}</span>
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Your enquiry has been received and will be reviewed within two business days.`,
    ``,
    `Reference: ${lead.id}`,
    ``,
    `— ${partnerName()}`,
    `TACC Pte Ltd, Singapore`,
  ].join('\n');

  return sendRaw({
    to: lead.email,
    subject,
    html: shellHtml(inner, 'Your enquiry to The Aurum Century Club has been received.'),
    text,
  });
}

// ── 3. Partner notification ───────────────────────────────────────────────────

export async function sendPartnerNotice(lead) {
  const to = notifyEmails();
  if (!to.length) return { sent: false, reason: 'no-notify-emails' };

  const subject = `[AURUM] New inquiry · ${lead.name || 'Unnamed'} · ${lead.country || '—'}`;

  const rows = [
    lead.name       && `<tr><td style="padding:5px 12px 5px 0;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.28em;color:#8a7d6b;width:100px">NAME</td><td style="padding:5px 0;color:#e8e3d8;font-size:14px">${esc(lead.name)}</td></tr>`,
    lead.email      && `<tr><td style="padding:5px 12px 5px 0;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.28em;color:#8a7d6b">EMAIL</td><td style="padding:5px 0;color:#e8e3d8;font-size:14px">${esc(lead.email)}</td></tr>`,
    lead.country    && `<tr><td style="padding:5px 12px 5px 0;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.28em;color:#8a7d6b">COUNTRY</td><td style="padding:5px 0;color:#e8e3d8;font-size:14px">${esc(lead.country)}</td></tr>`,
    lead.wealth     && `<tr><td style="padding:5px 12px 5px 0;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.28em;color:#8a7d6b">WEALTH</td><td style="padding:5px 0;color:#e8e3d8;font-size:14px">${esc(lead.wealth)}</td></tr>`,
    lead.occupation && `<tr><td style="padding:5px 12px 5px 0;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.28em;color:#8a7d6b">OCCUPATION</td><td style="padding:5px 0;color:#e8e3d8;font-size:14px">${esc(lead.occupation)}</td></tr>`,
    lead.referral   && `<tr><td style="padding:5px 12px 5px 0;font-family:'JetBrains Mono',monospace;font-size:9.5px;letter-spacing:.28em;color:#8a7d6b">REFERRAL</td><td style="padding:5px 0;color:#e8e3d8;font-size:14px">${esc(lead.referral)}</td></tr>`,
  ].filter(Boolean).join('\n');

  const adminUrl = `${siteUrl()}/admin?lead=${encodeURIComponent(lead.id)}`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0a;color:#e8e3d8;font-family:Georgia,serif">
<div style="max-width:560px;margin:0 auto;padding:32px 28px">
  <div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.32em;color:#C5A572;margin-bottom:4px">NEW INQUIRY</div>
  <h1 style="font-family:Georgia,serif;font-weight:500;font-size:26px;color:#e8e3d8;margin:0 0 22px">${esc(lead.name || 'Unnamed')}</h1>
  <table cellpadding="0" cellspacing="0" style="width:100%">${rows}</table>
  <div style="margin-top:28px">
    <a href="${esc(adminUrl)}" style="display:inline-block;padding:13px 22px;background:#C5A572;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.28em">REVIEW IN DASHBOARD →</a>
  </div>
  <div style="margin-top:28px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);font-family:'JetBrains Mono',monospace;font-size:8.5px;letter-spacing:.28em;color:#6b655e">TACC PTE LTD · ${new Date().getUTCFullYear()} · ID: ${esc(lead.id)}</div>
</div></body></html>`;

  const text = [
    `New inquiry — ${lead.name || 'Unnamed'}`,
    `Email: ${lead.email || '—'}`,
    `Country: ${lead.country || '—'}`,
    `Wealth: ${lead.wealth || '—'}`,
    `Referral: ${lead.referral || '—'}`,
    ``,
    `Dashboard: ${adminUrl}`,
    `ID: ${lead.id}`,
  ].join('\n');

  return sendRaw({ to, subject, html, text });
}

// ── 4. Password reset ─────────────────────────────────────────────────────────

export async function sendPasswordReset(lead, code) {
  const subject = 'Password Reset — The Aurum Century Club';
  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">PASSWORD RESET · 비밀번호 재설정</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:#e8e3d8">
    Reset <span style="font-style:italic;color:#C5A572">code.</span>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    Enter this 6-digit code on the reset page. It expires in 15 minutes and works once.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 30px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
      <td bgcolor="#0a0a0a" align="center" style="background:#0a0a0a;border:1px solid rgba(197,165,114,0.50);padding:24px">
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.30em;color:#8a7d6b;margin-bottom:12px">RESET CODE · 인증 코드</div>
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:32px;letter-spacing:.32em;color:#E3C187;font-weight:500">${esc(code)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 30px;font-family:Georgia,serif;font-style:italic;font-size:13px;line-height:1.7;color:#6b655e">
    If you did not request this, ignore this email — your password is unchanged.
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Password reset code: ${code}`,
    ``,
    `This code expires in 15 minutes. Enter it on the reset page.`,
    ``,
    `If you did not request this, ignore this email.`,
    ``,
    `— ${partnerName()}`,
  ].join('\n');

  return sendRaw({
    to: lead.email,
    subject,
    html: shellHtml(inner, 'Your AURUM password reset code.'),
    text,
  });
}

// ── 5. Wire instructions ──────────────────────────────────────────────────────

export async function sendWireInstructions(lead, wireDetails) {
  // Prefer the wire reference already stored on the lead/wireDetails so it
  // matches what the operator console + audit log shows. Fall back only if
  // none exists (legacy path).
  const ref = (wireDetails && wireDetails.reference)
    || (lead.wire && lead.wire.reference)
    || `${process.env.WIRE_REFERENCE_PREFIX || 'TACC'}-${lead.member_number || lead.id}`;
  const subject = 'Wire Instructions — The Aurum Century Club';

  const bank      = process.env.WIRE_BANK_NAME       || '[WIRE_BANK_NAME not set]';
  const acctName  = process.env.WIRE_ACCOUNT_NAME    || '[WIRE_ACCOUNT_NAME not set]';
  const acctNum   = process.env.WIRE_ACCOUNT_NUMBER  || '[WIRE_ACCOUNT_NUMBER not set]';
  const swift     = process.env.WIRE_SWIFT           || '[WIRE_SWIFT not set]';

  const wrow = (label, value) =>
    `<tr>
      <td style="padding:8px 14px 8px 0;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.26em;color:#8a7d6b;width:160px;vertical-align:top">${esc(label)}</td>
      <td style="padding:8px 0;font-family:Georgia,serif;font-size:14px;color:#e8e3d8;vertical-align:top">${esc(value)}</td>
    </tr>`;

  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">WIRE INSTRUCTIONS · 송금 안내</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:28px;line-height:1.2;color:#e8e3d8">
    Subscription <span style="font-style:italic;color:#C5A572">wire details.</span>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid rgba(197,165,114,0.30)">
      <tr><td style="padding:18px 22px">
        <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
          ${wrow('BENEFICIARY', acctName)}
          ${wrow('BANK', bank)}
          ${wrow('ACCOUNT', acctNum)}
          ${wrow('SWIFT', swift)}
          ${wrow('REFERENCE', ref + ' ← required on wire memo')}
          ${wireDetails && wireDetails.amount_usd ? wrow('AMOUNT', `USD ${Number(wireDetails.amount_usd).toLocaleString()}`) : ''}
        </table>
      </td></tr>
    </table>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-style:italic;font-size:14px;line-height:1.7;color:#8a7d6b">
    Include the reference above on the wire memo so we can match the receipt. 80% of the wire proceeds to gold procurement; 20% to the fund reserve per the subscription agreement.
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Wire instructions — The Aurum Century Club`,
    ``,
    `Beneficiary: ${acctName}`,
    `Bank: ${bank}`,
    `Account: ${acctNum}`,
    `SWIFT: ${swift}`,
    `Reference: ${ref}  ← required on wire memo`,
    wireDetails && wireDetails.amount_usd ? `Amount: USD ${Number(wireDetails.amount_usd).toLocaleString()}` : '',
    ``,
    `Include the reference on the wire memo. Reply to confirm receipt.`,
    ``,
    `— ${partnerName()}`,
    `TACC Pte Ltd, Singapore`,
  ].filter(Boolean).join('\n');

  return sendRaw({
    to: lead.email,
    subject,
    html: shellHtml(inner, 'Wire instructions for your Aurum Century Club subscription.'),
    text,
  });
}

// ── 6. Quarterly letter notification ─────────────────────────────────────────

export async function sendQuarterlyLetterNotification(lead, letter) {
  const portalUrl = `${siteUrl()}/portfolio`;
  const q = letter.quarter;
  const y = letter.year;
  const subject = `Fund Update Q${q} ${y} — The Aurum Century Club`;

  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">FUND UPDATE · 펀드 업데이트</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:#e8e3d8">
    Q${q} ${y} <span style="font-style:italic;color:#C5A572">quarterly letter.</span>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    Dear ${esc(lead.name || 'Member')}, your Q${q} ${y} fund update has been published to the member portal. It covers fund performance, gold allocation status, and key developments for the quarter.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 10px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid rgba(197,165,114,0.25)"><tr>
      <td style="padding:18px 22px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:.26em;color:#8a7d6b">
        <div style="font-size:8.5px;color:#6b655e;margin-bottom:6px">SUBJECT</div>
        <div style="color:#C5A572">${esc(letter.subject || `Q${q} ${y} Fund Update`)}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" align="left" style="background:#0a0a0a;padding:22px 32px 32px">
    <a href="${esc(portalUrl)}" style="display:inline-block;padding:14px 26px;background:#C5A572;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.30em;font-weight:600">READ IN PORTAL →</a>
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Dear ${lead.name || 'Member'},`,
    ``,
    `Your Q${q} ${y} fund update has been published to the member portal.`,
    ``,
    `Subject: ${letter.subject || `Q${q} ${y} Fund Update`}`,
    ``,
    `Read in portal: ${portalUrl}`,
    ``,
    `— ${partnerName()}`,
    `TACC Pte Ltd, Singapore`,
  ].join('\n');

  return sendRaw({
    to: lead.email,
    subject,
    html: shellHtml(inner, `Your Q${q} ${y} fund update is available in the portal.`),
    text,
  });
}

// ── 7. Vault verification notification ───────────────────────────────────────

export async function sendVaultVerificationNotification(lead, vv) {
  const portalUrl = `${siteUrl()}/portfolio`;
  const subject = `Vault Verification Report ${vv.year} — The Aurum Century Club`;

  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">VAULT VERIFICATION · 보관 검증</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:#e8e3d8">
    Independent vault <span style="font-style:italic;color:#C5A572">verification ${vv.year}.</span>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    Dear ${esc(lead.name || 'Member')}, an independent vault verification report has been completed and is now available in your member portal. This confirms the physical custody and integrity of your allocated gold at Singapore Freeport.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 10px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid rgba(197,165,114,0.25)"><tr>
      <td style="padding:18px 22px">
        <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:8.5px;letter-spacing:.26em;color:#6b655e;margin-bottom:6px">REPORT</div>
        <div style="font-family:Georgia,serif;font-size:14px;color:#C5A572;margin-bottom:8px">${esc(vv.title || `Vault Verification ${vv.year}`)}</div>
        ${vv.summary ? `<div style="font-family:Georgia,serif;font-size:13px;color:#8a7d6b;line-height:1.6">${esc(vv.summary)}</div>` : ''}
      </td>
    </tr></table>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" align="left" style="background:#0a0a0a;padding:22px 32px 32px">
    <a href="${esc(portalUrl)}" style="display:inline-block;padding:14px 26px;background:transparent;border:1px solid #C5A572;color:#C5A572;text-decoration:none;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.30em">VIEW REPORT →</a>
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Dear ${lead.name || 'Member'},`,
    ``,
    `An independent vault verification report has been published to your member portal.`,
    ``,
    `Report: ${vv.title || `Vault Verification ${vv.year}`}`,
    vv.summary ? `Summary: ${vv.summary}` : '',
    ``,
    `View in portal: ${portalUrl}`,
    ``,
    `— ${partnerName()}`,
    `TACC Pte Ltd, Singapore`,
  ].filter((l) => l !== undefined && !(l === '' && false)).join('\n');

  return sendRaw({
    to: lead.email,
    subject,
    html: shellHtml(inner, `Independent vault verification report ${vv.year} is now available.`),
    text,
  });
}

// ── 8. Funded confirmation ────────────────────────────────────────────────────

export async function sendFundedConfirmation(lead) {
  const memberNum = lead.member_number ? String(lead.member_number).padStart(3, '0') : null;
  const subject   = 'Subscription Confirmed — The Aurum Century Club';

  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:#C5A572">ADMITTED · 가입 확정</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:30px;line-height:1.2;color:#e8e3d8">
    Welcome to <span style="font-style:italic;color:#C5A572">the 100.</span>
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">
    Your subscription has been confirmed and your position is now active.
    ${memberNum ? `<strong style="color:#e8e3d8">Member #${esc(memberNum)}</strong> is registered in the Founding Round.` : ''}
  </td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#aaa39a">
    Bar serial numbers will be posted within 5 business days as gold is allocated at Singapore Freeport. You will be notified at each milestone.
  </td></tr>
  <tr><td bgcolor="#0a0a0a" align="left" style="background:#0a0a0a;padding:0 32px 32px">
    <a href="${esc(siteUrl())}/portfolio" style="display:inline-block;padding:14px 26px;background:transparent;border:1px solid #C5A572;color:#C5A572;text-decoration:none;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.30em">OPEN PORTFOLIO →</a>
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    `Your subscription has been confirmed and your position is now active.`,
    memberNum ? `Member #${memberNum} is registered in the Founding Round.` : '',
    ``,
    `Bar serials post within 5 business days. Access your portfolio: ${siteUrl()}/portfolio`,
    ``,
    `— ${partnerName()}`,
    `TACC Pte Ltd, Singapore`,
  ].filter(Boolean).join('\n');

  return sendRaw({
    to: lead.email,
    subject,
    html: shellHtml(inner, 'Your Aurum Century Club subscription is confirmed.'),
    text,
  });
}

// ── 9. Capital call reminder ──────────────────────────────────────────────────

export async function sendCapitalCallReminder(lead, call, daysToDue) {
  const ref      = call.ref || call.id || '—';
  const overdue  = daysToDue < 0;
  const daysAbs  = Math.abs(daysToDue);
  const subject  = overdue
    ? `Capital Call ${ref} — Overdue by ${daysAbs} day(s) · The Aurum Century Club`
    : `Capital Call ${ref} — Due in ${daysToDue} day(s) · The Aurum Century Club`;

  const bodyLine = overdue
    ? `Capital call <strong style="color:#e8e3d8">${esc(ref)}</strong> is overdue by ${daysAbs} day(s). Please arrange payment immediately.`
    : `Capital call <strong style="color:#e8e3d8">${esc(ref)}</strong> is due in <strong style="color:#e8e3d8">${daysToDue}</strong> day(s).`;

  const inner = `
  ${lockupRow}
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:36px 32px 8px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.34em;color:${overdue ? '#b05e56' : '#C5A572'}">${overdue ? 'OVERDUE · 연체' : 'REMINDER · 안내'}</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-weight:500;font-size:26px;line-height:1.2;color:#e8e3d8">Capital Call Notice</td></tr>
  <tr><td bgcolor="#0a0a0a" style="background:#0a0a0a;padding:0 32px 22px;font-family:Georgia,serif;font-size:16px;line-height:1.78;color:#aaa39a">${bodyLine}</td></tr>
  <tr><td bgcolor="#0a0a0a" align="left" style="background:#0a0a0a;padding:0 32px 32px">
    <a href="${esc(siteUrl())}/messages" style="display:inline-block;padding:14px 26px;background:transparent;border:1px solid #C5A572;color:#C5A572;text-decoration:none;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.30em">VIEW DETAILS →</a>
  </td></tr>
  ${dividerRow()}
  ${signOffRow()}
  `;

  const text = [
    overdue
      ? `Capital call ${ref} is overdue by ${daysAbs} day(s). Please arrange payment immediately.`
      : `Capital call ${ref} is due in ${daysToDue} day(s).`,
    '',
    `View details: ${siteUrl()}/messages`,
    '',
    `— ${partnerName()}`,
    'TACC Pte Ltd, Singapore',
  ].join('\n');

  return sendRaw({ to: lead.email, subject, html: shellHtml(inner, subject), text });
}
