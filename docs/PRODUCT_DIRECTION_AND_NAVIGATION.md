# Revenue OS — Product Direction and Navigation

**Status:** Proposed product direction for review  
**Scope:** Product vision, MVP boundaries, information architecture, and next delivery sequence. This document does not authorize a production deployment, database migration, or new external integrations.

## 1. Product thesis

Revenue OS is an evidence-led business attention and execution system for small and growing businesses. It helps an owner answer four questions:

1. What needs my attention?
2. Why does it matter, and what evidence supports it?
3. What is the safest useful next action?
4. Did the situation actually improve?

**North-star outcome:** verified incremental or recovered revenue. Keep estimated opportunity value, reported outcomes, and verified payments distinct. A payment observed after a reminder is not proof that the reminder caused the payment.

Positioning statement: **Revenue OS turns scattered business records into a prioritized list of revenue risks and opportunities, with evidence-backed next actions and measurable outcomes.**

The longer-term “business watchman” vision can include sales, money, commitments, and operational gaps. The MVP must earn this breadth by making one or two recurring workflows dependable first.

## 2. Initial customer and validation

### Working customer hypothesis
Small service businesses and agencies where the owner personally manages enquiries, quotations, deposits, invoices, follow-ups, and delivery commitments using spreadsheets, messaging apps, and memory.

This is a hypothesis, not a final market decision. Use WebAura's real workflows and 3–5 consenting service businesses to test it before broadening the target segment.

### Two workflow candidates to compare
- **Stalled prospect / quotation recovery:** find a documented next step that is overdue; explain the evidence and help the owner follow up.
- **Overdue invoice recovery:** find an overdue unpaid balance from saved invoice data and calculate a possible recovery estimate using an explicit assumption.

Do not decide based on which screen looks better. Compare frequency, urgency, willingness to pay, data availability, time-to-value, and whether users complete the recommended action.

A lead's silence alone is not sufficient evidence that it is stalled. If next-step date or activity evidence is missing, label it **Needs review**, not stalled.

## 3. Product loop

**Source evidence → detected issue/opportunity → ranked next action → human approval → recorded action → observed outcome → learning.**

Every finding should expose:
- what was detected;
- why it matters;
- the exact source record(s);
- rule and assumptions used;
- what is known versus estimated;
- recommended next step and owner;
- status, timestamps, and the outcome if known.

Deterministic code owns money calculations, date comparisons, matching, and state transitions. AI may summarize evidence and draft recommendations, but it must not invent source facts or bypass approval for consequential external actions.

## 4. Navigation proposal

Use one primary command centre with domain workspaces. Navigation labels should describe the owner's job, not internal technical modules.

| Navigation | Purpose | Key content |
| --- | --- | --- |
| **Overview** | Start the day and understand the business | Prioritized attention, known unpaid money, pipeline estimates, commitments at risk, recent verified outcomes, data freshness |
| **Attention** | Decide what to handle next | Unified ranked queue across overdue invoices, due follow-ups, quotations, deposits, tasks, disputes, unanswered enquiries, and payment-review items |
| **Sales** | Recover opportunities before they go cold | Leads, enquiries, quotations, next-step dates, follow-up history, owner, status, reason for “Needs review” |
| **Money** | Understand what is owed and what arrived | Invoices, balances, payments, deposits, unmatched-payment review, reconciliation status, aging |
| **Commitments** | Keep promises and delivery work on track | Tasks, due dates, action owners, customer promises, blockers, overdue commitments |
| **Actions** | Prepare and control work | Drafts, approval queue, approved / copied / manually sent states, action history, retry and failure status |
| **Outcomes** | Measure what changed | Payment evidence, resolved issues, reported conversions, verified revenue, attribution window and caveats |
| **Business Brain** | Inspect what the system believes | Facts, assumptions, evidence, conflicts, source, timestamp, confidence/verification status, change history |
| **Connections** | Manage data sources | CSV/manual import, Google Sheets, connection status, last successful sync, actionable sync errors |
| **Settings** | Control the workspace | Organization, team roles, preferences, security, data retention and plan limits |

### Navigation principles
- Overview is the default landing page, not a second copy of every module.
- Attention is the cross-domain queue; domain workspaces are where records are managed.
- Do not create separate top-level pages for every exception type.
- Avoid duplicate screens for the same records.
- Keep a clear empty state and show when checks failed or data is stale; “nothing needs attention” must not be shown when required checks failed.
- On mobile, preserve a compact, usable navigation and make the next action easy to reach.

## 5. Overview screen hierarchy

1. **Header:** workspace, selected period, data freshness, and a restrained “Add records” action.
2. **Today’s focus:** the highest-priority 1–3 actions with a short reason and a link to evidence.
3. **Business position:** separate known unpaid balances, estimated pipeline/opportunity value, and verified received money. Never add unlike currencies together or mix estimates with actuals.
4. **Attention queue preview:** severity, customer/record, reason, next step, owner, due date, and status.
5. **Recent outcomes:** only events that actually occurred, clearly distinguishing user-reported from independently matched/verified.
6. **Data health:** last successful imports/syncs, failed checks, skipped rows, unresolved payment matches, and missing information.

Avoid decorative charts that cannot change a decision. Every number should have a defined meaning, period, currency, source, and drill-down.

## 6. MVP boundary

### Keep and harden
- Invoice CSV import and row-level validation.
- Explicit recovery-rate assumptions and deterministic overdue detection.
- Organization-scoped persistence and access control.
- Lead/enquiry capture with documented next steps and follow-up activity.
- Unified attention queue using evidence-backed rules.
- Human-approved reminder drafts; manual sending only.
- Payment matching and review of ambiguous/unmatched records.
- Clear separation of estimates, reported outcomes, and verified payment evidence.
- Business Brain facts/assumptions with source and audit history.
- Google Sheets read-only sync only if the current connection path is reliable; show sync outcomes rather than implying authorization equals successful import.

### Do not add yet
- A general-purpose CRM replacement.
- Automatic WhatsApp/email sending.
- Autonomous financial actions or payment execution.
- A large integration catalogue.
- Predictive AI scoring that cannot explain its evidence.
- More dashboard widgets before the existing data and action loop is trustworthy.

CSV is an onboarding path, not the product identity. Connections should expand only when customer evidence shows a repeated, valuable need.

## 7. Data and trust requirements

- Every record belongs to an organization and is protected by server-enforced row-level security.
- Browser clients use only publishable/anon credentials; service-role secrets stay server-side.
- Imports must be idempotent and report inserted, updated, skipped, and rejected rows.
- Preserve source identifiers, import batch, timestamps, currency, and provenance.
- Ambiguous payment matches enter a review queue; never silently assign them.
- Partial payments, overpayments, duplicate references, and multiple currencies require explicit handling.
- Actions need a state machine and audit history; “drafted”, “approved”, “copied”, “sent by user”, and “verified outcome” are different states.
- Recommendations must explain missing evidence and rule failures.
- Tenant isolation, role permissions, and migration state must be tested before real customer financial data is used.

## 8. Prioritization model

Rank findings using explainable inputs, not opaque AI scores:
- severity and age;
- documented deadline or next-step date;
- known financial exposure (kept separate from speculative value);
- customer importance, if explicitly recorded;
- actionability and effort;
- evidence quality and data freshness.

Show why each item ranked where it did. Missing data should lower confidence and may produce **Needs review** rather than an assertive recommendation.

## 9. Delivery sequence

### Gate 1 — Reconcile current state
- Review the open dashboard redesign PR and current default branch.
- Run build, lint, domain/agent tests, and database journey/security tests on the exact candidate branch.
- Confirm the production and local migration histories match; inspect pending migrations and organization/RLS policies.
- Test login, organization isolation, invoice persistence after reload, duplicate imports, payment matching, and lead persistence with synthetic accounts/data.
- Do not merge or deploy a schema change while migration approval is unresolved.

### Gate 2 — Make the core loop reliable
- Fix persistence, loading/error states, import idempotency, and stale-data visibility.
- Confirm every attention item opens the correct source record and displays evidence.
- Verify action transitions and audit records.
- Make unresolved payment matches visible and safely reviewable.

### Gate 3 — Validate the workflow
Run a small pilot with 3–5 consenting service businesses. Observe setup time, number of useful findings, action completion, owner trust, and whether users return. Ask what they currently miss and what they would pay to prevent.

### Gate 4 — Design and ship one improvement
Only after Gates 1–3, implement the highest-evidence improvement behind a reviewed PR. Use synthetic data for automated tests, require human approval for external actions, and verify deployment separately from CI success.

## 10. Success measures

Primary:
- verified recovered/incremental revenue, reported separately from attribution claims;
- proportion of surfaced findings users confirm as useful;
- proportion of approved actions completed;
- time from importing data to first useful action;
- repeat weekly use by pilot businesses.

Guardrails:
- false-positive rate for attention items;
- ambiguous payment matches left unresolved;
- failed/stale data checks hidden from users;
- duplicate imports;
- tenant-isolation or authorization failures;
- recommendations without source evidence.

## 11. Immediate next step

Do not start another broad feature branch yet. First inspect the open dashboard redesign PR against the latest main branch, run the documented validation commands on its exact head, and resolve the product/data mismatch between a polished dashboard and trustworthy saved records. Then use this navigation as the design contract for the next UI pass.
