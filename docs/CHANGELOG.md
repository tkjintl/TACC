# AURUM CC 2026 VF — Changelog

## 2026-05-05 — Member Portal (tacc)

### Added: /ndadocs — pre-NDA document review page
- New `_pages/ndadocs.html`: bilingual (EN/KO) page titled "Review before signing."
- Shows 3 docs: Onboarding Package, Structural Memo, Member FAQ
- Accessible to any `accessed`+ member (before NDA signing)
- "Proceed to NDA →" CTA at bottom links to `/nda`
- Route wired in `vercel.json`: `/ndadocs` → `/api/doc?id=ndadocs-page`
- Noindex/no-store headers added for `/ndadocs`

### Changed: /main — View Documents CTA
- "View Documents" CTA now points to `/ndadocs` (was `/documents`)
- Pre-NDA members land on the 3-doc review page, not the funded-only vault

### Changed: /documents — funded-only, no conditional logic
- Reverted 2-gate approach (removed conditional show/hide based on status)
- Page is funded members only; no toggle JS, no pre-NDA document section

### Changed: api/doc.js — doc gate updates
- Added `ndadocs-page` to PAGE_GATES (gate: `rank(status) >= accessed`)
- `package` and `structural` doc gates loosened from `nda_state === 'approved'`
  to `rank(status) >= accessed` so pre-NDA members can download review docs
- `faq` gate was already `accessed+`, unchanged

### Previously (same session):

#### Added: /ioi — IOI/KYC page
- Ported `ioi.html`, `api/ioi.js`, `api/_lib/krw.js` from livetest-aurum
- Route: `/ioi` → `ndadocs-page` gate: `nda_state === 'approved'`
- Added `/api/ioi` route in `vercel.json`

#### Fixed: NDA template download (dead link)
- PDFs uploaded to Vercel Blob (private store) via `scripts/upload-docs-to-blob.js`
- `api/doc.js` tries Blob first, falls back to filesystem
- `api/_lib/blob.js`: added `Authorization: Bearer` header for private blob reads
- `api/nda.js`: added admin cookie bypass so admin can test NDA download

#### Fixed: telescope tabs II & III not clickable on /main
- data-pillar values changed from strings (`"vcc"`, `"credit"`, `"deploy"`) to
  numerics (`1`, `2`, `3`) — JS uses `+p.dataset.pillar` which cast strings to NaN

#### Fixed: founding member count showing 33 instead of 3
- Removed `loadLiveCount()` async API fetch from `main.html`
- Hardcoded `buildGrid(3); updateCounter(3);`

#### Fixed: admin dashboard missing "Main Site" button
- Restored `<a href="/main">Main Site</a>` to `admin.html` (dropped in commit fabfde6)

#### Fixed: member badge empty box in nav
- Badge element hidden by default; JS reveals only when `member_number` is set

#### Removed: closing section from /main
- Entire `<section class="closing">` block removed (redundant below NDA CTA)

#### Added: /gold and /letters redirects
- `/gold` → `/api/doc?id=portfolio-page`
- `/letters` → `/api/doc?id=documents-page`

## 2026-05-02

### Fixed: phantom gold box around italic headline (every slide)
- **Symptom:** Every slide rendered a thin 1px gold rectangle around the second (italic) line of the headline in the printed PDF.
- **Cause:** `.slide-headline .hl-g` used `linear-gradient` + `-webkit-background-clip: text` on a `display: block` element. Chromium's print engine leaked the gradient outside the text mask and rendered it as a thin outline at the block's edge.
- **Fix:** Replaced the gradient-clipped text fill with a solid color.
  - File: `AURUM CC 2026 VF.html`
  - Before:
    ```css
    .slide-headline .hl-g {
      font-style: italic;
      background: linear-gradient(135deg, var(--goldA), var(--goldD));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    ```
  - After:
    ```css
    .slide-headline .hl-g {
      font-style: italic;
      color: var(--goldC);
    }
    ```

### Fixed: trailing blank 13th page in PDF
- **Symptom:** Generated PDF had 13 pages; page 13 was empty (black background only).
- **Cause:** Chromium's headless print engine appended a final blank page regardless of CSS adjustments (tested: `:not(:last-child)` page-breaks, `min-height: 0`, reduced slide height to 209.9mm, hidden body-level `<script>`). Output byte-count was identical across all CSS variants, confirming the trailing page is a Chromium print quirk, not a layout overflow.
- **Fixes:**
  1. **HTML/CSS hardening** (`AURUM CC 2026 VF.html`):
     - Added explicit `margin: 0`, `padding: 0`, `min-height: 0`, `height: auto` to `html, body` inside `@media print`.
     - Scoped `page-break-after: always` to `.slide:not(:last-child)` only.
  2. **PDF post-processing:** After Chrome renders to PDF, the trailing blank page is dropped with PyMuPDF before saving the final file.

### Build pipeline (current)
1. Edit `AURUM CC 2026 VF.html`.
2. Render to PDF with headless Chrome:
   ```
   chrome --headless=new --disable-gpu --no-pdf-header-footer --no-margins \
     --print-to-pdf="<temp>/aurum.pdf" \
     "file:///.../AURUM%20CC%202026%20VF.html"
   ```
3. Trim trailing blank page with PyMuPDF:
   ```python
   import fitz
   src = fitz.open("<temp>/aurum.pdf")
   out = fitz.open()
   out.insert_pdf(src, from_page=0, to_page=11)
   out.save("AURUM CC 2026 VF.pdf")
   ```
4. Verify final PDF has 12 pages.
