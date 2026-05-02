# Operator Runbook

Step-by-step procedures for running TACC. Match each step against the admin console (`/admin`) tabs and ops listed in [`README.md`](./README.md). For env vars referenced here, see [`ENVIRONMENT.md`](./ENVIRONMENT.md).

This document is operational. Read it the first time end-to-end. Re-read the relevant section every time you do that procedure until it's automatic.

Companion docs:
- [`README.md`](./README.md) — architecture, routes, stack
- [`ENVIRONMENT.md`](./ENVIRONMENT.md) — env var reference

---

## Table of contents

- [A. Onboard a new prospect end-to-end](#a-onboard-a-new-prospect-end-to-end)
- [B. Handle a declined NDA](#b-handle-a-declined-nda)
- [C. Issue a capital call](#c-issue-a-capital-call)
- [D. Publish quarterly letter + NAV update](#d-publish-quarterly-letter--nav-update)
- [E. Publish a vault verification report](#e-publish-a-vault-verification-report)
- [F. Generate a tax statement (Korean)](#f-generate-a-tax-statement-korean)
- [G. Decline a lead vs revoke access vs soft delete](#g-decline-a-lead-vs-revoke-access-vs-soft-delete)
- [H. Backup & restore](#h-backup--restore)
- [I. Emergency procedures](#i-emergency-procedures)
- [J. Daily / weekly / monthly / annual routine](#j-daily--weekly--monthly--annual-routine)

---

## A. Onboard a new prospect end-to-end

The full pipeline: lead → invitation → NDA → subscription → wire → admission → portal access. Eleven steps. Each has a recovery path if it goes wrong.

### A.1 Prospect submits at `/interest`

The prospect fills the interest form. Form posts to `api/submit.js`, which:

- Rate-limits by IP (3 submissions / hour, see `isRateLimited` in `api/_lib/storage.js`).
- Creates a lead record with stage `interest`.
- Indexes the lead by email and ID.
- Appends to the audit log.

You're notified by seeing the new lead appear in the **Today** tab and **Pipeline → Interest** column.

**What can go wrong:**
- *Rate limit triggered* — same IP tried 3+ times in an hour. The submission silently fails (UX: form looks like it worked but no record). Mitigation: Pipeline scan won't show them. If a known prospect reports they didn't get an invitation, ask them to retry in an hour from a different network.
- *Email already exists* — `findLeadByEmail` returns a hit; the submission updates the existing record rather than creating a duplicate. No data loss; check the existing lead.

### A.2 Admin reviews the lead

In `/admin` → **Pipeline** tab → click the lead card. The **Lead Detail** drawer opens (op: `lead-detail`).

Review:
- Self-reported AUM band, source of wealth, country of residence, profession.
- Investment thesis answer (free-text from the form).
- Referral source.
- Any compliance flags already attached (e.g., sanctioned-country IP from `api/_lib/geo.js`).

**Decision:** Approve or Decline.

### A.3 Approve and issue code (or Decline)

**To approve:**
- Click **Approve** in the lead drawer. Calls `op=approve`.
- Server generates a 6-char code via `generateCode()` (alphabet excludes O/0/I/1/L), binds it to the lead with `bindCode`, transitions stage `interest` → `code_issued`, and triggers `sendInvitation` email.
- Email contains the code, a link to `/code`, and Korean translation if the lead's locale is `ko`.

**To decline:**
- Click **Decline**. A reason field is required (op: `decline-lead`).
- Lead transitions to `declined` stage. No email is sent (deliberate — declining silently is the right behaviour for cold prospects).
- The lead remains in the system for the audit trail. To remove from the active queue, soft-delete (see §G).

**What can go wrong:**
- *Email send fails* — Resend down, domain unverified, rate-limited. Approve op succeeds; email fails; lead is in `code_issued` state but the prospect doesn't have the code. Recovery: open the lead in admin, copy the code from the lead detail panel, send manually. Or: temporarily flip the lead back to `interest` and re-approve once Resend is fixed (use `recount-stages` afterward). The cleaner fix is **op: `resend-admission`** if available, or send the code via personal email.
- *Wrong email address on the lead* — happens. Edit the lead's email field directly in admin (if UI exposes it), or contact the prospect on their actual channel and tell them the code.

### A.4 Member receives invitation, enters code at `/code`

The prospect clicks the email link, lands on `/code`, types the 6 characters. `api/verify-code.js`:

- Looks up `lead_code:{code}` → lead ID.
- Issues an `aurum_access` JWT cookie (12h default TTL).
- Transitions stage `code_issued` → `code_redeemed`.
- Redirects to `/main`.

**What can go wrong:**
- *Code expired or revoked* — codes don't expire automatically, but if the lead was soft-deleted or revoked, the binding is gone. The user sees a "code not recognised" error. Recovery: re-approve the lead.
- *Wrong code typed* — `O/0/I/1/L` are not in the alphabet, so common confusions are eliminated. If they still type wrong: just re-enter.

### A.5 Member visits `/main`, reads pitch, proceeds to `/nda`

`/main` is the long-form pitch (rendered via `api/doc.js?id=program-page`). Member reads, then clicks the NDA CTA.

`/nda` shows the NDA download + an upload widget for the signed PDF.

### A.6 Member uploads NDA at `/nda`

The signed NDA is uploaded via `api/nda.js` to Vercel Blob. The lead transitions to `nda_pending`.

You're notified by the **Today** tab → **NDA Pending** queue and **Pipeline → NDA Pending** column count.

**What can go wrong:**
- *Upload fails* — Blob token missing, file too large, network. Member sees an error; lead stays in `code_redeemed`. Check `BLOB_READ_WRITE_TOKEN` in env. Ask the member to retry.

### A.7 Admin reviews NDA — approve or reject

In `/admin` → **Pipeline** → click the NDA Pending lead → drawer shows the uploaded PDF. Open it in a new tab.

Verify:
- Signed by the named individual on the lead record.
- All pages signed/initialled per template.
- Date is current.
- Beneficial owner declarations match the interest form answers.

**To approve:**
- Click **Approve NDA**. Op: `nda-approve` (also exposed as `approve-nda`). Stage transitions `nda_pending` → `nda_approved`. Email confirmation is sent.

**To reject:**
- Click **Reject NDA**. A reason field is required. Op: `reject-nda`. Stage transitions back to `code_redeemed` (so the member can re-upload). Reason is included in the rejection email.

See §B for what happens after rejection.

### A.8 Member visits `/subscription`, fills 12 fields, submits

After NDA approval, the member can access `/subscription`. The form (`api/subscription.js`) collects:

1. Full legal name
2. Date of birth
3. Nationality
4. Tax residency (and Korean RRN if KR)
5. Passport number
6. Permanent address
7. Mailing address
8. Source of funds declaration
9. Subscription amount (USD)
10. Beneficial owner confirmation
11. PEP / sanctions self-declaration
12. Korean FX-reporting self-attestation (if KR resident)

On submit, lead transitions to `subscription_submitted`. The subscription payload is stored on the lead record.

**What can go wrong:**
- *Field validation* — front-end validates before POST. If something gets through and the API rejects it, the member sees an error and the form stays filled. They retry.
- *Concurrent edit* — unlikely (single member, single tab). If somehow the lead record changes mid-submit, the lead saves with last-write-wins.

### A.9 Admin issues wire instructions

In `/admin` → **Pipeline** → click the lead in the Subscription Submitted column → **Issue Wire**. Op: `wire-issue`.

Server:
- Generates a per-member wire reference: `{WIRE_REFERENCE_PREFIX}-{lead.id}` (or member# if already assigned, but at this stage it isn't).
- Composes the wire instructions email using `WIRE_BANK_NAME`, `WIRE_ACCOUNT_NAME`, `WIRE_ACCOUNT_NUMBER`, `WIRE_SWIFT`.
- Sends via `sendWireInstructions`.
- Stage transitions `subscription_submitted` → `wire_issued`.

The email tells the member: amount, bank, beneficiary, account number, SWIFT, reference (must quote), deadline.

**What can go wrong:**
- *Wire fields not set in env* — the email will literally show `[WIRE_BANK_NAME not set]` etc. Catch this BEFORE sending. Confirm all four wire env vars are populated (see ENVIRONMENT.md production checklist). If you sent with placeholders, follow up immediately with the corrected wire details.

### A.10 Wire arrives at bank — admin marks "Wire Received"

When the fund administrator confirms wire receipt at the bank (typically by email or portal), open `/admin` → **Wires** tab → find the lead by reference → **Mark Received**. Op: `wire-received`.

This is a soft confirmation. It doesn't yet admit the member. It records the bank's acknowledgement and exposes the wire on the dashboard for partner sign-off.

### A.11 Wire clears — admin marks "Cleared & Admit"

Once the wire is cleared (funds available, not just received), click **Mark Cleared & Admit**. Op: `wire-cleared`.

Server (atomically):
- Finds the next available member# (1–100). The check uses `isMemberNumberTaken` and the assignment is wrapped in `withIdempotency` to prevent two operators double-assigning.
- Calls `markMemberFunded(leadId, memberNumber)`.
- Stage transitions `wire_issued` → `funded`.
- Generates the member certificate PDF (`generateMemberCertificate`) and stores it in Blob.
- Sends `sendFundedConfirmation` email containing:
  - Confirmation of admission
  - Assigned member# (1–100)
  - Setup-password link to `/setup-password`

### A.12 Member sets password, logs in, sees portfolio

The member clicks the setup-password link, sets a password (bcrypt cost 12 hash stored on the lead record), and is redirected to `/login`. They log in with email + password — `api/login.js` issues a fresh `aurum_access` cookie.

`/portfolio` now renders with:
- Member# in the header
- Live gold position (kg held, bar serials, cost basis, current spot)
- Two-engine NAV (gold + credit/equity sleeve)
- Capital calls (none yet)
- Documents (member certificate, NDA, vault verification reports as published)

**What can go wrong:**
- *Setup-password link expired* — links carry a JWT with limited TTL. If the member sits on it for too long, they need a fresh link. Op: `resend-admission` re-sends the admission email with a fresh link.
- *Member sees `/portfolio` empty* — check `findLeadByEmail` returns the funded lead, and that the lead has `member_number` set. If counters are wrong, run op: `recount-stages`.

---

## B. Handle a declined NDA

### B.1 Reject the NDA

In `/admin` → **Pipeline** → NDA Pending → click lead → **Reject NDA**. Provide a reason (this is required). Op: `reject-nda`.

**Common reasons:**
- "Signature missing on page X"
- "Beneficial owner declaration inconsistent with interest form"
- "Outdated NDA template — please re-download from /nda"
- "Date older than 30 days"

### B.2 What the member sees

The member receives an email containing the rejection reason. Their lead reverts to `code_redeemed`. They can return to `/nda` and re-upload.

The previous (rejected) PDF remains in Blob with a versioned blob path so the audit trail preserves the original. The new upload overwrites the canonical pointer on the lead record but does not delete the prior file.

### B.3 Follow up

If the member doesn't re-upload within 7 days, send a personal email (outside the platform) checking they understood the issue. The platform doesn't send NDA-pending nudges automatically. Track manually until we wire that.

> **Gap (operator to fill):** there is currently no automated nudge for stalled NDA re-uploads. If we want one, it's a cron addition to `api/cron.js` similar to capital-call reminders.

---

## C. Issue a capital call

Capital calls are fund-level events. Two flavours: **broadcast** (to all funded members) or **targeted** (a subset).

### C.1 Compose the capital call

In `/admin` → **Members** tab → **Issue Capital Call** button. Op: `issue-capital-call`. Required fields:

- **Reference** — short ID (e.g., `CC-2026Q4-01`). Becomes the wire reference suffix.
- **Amount per member (USD)** OR **Aggregate amount + pro-rata mode**. (The form computes per-member based on each member's commitment.)
- **Purpose** — narrative that goes into the email and member portal notice.
- **Due date** — used by the reminder cron.
- **Recipients** — "All funded" or a checkbox list.

On submit, server:
- Creates a capital call record on each recipient lead via `addCapitalCall`.
- Sends a notification email per recipient.
- Stage on the lead is unchanged (still `funded`).

### C.2 Member acknowledges

Members see the capital call in `/portfolio` and `/messages`. They click **Acknowledge**. Op: `member&op=ack-capital-call` updates the call's `acknowledged_at` and stops further reminders.

### C.3 Wire receipt — match by reference

When a member's wire arrives for the capital call, open `/admin` → **Wires** tab → find by reference → **Mark Capital Call Paid**. Op: `capital-call-paid`. The capital call's status flips to `paid`.

### C.4 Reminders

The `capital-call-reminders` cron runs daily at 01:00 UTC (`vercel.json`). For each unpaid, unacknowledged capital call with a `due_date`:

- T-7 days: reminder email.
- T-1 day: reminder email.
- Overdue: reminder every 3 days indefinitely until paid.

To stop reminders without payment (e.g., capital call cancelled), mark it paid manually or remove the call (op for removal: not currently exposed in admin UI — gap for operator).

> **Gap (operator to fill):** no UI op for "cancel capital call." If you need to cancel, the only clean path is to mark all instances paid with an internal note. Add a cancel op if this becomes a real need.

---

## D. Publish quarterly letter + NAV update

This is two distinct operations that are often run together.

### D.1 NAV update

`/admin` → **Today** or **Members** → **Update NAV**. Op: `nav-update`. Required:

- New gold price per oz (or auto-pull from `api/_lib/gold-price.js`).
- New value of credit/equity sleeve (manual, since these are private positions — input by the operator from the latest sleeve report).
- As-of date.

Server:
- Updates fund-level NAV.
- Per-member statements are regenerated (gold component recomputed against bar inventory; sleeve component pro-rated).
- A notification email is queued (one per member) — see §D.3 for whether to publish letter at the same time or send NAV-only.

### D.2 Quarterly letter

`/admin` → **Letters** tab → **New Letter**. The editor uses the `_copy/quarterly-letter-template.html` template. Sections:

- Quarter / year
- Executive summary
- Gold position update (auto-filled from current bar registry)
- Credit & equity sleeve update (manual narrative)
- Vault custody status
- Manager's conditions narrative
- Outlook

Preview (renders the template). Then **Publish**. Op: `send-quarterly-letter`.

Server:
- Stores letter via `addQuarterlyLetter` per recipient (all funded members).
- Sends `sendQuarterlyLetterNotification` email per recipient.
- Read receipts: each member's letter has `read_at: null` until they hit `mark-letter-read` (auto-fired when they open it in `/portfolio` Documents).

### D.3 Read receipts

`/admin` → **Letters** tab → click a published letter → see read/unread by member. Op: `read-receipt` (admin) and `mark-letter-read` (member).

Use this to follow up with members who haven't read after 14 days. The platform doesn't auto-nudge unread letters.

> **Gap (operator to fill):** no auto-nudge for unread letters. Manual follow-up only.

---

## E. Publish a vault verification report

Quarterly minimum. The report is the independent physical inspection signed by Malca-Amit (or whichever inspection party is contracted).

### E.1 Receive the signed report

The vault verification report (PDF) arrives by email from Malca-Amit. Verify:
- Date is recent (within 30 days).
- Bar serial list matches the fund's current bar registry.
- Inspector signature present.
- Insurance certification reference present.

### E.2 Publish

`/admin` → **Vault** tab → **Publish Vault Verification**. Op: `publish-vault-verification`. Upload the signed PDF. Server:

- Stores PDF in Vercel Blob.
- Calls `broadcastVaultVerification` — adds the verification record to every funded member's `/portfolio` Documents section.
- Sends `sendVaultVerificationNotification` to each funded member.
- Records `setLastVaultVerification` so `/api/health` and admin dashboard can show "last verification: N days ago."

### E.3 Audit trail

After publish, check `/admin` → **Activity** tab. The publish action appears with:
- actor: your operator email
- action: `publish_vault_verification`
- target: the verification ID
- recipient count

If recipient count ≠ funded member count, run op: `recount-stages` and re-broadcast.

---

## F. Generate a tax statement (Korean)

Annual operation, primarily for KR-resident members for NTS filing. Output is a Korean-language PDF (Noto Sans KR font).

### F.1 Open the member

`/admin` → **Members** → click member → **Generate Tax Statement** button. Op: `generate-tax-statement`. Required inputs:

- **Fiscal year** (e.g., 2026)
- **Period start gold price (USD/oz)** — typically Jan 1 of the year, or member's entry price if mid-year
- **Period end gold price (USD/oz)** — typically Dec 31
- **KRW FX rate** for end-of-period valuation
- **Member's RRN** (auto-filled from subscription record if KR resident)

### F.2 Render

Server (in `api/_lib/pdf-tax-kr.js`):
- Loads Noto Sans KR from `NOTO_KR_FONT_URL` (or fallback).
- Composes a Korean-format tax statement with member identity, fund identity (`AURUM_VCC_UEN`), period gain/loss in KRW, fee deductions, and statutory disclaimers.
- Stores PDF in Blob.
- Calls `saveTaxStatementUrl(leadId, fiscalYear, urlOrRecord)` to persist the pointer on the lead record.

### F.3 Member access

The member sees a new entry in `/portfolio` → Documents → "{Year} Tax Statement (KO)". Clicking calls `member&op=tax-statement-signed-url`, which mints a short-TTL signed URL via `api/_lib/signed-url.js`.

### F.4 Operator access

`/admin` op: `tax-statement-signed-url` mints the same kind of signed URL for operator review.

### F.5 Run cadence

Annually, in late January, for every KR-resident funded member. Track in **Members** tab — filter by tax residency = KR, then iterate.

> **Gap (operator to fill):** no batch "generate all KR tax statements for fiscal year X" op. Currently manual per-member. If KR member count grows past ~20, add a batch op.

---

## G. Decline a lead vs revoke access vs soft delete

Three different actions. Don't confuse them.

| Action | When to use | Effect | Reversible? |
|---|---|---|---|
| **Decline** (`decline-lead`) | Pre-funded prospect we don't want | Stage → `declined`. No email. Audit logged. | Yes — re-approve restores |
| **Revoke access** (`revoke-access`) | Funded member loses portal (e.g., compliance issue, regulatory escalation, request) | Login disabled. Member# **preserved** (financial record retention). Lead marked `access_revoked: true`. Audit logged. Capital position unchanged. | Yes — restore via lead edit (gap: no UI op for restore yet) |
| **Soft delete** (`soft-delete-lead`) | Admin queue cleanup — duplicate, spam, accidental submission | Lead `deleted_at` timestamp set. Hidden from active queues. **Not** a regulatory deletion — record persists for audit. | Yes — clear `deleted_at` (no UI op currently) |

**Critical:** `revoke-access` does NOT delete the member's financial record. Singapore VCC and tax retention requirements mean we keep the record, the bar serials, the wire history, and all PDFs even after revocation. The portal is just locked.

> **Gap (operator to fill):** no UI ops for "restore from soft-delete" or "restore revoked access." Currently must edit the lead record directly via admin Tools (only visible if `DEV_MODE=true` — keep this off in prod) or via a one-off API call. If restoration becomes routine, expose ops.

---

## H. Backup & restore

### H.1 What's backed up by default

| Data | Backup mechanism | Frequency |
|---|---|---|
| Upstash Redis (all KV state — leads, capital calls, audit log, sessions) | Upstash automatic snapshots | Daily |
| Vercel Blob (NDA uploads, generated PDFs) | Vercel Blob durability (multi-zone) | Continuous |
| Source code | GitHub `tkjintl/TACC` | On every push |
| Env vars | Vercel project settings | Stored encrypted; backed up by Vercel |

### H.2 Manual exports (recommended weekly)

Pull env vars to a local encrypted file:

```bash
vercel env pull .env.production.backup
# Move .env.production.backup to encrypted storage. Do NOT commit.
```

Export all leads (manual, for DR rehearsal):
- Run a script that calls `listLeads({ limit: 200 })` from `api/_lib/storage.js` and writes the result to JSON.
- Store the JSON in encrypted offline storage.

> **Gap (operator to fill):** there is no built-in "export all data" op. For a real DR strategy, write a small script (5–10 lines) that iterates `listLeads`, `globalAuditList`, and `listDeals` and dumps to disk. Run weekly. Add to the `_scripts/` folder when written.

### H.3 Restore from Upstash snapshot

Upstash snapshots are managed in the Upstash console (not Vercel). Procedure:

1. **Stop new writes.** Pause Vercel cron schedules in `vercel.json` and redeploy. Optionally take the admin login offline by adding a maintenance flag.
2. **Open Upstash console** → your KV instance → **Backup** tab.
3. Pick a snapshot timestamp. Confirm the timestamp pre-dates the issue you're recovering from.
4. **Restore** — Upstash will overwrite current state with the snapshot.
5. After restore: redeploy the project to flush function caches. Run op: `recount-stages` to rebuild stage counters from the restored data.
6. Verify: `/api/health` returns `kv: connected`, `recount-stages` returned counts that match expectation.

**Data lost in restore:** anything written between the snapshot timestamp and now. If you took a snapshot at 00:00 and restore at 14:00, fourteen hours of lead intake / capital call updates / audit records are gone. Communicate to affected members and re-issue if needed.

### H.4 Restore Vercel Blob files

Blob deletes are permanent unless you have a separate copy. Standard practice:

- Critical files (member certificates, vault verification reports, signed NDAs) should be downloaded to encrypted offline storage as soon as published. Build this into the procedure (§E.3, §A.11).
- If a blob is accidentally deleted, regenerate (member certificate via re-running funded-flow), or re-upload from offline copy.

---

## I. Emergency procedures

### I.1 Compromised admin credential

**Indicators:** unexpected logins in audit log, ops you didn't authorise, member emails complaining about wrong messages, unfamiliar admin email in `ADMIN_USERS`.

**Immediate actions:**
1. **Rotate `AURUM_SECRET`** in Vercel env. This invalidates ALL active sessions (member + admin). Everyone has to log in again.
2. **Rotate `ADMIN_PASSWORD`** to a fresh strong value.
3. **Audit `ADMIN_USERS`** — remove anything unfamiliar.
4. **Redeploy** to apply env changes.
5. **Review audit log** in `/admin` → **Activity** tab. Filter by actor; investigate every action by the suspect address. Roll back any unauthorised changes manually (re-approve / re-set position values).
6. **Force password resets** for all funded members if any member account was touched. There's no bulk-reset op currently — gap; for now, contact members individually and walk them through `/forgot-password`.
7. **Document the incident** — date, indicators, actions taken, post-action audit, whether any member data was exposed. File in operator records.

### I.2 Upstash down

**Indicators:** `/api/health` returns `"kv": "offline"`. Admin dashboard fails to load leads. Member portal shows "service unavailable."

**Actions:**
1. Check Upstash status page.
2. If Upstash regional issue: nothing we can do but wait. Platform is read-broken and write-broken until restored.
3. If Upstash is up but our project lost the connection: check `KV_REST_API_URL` and `KV_REST_API_TOKEN` in Vercel env. The marketplace integration occasionally needs re-linking.
4. **Do not** delete and re-provision the KV instance. That wipes everything. Re-link only.
5. If extended outage (>1h), notify any prospects mid-flow that the platform is temporarily down. Don't let them think their submission was lost.

### I.3 Resend rate-limited

**Indicators:** capital call broadcast to 100 members logs warnings about Resend 429s. Some members didn't get the email.

**Actions:**
1. Check Resend dashboard for current rate-limit usage.
2. The platform does not currently retry failed sends (gap). Identify which members didn't receive — `/admin` → **Activity** for the broadcast op, cross-reference with Resend send log.
3. Wait for the rate limit window to reset, then re-issue the message to the missed recipients only (op: `send-message` per-member).
4. For future broadcasts of >50 emails: throttle manually (split into batches with a pause) or upgrade Resend plan.

> **Gap (operator to fill):** no automatic retry/throttle for bulk email sends. If member count grows past 50 funded, add throttling in `api/_lib/email.js` or fan out to a queue.

### I.4 Gold price feed dead

**Indicators:** `/api/health` returns `"spot_stale": true`. Member portal shows a sticky price for hours. Admin NAV preview uses fallback.

**Actions:**
1. Check `METALS_API_KEY` and `GOLD_API_KEY` validity (log into the respective dashboards).
2. If either provider is down: spot falls back to `GOLD_SPOT_FALLBACK` (default $4,700). **Update `GOLD_SPOT_FALLBACK` to current market** (last known good spot from a manual check). Redeploy.
3. Member portal will show the fallback with the cached `fetched_at`. Acceptable for hours, not days.
4. If both providers are dead for >24h: post a notice in `/messages` to all funded members explaining that NAV display is using a manual price during the outage.

### I.5 Member reports unauthorized access to their account

**Immediate actions:**
1. **Log out the member** — there's no per-member force-logout op (gap). The closest available is to revoke access (`revoke-access`), which kills their session because it gates the cookie validation; then restore access after they reset password. Or rotate `AURUM_SECRET` (kills all sessions, see I.1).
2. **Force a password reset** — direct the member to `/forgot-password`. The reset flow uses a 6-digit code with 15-minute TTL and rate limiting (see `generateResetCode` in `api/_lib/auth.js`).
3. **Audit the member's account** — `/admin` → **Members** → click member → **Activity** tab for that member. Look at recent logins, NDA reviews, capital call acknowledgements. Roll back any unauthorised changes.
4. **Check IP / geo** in audit entries (`api/_lib/geo.js` annotates each).
5. **If beneficial owner data was viewed by an unauthorised party** — this is a regulatory disclosure event under Singapore PDPA. Consult counsel.

> **Gap (operator to fill):** no per-member force-logout op, no per-member session revocation. Add if member count grows.

### I.6 Cron jobs not running

**Indicators:** `/api/health` → `last_cron.<job>` is null or >36h stale.

**Actions:**
1. Check Vercel project → **Cron** tab. Confirm schedules are enabled.
2. Check `CRON_SECRET` is set (auto by Vercel). If unset, cron runs but is publicly accessible — set it.
3. Manual trigger: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron?job=scan-exceptions` (substitute the job name). If this works but the schedule doesn't fire, it's a Vercel platform issue — escalate to Vercel support.

---

## J. Daily / weekly / monthly / annual routine

### J.1 Daily (5–10 min)

- Open `/admin` → **Today** tab.
- Process any **Pending Decisions** queue items (NDA pending, wire received, subscription submitted).
- Glance at **Activity Feed** — anything anomalous? Logins from unexpected geographies?
- Check `/api/health` — kv connected, spot fresh, last_cron timestamps within 26h.

### J.2 Weekly (30–60 min)

- `/admin` → **Compliance** tab. Review flags raised by the daily `scan-exceptions` cron. Mute (with reason) or escalate.
- Pull env backup: `vercel env pull .env.production.backup` to encrypted storage.
- Export leads JSON (when the export script exists — see H.2 gap).
- Review unread quarterly letter recipients (D.3) — follow up if recently published.
- Confirm Upstash snapshots are running (Upstash console).

### J.3 Monthly (1–2 hr)

- Confirm vault verification is on schedule (last published within ~90 days; quarterly minimum).
- Review fee accrual on the fund admin side — reconcile against NAV updates pushed.
- If a quarter just ended: D (NAV + quarterly letter) and E (vault verification) are on the calendar.
- Rotate any credentials due (every 90 days for `ADMIN_PASSWORD`).
- Test `/forgot-password` and `/setup-password` from a real prospect's perspective. Catches token TTL issues.

### J.4 Quarterly (half day)

- Publish quarterly letter (§D).
- Publish vault verification report (§E).
- Update `GOLD_SPOT_FALLBACK` to current market level.
- DR rehearsal: pick a recent Upstash snapshot, restore in a non-production project (or branch), confirm shape of restored data.

### J.5 Annually (1–2 days)

- Generate tax statements for every KR-resident funded member (§F). Late January is the typical window.
- Annual audited fund financial statement distribution (manual — PDF prepared by fund admin, published via vault verification flow with type=annual_report or as a quarterly letter attachment).
- Renew Resend domain verification if needed.
- Renew gold price API subscriptions (`METALS_API_KEY`, `GOLD_API_KEY`).
- Operator security review: `ADMIN_USERS` allowlist current? `AURUM_SECRET` rotated? `ADMIN_PASSWORD` rotated?
- Renew the operator's understanding of this runbook by reading it cover-to-cover. Update where reality has drifted from documentation.
