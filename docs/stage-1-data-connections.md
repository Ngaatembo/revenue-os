# Stage 1 — Onboarding and data connections

## Goal

A new business can enter Revenue OS, connect or import its existing business data, review what was accepted or rejected, and understand whether the data was saved successfully. Do not claim an integration works until the complete deployed flow has been verified.

## Scope boundary

In scope:
- First-run onboarding and workspace creation.
- Invoice CSV import and payment CSV import.
- Google Sheets read-only authorization, sync, validation, duplicate handling, and connection status.
- Honest sync status, useful errors, last-successful-sync metadata, and safe disconnect.
- Refresh/reload after import to confirm records persist.
- Workspace authorization and isolation tests.

Out of scope for this stage:
- Gmail, WhatsApp, accounting platforms, and additional providers.
- New AI features, extra dashboard redesigns, and autonomous customer messaging.
- Production database migrations without explicit owner approval.

## Current baseline (from repository inspection)

- [x] First-run guidance exists in the app; it directs the user to connect data or import a CSV.
- [x] Invoice CSV parser and import workflow exist.
- [x] Payment CSV parser and import workflow exist.
- [x] Google Sheets Worker routes exist for OAuth start/callback, status, sync, and disconnect.
- [x] Google Sheets parsing tests cover accepted rows, common header aliases, invalid rows, missing columns, and duplicate invoice numbers within one range.
- [x] Google Sheets configuration and token-crypto unit tests exist.
- [ ] Live Google OAuth secrets and redirect URI verified in the deployed Worker.
- [ ] Hosted provider-connection and OAuth-state schema verified against the intended migration baseline.
- [ ] Real Google account authorization verified end to end.
- [ ] Sync of a dedicated synthetic test sheet verified against a test workspace.
- [ ] Repeated sync verified to be idempotent in persistence, not only in parsing.
- [ ] Refresh/reload verified to show saved imported records.
- [ ] Disconnect and revoked/expired-token recovery verified.
- [ ] Full deployed onboarding-to-first-data-import flow verified.

## Acceptance tests

1. A new user can create an account, establish a workspace, and reach Connections.
2. If Google Sheets is not configured, the app clearly says it is unavailable and does not claim a connection exists.
3. An authorized user can connect a Google account with read-only spreadsheet scope; tokens never reach the browser or logs.
4. A workspace member cannot inspect or use another workspace's connection.
5. A user can sync a spreadsheet they can read, using a specified range with a header row.
6. Invalid rows are counted and explained; valid rows are not silently lost.
7. Repeating an unchanged sync does not create duplicate invoices or double-count money.
8. A failed read or failed persistence does not update last-successful-sync metadata.
9. The imported records remain after a page reload and are reflected in the business attention workflow.
10. Disconnect removes usable stored credentials; subsequent sync attempts fail safely.
11. CSV import remains available as a fallback.
12. Build, lint, domain/Worker tests, SQL security/journey tests, and browser end-to-end tests pass on the exact candidate revision.

## Working sequence

1. Verify deployment configuration and database migration state without writing to production.
2. Run current automated tests and review gaps.
3. Fix the highest-priority connector or import defect on a branch.
4. Test against synthetic data and a disposable database/test workspace.
5. Deploy only after required checks pass and deployment safety checks are satisfied.
6. Record evidence and close Stage 1 only when the acceptance tests are satisfied.

## Safety

- Never use real customer financial records for initial connector verification.
- Never expose service-role keys, OAuth secrets, or refresh tokens in frontend code.
- Do not apply hosted migrations or alter production data as part of this stage without explicit approval.
- A passing unit test or successful preview build is not proof that a production integration works.
