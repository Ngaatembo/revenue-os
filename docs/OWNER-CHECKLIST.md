# Owner checklist — what only you can do, in order

**Never paste secrets, OAuth tokens, client secrets, passwords or email bodies into chat, a pull request, or an issue.** Everything below is done in the provider's own dashboard. When a step says "set a secret", type it into Cloudflare/Google yourself; just tell me "done".

Everything I can do alone is already done and tested in the sandbox. The items below unblock the **real-provider** verification. Items 1–5 can be done in parallel while the PR is reviewed.

---

## 1. Cloudflare plan — Workers **Paid** (needed; ≈ US$5/month)
Why: the free plan allows **10 ms of CPU per request / per cron run** and 50 subrequests; a sync decrypts a token, parses up to 100 emails and makes ~110 outbound calls, which will very likely exceed the free limits (the paid plan allows 30 s CPU for per-minute crons and up to 10,000 subrequests). Source: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) — confirm there.
How: Cloudflare dashboard → **Workers & Pages → Plans** → choose **Workers Paid**.

## 2. Cloudflare — confirm the Worker's settings exist (names only)
Dashboard → **Workers & Pages → revenue-os → Settings → Variables and Secrets**. These names must be listed (you cannot and need not view the values): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `APP_ORIGIN`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
I already observed from outside that the deployed Worker accepts them as configured (its Google routes answer 401, not "not configured", and the OAuth callback redirects to `https://revenue-os.ngaatendwew.workers.dev`), so this is a confirmation, not new work. `SUPABASE_URL`, `SYNC_INTERVAL_MINUTES` (5) and `SYNC_MESSAGE_BUDGET` (100) now ship in `wrangler.jsonc`, so you do not set them.
Also confirm **Settings → Build → Git repository** is connected to `Ngaatembo/revenue-os`, production branch `main` (merging deploys it).

## 3. Google Cloud (≈ 15 min) — <https://console.cloud.google.com>, the project that owns your existing OAuth client
1. **APIs & Services → Library**: enable **Gmail API**, **Google Sheets API**, **Google Drive API**.
2. **Google Auth Platform → Audience**: User type **External**, publishing status **Testing**. Under **Test users** add: (a) your own sign-in Google address, (b) the **test Gmail address** from item 5.
3. **Google Auth Platform → Data Access → Add or remove scopes**, add exactly these five (nothing else):
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/spreadsheets.readonly`
   - `https://www.googleapis.com/auth/drive.metadata.readonly`
   - `openid`
   - `.../auth/userinfo.email` (shown as "email")
4. **Google Auth Platform → Clients →** your Web application client → **Authorized redirect URIs** must contain **exactly**:
   `https://revenue-os.ngaatendwew.workers.dev/api/integrations/google/callback`
   (https, no trailing slash, no extra path). After the release, **Connections → Server setup check** prints the exact value it expects — compare.
Expect while in Testing: a "Google hasn't verified this app" warning (click **Advanced → Go to … (unsafe)**), and Google ending the connection about every **7 days** (the app then shows "Reconnect needed"). Making it public later needs Google verification plus a security assessment for the Gmail permission (weeks). These figures come from third-party integration documentation — confirm them in Google's OAuth verification documentation.

## 4. Supabase — leaked-password protection
Dashboard → project `revenue-os` → **Authentication → Sign In / Providers → Email** (direct link pattern: `/dashboard/project/<ref>/auth/providers?provider=Email`) → turn on **Prevent use of leaked passwords**.
This feature is available on the **Pro plan and above** ([Supabase docs](https://supabase.com/docs/guides/auth/password-security)); if the toggle is locked, the project is on the Free plan. It is also strongly advised to confirm a recent backup exists (**Database → Backups**) before the release.

## 5. Test accounts and synthetic data
1. **Test Gmail account** (new, free; not a real business mailbox). From any other address send it **4–6 emails** such as: "Quote request: 20 bags of cement", "Delivery to Bulawayo?", plus one "Re:" thread you answer from the test account. Wait 2+ days *or* tell me — the Overview only lists a message as "waiting for your reply" after **2 days**; I verify arrival earlier by database count.
2. **Synthetic Google Sheet** in the same or another test Google account (add it as a test user too). Tab named **Invoices**, row 1 exactly:
   `customer_id | customer_name | invoice_number | currency | total_amount | paid_amount | issued_at | due_at`
   Rows (use dates 45–90 days in the past for `due_at`, `YYYY-MM-DD`):
   `TEST-C1 | Test Customer One | TEST-INV-001 | USD | 1200.00 | 0 | <90 days ago> | <45 days ago>`
   `TEST-C2 | Test Customer Two | TEST-INV-002 | USD | 450.50 | 100.00 | <80 days ago> | <35 days ago>`
   `TEST-C3 | Test Customer Three | TEST-INV-003 | USD | 300.00 | 0 | <70 days ago> | <25 days ago>`
3. In Revenue OS → **Business Brain**, set a **recovery rate** (e.g. 25%) — without it no opportunities are calculated.

## 6. Authorize the release (one message from you)
Reply with the words **"Authorize release"** when items 1–5 are done (or tell me which to skip). That authorizes me to:
1. apply migrations `20261021120000`, `20261021130000`, `20261021140000` to the hosted project (one transaction each, rehearsed, rollback ready),
2. rename the local files to the stamped versions and commit,
3. merge the PR into `main` (Workers Builds deploys the Worker and its cron),
4. verify `/api/health`, the cron trigger and the deployed routes.
Nothing is applied, merged or deployed before that message.

## 7. Real-provider run (you click, I verify)
After the release I will tell you to do, in the live app:
1. Sign in → **Connections → Server setup check** → all ✓ (screenshot).
2. **Connect Gmail** → complete Google's consent for the **test** account, leaving the Gmail box ticked (screenshots of the card while it syncs and when complete).
3. **Connect Google Sheets** → choose the synthetic sheet and **Invoices** tab (screenshot).
4. Edit the sheet: set TEST-INV-001 `paid_amount` to `1200.00`; add a row TEST-INV-004. Do nothing else — no sync button.
I verify, by read-only database queries, that: connections are connected, records exist exactly once, the Sheets edit arrived within ≈6 minutes, the Overview numbers match the database, background sync ran without anyone opening the app (timestamps), and a second workspace sees none of it. I report each result as *production-verified* only when observed on the deployed system.
Optional afterwards: remove the app at <https://myaccount.google.com/permissions> and confirm the card says "Reconnect needed" within ≈6 minutes (revocation test).

---
WhatsApp stays secondary and unavailable until Gmail and Sheets are verified. Its route is in `docs/whatsapp-route.md`.
