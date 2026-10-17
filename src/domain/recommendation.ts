import { formatMoney } from './money.ts'
import type { ActionProgress, RankedOpportunity } from './prioritization.ts'

export type RecommendationEvidence = { label: string; value: string }

/** An evidence-backed next step. It is advice for a person: nothing here sends or changes anything. */
export type Recommendation = {
  opportunityId: string
  summary: string
  steps: string[]
  evidence: RecommendationEvidence[]
  /** The saved record every claim above is derived from. */
  sourceRecord: string
  requiresHumanApproval: true
  sendsAutomatically: false
  /** Estimates are assumptions, not money collected. */
  estimateIsNotRevenue: true
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** Returns every reason a recommendation is not safe to show. An empty list means it is valid. */
export function validateRecommendation(recommendation: Recommendation): string[] {
  const problems: string[] = []
  if (!recommendation.sourceRecord.trim()) problems.push('A recommendation must name its source record.')
  if (recommendation.evidence.length === 0) problems.push('A recommendation must list the evidence it is based on.')
  if (recommendation.evidence.some((item) => !item.label.trim() || !item.value.trim())) problems.push('Evidence items must have a label and a value.')
  if (recommendation.steps.length === 0) problems.push('A recommendation must contain at least one step.')
  if (recommendation.requiresHumanApproval !== true) problems.push('Human approval is required before any external action.')
  if (recommendation.sendsAutomatically !== false) problems.push('Recommendations must never send messages automatically.')
  if (recommendation.estimateIsNotRevenue !== true) problems.push('Estimates must be labelled as not revenue.')
  const text = [recommendation.summary, ...recommendation.steps, ...recommendation.evidence.flatMap((item) => [item.label, item.value])]
  if (text.some((value) => CONTROL_CHARACTERS.test(value))) problems.push('Recommendation text contains control characters.')
  return problems
}

function stepsFor(progress: ActionProgress): string[] {
  if (progress === 'proposed') return ['Open Actions and read the saved reminder draft.', 'Approve it only if the wording and amount are right.']
  if (progress === 'approved') return ['Copy the approved draft and send it yourself through your normal channel.', 'Then record that you sent it, so payment evidence can be checked later.']
  if (progress === 'executed') return ['Import a payment export that covers the period since you sent the reminder.', 'Run the payment check; revenue is verified only when payment records match.']
  return ['Draft a polite reminder for this invoice and review it.', 'Approve the draft, then send it yourself. Revenue OS sends nothing on its own.']
}

/** Builds a recommendation purely from a ranked opportunity's saved invoice evidence. Throws if it cannot be justified. */
export function buildRecommendation(ranked: RankedOpportunity, progress: ActionProgress): Recommendation {
  const { opportunity } = ranked
  const invoice = opportunity.evidence[0]
  if (!invoice) throw new Error('Cannot recommend an action for an opportunity with no source invoice.')
  const recommendation: Recommendation = {
    opportunityId: opportunity.id,
    summary: `${invoice.customerName} owes ${formatMoney(opportunity.outstanding)} on invoice ${invoice.invoiceNumber}, ${ranked.daysOverdue} day${ranked.daysOverdue === 1 ? '' : 's'} past due.`,
    steps: stepsFor(progress),
    evidence: [
      { label: 'Invoice', value: invoice.invoiceNumber },
      { label: 'Due date', value: invoice.dueAt.slice(0, 10) },
      { label: 'Total / paid', value: `${formatMoney(invoice.total)} / ${formatMoney(invoice.paid)}` },
      { label: 'Outstanding', value: formatMoney(opportunity.outstanding) },
    ],
    sourceRecord: `${invoice.source.sourceId} · ${invoice.source.recordId}`,
    requiresHumanApproval: true,
    sendsAutomatically: false,
    estimateIsNotRevenue: true,
  }
  const problems = validateRecommendation(recommendation)
  if (problems.length) throw new Error(problems.join(' '))
  return recommendation
}
