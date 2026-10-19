# Integration sequence and real-workspace test

Checked read-only against hosted project `zivgfvcmposnbwqsudas` on 2026-10-19: 20 migrations, newest
`20261018111455`; none of the four pending migrations is applied. `pg_cron` 1.6.4 is **available but not installed**;
migration `20261019220000` runs `CREATE EXTENSION IF NOT EXISTS pg_cron` and schedules the job when it is applied.

## Order (needs owner approval at step 1; merging deploys to production)
1. Apply, once each and in this order: `20261019200000`, `20261019210000`, `20261019220000`, `20261020100000`.
   Re-run `list_migrations` afterwards. Never re-apply a listed version.
2. Merge PR #32 (`feat/invoice-response-loop` → `main`), confirm CI (verify + database jobs).
3. Retarget PR #33 to `main`, confirm CI, merge. Cloudflare Workers Builds deploys on merge.
Merging before step 1 would ship UI that reads tables that do not exist yet (the Follow-ups page degrades with a
plain "not switched on yet" notice; the older invoice-response UI in #32 does not).

## Real-workspace test (after step 1–3, signed in as the real owner, with permission to use real data)
- [ ] Sign in; Business Brain → recovery rate saved (history entry appears).
- [ ] Import a real invoice CSV; overdue invoices appear in Urgent with evidence and a next step.
- [ ] Import a real payment export that contains one unknown invoice number: matched rows appear as evidence, the unknown one under Follow-ups → Payments to review; re-import the same file adds nothing.
- [ ] Add one real quotation, one promised deposit and one task; confirm each appears in Urgent when its date passes.
- [ ] Draft, approve and manually send one reminder; import a later payment; Outcomes → Check payment evidence shows only payments after the send.
- [ ] Next morning: Connections shows an automatic check from ~05:30 UTC (`select * from cron.job_run_details` for failures).
- [ ] Second account in another workspace cannot see any of the above.
