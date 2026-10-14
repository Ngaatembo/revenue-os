# Revenue OS

Revenue OS helps a business identify, prioritize, execute, and measure revenue opportunities. The north-star metric is **verified incremental or recovered revenue**. Estimates and verified revenue stay separate throughout the domain model.

## Current MVP

The current build has two connected work areas:

- **Invoice recovery prototype:** import an invoice CSV, set an explicit recovery-rate assumption, and deterministically identify overdue balances. Invoice records and estimates currently stay in browser memory and disappear when the tab is closed.
- **Lead Recovery:** sign in, create a workspace, record enquiries and follow-ups, and track pipeline status. Lead records are stored in Supabase Postgres and scoped to the authenticated organization by row-level security.

Lead Recovery does not send WhatsApp messages or email, and a user-marked conversion is not independently verified revenue. Actions remain human-controlled.

## Supabase configuration

The active Supabase project is named `revenue-os`. The frontend is configured with its **public publishable key** as a safe default, so the preview can start without local setup. You may override the defaults at Vite build time with:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

The publishable/anon key is intended for browser use. Never put a Supabase service-role key in a browser build or commit one to Git.

The migration `supabase/migrations/20261014120000_sales_leads_and_org_bootstrap.sql` creates the `sales_leads` table, organization-scoped RLS policies, and an authenticated onboarding RPC. The RPC creates a user's first organization and owner membership, and returns an existing membership if the user already has one. It does not accept an arbitrary user ID.

## Security boundaries

- All client requests use the publishable key and the signed-in user's access token; no service-role key is used by the frontend.
- RLS policies scope lead reads to organization membership and writes to owner/admin/operator roles.
- The browser never chooses the authenticated user ID or grants itself a role.
- Keep real customer financial data out of the invoice CSV prototype until invoice imports are persisted through authenticated operations and the complete access-control flow has been tested.
- The current lightweight auth wrapper uses Supabase Auth endpoints and keeps the session in `sessionStorage`. For a production release, review session handling, recovery flows, rate limits, and security headers before onboarding customers.

## Invoice CSV format

Required columns:

```text
customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at
```

Amounts must be non-negative decimal values with at most two decimal places. Currency must be a three-letter code. Invalid rows are skipped with a row-specific explanation; values are not silently coerced.

## Domain modules

- `src/domain/types.ts`: sourced invoices, assumptions, opportunities, actions, payment evidence, and attribution types.
- `src/domain/money.ts`: integer minor-unit arithmetic and currency checks.
- `src/domain/invoiceCsv.ts`: bounded CSV parsing and validation.
- `src/domain/overdueInvoices.ts`: deterministic overdue opportunity detection and estimate calculation.
- `src/domain/actions.ts`: approval-gated action state transitions.
- `src/domain/attribution.ts`: payment-record matching within a measurement window.
- `src/lib/supabaseRest.ts`: Supabase Auth and organization-scoped lead data access.

## Run locally

```sh
npm install
cp .env.example .env.local
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env.local` instead of `cp`. The example file contains placeholders; the built-in public project defaults are used unless you replace them with valid environment variables.

## Next engineering milestones

1. Persist invoice imports and recovery assumptions through authenticated Supabase operations.
2. Build the approval-gated action workflow and payment-evidence import.
3. Verify payment attribution against source records and distinguish observed outcomes from causal claims.
4. Add integration tests for authentication, tenant isolation, duplicate imports, partial payments, and failed requests.
5. Run a supervised pilot with synthetic data first, then a consenting WebAura client once the full financial-data workflow is secure.
