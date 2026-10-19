# Revenue OS — onboarding and product design handoff

## Product promise

**Revenue OS is the business watchman.** The owner signs in with an email, connects the information the business already has, and gets a short, evidence-backed list of what needs attention to protect or grow revenue. They should not need to learn a dashboard, build reports, or configure a dozen rules first.

## Reference products and what to learn from them

- **Float** — connection-first setup: link an existing accounting source, sync invoices/bills/transactions, then show a live decision view. Borrow the “connect once, use existing records, keep information fresh” mental model, not its finance-team complexity. Reference: https://www.floatapp.com/integrations and https://www.floatapp.com/product
- **Ramp** — short, numbered onboarding steps and clear progress from initial setup to connected systems and approvals. Borrow visible progress and plain-language next steps. Reference: https://ramp.com/switch
- **Fathom** — guided quick-start, data connection, then useful financial insights. Borrow the separation between source data and interpreted business performance. Reference: https://apps.xero.com/us/industry/accounting/app/fathom

Revenue OS is not an accounting system and should not ask an owner to migrate their business. It sits on top of the records and workflows they already use. For Zimbabwe and other African SMEs, spreadsheets/CSV and manual records must remain first-class options when integrations are unavailable.

## Intended first-run journey

1. **Email first** — enter email, receive a sign-in link, return to the same device. Google sign-in remains an alternative. Avoid asking for password and business details before the owner has seen value.
2. **One short business setup** — ask business name (prefill if available), business type, main goal, currency/currencies, and where customer/payment records currently live. Explain why each answer matters. Make optional fields skippable.
3. **Connect what already exists** — show only relevant choices: Google Sheets, invoice/payment CSV, and lead/enquiry records. Mark each as “Connect”, “Import a sample”, or “Do this later”. Do not imply a source is connected until a real successful sync/import is confirmed.
4. **Check the data** — preview detected records, currencies, date range, skipped rows, duplicates, and missing fields. Let the owner confirm before using imported data for recommendations. Never silently coerce money/date values.
5. **Prepare the business view** — show a clear first-sync state, then calculate overdue balances, upcoming follow-ups, and stalled enquiries from persisted records. Explain each recommendation with its source evidence and show when the data was last updated.
6. **First useful action** — present one high-value, human-approved action (e.g. draft a reminder for a verified overdue invoice). Never send messages automatically. Record approval, manual execution, and observed outcomes separately; do not claim an observed payment was caused by the action.
7. **Return to the watchman** — dashboard answers: “What needs attention?”, “Why?”, “What should I do next?”, and “What changed after I acted?” Keep setup checklist available but out of the way once the business is working.

## Onboarding principles

- Default to the shortest path; one decision per screen, visible progress, sensible defaults, plain language.
- Ask only for information that changes the recommendations. Allow “I’ll do this later”.
- Distinguish **not connected**, **connected but not synced**, **sync failed**, and **successfully synced**.
- Do not use fake metrics or sample data as if they were the customer’s real business. Label demos clearly.
- Support mixed currencies; never sum unlike currencies into one total.
- Make workspace boundaries and data permissions explicit; keep source records tenant-scoped.
- Design for mobile-first use, accessible labels, keyboard/focus states, readable text, and light/dark contrast.
- Avoid autonomous sending, bank/payment actions, and complex agent setup in the MVP.

## MVP completion gate

A new owner can sign in by email, create/confirm a workspace with minimal friction, connect or import one real source, inspect the import result, see persisted and workspace-scoped records, receive a grounded overdue/follow-up recommendation, approve and manually execute an action, and record an outcome. Refreshing or signing out/in must not lose the data. The production deployment must be verified separately from CI.

## Current implementation note

This branch introduces passwordless email-link sign-in for the existing Supabase Auth flow and removes the workspace-name/password requirement from the sign-in path. It does not yet claim the complete guided onboarding journey is implemented. The next build slice is a persistent business profile/setup checklist, followed by a real import-review step and a first-run “needs attention” state. Claude should refine the visual design and component hierarchy after the functional flow and state transitions are agreed; preserve the current data-integrity and approval boundaries.
