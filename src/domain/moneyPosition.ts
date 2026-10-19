import { addMoney, money } from './money.ts'
import type { PaymentRecord } from './promises.ts'
import type { InvoiceEvidence, Money, RevenueOpportunity } from './types.ts'

/**
 * Where the money stands, per currency. Every figure has a different meaning and they are never merged:
 *  - outstanding: unpaid balance according to the last imported invoice records (a fact from your data)
 *  - overdue: the part of that balance that is past due and tracked as an open issue
 *  - dismissedUnpaid: balances on dismissed issues. Out of the queue, still unpaid.
 *  - estimated: outstanding x your recovery-rate assumption. An assumption, not a prediction or payment.
 *  - promised: what customers SAID they would pay. Not money received.
 *  - paymentEvidence: imported payment records (money actually recorded as received)
 *  - verified: payment evidence matched to a manually sent reminder. Observed after, not proven caused by.
 */
export type MoneyPosition = {
  currency: string
  outstanding: Money
  overdue: Money
  dismissedUnpaid: Money
  estimated: Money
  promised: Money
  paymentEvidence: Money
  verified: Money
}

type Totals = Record<keyof Omit<MoneyPosition, 'currency'>, Money>

export function buildMoneyPosition(input: {
  invoices: InvoiceEvidence[]
  opportunities: RevenueOpportunity[]
  dismissed: RevenueOpportunity[]
  payments: PaymentRecord[]
  verified: Money[]
}): MoneyPosition[] {
  const byCurrency = new Map<string, Totals>()
  const slot = (currency: string): Totals => {
    let totals = byCurrency.get(currency)
    if (!totals) {
      const zero = money(0, currency)
      totals = { outstanding: zero, overdue: zero, dismissedUnpaid: zero, estimated: zero, promised: zero, paymentEvidence: zero, verified: zero }
      byCurrency.set(currency, totals)
    }
    return totals
  }
  const add = (currency: string, key: keyof Totals, amount: Money) => { const totals = slot(currency); totals[key] = addMoney(totals[key], amount) }

  for (const invoice of input.invoices) {
    const unpaid = invoice.total.amount - invoice.paid.amount
    if (unpaid > 0) add(invoice.currency, 'outstanding', money(unpaid, invoice.currency))
  }
  for (const opportunity of input.opportunities) {
    add(opportunity.outstanding.currency, 'overdue', opportunity.outstanding)
    add(opportunity.estimate.low.currency, 'estimated', opportunity.estimate.low)
    if (opportunity.workflow?.promisedAmount) add(opportunity.workflow.promisedAmount.currency, 'promised', opportunity.workflow.promisedAmount)
  }
  for (const opportunity of input.dismissed) add(opportunity.outstanding.currency, 'dismissedUnpaid', opportunity.outstanding)
  for (const payment of input.payments) add(payment.amount.currency, 'paymentEvidence', payment.amount)
  for (const amount of input.verified) add(amount.currency, 'verified', amount)

  return [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, totals]) => ({ currency, ...totals }))
}
