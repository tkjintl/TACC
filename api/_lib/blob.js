// _lib/blob.js — Vercel Blob wrapper with local filesystem fallback.
// Falls back to _local_blob/ directory if BLOB_READ_WRITE_TOKEN is absent.

import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, unlink, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = join(__dirname, '..', '..', '_local_blob');

let _warnedBlob = false;
function hasToken() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN);
}
function warnNoBlob() {
  if (_warnedBlob) return;
  _warnedBlob = true;
  console.warn('[aurum/blob] BLOB_READ_WRITE_TOKEN not set — using local filesystem fallback at _local_blob/. Set before production.');
}

// Lazy import @vercel/blob so the module loads without the token in local dev
async function blobPkg() {
  const require = createRequire(import.meta.url);
  return require('@vercel/blob');
}

// ── Local fallback helpers ────────────────────────────────────────────────────

function localPath(pathname) {
  // Sanitise: strip leading slashes, collapse traversal
  const safe = pathname.replace(/\.\./g, '_').replace(/^\/+/, '');
  return join(LOCAL_ROOT, safe);
}

async function ensureDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * putBlob(pathname, buffer, contentType)
 * Returns { url, pathname }
 */
export async function putBlob(pathname, buffer, contentType = 'application/octet-stream') {
  if (!hasToken()) {
    warnNoBlob();
    const fp = localPath(pathname);
    await ensureDir(fp);
    await writeFile(fp, buffer);
    return { url: `local://${pathname}`, pathname };
  }
  const { put } = await blobPkg();
  const result = await put(pathname, buffer, {
    access: 'private',
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: result.url, pathname };
}

/**
 * getBlob(pathname)
 * Returns Buffer or throws
 */
export async function getBlob(pathname) {
  if (!hasToken()) {
    warnNoBlob();
    const fp = localPath(pathname);
    return readFile(fp);
  }
  // Derive the blob URL pattern — list to find the URL then fetch
  const { list } = await blobPkg();
  const results = await list({ prefix: pathname, token: process.env.BLOB_READ_WRITE_TOKEN });
  const blob = results.blobs.find((b) => b.pathname === pathname || b.url.endsWith(pathname));
  if (!blob) throw new Error(`Blob not found: ${pathname}`);
  const headers = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) headers['Authorization'] = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  const r = await fetch(blob.url, { headers });
  if (!r.ok) throw new Error(`Blob fetch failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * listBlobs(prefix)
 * Returns [{ pathname, url, size, uploadedAt }]
 */
export async function listBlobs(prefix = '') {
  if (!hasToken()) {
    warnNoBlob();
    try {
      const dir = localPath(prefix || '');
      const names = await readdir(dir, { recursive: true });
      const results = [];
      for (const name of names) {
        const fp = join(dir, name);
        let s;
        try { s = await stat(fp); } catch { continue; }
        if (!s.isFile()) continue;
        const rel = (prefix ? prefix + '/' : '') + name;
        results.push({ pathname: rel, url: `local://${rel}`, size: s.size, uploadedAt: s.mtime });
      }
      return results;
    } catch {
      return [];
    }
  }
  const { list } = await blobPkg();
  const results = await list({ prefix, token: process.env.BLOB_READ_WRITE_TOKEN });
  return results.blobs.map((b) => ({
    pathname: b.pathname,
    url: b.url,
    size: b.size,
    uploadedAt: b.uploadedAt,
  }));
}

/**
 * deleteBlob(pathname)
 */
export async function deleteBlob(pathname) {
  if (!hasToken()) {
    warnNoBlob();
    const fp = localPath(pathname);
    await unlink(fp).catch(() => {});
    return;
  }
  const { del, list } = await blobPkg();
  const results = await list({ prefix: pathname, token: process.env.BLOB_READ_WRITE_TOKEN });
  const blob = results.blobs.find((b) => b.pathname === pathname || b.url.endsWith(pathname));
  if (blob) await del(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
}
