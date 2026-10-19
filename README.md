# Revenue OS

Revenue OS helps a business identify, prioritize, execute, and measure revenue opportunities. The north-star metric is **verified incremental or recovered revenue**. Estimates and verified revenue stay separate throughout the domain model.

## Current MVP

The current product includes these connected work areas:

- **Invoice recovery:** import an invoice CSV, set an explicit recovery-rate assumption, and deterministically identify overdue balances. Invoice rows and recovery-rate assumptions are stored in Supabase. Opportunity estimates are recalculated from those source records when the workspace loads.
- **Lead Recovery:** sign in, create a workspace, record enquiries and follow-ups, and track pipeline status. Lead records are stored in Supabase Postgres and scoped to the authenticated organization by row-level security.
- **Approval-gated recovery actions:** create an invoice-linked reminder draft from an overdue invoice, approve it, copy it to send manually, and only then mark it as sent. Revenue OS never sends customer messages automatically.
- **Payment evidence and outcomes:** import a payment CSV, match records to unique invoice numbers and currencies, and verify payments received within the measurement window after a manually sent action. Outcomes are labelled as observed after the action, not caused by it.
- **Google Sheets:** authorize a Google account through OAuth and import invoice rows from a selected spreadsheet range. Access is read-only; Revenue OS does not edit the spreadsheet or send messages.
- **Business Brain and prioritization:** present ranked work queues, explain recommendations, and distinguish saved source records from calculated estimates.

Lead Recovery does not send WhatsApp messages or email. A user-marked conversion is not independently verified revenue. Actions remain human-controlled. Google Sheets authorization does not itself mean an import has succeeded; check the sync result and last-successful-sync status.

## Supabase configuration

The active Supabase project is named `revenue-os`. The frontend is configured with its **public publishable key** as a safe default, so the preview can start without local setup. You may override the defaults at Vite build time with:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

The publishable/anon key is intended for browser use. Never put a Supabase service-role key in a browser build or commit one to Git.

The migration `supabase/migrations/20261014094640_sales_leads_and_org_bootstrap.sql` creates the `sales_leads` table, organization-scoped RLS policies, and an authenticated onboarding RPC. The RPC creates a user's first organization and owner membership, and returns an existing membership if the user already has one. It does not accept an arbitrary user ID.

## Security boundaries

- All client requests use the publishable key and the signed-in user's access token; no service-role key is used by the frontend.
- RLS policies scope lead reads to organization membership and writes to owner/admin/operator roles.
- The browser never chooses the authenticated user ID or grants itself a role.
- Before importing real customer financial data, test authentication and organization isolation with separate accounts, confirm import idempotency and partial-payment behavior, and review access logs.
- The current lightweight auth wrapper uses Supabase Auth endpoints and keeps the session in `sessionStorage`. For a production release, review session handling, recovery flows, rate limits, and security headers before onboarding customers.

## Google Sheets OAuth configuration

The Worker handles the server-side OAuth callback and token storage. Configure these values in Cloudflare Worker secrets/variables; never commit secret values:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the Google Cloud OAuth client.
- `GOOGLE_TOKEN_ENCRYPTION_KEY`: exactly 64 hexadecimal characters (32 random bytes). Keep the same key once encrypted tokens exist; rotating it can make stored tokens unreadable.
- `APP_ORIGIN`: the exact Worker origin used by the app, with no path or trailing slash.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` for the server-side integration. The service-role key must only exist in Worker secrets, never in Vite/browser variables.

Register this exact redirect URI on the Google OAuth client (replace the host only if the production Worker hostname changes):

```text
https://revenue-os.ngaatendwew.workers.dev/api/integrations/google/callback
```

For an OAuth app in **Testing** publishing status, add every intended Google account under Google Auth Platform → Audience → Test users. Keep requested scopes limited to what the feature uses. Uploading a logo or submitting for verification is not required merely to test with an allow-listed account.

In the app, open **Connections → Google Sheets**, authorize the account, paste the spreadsheet URL or ID, choose the invoice range including its header row (default `A:H`), then run the sync. The first row must contain these exact column names in order:

```text
customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at
```

## Invoice CSV format

Required columns:

```text
customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at
```

Amounts must be non-negative decimal values with at most two decimal places. Currency must be a three-letter code. Invalid rows are skipped with a row-specific explanation; values are not silently coerced.

## Payment CSV format

Required columns:

\`\`\`text
invoice_number,payment_reference,currency,amount,received_at
\`\`\`

Payment references should be unique within a source. Invoice number and currency must match exactly one saved invoice. Amounts must be positive decimal values with at most two decimal places. Verified outcomes require an executed reminder and matching payment records inside the measurement window; matched payments may not exceed the imported outstanding balance.

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

## Release and deployment checks

The production frontend and API are served by a Cloudflare Worker configured in `wrangler.jsonc`. The repository's GitHub Actions workflow validates pull requests and pushes to `main`; CI success alone does not prove the production Worker has deployed.

Before a release:

1. Require successful build/type-check, domain tests, lint, and database/security tests.
2. Confirm the production Worker deployment completed and inspect its deployment log.
3. Check `/api/health` returns `{"status":"ok","supabase":"reachable"}`.
4. Test sign-in, workspace separation, invoice import, Google Sheets OAuth and sync, and failure handling with synthetic data.
5. Verify desktop and mobile layouts in both light and dark mode.
6. Only then use real customer financial data, with their consent and appropriate access controls.

Useful commands:

```sh
npm run build
npm run test:domain
npm run lint
npm run cf:deploy
```

The deploy command requires an authenticated Cloudflare Wrangler session. Never paste API tokens or service-role keys into chat, source files, or frontend build variables.

## Database tests

`scripts/test-db.sh` replays every file in `supabase/migrations/` into a throwaway Postgres database
(with minimal stand-ins for the Supabase roles and `auth` schema) and runs `supabase/tests/02_journey.sql` and `03_sync_opportunities.sql`:
the synthetic invoice-to-verified-outcome journey, tenant isolation, role checks and membership guards.
All data is synthetic. It needs a Postgres server reachable through the standard `PG*` environment variables
(`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`), creates and drops its own database, and refuses to run against a hosted Supabase host.
Never point it at the real Supabase project.
