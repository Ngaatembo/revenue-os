# Real Gmail verification — exact steps

Goal: prove, with a real Google account, that authorization, first synchronization, automatic re-sync and revocation work. Until every step below succeeds, **Gmail is "implemented and simulated-tested", not "verified"**.

Use a **test mailbox** you do not mind the product reading (a new Gmail account with a few emails sent to it from another address is ideal). Revenue OS stores metadata and a ≤200-character preview, never bodies or attachments (see "What is stored").

## A. Google Cloud (one-time, ~15 minutes)

1. Open <https://console.cloud.google.com> → select the project that owns the existing Google Sheets OAuth client (or create one).
2. **APIs & Services → Library**: enable **Gmail API**, **Google Sheets API**, **Google Drive API** (Drive is used only to list sheet names and see "last modified").
3. **Google Auth Platform (OAuth consent screen)**:
   - User type **External**, publishing status **Testing**.
   - **Audience → Test users**: add the test Gmail address *and* your own sign-in Google address. Only listed accounts can authorize while in Testing.
   - **Data Access → Add or remove scopes**: add exactly `…/auth/gmail.readonly`, `…/auth/spreadsheets.readonly`, `…/auth/drive.metadata.readonly`, `openid`, `email`. (The app requests nothing else.)
4. **Credentials → your OAuth client (Web application)** → **Authorized redirect URIs** must contain **exactly**:
   `https://revenue-os.ngaatendwew.workers.dev/api/integrations/google/callback`
   (no trailing slash, `https`, same host as `APP_ORIGIN`). The in-app **Server setup check** prints the exact value it expects.

Why Testing mode matters: while Testing, Google expires refresh tokens after about 7 days for these scopes (so the owner is asked to *Reconnect* weekly — the app handles this) and caps test users at 100. `gmail.readonly` is a **restricted** scope: going public requires Google's verification and a third-party security assessment (weeks). Treat both as launch dependencies, not code tasks. *(Figures from third-party integration documentation — confirm on Google's pages.)*

## B. Cloudflare Worker settings (values never go in Git or chat)

Already observed on the deployed Worker (unauthenticated probes, 2026-10-21): Google routes pass the configuration guard (they answer 401, not 503), and the OAuth callback redirects to `https://revenue-os.ngaatendwew.workers.dev`, so `APP_ORIGIN`, the Google client settings, the 64-hex encryption key and the Supabase settings are **present and well-formed**. Their *values* have not been inspected.

Still to confirm/set:

| Setting | How |
|---|---|
| Cron Trigger `* * * * *` | Ships with the code (`wrangler.jsonc` → `triggers.crons`). After deploy: Cloudflare dashboard → Worker `revenue-os` → **Settings → Triggers → Cron Triggers** must list it. |
| Workers plan | **Workers Paid is required in practice** (free: 10 ms CPU, 50 subrequests). See `OWNER-CHECKLIST.md` item 1. |
| `SYNC_MESSAGE_BUDGET`, `SYNC_INTERVAL_MINUTES` | Ship in `wrangler.jsonc`: currently **10** (chosen for a Workers Free private test) and 5. Change them there, not in the dashboard. |

## C. Database + deploy (needs your explicit approval)

Follow `docs/deployment-readiness.md` ("Production procedure"). Order: apply migrations → deploy Worker. The new screens read tables that do not exist until the migrations are applied.

## D. Run the verification

1. Sign in to <https://revenue-os.ngaatendwew.workers.dev> as the owner. Open **Connections → Server setup check → Run setup check**. Every line must show ✓ and the redirect URI must equal the one you registered. "Background sync" will say *Cannot be checked yet* — that is correct.
2. **Connections → Gmail → Connect Gmail.** Google shows "Google hasn't verified this app" (expected in Testing) → **Advanced → Go to … (unsafe)** → on the permission screen **leave the Gmail read-only box ticked** (Google lets users untick individual permissions; if unticked, Revenue OS stores nothing as connected and says so) → **Continue**.
3. You return to Revenue OS. Expected: the Gmail card shows *Connection established / Fetching available information / Processing and organizing records* with an indeterminate bar and a real "N records stored so far" count. You may close the tab; it continues.
4. Wait. Speed is ≈ `SYNC_MESSAGE_BUDGET` emails per minute — **≈10/minute with the current Free-plan setting** (≈100/minute once raised on Paid). A test mailbox with ~50 mails takes about 5 minutes; 1,000 mails would take ≈100 minutes. When done the card says **Initial synchronization complete** and shows the last-sync time.
5. **Overview → Customer conversations.** Check against the real mailbox: customers who emailed you and got no reply in ≥2 days appear under "Waiting for your reply"; each item's **Open the original email** link must open that exact thread in Gmail. Newsletters/automated mail must not be listed (the line "N automated or newsletter threads ignored" counts them).
6. **Automatic sync:** from another address send the test mailbox a new email. Within **≈6 minutes** it should be stored (see "Update delay"). It appears in the Overview *list* only after it is ≥2 days old (by design); to see it immediately run the SQL below.
7. **Revocation:** at <https://myaccount.google.com/permissions> remove Revenue OS. Within ≈6 minutes the Gmail card must show **Reconnect needed**, and already-imported records must remain. Reconnect and confirm no duplicates (SQL below).
8. **Disconnect** from the card; confirm the app disappears from the Google permissions page (disconnect revokes at Google).

### SQL to confirm (Supabase → SQL editor, read-only; never paste tokens)

```sql
select provider, status, sync_stage, last_successful_sync_at, next_sync_at, last_error_code, consecutive_failures, records_synced
  from public.provider_connections;                         -- token column deliberately omitted
select count(*) total, count(*) filter (where is_automated) automated, min(occurred_at), max(occurred_at)
  from public.communications where provider = 'gmail';
select external_id, count(*) from public.communications group by 1 having count(*) > 1;   -- must return no rows
select provider, count(*) from public.communications group by 1;
```
Send me: screenshots of the setup check, the Gmail card at each stage, the Overview panel, and the SQL output. **Do not send tokens, client secrets or email bodies.**

## Update delay — what to expect (derived from the code, to be measured in step 6)

| Stage | Delay |
|---|---|
| Cron granularity | Cloudflare fires the trigger every minute (best-effort; occasional delays possible). |
| Poll interval | A healthy connection is re-checked every **5 minutes** (`SYNC_INTERVAL_MINUTES`). Only changes are fetched (Gmail history), so a quiet mailbox costs one cheap call. |
| New email → stored | **≤ 5 min + ≤ 1 min cron + seconds of work ≈ 6 min worst case, ~3 min average.** |
| Stored → visible in an open tab | The app re-reads status every 20 s, so **≤ 20 s** later; a newly opened page shows it immediately. |
| Initial backfill | ≈ budget emails per minute: **≈10/min with the current setting (≈100 min per 1,000)**; ≈100/min after raising the budget on the Paid plan. Incremental updates are unaffected (a few new emails fit in one run). |
| Rate limit / failure | Waits the provider's `Retry-After`; failures back off 5 min → 6 h; three failures ⇒ "Needs attention". |
| Real-time push | Not implemented (needs Gmail Pub/Sub watch + a verified push endpoint). Polling is the supported mechanism. |

## What is stored

Per email: provider message id, thread id, sent/received, counterpart address and name, subject (≤300), Google's preview snippet (≤200), timestamp, automated flag, mailbox address. No bodies, no attachments, no full recipient lists. Delete everything with Disconnect + `delete from public.communications where provider='gmail'` (owner request).
