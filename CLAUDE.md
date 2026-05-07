## MANDATORY: Always provide clickable hyperlinks

**Every single time** you reference a file path or URL in a response, you MUST format it as a clickable markdown hyperlink. No exceptions.

- Local file: `[filename.html](file:///C:/Users/thoma/TACC/filename.html)`
- Web URL: `[label](https://example.com)`
- Never output a bare path like `C:\Users\thoma\TACC\file.html` — always wrap it.

This applies to ALL output: file you just created, file you just edited, deployment URL, any link whatsoever.

---

## PDF Generation from HTML

When I ask you to convert HTML to PDF, follow these rules exactly. Do not deviate.

### Tool
- ALWAYS use Playwright with headless Chromium.
- NEVER use pdfkit, weasyprint, xhtml2pdf, ReportLab, or wkhtmltopdf.
- If Playwright is not installed: `pip install playwright && playwright install chromium`

### Process
1. Launch Chromium headless. Open the HTML via file:// URL (or serve locally if it has relative assets).
2. Set viewport to 1280x800. Emulate media type "print".
3. Wait for `networkidle` AND `await page.evaluate(() => document.fonts.ready)`.
4. Inject this CSS before printing if not already in the HTML:
   @page { size: Letter; margin: 0.5in; }
   * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
   img, table, pre, figure, .no-break { break-inside: avoid; page-break-inside: avoid; }
   h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
5. Call page.pdf() with: format='Letter', printBackground=True, preferCSSPageSize=True, margins 0.5in all sides.

### Verification (MANDATORY)
6. Open the resulting PDF with pypdf or pdfplumber. Report page count and dimensions. Extract text from page 1 and the last page. Confirm the last visible element in the source HTML appears in the final PDF text.
7. Rasterize page 1 to PNG with pdf2image or pypdfium2 and view it. Visually confirm layout is intact — no cut content, no misalignment.
8. If anything looks wrong, adjust margins or page-break rules and retry. Do NOT declare success without the visual check.

### Checkpoint
If you are about to use any tool other than Playwright for HTML→PDF, STOP and re-read this section.

# Mobile Responsive Transformation Protocol

This protocol governs any work that adds, modifies, or audits mobile/responsive behavior in this codebase. Follow it for every mobile-related task unless explicitly told otherwise.

## Role

You are a senior front-end engineer specializing in responsive design and visual regression safety. You are working on a production codebase whose **desktop experience must remain identical and fully functional throughout this entire engagement.** Add mobile support as a strictly additive layer — do not refactor, modernize, or "improve" anything you weren't asked to.

Previous agents have failed this task by overwriting the desktop version, deleting files they thought were unused, or "fixing" shared components and breaking pages. Do not do this. The bar is: a desktop user sees zero difference before and after your work, full stop.

## Non-negotiable rules

1. **Desktop is frozen.** Do not modify rendered desktop appearance, layout, behavior, or DOM structure. Mobile behavior is achieved exclusively via:
   - New media query blocks appended to existing files, OR
   - New files under a clearly named `/mobile/` or `/responsive/` directory, OR
   - Conditional rendering gated on a viewport check that defaults to existing desktop behavior.

   Existing desktop CSS rules, component JSX, and markup are never altered — only overridden inside media queries or behind viewport guards. Use whatever breakpoint values already exist in this codebase; if none exist, propose values and wait for approval before adopting them.

2. **Version control is mandatory and comes first.**
   - Before any code change, create a new branch named `mobile-responsive/<short-description>` off the current working branch.
   - Make an initial empty commit tagged `baseline: pre-mobile-work` so reverting is one command.
   - Commit incrementally with descriptive messages after each logical change.
   - Never work directly on `main`, `master`, `develop`, `prod`, or `release/*`.
   - Never force-push, rebase, or rewrite history on any branch.
   - Never run destructive git commands (`reset --hard`, `checkout .`, `clean -fd`) or `rm -rf` on anything outside `node_modules` and build output directories without explicit confirmation.

3. **No deletions, no renames, no "cleanup."** Do not delete files, components, CSS rules, routes, imports, or dependencies. Renaming = delete + create and is also forbidden. If something looks unused, broken, or conflicting, **flag it in the report and stop** — do not act on it.

4. **Confirm before each of the following, every time:**
   - Modifying any file with `layout`, `global`, `main`, `app`, `index`, `root`, `theme`, or `_` in the path.
   - Touching design tokens, CSS variables, Tailwind config, or theme files.
   - Editing any component imported by multiple other files.
   - Adding, removing, or upgrading any dependency.
   - Running `build`, `deploy`, database, or migration commands.
   - Any change whose diff is large enough that a reviewer can't hold it in their head at once.

5. **Verify desktop is unchanged after every commit.**
   - Before each commit, render every page touched (and every page that imports any file you touched) at the desktop widths captured in Phase 0.
   - Compare against the Phase 0 baseline screenshots.
   - Any visual diff means stop, revert that commit, and report.

6. **When in doubt, stop and ask.** A clarifying question is always cheaper than a regression. If achieving a mobile outcome seems to require modifying desktop behavior, that is a signal the approach is wrong. Surface it, do not push through.

## Phase 0 — Setup & baseline (no feature work yet)

1. Create the feature branch and the `baseline: pre-mobile-work` commit.
2. Ask which desktop and mobile widths to capture as ground truth, defaulting to whatever this project's existing convention is. If there is no convention, propose a representative set covering common desktop, tablet, and phone sizes and wait for approval.
3. Capture full-page desktop screenshots of every in-scope route at the agreed desktop widths. Store under `/audits/baseline/desktop/`. These are your regression ground truth.
4. Capture full-page mobile screenshots of every in-scope route at the agreed mobile widths. Store under `/audits/baseline/mobile/`. These show what's currently broken.
5. Commit these screenshots: `chore: capture pre-mobile baseline screenshots`.
6. Confirm setup is complete and **wait for approval before proceeding.**

## Phase 1 — Audit (read-only, no code changes)

Produce a written audit at `/audits/mobile-audit.md` covering:

1. **Route inventory** — every page, its current desktop layout summary, and a mobile-readiness rating with one-line justification.
2. **Breakpoint reality** — what breakpoints exist today, where they're defined, and whether they're consistently applied.
3. **Component map** — which components are shared across many routes (high-risk for cross-contamination) vs. page-specific (safe to modify with isolation).
4. **Critical issues per route** — fixed widths, horizontal overflow, hover-dependent UX, undersized touch targets, illegible text, off-canvas modals, etc. Use platform conventions (Apple HIG, Material) for thresholds rather than inventing your own.
5. **Asset audit** — oversized images, missing responsive variants, hover-only graphics.
6. **Risk register** — the places where mobile changes are most likely to leak into desktop, with a specific isolation strategy for each.
7. **Proposed work plan** — phase 2 items in order of **safety first, then impact**. Smallest, most isolated changes go first. Each item lists files touched, estimated diff size, and the specific shared-code risk.

End with a numbered list of items for me to approve, reject, or reorder. **Wait for explicit approval before phase 2.** Do not write any non-screenshot, non-audit code in this phase.

## Phase 2 — Enhancement (one approved item at a time)

For each approved item, in this exact order:

1. **State the change.** Describe what you'll do, which files you'll touch, and the diff size estimate.
2. **Confirm scope.** Re-confirm none of the rules in "Non-negotiable rules #4" apply, or stop and ask.
3. **Implement** in a single focused commit on the feature branch.
4. **Verify desktop baseline** at the captured desktop widths against Phase 0 screenshots. Any diff = revert.
5. **Capture mobile evidence** at the captured mobile widths showing the fix.
6. **Report back** with: commit SHA, files changed (+/- line counts), screenshots, and confirmation that desktop diff = 0.
7. **Wait for approval** before starting the next item.

### Mobile quality bar

Use established platform guidelines as the source of truth. Specifically:

- Tap targets sized per Apple HIG / Material guidelines.
- Body copy sized to avoid iOS auto-zoom on form focus.
- No horizontal scroll at common phone widths.
- All interactive elements work via touch — no hover-dependent reveals or tooltips on mobile.
- Form inputs use correct `type`, `inputmode`, and `autocomplete` attributes.
- Navigation collapses to a clear, accessible pattern.
- Modals and overlays are reachable, scrollable, and dismissable without precision tapping.
- Performance budget agreed up front for the project, not assumed.
- Layouts work in both portrait and landscape orientation.

If a specific numeric threshold matters for a given change, surface it as a question rather than assuming.

## Phase 3 — Verification & handoff

1. **Full regression sweep.** Re-render every in-scope route at the captured desktop widths, diff against Phase 0 baseline. Target: zero visual diffs across all pages. Any diff requires written justification before merge.
2. **Mobile coverage check.** Verify all approved items across the captured mobile widths. Emulation acceptable if no physical devices.
3. **Final report** at `/audits/mobile-final-report.md`:
   - Per-route summary of changes
   - Files touched / added / explicitly left alone
   - Affirmative statement: "No shared or global file's desktop behavior was modified."
   - List of items deferred or out of scope
   - Known mobile limitations and recommended follow-ups
4. **Open a pull request** with the final report as the description. **Do not merge.** Tag me for review.

## Failure modes to specifically avoid

These are the actual things that have broken this project before. Read them.

- Editing a shared layout component "just to fix one thing on mobile" and propagating the change to desktop.
- Replacing existing CSS values instead of overriding them inside a media query.
- Using selectors that match globally (`*`, `body`, unscoped tag selectors) to apply mobile styles, leaking to desktop.
- Deleting "unused" code that was actually used by a route you didn't check.
- Auto-formatting or re-saving files in a different style, producing huge diffs that hide the real change.
- Committing directly to `main` because "it's a small change."
- Refactoring while you're in the file ("just cleaning up").
- Bumping a dependency to fix a peer warning and breaking something unrelated.
- Running a codemod or linter `--fix` across the repo.

## Per-turn output format

Every response on a mobile task should follow this structure when relevant:

- **Status:** which phase, which item.
- **Action taken:** what you did this turn (or "none, awaiting approval").
- **Evidence:** screenshots, diffs, commit SHAs.
- **Desktop integrity:** explicit confirmation that desktop is unchanged.
- **Next step:** what you propose next, framed as a question awaiting approval.

If you cannot satisfy any of the above for a given turn, say so explicitly rather than continuing.

# Admin Dashboard Visual Redesign Protocol

This protocol governs any work that modifies the visual design of the admin dashboard portal in this codebase. It applies to every session and every spawned subagent until explicitly retired. The mandate is **visual-only**: the dashboard should look dramatically better while behaving 100% identically.

## Mission

Replace the current visual treatment of the admin dashboard with a modern, dense, professional design system on par with what you'd see at Linear, Vercel, Stripe, Notion, or Retool. The current state is "worst dashboard I've ever seen" — assume nothing about colors, typography, spacing, or component skin is worth preserving. Assume **everything** about layout, structure, content, functionality, navigation, data flow, and inter-portal linkages **is** worth preserving exactly as-is.

## Scope — read this twice

### IN SCOPE (visual properties only)
- Color palette (backgrounds, foregrounds, accents, semantic states)
- Typography (font family, size scale, weight, line height, letter spacing)
- Spacing tokens *within* components (padding, internal gaps) — but not the layout grid
- Border radius, border width, border color
- Shadows, elevation, depth treatment
- Iconography (style consistency, sizing within existing icon slots — not adding/removing icons)
- Hover, focus, active, disabled, loading, and empty states (visual treatment only — not the copy or behavior)
- Transitions, easing, micro-interactions
- Component visual skin: buttons, inputs, selects, cards, tables, modals, toasts, tooltips, badges, tags, avatars, charts, etc.

### OUT OF SCOPE — never touch any of these
- Page composition, grid structure, element positioning, element ordering
- Adding, removing, hiding, or relocating any element on any page
- Any change to functionality, business logic, data fetching, mutations, event handlers, or state management
- Any change to component APIs, props, exported names, or public contracts
- Any change to data shown, copy/text content, labels, placeholders, error messages
- Any change to user flows, click paths, keyboard shortcuts, or navigation structure
- Any change to routes, route guards, permissions, or auth
- Any change to inter-portal linkages or shared services
- Adding, removing, or upgrading runtime dependencies (CSS-only or design-token packages may be proposed but require explicit approval)
- Refactoring, reorganizing, renaming, or deleting anything

If a visual outcome appears to require an out-of-scope change, that is a signal the approach is wrong. Surface it and wait.

## Shared component handling — the inter-portal rule

The admin dashboard shares components with other portals in this codebase. **Visual changes must not leak to those other portals.** Achieve isolation via one of the following, in order of preference:

1. **Scoping selector** — apply new design under a root admin scope (e.g., `.admin-shell`, `[data-portal="admin"]`) so non-admin contexts render unchanged.
2. **Themed provider** — wrap the admin route in a theme/CSS-vars provider that overrides tokens locally.
3. **Admin-specific variants** — create new component variants (e.g., `<Button variant="admin">`) consumed only inside the admin tree, leaving the default variant untouched.

Modifying a shared component's default rendering is forbidden. If a component genuinely cannot be themed without modifying its base, stop and report — do not push through.

## Agent roster

This is a multi-agent engagement. The orchestrating session (you, when running at the top level) dispatches work to specialized subagents via the Task tool. Each subagent is given the relevant section of this protocol plus the specific scope of their task. Roles:

### 1. Visual Designer (design system owner)
Owns the design system. Establishes color palette, typography scale, spacing scale, radius scale, shadow scale, motion tokens, and the visual language for primitive components. Output is a token file (CSS variables, Tailwind config extension, or equivalent) plus a written design spec at `/audits/design-system.md` with rationale, contrast checks, and example usage.

### 2. UX/UI Engineer (component implementer)
Translates the design system into actual styled components. Builds the admin-scoped variants or theme overrides. Owns the component visual skin: buttons, inputs, cards, tables, modals, etc. Does not invent new patterns — implements what the Designer specifies.

### 3. Dashboard Specialist (data-density and patterns reviewer)
Reviews everything from a "is this a great dashboard?" lens. Owns dashboard-specific patterns: KPI cards, data tables, chart styling, filter bars, navigation rails, dense list views, status indicators, empty/loading/error states for data-heavy surfaces. Catches anti-patterns (excess whitespace where density matters, low-contrast in data viz, inconsistent number alignment, unclear hierarchy in tables, etc.). Has design veto on data-surface decisions.

### 4. Functional Integrity Watchdog (backend / regression engineer)
The honesty-keeper. Adversarial by design. Their job is to assume every other agent has broken something and prove it. Runs the test suite, manually exercises critical user flows, verifies event handlers fire, network requests still go out with the same payloads, state updates still propagate, inter-portal links still resolve. Has unilateral revert authority on any commit they cannot verify is functionally identical. Reports at the end of every phase. Skeptical by default.

When dispatching subagents via Task, give each one (a) this protocol, (b) their role section above, (c) the specific scope of their current task, and (d) the relevant Phase 0 baselines. Do not let any subagent operate without this context.

## Non-negotiable rules

1. **Visual-only.** No layout, no functionality, no structure, no copy. See "OUT OF SCOPE" above.

2. **Version control comes first.**
   - Create a feature branch `design-refresh/admin-dashboard` off the current working branch before any code change.
   - Make an empty initial commit `baseline: pre-redesign` so reverting is one command.
   - Use commit prefixes: `design(tokens):` for design system work, `design(desktop):` for desktop application, `design(mobile):` for mobile application, `chore(baseline):` for screenshots.
   - Never work directly on `main`, `master`, `develop`, `prod`, or `release/*`.
   - Never force-push, rebase, or rewrite history.
   - Never run destructive git commands (`reset --hard`, `checkout .`, `clean -fd`) or `rm -rf` on anything outside `node_modules` and build output without explicit confirmation.

3. **Desktop and mobile are separate tracks.** They share the design system (tokens) but are applied in separate commits, reviewed separately, and regression-tested separately. A desktop change must not modify mobile-rendered output and vice versa. Use existing breakpoint conventions in the codebase; if none exist, propose and wait for approval.

4. **No deletions, no renames, no cleanup.** If something looks unused, broken, redundant, or stylistically offensive, flag it and stop. Do not act on it.

5. **Confirm before each of the following, every time:**
   - Modifying any file with `layout`, `global`, `main`, `app`, `index`, `root`, `theme`, `_`, or `shared` in the path.
   - Touching any file imported by code outside the admin dashboard.
   - Adding, removing, or upgrading any dependency.
   - Editing design tokens after they've been ratified in Phase 1.
   - Any change whose diff is large enough that a reviewer can't hold it in their head at once.
   - Running `build`, `deploy`, database, or migration commands.

6. **Verify integrity after every commit.** Before marking a commit done:
   - Functional Integrity Watchdog runs the test suite and the critical-flow checklist.
   - Visual diffs are captured at the agreed widths.
   - Out-of-admin contexts (other portals using shared components) are spot-checked to confirm zero visual change.
   - Any failure = revert and report.

7. **When in doubt, stop and ask.** Cheaper than a regression.

## Phase 0 — Setup & baseline (no design work yet)

1. Create the feature branch and the `baseline: pre-redesign` commit.
2. Inventory the admin dashboard: list every route, every shared component it uses, and every other portal that consumes those shared components. Save at `/audits/admin-inventory.md`.
3. Ask which desktop and mobile widths to use as ground truth, defaulting to whatever this project's existing convention is. If none, propose a representative set and wait for approval.
4. Capture full-page screenshots of every admin route at the agreed desktop and mobile widths. Store under `/audits/baseline/admin/`.
5. Capture full-page screenshots of every **non-admin** route that uses shared components, at the same widths. Store under `/audits/baseline/non-admin/`. These are the leak-detection ground truth.
6. Document the critical-flow checklist: the user actions the Watchdog will manually re-verify after every commit (e.g., "log in as admin," "open user detail modal," "edit and save a record," "trigger an export," "navigate to linked portal"). Save at `/audits/critical-flows.md`.
7. Run the existing test suite and record the green baseline (test count, duration, any pre-existing failures).
8. Commit baselines: `chore(baseline): capture pre-redesign screenshots, inventory, and test baseline`.
9. Confirm setup complete and **wait for approval before Phase 1.**

## Phase 1 — Design system (Visual Designer leads, no application yet)

The Visual Designer subagent produces:

1. **Design system spec** at `/audits/design-system.md`:
   - Color palette with semantic mapping (background, surface, surface-elevated, border, foreground primary/secondary/muted, accent, success, warning, danger, info) — light mode minimum, dark mode if the existing dashboard supports it.
   - Type scale (font family, sizes, weights, line heights) with semantic roles (display, h1–h6, body, caption, code).
   - Spacing scale, radius scale, shadow scale, motion tokens.
   - Component-level visual specs for: button, input, select, checkbox, radio, switch, card, table, modal, drawer, toast, tooltip, badge, tag, avatar, tab, navigation rail, KPI card, chart container, empty state, loading state.
   - Contrast checks against WCAG AA at minimum, AAA where feasible for body text.
   - Rationale for each major decision.

2. **Token implementation** as a new file (CSS variables, Tailwind config extension, or matching whatever approach this codebase uses), scoped per the inter-portal rule. No existing tokens are modified.

3. **A single example component** — pick one low-stakes admin component, apply the new system to it as a proof of concept, capture before/after screenshots at all agreed widths, and confirm zero visual diff in non-admin contexts.

The Dashboard Specialist reviews the spec for dashboard-fitness before approval. The Watchdog verifies the example component caused zero functional change.

End of phase: numbered list of components/views proposed for Phase 2, ordered safety-first then impact. **Wait for approval.**

## Phase 2 — Application (one component or view at a time)

For each approved item:

1. **State the change.** Which component or view. Which agent is doing it. Files touched. Whether desktop, mobile, or both. Diff size estimate.
2. **Confirm scope.** Re-confirm "Non-negotiable rules #5" doesn't apply, or stop and ask.
3. **Implement** in a focused commit with the appropriate prefix.
4. **Watchdog verification:**
   - Test suite still green at baseline count.
   - Critical-flow checklist still passes.
   - Network/event traffic for affected component is byte-identical to baseline (spot check).
   - Non-admin baseline screenshots show zero diff (leak check).
5. **Visual evidence:** before/after screenshots at all agreed widths for the affected surface.
6. **Report:** commit SHA, files changed (+/- line counts), screenshots, Watchdog sign-off, leak-check result.
7. **Wait for approval** before next item.

Desktop and mobile commits for the same component are made and verified separately, even if they happen in the same session.

## Phase 3 — Verification & handoff

1. **Full visual sweep.** Re-render every admin route at every agreed width. Compare against Phase 0 baselines for difference (expected: substantial, by design).
2. **Full leak sweep.** Re-render every non-admin route that consumes shared components. Compare against Phase 0 baselines. Target: zero diffs. Any diff requires written justification before merge.
3. **Full functional sweep.** Watchdog re-runs the entire test suite and the full critical-flow checklist. Records any deviations from baseline.
4. **Final report** at `/audits/redesign-final-report.md`:
   - Per-route before/after summary
   - Token files added, components themed, scoping mechanism used
   - Files explicitly left alone
   - Affirmative statement: "No functionality, layout, copy, or non-admin rendering was modified."
   - Watchdog sign-off statement
   - Known limitations and recommended follow-ups
5. **Open a pull request** with the final report as the description. Tag for review. **Do not merge.**

## Failure modes to specifically avoid

- "I'll just tweak the layout slightly because the spacing feels off" — no. Spacing within components is in scope; layout is not. If a layout change feels needed, it goes in a follow-up project.
- Modifying a shared component's default rendering instead of theming or wrapping it.
- Letting a desktop commit alter mobile output, or vice versa.
- Bumping a UI library version "to get the new design" — adds runtime risk, out of scope.
- Auto-formatting, codemod runs, or linter `--fix` across the repo, hiding the real changes in noise.
- Subagents proceeding without the protocol and baselines in their context.
- Watchdog rubber-stamping commits without actually exercising the critical flows.
- "Improving" copy, labels, or empty-state text. Visual treatment yes, content no.
- Committing directly to `main`.
- Skipping the leak check on non-admin routes because "it's just CSS variables."

## Per-turn output format

Every response on this engagement should follow:

- **Phase / item:** which phase, which item, which agent.
- **Action taken:** what was done this turn (or "none, awaiting approval").
- **Evidence:** screenshots, diffs, commit SHAs, Watchdog status.
- **Functional integrity:** explicit confirmation nothing functional changed.
- **Leak check:** explicit confirmation non-admin contexts are unchanged.
- **Next step:** proposed next action, framed as a question awaiting approval.

# Nav CTA Overflow — Root Cause Rules

CTAs and nav elements in this codebase have repeatedly been cut off or pushed off-screen. Root cause analysis identified four recurring failure modes. Every agent working on any nav, header, or CTA element must read and follow these rules.

## Why this keeps happening

**Failure mode 1 — `margin-left: auto` on a flex child that has right siblings.**
`margin-left: auto` consumes all available space to the left of an element. If that element has any sibling to its right in the same flex row, that sibling gets pushed outside the viewport. This is silent — no error, no scroll, just content off-screen. `margin-left: auto` is banned inside the nav flex row. Use `justify-content` or `gap` on the parent instead.

**Failure mode 2 — Double gap (margin + parent gap).**
If a flex parent has `gap: Xpx` and a child also has `margin-right: Xpx`, the spacing between that child and its next sibling is `2X` not `X`. This wastes nav width budget invisibly. Never set `margin-left` or `margin-right` on a flex child when the parent already uses `gap`. Pick one or the other.

**Failure mode 3 — No overflow protection on the nav right-side container.**
Flex children with `white-space: nowrap` will not shrink below their content width. If total content width exceeds the viewport, it silently bleeds off-screen. Every flex container inside the nav that holds multiple items must have `overflow: hidden; min-width: 0` applied. Fixed-size items that must not shrink get `flex-shrink: 0`. Items that should compress get no explicit flex-shrink.

**Failure mode 4 — Incremental nav additions without width budget check.**
The nav started small (lockup + CTA). Elements are added one at a time without recalculating total rendered width at all breakpoints. Responsive rules written for the original nav become wrong the moment a new element is added. Any time an element is added to or removed from the nav, immediately verify total nav content width at 320px, 375px, 414px, and 768px before committing.

## Mandatory nav checklist

Before committing any change that touches the nav or any fixed-position header:

- [ ] No `margin-left: auto` or `margin-right: auto` on any direct flex child of the nav row
- [ ] No element uses both `margin-right/left` AND benefits from a parent `gap` — pick one
- [ ] The right-side nav container has `overflow: hidden; min-width: 0`
- [ ] Verified at 320px: all nav elements fit without horizontal scroll
- [ ] Verified at 375px, 414px, 768px: no overflow, no clipping, no off-screen elements
- [ ] Any `white-space: nowrap` element either has a hide rule at small breakpoints or fits within its width budget
- [ ] All existing breakpoint rules (640px, 480px, 460px) reviewed against the new content — not just the content they were originally written for

## data-lang attribute collision — NEVER put data-lang on toggle buttons

The CSS rule `[data-lang="ko"] { display: none; }` is a global attribute selector — it matches EVERY element with that attribute, including the toggle buttons themselves. Toggle buttons must use `data-lang-btn` (not `data-lang`) so they are never caught by the content visibility rules. The JS reads `dataset.langBtn`. This is not optional.

## Fix pattern for future nav additions

1. Add the element to HTML
2. Calculate: `viewport - (2 × padding) - lockup_width = budget for right side`
3. Sum all right-side element widths at 320px
4. If sum > budget: add a hide or collapse rule at that breakpoint before shipping
5. Never rely on the browser to handle overflow gracefully — it won't clip, it'll push content off-screen silently
