# WhatsApp for existing numbers — audit, route, test plan and next slice

Date of research: 22 October 2026. Status labels used throughout: **Implemented**, **Tested locally** (simulated, no Meta involved), **Verified against Meta** (real Meta delivery observed), **Missing**.
**Nothing in this document has been verified against Meta yet.** Meta pages were read through a summarising fetch tool; wording below marked *(summary)* must be re-read on the live page before relying on it.

## 1. Current-state audit (main at `df14b07`)

| Step | Where | Status |
|---|---|---|
| Webhook endpoint exists, off until `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` are set | `src/worker/index.ts:39`, `src/worker/connections/whatsapp.ts` (`handleWhatsAppWebhook`) | Implemented, tested locally. Production: off (secrets unset, migration unapplied; `whatsapp_numbers` absent, checked read-only 21 Oct) |
| Verification handshake (GET `hub.mode/verify_token/challenge`) | `whatsapp.ts` | Implemented, tested locally. Not verified against Meta |
| Signature check: HMAC-SHA256 over the raw body, constant time | `verifySignature` | Implemented, tested locally (incl. non-ASCII). Whether Meta signs the exact raw bytes is stated in Meta docs only as "JSON payload" *(summary)* — confirm with the first real delivery |
| Phone-number-ID → workspace | `whatsapp_numbers` (service-role only; operator inserts a row, no self-service) and the lookup in the handler | Implemented, tested locally. Unknown numbers are acknowledged and dropped. **Missing:** self-serve registration (needs Embedded Signup) |
| Parsing inbound messages (text and `[type]` placeholders; statuses ignored) | `parseWebhook` | Implemented, tested locally |
| Parsing messages the owner sends from the Business app (`smb_message_echoes`) | `parseEchoes` — **added on this branch** | Implemented, tested locally. Payload shape taken from Meta's reference *(summary)*; **never seen in a real delivery** |
| Deduplication | `communications` unique `(organization_id, provider, external_id)` + `ignore-duplicates` upsert | Implemented, tested locally (unit, DB, browser replay). Meta retries non-2xx for up to ~7 days *(summary)* |
| Persistence failure retried safely | handler returns 500 → Meta retries; storage idempotent | Implemented, tested locally |
| Secure persistence | `communications` RLS forced; WhatsApp migration deferred | Table exists in production; the WhatsApp provider value is not allowed there yet |
| Customer/thread identity | `thread_id` = customer's `wa_id`; name from `contacts[].profile.name` | Implemented. Not matched to invoices or other channels |
| Logging | no `console.*` in the handler; `db()` throws a generic error | Tested locally on this branch: no message text, secret, signature or token appears in logs |
| Business-signal generation | none. PR #63 (open, not wired to any connector, table not in production) | **Missing** |
| Overview / follow-up | WhatsApp rows are invisible: the conversation loader requests `provider=eq.gmail` (`src/connections/api.ts:12`), and Overview "waiting" logic is Gmail-only. The browser test asserts WhatsApp is not turned into a waiting guess | **Missing** (deliberate until outbound visibility is proven) |
| Connection health / stale state for WhatsApp | none; catalog marks WhatsApp "external approval required" | **Missing** |

**PR #63 (business signals):** open, +163/−30, 3 files, based on the pre-#64 main, migration version `20261021120000` (sorts before the connection migrations). No connector writes to it. **Do not use it for the first WhatsApp slice**: messages already live in `communications`, and the Overview reads that table. Adapting `communications` rows into signals is a later, separate step once #63 is rebased and applied.

## 2. What Meta's documentation establishes (and what it does not)

Established *(summary of Meta pages, 22 Oct 2026)*:
- **Test numbers:** starting with Cloud API auto-creates a test WhatsApp account and test business number with relaxed limits and no payment method for template sends. A tester replying to the test number fires webhooks. Recipient cap and token lifetime: not found — read them in the App Dashboard API Setup panel.
- **Webhooks:** verify with GET handshake; `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 with the app secret; non-200 responses are retried with decreasing frequency for up to 7 days; duplicates possible. Fields are subscribed once at app level; for each customer, `POST /<WABA_ID>/subscribed_apps` with that customer's token.
- **Embedded Signup:** v4 is current. v2/v3 were deprecated 15 Oct 2026 and are served as v4; v2 WABA-only sharing works until 16 Nov 2026. Flow: `FB.login` with `config_id`, `WA_EMBEDDED_SIGNUP` event returns `waba_id`/`phone_number_id`, server exchanges the 30-second code, subscribes the app, registers the number.
- **Tech Provider:** needs a Meta app with the WhatsApp use case, a business portfolio, **Business Verification** (before App Review), then **App Review** with Advanced access to `whatsapp_business_messaging` and `whatsapp_business_management` plus two screen recordings. Until then the limit is **10 new customers per rolling 7 days**; after verification and review it rises to **200**. Meta lists no fee for Tech Providers.
- **Coexistence (existing Business app number):** Business app v2.24.17 or later; **only a Solution Partner or Tech Provider can onboard business-app users**; Embedded Signup with `featureType: whatsapp_business_app_onboarding`; subscribe to `history`, `smb_message_echoes`, `smb_app_state_sync`, `account_update`. History is a one-time sync of up to 180 days that must be completed within 24 hours; groups excluded; media IDs only for the last 14 days; throughput fixed at 20 messages/second; broadcast lists, disappearing messages, view-once and live location stop working in 1:1 chats; the Business app must be opened at least about every 13-14 days (third-party and Meta webhook reasons differ slightly).
- **Pricing:** inbound messages are free; messages sent from the Business app under coexistence are free; each business number has 1,000 free service messages a month; from 1 Oct 2026 service messages beyond that and utility messages inside an open window are charged; Zimbabwe is in the "Rest of Africa" rate region, priced by the recipient's country. The USD rate figures were not retrievable.

**Not established:**
- **Whether +263 numbers can use Coexistence.** No Meta page we could read mentions Zimbabwe for coexistence, and Meta's onboarding page publishes no country list. Meta's changelog shows a country-by-country rollout (launch Feb 2025; India May 2025; several countries Oct 2025), which suggests country-code gating, but absence of +263 from the changelog proves nothing either way. Third-party providers say "global except Nigeria and South Africa" (one 2026 marketing post says those were added in April 2026, **unverified**); none mention Zimbabwe. Do not treat any of this as support.
- Whether an unregistered sole trader in Zimbabwe can pass Business Verification (Meta says self-filed forms are not accepted; accepted documents must show legal name and address; nothing found on sole traders or Zimbabwe).
- Whether a business can use coexistence through its **own** Cloud API app without being a Tech Provider (docs say no; not stated explicitly for the self-use case).
- App Review turnaround (no figure found); the in-app confirmation screens (not documented by Meta).

## 3. Direct Meta route versus a provider

| | A. Direct (own Embedded Signup, we are a Tech Provider) | B. Provider (e.g. 360dialog partner plan) |
|---|---|---|
| Recurring fees | none found from Meta | 360dialog partner plans €250 / €500 / €1,000 a month (5 / 10 / 20 channels; extra channels €49 / €25 / €15); card payments +4%; EUR/USD only *(vendor pricing page, 22 Oct 2026)*. Twilio $0.005 per message **including inbound**, plus Meta fees |
| Meta message fees | $0 for a read-only inbox | same, billed separately |
| Still needs Meta Business Verification / App Review? | yes | yes — a provider's partner program does not remove Meta's requirements; it moves some of them behind the provider |
| Coexistence | via our Embedded Signup | supported by 360dialog; number must have been active in the Business app ≥7 days; the Business Manager choice is permanent |
| Engineering | about 8–12 working days for a developer who already has a receiver (**my estimate, not sourced**): Embedded Signup UI, token storage, per-WABA subscription, history sync within 24 h, echoes, media download | less onboarding code, but webhook forwarding, data export and number portability terms were **not found** |
| Lock-in | lowest | unknown; 360dialog's Business Manager choice is permanent |
| Risk | Business Verification for a Zimbabwe business without registration is the unknown | cost, and the same eligibility unknown for +263 |

**Recommendation:** direct, because a read-only inbox costs nothing in Meta fees and the provider route does not remove the Meta verification risk. Use a provider only as a fallback or as a **cheap eligibility oracle**: ask for written confirmation of +263 coexistence support before paying anything. Not researched: Gupshup, Wati, Respond.io, Chakra, Interakt, Infobip, Bird, Vonage, Zenvia.

## 4. Cost estimate

| Item | Unavoidable? | Cost |
|---|---|---|
| Meta test number, developer app, webhook | yes for the first test | $0 |
| Meta Business Verification | yes before real customers | no fee found |
| Meta fees for receiving messages and for messages the owner sends from the Business app | — | $0 |
| Meta fees for messages Revenue OS would send | We never send. $0 | $0 |
| Cloudflare Workers Paid | optional, recommended for reliable background sync | $5/month |
| Supabase Pro | optional (backups; leaked-password protection) | from $25/month |
| 360dialog partner plan | optional fallback | from €250/month (+4% card fee) |
| Twilio | optional fallback | $0.005 per message, inbound included |
| Custom domain | needed for Google verification, helpful for Meta | registration fee only |
| Developer time | yes | the main cost |

## 5. Existing-number compatibility: exact test plan (nothing here migrates or risks your current number)

**Why you cannot just try it today:** Meta says only a Solution Partner or Tech Provider can onboard Business-app users. We are not one yet. A **Meta test number cannot test coexistence** (it is not a Business-app number); it only proves our receiver. So the +263 question has to be answered by one of these routes, cheapest first:

**Step 0 — zero-risk checks on your current number (read only; change nothing).**
1. Confirm it is the **WhatsApp Business app** (green "B" icon), not consumer WhatsApp.
2. Update it to version 2.24.17 or later. Note the version.
3. Note whether the business profile is complete and the number has been active for more than 7 days.
4. Confirm you control the SIM, the chat backup and the two-step verification PIN (write the PIN down safely; do not share it).
5. Confirm you are an admin of a Meta Business portfolio (business.facebook.com). Create one if not; it is free.

**Step 1 — get an answer without touching the number.** Email a provider that supports coexistence and ask, in writing: "Can a Zimbabwean +263 WhatsApp Business app number be onboarded with Coexistence today? If not, what error does the user see?" Save the reply. A written "yes" or "no" costs nothing.

**Step 2 — only if Step 1 is "yes" or unclear: use a spare number, not your main one.** Buy or use a spare +263 SIM, install the WhatsApp Business app on a second phone or the same phone's spare profile, create a business profile, and use it for a few days with a friend so it has real chats. Then run the provider's or our own Embedded Signup with Coexistence on **that** number.
- **Eligible looks like** *(third-party description, Meta has not documented the screens)*: a prompt to connect an existing Business-app account, a QR scan from the Business app, a choice whether to share chat history, and the app showing it is connected.
- **Ineligible looks like:** the message "Your phone number isn't eligible to connect to the WhatsApp Business Platform", or a flow that only offers to register the number as a **new API-only number**. **Stop at that point.** Never accept an API-only registration on your main number: it would stop working in the app.

**Step 3 — only if the spare number passes:** repeat once on the main number, with a fresh chat backup taken first and the written PIN to hand.

**Back-out:** disconnect from the Business app (Settings → Account → Business Platform, *third-party description; verify in the app*) or through the provider. Do not delete the Business app account.

**If coexistence is not available for +263:** keep the number exactly as it is and use the **test-number fallback**: a Meta test number (or a new, separate number) receives messages sent to it, which proves the receiver and the Overview behaviour but not coexistence. Product-wise, owners on ineligible numbers cannot be watched on WhatsApp without moving to an API-only number; we will not suggest that, and we will not use unofficial WhatsApp Web automation.

## 6. Test-number integration: what was and was not proved

**Real Meta evidence: none.** Everything below is simulated.

| Required check | Evidence |
|---|---|
| Real Meta verification handshake | **Not done.** Needs a deployed URL with `WHATSAPP_VERIFY_TOKEN` set |
| Real signed inbound message | **Not done** |
| Correct mapping to the intended workspace | Simulated: unit test with two numbers in one delivery; browser test with a registered number |
| One stored event per message despite retries | Simulated: unit, database and browser replay tests |
| Invalid signatures rejected | Simulated: unit (401, nothing read or written) and browser |
| Unknown phone-number IDs cannot write elsewhere | Simulated: unit (mixed delivery writes only to each number's own workspace) and browser |
| Persistence failures retried safely | Simulated: 500 returned, idempotent storage |
| No credentials or message bodies in logs | Simulated: unit test captures every `console` call across success, forgery and failure |

`scripts/whatsapp-simulate.mjs` (`npm run whatsapp:simulate -- <base-url>`) replays these checks against any URL you choose. It prints only status codes and never prints a secret. It is **not Meta evidence**; it only proves our endpoint's behaviour. I ran it against a local harness: 6 of 6 checks passed.

**To get real evidence (needs your approval):** apply `20261021170000` to production, set the two secrets in Cloudflare yourself, create the Meta app and test number, register the callback URL `https://revenue-os.ngaatendwew.workers.dev/api/webhooks/whatsapp`, insert one `whatsapp_numbers` row for a **test workspace**, and send a message from your phone to the test number. The exact steps are in `docs/whatsapp-route.md`. Do not enable the real webhook on a workspace with customer data.

## 7. Smallest safe next slices

**Slice 1 (this branch, done):** receiver hardening (constant-time verify token), echo parsing into outbound rows, tests, simulator. No UI, no migration changes.

**Slice 2 (after the real test number delivers one message and one echo):** make WhatsApp useful to the watchman.
- *Observed:* an "Observed" row per WhatsApp thread: last customer message, date, snippet, source "WhatsApp (number …)".
- *Never assume waiting:* a thread is "Inferred: waiting for your reply" only when **all** hold: the last message is inbound; the number has **outbound visibility** (at least one echo from the Business app has been received for this number); no outbound after it; it is older than the same threshold Gmail uses; the owner has not handled or snoozed it. Without outbound visibility the row says "reply status unknown" and is never counted as waiting.
- *No duplicate opportunities:* one row per `(organization, provider, thread_id)` — the existing key used by `conversation_tracking`. Needs `conversation_tracking.provider` to allow `'whatsapp'`.
- *Privacy:* snippets only (≤200 characters, as for Gmail), no media stored, workspace-scoped RLS, deletion on disconnect extended to WhatsApp.
- *Health:* a member-readable RPC returns, per number: last message received, last echo received, and whether echoes have been seen. There is no polling to fail, so absence of messages is **not** shown as an error; only "no message since …" is shown. A reconnect or `account_update` event marks the connection as needing attention.
- *Owner control:* nothing is sent; "Mark handled" and "Remind me" reuse the Gmail tracking.
- *Migration:* one new migration (amend the unapplied `20261021170000` to add `conversation_tracking` provider check, `outbound_visible`, last-seen columns and the status RPC). Needs approval and a rehearsal first.

**Slice 3:** Embedded Signup (needs Business Verification and App Review first) so numbers register themselves; history sync within 24 hours.

**Reusable for Instagram and Messenger:** keep the same shape — one receiver per channel normalising into `communications` (`provider` = `whatsapp` / `instagram` / `messenger`), a per-channel *outbound visibility* capability, and channel-generic insight rules. Not implemented here.

## 8. Checklist of what I need from you

1. **Decide** whether to run the real test number test now. If yes, say "approve WhatsApp test": I then give you the migration SQL to run in the Supabase editor, and you set the two secrets in Cloudflare.
2. Create a free **Meta developer account and app** (type Business, WhatsApp product) and note the **Phone number ID** of the test number. Do not paste the app secret or tokens into chat.
3. Tell me which **test workspace** should own the test number.
4. Do **Step 0** of the existing-number test plan and tell me: app version, whether it is the Business app, whether you have a Meta Business portfolio.
5. Send the **Step 1 email** to a provider (360dialog sales or support) and forward me their answer.
6. Provide **operator details** (legal or trading name, contact email, postal address): Meta Business Verification and Google verification both need them.
7. Tell me whether the business is **registered** (certificate) or a sole trader; that decides whether Meta Business Verification can succeed.

## 9. Blockers and recommended next action

| Blocker | Owner |
|---|---|
| Coexistence for +263 not established | Step 1 email, then spare-number test |
| Business Verification route for an unregistered business unknown | You: operator details and registration status |
| Real webhook needs production migration and two secrets | You, with your approval |
| App Review timing unknown | Meta |
| PR #63 not needed for Slice 2; do not merge it for this | — |

**Next action (single):** approve the test-number run (item 1 above) and do items 2–3, so one real signed message reaches the receiver. In parallel, send the Step 1 email — it costs nothing and answers the +263 question before anyone pays for anything.
