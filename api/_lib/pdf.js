// _lib/pdf.js — PDF generation using PDFKit.
// Produces: Member Certificate + Tax Statement.
// Both are stored to Blob after generation.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { putBlob } from './blob.js';

function PDFDocument() {
  // Lazy require — PDFKit uses CommonJS
  const PDFKit = require('pdfkit');
  return PDFKit;
}

// Brand colours
const GOLD        = '#C5A572';
const GOLD_LIGHT  = '#D4B98A';
const CREAM_BG    = '#F4F0E6';
const DARK        = '#1A1410';
const BODY_GREY   = '#4A4035';

function vccUen() {
  return process.env.AURUM_VCC_UEN || '[VCC UEN NOT SET]';
}

function siteUrl() {
  return process.env.SITE_URL || 'https://www.theaurumcc.com';
}

// ── Helper: build PDF buffer from a drawing function ─────────────────────────

function buildPdf(drawFn) {
  return new Promise((resolve, reject) => {
    const PDFKit = PDFDocument();
    const doc = new PDFKit({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      drawFn(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ── Dual border helper ────────────────────────────────────────────────────────

function drawDualBorder(doc) {
  const pw = doc.page.width;
  const ph = doc.page.height;
  const margin = 28;
  const gap    = 8;

  // Outer border
  doc.save()
    .rect(margin, margin, pw - margin * 2, ph - margin * 2)
    .lineWidth(1)
    .strokeColor(GOLD)
    .stroke()
    .restore();

  // Inner border
  doc.save()
    .rect(margin + gap, margin + gap, pw - (margin + gap) * 2, ph - (margin + gap) * 2)
    .lineWidth(0.5)
    .strokeColor(GOLD_LIGHT)
    .stroke()
    .restore();
}

// ── Member Certificate ────────────────────────────────────────────────────────

/**
 * generateMemberCertificate(lead)
 * Returns Buffer (PDF). Also stores to Blob at certificates/[leadId].pdf
 */
export async function generateMemberCertificate(lead) {
  const buffer = await buildPdf((doc) => {
    const pw = doc.page.width;

    // Cream background
    doc.rect(0, 0, pw, doc.page.height).fill(CREAM_BG);

    drawDualBorder(doc);

    // Top ornament — gold seal placeholder (text-based)
    doc.font('Helvetica-Bold')
       .fontSize(10)
       .fillColor(GOLD)
       .text('— AURUM CENTURY CLUB —', 0, 60, { align: 'center', characterSpacing: 3 });

    doc.font('Helvetica')
       .fontSize(7)
       .fillColor(GOLD_LIGHT)
       .text('TACC PTE LTD · SINGAPORE VCC', 0, 76, { align: 'center', characterSpacing: 2 });

    // Main title
    doc.font('Helvetica-Bold')
       .fontSize(26)
       .fillColor(DARK)
       .text('CERTIFICATE OF MEMBERSHIP', 0, 120, { align: 'center', characterSpacing: 1.5 });

    // Thin gold rule
    doc.moveTo(80, 162).lineTo(pw - 80, 162).lineWidth(0.5).strokeColor(GOLD).stroke();

    // Body text
    const admitDate = lead.wire && lead.wire.cleared_at
      ? new Date(lead.wire.cleared_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    doc.font('Helvetica')
       .fontSize(12)
       .fillColor(BODY_GREY)
       .text('This certifies that', 0, 185, { align: 'center' });

    // Member name — large
    const displayName = (lead.subscription && lead.subscription.legal_name) || lead.name || 'Member';
    doc.font('Helvetica-Bold')
       .fontSize(22)
       .fillColor(DARK)
       .text(displayName, 80, 210, { align: 'center', width: pw - 160 });

    doc.font('Helvetica')
       .fontSize(12)
       .fillColor(BODY_GREY)
       .text('has been duly admitted to The Aurum Century Club as a Founding Member', 80, 248, { align: 'center', width: pw - 160 });

    doc.font('Helvetica')
       .fontSize(11)
       .fillColor(BODY_GREY)
       .text(`Effective: ${admitDate}`, 0, 278, { align: 'center' });

    // Member number box
    const memberNum = lead.member_number ? String(lead.member_number).padStart(3, '0') : '—';
    doc.save()
       .rect(pw / 2 - 80, 308, 160, 46)
       .lineWidth(0.75)
       .strokeColor(GOLD)
       .stroke()
       .restore();

    doc.font('Helvetica')
       .fontSize(7)
       .fillColor(GOLD)
       .text('MEMBER NUMBER', 0, 318, { align: 'center', characterSpacing: 2 });

    doc.font('Helvetica-Bold')
       .fontSize(20)
       .fillColor(DARK)
       .text(`#${memberNum}`, 0, 332, { align: 'center' });

    // VCC UEN
    doc.font('Helvetica')
       .fontSize(9)
       .fillColor(BODY_GREY)
       .text(`VCC Registration: ${vccUen()}`, 0, 375, { align: 'center' });

    // Gold rule
    doc.moveTo(80, 398).lineTo(pw - 80, 398).lineWidth(0.5).strokeColor(GOLD_LIGHT).stroke();

    // Signature blocks
    const sigY = 420;
    const leftX  = 100;
    const rightX = pw - 280;

    doc.font('Helvetica')
       .fontSize(10)
       .fillColor(BODY_GREY);

    // Left sig line
    doc.moveTo(leftX, sigY + 30).lineTo(leftX + 160, sigY + 30).lineWidth(0.5).strokeColor(DARK).stroke();
    doc.text('Fund Manager', leftX, sigY + 36, { width: 160, align: 'center' });

    // Right sig line
    doc.moveTo(rightX, sigY + 30).lineTo(rightX + 160, sigY + 30).lineWidth(0.5).strokeColor(DARK).stroke();
    doc.text('Fund Administrator', rightX, sigY + 36, { width: 160, align: 'center' });

    // Footer
    doc.moveTo(80, doc.page.height - 60).lineTo(pw - 80, doc.page.height - 60).lineWidth(0.5).strokeColor(GOLD_LIGHT).stroke();

    doc.font('Helvetica')
       .fontSize(7)
       .fillColor(GOLD_LIGHT)
       .text(
         `Member #${memberNum} · ${siteUrl()} · CONFIDENTIAL`,
         0,
         doc.page.height - 46,
         { align: 'center', characterSpacing: 1 }
       );
  });

  // Store to Blob
  const pathname = `certificates/${lead.id}.pdf`;
  const { url } = await putBlob(pathname, buffer, 'application/pdf');

  return { buffer, url, pathname };
}

// ── Tax Statement ─────────────────────────────────────────────────────────────

/**
 * generateTaxStatement(lead, fiscalYear, goldPriceAtYearStart, goldPriceAtYearEnd, fxRates)
 *   fxRates: { krw_start, krw_end, sgd_start, sgd_end }
 * Returns { buffer, url, pathname }
 */
export async function generateTaxStatement(lead, fiscalYear, goldPriceAtYearStart, goldPriceAtYearEnd, fxRates) {
  const kg = (lead.subscription && lead.subscription.kg_requested) || 1;
  const gramsHeld = kg * 1000;

  const valueStartUsd = kg * goldPriceAtYearStart;
  const valueEndUsd   = kg * goldPriceAtYearEnd;
  const unrealizedUsd = valueEndUsd - valueStartUsd;

  const krwStart = fxRates.krw_start || 1;
  const krwEnd   = fxRates.krw_end   || 1;
  const sgdStart = fxRates.sgd_start || 1;
  const sgdEnd   = fxRates.sgd_end   || 1;

  const valueStartKrw = valueStartUsd * krwStart;
  const valueEndKrw   = valueEndUsd   * krwEnd;
  const unrealizedKrw = valueEndKrw - valueStartKrw;

  const memberNum = lead.member_number ? String(lead.member_number).padStart(3, '0') : '—';
  const displayName = (lead.subscription && lead.subscription.legal_name) || lead.name || 'Member';

  function fmt(n, decimals = 2) {
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  const buffer = await buildPdf((doc) => {
    const pw = doc.page.width;

    doc.rect(0, 0, pw, doc.page.height).fill('#0A0A0A');

    // Header band
    doc.rect(0, 0, pw, 72).fill('#111008');

    doc.font('Helvetica-Bold')
       .fontSize(9)
       .fillColor(GOLD)
       .text('AURUM CENTURY CLUB', 50, 22, { characterSpacing: 3 });

    doc.font('Helvetica')
       .fontSize(7)
       .fillColor('#8A7D6B')
       .text(`TAX STATEMENT · FISCAL YEAR ${fiscalYear}`, 50, 37, { characterSpacing: 2 });

    doc.font('Helvetica-Bold')
       .fontSize(20)
       .fillColor('#E8E3D8')
       .text(`FY ${fiscalYear} Gold Position Statement`, 50, 82);

    // Member info box
    doc.rect(50, 120, pw - 100, 58).lineWidth(0.5).strokeColor('#2A2520').stroke();

    const infoRows = [
      ['MEMBER', displayName],
      ['MEMBER #', `#${memberNum}`],
      ['VCC UEN', vccUen()],
      ['INSTRUMENT', '999.9 LBMA 1kg Gold Bar(s) · Malca-Amit Singapore FTZ'],
    ];

    infoRows.forEach((row, i) => {
      const ry = 130 + i * 12;
      doc.font('Helvetica')
         .fontSize(7)
         .fillColor('#8A7D6B')
         .text(row[0], 62, ry, { width: 80, characterSpacing: 1.5 });
      doc.font('Helvetica')
         .fontSize(8)
         .fillColor('#E8E3D8')
         .text(row[1], 150, ry);
    });

    // Position table
    const tableY = 196;
    doc.font('Helvetica-Bold')
       .fontSize(7)
       .fillColor(GOLD)
       .text('GOLD POSITION DETAIL', 50, tableY, { characterSpacing: 2 });

    doc.moveTo(50, tableY + 14).lineTo(pw - 50, tableY + 14).lineWidth(0.3).strokeColor('#2A2520').stroke();

    function tableRow(label, col1, col2, col3, y) {
      doc.font('Helvetica').fontSize(8).fillColor('#8A7D6B').text(label, 50, y, { width: 180 });
      doc.font('Helvetica').fontSize(8).fillColor('#E8E3D8').text(col1, 230, y, { width: 100, align: 'right' });
      doc.font('Helvetica').fontSize(8).fillColor('#E8E3D8').text(col2, 340, y, { width: 100, align: 'right' });
      if (col3 !== undefined) doc.font('Helvetica').fontSize(8).fillColor('#E8E3D8').text(col3, 450, y, { width: 90, align: 'right' });
    }

    function tableHeader(l, c1, c2, c3, y) {
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#6B655E')
         .text(l, 50, y, { width: 180, characterSpacing: 1 })
         .text(c1, 230, y, { width: 100, align: 'right' })
         .text(c2, 340, y, { width: 100, align: 'right' });
      if (c3) doc.text(c3, 450, y, { width: 90, align: 'right' });
    }

    tableHeader('DESCRIPTION', 'YEAR START', 'YEAR END', 'CHANGE', tableY + 20);
    doc.moveTo(50, tableY + 32).lineTo(pw - 50, tableY + 32).lineWidth(0.3).strokeColor('#2A2520').stroke();

    const rows = [
      [`Gold Held (grams)`,          `${fmt(gramsHeld, 1)} g`,       `${fmt(gramsHeld, 1)} g`,       '—'],
      [`XAU/USD (per kg)`,           `$${fmt(goldPriceAtYearStart)}`, `$${fmt(goldPriceAtYearEnd)}`,  '—'],
      [`USD/KRW Rate`,               fmt(krwStart, 2),               fmt(krwEnd, 2),                 '—'],
      [`Acquisition Cost (USD)`,     `$${fmt(valueStartUsd)}`,       '—',                            '—'],
      [`Year-End Value (USD)`,        '—',                            `$${fmt(valueEndUsd)}`,         '—'],
      [`Unrealized Gain/Loss (USD)`, '',                              '',                             `${unrealizedUsd >= 0 ? '+' : ''}$${fmt(unrealizedUsd)}`],
      [`Acquisition Cost (KRW)`,     `₩${fmt(valueStartKrw, 0)}`,   '—',                            '—'],
      [`Year-End Value (KRW)`,        '—',                            `₩${fmt(valueEndKrw, 0)}`,     '—'],
      [`Unrealized Gain/Loss (KRW)`, '',                              '',                             `${unrealizedKrw >= 0 ? '+' : ''}₩${fmt(unrealizedKrw, 0)}`],
    ];

    rows.forEach((row, i) => {
      const ry = tableY + 40 + i * 18;
      tableRow(row[0], row[1], row[2], row[3], ry);
      if (i % 2 === 0) {
        doc.rect(50, ry - 3, pw - 100, 16).fillOpacity(0.03).fill('#FFFFFF').fillOpacity(1);
      }
    });

    // Disclaimer
    const disclaimerY = tableY + 40 + rows.length * 18 + 24;
    doc.moveTo(50, disclaimerY).lineTo(pw - 50, disclaimerY).lineWidth(0.3).strokeColor('#2A2520').stroke();

    doc.font('Helvetica')
       .fontSize(7)
       .fillColor('#4A4540')
       .text(
         'DISCLAIMER: This statement is provided for informational purposes only and does not constitute tax advice. ' +
         'Gold holdings are recorded at spot rates cited above. Unrealized gains/losses are not taxable events until ' +
         'disposition. Members are advised to consult a qualified tax advisor in their jurisdiction. Values are stated ' +
         'in USD and KRW using end-of-period FX rates. TACC Pte Ltd makes no representations regarding the tax ' +
         'treatment of gold investments in any jurisdiction.',
         50,
         disclaimerY + 10,
         { width: pw - 100, lineGap: 3 }
       );

    // Footer
    doc.font('Helvetica')
       .fontSize(7)
       .fillColor('#3A3530')
       .text(
         `Member #${memberNum} · Generated ${new Date().toISOString().slice(0, 10)} · ${siteUrl()} · CONFIDENTIAL`,
         50,
         doc.page.height - 40,
         { width: pw - 100, align: 'center', characterSpacing: 0.5 }
       );
  });

  const pathname = `tax-statements/${lead.id}/${fiscalYear}.pdf`;
  const { url } = await putBlob(pathname, buffer, 'application/pdf');

  return { buffer, url, pathname };
}
