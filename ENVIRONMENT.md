# Environment Variables — Reference

Every env var the platform reads, where it's read, who sets it, when it changes, and what breaks if it's missing.

Set everything at: **Vercel → Project (`tacc`) → Settings → Environment Variables**, scoped to **Production** (and Preview if needed). After changing a var, redeploy or use Vercel's "Redeploy" button on the latest production deployment — env changes don't apply to running instances until next cold start.

For procedural use of these vars, see [`RUNBOOK.md`](./RUNBOOK.md). For overall architecture, see [`README.md`](./README.md).

Companion docs:
- [`README.md`](./README.md)
- [`RUNBOOK.md`](./RUNBOOK.md)

---

## Conventions

- **Required** = platform breaks or runs in degraded/insecure mode without it.
- **Optional** = feature degrades gracefully if absent, no security impact.
- **System** = automatically injected by Vercel (you do not set it manually).
- **Operator** = the founder/partner sets it via Vercel dashboard.
- **Engineer** = a developer sets it during build/deploy of related code.

---

## Auth & sessions

### `AURUM_SECRET`

| Field | Value |
|---|---|
| Required | **Yes** |
| Default | `aurum-dev-secret-change-in-prod` (loud console warning) |
| Where used | `api/_lib/auth.js` — HS256 JWT signing for both member and admin sessions |
| Who sets | Operator |
| When set | One-time at setup; rotate on operator change or suspected leak |
| What breaks if missing | Sessions still work but use a known fallback secret — anyone who knows the fallback can forge admin and member tokens. Effectively **no auth in production** if unset. |

Generate with: `openssl rand -base64 48` (or any 32+ byte random string).

Rotation invalidates all live member and admin sessions. After rotation, members must log in again.

### `SESSION_COOKIE_SECRET`

Legacy alias for `AURUM_SECRET`. If both are set, `AURUM_SECRET` wins. Don't set both. Prefer `AURUM_SECRET`.

### `ADMIN_USERS`

| Field | Value |
|---|---|
| Required | **Yes** for production |
| Default | empty (login at `api/login.js` rejects all admin attempts) |
| Where used | `api/login.js` — comma-separated allowlist of admin email addresses |
| Who sets | Operator |
| When set | One-time; updated when adding/removing operators |
| What breaks if missing | No one can log in as admin. |

Format: `tkjintl@gmail.com,partner@example.com` (comma-separated, lowercase preferred, no spaces).

### `ADMIN_PASSWORD`

| Field | Value |
|---|---|
| Required | **Yes** for production |
| Default | `1234` (literal — soft-launch backdoor) |
| Where used | `api/login.js` — shared password checked against any email in `ADMIN_USERS` |
| Who sets | Operator |
| When set | Before launch; rotate quarterly or on operator change |
| What breaks if missing | Default `1234` is in effect — anyone who guesses a real operator email + types `1234` gets admin. **Treat the platform as compromised** until this is set to a real password. |

> **CRITICAL.** The `1234` default exists so we can run preview deploys and demo flows without fumbling secrets. It is **never acceptable** in front of a real prospect. The first item in the launch checklist below is "rotate this." See RUNBOOK §I if you suspect compromise.

---

## Storage

### `KV_REST_API_URL`

| Field | Value |
|---|---|
| Required | **Yes** for production |
| Default | empty (in-memory fallback engages with a loud warning; data lost on cold start) |
| Where used | `api/_lib/storage.js`, `api/_lib/error-shape.js`, `api/_lib/fx.js`, `api/_lib/gold-price.js`, `api/health.js` |
| Who sets | System (auto-injected by Vercel ↔ Upstash Marketplace integration) |
| When set | Once, when Upstash KV is provisioned via Vercel Marketplace |
| What breaks if missing | All persistence is in-memory. Every cold start wipes leads, audit log, capital calls, vault reports, sessions, rate limits — i.e. **the platform is unusable**. |

### `KV_REST_API_TOKEN`

Same provenance and impact as `KV_REST_API_URL`. Both are required to talk to Upstash.

### `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`

Aliases. Some Upstash docs use these names. Code reads either pair. If the marketplace integration sets `KV_*`, you don't need to set these.

### `BLOB_READ_WRITE_TOKEN`

| Field | Value |
|---|---|
| Required | **Yes** for production |
| Default | empty (`api/_lib/blob.js#hasBlobToken()` returns false → uploads/list/delete throw) |
| Where used | `api/_lib/blob.js` (NDA upload, generated PDFs, signed URLs) |
| Who sets | System (auto-injected by Vercel when Blob storage is enabled on the project) |
| When set | Once at Blob provisioning |
| What breaks if missing | NDA uploads fail. Tax statement, member certificate, and vault verification PDFs cannot be persisted or served. Member portal "Documents" section is empty. |

---

## Email

### `RESEND_API_KEY`

| Field | Value |
|---|---|
| Required | Optional (no-op without) |
| Default | empty |
| Where used | `api/_lib/email.js` |
| Who sets | Operator |
| When set | Before first real invitation; rotate annually |
| What breaks if missing | All `send*` functions silently no-op (logged at warn). Invitations, wire instructions, NDA approvals, admission emails, capital call notices, quarterly letter notifications, vault verification notifications — none send. The state changes still apply; only the notification email is dropped. |

Verify a sending domain in Resend before going live. Free tier rate limit is per-second; capital call broadcasts to 100 members can hit it (RUNBOOK §I.4).

### `RESEND_FROM_ADDRESS`

| Field | Value |
|---|---|
| Required | Optional |
| Default | (hardcoded in `api/_lib/email.js`) |
| Where used | `api/_lib/email.js` — From: header on every send |
| Who sets | Operator |
| When set | When sending domain is finalised |
| What breaks if missing | Falls back to whatever the email module hardcodes. Confirm before launch. |

### `NOTIFY_EMAILS`

| Field | Value |
|---|---|
| Required | Optional |
| Default | empty |
| Where used | `api/_lib/email.js` — internal BCC for ops alerts |
| Who sets | Operator |
| When set | At setup |
| What breaks if missing | No internal copy of operational emails. Recommend setting to operator email so you have a thread record. |

---

## Site

### `SITE_URL`

| Field | Value |
|---|---|
| Required | **Yes** for production email links |
| Default | `https://www.theaurumcc.com` (hardcoded fallback in multiple files) |
| Where used | All email link generation, `api/_lib/email.js`, `api/_lib/pdf.js`, `api/_lib/pdf-tax-kr.js`, `api/_lib/signed-url.js`, `api/v2.js` (multiple) |
| Who sets | Operator |
| When set | When production domain is final |
| What breaks if missing | Email CTAs and PDF footer links point to the hardcoded fallback. If the real domain is different, every "Click to log in" link in every email is broken. |

**No trailing slash.** Code concatenates paths with `/`; a trailing slash produces double-slash links.

### `TARGET_CLOSE_DATE`

| Field | Value |
|---|---|
| Required | Optional |
| Default | empty (countdown returns `null`) |
| Where used | `api/v2.js` → `publicCountdown` (`/api/public?op=countdown`) |
| Who sets | Operator |
| When set | When close date is set; updated if close shifts |
| What breaks if missing | Public countdown widget on the landing/code/main pages shows nothing. |

ISO date or full ISO timestamp. Example: `2026-09-30` or `2026-09-30T16:00:00+08:00`.

---

## Gold pricing

### `METALS_API_KEY`

| Field | Value |
|---|---|
| Required | Optional (recommended) |
| Default | empty |
| Where used | `api/_lib/gold-price.js` — primary spot source |
| Who sets | Operator |
| When set | At setup |
| What breaks if missing | Falls through to `GOLD_API_KEY`, then to fallback price. NAV displays drift from market. |

### `GOLD_API_KEY`

| Field | Value |
|---|---|
| Required | Optional (backup) |
| Default | empty |
| Where used | `api/_lib/gold-price.js` — secondary spot source |
| Who sets | Operator |
| When set | At setup |
| What breaks if missing | If `METALS_API_KEY` also fails, falls to `GOLD_SPOT_FALLBACK`. |

### `GOLD_SPOT_FALLBACK`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `4700` (USD/oz) |
| Where used | `api/_lib/gold-price.js` — last-resort price when both APIs fail |
| Who sets | Operator |
| When set | Update quarterly to current market level so a feed outage doesn't show a stale price |
| What breaks if missing | Default of $4,700 is used. If market diverges materially, members see a wrong NAV during feed outages. |

### `GOLD_MARKUP_PCT`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `3.0` (percent) |
| Where used | `api/_lib/gold-price.js` — markup applied to spot when computing physical 1kg cost basis |
| Who sets | Operator |
| When set | When refiner pricing is renegotiated |
| What breaks if missing | Default 3% applied. Set to actual blended refiner+freight markup. |

### `VAULT_TRACKING_MODE`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `vault` |
| Where used | `api/_lib/gold-price.js` — `getVaultMode()` |
| Who sets | Operator |
| When set | If vault tracking is replaced by bank custody or vice versa |
| What breaks if missing | Default `vault` mode. Set to `bank` only if a banking custodian replaces Malca-Amit. |

Values: `vault` | `bank`.

---

## Fund identity

### `AURUM_VCC_UEN`

| Field | Value |
|---|---|
| Required | **Yes** before any real PDF goes to a prospect |
| Default | `[VCC UEN NOT SET]` placeholder string |
| Where used | `api/_lib/pdf.js` (member certificates), `api/_lib/pdf-tax-kr.js` (Korean tax statements) |
| Who sets | Operator |
| When set | Once VCC registration is issued by ACRA |
| What breaks if missing | All generated PDFs print the placeholder text in the issuer block. Member certificates and tax statements look unprofessional and may be rejected by Korean tax counsel. |

---

## Wire instructions

These four populate the wire-issue email and the subscription page wire panel. All four are read in `api/_lib/email.js` and `api/v2.js` (capital-call issuance + wire-issue op).

### `WIRE_BANK_NAME`

| Field | Value |
|---|---|
| Required | **Yes** before first real wire |
| Default | empty → email shows `[WIRE_BANK_NAME not set]` literal |
| Who sets | Operator |
| When set | When fund administrator's bank account is opened |
| What breaks | Wire instructions email is unusable (placeholder visible). Member can't wire. |

### `WIRE_ACCOUNT_NAME`

Same as above. Beneficiary name on the receiving account.

### `WIRE_ACCOUNT_NUMBER`

Same. Account number / IBAN.

### `WIRE_SWIFT`

Same. SWIFT/BIC.

### `WIRE_REFERENCE_PREFIX`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `TACC` |
| Where used | `api/_lib/email.js`, `api/v2.js` — generates per-member wire reference (`TACC-<member#>` or `TACC-<lead-id>`) |
| Who sets | Operator |
| When set | At setup |
| What breaks if missing | Default `TACC` used. Wire matching by reference still works. |

---

## Email signoff

### `PARTNER_NAME`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `The Aurum Team` |
| Where used | `api/_lib/email.js` — signature block on outgoing emails |
| Who sets | Operator |
| When set | At setup |
| What breaks if missing | Generic signoff. Personal touch lost. |

### `PARTNER_TITLE`

| Field | Value |
|---|---|
| Required | Optional |
| Default | empty |
| Where used | `api/_lib/email.js` — line under partner name |
| Who sets | Operator |
| When set | At setup |
| What breaks if missing | Title line omitted. |

---

## Prism bridge

The Prism bridge lets the deal-feed (private credit positions) sync from Prism into the `/deals` member page.

### `PRISM_BRIDGE_ENABLED`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `false` (disabled) |
| Where used | `api/_lib/prism-bridge.js` — gate flag |
| Who sets | Operator |
| When set | When Prism is live and ready to feed positions |
| What breaks if missing | `/deals` page returns empty / placeholder data. Members see no private-credit position list. |

Value must be the literal string `true` to activate.

### `PRISM_TACC_BRIDGE_SECRET`

| Field | Value |
|---|---|
| Required | **Yes** if `PRISM_BRIDGE_ENABLED=true` |
| Default | empty (bridge requests rejected) |
| Where used | `api/_lib/prism-bridge.js` — HMAC shared secret with Prism |
| Who sets | Operator (must match the value set in Prism's env) |
| When set | One-time when bridge is enabled; rotate annually |
| What breaks if missing | Bridge requests are rejected with HMAC mismatch. Deal feed stays empty. |

### `PRISM_SITE_URL`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `https://prism.theaurumcc.com` |
| Where used | `api/_lib/prism-bridge.js` — outbound URL when calling Prism |
| Who sets | Operator |
| When set | If Prism is hosted at a non-default domain |
| What breaks if missing | Default used. Override only if Prism domain is non-standard. |

---

## PDF / fonts

### `NOTO_KR_FONT_URL`

| Field | Value |
|---|---|
| Required | Optional |
| Default | falls back to GitHub raw URL hardcoded in `api/_lib/pdf-tax-kr.js` |
| Where used | `api/_lib/pdf-tax-kr.js` — Korean tax statement renderer |
| Who sets | Engineer (or operator if hosting font on own CDN) |
| When set | If GitHub raw becomes unreliable; pin to own CDN |
| What breaks if missing | Default URL used. If GitHub raw is rate-limited or down, Korean tax PDFs fail to render with Korean glyphs. |

---

## Operations

### `DEV_MODE`

| Field | Value |
|---|---|
| Required | Optional |
| Default | `false` |
| Where used | `admin.html` (client-side) — shows the "Tools" dropdown (wipe audit, regenerate demo data, recount stages) |
| Who sets | Operator |
| When set | `true` during build/QA, `false` (or unset) for production |
| What breaks if changed | If `true` in production: a one-click "Wipe audit log" button is visible to anyone who logs in as admin. If `false`: the destructive tools are hidden and have to be invoked manually via the API. |

> **Set to `false` (or unset) in production.** Keep `true` only on preview deployments or during initial setup.

### `CRON_SECRET`

| Field | Value |
|---|---|
| Required | **Yes** for production |
| Default | empty (cron auth disabled — anyone hitting `/api/cron` can run jobs) |
| Where used | `api/cron.js` — `Authorization: Bearer ${CRON_SECRET}` check |
| Who sets | System (Vercel auto-injects when Cron is enabled on the project) |
| When set | Automatically on first cron schedule |
| What breaks if missing | Cron endpoint accepts unauthenticated requests. Outsider can trigger `scan-exceptions`, generate reminder spam, or recount stages. Not catastrophic but undignified. |

Vercel sets this automatically; you don't normally touch it. If you ever explicitly set it, copy the value Vercel uses (visible under Project Settings → Cron).

### `NODE_ENV`

| Field | Value |
|---|---|
| Required | (auto-set by Vercel) |
| Default | `production` on production deploys, `development` locally |
| Where used | `api/_lib/auth.js` (`Secure` cookie flag), `api/_lib/http.js`, `api/_lib/prism-bridge.js` |
| Who sets | System |
| When set | Per-build |
| What breaks if changed | If forced to `development` in production, session cookies lose the `Secure` flag and can be sent over plain HTTP. Don't override. |

---

## Production env checklist

Before sending the first invitation to a real prospect, verify each of the following in **Vercel → Project (`tacc`) → Settings → Environment Variables → Production scope**:

1. **`ADMIN_PASSWORD`** is set to a strong random password (not `1234`). Confirm by attempting login with `1234` — it must fail.
2. **`ADMIN_USERS`** lists exactly the operator emails who should have admin access. No leftover dev addresses.
3. **`AURUM_SECRET`** is set to a 32+ byte random value. Confirm `/api/health` does not warn about fallback secret in function logs.
4. **`KV_REST_API_URL`** and **`KV_REST_API_TOKEN`** present (or `UPSTASH_REDIS_REST_URL` / `_TOKEN`). `/api/health` returns `"kv": "connected"`.
5. **`BLOB_READ_WRITE_TOKEN`** present. Test by uploading a dummy NDA via `/nda` as a test member — file should land in Vercel Blob.
6. **`RESEND_API_KEY`** set, with verified sending domain. Send a test invitation to your own address.
7. **`RESEND_FROM_ADDRESS`** matches the verified sending domain.
8. **`SITE_URL`** is the production domain, no trailing slash. Click any email CTA — the link must resolve to production, not preview.
9. **`AURUM_VCC_UEN`** is the actual ACRA-issued UEN. Generate a test member certificate; UEN appears in the issuer block.
10. **`WIRE_BANK_NAME`**, **`WIRE_ACCOUNT_NAME`**, **`WIRE_ACCOUNT_NUMBER`**, **`WIRE_SWIFT`** are all set with the real fund administrator banking. Generate a test wire-instructions email; all four populate.
11. **`WIRE_REFERENCE_PREFIX`** confirmed (`TACC` is fine; only change if the fund administrator requires another).
12. **`PARTNER_NAME`** and **`PARTNER_TITLE`** set so emails sign properly.
13. **`TARGET_CLOSE_DATE`** set to the actual first-close date.
14. **`METALS_API_KEY`** (and `GOLD_API_KEY` as backup) set. `/api/health` returns `spot_stale: false`.
15. **`GOLD_SPOT_FALLBACK`** updated to within ~5% of current market.
16. **`DEV_MODE`** unset (or `false`). Log in as admin and confirm the "Tools" dropdown is hidden.
17. **`CRON_SECRET`** auto-injected (visible in Vercel Cron settings). `/api/health` shows recent `last_cron` timestamps within expected windows after 24h.
18. **`PRISM_BRIDGE_ENABLED`** — only set to `true` if Prism is live; otherwise leave unset. If `true`, **`PRISM_TACC_BRIDGE_SECRET`** must match Prism's value.
19. **`NOTIFY_EMAILS`** set to the operator address so a copy of every transactional email is captured.
20. Redeploy after final env changes — env var updates do not take effect on existing function instances until next cold start.

Confirm each item by ticking it off in person. The default values fail closed in some cases (no email, empty PDF text) but fail open in others (admin password `1234`). Do not assume "it works" means "it's safe."
