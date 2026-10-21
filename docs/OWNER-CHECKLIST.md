# Owner checklist — what only you can do

**Never paste secrets, OAuth tokens, client secrets, passwords or email bodies into chat, a pull request, or an issue.** Everything below is done in the provider's own dashboard. When a step says "set a secret", type it into Cloudflare/Google yourself; just tell me "done".

## Release scope
**Initial release (this PR): migrations `20261021120000` and `20261021130000` — Gmail and Google Sheets.**
**Deferred: `20261021140000` (WhatsApp).** Do not apply it, and do not set `WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN`, until the WhatsApp test starts (`docs/whatsapp-route.md`). The current Worker is compatible with this: while those two settings are absent the WhatsApp endpoint answers 404 without ever contacting the database, Gmail and Sheets never reference the WhatsApp table, and the whole connections journey passes with that migration left out (`npm run test:e2e:connections:initial`, `DB_TEST_SCOPE=initial ./scripts/test-db.sh`, and the migration rehearsal's two phases — all in CI).

## Costs — everything that could cost money, before you decide anything
Your Supabase organization is on the **Free** plan (verified through the Supabase API). Cloudflare plan: not visible to me — check **Workers & Pages → Plans**.

| Item | Needed for | Cost | Notes |
|---|---|---|---|
| Cloudflare **Workers Paid** | Reliable background sync (recommended for the private test; needed in practice for real use) | **US$5/month** base, includes 10 M requests and 30 M CPU-ms; overage $0.30 per extra million requests and $0.02 per extra million CPU-ms; subrequests are not billed ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | My estimate (not measured): the per-minute cron is ≈43,000 requests/month and each connection's 5-minute polls ≈8,600 light runs/month, so a handful of connections stay inside the included amounts → effectively **$5/month flat**. Free-plan limits are 10 ms CPU and 50 subrequests per run ([limits](https://developers.cloudflare.com/workers/platform/limits/)). |
| Supabase **Pro** | *Public launch*, not the private test | **from $25/month** (includes 7-day daily backups; point-in-time recovery is a separate add-on ≈$100/month per 7 days) ([pricing](https://supabase.com/pricing)) | Required for leaked-password protection ([docs](https://supabase.com/docs/guides/auth/password-security)). Also the only plan with automatic backups — see item B below. |
| Google Cloud APIs (Gmail, Sheets, Drive) | Both | **$0** at this scale | Testing-mode OAuth is free. |
| Google **security assessment** for the Gmail permission | *Public launch only* | Assessor fee quoted by Google as **$500–$4,500**, plus yearly renewal per secondary sources, and weeks of calendar time ([Google app verification](https://developers.google.com/health/app-verification)) | Not needed while the app is in Testing with named test users. Vendor pages quote far higher numbers; treat those cautiously. |
| Meta / WhatsApp | Deferred | Free test number; per-message pricing for real use | Not part of this release. |
| Custom domain | Optional | domain registration | The `workers.dev` address is fine for the private test. |

## A. REQUIRED for the private real-provider test (you + one test mailbox + one test sheet)

**A1. Cloudflare plan (your choice).**
- *Option 1 (recommended, +$5/month):* **Workers & Pages → Plans → Workers Paid.** Raise `SYNC_MESSAGE_BUDGET` in `wrangler.jsonc` to 100 afterwards.
- *Option 2 ($0, riskier) — **currently selected**: `wrangler.jsonc` already sets `SYNC_MESSAGE_BUDGET` to 10 (commit `f7cbefe`).* A small test mailbox and a small test sheet may sync, but Free allows only 10 ms CPU per run, so runs can be cut off ("exceeded CPU" in Worker logs). If that happens the result says nothing about whether the product is right, and the fix is Option 1. Keep the test sheet to a few rows and the test mailbox small.

**A2. Cloudflare — confirm names (not values).** **Workers & Pages → revenue-os → Settings → Variables and Secrets** must list: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `APP_ORIGIN`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. (From outside, the deployed Worker already behaves as if all are set and well-formed.) `SUPABASE_URL`, `SYNC_INTERVAL_MINUTES`, `SYNC_MESSAGE_BUDGET` ship in `wrangler.jsonc`. Also confirm **Settings → Build → Git repository** is `Ngaatembo/revenue-os`, production branch `main`.

**A3. Google Cloud (~15 min)** — <https://console.cloud.google.com>, the project owning your existing OAuth client.
1. **APIs & Services → Library:** enable **Gmail API**, **Google Sheets API**, **Google Drive API**.
2. **Google Auth Platform → Audience:** **External**, status **Testing**. **Test users:** your sign-in Google address and the test Gmail address (and the Google account that owns the test sheet).
3. **Data Access → scopes** — exactly: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/spreadsheets.readonly`, `https://www.googleapis.com/auth/drive.metadata.readonly`, `openid`, and the "email" scope.
4. **Clients →** your Web application client → **Authorized redirect URIs** contains exactly: `https://revenue-os.ngaatendwew.workers.dev/api/integrations/google/callback`.
In Testing mode expect Google's "hasn't verified this app" warning (Advanced → Go to … (unsafe)) and Google ending the connection about every **7 days** (the app shows "Reconnect needed"; third-party-documented, confirm with Google).

**A4. Test data.**
1. A throwaway **test Gmail account**; from another address send it 4–6 emails ("Quote request: 20 bags of cement", "Delivery to Bulawayo?", and one thread you reply to).
2. A **synthetic Google Sheet**, tab **Invoices**, row 1 exactly `customer_id | customer_name | invoice_number | currency | total_amount | paid_amount | issued_at | due_at`, then three rows with `due_at` 25–45 days in the past: `TEST-C1 | Test Customer One | TEST-INV-001 | USD | 1200.00 | 0 | … | …`, `TEST-C2 | … | TEST-INV-002 | USD | 450.50 | 100.00 | … | …`, `TEST-C3 | … | TEST-INV-003 | USD | 300.00 | 0 | … | …` (dates `YYYY-MM-DD`).
3. In Revenue OS → **Business Brain**, set a **recovery rate** (e.g. 25%).

**A5. Authorize the release** — reply **"Authorize release"**. That authorizes me to (1) apply `20261021120000` then `20261021130000` only, (2) rename the local files to the stamped versions and commit, (3) merge the PR (Workers Builds deploys the Worker and its cron), (4) verify health, cron and routes. Nothing happens before that message.

**What happens in the real run (you click, I verify):** setup check all ✓ → Connect Gmail with the test account (leave the Gmail box ticked) → Connect Google Sheets, choose the sheet and tab → edit the sheet (mark TEST-INV-001 fully paid, add TEST-INV-004) and touch nothing else. I confirm with read-only queries that records exist exactly once, the edit arrived within ≈6 minutes, background syncs ran while nobody had the app open, the Overview matches the database, and a second workspace sees none of it.

## B. Strongly advised, but a decision rather than a blocker for the private test
- **Backups.** The Free plan has **no automatic backups**. The release only *adds* objects, was rehearsed with its rollback, and I will compare a per-table row-count/checksum fingerprint of every business table before and after (`scripts/prod-data-fingerprint.sql`; baseline already taken today). If you want a real restore point, the only way is upgrading to Pro first (cost above). Your call.
- **Production has real rows** (several workspaces, 10 invoices, 7 opportunities as of today). The migration does not alter them; the fingerprint will prove it.

## C. NOT needed for the private test — required before real customers / public launch
- **Supabase Pro + "Prevent use of leaked passwords"** (Authentication → Sign In / Providers → Email). $25/month.
- **Google OAuth verification and the Gmail security assessment** (weeks; $500–$4,500 assessor fee quoted by Google). Without it only named test users can connect.
- A clear **privacy notice** describing what is stored per email (metadata + ≤200-character preview, no bodies/attachments).
- Moving the app from `workers.dev` to your own domain (optional but expected by Google's verification for the app's home page).
- WhatsApp: Meta business verification and app review (deferred feature).
- Revisit running imports as the workspace owner (a dedicated system actor) and per-workspace audit needs.

---
WhatsApp stays secondary and unavailable until Gmail and Sheets are verified against real providers.
