# Migration history (reconciled 2026-10-19)

Checked read-only against the hosted project `revenue-os` (`zivgfvcmposnbwqsudas`) on 2026-10-19:
the hosted history lists 20 migrations, versions `20261013212317` through `20261018111455`.

The earlier discrepancy (version `20261014150000` applied by hand in the SQL Editor but missing from
the history) is resolved: it is now listed in the hosted history.

Two local files carried version stamps that differed from the hosted history for the same migration.
They were renamed to the hosted versions so a push cannot treat them as new:

| Migration | Old local version | Hosted (and now local) version |
| --- | --- | --- |
| `sync_overdue_opportunities` | `20261017200000` | `20261017192932` |
| `provider_connections_server_only` | `20261018073000` | `20261018054702` |

Hosted re-checked 2026-10-19 (read-only): still 20 migrations; none of the following is applied.

Not yet applied to hosted (apply in this order, each once; owner approval needed):

1. `20261019200000_invoice_responses_and_issue_states.sql`: customer responses, promises, issue states
   (acknowledge / snooze / dismiss / reopen).
2. `20261019210000_business_brain.sql`: sourced facts with history, conflict handling, audit trail for
   recovery-rate changes. Independent of (1).
3. `20261019220000_scheduled_evaluation.sql`: daily background re-check and run log. Needs (1). It schedules
   itself with pg_cron only if that extension is available; otherwise it prints a notice and nothing is scheduled.
4. `20261020100000_business_records.sql`: quotations, deposits, tasks, action owners, payment review queue,
   workspace member list; replaces `persist_payment_import` so unmatched/ambiguous payments are queued for review
   instead of rejecting the file. Needs (1)-(3) (extends the evaluation run).

Apply through the project's normal migration workflow, then re-check `list_migrations`.
Never re-apply a version that is already listed.

Verify before any push: compare `supabase migration list` (or the hosted `list_migrations`) against
`supabase/migrations/`; every hosted version must have a local file with the same version stamp.

Membership policy confirmed by tests: owners/admins may leave a workspace (self-removal), cannot rejoin
themselves, nobody may change their own role, and the last owner can never be removed.
