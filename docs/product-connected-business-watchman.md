# Revenue OS product direction: Connected Business Watchman

Status: product proposal and implementation sequence
Date: 2026-10-20

## Product thesis

Revenue OS is a connected business watchman for owner-operated businesses. It should do the repetitive work of gathering permitted business signals, organizing them into one trustworthy view, and identifying the next best action. Owners should spend their time deciding and acting—not copying information into another CRM.

**Promise:** Connect the tools you already use. Revenue OS keeps track of what needs attention, explains why, and prepares the next action. You remain in control of consequential actions.

North-star outcome: verified cash collected, revenue recovered, opportunities progressed, and commitments not missed—not logins, records imported, or AI-generated activity.

## User experience principles

1. Connect once, reuse the connection. Each provider explains what will be read, why, scope, last sync, and disconnect controls.
2. One guided setup, not a configuration maze. Welcome → value and permissions → choose sources → authorize each provider → initial sync → review exceptions → useful daily brief.
3. No empty-dashboard dead end. Explain what Revenue OS can do, what data is missing, and the shortest next step.
4. Never imply OAuth equals working sync. Show separate states for connected, syncing, healthy, degraded, and disconnected.
5. Default to read-only and least privilege. Ask for additional scopes only when the user enables a feature that needs them.
6. Do not make owners re-enter data that already exists in their authorized tools. Allow manual entry as an escape hatch, not the normal workflow.
7. Explain every important alert with source, evidence, timestamp, confidence, and recommended action.
8. Human approval for external side effects. Drafting is safe; sending, changing records, payments, and other irreversible actions need explicit approval and an audit trail.
9. Mobile-first, low cognitive load. The daily brief should surface the few highest-value items, not make the owner navigate many tabs.
10. Honest freshness. Show the last successful sync and stale-data warnings. Never invent a conversation, payment, customer promise, or business event.

## Proposed onboarding flow

### 0. Account and workspace
After sign-in, create or select the user's organization. Explain that connected accounts belong to this workspace and access is limited by workspace membership.

### 1. Welcome / value
Headline: “Your business, watched over.”
Explain in plain language:
- See overdue invoices and money that needs attention.
- Find customers and prospects waiting for a reply or follow-up.
- Keep promises, tasks, quotations, and deposits from being forgotten.
- Get a prioritized daily brief with evidence and next actions.

Primary CTA: “Connect my business tools.” Secondary CTA: “Explore with sample data.” Sample data must be clearly labelled and never mixed with real business records.

### 2. Choose what to connect
Show provider cards with clear capabilities and status:
- Google Sheets — invoice and business records (read-only).
- Gmail / Microsoft email — unanswered enquiries, commitments, and follow-up context (read-only, separately consented).
- WhatsApp Business Platform — supported business conversations and contact context; availability depends on eligible Meta business assets, permissions, and approved API setup.
- Accounting/payment sources — prioritize only after validating which tools target customers actually use.
- CSV upload — fallback for customers who cannot connect a source.

Each card says what will be imported, required permissions, limitations, and whether the connector is ready, beta, or planned. Do not show a “Connect” button for a connector that cannot complete a real end-to-end flow.

### 3. Authorize providers
Use each provider's official OAuth or embedded authorization. Show provider identity and granted scopes after return. A failed provider should be recoverable without restarting the entire onboarding. Preserve successful connections if another provider fails.

### 4. Initial synchronization
Show a durable progress screen per source:
- Connecting / discovering / reading / identifying records / checking duplicates / saving / reviewing exceptions / complete.
- Counts for records found, imported, duplicates, rejected, and items needing review.
- Last successful sync time and clear retry action.
- Never show fake percentage progress when the provider cannot report it; use truthful stage labels.
- If one connector fails, continue with successful sources and provide a focused retry.

### 5. Review only what needs a human
Infer headers, source type, and contact matches. Auto-map high-confidence fields; ask the user only about ambiguous mappings, duplicate identity, missing required fields, or conflicting records. Preview the first records and explain the effect before saving. Never infer that an invoice is paid because it disappeared from a source.

### 6. First value moment
After initial sync, show a concise daily brief:
- Money needing attention (source-linked overdue balances).
- Customer/prospect conversations needing a reply, where authorized message data supports this.
- Promises, quotations, deposits, and tasks due.
- Opportunities at risk and why.
- Recommended next actions with evidence, confidence, and a direct route to the source/customer.

Do not show a made-up opportunity count when data is absent. If there is not enough data, explain exactly what source or field is needed.

## Daily product experience

The Overview should answer, in under a minute:
1. What changed since the last check?
2. What needs my attention now?
3. Which customer or invoice is at risk?
4. What is the next best action?
5. What can I safely approve or send?
6. Is the information current, and which sources are failing?

Use a prioritized “Needs you” queue rather than making users inspect multiple tabs. Each item includes a short explanation, evidence/source link, age or due date, suggested next action, and clear completion state. Separate observed facts from AI interpretations and estimates.

A customer detail view should unify known business identity, invoices, opportunities, tasks, last observed contact, and authorized conversation excerpts/links. Show “last contacted” only if message or activity evidence exists, with the source and timestamp. A failed or disconnected source must not be represented as “no messages.”

## Messaging strategy

Phase 1: context and hand-off, not a premature universal inbox.
- Detect a customer/prospect phone or email only from authorized records.
- Offer “Open WhatsApp” or “Compose email” links with the recipient prefilled where supported.
- Generate a context-aware draft and let the owner edit/copy/send in their existing app.
- Record that a draft was prepared; do not claim it was sent.
- Let the owner explicitly log the outcome or connect an authorized channel that can verify delivery/status.

Phase 2: in-product inbox for providers with supported APIs and sufficient demand.
- Sync inbound conversations and message metadata using official APIs/webhooks.
- Thread messages against contacts with conservative matching and a review queue for ambiguous matches.
- Show unread/unanswered messages, time since last inbound/outbound message, owner, and next action.
- Send only through provider-approved APIs, respecting template rules, opt-in, customer-service windows, rate limits, and platform policies.
- Require human approval for first-time or sensitive outbound actions; provide a clear send confirmation and audit trail.
- Do not promise access to all existing WhatsApp Business app history. Access depends on Meta's supported account/API setup and migration/coexistence capabilities.

## Integration architecture

Use a shared provider adapter contract:
- capabilities and requested scopes
- connect / callback / reconnect / disconnect
- discover resources
- inspect and map schema
- initial and incremental sync
- webhook/event handling where available
- durable sync-run status, cursor, freshness and errors
- idempotent persistence and source provenance
- health check and actionable recovery
- audit trail

Store credentials encrypted server-side; never expose refresh/access tokens to the browser or logs. Enforce organization membership on every endpoint. Use least-privilege scopes and support disconnect. Isolate provider failures so one broken integration does not block the entire workspace.

Prefer event-driven updates/webhooks when supported; use bounded scheduled incremental sync otherwise. Full rescans should be limited and safe. Use durable cursors, retry/backoff, rate-limit handling, dead-letter/review states, and idempotency keys. For Gmail push, Google documents Pub/Sub setup and watch renewal at least every seven days (daily renewal recommended); implement only when its infrastructure and operational burden are justified.

## What research suggests

- ChatGPT's connected-app model is a strong UX reference: select a supported app, authorize the intended account, review permissions, then invoke that app in context. Connection availability and capabilities are provider/workspace dependent; authorization is distinct from what actions an app can perform.
- HubSpot's WhatsApp integration promotes a shared inbox, conversation history, contact context, and replies from one place. This validates the demand for joined-up customer conversations, but its advanced capabilities depend on product tier and provider setup.
- Pipedrive positions its core value around leads, deals, contacts, activities, and follow-ups in one sales workspace; it lists integrations and AI-supported reports as part of the product.
- Official Google Gmail API docs support mailbox change notifications through Pub/Sub, but require ongoing watch renewal and a sync process to fetch actual changes. Push notification is a trigger, not the complete message payload.
- Meta's WhatsApp Business Platform Cloud API is the official route for API-based messaging and requires a WhatsApp Business Account/business assets and relevant permissions. This is not equivalent to reading arbitrary personal WhatsApp history.

Sources:
- OpenAI Help Center, Connected apps in ChatGPT: https://help.openai.com/en/articles/11487775-connected-apps-in-chatgpt
- OpenAI Help Center, Connecting and managing app accounts: https://help.openai.com/en/articles/20001494-connecting-and-managing-app-accounts
- HubSpot, WhatsApp integration: https://www.hubspot.com/products/whatsapp-integration
- HubSpot, Sales Hub pricing: https://www.hubspot.com/pricing/sales
- Pipedrive pricing: https://www.pipedrive.com/en/pricing
- Google for Developers, Gmail API push notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Meta WhatsApp Cloud API overview (official documentation entry point): https://developers.facebook.com/docs/whatsapp/cloud-api/overview/

## Competitive positioning and monetization

Do not compete as “another CRM with AI.” Differentiate on:
- fast onboarding for owner-operated businesses;
- exception-first monitoring across existing tools;
- explainable, source-linked recommendations;
- local business workflows (quotes, deposits, receivables, payment evidence, customer follow-up);
- low manual maintenance and explicit freshness;
- a measurable focus on cash collected and missed opportunities recovered.

Hypothesis to validate with 8–12 target business owners before final pricing:
- Starter: one or two sources, daily brief, basic follow-up and overdue invoice alerts.
- Growth: multiple sources, richer customer timeline, more frequent sync, shared team ownership and audit trail.
- Assisted setup: one-time paid onboarding for customers who want WebAura/Revenue OS to configure connections and map data.
- Price by business value and source/usage limits, not only seats; clearly disclose messaging/API pass-through fees.

Competitor reference points are not direct apples-to-apples: HubSpot currently lists Sales Hub Starter at a low per-seat starting price and Professional at a much higher per-seat price with onboarding fees; Pipedrive lists Lite at US$14 per seat/month when billed annually and Growth at US$39. These public prices show willingness to pay for sales workflows, but do not prove what Zimbabwean SMEs will pay. Test willingness to pay with interviews and paid pilots rather than assume a price.

## Recommended implementation sequence

### Stage A — make one connector trustworthy end-to-end
1. Complete hosted Google Sheets acceptance: discover, inspect, map, initial sync, duplicate retry, partial rejection, disconnected/revoked recovery.
2. Replace generic sync failure with provider-specific, user-actionable errors and show run history/freshness.
3. Improve header mapping and preview so users know what will be imported before sync.
4. Keep CSV fallback visible.
5. Add a “test connection” and “last successful sync” state.

### Stage B — guided onboarding and first value
1. Build welcome screen and concise explanation of value.
2. Add connection chooser with Ready / Beta / Planned states.
3. Persist onboarding progress; allow skipping optional providers and resuming later.
4. Show honest initial-sync progress and partial failures.
5. Land on a useful evidence-backed daily brief after the first successful source.
6. Add a short first-run checklist that disappears as tasks are completed.

### Stage C — contact and action context
1. Introduce normalized contacts/customer identities and source-linked activity events.
2. Add “last observed contact” and source links only where verified.
3. Add click-to-open WhatsApp/email and generated drafts, without auto-send.
4. Record approved/sent/manual outcome states accurately.

### Stage D — inbox and event-driven synchronization
1. Validate demand and provider eligibility for WhatsApp Business Platform and Gmail/Microsoft.
2. Implement one channel end-to-end with webhooks, cursors, retry, consent, privacy, and audit.
3. Add unified inbox only after message threading and contact matching are reliable.
4. Add sending through APIs only after opt-in/template policy, user approval, failure handling, and cost controls are implemented.

## Non-negotiable acceptance criteria

- A new owner can understand the value and connect one supported source without reading technical instructions.
- One source failing does not block another source from syncing.
- User sees the connected provider identity, data scope, last successful sync, record counts, and a useful recovery path.
- Initial import previews field mapping and exceptions before persistence.
- Repeat sync is idempotent; partial sync never advances authoritative snapshot state.
- Source data is tenant-isolated and auditable.
- A recommendation includes source evidence, timestamp, reason, and a reversible next action when possible.
- Contact history is never fabricated; stale/failed source is visibly stale.
- No external message or financial state change occurs without the correct consent and approval.
- The first useful business brief is reached with minimal setup and no unnecessary manual data entry.
- Hosted end-to-end tests prove behavior; build success alone is not a product acceptance test.
