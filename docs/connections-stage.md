# Connections stage — what exists and how far it is verified

Verification levels used below: **Implemented** (code exists) · **Locally tested** (unit/DB tests) · **Integration-tested** (real app + Worker + Postgres + browser, *simulated* Google) · **Production-verified** (observed against the deployed service and real Google). **Nothing in this stage is production-verified yet.**

## Journey

| Step | What happens | Where |
|---|---|---|
| Sign in | First visit: short welcome → Connections. Setup unfinished: resumes on Connections. A source has synced or records exist: Overview, never forced back. | `src/connections/landing.ts`, `Welcome.tsx`, `App.tsx` |
| Connect | Provider cards state what is read, what it is used for, current state, last sync and the real external dependency. | `src/connections/catalog.ts`, `ConnectionsPage.tsx` |
| Authorize | Google OAuth (code flow, one-time hashed state, `access_type=offline`). The refresh token is AES-GCM encrypted server-side; clients cannot read `provider_connections`. Missing permission ⇒ nothing is stored as connected. | `googleSheetsHandlers.ts` (`/api/integrations/google/start|callback?provider=gmail`) |
| Synchronize | Atomic claim lease → stage updates → page-by-page checkpoints → idempotent upsert. Initial 90-day backfill, then Gmail `history.list` incrementals; expired history position triggers a safe re-backfill. | `connections/runner.ts`, `connections/gmail.ts`, migration `20261021120000` |
| Automatic | Cloudflare Cron Trigger (`* * * * *`) calls `scheduled()` → `runDueSyncs`. A healthy connection is re-checked every 15 min; failures back off 5 min → 6 h; 3 failures ⇒ "Needs attention"; rate limits wait the provider's `Retry-After` and are not counted as failures; revoked access ⇒ token dropped, "Reconnect needed", no retry loop. | `wrangler.jsonc`, `src/worker/index.ts` |
| Overview | "Customer conversations" panel from persisted `communications`: each item separates **Observed** (facts), **Inferred** (what that probably means) and **Suggested**, with a link to the original email. | `ConversationsPanel.tsx`, `conversationInsights.ts` |

## Evidence (run 2026-10-21, sandbox)

- `npm run build` ✔ · `npm run lint` 0 errors · `npm run test:domain` 220/220 (includes Gmail parsing, pagination, budget resume, incremental, expired history, rate limit, status/landing/insight rules).
- `scripts/test-db.sh` — new `10_connections_communications.sql` (21 assertions: provider/status constraints, claim lease incl. stale lease, schedule gating, workspace isolation of communications/threads/status, no client access to tokens, anonymous denial).
- `npm run test:e2e:connections` 18/18, Chromium + real Worker + real Postgres/PostgREST + simulated Google:
  welcome → Connections → authorize → encrypted token stored against the workspace → first 100-message chunk with indeterminate progress and real stored count → sync continues after leaving the page → 207 messages stored once → Overview lists 2 waiting + 1 gone-quiet customer with source links, ignoring 200 newsletters → automatic pickup of a new email → rate-limit pause/resume → repeated 5xx ⇒ needs attention ⇒ recovery → revoked access ⇒ reconnect ⇒ no duplicates → second workspace isolated (data, status, tokens, sync, disconnect) → disconnect revokes at provider and removes the credential → declined permission stores nothing.
- `npm run test:e2e` 17/17 (pre-existing invoice/quotation/deposit/task/lead journey still passes).

## What is NOT verified (be explicit)

1. **Real Google**: no real consent, token exchange or Gmail response has been exercised. Field names follow Google's documented shapes only.
2. **Cloudflare cron**: `scheduled()` is called by the test; the deployed trigger has not been observed. Check Worker logs for `scheduled_sync` after deploy.
3. **Workers limits**: each run is bounded by `SYNC_MESSAGE_BUDGET` (default 100 messages ≈ 100+ subrequests). The free Workers plan allows 50 subrequests per invocation; set the budget to ≤ 40 there. Large mailboxes take many minutes.
4. **Production database**: migration `20261021120000` is **not applied** to Supabase. It must be applied (owner approval) before deploy; the new UI reads `list_connection_status`, `communications`, `conversation_threads`.
5. **Google Sheets** automatic sync (below) is simulated-tested only; it remains unproven against real Google (see `google-sheets-connector.md`).

## External dependencies the owner must resolve

- Enable the **Gmail API** in the Google Cloud project; add the Gmail scope to the consent screen; add each test account as a test user. Redirect URI is unchanged: `…/api/integrations/google/callback`.
- **Testing-mode limits** (secondary sources, confirm with Google): refresh tokens for sensitive/restricted scopes expire after ~7 days (owners are asked to reconnect weekly), ≤100 test users. `gmail.readonly` is a *restricted* scope: public use requires Google verification and a third-party security assessment (weeks). `gmail.metadata` would avoid body-adjacent data but cannot search, so it is not used.
- Worker secrets as in README, plus optional `SYNC_MESSAGE_BUDGET`.
- **WhatsApp Business**: not implemented, deliberately. Official Cloud API needs a Meta Business account, business verification, an approved app and an API-registered number; it delivers messages via webhooks sent to that number after setup. Existing personal WhatsApp chats are not readable. Meta partners describe a "coexistence" mode for numbers also used in the WhatsApp Business app (optional history share of up to ~6 months, best-effort webhooks, not available in every country) — verify against Meta's own docs and the owner's country before building.
- **Gmail push notifications** (Pub/Sub watch) would replace the 15-minute poll with near-real-time updates but need a Google Cloud Pub/Sub topic and a verified push endpoint; polling is the supported fallback today.

## Privacy

Stored per email: id, thread id, direction, counterpart address/name, subject (≤300), Google's snippet (≤200), time, automated flag, mailbox address. No bodies, attachments or recipients lists. Automated/newsletter mail is stored but flagged and excluded from insights.


## Update 2 — Sheets automation, readiness, WhatsApp route
- **Automatic Google Sheets sync** (`connections/sheets.ts`, runner, migration `20261021130000`): authorize once and choose a tab; the shared runner re-checks it every 5 minutes. A single Drive "modified" call detects change; the sheet is re-read (in 5,000-row pages, ≤50,000 rows) only if modified; identical content is never re-imported; a changed snapshot is persisted by the existing import RPC (content-hash de-dup, upsert by invoice id) and reconciled by the existing snapshot finalizer (missing rows go to review, never deleted or assumed paid); opportunities are refreshed by the same evaluation the daily job uses. Owner-fixable problems (missing columns, deleted/unshared sheet) show immediately and are not re-read until the file changes. The Overview refreshes by itself when the sync finishes.
- **Server setup check** (Connections page, owner/admin): shows which settings exist (booleans only), the exact redirect URI to register, and whether background sync is observed running.
- **Migration rehearsal and rollback**: `scripts/rehearse-migration.sh`, `supabase/rollbacks/`. See `deployment-readiness.md`.
- **WhatsApp**: dormant receiver and the smallest real test route: `whatsapp-route.md`.
- **Real Gmail test procedure and expected delays**: `gmail-verification-runbook.md`.

### Evidence (sandbox, 2026-10-21)
`npm run test:domain` 241/241 · `scripts/test-db.sh` passes (new suites 10, 11, 12) · `npm run test:e2e:connections` 26/26 · `npm run test:e2e` 17/17 · `scripts/rehearse-migration.sh` PASSED · build and lint clean. All provider behaviour above is **simulated Google**.
