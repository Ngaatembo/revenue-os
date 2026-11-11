# Source reconciliation — Stage 1 design

## Problem

Google Sheets sync currently upserts rows that are present in the selected range. It does not record which invoices were absent from a later successful sync. If a source row is deleted, moved outside the selected range, or filtered out, its previously imported invoice can remain in Revenue OS and continue to feed overdue-invoice detection.

Absence from a sheet is not automatically proof that an invoice is void. The range may have changed, a user may have temporarily hidden rows, or the source may be incomplete. A reconciliation design must not silently erase financial history.

## Goals

- Make source freshness and row absence visible.
- Prevent an invoice no longer present in a verified source snapshot from being treated as unquestionably current forever.
- Preserve prior recovery actions, responses, payment evidence, verified outcomes, and audit history.
- Make retries idempotent and make a failed or partial sync incapable of marking records missing.
- Keep separate source/range scopes separate.
- Explain changes to the owner and allow review before financially consequential closure.

## Proposed model

1. Treat each successful sync as a complete snapshot only for its exact spreadsheet ID and selected range. Do not infer absence outside that range.
2. Persist a snapshot/run record with a stable source key, range, started/completed status, completion timestamp, accepted row count, rejected row count, and a content digest.
3. Track the last successful snapshot membership for each invoice/source scope. Reconcile only after the full source read, validation, and invoice persistence all succeed.
4. If a previously present invoice is absent from the new complete snapshot, mark it as 'missing_from_source_pending_review' (or an equivalent explicit state); do not delete the invoice or erase its evidence.
5. Exclude pending-review missing records from new overdue-opportunity detection only after product semantics and SQL tests explicitly establish this behavior. Existing actions and outcomes remain readable and verifiable.
6. Require owner/admin review to confirm whether a missing invoice is void, moved, settled elsewhere, or merely outside the selected range. A reviewed resolution should retain the original invoice and event history.
7. Never reconcile when the provider read failed, the range is invalid, no valid invoice rows were accepted, or persistence did not complete. Preserve the prior last-successful-sync timestamp.
8. Report added, updated, unchanged, missing-for-review, accepted, and rejected counts clearly. Distinguish a successful snapshot from a snapshot with rejected rows.

## Safety constraints

- Do not hard-delete invoices as part of sync.
- Do not silently overwrite verified payment evidence or historical recovery snapshots.
- Do not mark missing records as paid; absence is not payment proof.
- Do not infer that a row is deleted from an incomplete or failed response.
- Do not automatically close an opportunity with a recorded action solely because its source row disappeared.
- Keep content-hash duplicate-import optimization, but ensure duplicate detection does not skip necessary reconciliation metadata when the source snapshot is identical.
- Apply schema changes only through reviewed migrations and test them against a disposable PostgreSQL database first. No hosted migration is authorized by this design.

## Acceptance tests

1. Initial complete snapshot imports a fictional invoice and records snapshot membership.
2. Repeating the identical snapshot creates no duplicate invoices and does not duplicate financial totals.
3. Updating an invoice changes its current snapshot without replacing historical action/payment evidence.
4. Removing an invoice from a later complete snapshot marks it for review rather than deleting it.
5. A failed read, malformed response, invalid range, or failed persistence does not mark any invoice missing and does not advance the last-successful-sync timestamp.
6. A snapshot with rejected rows cannot silently reconcile away records; policy for partial snapshots is explicit and tested.
7. A row moved outside the configured range is presented as a range/source-review case, not falsely declared void.
8. An invoice with a prior recovery action remains available to inspect and verify after it is marked missing.
9. A missing invoice is never treated as paid without independent payment evidence.
10. All reconciliation queries and writes are organization-scoped and covered by SQL security tests.
11. Two concurrent syncs for the same source cannot produce conflicting membership states.
12. CSV imports retain their existing semantics and do not trigger Google Sheets source reconciliation.

## Implementation sequence

1. Decide source scope identity and whether the app needs a separate source-snapshot table or an equivalent event model.
2. Add migration and database journey/security tests on a branch; do not apply it to hosted Supabase.
3. Implement sync-run tracking and membership reconciliation atomically with invoice persistence.
4. Add UI evidence and explicit review/resolution actions.
5. Run build, lint, domain/Worker tests, SQL tests, and browser E2E against a disposable database.
6. Verify with a synthetic spreadsheet in a non-production/test workspace before deployment.

## Current status

This document records the intended safe behavior. It does not implement reconciliation, claim it is available in the app, or authorize production changes.