# Hosted migration history and schema drift

## Verified production state on 2026-10-20

The hosted project `revenue-os` (`zivgfvcmposnbwqsudas`) reports 22 tracked migrations, from
`20261013212317` through `20261020081110`. The two source-snapshot migrations are now applied and
tracked under these exact hosted versions:

- `20261020081030 source_sync_snapshot_tracking`
- `20261020081110 complete_source_sync_snapshot`

The local filenames must match those version stamps so future Supabase CLI runs do not treat these
already-applied migrations as new work.

A prior read-only schema inspection found objects associated with four later local migrations already
present in the hosted schema, while the hosted migration history did not list their local versions:
`20261019200000`, `20261019210000`, `20261019220000`, and `20261020100000`. Their presence alone
does not prove that every constraint, policy, trigger, function body, index, or grant matches the local
migration. The attempt to repair the internal migration ledger was blocked by the database tool's safety
controls and was not bypassed.

## Source snapshot migration verification

The following checks were run after applying the two migrations:

- `public.source_sync_runs` exists.
- `public.source_sync_memberships` exists.
- `public.complete_source_sync_snapshot(...)` is SECURITY DEFINER with an empty search path.
- `anon` and `authenticated` cannot execute the finalizer; `service_role` can.
- The latest repository verification, database, browser-workflow, and Cloudflare Worker build checks passed.

## Google Sheets connection status

The hosted connection record is `connected`, but `last_successful_sync_at` is still NULL and the last
recorded error is `google_sheet_sync_failed`. The saved scopes include the read-only Sheets scope.
This is not proof of a successful real spreadsheet import; an end-to-end sync, repeat-sync idempotency,
partial-row rejection, and owner review flow still need a real safe test.

## Reconciliation plan for the four older schema-history gaps

1. Compare each of the four local migration files against the actual hosted tables, columns, constraints,
   indexes, policies, triggers, functions, and grants. Do not compare table names alone.
2. Identify exactly which objects match and which differ.
3. Prepare a reviewed reconciliation plan. Do not insert migration-history rows merely to make the list
   look current.
4. Run the complete migration suite and SQL security tests on a disposable database first.
5. Use the supported Supabase migration workflow to reconcile the history; do not bypass tool safety
   controls or replay DDL blindly.
6. Re-check the migration list and object definitions after the supported repair.

## Known local migration order

- `20261019200000_invoice_responses_and_issue_states.sql`: customer responses and issue states.
- `20261019210000_business_brain.sql`: sourced facts, conflict handling, and recovery-rate audit trail.
- `20261019220000_scheduled_evaluation.sql`: evaluation run log and optional `pg_cron` schedule.
- `20261020100000_business_records.sql`: quotations, deposits, tasks, action owners, payment review queue,
  workspace member list, and payment import behavior.
- `20261020081030_source_sync_snapshot_tracking.sql`: Google Sheets source snapshot tracking.
- `20261020081110_complete_source_sync_snapshot.sql`: atomic snapshot finalization and reconciliation.

Migration timestamps alone do not establish dependency order; verify actual function and table dependencies
from the SQL before preparing any production reconciliation.

## Earlier version-stamp reconciliation

Two earlier local files were renamed to match hosted versions:

| Migration | Old local version | Hosted/local version |
| --- | --- | --- |
| `sync_overdue_opportunities` | `20261017200000` | `20261017192932` |
| `provider_connections_server_only` | `20261018073000` | `20261018054702` |

Membership security expectations remain: owners/admins may leave a workspace, cannot rejoin themselves,
nobody may change their own role, and the last owner cannot be removed.
