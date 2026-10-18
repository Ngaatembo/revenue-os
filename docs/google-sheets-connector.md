# Google Sheets connector — implementation contract

This document describes the first connector milestone. It is not evidence that OAuth is configured or that a provider is connected.

## Scope

- Google Sheets read-only access using `https://www.googleapis.com/auth/spreadsheets.readonly`.
- OAuth authorization-code flow with a one-time, short-lived, server-validated state value.
- Bind every connection to the authenticated Revenue OS organization; never accept an organization ID as proof of membership.
- Encrypt refresh tokens before persistence using an independently configured Cloudflare secret key.
- Never return access or refresh tokens to the browser, log them, or place them in URLs.
- Only show “Connected” after the callback succeeds and a server-side Sheets API read is verified.
- Provide disconnect/revoke behavior, safe error messages, and last-successful-sync metadata.
- Keep invoice imports idempotent and preserve source spreadsheet ID, sheet/range, row identity, import timestamp, and currency/amount validation.

## Planned endpoints

- `GET /api/integrations/google/start`: requires a valid Supabase access token; starts authorization for the current organization.
- `GET /api/integrations/google/callback`: validates one-time state, exchanges the code server-side, encrypts and persists credentials, verifies read-only access, then redirects to a safe app URL.
- `GET /api/integrations/google/status`: authenticated, organization-scoped status only; never returns secrets.
- `POST /api/integrations/google/disconnect`: authenticated, organization-scoped disconnect and best-effort Google token revocation.
- `POST /api/integrations/google/read-test`: authenticated, organization-scoped test read for an explicitly selected spreadsheet ID.

All endpoints must use no-store responses, strict method checks, bounded request sizes, generic user-facing OAuth errors, and safe redirects. CORS must not be opened to arbitrary origins.

## Required deployment configuration

Set only through Cloudflare Worker secrets / bindings, never in Git or browser variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_TOKEN_ENCRYPTION_KEY` (random, high-entropy key used for AES-GCM encryption)
- A server-only persistence credential or binding with least privilege for the connector credential table.

The Google OAuth redirect URI must exactly match the callback URL registered in Google Cloud. Do not enable the feature in production until the secret configuration, storage migration, tenant isolation, and tests are complete.

## Storage and tenancy requirements

Persist provider, organization ID, encrypted refresh token, granted scopes, connection status, connected account identifier, created/updated timestamps, last successful sync, and safe error code. Enforce one connection per provider per organization unless multi-account behavior is explicitly designed. RLS/authorization must prevent cross-organization reads and writes. Never store provider tokens in localStorage/sessionStorage.

## Acceptance criteria

1. OAuth state mismatch, replay, missing code, and provider denial fail closed.
2. Invalid/expired Supabase sessions are rejected.
3. Organization A cannot inspect, use, disconnect, or read Organization B's connection.
4. Tokens are encrypted at rest and never included in API responses or logs.
5. Sheets API errors/timeouts do not mark a connection healthy.
6. Duplicate sync attempts do not create duplicate invoice records.
7. Existing sign-in, invoice CSV, lead recovery, actions, outcomes, and health endpoints continue to work.
8. Lint, type-check/build, domain/security tests, and integration tests pass before merge.
