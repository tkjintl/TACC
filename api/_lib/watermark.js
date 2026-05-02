// _lib/watermark.js — Per-member diagonal watermark overlay on PDFs.
// Uses PDFKit to stamp every page of the source PDF.
// Strategy: we cannot modify existing PDF pages with PDFKit (it's a generator,
// not a mutator). We use pdf-lib's PDFDocument to draw on top if available,
// otherwise we fall through to PDFKit overlay on a fresh PDF and composite.
//
// Decision: use a pure-PDFKit approach — generate a single-page overlay PDF
// and return it as a layered byte stream. For actual page-by-page stamping
// in production, integrate pdf-lib. Here we implement the spec interface
// precisely and note the production upgrade path.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/**
 * watermarkPdf(pdfBuffer, memberName, memberNumber, date)
 * Overlays diagonal watermark text on every page.
 * Returns watermarked Buffer.
 *
 * Implementation: uses pdf-lib for page mutation (added to package.json).
 * Falls back to returning the original buffer with a console warning if
 * pdf-lib is unavailable.
 */
export async function watermarkPdf(pdfBuffer, memberName, memberNumber, date) {
  let PDFLib;
  try {
    PDFLib = require('pdf-lib');
  } catch {
    console.warn('[aurum/watermark] pdf-lib not installed — returning unwatermarked PDF. Add pdf-lib to package.json.');
    return pdfBuffer;
  }

  const { PDFDocument, rgb, degrees } = PDFLib;

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  const watermarkText = `${memberName} · Member #${memberNumber} · ${date}`;
  const fontSize = 11;
  const opacity  = 0.12;

  for (const page of pages) {
    const { width, height } = page.getSize();

    // Draw the watermark text diagonally across the page.
    // We tile it in a grid pattern so coverage is even on all page sizes.
    const stepX = 200;
    const stepY = 140;

    for (let x = -50; x < width + 50; x += stepX) {
      for (let y = 20; y < height + 20; y += stepY) {
        page.drawText(watermarkText, {
          x,
          y,
          size: fontSize,
          color: rgb(0.1, 0.1, 0.1),
          opacity,
          rotate: degrees(45),
        });
      }
    }
  }

  const watermarkedBytes = await pdfDoc.save();
  return Buffer.from(watermarkedBytes);
}
