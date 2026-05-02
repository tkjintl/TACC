# Aurum Century Club — Operator Console

Internal documentation for the founder/partner operating the platform. Not for prospects. Not for members. Confidential.

Companion docs:
- [`ENVIRONMENT.md`](./ENVIRONMENT.md) — full env var reference, what breaks if each is missing.
- [`RUNBOOK.md`](./RUNBOOK.md) — step-by-step operator procedures (onboarding, capital calls, NAV, vault reports, tax statements, emergency).
- [`AUTOMATION_ARCHITECTURE.md`](./AUTOMATION_ARCHITECTURE.md) — internals of the automation layer (kept as-is).

---

## What this is

The Aurum Century Club ("TACC") is a Singapore-registered Variable Capital Company (VCC) holding LBMA-compliant 1kg physical gold in allocated, segregated Singapore Freeport custody, collateralised against an institutional credit facility deployed into private credit and pre-IPO equity. 100 invitation-only HNW members. Korean primary audience. First close: Q3 2026 (target).

This repo is the operator console: a single application that handles prospect intake, NDA review, subscription, wire reconciliation, member admission, NAV updates, quarterly letters, vault verification publication, capital calls, and Korean-format tax statement generation. Frontend is plain HTML/JS served as static files. Backend is Vercel serverless functions in Node.js ESM. Data lives in Upstash Redis. PDFs and signed documents live in Vercel Blob.

---

## Architecture

- **Frontend** — vanilla HTML/JS. No framework. No build step. Static files at `/`, member pages rendered server-side via `api/doc.js` so we can token-gate them.
- **Backend** — Vercel Functions (Node.js 20+, ESM). Single dispatcher `api/v2.js` routes by `?resource=` and `?op=`. Per-page entry points (`api/login.js`, `api/portfolio.js`, etc.) handle session-bound flows.
- **Storage** — Upstash Redis (REST API, via `@upstash/redis`). Schema documented inline in `api/_lib/storage.js`. In-memory fallback for local dev (data lost on restart).
- **Files** — Vercel Blob for NDA uploads, generated PDFs (member certificates, tax statements, vault verification reports). Signed URLs minted via `api/_lib/signed-url.js`.
- **Email** — Resend (`api/_lib/email.js`). Optional — silently no-ops if `RESEND_API_KEY` not set, so dev works without it.
- **PDFs** — `pdfkit` for member certificates and English statements; `pdf-lib` for templated overlays; Korean tax statements use a vendored Noto Sans KR font (see `NOTO_KR_FONT_URL`).
- **Auth** — `jose` for HS256 JWTs (member + admin sessions, separate cookies). `bcryptjs` cost 12 for member passwords. Admin auth is shared-roster (`ADMIN_USERS` allowlist, `ADMIN_PASSWORD` shared secret) — single founder team, deliberate.
- **Cron** — three Vercel cron jobs (see below).
- **Audit trail** — every state-changing operation appends to a per-lead audit log AND a global audit feed via `appendAudit` / `globalAuditAppend` in `api/_lib/storage.js`. Visible in the admin Activity Feed.

---

## Stack

| Component | Version | Purpose |
|---|---|---|
| Node.js | >=20 | Runtime (set in `package.json#engines`) |
| `@upstash/redis` | ^1.34.0 | Redis client (REST) |
| `@vercel/blob` | ^0.27.0 | File storage |
| `jose` | ^5.9.6 | JWT sign/verify (HS256) |
| `bcryptjs` | ^2.4.3 | Password hashing (cost 12) |
| `nanoid` | ^3.3.7 | Short ID generation |
| `resend` | ^4.0.0 | Transactional email |
| `pdfkit` | ^0.15.0 | PDF generation |
| `pdf-lib` | ^1.17.1 | PDF mutation / templating |

No bundler. No transpiler. No client framework.

---

## File structure

```
NEW TACC/
├── README.md                  ← this file
├── ENVIRONMENT.md             ← env var reference
├── RUNBOOK.md                 ← operator procedures
├── AUTOMATION_ARCHITECTURE.md ← automation internals (existing)
├── package.json               ← deps, ESM, Node >=20
├── vercel.json                ← rewrites, crons, security headers
│
├── index.html                 ← landing
├── interest.html              ← prospect intake form
├── code.html                  ← invite-code entry
├── login.html                 ← member + admin login
├── forgot-password.html       ← password reset request
├── reset-password.html        ← password reset confirm
├── admin.html                 ← admin console (single-page, all tabs)
├── deck.html                  ← pitch deck viewer
├── landing-*.html             ← landing variants (preview routes)
│
├── _pages/                    ← member-gated pages (rendered via api/doc.js)
│   ├── main.html              ← /main — pitch
│   ├── memo.html              ← /memo — long-form
│   ├── nda.html               ← /nda — upload
│   ├── subscription.html      ← /subscription — 12-field form
│   ├── portfolio.html         ← /portfolio — live position
│   ├── documents.html         ← /documents — archive
│   ├── messages.html          ← /messages — inbox
│   └── deals.html             ← /deals — Prism feed (private credit positions)
│
├── _copy/                     ← canonical copy (Korean-aware)
│   ├── main-pitch.md
│   ├── email-templates.md
│   ├── faq.md
│   ├── empty-states.md
│   ├── error-states.md
│   ├── quarterly-letter-template.html
│   └── ko/                    ← Korean translations
│
├── _scripts/
│   └── shared.js              ← shared client JS
│
├── _styles/                   ← shared CSS
│
├── docs/
│   └── AURUM CC 2026 VF.{html,pdf}  ← PPM artifacts
│
└── api/
    ├── v2.js                  ← unified dispatcher (resource/op router)
    ├── login.js               ← member+admin login
    ├── logout.js              ← clears both cookies
    ├── me.js                  ← session probe
    ├── doc.js                 ← gated page renderer
    ├── verify-code.js         ← invite-code → member redemption
    ├── submit.js              ← /interest form intake
    ├── nda.js                 ← NDA upload
    ├── subscription.js        ← subscription form submit
    ├── portfolio.js           ← /api/portfolio (full member object)
    ├── messages.js            ← message read/ack
    ├── admin.js               ← legacy admin (most ops migrated to v2.js)
    ├── bridge.js              ← Prism bridge (deal feed in/out)
    ├── gold.js                ← /api/spot — live spot price
    ├── health.js              ← /api/health — operational probe
    ├── cron.js                ← /api/cron — Vercel cron entry
    │
    └── _lib/
        ├── auth.js            ← JWT, password hashing, code generation
        ├── storage.js         ← Upstash wrapper, Redis schema, all CRUD
        ├── http.js            ← request helpers (cookie, query, body, response)
        ├── email.js           ← Resend wrappers (invitation, wire, etc.)
        ├── blob.js            ← Vercel Blob wrappers (upload, list, delete)
        ├── signed-url.js      ← signed URL minting
        ├── pdf.js             ← member certificate generation
        ├── pdf-tax-kr.js      ← Korean tax statement (Noto Sans KR)
        ├── gold-price.js      ← spot fetch + cache + fallback
        ├── fx.js              ← USD→KRW (and others) rates
        ├── geo.js             ← IP→country
        ├── exceptions.js      ← compliance flag scanner
        ├── audit-runner.js    ← audit append helpers
        ├── error-shape.js     ← recent-errors sorted set
        ├── format.js          ← number/currency formatting
        ├── watermark.js       ← PDF watermarking
        ├── simulation.js      ← demo data generator
        ├── prism-bridge.js    ← HMAC-signed bridge to Prism
        ├── prism-bridge.test.js
        ├── race-tests.js      ← concurrency tests
        └── bots-live.js       ← demo bot/lead generator
```

---

## Routes

### Public (no auth)

| Route | Purpose |
|---|---|
| `/` | Landing |
| `/interest` | Prospect intake form |
| `/code` | Invite-code redemption |
| `/login` | Member + admin login |
| `/forgot-password`, `/reset-password` | Password reset |
| `/setup-password` | First-time password set (post-admission) |
| `/api/public?op=stats` | Member count (cached 60s) |
| `/api/public?op=spot` | Gold spot price (cached 15min) |
| `/api/public?op=countdown` | Days to first close |
| `/api/health` | Operational probe (KV, spot age, FX age, last cron, error counts) |

### Member-gated (cookie `aurum_access`)

| Route | Stage |
|---|---|
| `/main` | Pitch (post-code, pre-NDA) |
| `/memo` | Long-form memo |
| `/nda` | NDA upload |
| `/subscription` | 12-field subscription form |
| `/portfolio` | Live position (post-funded) |
| `/documents` | Document archive |
| `/messages` | Inbox |
| `/deals` | Private credit position feed (Prism bridge) |
| `/api/member/me` | Full member object |
| `/api/member/letters` | Quarterly letters |
| `/api/member/vault-verifications` | Vault reports |
| `/api/member/ack-capital-call` | Capital call acknowledgement |
| `/api/member/tax-statement-signed-url` | Time-limited tax PDF link |
| `/api/member/member-certificate-url` | Member certificate signed URL |

### Admin-gated (cookie `aurum_admin`)

The admin console is `admin.html` — a single page with multiple tabs (Today, Pipeline, Members, Wires, Letters, Vault, Activity, Compliance, Tools). All ops dispatch through `api/v2.js` with `?resource=admin&op=…`. Full op list is enumerated in the rewrites block of `vercel.json`. Notable ops:

| Op | Purpose |
|---|---|
| `approve` | Approve interest lead → issue invite code → email |
| `decline-lead` | Decline pre-funded prospect with reason |
| `nda-approve` / `approve-nda` / `reject-nda` | NDA review |
| `wire-issue` | Issue wire instructions email |
| `wire-received` | Mark wire received at bank |
| `wire-cleared` | Clear wire → admit member (atomic member# assignment) |
| `nav-update` | Push NAV update; regenerates per-member statements |
| `send-quarterly-letter` | Publish letter + notify all funded members |
| `publish-vault-verification` | Upload + broadcast vault report |
| `generate-tax-statement` | Generate Korean-format tax PDF for a member |
| `issue-capital-call` | Broadcast or targeted capital call |
| `capital-call-paid` | Match wire receipt to capital call |
| `add-position` / `update-position` / `remove-position` | Private credit/equity sleeve positions |
| `revoke-access` | Lock funded member's portal (member# preserved) |
| `soft-delete-lead` | Admin queue cleanup (not regulatory) |
| `recount-stages` | Rebuild stage counters |
| `scan-exceptions` | On-demand compliance scan |
| `cmdk-search` | Cmd+K search across leads/audit |

### Cron

Defined in `vercel.json`. Vercel injects `Authorization: Bearer ${CRON_SECRET}` on each invocation; `api/cron.js` validates it.

| Job | Schedule (UTC) | Purpose |
|---|---|---|
| `scan-exceptions` | `0 18 * * *` (daily 18:00) | Compliance flag scan |
| `capital-call-reminders` | `0 1 * * *` (daily 01:00) | T-7d / T-1d / overdue+3d reminders |
| `stale-data-audit` | `0 0 * * 1` (Mondays 00:00) | Recount stage counters, trim error log to 7d window |

---

## Operating environment

| Service | Project | Notes |
|---|---|---|
| Vercel | `tacc` | Frontend + Functions. Production domain points here. Cron schedules live in `vercel.json`. |
| Upstash Redis | provisioned via Vercel Marketplace | KV. `KV_REST_API_URL` / `KV_REST_API_TOKEN` injected automatically. Daily snapshots. |
| Vercel Blob | provisioned via Vercel | File store. `BLOB_READ_WRITE_TOKEN` injected. |
| Resend | tkjintl@gmail.com account | Transactional email. From-address must be on a verified domain. |
| GitHub | `tkjintl/TACC` | Source of truth. Vercel auto-deploys `main` to production. |

Live preview (current build): `https://tacc-he9olk3cs-tkjintls-projects.vercel.app`

---

## Quick start for operator

1. Open the live URL above (or production domain when set).
2. Go to `/login`.
3. Enter your operator email (must be in `ADMIN_USERS` allowlist) + password.

> **WARNING — soft-launch backdoor.** The `ADMIN_PASSWORD` env var defaults to `1234` if not set. This is fine for build/preview but **must be set to a real password before any real prospect sees the platform**. See `ENVIRONMENT.md` → "Production env checklist" item 1. Until then, anyone who guesses an operator email + types `1234` gets full admin access. Confirm `ADMIN_PASSWORD` is set in Vercel → Project Settings → Environment Variables before sending the first invitation.

For day-to-day procedures (onboarding, capital calls, NAV, vault reports, tax statements, emergencies), read `RUNBOOK.md`. For env var setup, read `ENVIRONMENT.md`.

---

## Build & deploy

No build step. Deploy = `git push origin main`.

```bash
# Standard flow
git add -A
git commit -m "ops: <change>"
git push origin main
# Vercel detects the push, builds, and promotes to production.
```

Manual deploy (rare — use only if Vercel auto-deploy is paused):

```bash
vercel deploy --prod
```

Rollback: Vercel → Deployments → pick prior green deployment → "Promote to Production". No data migration concerns since Redis schema is additive.

---

## Health check

```bash
curl https://<domain>/api/health
```

Returns:

```json
{
  "ok": true,
  "kv": "connected" | "offline",
  "spot_usd_oz": 4732.18,
  "spot_age_seconds": 412,
  "spot_stale": false,
  "fx_age_seconds": 1840,
  "last_cron": {
    "scan-exceptions":         1714680000123,
    "capital-call-reminders":  1714683600456,
    "stale-data-audit":        1714521600789
  },
  "recent_errors_5m": 0,
  "recent_errors_1h": 2,
  "now": 1714683612000
}
```

Investigate if any of:
- `kv !== "connected"` — Upstash misconfigured or down. See RUNBOOK §I.
- `spot_stale === true` — gold price feed dead, fallback in use. Check `METALS_API_KEY` / `GOLDAPI_KEY`.
- `recent_errors_5m > 5` — error rate spike. Check Vercel function logs.
- `last_cron.<job>` more than 26h stale (or 8d for `stale-data-audit`) — cron not firing.

---

## License / classification

Confidential. Source code and member data are proprietary to The Aurum Century Club VCC. Platform is operated for the benefit of qualified investors only as defined by the Singapore Securities and Futures Act and the Fund's PPM. No part of this repository constitutes an offer or solicitation. Distribution of source, deployment URLs, member lists, or audit data outside the operator team is a breach of internal compliance policy and may breach Singapore securities regulations.
