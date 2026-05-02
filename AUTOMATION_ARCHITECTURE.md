# Aurum Century Club — Automation Operating Architecture
**Singapore VCC | Physical Gold + Private Credit | 100 Founding Members | Q3 2026 First Close**

Last updated: 2026-05-02

---

## PART 1: AUTOMATION SPEC CARDS

---

### A. GOLD PRICE & LTV MONITORING

---

```
NAME: XAU Price Poller
TRIGGER: Vercel Cron — every 15 minutes during market hours
         Schedule: */15 8-22 * * 1-5 (UTC+8, Mon–Fri)
         Fallback: hourly on weekends (0 * * * 0,6)
SOURCE: GoldAPI.io or Metals-API REST endpoint (XAU/USD spot)
        Redis key: gold:price:current (previous value)
        Redis key: gold:price:24h_high / :24h_low
ACTION: 1. Fetch current XAU/USD spot price
        2. Write to Redis: gold:price:current, gold:price:timestamp
        3. Calculate % change from last 24h baseline
        4. If price drops >= 5% in single poll interval: trigger
           PRICE_DROP_ALERT event (feeds into LTV monitors below)
        5. Append to daily price log in Vercel Blob: prices/YYYY-MM-DD.json
ESCALATE: If API returns error 3 consecutive polls: alert partner via
          Resend with subject "GOLD PRICE FEED DOWN — manual check required"
IMPLEMENT: Vercel Cron → api/cron/gold-price.js
PRIORITY: P0
```

---

```
NAME: LTV Monitor — 70% Warning Threshold
TRIGGER: Event-driven — fires after every XAU Price Poller write
         Also: Vercel Cron at 08:00 SGT daily as safety sweep
SOURCE: Redis hash member:{id}:loan_balance (draw amount in USD)
        Redis key: gold:price:current
        Redis hash member:{id}:gold_kg (bars allocated to member)
        Calculation: LTV = loan_balance / (gold_kg * 32.1507 * xau_usd)
ACTION: 1. Loop all funded members with active credit lines
        2. Calculate current LTV for each member
        3. If LTV crosses 70% (was below, now at/above):
           a. Write Redis: member:{id}:ltv_alert:70 = timestamp
           b. Send member email: "Portfolio update — gold coverage notice"
              (non-alarming tone, factual, Korean bilingual)
           c. Log event to Vercel Blob: events/ltv/YYYY-MM-DD.json
           d. Write admin dashboard flag: admin:alerts:ltv_70
        4. If LTV falls back below 68%: clear flag, send member
           "Coverage restored" notification
ESCALATE: Alert partner Slack/email if >= 3 members breach 70%
          simultaneously (systemic gold price event, not individual)
IMPLEMENT: Vercel Function triggered by gold-price.js internal call
           + api/cron/ltv-sweep.js (daily safety net)
PRIORITY: P0
```

---

```
NAME: LTV Monitor — 80% Critical Threshold (Margin Call Trigger)
TRIGGER: Same event chain as 70% monitor
         Additional: independent Vercel Cron every 30 minutes
         Schedule: */30 * * * * (always-on, no market hours restriction)
SOURCE: Same as 70% monitor
        Redis key: member:{id}:ltv_alert:70 (must exist first)
        Redis key: member:{id}:capital_call_in_progress (deduplication)
ACTION: 1. If LTV crosses 80% AND no capital call already in progress:
           a. Write Redis: member:{id}:ltv_alert:80 = timestamp
           b. Set Redis: member:{id}:capital_call_in_progress = "pending_approval"
           c. Send URGENT partner email: "ACTION REQUIRED — [Member] at 80% LTV"
              with current LTV, loan balance, gold value, margin gap amount
           d. DO NOT send member communication yet — partner reviews first
           e. Set Redis: admin:alerts:ltv_80:{memberId} with 4-hour TTL
              (forces partner to act within 4 hours or re-alert fires)
        2. Log to audit trail in Vercel Blob
ESCALATE: This IS the escalation. No automated action taken at 80%.
          Partner must manually approve capital call issuance.
          If partner has not responded in 4 hours: re-alert.
          If 24 hours with no response: alert second partner contact.
IMPLEMENT: api/cron/ltv-critical.js + Redis TTL expiry re-alert pattern
PRIORITY: P0
```

---

```
NAME: Gold Price Drop Reserve Deployment Alert (25% Decline)
TRIGGER: XAU Price Poller — calculated against 30-day rolling baseline
         Redis key: gold:price:30d_baseline (updated daily)
SOURCE: gold:price:current vs gold:price:30d_baseline
        Redis key: fund:reserve_balance_usd
        Redis hash: all member LTV states
ACTION: 1. If spot price decline >= 25% from 30-day baseline:
           a. Declare SYSTEMIC_PRICE_EVENT in Redis with timestamp
           b. Run full LTV sweep across all 100 members
           c. Generate reserve deployment memo in Vercel Blob:
              reports/reserve-memo-{timestamp}.json
              (shows: members at risk, USD gap to restore LTVs to 70%,
               current reserve balance, coverage ratio)
           d. Send partner alert email with memo attached as HTML table
           e. Set fund:systemic_alert_active = true in Redis
           f. Increase LTV polling to every 5 minutes until cleared
        2. No automatic reserve deployment — this is a decision memo only
ESCALATE: Immediate. This event always requires partner decision.
          Automation provides the math; human makes the call.
IMPLEMENT: Logic inside api/cron/gold-price.js + api/cron/ltv-sweep.js
PRIORITY: P0
```

---

```
NAME: Annual Gold Procurement Buffer Reconciliation
TRIGGER: Vercel Cron — annually on January 15 (after year-end)
         Schedule: 0 9 15 1 * (09:00 UTC on Jan 15)
SOURCE: Vercel Blob: vault/bar-registry.json (bar list, weights, assay)
        Redis: fund:committed_capital_usd, fund:gold_kg_total
        Gold price at fiscal year-end (stored in prices/YYYY-12-31.json)
ACTION: 1. Calculate theoretical gold kg required at year-end price
        2. Compare against vault registry bar count x weights
        3. Generate reconciliation report: buffer surplus/deficit in kg and USD
        4. Store in Vercel Blob: reports/annual/procurement-recon-YYYY.json
        5. Email to partner: "Annual Procurement Buffer Report — Action Required"
ESCALATE: Always escalates — output is a report for human review and
          instruction to vault/custodian, never an automated transaction.
IMPLEMENT: api/cron/annual-procurement-recon.js
PRIORITY: P1
```

---

### B. MEMBER PIPELINE AUTOMATION

---

```
NAME: NDA Upload Detection & Partner Alert
TRIGGER: Webhook — fired when member uploads signed NDA to Vercel Blob
         POST to api/webhooks/nda-uploaded
SOURCE: Vercel Blob upload event (via blob upload handler in api/doc.js)
        Redis: member:{id}:stage (must be "nda_pending")
        Redis: member:{id}:profile (name, email, partner assigned)
ACTION: 1. Write Redis: member:{id}:nda_uploaded_at = timestamp
        2. Store blob path in Redis: member:{id}:nda_blob_path
        3. Update stage to "nda_review"
        4. Send partner email: "[Member Name] uploaded NDA — review required"
           with direct link to blob document and admin approval button deep-link
        5. Set Redis TTL key: member:{id}:nda_review_pending with 48h TTL
ESCALATE: If 48h TTL expires (Redis key deleted) and stage still "nda_review":
          fire re-alert to partner. Uses Vercel Cron daily sweep to catch these.
IMPLEMENT: api/webhooks/nda-uploaded.js + api/cron/pipeline-staleness.js
PRIORITY: P0
```

---

```
NAME: Post-NDA-Approval Welcome Sequence Initiator
TRIGGER: Partner manually approves NDA in admin dashboard
         Admin action calls: POST api/admin/approve?stage=nda&memberId=X
SOURCE: Redis: member:{id}:stage
        Redis: member:{id}:profile
ACTION: 1. Update Redis stage to "memo_access"
        2. Unlock /memo route for member (write member:{id}:memo_access = true)
        3. Send member email: "Your NDA has been approved — next steps"
           (Korean bilingual, includes link to investment memo)
        4. Set Redis: member:{id}:memo_opened_check with 72h TTL
           (feeds read receipt check automation below)
        5. Log to audit trail
        6. Update admin dashboard lead status
ESCALATE: None — this fires automatically on partner approval action.
IMPLEMENT: Logic in api/v2.js (admin approve handler) triggering
           internal call to api/_lib/pipeline.js sequence initiator
PRIORITY: P0
```

---

```
NAME: Investment Memo Read Receipt Check
TRIGGER: Redis TTL expiry pattern — 72h after memo access granted
         Vercel Cron daily sweep: 0 8 * * * checks all pending TTL keys
SOURCE: Redis: member:{id}:memo_opened_check (TTL key)
        Redis: member:{id}:memo_first_opened_at (set on first /memo load)
ACTION: 1. Daily cron sweeps for members where memo_opened_check exists
           but memo_first_opened_at does NOT exist (not yet opened)
        2. If 72 hours elapsed with no open: send member reminder email
           "Your investment memo is ready to review" (warm, not alarming)
        3. If 120 hours (5 days) with no open: partner alert
           "[Member] has not opened the investment memo in 5 days"
        4. If 14 days with no open: flag as pipeline_at_risk in Redis
ESCALATE: 5-day no-open triggers partner alert. 14-day = partner outreach decision.
IMPLEMENT: api/cron/pipeline-staleness.js (handles all TTL-based staleness checks)
PRIORITY: P1
```

---

```
NAME: KYC Status Poller (Useb / Third-Party KYC Webhook Handler)
TRIGGER: Inbound webhook from KYC provider — POST api/webhooks/kyc-status
         Fallback: Vercel Cron polling every 6 hours if webhook not available
         Schedule: 0 */6 * * *
SOURCE: KYC provider API (Useb or equivalent) — member verification result
        Redis: member:{id}:kyc_submitted_at
        Redis: member:{id}:kyc_status (pending / approved / rejected / needs_more)
ACTION: On webhook receipt or poll result change:
        1. Update Redis: member:{id}:kyc_status = new status
        2. If APPROVED:
           a. Update pipeline stage to "kyc_cleared"
           b. Send member: "Identity verified — subscription documents next"
           c. Alert partner: "[Member] KYC cleared"
           d. Unlock /subscription route
        3. If REJECTED or NEEDS_MORE_INFO:
           a. Write specific rejection reason to Redis
           b. Send member notification with required action
           c. Alert partner immediately
        4. If PENDING > 5 business days: alert partner to chase provider
ESCALATE: Any rejection, any pending > 5 days, any needs-more-info → partner alert
IMPLEMENT: api/webhooks/kyc-status.js + api/cron/kyc-stale.js
PRIORITY: P0
```

---

```
NAME: Subscription Document Receipt Alert
TRIGGER: Webhook — member completes and submits subscription form
         POST api/webhooks/subscription-submitted
SOURCE: Vercel Blob: subscriptions/{memberId}/subscription-agreement.pdf
        Redis: member:{id}:subscription_submitted_at
ACTION: 1. Write Redis: member:{id}:subscription_submitted_at = timestamp
        2. Store blob path
        3. Update stage to "subscription_review"
        4. Send partner email: "[Member] submitted subscription documents"
           with document link, member profile summary, KYC status
        5. Send member confirmation: "Documents received — we will contact you
           within 2 business days" (Korean bilingual)
        6. Set 48h staleness TTL for partner action check
ESCALATE: If partner has not actioned after 48h: re-alert.
IMPLEMENT: api/webhooks/subscription-submitted.js
PRIORITY: P0
```

---

```
NAME: Capital Call 48-Hour Read Receipt Monitor
TRIGGER: Vercel Cron — every 6 hours when capital calls are active
         Schedule: 0 */6 * * * (only runs when fund:capital_call_active = true)
SOURCE: Redis: fund:capital_call_active (boolean gate)
        Redis hash: capital_call:{callId}:sent_to (list of member IDs)
        Redis hash: capital_call:{callId}:opened_by (list of member IDs)
        Redis: capital_call:{callId}:sent_at (timestamp)
ACTION: 1. Check if >= 48 hours since capital_call sent_at
        2. Identify members in sent_to but NOT in opened_by
        3. For each unread member:
           a. Log to Vercel Blob: capital-calls/{callId}/unread-log.json
           b. Send partner alert listing all unread members with contact info
        4. At 72 hours: send member reminder email (cc: partner)
        5. At 96 hours: partner phone call prompt (alert with member phone number)
ESCALATE: 48h → partner email list. 72h → member reminder sent. 96h → partner
          must call member directly. Automation handles delivery and tracking only.
IMPLEMENT: api/cron/capital-call-monitor.js
PRIORITY: P0
```

---

```
NAME: Wire Receipt Monitoring (Semi-Automated)
TRIGGER: Vercel Cron — daily at 09:00 SGT when subscriptions pending wire
         Schedule: 0 1 * * * (01:00 UTC = 09:00 SGT)
         Manual trigger: admin API endpoint api/admin/wire-received
SOURCE: Redis: member:{id}:wire_expected (amount, expected date)
        Redis: member:{id}:wire_received_at (set manually by partner or bank)
        NOTE: No direct bank API — wire confirmation is manual input
ACTION: 1. Daily sweep: flag all members where wire_expected exists but
           wire_received_at does NOT exist and expected date has passed
        2. Generate daily partner digest: "Wires Pending" table with
           member name, expected amount, expected date, days overdue
        3. Email digest to partner every morning during active close period
        4. When partner manually marks wire received via admin:
           a. Write wire_received_at
           b. Update member stage to "funded"
           c. Trigger funded welcome sequence (see Section E)
ESCALATE: Wire > 3 business days overdue → individual partner alert per member.
          Wire > 7 business days overdue → flag as pipeline_critical.
          No automated bank API integration feasible on this stack.
IMPLEMENT: api/cron/wire-monitor.js + manual api/admin/wire-received endpoint
PRIORITY: P0
```

---

### C. FUND REPORTING AUTOMATION

---

```
NAME: Quarterly Letter Reminder
TRIGGER: Vercel Cron — 20 days before each quarter-end
         Dates: March 11, June 10, September 10, December 11
         Schedule: 0 9 11 3 * | 0 9 10 6 * | 0 9 10 9 * | 0 9 11 12 *
         (Practical: single monthly cron checks if within 20 days of quarter-end)
SOURCE: Redis: fund:last_quarterly_letter_sent (date)
        Vercel Blob: reports/quarterly/ (previous letters)
ACTION: 1. Send partner email: "Quarterly letter due in 20 days"
           with template checklist: NAV figure, gold price period summary,
           credit portfolio update, deal pipeline note, fund expense summary
        2. At 10 days: second reminder
        3. At 5 days: urgent reminder with draft template attached
        4. At 0 days (quarter-end): alert if letter not yet marked sent
ESCALATE: Always a reminder system — drafting and sending is human work.
IMPLEMENT: api/cron/reporting-reminders.js
PRIORITY: P1
```

---

```
NAME: NAV Calculation Assistant
TRIGGER: Vercel Cron — 5th business day of each month
         Schedule: 0 9 5 * * (adjusted if weekend via business day logic)
         Also: on-demand trigger from admin dashboard
SOURCE: Redis: gold:price:current (or month-end close price from Blob)
        Vercel Blob: vault/bar-registry.json (total gold kg)
        Redis: fund:committed_capital_usd
        Redis: fund:private_credit_portfolio (NAV of credit book, manual input)
        Redis: fund:total_liabilities (fund expenses accrued, manual input)
ACTION: 1. Pull gold value: total_kg * xau_usd_month_end * 32.1507
        2. Pull credit book NAV (manually entered by partner/fund admin)
        3. Calculate: NAV = gold_value + credit_nav - total_liabilities
        4. Calculate NAV per share
        5. Write to Redis: fund:nav_current, fund:nav_per_share, fund:nav_date
        6. Store to Vercel Blob: reports/nav/YYYY-MM.json
        7. Send partner email: "NAV draft ready for review and approval"
           with full calculation breakdown
        8. NAV is NOT published to members until partner explicitly approves
ESCALATE: Gold price component is automated. Credit book NAV requires
          manual partner/fund admin input. Gold component only auto-calc;
          full NAV always requires partner sign-off before publishing.
IMPLEMENT: api/cron/nav-calc.js + api/admin/approve-nav endpoint
PRIORITY: P1
```

---

```
NAME: Annual Tax Statement Generator
TRIGGER: Vercel Cron — February 1 each year (post fiscal year-end)
         Schedule: 0 9 1 2 *
SOURCE: Vercel Blob: reports/nav/YYYY-*.json (monthly NAVs for prior year)
        Vercel Blob: vault/bar-registry.json
        Redis: member:{id}:subscription_amount, member:{id}:funded_date
        Redis: fund:distributions (any distributions paid)
        Redis: fund:expenses_annual (total fund expenses for year)
ACTION: 1. Generate per-member statement data:
           - Opening NAV (if mid-year entry: pro-rated)
           - Closing NAV at December 31
           - Gold value component vs credit component
           - Member's proportional expense allocation
           - Any distributions received
        2. Store as JSON in Vercel Blob: tax/{year}/member-{id}.json
        3. Send partner email: "Annual tax data ready — review before member release"
           with summary of all 100 members
        4. Individual member statements NOT sent until partner approves
ESCALATE: All tax statements require partner + fund administrator review
          before delivery to members. Auto-generation only; no auto-send.
IMPLEMENT: api/cron/annual-tax-statements.js
PRIORITY: P1
```

---

```
NAME: Annual Vault Verification Reminder
TRIGGER: Vercel Cron — November 1 each year
         Schedule: 0 9 1 11 *
SOURCE: Vercel Blob: vault/bar-registry.json (last verification date)
        Redis: fund:vault_last_verified (date of most recent audit)
ACTION: 1. Check days since fund:vault_last_verified
        2. If > 335 days: send partner reminder
           "Annual vault verification due — schedule with [custodian name]"
        3. Include: bar count, total kg, vault location, custodian contact
        4. Follow-up reminders at Nov 15, Dec 1, Dec 15 if not marked complete
        5. When partner marks verified: update fund:vault_last_verified
ESCALATE: Always human. Automation is reminder only. Physical vault
          verification requires on-site custodian inspection.
IMPLEMENT: api/cron/reporting-reminders.js (shared cron, multiple reminder types)
PRIORITY: P1
```

---

```
NAME: Annual Fund Audit Reminder
TRIGGER: Vercel Cron — October 1 each year
         Schedule: 0 9 1 10 *
SOURCE: Redis: fund:audit_last_completed, fund:auditor_contact
ACTION: 1. Send partner: "Annual audit planning — fiscal year ends Dec 31"
           Recommended audit firm engagement: October
           Draft financials to auditor: January 31
           Audited accounts due to ACRA: within 6 months of FYE (by June 30)
        2. Milestone reminders: Nov 1 (confirm auditor), Jan 15 (draft ready),
           April 1 (audit in progress check), May 15 (final review)
        3. Each milestone fires a separate reminder email
ESCALATE: Always human. Reminders only. Audit is external professional service.
IMPLEMENT: api/cron/reporting-reminders.js
PRIORITY: P1
```

---

### D. CAPITAL CALL AUTOMATION

---

```
NAME: Capital Call Initiator
TRIGGER: Partner-initiated via admin dashboard (manual approval required)
         Automated flag fires when: (a) any member hits 80% LTV threshold
         OR (b) fund:reserve_balance_usd drops below fund:reserve_minimum_usd
         Automation creates a "capital call recommended" flag, NOT the call itself
SOURCE: Redis: admin:alerts:ltv_80:* (any member flagged)
        Redis: fund:reserve_balance_usd vs fund:reserve_minimum_usd
        Redis: fund:capital_call_active (deduplication — only one active at a time)
ACTION: AUTOMATED (flag only):
        1. Write Redis: fund:capital_call_recommended = {reason, timestamp, details}
        2. Alert partner: "Capital call recommended — [reason]" with supporting data
        AFTER PARTNER APPROVES (via admin dashboard):
        3. Write fund:capital_call_active = {callId, approved_by, approved_at}
        4. Trigger Capital Call Notice Delivery automation (below)
ESCALATE: Capital call initiation ALWAYS requires partner approval.
          No capital call notice goes to members without explicit partner sign-off.
IMPLEMENT: Flag logic in api/cron/ltv-critical.js and api/cron/reserve-monitor.js
           Approval endpoint: api/admin/approve-capital-call
PRIORITY: P0
```

---

```
NAME: Capital Call Notice Delivery
TRIGGER: Fires immediately after partner approves capital call
         Internal event: fund:capital_call_active set to approved state
SOURCE: Redis: fund:capital_call_active (call details, amount, deadline)
        Redis: member:{id}:funded = true (scope to funded members only)
        Redis: member:{id}:email, member:{id}:name (bilingual fields)
ACTION: 1. Generate capital call notice document, store in Vercel Blob:
           capital-calls/{callId}/notice.html
        2. Send bilingual email to all funded members:
           - Amount requested (total and per-member proportional share)
           - Wire instructions
           - Deadline (typically 10 business days)
           - Account details
        3. Write to Redis: capital_call:{callId}:sent_to = [memberId array]
        4. Write capital_call:{callId}:sent_at = timestamp
        5. Activate capital_call_monitor cron (sets fund:capital_call_active gate)
        6. Send partner confirmation: "Capital call notices sent to [N] members"
ESCALATE: Delivery failures (Resend bounce) → immediate partner alert per member.
IMPLEMENT: api/admin/approve-capital-call.js triggers internal send sequence
           via api/_lib/capital-call.js
PRIORITY: P0
```

---

```
NAME: Fund Reserve Balance Monitor
TRIGGER: Vercel Cron — daily at 08:00 SGT
         Schedule: 0 0 * * *
         Also: fires after any wire-received event (reserve may change)
SOURCE: Redis: fund:reserve_balance_usd
        Redis: fund:reserve_minimum_usd (set at fund inception, typically 10% of AUM)
        Redis: fund:committed_capital_usd
ACTION: 1. Calculate reserve ratio: reserve_balance / committed_capital
        2. If ratio < 15%: log warning to Vercel Blob, update admin dashboard
        3. If ratio < 10% (minimum threshold): send partner alert
           "Reserve approaching minimum — capital call may be required"
        4. Write daily reserve ratio to Blob: reports/reserve/YYYY-MM-DD.json
        5. Update Redis: fund:reserve_ratio_current
ESCALATE: Below 15%: admin dashboard warning. Below 10%: partner email alert.
          Below 5%: URGENT partner email + create capital call recommendation flag.
IMPLEMENT: api/cron/reserve-monitor.js
PRIORITY: P0
```

---

### E. COMMUNICATIONS AUTOMATION

---

```
NAME: Funded Member Welcome Sequence
TRIGGER: Wire receipt confirmed by partner (member:stage transitions to "funded")
         Fires from api/admin/wire-received handler
SOURCE: Redis: member:{id}:profile (name, subscription amount, email)
        Redis: member:{id}:funded_at (just written)
        Vercel Blob: _docs/welcome-kit.html (welcome materials)
ACTION: Day 0 (immediately):
        Email 1 — "Welcome to the Aurum Century Club"
        Korean bilingual. Confirms funded status, member number (#001–#100),
        portfolio access link, key contacts, vault information overview.

        Day 3:
        Email 2 — "Your gold position"
        Gold kg allocated (proportional), current spot value, LTV headroom.
        Link to live portfolio dashboard.

        Day 7:
        Email 3 — "Your private credit allocation"
        Prism deal overview, expected return profile, drawdown schedule.

        Day 30:
        Email 4 — "One month in — your portfolio at a glance"
        Mini-statement: gold value, credit NAV, total position.

        All emails stored in Redis with sent timestamps for deduplication.
        Sequence managed via Redis: member:{id}:welcome_sequence_step
ESCALATE: Any Resend bounce on day 0 email → immediate partner alert.
IMPLEMENT: api/_lib/welcome-sequence.js triggered from wire-received handler
           Subsequent emails via api/cron/comms-scheduler.js (daily sweep)
PRIORITY: P1
```

---

```
NAME: Membership Milestone Notifications
TRIGGER: Vercel Cron — daily at 09:00 SGT
         Schedule: 0 1 * * *
         Checks all funded members for anniversary milestones
SOURCE: Redis: member:{id}:funded_at
        Today's date vs funded_at
ACTION: 6-month milestone:
        Email: "6 months with Aurum — your portfolio snapshot"
        Include: gold price change since entry, credit income accrued,
        NAV change, market commentary note from partner.

        12-month milestone:
        Email: "One year as a founding member"
        Include: full year performance summary, gold vs credit contribution,
        personal message from managing partner (template with merge fields).

        Each milestone write to Redis: member:{id}:milestone_6m_sent (deduplication)
ESCALATE: None — these are automated but personalised templates.
          12-month email has a 3-day advance alert to partner to review/customise.
IMPLEMENT: api/cron/comms-scheduler.js
PRIORITY: P2
```

---

```
NAME: Prism Deal Update Notifier
TRIGGER: Webhook — POST api/webhooks/prism-deal-update
         Fires when bridge/Prism platform pushes deal status update
         Alternatively: Vercel Cron polling Prism API if no webhook available
         Schedule: 0 */4 * * * (every 4 hours)
SOURCE: Prism/bridge deal data (deal stage, drawdown event, repayment, new deal)
        Redis: fund:prism_last_update (deduplication)
        Redis: member:{id}:funded (scope to funded members only)
ACTION: On material deal update (new deal funded, drawdown, repayment, exit):
        1. Write update to Redis: fund:prism_updates queue
        2. Store deal update in Vercel Blob: deals/updates/YYYY-MM-DD-{id}.json
        3. Send partner email for review: "Prism update — approve for member release?"
        4. After partner approval: send member notification
           "Portfolio update — [deal name] update"
        5. Update /deals page data in Redis
ESCALATE: All deal communications require partner approval before member delivery.
          Automation handles ingestion, storage, and delivery — not editorial.
IMPLEMENT: api/webhooks/prism-deal-update.js or api/cron/prism-poller.js
PRIORITY: P1
```

---

```
NAME: Member Inactivity Detector
TRIGGER: Vercel Cron — weekly on Monday at 09:00 SGT
         Schedule: 0 1 * * 1
SOURCE: Redis: member:{id}:last_login_at
        Redis: member:{id}:funded_at, member:{id}:stage
        Today's date
ACTION: 1. Sweep all funded members
        2. If last_login > 90 days ago:
           a. Send member re-engagement email:
              "We noticed you haven't logged in recently — here's your portfolio"
              Include current gold price, NAV snapshot, any deal updates missed
           b. Log to admin dashboard: admin:inactive_members list
        3. If last_login > 180 days ago:
           a. Additional partner alert: "[Member] inactive 6 months — consider outreach"
           b. Do not send member another automated email (avoid spam perception)
        4. Never auto-mark member as churned — human decision only
ESCALATE: 180-day inactivity → partner manual outreach recommended.
IMPLEMENT: api/cron/comms-scheduler.js
PRIORITY: P2
```

---

### F. COMPLIANCE AUTOMATION

---

```
NAME: MAS Annual Restricted Scheme Declaration Reminder
TRIGGER: Vercel Cron — January 15 each year
         Schedule: 0 9 15 1 *
SOURCE: Redis: compliance:mas_declaration_last_filed (year)
        Redis: fund:manager_contact
ACTION: 1. Send partner reminder: "MAS restricted scheme annual declaration due"
           Include: required filing checklist per MAS Notice VCC-N01 (revised 2025),
           submission portal link (MAS-Tx portal), previous year filing reference
        2. Follow-up reminder on February 1 if not marked complete
        3. When partner marks filed: write compliance:mas_declaration_last_filed = year
ESCALATE: If not marked filed by March 31: escalation alert.
          Filing is always human — automation is reminder and tracking only.
IMPLEMENT: api/cron/compliance-reminders.js
PRIORITY: P0
```

---

```
NAME: FATCA/CRS Annual Reporting Reminder
TRIGGER: Vercel Cron — March 1 each year
         Schedule: 0 9 1 3 *
SOURCE: Redis: compliance:fatca_crs_last_filed
        Redis: member:{id}:tax_residency (to flag US persons and CRS-reportable members)
ACTION: 1. Count members who are US persons (FATCA) or reportable under CRS
        2. Send partner: "FATCA/CRS reporting due — [N] reportable members"
           Include: reportable member list, IRAS submission deadline (typically May 31),
           required data fields per member, previous year reference
        3. Reminder on April 1 and May 1
        4. When partner marks filed: write compliance:fatca_crs_last_filed
ESCALATE: Always human filing. Never automated submission.
          If IRAS deadline within 7 days and not marked filed: URGENT alert.
IMPLEMENT: api/cron/compliance-reminders.js
PRIORITY: P0
```

---

```
NAME: Korean NTS Overseas Investment Reporting Reminder
TRIGGER: Vercel Cron — April 1 each year
         Schedule: 0 9 1 4 *
         (Deadline: June 30 per Korean LCITA for prior-year accounts)
SOURCE: Redis: member:{id}:tax_residency = "KR" (Korean tax residents)
        Redis: member:{id}:subscription_amount
        Note: Threshold is KRW 500M (~USD 370K) on any month-end balance
ACTION: 1. Identify all Korean tax resident members
        2. Filter those whose fund balance likely exceeds KRW 500M threshold
        3. Send personalised email to each qualifying member:
           "Annual reporting reminder for Korean residents — NTS filing by June 30"
           Include: their subscription amount, current estimated NAV,
           NTS reporting requirements summary (Korean language),
           recommendation to consult Korean tax advisor
        4. NOT tax advice — informational reminder only. Include disclaimer.
        5. Send partner summary: "[N] Korean members sent NTS reminder"
        6. Follow-up reminder on June 1 for all who haven't acknowledged
ESCALATE: Members with very large positions (> KRW 2B equivalent): flag for
          partner to consider individual outreach. Tax filing is member responsibility.
IMPLEMENT: api/cron/compliance-reminders.js
PRIORITY: P1
```

---

```
NAME: KYC Re-Verification Trigger
TRIGGER: Vercel Cron — annual sweep on January 1
         Schedule: 0 9 1 1 *
         Also: event-triggered if MAS issues updated CDD guidance
SOURCE: Redis: member:{id}:kyc_verified_at
        Redis: member:{id}:kyc_risk_rating (low / medium / high)
        MAS AML/CFT guidelines (Notice VCC-N01, revised June 2025)
ACTION: Risk-based re-verification schedule:
        Low risk: re-verify every 3 years
        Medium risk: re-verify every 2 years
        High risk: re-verify every 1 year
        1. Calculate members due for re-verification in next 90 days
        2. Send partner alert: "KYC re-verification due — [N] members"
           with member list, risk ratings, last verification dates
        3. 60 days before due: send member notification requesting updated documents
        4. 30 days overdue: member portal access flag (not blocked, but flagged)
        5. 90 days overdue: partner must decide on access restriction
ESCALATE: 90+ days overdue on KYC re-verification: partner decision required.
          Never auto-restrict member access without human decision.
IMPLEMENT: api/cron/compliance-reminders.js + api/cron/kyc-reverification.js
PRIORITY: P0
```

---

```
NAME: AML Transaction Monitoring
TRIGGER: Event-driven — fires on every wire receipt event
         Also: Vercel Cron weekly on Monday for pattern review
         Schedule: 0 9 * * 1
SOURCE: Redis: member:{id}:wire_history (array of wire events with amounts/dates)
        Redis: member:{id}:kyc_risk_rating
        Redis: fund:aml_thresholds (configurable, default: flag > SGD 100K single wire)
ACTION: Per wire receipt:
        1. Check wire amount against thresholds
        2. Check for unusual patterns: multiple wires in short period,
           round numbers, amounts just below threshold
        3. If any flag triggered:
           a. Write to Redis: aml:alerts:{memberId}:{timestamp}
           b. Store in Vercel Blob: compliance/aml/YYYY-MM/{memberId}-{timestamp}.json
           c. Send partner alert: "AML flag — [Member] — [reason]"
        4. Weekly sweep: generate AML monitoring digest for partner records
ESCALATE: Any AML flag → immediate partner review. No automated action.
          Partner must clear or escalate to MAS-appointed compliance officer.
          STR (Suspicious Transaction Report) is always a human decision.
IMPLEMENT: api/webhooks/wire-received.js (AML check module)
           + api/cron/aml-weekly-digest.js
PRIORITY: P0
```

---

### G. OPERATIONAL HEALTH

---

```
NAME: Redis Health Check
TRIGGER: Vercel Cron — every 5 minutes
         Schedule: */5 * * * *
SOURCE: Upstash Redis PING command
        Redis: health:last_ping_success (timestamp)
ACTION: 1. Send PING to Upstash Redis
        2. If response OK: write health:last_ping_success = now
        3. If PING fails:
           a. Retry after 60 seconds
           b. If second failure: send partner alert via Resend
              "CRITICAL: Redis KV unavailable — platform may be degraded"
           c. Write to Vercel Blob: ops/health/outages.log (append)
        4. If health:last_ping_success > 15 minutes old and no new success:
           treat as outage even if cron missed execution
ESCALATE: Any confirmed Redis outage → immediate partner alert.
          Vercel status page check included in alert message.
IMPLEMENT: api/cron/health-redis.js
PRIORITY: P0
```

---

```
NAME: Email Delivery Monitor (Resend Webhook Handler)
TRIGGER: Inbound webhook from Resend — POST api/webhooks/resend-events
         Events: email.bounced, email.complained, email.delivery_delayed
SOURCE: Resend webhook payload (email ID, recipient, event type, reason)
        Redis: email:{resendId}:recipient_member_id (reverse lookup)
ACTION: On bounce event:
        1. Look up which member the email belongs to
        2. Write Redis: member:{id}:email_bounced_at = timestamp,
           member:{id}:email_bounce_reason = reason
        3. Send partner alert: "[Member] email bounced — [reason] — update contact"
        4. Flag member in admin dashboard with email_invalid status

        On spam complaint:
        1. Write member:{id}:spam_complaint = true
        2. Immediately pause all automated emails to that member
        3. Alert partner: "[Member] marked email as spam"

        On delivery delay (> 4 hours):
        1. Log to ops/email-delays.json
        2. Alert partner if delay > 24 hours on critical communications
           (capital call, LTV alert, funded confirmation)
ESCALATE: Any bounce on critical mail (capital call, 80% LTV) → immediate alert.
          Spam complaint → partner decides whether to re-engage member.
IMPLEMENT: api/webhooks/resend-events.js
PRIORITY: P0
```

---

```
NAME: Daily Audit Log Digest
TRIGGER: Vercel Cron — daily at 08:00 SGT
         Schedule: 0 0 * * *
SOURCE: Vercel Blob: events/audit/YYYY-MM-DD.json (all events from prior day)
        Redis: admin:alerts:* (any open alerts)
        Redis: fund:nav_current, fund:reserve_ratio_current
ACTION: 1. Compile prior day's events:
           - Member pipeline movements
           - LTV events
           - Emails sent
           - API errors
           - Any compliance flags
           - Gold price range
        2. Format as HTML digest email
        3. Send to partner(s): "Aurum Daily Operations Digest — [date]"
        4. Store digest in Vercel Blob: reports/daily-digest/YYYY-MM-DD.html
ESCALATE: If any P0 alerts are still open from prior day: flag prominently
          at top of digest as "REQUIRES ATTENTION."
IMPLEMENT: api/cron/daily-digest.js
PRIORITY: P1
```

---

```
NAME: Blob Storage Usage Monitor
TRIGGER: Vercel Cron — weekly on Sunday at 09:00 SGT
         Schedule: 0 1 * * 0
SOURCE: Vercel Blob list API (count files, estimate total size)
        Vercel account storage limits
ACTION: 1. Count total blobs, estimate storage used
        2. Log to Redis: ops:blob_usage_bytes
        3. If approaching 80% of plan limit: send partner alert
           "Storage approaching limit — consider archiving or plan upgrade"
        4. Generate weekly storage report in digest
ESCALATE: At 80% capacity: partner alert. This stack (Vercel Blob) can be
          upgraded but requires billing action.
IMPLEMENT: api/cron/health-blob.js
PRIORITY: P2
```

---

```
NAME: API Error Rate Monitor
TRIGGER: Integrated into all API functions — error logging on every 5xx
         Vercel Cron — daily digest of error counts
         Schedule: 0 0 * * *
SOURCE: Vercel Blob: ops/api-errors/YYYY-MM-DD.json (append-only error log)
        Redis: ops:error_count:today (incremented on each 5xx)
ACTION: 1. Every API function: on 5xx error, append to error log in Blob,
           increment Redis counter
        2. If ops:error_count:today > 10: send partner alert mid-day
           "Elevated API error rate — [N] errors today"
        3. Daily digest includes prior day error count and breakdown by endpoint
        4. Weekly trend: if error rate increasing week-over-week, send alert
ESCALATE: > 10 errors in one day: partner alert.
          Any error on payment or compliance endpoints: immediate alert
          regardless of count.
IMPLEMENT: api/_lib/error-logger.js (shared module) + api/cron/daily-digest.js
PRIORITY: P1
```

---

## PART 2: IMPLEMENTATION ARCHITECTURE OVERVIEW

### Vercel Cron Configuration (vercel.json additions)

All crons register in vercel.json under the `"crons"` key. The platform runs on Vercel Pro, so sub-daily schedules are supported. Every cron calls a single consolidated endpoint that routes by job name to avoid the 10-cron file limit on Vercel Pro.

Pattern: all crons → `api/cron/dispatch.js` with a `?job=` parameter.
Individual job logic lives in `api/cron/jobs/` as separate modules.

### Redis Key Namespace Map

```
gold:price:*              — Price feed data
member:{id}:*             — Per-member state
fund:*                    — Fund-level state
capital_call:{callId}:*   — Active capital call tracking
compliance:*              — Compliance filing records
aml:alerts:*              — AML flags
admin:alerts:*            — Partner dashboard alerts
ops:*                     — Platform health metrics
health:*                  — System health pings
email:{resendId}:*        — Email reverse lookup
```

### Webhook Endpoints Required

```
POST api/webhooks/nda-uploaded          — Blob upload event
POST api/webhooks/kyc-status            — KYC provider callback
POST api/webhooks/subscription-submitted — Subscription form submit
POST api/webhooks/resend-events         — Resend bounce/complaint/delay
POST api/webhooks/prism-deal-update     — Bridge/Prism deal feed
POST api/webhooks/wire-received         — Manual or bank-triggered wire confirm
```

All webhook handlers validate a shared secret header before processing.

### Vercel Blob Folder Structure

```
vault/
  bar-registry.json
prices/
  YYYY-MM-DD.json
events/
  audit/YYYY-MM-DD.json
  ltv/YYYY-MM-DD.json
reports/
  nav/YYYY-MM.json
  quarterly/YYYYQ[1-4].html
  daily-digest/YYYY-MM-DD.html
  annual/procurement-recon-YYYY.json
  reserve/YYYY-MM-DD.json
capital-calls/
  {callId}/notice.html
  {callId}/unread-log.json
subscriptions/
  {memberId}/subscription-agreement.pdf
tax/
  {year}/member-{id}.json
deals/
  updates/YYYY-MM-DD-{id}.json
compliance/
  aml/YYYY-MM/{memberId}-{timestamp}.json
ops/
  health/outages.log
  api-errors/YYYY-MM-DD.json
  email-delays.json
```

---

## PART 3: BUILD PHASES

### Phase 1 — Fund-Critical (P0) | Build before Q3 2026 first close

These run the fund. Without them, operation is not safe.

1. XAU Price Poller + LTV Monitor 70% + LTV Monitor 80%
2. Capital Call Initiator + Notice Delivery + 48h Read Receipt Monitor
3. KYC Status Poller (webhook handler)
4. NDA Upload Detection + Post-NDA Approval Sequence
5. Subscription Document Receipt Alert
6. Wire Receipt Monitor
7. AML Transaction Monitoring
8. Redis Health Check
9. Email Delivery Monitor (Resend webhook)
10. MAS Annual Declaration Reminder
11. FATCA/CRS Annual Reporting Reminder
12. KYC Re-Verification Trigger
13. Fund Reserve Balance Monitor

Timeline: 6–8 weeks of development. These are the automation skeleton.

---

### Phase 2 — Operational (P1) | Build within 90 days of first close

These make operations professional and reduce partner time burden.

14. Gold Price Drop 25% Reserve Deployment Alert
15. Funded Member Welcome Sequence (emails 1–4)
16. Quarterly Letter Reminder
17. NAV Calculation Assistant
18. Annual Tax Statement Generator
19. Annual Vault Verification Reminder
20. Annual Fund Audit Reminder
21. Prism Deal Update Notifier
22. Korean NTS Overseas Reporting Reminder
23. Daily Audit Log Digest
24. API Error Rate Monitor
25. Memo Read Receipt Check

Timeline: 4–6 weeks after Phase 1.

---

### Phase 3 — Quality of Life (P2) | Build in year 1 operations

26. Membership Milestone Notifications (6-month, 1-year)
27. Member Inactivity Detector
28. Annual Procurement Buffer Reconciliation
29. Blob Storage Usage Monitor

Timeline: As bandwidth allows.

---

## PART 4: LIGHTS-OUT OPERATIONS vs. ALWAYS-HUMAN

### What runs fully automatically (no human needed)

- Gold price polling and LTV calculation
- 70% LTV member notification
- Pipeline stage progression after partner approves each gate
- KYC status updates from provider
- Welcome sequence email delivery
- Milestone emails
- Inactivity emails
- Korean NTS, FATCA/CRS, MAS compliance reminder emails to members
- NAV gold component calculation (math only)
- Daily audit log digest
- Redis health monitoring
- Resend bounce detection and member flagging
- AML flag creation (not filing — creation only)
- Capital call read receipt tracking

### What always requires a human partner decision

- NDA approval or rejection
- Approving a member to advance to subscription stage
- Any action at 80% LTV or above
- Initiating a capital call
- Sending a capital call notice (partner approves, system sends)
- Wire receipt confirmation (no direct bank API on this stack)
- NAV sign-off before publishing to members
- Tax statement release to members
- Any AML suspicious transaction report to MAS
- AML flag clearance
- KYC rejection response
- Access restriction for any member
- Any fund-level transaction (bar purchase, reserve deployment)
- Vault verification (physical, with custodian)
- All external filings (MAS, IRAS, ACRA)
- 80% LTV capital call: human decision, system executes
- Any member communication outside templated sequences

### The honest ceiling

With this stack — Vercel Functions, Upstash Redis, Vercel Blob, Resend — you can automate roughly 70% of recurring operational work by volume. The remaining 30% is the irreducible human layer: decisions with legal, financial, or regulatory consequences. The automation architecture above handles surveillance, communication, reminders, and data preparation. The human partner handles authorization, judgment, and external relationships. That split is correct for a regulated Singapore VCC and should remain that way.

---

## PART 5: GOLD PRICE API RECOMMENDATION

Recommended: **Metals-API** (metals-api.com) on a paid tier for 10-minute polling frequency, with **GoldAPI.io** as a hot backup. Both return standard JSON with XAU/USD spot price.

Fallback logic: if primary API returns error, immediately try backup. If both fail for 3 consecutive polls, declare price feed down and freeze all LTV calculations at last-known price — notify partner. Never make LTV decisions on stale price data older than 2 hours.

Store `gold:price:feed_status` in Redis: `live | stale | down`. Surface prominently in admin dashboard.

---

*End of document. Total automations specified: 29. P0: 13. P1: 12. P2: 4.*
