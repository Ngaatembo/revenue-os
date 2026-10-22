# WhatsApp Business — supported route and the smallest real test

Status in the product: **Not available.** Its migration (`20261021170000`) is **deferred**: it is not part of the initial Gmail + Sheets release. The card says so and is not clickable. The receiver code below is dormant (HTTP 404) until configured, and nothing it stores is used for insights yet.

## What the official API can and cannot give us (from Meta-published pages and partner documentation; verify against Meta's current docs)
- Access is through the **WhatsApp Business Platform (Cloud API)** with a Meta Business account, a WhatsApp Business Account (WABA) and a phone number registered to the API. It does **not** read a personal WhatsApp account, and a number cannot normally be in the ordinary WhatsApp Business app and the API at the same time.
- **Inbound messages arrive by webhook**, after the number is set up. The API is not a mailbox: there is no "list my past conversations" call. Meta's `messages` webhook carries inbound messages and delivery statuses.
- **Coexistence** (partners describe it) lets a number stay in the WhatsApp Business app while also on the API; the owner can optionally share up to about six months of history during onboarding, and messages sent from the app arrive as *echo* events. Partner docs call this best-effort visibility, not a complete archive, and say some countries are excluded. Eligibility for Zimbabwean numbers is **unknown** and must be checked with Meta.
- **Sending** is outside this product's scope (Revenue OS never sends customer messages). Business-initiated messages need approved templates.
- A real customer launch needs **business verification** and **app review**. A developer test needs neither.

## Why the Overview does not infer "waiting for your reply" from WhatsApp
Replies sent from the phone/app are invisible to the API unless coexistence echoes are enabled, so every thread would look unanswered. Until outbound visibility exists, WhatsApp messages are stored but excluded from that insight (asserted in the browser test).

## Smallest practical real test (≈1 hour, free)
1. <https://developers.facebook.com> → create an app (type *Business*) → add the **WhatsApp** product. Meta provisions a **test phone number** and a temporary token; add your own phone (up to 5 recipients) and verify it by the WhatsApp code.
2. Record the test number's **Phone number ID** (digits).
3. **Apply the deferred migration `20261021170000_whatsapp_webhook_receiver.sql` first (needs the owner's authorization, like any production change).** Only then, in Cloudflare set secrets `WHATSAPP_APP_SECRET` (Meta app → Settings → Basic → App secret) and `WHATSAPP_VERIFY_TOKEN` (any long random string you invent). Deploy.
4. In the Meta app → WhatsApp → Configuration: Callback URL `https://revenue-os.ngaatendwew.workers.dev/api/webhooks/whatsapp`, the same verify token → **Verify and save** (Meta calls our GET handshake) → subscribe to the **messages** field.
5. Register the number to your workspace (operator step, service role; there is deliberately no self-service route):
   `insert into public.whatsapp_numbers(phone_number_id, organization_id, display_phone_number) values ('<PHONE_NUMBER_ID>', '<ORG_ID>', '<display number>');`
6. Send a WhatsApp message from your phone **to the test number**. Expected within seconds:
   `select external_id, thread_id, counterpart_name, snippet, occurred_at from public.communications where provider='whatsapp' order by occurred_at desc;` shows exactly one row; sending again does not duplicate; a forged POST is rejected with 401.
7. Only then decide the product questions (outbound visibility / coexistence, UI state, insights, onboarding via Embedded Signup for real tenants).

## What is built and tested (simulated)
`src/worker/connections/whatsapp.ts` + migration `20261021170000`: GET handshake, HMAC-SHA256 verification over the raw body (constant time), idempotent storage by message id, unknown numbers acknowledged but dropped, storage failures return 500 so Meta retries. Unit tests (signature incl. non-ASCII, parsing, handshake, rejection, idempotency, failure), DB tests (12), and a browser journey step. **Not tested against Meta.**

> Updated plan, Meta findings, route comparison and the next slices: see `docs/whatsapp-existing-number-plan.md` (22 Oct 2026).
