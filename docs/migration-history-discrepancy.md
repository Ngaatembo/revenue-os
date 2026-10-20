# Hosted migration history and schema drift

## Read-only verification on 2026-10-20

The hosted project `revenue-os` (`zivgfvcmposnbwqsudas`) reports 20 tracked migrations, from
`20261013212317` through `20261018111455`. The history includes the previously reconciled
`20261014150000` migration.

A read-only schema inspection found an important discrepancy: several tables associated with later local
work exist in the hosted schema, including `quotations`, `quotation_events`, `deposits`,
`payment_review_items`, `tasks`, `brain_facts`, `evaluation_runs`, and `invoice_interactions`,
but the hosted migration history does not list the later local migration versions
`20261019200000`, `20261019210000`, `20261019220000`, or `20261020100000`.
The new `source_sync_runs` and `source_sync_memberships` tables are absent from the hosted schema.

The live Google Sheets connection row currently reports `status=connected`, no successful sync timestamp,
and a generic sync error. This is not proof that a spreadsheet sync has succeeded.

## Safety decision

**Do not apply any further production migrations until the schema/history discrepancy is reconciled.**
Existing tables may have been created outside the tracked migration workflow or through partial manual
application. Replaying the same DDL blindly could fail or leave partially divergent functions, triggers,
constraints, grants, and policies. The hosted database also contains real workspace records, so it must not
be treated as empty or disposable.

No production schema or data was changed during this check.

## Reconciliation procedure

1. Compare each of the four later local migration files against the actual hosted tables, columns, constraints,
   indexes, policies, triggers, functions, and grants. Do not compare table names alone.
2. Identify which objects are missing, which are already present, and whether their definitions exactly match
   the local migration.
3. Prepare a reviewed, idempotent reconciliation migration or documented migration-history repair plan. Do not
   insert migration-history rows merely to make the list look current.
4. Run the complete migration suite and SQL security tests on a disposable database first.
5. Obtain explicit owner approval before any production DDL or migration-history mutation.
6. Apply the reviewed change once through the approved workflow, then re-check migration history and schema.
7. Apply the source snapshot migrations only after the prior schema dependencies and their definitions are
   confirmed consistent.

## Known local migration order

- `20261019200000_invoice_responses_and_issue_states.sql`: customer responses and issue states.
- `20261019210000_business_brain.sql`: sourced facts, conflict handling, and recovery-rate audit trail.
- `20261019220000_scheduled_evaluation.sql`: evaluation run log and optional `pg_cron` schedule.
- `20261020100000_business_records.sql`: quotations, deposits, tasks, action owners, payment review queue,
  workspace member list, and payment import behavior.
- `20261020083000_source_sync_snapshot_tracking.sql` and
  `20261020084500_complete_source_sync_snapshot.sql`: Google Sheets source snapshot tracking and reconciliation.

The migration timestamps do not themselves establish dependency order; verify the actual function and table
dependencies from the SQL before preparing the reconciliation plan.

## Earlier version-stamp reconciliation

Two local files were renamed to match the hosted versions previously confirmed:

| Migration | Old local version | Hosted/local version |
| --- | --- | --- |
| `sync_overdue_opportunities` | `20261017200000` | `20261017192932` |
| `provider_connections_server_only` | `20261018073000` | `20261018054702` |

Membership security expectations remain: owners/admins may leave a workspace, cannot rejoin themselves,
nobody may change their own role, and the last owner cannot be removed.
