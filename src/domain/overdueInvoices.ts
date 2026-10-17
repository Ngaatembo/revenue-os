import { addMoney, money, multiplyByBps, subtractMoney } from './money.ts'
import type { InvoiceEvidence, OpportunityInput, RevenueOpportunity } from './types.ts'

function isoTime(value: string, field: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid date.`)
  return timestamp
}

function outstandingFor(invoice: InvoiceEvidence) {
  if (invoice.total.currency !== invoice.paid.currency) {
    throw new Error(`Invoice ${invoice.id} has inconsistent currencies.`)
  }
  if (invoice.total.amount < 0 || invoice.paid.amount < 0 || invoice.paid.amount > invoice.total.amount) {
    throw new Error(`Invoice ${invoice.id} has invalid total or paid amount.`)
  }
  return subtractMoney(invoice.total, invoice.paid)
}

export function buildOverdueOpportunities(input: OpportunityInput): RevenueOpportunity[] {
  const asOf = isoTime(input.asOf, 'asOf')
  const minDays = input.minDaysOverdue ?? 1
  if (!Number.isSafeInteger(minDays) || minDays < 0) {
    throw new Error('minDaysOverdue must be a non-negative integer.')
  }
  const bps = input.assumption.valueBps
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('Recovery-rate assumption must be between 0 and 10,000 basis points.')
  }

  return input.invoices.flatMap((invoice) => {
    const outstanding = outstandingFor(invoice)
    const dueAt = isoTime(invoice.dueAt, `invoice ${invoice.id} dueAt`)
    const overdueMs = asOf - dueAt
    if (outstanding.amount <= 0 || overdueMs < minDays * 24 * 60 * 60 * 1000) return []

    const estimate = multiplyByBps(outstanding, bps)
    return [{
      id: `overdue_invoice:${invoice.id}`,
      kind: 'overdue_invoice',
      status: 'open',
      evidence: [invoice],
      outstanding,
      estimate: {
        low: estimate,
        high: estimate,
        assumptionId: input.assumption.id,
        formula: 'outstanding_times_recovery_rate',
      },
      detectedAt: new Date(asOf).toISOString(),
    }]
  })
}

export function sumOpportunityEstimates(opportunities: RevenueOpportunity[]) {
  if (opportunities.length === 0) return null
  const currency = opportunities[0].estimate.low.currency
  return opportunities.reduce(
    (total, opportunity) => addMoney(total, opportunity.estimate.low),
    money(0, currency),
  )
}
