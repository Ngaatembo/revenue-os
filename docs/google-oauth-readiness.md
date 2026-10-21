# Google OAuth readiness: evidence, status and open items

Prepared 2026-10-21 from the repository itself (not from marketing copy or research notes). Pages: `/privacy` (`privacy.html`) and `/terms` (`terms.html`).
**These are implementation drafts. They do not mean Google verification has passed, and they are not legal advice.**

## 1. Evidence checklist (finding → where it lives)

| # | Finding | Evidence |
|---|---|---|
| 1 | Gmail scope requested: **`gmail.readonly`** + `openid` + `email`. No `gmail.metadata`, no send/modify/compose. | `src/worker/googleSheetsHandlers.ts` lines 11–12 (`GMAIL_SCOPE`, `GMAIL_SCOPES`) |
| 2 | Sheets/Drive scopes: `spreadsheets.readonly`, `drive.metadata.readonly`, `openid`, `email`. Read-only. | same file, line 10 (`SCOPES`) |
| 3 | OAuth request: `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`. | `googleSheetsHandlers.ts` lines 123–130 |
| 4 | Gmail endpoints used: `users/me/profile`, `messages` (list with `q`, `maxResults`), `messages/{id}?format=metadata` with `metadataHeaders` From, To, Subject, List-Unsubscribe, Precedence, Auto-Submitted, `history` (`messageAdded`). Never `format=full/raw`. | `src/worker/connections/gmail.ts` (`gmailGet`, `fetchMetadata`, `syncGmail`) |
| 5 | Fields read per message: id, threadId, labelIds, snippet, internalDate, the six headers. **No bodies, no attachments requested.** | `gmail.ts` `GmailMessage` type + `parseGmailMessage` |
| 6 | Stored per message: counterpart address/name, subject ≤300, snippet ≤200, time, direction, automated flag, ids, mailbox address. Header values are used for the flag only, not stored. | `supabase/migrations/20261021150000_connections_sync_and_communications.sql` (`communications`) |
| 7 | **Access vs storage:** `gmail.readonly` would technically allow reading whole messages; the code requests only metadata. The policy says so and never claims metadata-only access. | `privacy.html` §3; test `never claims metadata-only access…` |
| 8 | Sheets/Drive: lists spreadsheets (id, name, mimeType, modifiedTime, webViewLink), reads title/tab names/grid size and the selected tab's values. Stores selection + imported invoice rows + content hash. No writes. | `googleSheetsHandlers.ts` lines ~221–329; `provider_source_selections`; `persist_invoice_import_system` |
| 9 | No sending, modifying or deleting through Google APIs. | no write calls in `src/worker` (only `oauth2.googleapis.com/revoke`) |
| 10 | Refresh tokens: AES-256-GCM, key in a Worker secret (`GOOGLE_TOKEN_ENCRYPTION_KEY`), table has no client grants and FORCE RLS. Access tokens not persisted. | `src/worker/googleSheetsCrypto.ts`; `20261018054702_provider_connections_server_only.sql` (REVOKE ALL … FROM PUBLIC, anon, authenticated) |
| 11 | OAuth `state` stored hashed, expires in 10 minutes. | `googleSheetsHandlers.ts` line 116; `consume_provider_oauth_state` |
| 12 | Revocation by Google (`invalid_grant`): token cleared, status needs reconnect, synced data kept. | `src/worker/connections/runner.ts` ~line 170 |
| 13 | Workspace isolation: member-only RLS on `communications`, `conversation_tracking`, `muted_senders`; roles enforced (owner/admin connect+disconnect; owner/admin/operator tracking). | migrations `…150000`, `…180000`; handlers `membership()` checks |
| 14 | Hosting/processors: Cloudflare Worker (assets + cron), Supabase project `zivgfvcmposnbwqsudas`, region **eu-west-1** (verified via the Supabase API on 2026-10-21). No analytics/ads scripts: the only script in `index.html` is the app. Worker logs one counts-only line per cron run. | `wrangler.jsonc`; `index.html`; `src/worker/index.ts` line 54 |
| 15 | Sign-in methods: email+password, email link, "Continue with Google" through Supabase Auth (no extra scopes set in code). | `src/AuthApp.tsx`, `src/lib/supabaseRest.ts` |
| 16 | **Retention: none enforced.** No scheduled deletion job exists (only `revenue-os-daily-evaluation`). Synced mail accumulates while connected. | migrations (`cron.schedule` grep); test `does not promise a scheduled deletion job…` |
| 17 | **Account deletion / data export: not implemented in the product.** Workspace deletion cascades (`ON DELETE CASCADE` from `organizations`) but only the operator can do it. | grep across `src` and migrations: no such feature |
| 18 | No pre-existing privacy/terms pages and no verified operator contact existed in the repo. | repository search |

## 2. Gaps found, and what was changed so the policy can be true

| Gap | Resolution |
|---|---|
| Ongoing Gmail sync fetched Promotions/Social/Forums/Spam/Trash messages (only the first sync filtered them) | **Fixed in code:** `parseGmailMessage` now skips `SPAM`, `TRASH`, `CATEGORY_PROMOTIONS/SOCIAL/FORUMS` (`EXCLUDED_LABELS`), matching the first sync. Test added. |
| Google Sheets "Disconnect" removed the token locally but did **not** revoke at Google (legacy route) | **Fixed in code:** the screen now uses `/api/connections/disconnect`, which revokes at Google. E2E asserts a revoke call. |
| Disconnecting Gmail kept all synced mail with no way to delete it | **Added:** "Disconnect and delete synced email data" (owner/admin). Deletes `communications`, Gmail `conversation_tracking` and `muted_senders` for the workspace, resets counters, revokes the token. Only offered for Gmail; imported invoices are never touched. E2E asserts deletion, isolation from other workspaces and invoices. |
| No automatic retention limit | **Unresolved (owner decision).** Policy states plainly that there is none. |
| No self-service account/workspace deletion or export | **Unresolved.** Policy says requests are handled manually and gives no response-time promise. |
| Invoices imported from Sheets cannot be deleted by the user | **Unresolved.** Policy says they stay until the workspace is deleted. |

## 3. Scope assessment: could `gmail.readonly` be narrowed?

- Google's `users.messages.list` reference (fetched 2026-10-21) states the `q` parameter "cannot be used when accessing the api using the gmail.metadata scope". The first sync depends on `q` (`newer_than:90d` and category exclusions), so **switching to `gmail.metadata` would break it as written**. It would need a different backfill (page by label, filter by date client-side), costing more calls and re-engineering the exclusions.
- Whether `snippet` is returned under `gmail.metadata` is **not stated** in the reference pages read; unverified.
- Per the earlier research notes (to be re-verified in Google's scope table), `gmail.metadata` is also a *restricted* scope, so narrowing would **not** remove the need for the restricted-scope security assessment. The benefit would be a narrower consent description, not an easier review.
- **Decision: scopes were not changed.** Re-assess only with a tested backfill design and a test mailbox.
- Separate point to check: confirm in Google's scope table whether `drive.metadata.readonly` is classified restricted. If it is, it also triggers the assessment. A narrower alternative is a per-file picker with `drive.file`, which is a product change, not done here.

## 4. Google verification checklist

**Done in code (this change)**
- Public `/privacy` and `/terms` pages (static HTML, no sign-in, no JavaScript), own title/description/canonical/indexing, mobile-checked.
- Links from the homepage (sign-in screen), the signed-in footer, and the Google connection screen, plus the verbatim Limited Use statement at the point of connection.
- Policy tied to the code by tests (`src/legal/__tests__`): scopes, headers, field limits, labels, token protection, no-scheduled-deletion, disconnect/deletion behaviour, no invented contact, no certification claims.
- Bundle secret scan (`npm run check:bundle`, also in CI).
- `npm run check:legal` lists every unresolved item (currently exits 1 by design).

**Owner-only (needs your accounts or decisions)**
1. Provide operator details in `legal/operator.json` (legal name, contact email, postal address). Never guessed.
2. **Own a custom domain.** A `workers.dev` address cannot be verified in Google Search Console. Then: set `siteUrl`, Cloudflare `APP_ORIGIN`, the OAuth redirect URI, and Supabase Auth redirect URLs.
3. Verify the domain in Google Search Console; add it as an authorized domain.
4. Configure the OAuth consent screen: app name, logo, support email, developer contact, homepage URL, privacy and terms URLs, authorized domains.
5. Keep the app in **Testing**. **Do not click "Publish app" unverified** and do not add test users without deciding the pilot list (100-user cap; refresh tokens expire every 7 days in Testing).
6. Scope justification text and an unlisted **demo video** (English) showing the consent flow, each scope's use, and the in-app disclosure. Outline below.
7. Choose and pay an authorized **security assessor** (annual CASA / Letter of Validation).
8. Confirm in Supabase what "Continue with Google" requests, and which service sends sign-in emails (policy wording is generic until confirmed).

**Professional services**
- Lawyer: the items in section 5.
- Assessor: the restricted-scope security assessment.

### Draft scope justification (edit before use)
- `gmail.readonly`: "Revenue OS shows a business owner which customers wrote to them and have not had a reply. It reads message headers (From, To, Subject), the date and Gmail's short preview for the last 90 days and new messages, and stores the other party's address and name, the subject, up to 200 characters of preview and dates. It does not request message bodies or attachments, and never sends, changes or deletes email. A narrower scope cannot be used because the first sync relies on Gmail search (`q`), which `gmail.metadata` does not allow."
- `spreadsheets.readonly` + `drive.metadata.readonly`: "To let the owner pick their invoice spreadsheet by name and read its invoice rows so overdue invoices are found automatically. No edits."
### Demo video outline
Sign-in screen with privacy/terms links → Connections page with the disclosure → click Connect Gmail → Google consent screen showing the requested permission → return to the app, first-sync progress → Overview showing waiting-for-reply customers → disconnect with both choices (keep / delete) → show the Privacy Policy sections 3 and 9.

## 5. Legal review checklist (unresolved, deliberately not invented)
- Operator identity, postal address, privacy/security contact (pages show visible "owner to provide" markers).
- Governing law, dispute process, liability cap and consumer-law carve-outs (Terms §11–12 marked "lawyer to decide").
- Controller/processor roles, DPA and sub-processor list for customers' customers' data; EU/UK representative question; Zimbabwe data-protection registration and transfer rules; other jurisdictions where customers are.
- Retention periods (none enforced today) and deletion promises; response times for access/deletion requests; backups (not described, not verified).
- Commitments written into the draft that need sign-off: breach notice "without undue delay", notice of material changes, "no human reads Google data except…", Limited Use wording, "not directed at children".
- Age/eligibility wording; whether to require acceptance of the Terms at sign-up (not implemented).
- Billing, trial, cancellation and refund terms (nothing is billed today; Terms say so).
- The effective date (draft) and a version history.

## 6. Verified facts vs assumptions
Verified from code/config: items 1–18 above, the Supabase region, the Google reference statement on `q`. Assumptions or unverified: Google's consent-screen wording for `gmail.readonly`; restricted/sensitive classification of each scope; CASA cost and timeline; what Supabase's Google sign-in requests; the sign-in email sender; whether `snippet` is returned under `gmail.metadata`.
