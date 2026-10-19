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

Not yet applied to hosted: `20261019200000_invoice_responses_and_issue_states.sql`. It adds customer
response recording, promises, and issue states (acknowledge / snooze / dismiss / reopen). It needs
owner approval before it is applied. Apply it once, through the project's normal migration workflow,
and re-check `list_migrations` afterwards. Never re-apply a version that is already listed.

Verify before any push: compare `supabase migration list` (or the hosted `list_migrations`) against
`supabase/migrations/`; every hosted version must have a local file with the same version stamp.

Membership policy confirmed by tests: owners/admins may leave a workspace (self-removal), cannot rejoin
themselves, nobody may change their own role, and the last owner can never be removed.
