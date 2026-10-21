# Revenue OS — Product UI & Brand System Prompt

> This document is the implementation brief for every UI change to Revenue OS. Treat it as the source of truth. Follow it before inventing a new style or adding one-off CSS.

## Mission and product truth

Design Revenue OS as a calm, capable revenue-operations desk for small service businesses. It helps an owner understand what needs attention, why it matters, what evidence supports it, and what action to take next. The interface should feel like a well-made financial/work ledger: trustworthy, precise, practical, and quietly premium—not a generic AI dashboard, a CRM clone, a crypto terminal, or a marketing landing page.

The primary job-to-be-done is: **show me the most important thing I can act on next, the evidence behind it, and the expected next step.** Every major screen should help answer:
1. What needs my attention?
2. What is known, and which source supports it?
3. What remains uncertain or out of date?
4. What can I safely do next?
5. What changed after I acted?

Truthfulness is part of the visual system. A connected account is not the same as a successful import. A payment promise is not payment evidence. An estimate is not collected revenue. A message draft is not a sent message. A missing row is not proof of payment. An unavailable source must never be styled as an empty source.

## Visual direction: “Revenue Desk”

Use a warm ivory canvas, forest-green navigation and primary action, ink-like near-black green text, soft sage secondary surfaces, restrained amber for needs-attention states, and red only for genuine critical/error states. The design should have a subtle tactile/editorial quality—like a refined paper ledger and a well-made operations tool—but remain a crisp digital interface.

Texture should be almost imperceptible and functional:
- Use layered, low-contrast CSS gradients or a faint warm surface variation only where it improves depth.
- Do not use noisy grain images, glassmorphism, strong gradients, glossy shine, glow, heavy drop shadows, or patterned backgrounds behind dense data.
- Main work surfaces must stay clean and highly readable.
- Use thin rules, carefully aligned columns, and whitespace to establish hierarchy rather than surrounding every item with a card.
- Use a small number of elevation levels: flat canvas, outlined panel, and a floating menu/dialog only when needed.

## Brand and logo

The brand is **Revenue OS**. Use the same exact wordmark spelling and a single canonical mark asset everywhere.

- Rework `public/revenue-os-mark.svg` as a simple, recognizable 64×64 scalable mark representing revenue clarity / upward progress. It must work in monochrome, at 16–24 px, and on light or dark surfaces. Prefer a solid forest-green geometry with one restrained sage/green signal detail. No blue/green competing gradients, no fine lines that disappear at favicon size, no overlapping shapes that look accidental.
- Keep the icon and wordmark separate: the mark is the SVG asset; the wordmark is live text so it remains sharp and accessible.
- In the application sidebar, align mark and wordmark on one baseline with consistent optical spacing; no improvised CSS bar logo, no duplicated icon, no stretching, no cropping.
- Use the mark at a consistent 28–32 px in the app sidebar and 36–44 px on sign-in/onboarding surfaces. Favicon may use the mark alone.
- Give the logo adequate clear space, preserve aspect ratio, and never recolor it ad hoc per component. Verify at 16, 24, 32, and 48 px, on ivory and forest surfaces.
- Logo alt text is empty when adjacent wordmark already names the product; use “Revenue OS” when the mark appears alone.
- Keep `index.html` favicon and theme color aligned with the same brand tokens. Do not create a second unofficial logo in CSS.

## Color tokens

Define semantic CSS custom properties in one canonical place. Components should consume semantic roles, not hard-coded colors.

Suggested initial palette (adjust only after contrast and UI review):
- `--page: #F7F5EF` — warm ivory application canvas.
- `--surface: #FFFEFA` — clean primary surface.
- `--surface-soft: #F0F2EB` — quiet sage/secondary surface.
- `--sidebar: #183B32` — deep forest navigation.
- `--sidebar-ink: #F5F5EC` — navigation foreground.
- `--sidebar-muted: #B8C9BE` — secondary navigation text.
- `--ink: #202923` — primary text.
- `--muted: #657168` — supporting text; ensure contrast.
- `--line: #DADFD6` — dividers and outlines.
- `--action: #245B46` — primary action and selected states.
- `--action-hover: #194A38` — hover.
- `--verified: #24754E` — verified/success only.
- `--warning: #A96316` — caution/needs attention.
- `--critical: #B33B35` — critical errors only.
- `--focus: #2D7C63` — visible keyboard focus.
- `--money-font: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Consolas, monospace` — only for numeric financial values when suitable.

Never rely on color alone to communicate state; include clear labels and/or icons. Keep contrast WCAG 2.2 AA targets (4.5:1 normal text, 3:1 large text and essential UI boundaries). Do not automatically switch to a dark theme based on operating-system preference unless a deliberately designed and tested dark theme exists. Default to light mode.

## Typography

Use a reliable, licensed, self-hosted/open-source UI sans where feasible. Prefer Inter or system sans; do not add a remote font dependency just for decoration. Use a restrained mono face only for financial numerals, IDs, timestamps, and tabular values. No decorative display fonts.

- Page title: 28–32 px desktop, 25–28 px mobile; 1.15–1.25 line-height; medium/semi-bold.
- Section heading: 16–20 px; clear hierarchy, not oversized.
- Body: 14–16 px with 1.45–1.6 line-height.
- Table and compact controls: 13–14 px; avoid tiny 10–11 px text for important data.
- Helper/meta text: 12–13 px only when genuinely secondary and contrast-safe.
- Money and counts: tabular numerals; align amounts vertically; preserve currency codes and do not imply precision the source does not have.
- Use sentence case. Avoid all-caps labels except very short quiet eyebrows.

## Layout, spacing, and surfaces

- Use a 4 px base spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Desktop: stable sidebar around 232–248 px; main work area capped to a comfortable readable width but may widen for dense tables; page padding 28–40 px.
- Tablet: reduce padding and sidebar width deliberately; do not simply shrink everything.
- Mobile: collapse sidebar into a clear navigation pattern; do not leave a tall desktop sidebar above the content. Stack metrics, keep primary actions reachable, and make tables scroll or transform into readable rows.
- Prefer ruled lists and grouped work queues to endless grids of identical cards. Use cards only when a group has its own meaningful boundary or action.
- Use 8–12 px radii consistently. Avoid pill-shaped everything. Pills are for compact statuses only.
- Shadows are rare, soft, and reserved for menus, dialogs, or floating controls. Most panels use a subtle border and surface contrast.
- Do not add decorative charts or fake data just to fill space.

## Navigation and screen patterns

The app should feel like one coherent product across Overview, Urgent, Follow-ups, Opportunities, Lead Recovery, Actions, Outcomes, Business Brain, and Connections.

- Sidebar: logo at top; clear workspace context; concise navigation labels; active section uses a subtle sage tint / border or icon emphasis. The sidebar should not visually overpower the working area.
- Top bar: current location / breadcrumb and only useful contextual controls. Avoid duplicate page titles and status indicators.
- Page heading: title, one-sentence explanation, then one primary action and optional secondary action.
- Overview / daily brief: prioritize the top 1–3 actionable items with evidence, why now, owner/next step, and confidence/freshness. Summaries must reflect saved records and disclose when sources are not monitored in the background.
- Urgent and Follow-ups: readable queue with clear priority, amount/customer/context, source and last-updated evidence, plus the safest next action. Avoid alarm-red styling for ordinary overdue work.
- Opportunities: distinguish estimated value from observed/verified value and show the assumptions used.
- Lead Recovery: concise stage/status, next follow-up, last interaction and source. Never label a lead ignored solely because one channel lacks a reply.
- Actions: separate proposed, approved, and manually sent states. Approval controls must be explicit; sending remains manual unless a future, separately approved integration genuinely supports it.
- Outcomes: show the evidence window, matching confidence and payment-source provenance. Separate timing association from causal attribution.
- Business Brain: distinguish facts, assumptions, conflicts, and stale information; show source and audit context.
- Connections: each provider gets a clear state, access scope, last successful sync, last error, selected resource, accepted/rejected counts, and retry/reconnect action where available. Never show “Synced” without a real successful sync.
- Settings and onboarding: explain what the user is connecting, what Revenue OS can read/do, and how to recover from failure in plain language.

## Component contract

Build reusable, consistent variants for:
- Primary, secondary, tertiary/link, destructive, loading, disabled, and icon buttons.
- Inputs, selects, textareas, validation help, inline errors, and confirmation dialogs.
- Status chips with text labels and semantic color.
- Evidence rows with source, timestamp, confidence/qualification, and details.
- Work queue rows, data tables, metric summaries, empty states, loading skeletons, error/retry panels, notices, and pagination/filters where needed.
- Dialogs/drawers for focused review only; prefer inline/contextual actions where clearer.
- Keyboard focus, hover, pressed, disabled, and loading states.
- Icons should share one stroke style, optical size, and baseline. Use existing icon conventions before adding another icon package.

Every stateful component needs appropriate success, loading, empty, unavailable, error, disabled, and partial-data states where relevant. No fake loading animation or optimistic success before the server confirms a mutation. Use clear success feedback and prevent double submission.

## Motion and interaction

- Keep motion functional and restrained: roughly 120–180 ms for simple state transitions.
- No parallax, bouncy animations, animated gradients, or decorative entrance sequences.
- Respect `prefers-reduced-motion`.
- Make keyboard operation possible, keep focus visible, use semantic buttons/links and accessible labels, and announce meaningful async results to assistive technology.
- Touch targets should generally be at least 44×44 px.
- Do not use hover as the only way to reveal critical information.

## Copy and trust

Use concise, calm, human language. Prefer “Last successful sync”, “Needs attention”, “No successful import yet”, and “Payment evidence not found” over vague green “Connected” labels. State what is known, what is not known, and the next useful action. Avoid hype, anthropomorphic AI language, fabricated confidence, and promises of automatic monitoring that the deployed system does not perform.

## Technical implementation rules

- First inspect the existing app, design files, components, assets, and current production/preview behavior. Extend existing components and design tokens instead of building a parallel UI or a second data model.
- Keep this React + Vite + TypeScript app’s existing Supabase/auth/domain/business logic intact. This is a UI/brand task: do not rewrite data workflows, RLS, migrations, OAuth scopes, or payment logic as collateral.
- Keep business calculations and truth-state logic separate from presentation.
- Avoid adding dependencies unless a clear capability gap is demonstrated.
- Do not introduce a logo asset that is not used consistently by app navigation, authentication, favicon, and any existing marketing surface.
- Never claim a feature, source connection, sync, payment, or action is live unless its real state proves it.
- Use semantic CSS variables and remove contradictory/duplicated overrides when safe. No giant appended patch layers as the final architecture.
- Make incremental commits on a feature branch and open a PR. Do not deploy production merely because a PR is open or merged.

## Definition of done

1. The visual language is consistent across all primary screens and auth/onboarding.
2. Logo is clear at favicon size, correctly aligned in the sidebar, and used consistently.
3. Text, money, statuses, tables, and forms have a deliberate hierarchy and readable contrast.
4. Texture is subtle, surfaces are calm, and the interface feels crafted rather than template-generated.
5. Desktop, tablet, and mobile layouts are checked at representative widths.
6. Keyboard navigation, visible focus, semantic controls, reduced motion, and status announcements are verified.
7. Empty, loading, error, partial-data, connected-but-unsynced, and successful-sync states are honest and usable.
8. Existing business logic and data persistence still work; design changes do not regress CSV, lead, action, payment-evidence, or connection workflows.
9. Build, lint, domain tests, browser tests, and a preview of the exact PR head pass; inspect the preview before merging.
10. Report exactly what changed, what was tested, what remains unverified, and whether production was deployed.
