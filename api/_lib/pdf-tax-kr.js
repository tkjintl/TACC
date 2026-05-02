// _lib/pdf-tax-kr.js — Korean-primary tax statement PDF generator.
//
// Renders the FY tax statement with Korean labels (Hangul) followed by English
// labels in parentheses. Members are mostly Korean; the document is the
// authoritative artefact saved to Vercel Blob and surfaced via signed URL.
//
// Korean glyph rendering needs a font with full Hangul coverage. PDFKit's
// built-in Helvetica only ships Latin. We fetch Noto Sans KR from Google's
// public Noto repo on first use and cache the buffer in module memory.
// (No npm dependency added.)

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { putBlob } from './blob.js';

const GOLD = '#C5A572';
const DARK = '#1A1410';
const BODY = '#2A2520';
const MUTED = '#8A7D6B';
const LINE = '#2A2520';

// ── Korean font fetch + cache ────────────────────────────────────────────────

// Noto Sans CJK KR Regular (subset is ~10MB; full OTF is ~17MB). We use the
// Google Fonts static-host Noto Sans KR Regular which is ~5MB and ships
// Hangul + Latin in a single TTF.
//
// OPERATOR: vendor the .otf to Vercel Blob and set NOTO_KR_FONT_URL to the
// public URL to avoid the cold-start GitHub fetch. Recommended pattern:
//   NOTO_KR_FONT_URL=https://<your-blob-store>.public.blob.vercel-storage.com/fonts/NotoSansCJKkr-Regular.otf
// File: googlefonts/noto-cjk Sans/OTF/Korean/NotoSansCJKkr-Regular.otf (~17MB).
const ENV_FONT_URL = process.env.NOTO_KR_FONT_URL || '';
const GITHUB_FONT_URLS = [
  // GitHub raw of Google's fonts (well-known stable URL for Noto Sans KR Regular).
  'https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf',
  'https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf',
];

let _fontPromise = null;
let _fontBuf = null;
let _fontSource = null; // 'env' | 'github' | 'failed' | null (not loaded yet)

export function getKoreanFontSource() { return _fontSource; }

async function _tryFetch(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    if (ab.byteLength < 1000) return null; // sanity check
    return Buffer.from(ab);
  } catch (e) {
    console.warn('[pdf-tax-kr] font fetch failed for', url, e && e.message);
    return null;
  }
}

async function loadKoreanFont() {
  if (_fontBuf) return _fontBuf;
  if (_fontPromise) return _fontPromise;
  _fontPromise = (async () => {
    // 1. Operator-vendored URL via env (preferred).
    if (ENV_FONT_URL) {
      const buf = await _tryFetch(ENV_FONT_URL);
      if (buf) {
        _fontBuf = buf;
        _fontSource = 'env';
        return _fontBuf;
      }
      console.warn('[pdf-tax-kr] NOTO_KR_FONT_URL fetch failed, falling through to GitHub');
    }
    // 2. GitHub raw fallback (fragile on cold start; can fail under rate limit).
    for (const url of GITHUB_FONT_URLS) {
      const buf = await _tryFetch(url);
      if (buf) {
        _fontBuf = buf;
        _fontSource = 'github';
        return _fontBuf;
      }
    }
    // 3. None worked — caller renders Latin-only.
    _fontBuf = null;
    _fontSource = 'failed';
    console.error('[pdf-tax-kr] all font sources failed; rendering in Latin-only mode');
    return null;
  })();
  return _fontPromise;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function vccUen() {
  return process.env.AURUM_VCC_UEN || 'TACC PTE LTD · UEN [unset]';
}
function siteUrl() {
  return process.env.SITE_URL || 'https://www.theaurumcc.com';
}
function fmtUsd(n, dp = 2) {
  if (!isFinite(n)) return '-';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtNum(n, dp = 2) {
  if (!isFinite(n)) return '-';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function buildPdf(drawFn) {
  return new Promise((resolve, reject) => {
    const PDFKit = require('pdfkit');
    const doc = new PDFKit({ size: 'A4', margin: 0, autoFirstPage: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    Promise.resolve(drawFn(doc))
      .then(() => doc.end())
      .catch(reject);
  });
}

/**
 * generateKoreanTaxStatement(lead, fiscalYear, opts)
 *   opts: { gold_price_start_per_kg, gold_price_end_per_kg, fx_rate_krw_end,
 *           custodian, issue_date_iso }
 * Returns { buffer, url, pathname }
 */
export async function generateKoreanTaxStatement(lead, fiscalYear, opts = {}) {
  const kg = (lead.bars && lead.bars.length)
    ? lead.bars.reduce((s, b) => s + (Number(b.weight_kg) || 0), 0)
    : ((lead.subscription && Number(lead.subscription.kg_requested)) || 0);

  const goldStart = Number(opts.gold_price_start_per_kg) || 0;
  const goldEnd   = Number(opts.gold_price_end_per_kg)   || 0;
  const fxKrw     = Number(opts.fx_rate_krw_end)         || 0;

  // Cost basis preference: real bar-level basis if available, else subscription, else start price * kg
  const costBasisUsd = (lead.bars && lead.bars.length)
    ? lead.bars.reduce((s, b) => s + (Number(b.cost_basis_usd) || 0), 0) || (kg * goldStart)
    : ((lead.subscription && Number(lead.subscription.usd_amount)) || (kg * goldStart));

  const currentValueUsd = kg * goldEnd;
  const pnlUsd          = currentValueUsd - costBasisUsd;
  const pnlPct          = costBasisUsd > 0 ? (pnlUsd / costBasisUsd) * 100 : 0;

  // Holding period — earliest bar.assigned_at or funded_at to fiscalYear-end (Dec 31)
  const fyEndMs = Date.UTC(Number(fiscalYear), 11, 31, 23, 59, 59);
  const holdStartMs = (lead.bars || []).reduce((min, b) => {
    const t = b.assigned_at ? new Date(b.assigned_at).getTime() : Infinity;
    return t < min ? t : min;
  }, Infinity);
  const startMs = isFinite(holdStartMs) ? holdStartMs
    : (lead.funded_at || (lead.wire && lead.wire.cleared_at) || Date.now());
  const holdingDays = Math.max(0, Math.floor((fyEndMs - startMs) / (1000 * 60 * 60 * 24)));

  const memberNum = lead.member_number ? String(lead.member_number).padStart(3, '0') : '—';
  const displayName = (lead.subscription && lead.subscription.legal_name) || lead.legal_name || lead.name || 'Member';
  const custodian = String(opts.custodian || 'Malca-Amit Singapore FTZ');
  const issueIso  = String(opts.issue_date_iso || new Date().toISOString().slice(0, 10));

  const fontBuf = await loadKoreanFont();

  const buffer = await buildPdf(async (doc) => {
    if (fontBuf) {
      try { doc.registerFont('NotoKR', fontBuf); } catch (e) {
        console.warn('[pdf-tax-kr] registerFont failed:', e && e.message);
      }
    }
    const KR = fontBuf ? 'NotoKR' : 'Helvetica';
    const KR_BOLD = fontBuf ? 'NotoKR' : 'Helvetica-Bold';

    const pw = doc.page.width;
    const ph = doc.page.height;

    // Page background — cream
    doc.rect(0, 0, pw, ph).fill('#F8F4EA');

    // Top band
    doc.rect(0, 0, pw, 84).fill('#0F0E08');

    doc.font(KR_BOLD).fontSize(10).fillColor(GOLD)
       .text('AURUM CENTURY CLUB', 50, 24, { characterSpacing: 3 });
    doc.font(KR).fontSize(7).fillColor('#8A7D6B')
       .text(`세무신고용 보유증명서  ·  TAX STATEMENT  ·  FY ${fiscalYear}`, 50, 42, { characterSpacing: 1 });

    // Title
    doc.font(KR_BOLD).fontSize(20).fillColor(DARK)
       .text(`${fiscalYear} 회계연도 금 보유증명서`, 50, 110);
    doc.font(KR).fontSize(9).fillColor(MUTED)
       .text(`(FY ${fiscalYear} Gold Position Statement)`, 50, 140);

    // Member info card
    doc.save().rect(50, 168, pw - 100, 96).lineWidth(0.5).strokeColor(LINE).stroke().restore();

    const labelW = 160;
    const valX   = 50 + labelW + 12;
    const rows = [
      ['회원번호 (Member #)',          `#${memberNum}`],
      ['성명 (Name)',                  displayName],
      ['신탁회사 (Custodian)',         custodian],
      ['회사 (Issuer)',                vccUen()],
      ['발행일 (Issue Date)',          issueIso],
    ];
    for (let i = 0; i < rows.length; i++) {
      const ry = 178 + i * 16;
      doc.font(KR).fontSize(8).fillColor(MUTED).text(rows[i][0], 60, ry, { width: labelW });
      doc.font(KR_BOLD).fontSize(9).fillColor(BODY).text(rows[i][1], valX, ry, { width: pw - valX - 60 });
    }

    // Position table
    const tableY = 286;
    doc.font(KR_BOLD).fontSize(9).fillColor(GOLD)
       .text('보유 포지션 상세 (Position Detail)', 50, tableY, { characterSpacing: 1 });
    doc.moveTo(50, tableY + 16).lineTo(pw - 50, tableY + 16).lineWidth(0.5).strokeColor(LINE).stroke();

    const tRows = [
      ['보유 kg (Gold Held)',                     `${fmtNum(kg, 3)} kg`],
      ['보유기간 (Holding Period)',               `${holdingDays} 일 (days)`],
      ['취득가 USD (Cost Basis)',                 fmtUsd(costBasisUsd, 2)],
      ['평가액 USD (Current Value)',              fmtUsd(currentValueUsd, 2)],
      ['수익 USD (P&L)',                          (pnlUsd >= 0 ? '+' : '') + fmtUsd(pnlUsd, 2) + `  (${(pnlPct).toFixed(2)}%)`],
      ['연말 금시세 USD/kg (Year-End XAU/USD)',   fmtUsd(goldEnd, 2)],
      ['연초 금시세 USD/kg (Year-Start XAU/USD)', fmtUsd(goldStart, 2)],
      ['환율 KRW/USD (FX Rate Year-End)',         fmtNum(fxKrw, 2)],
      ['평가액 KRW (Value in KRW)',               '₩' + fmtNum(currentValueUsd * fxKrw, 0)],
    ];

    tRows.forEach((r, i) => {
      const ry = tableY + 28 + i * 22;
      if (i % 2 === 0) {
        doc.save().rect(50, ry - 4, pw - 100, 20).fillOpacity(0.04).fill(GOLD).fillOpacity(1).restore();
      }
      doc.font(KR).fontSize(9).fillColor(BODY).text(r[0], 60, ry, { width: pw - 240 });
      doc.font(KR_BOLD).fontSize(10).fillColor(DARK).text(r[1], pw - 230, ry, { width: 170, align: 'right' });
    });

    // Bars listing (if vault mode)
    let barsBlockEndY = tableY + 28 + tRows.length * 22 + 20;
    if (lead.bars && lead.bars.length) {
      doc.font(KR_BOLD).fontSize(9).fillColor(GOLD)
         .text(`바 일련번호 (LBMA Bar Serials) — ${lead.bars.length}개`, 50, barsBlockEndY);
      barsBlockEndY += 16;
      doc.font(KR).fontSize(8).fillColor(BODY);
      for (const b of lead.bars) {
        const line = `• ${b.serial || '-'}   ${b.refiner || ''}   ${b.year || ''}   ${fmtNum(Number(b.weight_kg) || 1, 3)} kg`;
        doc.text(line, 60, barsBlockEndY, { width: pw - 120 });
        barsBlockEndY += 12;
      }
      barsBlockEndY += 8;
    }

    // Disclaimer
    doc.moveTo(50, barsBlockEndY).lineTo(pw - 50, barsBlockEndY).lineWidth(0.3).strokeColor(LINE).stroke();
    doc.font(KR).fontSize(7).fillColor('#5A5550')
       .text(
         '본 증명서는 정보제공 목적으로만 발행되며 세무자문이 아닙니다. 미실현 손익은 처분 시점까지 과세사건이 아닙니다. ' +
         '회원은 자국 관할 세무전문가의 자문을 받으시기 바랍니다.\n' +
         '(Disclaimer: This statement is informational only and does not constitute tax advice. Unrealized P&L is not a ' +
         'taxable event until disposition. Members should consult a qualified tax advisor in their jurisdiction.)',
         50, barsBlockEndY + 10, { width: pw - 100, lineGap: 3 },
       );

    // Footer
    doc.font(KR).fontSize(7).fillColor('#3A3530')
       .text(
         `회원 #${memberNum} · ${siteUrl()} · CONFIDENTIAL · ${issueIso}`,
         50, ph - 36, { width: pw - 100, align: 'center', characterSpacing: 0.5 },
       );
  });

  const pathname = `tax-statements/${lead.id}/${fiscalYear}-kr-${Date.now().toString(36)}.pdf`;
  const { url } = await putBlob(pathname, buffer, 'application/pdf');

  return { buffer, url, pathname, font_source: _fontSource };
}
