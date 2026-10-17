import { addMoney, money } from './money.ts'
import type { PaymentEvidence, RevenueAction, RevenueAttribution, RevenueOpportunity } from './types.ts'

export function verifyPaymentOutcome(input: {
  action: RevenueAction
  opportunity: RevenueOpportunity
  payments: PaymentEvidence[]
  windowDays: number
}): RevenueAttribution | null {
  const { action, opportunity, payments, windowDays } = input
  if (action.status !== 'executed' || !action.executedAt) {
    throw new Error('Revenue can only be attributed after an action was executed.')
  }
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365) {
    throw new Error('Measurement window must be from 1 to 365 days.')
  }

  const start = Date.parse(action.executedAt)
  if (!Number.isFinite(start)) throw new Error('Action execution time must be valid.')
  const end = start + windowDays * 24 * 60 * 60 * 1000
  const invoices = new Map(opportunity.evidence.map((invoice) => [invoice.id, invoice]))
  const matched = payments.filter((payment) => {
    const invoice = invoices.get(payment.invoiceId)
    const paidAt = Date.parse(payment.receivedAt)
    return Boolean(
      invoice &&
      Number.isFinite(paidAt) &&
      paidAt >= start &&
      paidAt <= end &&
      payment.amount.amount > 0 &&
      payment.amount.currency === opportunity.outstanding.currency &&
      payment.amount.currency === invoice.total.currency,
    )
  })

  if (matched.length === 0) return null
  const amount = matched.reduce(
    (total, payment) => addMoney(total, payment.amount),
    money(0, opportunity.outstanding.currency),
  )
  if (amount.amount > opportunity.outstanding.amount) {
    throw new Error('Matched payments exceed the outstanding invoice balance; review is required.')
  }

  return {
    id: `verified:${action.id}:${matched.map((payment) => payment.id).sort().join(',')}`,
    actionId: action.id,
    opportunityId: opportunity.id,
    paymentEvidence: matched,
    amount,
    state: 'verified',
    method: 'matched_payment_record',
    measurementWindow: {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
    },
    causalClaim: 'observed_after_action_not_proven_causal',
  }
}
