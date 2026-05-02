# Email Templates — Copy Reference
# These templates are already implemented as functions in `NEW TACC/api/_lib/email.js`
# (sendQuarterlyLetterNotification and sendVaultVerificationNotification).
# This file records the canonical copy so it can be reviewed, translated, or updated
# independently of the code.
# [NEEDS KO TRANSLATION] for bilingual variants

---

## Template 1: Quarterly Letter Notification

**Subject line:**
```
Fund Update Q{Q} {YYYY} — The Aurum Century Club
```

**Preheader text (hidden preview line):**
```
Your Q{Q} {YYYY} fund update is available in the member portal.
```

**Eyebrow label (mono, gold):**
```
FUND UPDATE · 펀드 업데이트
```

**Headline:**
```
Q{Q} {YYYY} quarterly letter.
```
*(Display: "Q{Q} {YYYY}" in text color, "quarterly letter." in italic gold)*

**Body paragraph:**

Dear {{member_name}}, your Q{Q} {YYYY} fund letter has been published to the member portal. It covers your gold position, credit line status, vault custody, and the Manager's conditions narrative for the quarter. The letter is available in full in the portal; a summary is not provided in this notification.

**CTA button:**
```
READ FUND UPDATE →
```
Link: `https://www.theaurumcc.com/_pages/documents.html`

**Sign-off block (mono, muted):**
```
— {PARTNER_NAME}
AURUM · TACC PTE LTD · SINGAPORE
CONFIDENTIAL · QUALIFIED MEMBERS ONLY
```

**Plain text version:**
```
Dear {member_name},

Your Q{Q} {YYYY} fund letter has been published to the member portal.

Read the full letter: https://www.theaurumcc.com/_pages/documents.html

— {PARTNER_NAME}
TACC Pte Ltd, Singapore
CONFIDENTIAL · QUALIFIED MEMBERS ONLY
```

---

## Template 2: Vault Verification Notification

**Subject line:**
```
Vault Verification Report {YYYY} — The Aurum Century Club
```

**Preheader text (hidden preview line):**
```
Independent vault verification report {YYYY} is now available in the member portal.
```

**Eyebrow label (mono, gold):**
```
VAULT VERIFICATION · 보관 검증
```

**Headline:**
```
Independent vault verification {YYYY}.
```
*(Display: "Independent vault verification" in text color, "{YYYY}." in italic gold)*

**Body paragraph:**

Dear {{member_name}}, the annual independent physical inspection at Malca-Amit Singapore Freeport has been completed for {YYYY}. The vault verification report, confirming bar serial numbers, assay weights, and custody status for all bars held in the fund's allocated account, is now available in your member portal under Documents — Vault Verifications.

**CTA button:**
```
VIEW REPORT →
```
*(Ghost/outline style button — gold border, transparent fill)*
Link: `https://www.theaurumcc.com/_pages/documents.html`

**Sign-off block (mono, muted):**
```
— {PARTNER_NAME}
AURUM · TACC PTE LTD · SINGAPORE
CONFIDENTIAL · QUALIFIED MEMBERS ONLY
```

**Plain text version:**
```
Dear {member_name},

The {YYYY} independent vault verification report is now available in your member portal under Documents — Vault Verifications.

Bar serial numbers, weights, and custody status are confirmed in the report.

View report: https://www.theaurumcc.com/_pages/documents.html

— {PARTNER_NAME}
TACC Pte Ltd, Singapore
CONFIDENTIAL · QUALIFIED MEMBERS ONLY
```

---

## Design reference for both templates

These emails use the shell already implemented in `email.js`:

- Outer background: `#0a0a0a`
- Inner max-width: 600px, centered
- Brand lockup: gold-bordered `Au` seal (38px × 38px, italic Georgia) + "AURUM" wordmark (Outfit 600, 0.34em tracking) + "CENTURY · CLUB" sub (JetBrains Mono, 8.5px, 0.36em tracking, `#8a7d6b`)
- Eyebrow row: JetBrains Mono, 11px, 0.34em tracking, `#C5A572`
- Headline row: Georgia 500, 30px, `#e8e3d8` with italic gold span
- Body row: Georgia, 16px, 1.78 line-height, `#aaa39a`
- CTA primary: `background:#C5A572; color:#0a0a0a` — JetBrains Mono, 11px, 0.30em tracking
- CTA ghost: `border:1px solid #C5A572; color:#C5A572; background:transparent`
- Sign-off: JetBrains Mono, 9.5px, 0.30em tracking, `#6b655e`; border-top `rgba(255,255,255,0.08)`

[NEEDS KO TRANSLATION]
