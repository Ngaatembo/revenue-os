# Revenue OS — Master Product & Technical Blueprint

**Status:** Working blueprint · v0.1 · 13 October 2026  
**Purpose:** Keep product decisions, validation evidence, architecture, and delivery sequence in one place. This is a hypothesis-driven plan, not a claim that the market or product has already been validated.

## 1. Executive direction

Revenue OS is an **evidence-led revenue opportunity and execution system for small and growing businesses**. It helps an owner see what needs attention, understand why it matters, choose a next action, and later record what actually happened.

The long-term idea is a business watchman: surface missed opportunities, overdue commitments, process gaps, payment issues, and possible money leakage across a business. The first release must not attempt to monitor every business function. It must solve one recurring, costly problem reliably and earn the right to expand.

**Working product promise:** “Know what needs attention next, why it matters, and whether acting on it made a difference.”

### Non-negotiable principles

1. **Evidence before advice.** Every finding points to its source records, timestamps, rules, and assumptions.
2. **Estimate is not revenue.** Keep estimated, reported, and verified amounts distinct. Do not claim that an action caused a payment merely because the payment happened afterwards.
3. **Human approval before consequential action.** The first release may prepare an action or message; it must not silently contact customers, change records, or move money.
4. **Exceptions before dashboards.** Lead with a short, ranked list of what needs attention—not a wall of charts.
5. **Low-friction adoption.** Start with CSV and manual workflows. Add integrations only when customers demonstrate the need and willingness to pay.
6. **Trust and reversibility.** Show uncertainty, allow dismissals with reasons, preserve an audit trail, and make actions inspectable.
7. **One validated wedge at a time.** Do not build a generic AI assistant, accounting suite, CRM, or ERP before proving a narrow use case.

## 2. The customer problem and the first wedge

### Current problem hypothesis

Service businesses lose revenue when enquiries, quotations, promised follow-ups, deposits, unpaid invoices, or delivery commitments fall between people and tools. The owner often has to reconstruct the situation from WhatsApp, memory, spreadsheets, and separate systems.

This is a **problem hypothesis based on early discovery**, not yet a quantified market finding.

### Candidate first use cases

The repository already contains a deterministic **overdue-invoice recovery** slice. The founder's current operating experience also points to **stalled prospects and quotations** as a frequent pain. These are related but distinct use cases. Keep both documented; do not combine them into a sprawling MVP before testing them.

| Candidate | Evidence available now | What must be proven |
|---|---|---|
| Stalled prospect/quotation detector | Founder reports missed follow-ups and quotations several times a week; information is scattered across WhatsApp, memory, and manual tracking | Can a small business provide enough dates/stages to detect missed next steps, and will it act on the alerts? |
| Overdue-invoice recovery | Existing code parses invoice CSVs and deterministically estimates overdue balances using an explicit recovery-rate assumption | Can owners safely import reliable invoice data, and does the workflow help collect balances? |

**Decision rule:** Run a small manual test of the prospect/quotation workflow with real, non-sensitive business records. Compare its frequency, urgency, user effort, and measurable outcome against the invoice workflow. Choose one primary MVP wedge from evidence. The existing invoice slice remains a prototype, not proof of product-market fit.

### Initial customer hypothesis

Start with owner-operated service businesses where one missed follow-up or payment can matter: web/digital agencies, contractors, car rentals, hospitality/venues, and other quote/deposit-based services. Use WebAura as a learning environment, but do not assume that WebAura's own workflow represents every business.

### Jobs to be done

- “Tell me which opportunities or commitments need my attention today.”
- “Show me why this item is flagged and the evidence behind it.”
- “Help me take the next reasonable step without making me learn a complex system.”
- “Let me see what happened after I acted, without overstating the result.”

## 3. Positioning and competitive landscape

### Positioning

Revenue OS should sit **alongside existing tools as an exception-detection and follow-through layer**. It should not initially replace accounting software, a CRM, WhatsApp, spreadsheets, or an ERP.

The defensible product behaviour is the complete loop:

**Business evidence → detected exception/opportunity → ranked next action → human-approved execution → observed outcome → learning.**

A generic chatbot can suggest actions; Revenue OS must connect recommendations to a business's actual records and show whether follow-through occurred.

### Representative alternatives to investigate

This is an initial desk-research list, not an exhaustive competitor audit. Product capabilities and regional availability must be rechecked before making public comparative claims.

| Alternative | Adjacent job it serves | Product implication |
|---|---|---|
| [QuickBooks](https://quickbooks.intuit.com/) | Accounting, invoicing, receivables and financial records | Do not compete by rebuilding a ledger. |
| [Chaser](https://www.chaserhq.com/) | Accounts-receivable follow-up and collections automation | Invoice reminders alone are not a unique differentiator. |
| [Zoho](https://www.zoho.com/) | Broad suite including CRM and business applications | A broad feature checklist is not a credible early strategy. |
| [Odoo](https://www.odoo.com/) | Integrated business apps and ERP workflows | Start smaller and complement existing systems. |
| [Velvy](https://velvy.co/) | African SME-oriented business management (verify current scope) | Test whether local workflows and onboarding are underserved. |
| [ZivoBooks](https://zivobooks.com/) | Invoicing/bookkeeping-oriented SME workflows (verify current scope) | Local payment and currency workflows may matter, but are not sufficient differentiation alone. |
| [BillRyt](https://billryt.com/) | Billing/invoicing-oriented workflow (verify current scope) | Avoid being only another billing tool. |

**Research discipline:** Vendor websites describe their own offerings; they do not prove customer outcomes. Confirm each vendor's current features, target market, pricing, local integrations, and actual usage through direct product checks and customer interviews. Treat claims about gaps as hypotheses until tested.

### Potential differentiation to validate

- Finds missed handoffs across workflows rather than only reporting data already visible in one system.
- Ranks exceptions by evidence, value, urgency, confidence, and effort.
- Gives a clear reason and a useful next action for every alert.
- Works with imperfect, fragmented records and makes missing information visible.
- Measures follow-through and observed outcomes, separating evidence from causal claims.
- Offers simple onboarding and clear value for businesses with limited time and technical support.

## 4. Product scope and roadmap

### Phase 0 — Validate the problem (before expanding code)

1. Interview 5–10 owners/operators; work toward 10–15 interviews in the first month.
2. Ask them to walk through the last real missed follow-up, stalled quote, or late payment—not just whether they like the idea.
3. Record current workaround, frequency, consequence, existing tools, missing data, and what they have already paid to solve it.
4. Run a 7-day concierge test using 5–10 existing WebAura prospects/quotes, using only data that is safe to use.
5. Compare the prospect/quote wedge with invoice recovery and choose one primary workflow.

### Phase 1 — One reliable workflow

- Import or enter a small set of source records.
- Show provenance, timestamps, missing fields, and data quality.
- Detect only explicit, explainable conditions.
- Rank the resulting opportunities with a transparent rule.
- Provide a suggested next step and owner/deadline.
- Require a human to approve any external action.
- Record the action and outcome.
- Show estimated, reported, and verified outcomes separately.

### Phase 2 — Persistence and safe multi-tenant foundation

- Server-verified authentication and organization membership.
- Organization-scoped persistence through authenticated Worker routes.
- Idempotent imports and source-record reconciliation.
- Audit trail, permissions, tenant-isolation tests, and data-retention controls.
- Import and correction flows that preserve source evidence.

### Phase 3 — Integrations only where demanded

Prioritize integrations from observed customer demand, not technical novelty. Possible sources include accounting exports, payment exports, CRM/spreadsheets, and messaging workflows. Any outbound messaging or consequential change must be explicitly authorized and logged.

### Phase 4 — Expand the Business Watchman

Only after retention and repeat value are demonstrated, consider additional detectors:
- Dropped handoff between enquiry, quote, deposit, and delivery.
- Forgotten promise or deadline.
- Payment/invoice mismatch.
- Potential unbilled work, unexpected discount, or cost/margin anomaly.
- Cash-pressure warning based on disclosed evidence and assumptions.
- Daily exception briefing showing what changed and what needs attention.

Each detector needs its own evidence contract, false-positive tests, user control, and success measure. Do not release them all at once.

## 5. Product interaction and prioritisation

### A useful opportunity card should answer

1. **What needs attention?**
2. **Why was it flagged?** Link to source records and rule.
3. **How urgent is it?** Show the actual deadline/age and relevant stage.
4. **What is the potential value?** State currency, calculation, assumptions, and uncertainty.
5. **What should happen next?** Suggest an action, owner, and date.
6. **What can I do?** Approve, edit, snooze, dismiss with a reason, or mark as resolved.
7. **What happened later?** Record response, decision, payment evidence, or another outcome.

### Transparent prioritisation

For the first version, use a deterministic rule, not an opaque AI score. Consider:

- **Urgency:** How far past a documented due date or promised next step is it?
- **Value:** Known amount or an explicitly labelled estimate.
- **Confidence:** Completeness and reliability of source evidence.
- **Effort:** Approximate effort required to take the next step.
- **Business stage:** Whether the next action is still appropriate.

Display the factors and rule. Missing next-action dates should result in **“Needs review”**, not a fabricated overdue alert. A prospect's silence alone is not enough to conclude that an opportunity is stalled.

## 6. Domain model

The current invoice prototype already defines sourced invoice evidence, assumptions, opportunities, actions, payment evidence, and attribution. Keep the model evidence-centred while allowing other opportunity kinds later.

### Core entities

- **Organization:** tenant/business boundary.
- **User and Membership:** identity and role within an organization.
- **Data Source:** where records originated (CSV, manual entry, or a future integration).
- **Import:** immutable provenance for a batch, including content hash and row counts.
- **Source Record / Evidence:** normalized business facts plus original source identifiers, timestamps, and reliability metadata.
- **Opportunity:** a detected exception with type, status, detection rule/version, evidence references, and value estimate if justified.
- **Assumption:** explicit user-supplied parameter with author and timestamp.
- **Action:** proposed next step, owner, due date, approval state, execution evidence, and result.
- **Outcome:** reported or verified observation linked to the relevant action/opportunity and supporting evidence.
- **Audit Event:** append-only record of important changes, approvals, imports, dismissals, and verification.

### Prospect/quotation fields to validate before adding to the production schema

- Prospect/customer identifier and display name.
- Service/product offered and source channel.
- Current stage (e.g. new enquiry, qualified, quotation sent, negotiation, won, lost).
- Last meaningful contact timestamp and interaction summary.
- Next action, promised date/deadline, owner, and status.
- Quotation amount/currency, where known.
- Evidence/source link and last-updated timestamp.
- Outcome (reply, meeting, revised quote, accepted, declined, deposit, payment) with date and evidence.

Do not add these tables simply because they are listed here. First confirm the chosen wedge and the smallest set of fields users can reliably provide.

### Financial and evidence rules

- Store money as integer minor units with an explicit currency; never sum different currencies.
- Preserve original source IDs and import metadata.
- Make repeated imports idempotent.
- Keep estimates separate from reported and verified amounts.
- A payment after an action is an observation, not proof the action caused it.
- Store the formula, rule version, and assumptions used for each estimate/detection.
- Never fabricate missing dates, stages, balances, or confidence.

## 7. Technical architecture

### Current repository baseline

- **Frontend:** React + TypeScript + Vite.
- **Runtime direction:** Cloudflare Workers with Workers Static Assets.
- **Database direction:** Cloudflare D1 (SQLite).
- **Current domain modules:** money, invoice CSV parsing, overdue-invoice detection, action transitions, and payment attribution.
- **Current migration:** core organization-scoped schema with memberships, sources/imports, invoices, assumptions, opportunities, actions, payment evidence, outcomes, and audit log.
- **Current limitations:** local-session invoice import; no authenticated business-data APIs; no production persistence/authentication; external actions are not wired. The D1 identifier in configuration is a placeholder until intentionally provisioned.

### Logical request/data flow

1. User signs in through a selected identity provider.
2. Worker validates the session server-side.
3. Worker resolves organization membership and role from trusted identity—not from an organization ID supplied by the browser.
4. Worker validates input and records source/import evidence in D1.
5. Deterministic domain functions detect opportunities and persist the rule version, assumptions, and evidence references.
6. User reviews and approves a proposed action.
7. Worker validates authorization and state transition; external execution remains manual until explicitly designed and tested.
8. New evidence is imported or recorded; outcomes are matched and labelled reported or verified.
9. Audit trail records meaningful changes.

### Recommended code boundaries

- **Domain:** pure rules and types; no network, database, or UI dependencies.
- **Application:** future use-case orchestration that calls domain rules.
- **Worker/API:** authenticated request handling, authorization, validation, and D1 access.
- **Migrations:** forward-only schema changes and integrity constraints.
- **Tests:** domain tests, import idempotency tests, API authorization tests, and cross-tenant negative tests.
- **Docs:** product decisions, data contracts, security model, operational/deployment notes.

Preserve the current repository's established conventions if its actual structure differs; avoid moving files solely to match this diagram.

## 8. Security, privacy, and reliability requirements

**Do not treat the current preview as production-ready.** Do not upload real sensitive customer/financial records into the current local-only UI and do not represent the app as secure for multi-business use yet.

Before storing real business data:
- Select and implement an identity provider; verify sessions in the Worker.
- Resolve membership and role server-side on every request.
- Derive organization scope from trusted membership; never trust a request-body tenant ID.
- Scope all reads and writes to organization; use composite organization-scoped foreign keys where appropriate.
- Add negative tests proving organization A cannot read or mutate organization B's records.
- Validate all inputs server-side; bound upload sizes and CSV row counts.
- Make imports idempotent and handle partial failures visibly.
- Keep secrets in Cloudflare secrets/environment configuration, never committed to Git or sent to the browser.
- Use least-privilege roles and explicit authorization for imports, approvals, and data exports.
- Preserve append-only audit events for important actions.
- Define retention, deletion/export, backup/recovery, and incident-response procedures before onboarding customers.
- Avoid sending financial or personal data to an AI provider unless the customer has been informed and the data handling is deliberately designed.
- Add rate limiting and abuse protection before public exposure.

## 9. AI policy

AI is a later assistance layer, not the source of financial truth.

- Deterministic code calculates money, due dates, scores, and verification conditions.
- AI may summarize stored evidence, explain a detected rule in plain language, or draft a follow-up.
- Every AI recommendation must reference stored evidence and identify missing information/assumptions.
- Never let a language model invent financial facts, mark an outcome verified, override authorization, or execute external actions without an explicit human approval path.
- Log the prompt/template version and relevant evidence references where appropriate, while minimizing retained sensitive data.
- Measure accuracy, usefulness, and harmful/false-positive recommendations before broad release.

## 10. Validation and business metrics

### First 7-day concierge test

For 5–10 existing prospect/quotation records, create a private working list with: prospect, offer, last contact, stage, promised next step/date, known value/currency, evidence, owner, and result. Use the normal follow-up process; Revenue OS should not send messages automatically.

Track:
- Records with a genuinely overdue next step.
- Alerts judged useful vs incorrect or premature.
- Time needed to assemble and review the list.
- Follow-ups completed.
- Replies, meetings, quotation decisions, deposits, and payments.
- Which outcomes are directly evidenced and which are merely reported.
- Whether the owner would continue using the workflow and pay for it.

**Do not claim recovered revenue based on replies alone.** Track stages separately.

### Early product metrics

- **Activation:** business imports/records enough usable evidence to see its first credible opportunity.
- **Time to first value:** time from onboarding to first useful, evidence-backed finding.
- **Action rate:** share of accepted opportunities with a completed next step.
- **False-positive rate:** findings users dismiss as incorrect or premature.
- **Outcome evidence rate:** share of claimed outcomes with supporting evidence.
- **Verified recovered/protected revenue:** amount supported by matched source evidence, reported separately from estimates.
- **Retention:** businesses still using the workflow after the initial test.
- **Commercial validation:** paid pilots, willingness to pay, onboarding time, and support cost.

### Proposed learning milestones (targets, not promises)

- First: 5–10 owner interviews and one documented concierge experiment.
- By 30 days: 10–15 interviews, one clearly selected wedge, and at least one paid pilot if evidence supports it.
- Before broader launch: repeat usage by multiple businesses, credible outcome evidence, acceptable false-positive rate, and a safe production data path.

## 11. Commercial hypotheses

Test rather than assume:
- A simple paid setup/onboarding fee may fit businesses that need help cleaning or importing records.
- A monthly subscription may fit repeated monitoring and follow-through.
- Assisted implementation/integrations may be a later premium service.
- Avoid charging a percentage of “recovered money” until attribution and customer trust are proven; payment after a reminder does not prove causation.
- Price through interviews and paid pilots, not competitor prices alone.

## 12. Delivery gates

| Gate | Must be true before proceeding |
|---|---|
| Problem gate | Real owners describe a recurring costly problem and show how they handle it today. |
| Wedge gate | One use case wins on frequency, urgency, data availability, actionability, and willingness to pay. |
| Prototype gate | Deterministic detection works on real but safely handled sample data; users can explain why an alert appeared. |
| Persistence gate | Authenticated server APIs, idempotent imports, and reliable evidence persistence exist. |
| Security gate | Tenant-isolation, authorization, audit, and validation tests pass. |
| Pilot gate | Users repeatedly act on findings and provide outcome evidence; at least one customer pays or gives a credible paid-pilot commitment. |
| Expansion gate | The first workflow has repeat value before a second detector is added. |

## 13. Immediate next actions

1. Keep this document as the product decision record and update it when evidence changes a decision.
2. Run the seven-day manual prospect/quotation test while keeping the existing invoice detector intact.
3. Create a small, non-sensitive sample dataset and write down expected findings before coding more detectors.
4. Decide the first wedge from results; then update the domain model and implementation plan accordingly.
5. Before real business data is persisted, choose the identity provider and design server-side tenant authorization.
6. Run repository checks and review migrations/tests before each change.
7. Deploy to Cloudflare only after the intended configuration, database, auth, and security gates are met. The founder handles deployment; no deployment is performed as part of this blueprint.

## Decision log

- **D-001:** Verified or recovered revenue is the north-star outcome, with estimates and evidence kept separate.
- **D-002:** Cloudflare Workers + D1 is the current technical direction; no production D1 database is assumed to exist.
- **D-003:** Human approval is required before consequential external actions.
- **D-004:** The first product wedge is not yet final: prospect/quotation follow-through and overdue-invoice recovery will be compared through a small manual test.
- **D-005:** AI assistance follows reliable evidence and deterministic rules; it does not replace them.
