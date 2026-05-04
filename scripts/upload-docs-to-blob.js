// scripts/upload-docs-to-blob.js
// Uploads all static PDFs from _docs/ to Vercel Blob.
// Usage: BLOB_READ_WRITE_TOKEN=xxx node scripts/upload-docs-to-blob.js
//   OR:  vercel env pull .env.local && node --env-file=.env.local scripts/upload-docs-to-blob.js

import { put } from '@vercel/blob';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', '_docs');

const FILES = [
  'nda-template.pdf',
  'TACC_Onboarding_May_2026.pdf',
  'TACC_Structural_Memo.pdf',
  'TACC_Member_FAQ.pdf',
];

const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN not set.');
  console.error('Run: vercel env pull .env.local && node --env-file=.env.local scripts/upload-docs-to-blob.js');
  process.exit(1);
}

for (const filename of FILES) {
  const filePath = join(DOCS_DIR, filename);
  try {
    const buf = await readFile(filePath);
    const result = await put(filename, buf, {
      access: 'public',
      contentType: 'application/pdf',
      token,
    });
    console.log(`✓ ${filename} → ${result.url}`);
  } catch (e) {
    console.error(`✗ ${filename}: ${e.message}`);
  }
}
