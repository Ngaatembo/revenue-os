# Revenue OS

Revenue OS is an evidence-led revenue opportunity and execution system for small and growing businesses. It aims to help an owner see what needs attention, understand why it matters, take an appropriate next step, and record what happened.

**North-star outcome:** verified incremental or recovered revenue. Estimates, reported outcomes, and verified outcomes must remain distinct. A payment observed after an action is not proof that the action caused it.

## Product direction

The long-term idea is a **business watchman**: identify missed opportunities, overdue commitments, process gaps, payment issues, and possible revenue leakage across fragmented business tools.

The product must earn that breadth by solving one narrow, recurring problem well. Two candidate starting points are being evaluated:

1. **Stalled prospects and quotations:** identify a documented next step that has become overdue, explain the evidence, and help the owner follow up.
2. **Overdue invoice recovery:** identify unpaid overdue balances from invoice data and estimate a possible recovery amount using an explicit assumption.

The first workflow is not yet final. Validate both against real customer behaviour before committing to a larger build. A prospect's silence alone is not enough to label an opportunity stalled; missing next-step information should be shown as “Needs review.”

## Product and technical blueprint

The full working plan lives in [docs/MASTER_PRODUCT_TECHNICAL_BLUEPRINT.md](docs/MASTER_PRODUCT_TECHNICAL_BLUEPRINT.md). It covers product positioning, competition hypotheses, customer validation, architecture, domain model, security, AI boundaries, metrics, and delivery gates. Update it when evidence changes a product or technical decision.

### Core product loop

**Business evidence → opportunity/exception → ranked next action → human approval → observed outcome → learning.**

Principles:
- Every finding must link to its source evidence, rule, and assumptions.
- Deterministic code calculates money and applies detection rules.
- Estimates are never presented as verified revenue.
- Consequential external actions require human approval.
- Begin with low-friction CSV/manual workflows; add integrations when customer demand justifies them.
- Build and validate one workflow at a time.

## Current implementation

The repository currently contains an early overdue-invoice prototype:

1. Import invoices using a CSV with source identifiers and explicit payment balances.
2. Set an explicit recovery-rate assumption.
3. Detect overdue invoices deterministically and estimate a possible recovery amount.
4. Define approval-gated action state transitions in the domain layer.
5. Match later payment records to executed actions as observed evidence, without asserting causality.

The screen currently implements the first three steps in a local browser session. Imported data is held in React memory for the current tab. The action and attribution rules are domain foundations, not yet complete persisted workflows.

**This is not production-ready. Do not use it with sensitive production or customer financial data.** Authentication, tenant-aware financial APIs, and durable business-data persistence are not implemented. The Worker currently exposes a health route that checks D1 connectivity; it does not expose tenant or financial APIs.

## Technology and Cloudflare direction

- **Frontend:** React, TypeScript, Vite.
- **Edge runtime and static delivery:** Cloudflare Workers and Workers Static Assets.
- **Database direction:** Cloudflare D1 (SQLite).
- **Wrangler:** scripts currently pin version 4.149.0 via npx.

D1 has no PostgreSQL-style row-level security. Every business table must be organization-scoped, cross-table relationships should use composite organization-scoped foreign keys, and every query must derive organization scope from the authenticated membership—not a browser-supplied organization ID. The browser must never receive a database binding.

The configured database ID is a placeholder. No production D1 database is assumed to exist or to have been migrated. Do not deploy the application as a real multi-tenant financial product until identity, authorization, persistence, and security checks are implemented and reviewed.

Cloudflare globally serves application assets, but that does not guarantee low-latency database writes from every market. Measure performance against intended launch regions before committing to financial workloads at scale.

## Invoice CSV format

Required columns:

~~~csv
customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at
~~~

Validation rules:
- Amounts must be non-negative decimal values with at most two decimal places.
- Currency must be a three-letter code.
- Invoice numbers must be unique within an import.
- Invalid rows are skipped with a row-specific explanation; values are not silently coerced.

Download a blank template from the current app to see the expected header.

## Domain modules

- **src/domain/types.ts:** sourced invoices, explicit assumptions, opportunities, actions, payment evidence, and attribution types.
- **src/domain/money.ts:** integer minor-unit arithmetic and currency checks.
- **src/domain/invoiceCsv.ts:** bounded CSV parsing and validation.
- **src/domain/overdueInvoices.ts:** deterministic overdue opportunity detection and estimate calculation.
- **src/domain/actions.ts:** approval-gated action state transitions.
- **src/domain/attribution.ts:** payment-record matching within a measurement window.
- **migrations/0001_revenue_os_core.sql:** initial organization-scoped data model and integrity constraints.

## Run locally

Install dependencies:

~~~sh
npm install
~~~

Start the Vite frontend:

~~~sh
npm run dev
~~~

Useful checks:

~~~sh
npm run lint
npm run build
~~~

For a local Cloudflare preview, after checking the Wrangler/D1 configuration:

~~~sh
npm run cf:migrate:local
npm run build
npm run cf:dev
~~~

The local migration command changes local D1 state. Confirm configuration before running it.

## Production-readiness gates

Complete and test these before storing real business data:

1. Select an identity provider and implement server-verified sessions.
2. Resolve organization membership and role on the server for every request.
3. Add tenant-isolation tests, including negative cross-organization access cases.
4. Persist source imports and evidence through authenticated Worker routes; make imports idempotent.
5. Add server-side opportunity/action APIs and enforce approval and authorization rules.
6. Add outcome imports and evidence-backed payment attribution.
7. Validate upload limits, input handling, audit logging, retention, backup/recovery, and operational monitoring.
8. Review secrets and Cloudflare configuration; never commit credentials or expose database bindings to the browser.
9. Validate the first product workflow with customers before expanding into additional detectors or adding an AI analyst.

## Current delivery sequence

1. Design and validate the first workflow; compare stalled prospect/quotation follow-through with overdue-invoice recovery.
2. Run a small concierge experiment and record false positives, actions, outcomes, and willingness to pay.
3. Choose one MVP wedge from evidence and update the blueprint.
4. Implement the selected workflow with deterministic rules and tests.
5. Build authenticated persistence and tenant-safe APIs before real customer data is stored.
6. Add AI assistance only after reliable evidence and deterministic behaviour exist. AI may explain evidence or draft a message; it must not invent facts, verify revenue, bypass authorization, or silently execute consequential actions.

## Deployment

The repository includes the deployment script npm run cf:deploy, which builds and deploys to Cloudflare. **Do not run this command until the production-readiness gates and account/database configuration are reviewed.** Deployment is a deliberate operator action; no deployment is performed by this README update.
