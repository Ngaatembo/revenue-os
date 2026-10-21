# Migration ledger reconciliation — 21 October 2026

**Status: investigated, repair proposed, NOT executed.** Production was only read.

## Findings (read-only, 2026-10-21)
| Check | Result |
|---|---|
| Migration files in git | 32 |
| Versions in `supabase_migrations.schema_migrations` | 28 (all match a git file) |
| In git but not in the ledger | `20261021150000`, `20261021160000`, `20261021170000`, `20261021180000` |
| `20261021150000` objects live? | Yes: `communications` (RLS on and forced), `conversation_threads` view, the three indexes, `communications_member_read`, `provider_connections` sync columns, `consume_provider_oauth_state`, `claim_connection_sync`, `list_connection_status` |
| `20261021160000` objects live? | Yes: `persist_invoice_import_system`, `refresh_org_after_sync` |
| `20261021180000` objects live? | Yes: `conversation_tracking`, `muted_senders` (RLS on and forced), their policies, `set_conversation_tracking`, `mute_sender`, `unmute_sender` |
| `20261021170000` (WhatsApp) live? | **No.** `whatsapp_numbers` is absent and `communications.provider` is still limited to `'gmail'`. It must stay unrecorded. |

## How equivalence was checked
A scratch Postgres was built from the repo files (initial scope, no WhatsApp). For the five tables and the views touched, the column
definitions (names, types, nullability, defaults) and the table and function grants hash **identically** to production. The eight
functions have different raw hashes but **identical hashes after collapsing whitespace**; the live copies carry extra indentation from being pasted into the SQL
editor. No logic difference was found.

## Cause
The three migrations were applied through the Supabase SQL editor (the migration tool was declined), which does not write a ledger row.

## Proposed repair
`docs/ledger-repair-20261021.proposed.sql` inserts three ledger rows (`statements` = the repo file text) inside a transaction that aborts, changing nothing, if
a version is already present, an expected object is missing, or `whatsapp_numbers` exists. It runs no DDL.

Risks: the stored statements are the repo files, not the exact pasted text; the Supabase CLI will treat the versions as applied; the ledger cannot show later edits.
Rollback: `DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261021150000','20261021160000','20261021180000');`

Not covered: the older 2026-10-20 mismatch described in `migration-history-discrepancy.md` (all 28 ledger versions now match files).
