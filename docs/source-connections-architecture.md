# Revenue OS source connections — product and implementation contract

## Product principle

Revenue OS is the business watchman, not a manual data-entry tool. Owners should authorize a source once, choose what business data is relevant once, and then see reliable freshness, health, exceptions, and recommended actions. Integrations must reduce repeated setup rather than introduce another admin workflow.

## Common connection lifecycle

Every source adapter should follow the same lifecycle and present the same states:

1. **Unavailable** — connector not configured or not supported; state the reason and next step.
2. **Disconnected** — no usable credential is stored.
3. **Connecting** — authorization is in progress; use one-time, short-lived OAuth state.
4. **Connected, not synced** — identity is authorized, but no successful data import has been confirmed.
5. **Discovering** — list available files/accounts/resources through the provider API using least-privilege scopes.
6. **Needs source selection** — show discovered resources and useful metadata; do not ask users to copy IDs or guess API ranges.
7. **Needs mapping** — detect likely data type, sheet/tab/table, header row, and fields; propose a mapping and ask only when ambiguous.
8. **Syncing** — show progress where possible; use bounded jobs and idempotency keys.
9. **Healthy** — last successful sync timestamp, records read/imported/rejected, and source freshness.
10. **Degraded / needs attention** — show a human-readable cause, whether old data is still being used, and a recovery action.
11. **Disconnected / revoked** — stop using credentials and provide a clear reconnect flow.

Never label a connection healthy merely because OAuth succeeded. Never advance last-successful-sync on partial, failed, or unverified work.

## Shared connector contract

Each adapter should implement a small provider-specific boundary behind a shared application contract:

- `capabilities()`: supported data types, authorization scopes, discovery, incremental sync, webhooks, and disconnect/revoke support.
- `connect()`: least-privilege authorization, validated redirect URI, anti-CSRF state, account identity.
- `discover()`: list resources accessible to the authorized account; paginate and respect provider limits.
- `inspect(resource)`: preview schema/headers and infer likely business data without importing it.
- `map(resource, mapping)`: persist the confirmed source selection and field mapping at workspace scope.
- `sync(resource, cursor)`: bounded, retryable, idempotent import with a durable run record.
- `reconcile(snapshot)`: only after a complete authoritative snapshot; never infer payment or delete history from absence.
- `health()`: credential validity, last success, latency/freshness, latest error category, and next step.
- `disconnect()`: disable local use, erase locally stored credentials, and revoke provider tokens when supported.
- `audit()`: record authorization, source selection, sync outcome, mapping changes, disconnect, and human decisions without logging secrets or sensitive row contents.

Provider adapters must not bypass the common workspace authorization boundary, source-run tracking, import validation, audit trail, or human approval rules.

## Cross-provider invariants

- Secrets and refresh tokens remain server-side, encrypted at rest, and never appear in browser payloads or logs.
- Every source, saved mapping, sync run, and imported record is organization-scoped and checked on the server.
- Use read-only scopes by default. Request write permissions only for a separately approved feature that needs them.
- Discovery is metadata-first. Import only the resources and fields relevant to the workspace's stated use.
- Users explicitly confirm the initial source and field mapping; routine refreshes should not require repeated configuration.
- Preserve raw-source identity, source timestamps, import hashes, and row-level rejection reasons.
- Identical syncs must be idempotent. Retries must be safe. Partial snapshots must not reconcile missing rows.
- A missing row is an exception for human review, not proof that an invoice was paid or a record should be deleted.
- Estimates, observed events, and verified financial outcomes remain distinct.
- No automatic customer-facing email, SMS, WhatsApp, payment, or accounting mutations without a separately approved and auditable action.
- Rate limits, expired credentials, provider outages, permission changes, pagination failures, and schema drift must be visible and recoverable.
- CSV/manual import remains a fallback, not the primary path for a source with a supported API.

## Initial source priorities

Prioritize by how directly each source improves verified revenue recovery and by integration effort:

1. **Google Sheets** — finish discovery of accessible spreadsheets, spreadsheet/tab inspection, header detection, remembered source mapping, reliable repeat sync, and live hosted acceptance tests. Add the narrow Drive metadata-read scope only if needed for discovery and explain it in consent UX.
2. **Payment evidence** — payment processors/bank exports where supported; match payment references to invoices, keep unmatched payments in a review queue, and never silently mark invoices paid.
3. **Accounting/invoicing** — adapters for tools actually used by target customers; ingest customers, invoices, credits, and payment state read-only first.
4. **CRM and lead sources** — capture enquiries and pipeline changes to surface stalled opportunities and follow-up obligations.
5. **Email/calendar** — optional and separately consented; derive tasks/promises only with evidence and clear provenance. Never send or modify messages automatically.
6. **Other operational systems** — add based on validated customer demand, not a long list of superficial integrations.

Do not implement all providers at once. Build the shared lifecycle and acceptance suite first, complete one provider end-to-end, then reuse the contract for the next adapter.

## Google Sheets implementation gap

Current Google Sheets code already has OAuth, encrypted refresh-token storage, organization membership checks, manual spreadsheet/range input, parsing, import persistence, and source snapshot reconciliation. The current UI still asks users to paste a spreadsheet ID/URL and type a range. OAuth requests the Sheets read-only scope but does not yet discover the Drive file list or inspect tabs automatically. Therefore it does not yet meet the intended "connect once, discover automatically" experience.

Required next increment:

1. Add provider-scoped discovery for spreadsheets visible to the connected Google account, with pagination and metadata-only fields.
2. Inspect a chosen spreadsheet's tabs and header rows using the Sheets API.
3. Suggest the best invoice tab and field mapping; explain missing/ambiguous fields.
4. Persist chosen spreadsheet, tab/range, and mapping per organization.
5. Make refresh use the saved source and mapping; keep manual range as an advanced override, not a required step.
6. Add explicit "connected, not synced" and clear discovery/sync error states.
7. Test pagination, inaccessible files, empty sheets, header mismatch, repeated sync, partial rejection, revoked token, workspace isolation, and successful live hosted import.
8. Only claim completion after hosted OAuth and real synthetic-sheet sync pass.

## Definition of done for any connector

- User can connect and identify the provider account once.
- Available resources are discovered automatically, with a useful empty state.
- First-time source and mapping selection is short and clear.
- Routine sync does not require re-entering resource IDs or ranges.
- Sync is observable: run status, timestamps, imported/rejected counts, and actionable errors.
- Retry and identical sync are safe.
- Tenant isolation, token handling, provider limits, and failure cases have automated tests.
- Data provenance and audit records are available.
- Disconnect/revocation behavior is truthful and tested.
- CSV/manual fallback remains available.
- Hosted configuration and at least one real provider round trip are verified before release.
