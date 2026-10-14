# Migration history discrepancy (open, reconcile later)

On 2026-10-14 the PR #7 migration
(`supabase/migrations/20261014150000_fix_invoice_import_ambiguity_and_membership_escalation.sql`)
was executed manually in the Supabase SQL Editor after the in-app migration tool returned `cancelled`
twice. Read-only checks afterwards (reported by the project owner) confirmed the corrected
`persist_invoice_import` and an enabled `memberships_escalation_guard` trigger.

`supabase_migrations.schema_migrations` still lists 15 entries and does **not** include version
`20261014150000`, so the hosted schema and the migration history disagree.

Do not re-run the SQL and do not `supabase db push` blindly (it would try to apply the file again).
When reconciling, either record the version with `supabase migration repair --status applied 20261014150000`
after confirming the live definitions match the file, or follow the project's agreed process. Check
history consistency before renaming or editing any migration file.

Membership policy confirmed by tests: owners/admins may leave a workspace (self-removal), cannot rejoin
themselves, nobody may change their own role, and the last owner can never be removed.
