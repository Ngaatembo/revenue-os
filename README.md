# Revenue OS

Revenue OS helps a business identify, prioritize, execute, and measure revenue opportunities. The north-star metric is **verified incremental or recovered revenue**. Estimates and verified revenue are separate throughout the domain model.

## Current build

The first vertical slice starts with overdue invoice recovery:

1. Import invoices with source identifiers and explicit payment balances.
2. Set an explicit recovery-rate assumption.
3. Detect overdue invoices deterministically and calculate an estimate from the outstanding amount.
4. Keep action transitions approval-gated in the domain layer. External execution is manual by design.
5. Match later payment records to executed actions and label the result as verified evidence observed after the action, without claiming causality.

The current screen implements steps 1–3 in a local browser session. The action and attribution rules are domain foundations; their persistence and user workflows await the server and database layer.

The current screen and import parser run in the browser. Imported records remain in React memory for the current tab only; no business-data persistence, authentication, or external actions are wired yet. The Worker only checks D1 connectivity. The screen states the local-only behavior clearly. Do not use it with sensitive production data.

## Cloudflare direction

The app is being prepared for Cloudflare Workers and Workers Static Assets. The Worker serves the SPA and exposes a small `/api/health` route that checks D1 connectivity. It does not expose tenant or financial APIs yet.

Selected direction: Cloudflare Workers + D1. All database access must go through authenticated Worker routes. D1 is SQLite-based and has no PostgreSQL-style row-level security, so every business table carries an `organization_id`, cross-table relationships use composite organization-scoped foreign keys, and each query must derive its organization from the authenticated membership—not a request parameter. The browser must never receive a database binding.

D1's global read replication is currently marked beta, and writes are handled by a primary location. Cloudflare currently offers no Africa location hint, so global app delivery does not mean low-latency writes from every region. We will measure this against the intended launch markets before committing financial workloads at scale. The initial migration creates only the data model; authentication and tenant-aware APIs are deliberately not wired until the identity provider and authorization flow are implemented.

Wrangler scripts are pinned to version `4.149.0` via `npx` because network access prevented installing and locking it in this environment. For local Cloudflare preview, run `npm run cf:migrate:local`, `npm run build`, then `npm run cf:dev`. `npm run cf:deploy` deploys to Cloudflare and must only be run after account configuration and explicit deployment approval.

The initial D1 schema is in `migrations/0001_revenue_os_core.sql`. Apply it to the local D1 state with the command above before starting the Worker. The configured database ID is a local placeholder; no remote database has been created, and deployment must wait until a real D1 database is intentionally provisioned.

## Invoice CSV

Required columns:

```text
customer_id, customer_name, invoice_number, currency, total_amount, paid_amount, issued_at, due_at
```

Amounts must be non-negative decimal values with at most two decimal places. `currency` must be a three-letter code. Invoice numbers must be unique within an import. Invalid rows are skipped with a row-specific explanation; the parser does not silently coerce values.

## Domain modules

- `src/domain/types.ts`: sourced invoices, explicit assumptions, opportunities, actions, payment evidence, and attribution types.
- `src/domain/money.ts`: integer minor-unit arithmetic and currency checks.
- `src/domain/invoiceCsv.ts`: bounded CSV parsing and validation.
- `src/domain/overdueInvoices.ts`: deterministic overdue opportunity detection and estimate calculation.
- `src/domain/actions.ts`: approval-gated action state transitions.
- `src/domain/attribution.ts`: payment-record matching within a measurement window.

## Run locally

```sh
npm install
npm run dev
```

## Next engineering steps

1. Select an authentication provider and implement server-verified sessions and organization membership resolution.
2. Add tenant-isolation tests for every D1 query and negative cross-organization access cases.
3. Persist source imports and evidence through authenticated Worker routes; make import idempotent.
4. Add server-side opportunity/action APIs and enforce the human approval gate.
5. Add outcome imports and verified payment attribution.
6. Add the Revenue Analyst only after the deterministic slice works; recommendations must reference stored evidence and assumptions.

The current project is an early frontend, edge-runtime, and database-schema foundation, not a production revenue system. No production D1 database has been created or migrated.
