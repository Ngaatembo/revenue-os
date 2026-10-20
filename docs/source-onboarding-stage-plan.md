# Revenue OS source onboarding — implementation contract

## Outcome

A first-time business owner should be able to connect one existing source, understand what Revenue OS can and cannot see, verify what was imported, and reach a useful daily attention brief without guessing whether setup succeeded.

This stage improves onboarding and source trust. It does not introduce background monitoring, new connector scopes, billing, or automated customer messaging.

## Current product facts

- The current app has a first-run panel in `src/App.tsx` and a Connections workspace.
- Google Sheets uses OAuth and a read-only import flow. The owner selects a spreadsheet and invoice tab, then explicitly runs sync.
- Invoice CSV import has a preview and confirmation step.
- The daily brief is calculated from saved workspace records when the app loads; it is not a background watcher.
- The app currently has no live email or WhatsApp connector. The onboarding UI must keep those clearly marked as planned.
- A Google authorization is not evidence of a successful import. The UI must distinguish connection authorization from sync health and imported data.

## Intended first-run flow

1. **Explain the value** — “Connect one source. Revenue OS will show overdue money and follow-ups supported by your records.”
2. **Choose a source** — Google Sheets (read-only, if configured) or invoice CSV (manual upload). Do not imply email or WhatsApp are available.
3. **Authorize or upload** — request only the existing permissions; show a specific error if the provider is not configured.
4. **Inspect before saving** — preserve the current import preview and row-level errors; make the owner confirm the records.
5. **Show the result** — report accepted rows, rejected rows, duplicates, and last successful sync where available.
6. **Return to the daily brief** — summarize what is actually present and link to the most relevant queue. Empty source data must not be described as “no issues” when a sync failed or has never succeeded.

## Source status model

Represent these as distinct UI states rather than a single green “connected” badge:

- **Not connected** — no valid provider authorization.
- **Connected, not synced** — authorization succeeded but no successful import is recorded.
- **Syncing** — a sync is in progress.
- **Synced** — the latest sync completed successfully; show its timestamp and import counts if available.
- **Needs attention** — last sync failed, permissions expired, or rows require review. Explain the observed error and a recovery action.
- **Unavailable** — status could not be checked. Do not interpret this as an empty source.

Do not infer status from missing fields. Unknown values should remain unknown.

## Acceptance criteria

- The first-run panel's progress reflects real data: no invoices/leads/records, source authorized, and successful sync are separate facts.
- The owner can reach Connections and CSV import from onboarding in one action.
- Google Sheets is described as read-only and requires a separate successful sync before the UI calls it synced.
- The UI never claims that Revenue OS is monitoring email, WhatsApp, or other services that are not connected and implemented.
- Sync errors remain visible and include a retry/reconnect path; failed syncs do not erase the last known successful-sync timestamp.
- Import previews and source-review safeguards remain intact.
- Daily brief copy makes clear it is based on saved records and currently refreshes on app load, not continuous background monitoring.
- Keyboard focus, visible labels, narrow-screen layout, and reduced-motion behavior remain supported.
- No schema migration, new OAuth scope, production deployment, or automatic external message is part of this stage.

## Verification gate

Before merge, run and record:

- `npm run build`
- `npm run lint`
- `npm run test:domain`
- `npm run test:e2e`
- Database/security checks if persistence or authorization code changes
- Cloudflare preview build/deployment for the exact PR head
- Manual desktop and mobile review of first-run setup, connected-but-not-synced, successful sync, and failed/unavailable source states

A passing build alone does not prove that the onboarding flow is usable or that the displayed source status is true.
