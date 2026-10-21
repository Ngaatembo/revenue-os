# Follow-up tracking: release notes

What it adds: on each waiting customer the owner can **Mark handled**, **Remind me** (tomorrow / in 3 days / next week), **Add a note** (max 500 characters) and mark a sender **Not a customer**. Set-aside conversations live under "Handled and snoozed" and muted senders under "Hidden senders", each with a way back.

## Rules (all covered by tests)
- A **handled** conversation returns when the customer's last message is newer than the moment it was handled.
- A **snoozed** conversation returns at the reminder time (08:00 UTC on the chosen day) or earlier if the customer writes again.
- A **muted** sender is hidden for the whole workspace; the app warns first when the owner has written to that address.
- No message content is stored by this feature. The only free text is the owner's own note.
- Viewers can read tracking; only owner/admin/operator can change it (enforced in the database, not only in the screen).

## Release order (do not merge the app before the migration)
1. Run `supabase/migrations/20261021180000_conversation_tracking.sql` once in the Supabase SQL editor (the migration tool is blocked in this environment).
2. Check it: tables `conversation_tracking` and `muted_senders` exist with RLS forced, and `set_conversation_tracking`, `mute_sender`, `unmute_sender` are executable by `authenticated` only (not `anon`).
3. Merge the PR. If the app were ever deployed first, it still works: it detects the missing tables and hides the new buttons.
4. Record the migration in the ledger so `supabase db push` does not re-run it:
   `insert into supabase_migrations.schema_migrations (version, name) values ('20261021180000', 'conversation_tracking') on conflict (version) do nothing;`

## Rollback
`supabase/rollbacks/20261021180000_conversation_tracking.rollback.sql` drops both tables and the three functions. It deletes every handled/snoozed mark, note and muted sender; conversations themselves are untouched.

## Verified here / not verified
Verified in the sandbox: 37 database tests (permissions, validation, isolation), 11 rule unit tests, browser flow (handled, reload, reopen, resurface, remind, note, mute, unhide) at 33/33. Not verified: against the production database or a real mailbox until the migration is applied and the app is released.
