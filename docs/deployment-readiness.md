# Deployment readiness — Connections release

Nothing in this document has been applied to production. **Production changes need the owner's explicit authorization.**

## 1. Exactly what the migrations change

### `20261021120000_connections_sync_and_communications.sql` (idempotent; re-apply is safe — rehearsed)
| Object | Change |
|---|---|
| `provider_connections` | Drops all 4 existing CHECK constraints (live today: `provider_connections_check`, `…_last_error_code_check`, `…_provider_check`, `…_status_check` — verified against the hosted project 2026-10-21) and re-creates 4 named ones: provider ∈ {google_sheets, gmail}; status adds `syncing`, `needs_attention`; error-code length; "token required while connected/syncing/needs_attention". Adds 7 columns: `sync_stage`, `sync_started_at`, `sync_cursor`, `next_sync_at`, `consecutive_failures`, `records_synced`, `initial_sync_completed_at`. Adds partial index `provider_connections_due_idx`. Existing row (`google_sheets/connected`) satisfies every new constraint and keeps all values. |
| `provider_oauth_states` | Provider check widened to include `gmail`. |
| `consume_provider_oauth_state(text)` | Replaced: no longer filters `provider='google_sheets'` (the caller checks the returned provider). Still service-role only. |
| NEW `claim_connection_sync(text,text,boolean)` | SECURITY DEFINER, service-role only. Atomic lease so two workers never sync one connection. Returns the encrypted token **only to service_role**. |
| NEW `list_connection_status(text)` | SECURITY DEFINER, `authenticated`+`service_role`, anon revoked, membership-checked. Returns state/errors/account email — never a token. |
| NEW table `communications` | Metadata of customer emails. RLS enabled **and forced**; members `SELECT` through `private.is_org_member`; writes service-role only; unique `(organization_id, provider, external_id)`. |
| NEW view `conversation_threads` | `security_invoker` (RLS of the caller applies). |

### `20261021130000_sheets_automatic_sync.sql`
Two service-role-only SECURITY DEFINER functions: `persist_invoice_import_system` (runs the unchanged `persist_invoice_import` as the workspace owner, the same attribution model as `private.run_org_evaluation`) and `refresh_org_after_sync` (runs that existing per-workspace evaluation). No tables.

### `20261021140000_whatsapp_webhook_receiver.sql` (dormant; may be applied later)
Widens `communications.provider` to include `whatsapp`; new service-role-only table `whatsapp_numbers`.

## 2. Compatibility
- **Old Worker + new schema:** safe. Rehearsal proves a Sheets OAuth flow started before the release still completes, the existing connection/selection/credential are untouched, and old column sets still work.
- **New Worker/UI + old schema:** *not* safe (status RPC and `communications` missing → Connections shows an error). **Apply migrations first, then deploy.**
- Landing behaviour for existing users: a workspace that already has records goes straight to Overview. A workspace with an existing `google_sheets` connection and a saved sheet will start **automatic syncing on first cron run after deploy** (intended).
- The existing Sheets connection currently records `google_sheet_sync_failed` and no successful sync. Automatic sync will retry it; a persisting failure will show with an owner-readable reason.

## 3. Security review
- Tokens stay server-only: `provider_connections` still has no client grants (rehearsal asserts it); the new `claim_connection_sync` that returns the encrypted token is not executable by `anon`/`authenticated`.
- New SECURITY DEFINER functions all set `search_path = ''`. Service-role-only ones check `auth.role()` and have `EXECUTE` revoked from `PUBLIC, anon, authenticated`.
- `list_connection_status` adds one more intentionally member-callable SECURITY DEFINER function (the Supabase advisor already lists 24 of these, each membership-checked). It exposes the connected account email to every workspace member — acceptable for a shared workspace, noted.
- `communications`/`conversation_threads` isolation: DB test (21 assertions) and the browser journey show another workspace reads zero rows, cannot read status, cannot sync or disconnect another workspace.
- Automatic import runs as the **workspace owner** (audit rows show the owner as importer). Documented trade-off; a dedicated "system" actor would be a later improvement.
- Webhooks: WhatsApp endpoint is off unless two secrets exist; signature verified over the raw body in constant time; no self-service number registration (prevents one tenant claiming another's number).
- Existing advisor findings unchanged by this release: leaked-password protection disabled (dashboard setting — turn it on before real users), RLS-no-policy INFO on server-only tables (intentional).

## 4. Rollback
`supabase/rollbacks/*.rollback.sql`, run in **reverse order** (140000 → 130000 → 120000), each inside a transaction (`psql -1`).
- 130000 / 140000-less rollbacks lose no business data.
- **120000's rollback deletes `communications` (all synced emails) and any Gmail connection.** Sheets connection and invoice data are untouched. Use only if the release is abandoned.
- `bash scripts/rehearse-migration.sh` rebuilds today's production schema on a disposable database, seeds a production-like Sheets connection, applies all three migrations, checks compatibility, applies the rollbacks and proves the schema fingerprint (columns, constraints, indexes, policies, functions, grants) is identical to before. **Last run: PASSED.**

## 5. Production procedure (do not start without authorization)
1. Confirm a recent Supabase backup/PITR point exists (Dashboard → Database → Backups). The migrations are additive, but this is the cheap safety net.
2. Re-check the constraint list the migration will drop (must be exactly the four listed above):
   `select conname from pg_constraint where conrelid='public.provider_connections'::regclass and contype='c';`
3. Apply `120000`, then `130000` (and `140000` when ready for the WhatsApp test) with the Supabase migration tool. Each is one transaction.
4. The tool stamps its own version. List migrations, **rename the local file to the stamped version** and commit in the same sitting (project rule).
5. Verify: `to_regclass('public.communications')` is not null; `select * from public.provider_connections` (via SQL editor) still shows the existing row `connected`; run advisors and confirm no *new* ERROR-level finding.
6. Merge the branch → Cloudflare Workers Builds deploys the Worker with the cron trigger. Confirm Settings → Triggers shows `* * * * *`, `/api/health` is ok, and **Connections → Server setup check** passes.
7. Watch Worker logs for `scheduled_sync` lines; a connected source should show a fresh "last successful sync" within ~6 minutes.

## 6. Worker configuration and secrets (names only)
Verified in the repo by `src/worker/__tests__/deployConfig.test.ts`: cron `* * * * *`, `scheduled()` exported, `/api/*` served by the Worker first, no secret committed (`vars` contains only `SUPABASE_URL`).

| Name | Kind | Status on deployed Worker |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | present (guard passes) |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | secret, 64 hex | present & well-formed (guard passes) — never rotate once tokens exist |
| `APP_ORIGIN` | secret/var | present; equals `https://revenue-os.ngaatendwew.workers.dev` (callback redirects there) |
| `SUPABASE_URL` | var (in `wrangler.jsonc`) | present |
| `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | secret | present (guard passes) |
| `SYNC_MESSAGE_BUDGET`, `SYNC_INTERVAL_MINUTES` | optional | defaults 100 / 5. **Set budget ≤ 30 on the free plan.** |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | optional secrets | not set (receiver disabled) |
Observed 2026-10-21 against production with unauthenticated requests only: `/api/health` ok; Google routes answer 401 (not 503); `/api/connections/*` is 404 (old Worker deployed; no cron yet).

## 7. Every remaining external requirement
1. Owner approval to apply the migrations and merge/deploy.
2. Google Cloud: Gmail API enabled, scopes added, test users, redirect URI (see `gmail-verification-runbook.md`).
3. Choose the Workers plan or set `SYNC_MESSAGE_BUDGET` accordingly.
4. Real authorization run with a test mailbox and a test spreadsheet (synthetic data).
5. Supabase Auth: enable leaked-password protection.
6. Public launch only: Google OAuth verification + security assessment for `gmail.readonly`.
7. WhatsApp: Meta developer app/test number (see `whatsapp-route.md`); business verification and app review for real customers.
