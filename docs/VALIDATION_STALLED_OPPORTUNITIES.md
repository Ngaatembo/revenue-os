# Revenue OS — 7-Day Stalled Opportunity Validation

**Status:** Working experiment · v0.1 · 13 October 2026  
**Owner:** Founder  
**Purpose:** Test whether identifying missed next steps on real prospects or quotations helps recover momentum before building a new UI, database, or integration.

## Hypothesis

Owner-operated service businesses lose opportunities when a promised follow-up or next step is forgotten across messages, calls, and memory. A useful detector should identify a specific missed commitment, explain its evidence, and recommend one reasonable next action.

This is a hypothesis, not a proven market fact.

## Scope and safeguards

- Test with 5–10 current or recently active WebAura prospects/quotations for seven days.
- Use only information needed for the test. Prefer aliases or internal IDs; do not copy private message contents, phone numbers, passwords, payment credentials, or unrelated personal data into the repository.
- Keep records in a private local working file or a secure location, not a public Git commit.
- Continue normal follow-up. Do not delay a useful follow-up to create a control group.
- Do not send messages automatically. The founder reviews and sends any follow-up.
- A quotation is not cash. Record deposits or payments only when supported by evidence.
- Do not claim that an alert caused a reply or payment simply because it happened afterwards.

## Minimum record fields

For each opportunity, record:

- opportunity_id: an alias such as P-01, not a customer's personal identifier.
- business_type: optional coarse category.
- offer_or_quote: short label, no sensitive details.
- stage: new enquiry, discovery, quote sent, awaiting decision, deposit pending, won, lost, or other.
- last_contact_date: ISO date (YYYY-MM-DD) if known.
- last_contact_channel: call, WhatsApp, email, meeting, or other.
- promised_next_step: specific agreed action; blank if none is known.
- next_step_due_date: ISO date if explicitly agreed or reliably recorded; blank if unknown.
- known_value_amount and currency: only when grounded in a quote or other evidence; otherwise blank.
- evidence_note: short factual source reference, not a copied conversation.
- owner: person responsible for the next step.
- alert_result: useful, not useful, or needs review.
- action_taken and action_date.
- outcome and outcome_evidence: reply, meeting, revised quote, decision, deposit/payment, no change, or unknown.
- time_spent_minutes: approximate manual effort.

## Alert rules for the manual test

1. **Overdue promised step:** Flag when a specific next step and due date are known, the date has passed, the opportunity is not marked won/lost, and there is no evidence the step was completed.
2. **Needs review:** Use when the stage, due date, next step, or latest progress is unknown or contradictory. Do not guess a deadline.
3. **No confirmed next step:** Do not label silence alone as a stalled opportunity. It may be a candidate for human review only if the normal sales process says a follow-up is appropriate.
4. **Resolved:** Do not keep flagging an item when evidence shows the next step was completed or the opportunity was closed.
5. **Priority:** First consider due date and explicit business value; do not invent a probability of winning or a guaranteed recovery amount.

Every alert should show: **what is flagged, why, evidence, suggested next action, and what is unknown**.

## Daily procedure (10–15 minutes)

1. Review the 5–10 records and update only facts supported by evidence.
2. Apply the rules above manually.
3. Count alerts and classify each as useful, not useful, or needs review.
4. Choose at most the next sensible action for each useful alert.
5. Follow up through the normal channel after human review.
6. Record the outcome and time spent. An unanswered message is an outcome, not a failure of the experiment by itself.

## Seven-day schedule

- **Day 0:** Select records, create aliases, capture known facts, and note the current state.
- **Days 1–6:** Review once daily, apply rules, act on useful alerts, and log results.
- **Day 7:** Review alert quality, actions, outcomes, manual effort, and whether a business would pay for this workflow.

## Measures

Report counts and examples, not invented percentages from a tiny sample:

- Number of opportunities reviewed.
- Number of overdue promised steps found.
- Number of useful, not useful, and needs-review alerts.
- Number of actions taken.
- Replies, meetings, decisions, revised quotes, and deposits/payments observed.
- Time required to gather/update records and review alerts.
- Number of facts that were missing or too uncertain to alert safely.
- Whether the user would use the workflow again and what they would pay for a pilot.

Keep **estimated value**, **quoted value**, **deposit received**, and **payment received** separate. A later payment is an observed outcome; it is not proof of causation.

## Decision gate

Proceed to a small software vertical slice only if the test reveals a recurring problem and the alerts are actionable with acceptable false-positive and review effort. A practical initial signal is at least three genuinely useful stalled-opportunity findings that the founder acts on during the test; this is a learning threshold, not statistical proof or a market-wide success claim.

If too many records lack reliable next-step dates, test a simpler capture workflow before automating detection. If alerts are mostly noise or users will not act on them, revise or reject this wedge and compare it with overdue-invoice recovery.

## End-of-test summary

- Records reviewed:
- Useful alerts:
- Not useful alerts:
- Needs-review alerts:
- Actions taken:
- Replies / meetings / decisions:
- Deposits or payments observed (with evidence):
- Minutes spent:
- Main missing data:
- Would use again? Why?
- Would pay for a pilot? Amount and conditions:
- Decision: continue / revise / reject / compare with invoice recovery
