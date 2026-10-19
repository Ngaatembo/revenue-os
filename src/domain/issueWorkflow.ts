import { addMoney, formatMoney } from './money.ts'
import type { Money, RevenueOpportunity } from './types.ts'

/**
 * Where an OPEN overdue-invoice issue stands in the conversation with the customer.
 * This is separate from the lifecycle status (open / dismissed / closed).
 */
export type WorkflowState = 'new' | 'acknowledged' | 'awaiting_response' | 'in_conversation' | 'promised' | 'disputed' | 'payment_claimed'

export type OpportunityWorkflow = {
  state: WorkflowState
  snoozedUntil: string | null
  /** Date only, YYYY-MM-DD. */
  nextFollowUp: string | null
  /** A promise is a statement by the customer. It is never money received. */
  promisedAmount: Money | null
  promisedDate: string | null
  dismissedReason: string | null
}

export const DEFAULT_WORKFLOW: OpportunityWorkflow = {
  state: 'new', snoozedUntil: null, nextFollowUp: null, promisedAmount: null, promisedDate: null, dismissedReason: null,
}

export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  awaiting_response: 'Awaiting customer response',
  in_conversation: 'In conversation',
  promised: 'Payment promised',
  disputed: 'Disputed',
  payment_claimed: 'Customer says paid',
}

export type AttentionCode = 'broken_promise' | 'disputed' | 'payment_claimed' | 'follow_up_due' | 'severely_overdue'
export type AttentionReason = { code: AttentionCode; label: string; rank: number }

/** Today's date as YYYY-MM-DD in UTC, matching the database's CURRENT_DATE. */
export function dateOnly(asOf: string): string {
  const time = Date.parse(asOf)
  if (!Number.isFinite(time)) throw new Error('Dates must be valid ISO timestamps.')
  return new Date(time).toISOString().slice(0, 10)
}

export function isSnoozed(workflow: OpportunityWorkflow | undefined, asOf: string): boolean {
  if (!workflow?.snoozedUntil) return false
  const until = Date.parse(workflow.snoozedUntil)
  return Number.isFinite(until) && until > Date.parse(asOf)
}

/**
 * The transparent rules that put an issue in the Urgent queue. Each reason carries the plain-language
 * explanation shown to the owner. A snoozed issue is still returned here; callers decide whether to hide it,
 * because snoozing hides an alert for a while and never hides the unpaid balance.
 */
export function attentionReasons(opportunity: RevenueOpportunity, daysPastDue: number, asOf: string): AttentionReason[] {
  const workflow = opportunity.workflow
  const today = dateOnly(asOf)
  const reasons: AttentionReason[] = []
  if (workflow?.promisedAmount && workflow.promisedDate && workflow.promisedDate < today) {
    reasons.push({
      code: 'broken_promise', rank: 5,
      label: `The customer promised ${formatMoney(workflow.promisedAmount)} by ${workflow.promisedDate}. That date has passed and the invoice is still unpaid in your records.`,
    })
  }
  if (workflow?.state === 'disputed') {
    reasons.push({ code: 'disputed', rank: 4, label: 'The customer disputes this invoice. It needs a decision before more reminders are sent.' })
  }
  if (workflow?.state === 'payment_claimed') {
    reasons.push({ code: 'payment_claimed', rank: 4, label: 'The customer says they have paid, but no matching payment is recorded yet. Check your bank or import the payment.' })
  }
  if (workflow?.nextFollowUp && workflow.nextFollowUp <= today && workflow.state !== 'new' && !reasons.some((reason) => reason.code === 'broken_promise')) {
    reasons.push({ code: 'follow_up_due', rank: 3, label: `A follow-up was planned for ${workflow.nextFollowUp} and has not been recorded.` })
  }
  if (daysPastDue > 30) {
    reasons.push({ code: 'severely_overdue', rank: daysPastDue > 60 ? 4 : 3, label: `The invoice is ${daysPastDue} days past due.` })
  }
  return reasons
}

/** What the owner should do next, given where the conversation stands. Returns null when there is nothing workflow-specific to say. */
export function nextActionForWorkflow(workflow: OpportunityWorkflow | undefined, asOf: string): string | null {
  if (!workflow) return null
  const today = dateOnly(asOf)
  if (workflow.promisedAmount && workflow.promisedDate) {
    if (workflow.promisedDate < today) return 'The promised date has passed. Contact the customer, then record their response.'
    return `Wait for the promised payment (due ${workflow.promisedDate}); import payment evidence when it arrives.`
  }
  switch (workflow.state) {
    case 'disputed': return 'Resolve the dispute with the customer, then record the outcome or dismiss the issue with a reason.'
    case 'payment_claimed': return 'Confirm the payment in your bank records, then import it as payment evidence.'
    case 'awaiting_response': return workflow.nextFollowUp && workflow.nextFollowUp <= today
      ? 'The customer has not replied. Follow up again and record what happens.'
      : `Wait for a reply. Follow up on ${workflow.nextFollowUp ?? 'the planned date'}.`
    case 'in_conversation': return 'Keep the conversation going and record any promise to pay.'
    default: return null
  }
}

export function summarizeWorkflow(opportunities: RevenueOpportunity[], asOf: string): {
  followUpsDue: number
  brokenPromises: number
  disputes: number
  promisesOutstanding: Money[]
  snoozed: number
} {
  const today = dateOnly(asOf)
  let followUpsDue = 0, brokenPromises = 0, disputes = 0, snoozed = 0
  const promised = new Map<string, Money>()
  for (const opportunity of opportunities) {
    const workflow = opportunity.workflow
    if (!workflow) continue
    if (isSnoozed(workflow, asOf)) snoozed += 1
    if (workflow.state === 'disputed') disputes += 1
    if (workflow.nextFollowUp && workflow.nextFollowUp <= today && workflow.state !== 'new') followUpsDue += 1
    if (workflow.promisedAmount && workflow.promisedDate) {
      if (workflow.promisedDate < today) brokenPromises += 1
      const current = promised.get(workflow.promisedAmount.currency)
      promised.set(workflow.promisedAmount.currency, current ? addMoney(current, workflow.promisedAmount) : workflow.promisedAmount)
    }
  }
  return { followUpsDue, brokenPromises, disputes, promisesOutstanding: [...promised.values()], snoozed }
}

