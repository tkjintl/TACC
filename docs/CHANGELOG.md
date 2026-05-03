# AURUM CC 2026 VF — Changelog

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
