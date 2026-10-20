# Google Sheets connector — implementation contract

This document separates implemented behavior from configuration and verification that are still required. Code in the repository or a successful Worker build does not prove that hosted OAuth is configured or that a real spreadsheet has synced.

## Current implemented scope

- Google Sheets API access requests read-only Sheets access plus `https://www.googleapis.com/auth/drive.metadata.readonly` so the connector can discover spreadsheet files. It does not request Drive file-content or write access.
- OAuth uses a short-lived, one-time state stored as a hash and consumed server-side.
- Authenticated requests are checked against Revenue OS organization membership.
- Refresh tokens are encrypted server-side using `GOOGLE_TOKEN_ENCRYPTION_KEY`; tokens are not returned to the browser.
- The connector records an authorized account and explicitly displays “No successful sync yet” until a sync succeeds.
- The connector can discover spreadsheets visible to the connected account using Drive metadata (file ID, name, modified time, and web link). Discovery is organization-scoped and paginated by the provider API.
- The Connections UI offers a spreadsheet picker instead of requiring the user to paste an ID. A successful OAuth connection is still distinct from a successful invoice sync.
- First sync currently reads the selected spreadsheet/range. Tab/header inspection and remembered mappings remain follow-up work; the range field is still an advanced manual step.
- Invoice rows are validated and persisted through the invoice-import RPC. Repeated imports use a content hash and stable source-row identity.
- Successful complete snapshots track source/range membership. Missing rows enter a review queue; absence never marks an invoice paid or deletes its history.
- Owner/admin users can record a decision and note for a missing row. Decisions are audit metadata only; they do not verify payment, close an opportunity, or suppress overdue detection.
- Disconnect removes the stored refresh token and marks the local connection disconnected. It does **not** currently call Google's token-revocation endpoint; do not describe this as provider-side revocation.

## Implemented endpoints

- `GET /api/integrations/google/start`: authenticated organization member; starts OAuth authorization.
- `GET /api/integrations/google/callback`: validates/consumes state, exchanges code, checks the granted read-only scope, encrypts and stores the refresh token, then redirects to the configured app origin. It does not test a selected spreadsheet because no spreadsheet is selected at this point.
- `GET /api/integrations/google/status`: authenticated, organization-scoped status; does not return tokens.
- `GET /api/integrations/google/discover`: authenticated, organization-scoped spreadsheet discovery; returns metadata only, never tokens or spreadsheet cell contents.
- `POST /api/integrations/google/sync`: reads the requested spreadsheet/range, validates rows, persists invoices and completes source reconciliation.
- `GET /api/integrations/google/source-review`: owner/admin-only missing-row review queue.
- `POST /api/integrations/google/source-review`: owner/admin-only decision and audit note.
- `POST /api/integrations/google/disconnect`: owner/admin-only local disconnect and credential removal.

The callback and API require an exact `APP_ORIGIN` match. Responses are non-cacheable and errors should not expose provider credentials.

## Required Cloudflare Worker configuration

Set only through Cloudflare Worker secrets/variables, never in Git or browser variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters representing 256 bits for AES-GCM.
- `APP_ORIGIN`: exact production app origin, with no path or trailing slash.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY`.

The Google OAuth redirect URI must exactly match the deployed callback:
`https://revenue-os.ngaatendwew.workers.dev/api/integrations/google/callback`
(or the exact production origin actually configured for the app).

Do not paste secrets into chat, commit them, or place them in `VITE_*` variables. If the OAuth consent screen is in testing mode, add the account used for testing as an allowed test user.

## Safety and reconciliation rules

- A connected account is not the same as a successful spreadsheet sync.
- A failed read, rejected row, failed persistence, or incomplete snapshot must not mark missing rows.
- Empty/header-only snapshots are rejected to avoid treating an accidental empty range as a complete snapshot.
- Only a fully accepted snapshot can mark previously present rows as `missing_from_source_pending_review`.
- Missing rows are never deleted and are never inferred to be paid.
- Decisions such as `settled_elsewhere` are not payment evidence.
- Provider sync history and review decisions must remain organization-scoped.
- Production database migrations require explicit owner approval; repository migrations and disposable-database tests do not prove hosted migrations have been applied.

## Stage 1 acceptance checklist

1. Worker reports explicit unavailable/configuration status when required secrets are absent.
2. An authorized account can discover spreadsheets with read-only metadata permission; missing scope produces a clear reconnect instruction.
3. OAuth state mismatch, replay, missing code, provider denial, and invalid sessions fail closed.
4. Organization A cannot inspect, use, sync, review, or disconnect Organization B's connection.
5. The callback stores only an encrypted refresh token; no token appears in API responses or logs.
6. A first real sync reads a synthetic spreadsheet with the required headers and persists the expected rows.
7. Invalid rows are counted and shown; partial/rejected snapshots do not reconcile missing rows or advance last-successful-sync time.
8. An identical successful sync creates no duplicate invoices and leaves membership consistent.
9. A later complete snapshot with a missing row creates a review item; owner review is auditable and does not infer payment.
10. Failed/revoked access does not mark the connection healthy; disconnect clears the local usable credential.
11. CSV fallback and the existing sign-in, invoice recovery, leads, actions, outcomes, and workspace isolation continue to work.
12. Type-check/build, lint, domain tests, SQL migration/security tests, and browser E2E pass.
13. A real hosted OAuth/discovery/sync test is performed only after secrets and Google redirect/test-user settings are confirmed. This is not covered by disposable-database CI.

## Known limitations

- Google OAuth, spreadsheet discovery, and live spreadsheet sync are not confirmed merely by the code or CI.
- Existing OAuth connections created before Drive metadata discovery was added must reconnect once to grant the additional read-only metadata scope.
- Google token revocation is not implemented; disconnect only removes Revenue OS's stored credential.
- The review queue is audit-only; review decisions do not yet change overdue-opportunity calculation.
- The browser E2E uses local Postgres/PostgREST and a Supabase Auth stand-in. It does not exercise Google OAuth or hosted Supabase.
