import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_WORKFLOW } from '../issueWorkflow.ts'
import { money } from '../money.ts'
import { buildMoneyPosition } from '../moneyPosition.ts'
import type { InvoiceEvidence, RevenueOpportunity } from '../types.ts'

const inv = (id: string, total: number, paid: number, currency = 'USD'): InvoiceEvidence => ({
  id, customerId: 'c', customerName: 'C', invoiceNumber: id, currency: currency as never, total: money(total, currency), paid: money(paid, currency),
  issuedAt: '2026-01-01T00:00:00.000Z', dueAt: '2026-02-01T00:00:00.000Z', source: { sourceId: 's', recordId: id, importedAt: '2026-10-01T00:00:00.000Z' },
})
const opp = (id: string, outstanding: number, est: number, promised?: number, currency = 'USD', status: 'open' | 'dismissed' = 'open'): RevenueOpportunity => ({
  id: 'overdue_invoice:' + id, kind: 'overdue_invoice', status, evidence: [inv(id, outstanding, 0, currency)], outstanding: money(outstanding, currency),
  estimate: { low: money(est, currency), high: money(est, currency), assumptionId: 'r', formula: 'outstanding_times_recovery_rate' }, detectedAt: '2026-10-01T00:00:00.000Z',
  workflow: { ...DEFAULT_WORKFLOW, promisedAmount: promised ? money(promised, currency) : null, promisedDate: promised ? '2026-10-30' : null },
})

test('promised money is reported separately and never added to payment evidence or verified revenue', () => {
  const [usd] = buildMoneyPosition({
    invoices: [inv('a', 100_000, 0), inv('b', 50_000, 20_000), inv('c', 10_000, 10_000)],
    opportunities: [opp('a', 100_000, 30_000, 40_000), opp('b', 30_000, 9_000)],
    dismissed: [],
    payments: [{ invoiceId: 'b', amount: money(5_000, 'USD'), receivedAt: '2026-10-10T00:00:00.000Z' }],
    verified: [],
  })
  assert.equal(usd.outstanding.amount, 130_000)
  assert.equal(usd.overdue.amount, 130_000)
  assert.equal(usd.estimated.amount, 39_000)
  assert.equal(usd.promised.amount, 40_000)
  assert.equal(usd.paymentEvidence.amount, 5_000)
  assert.equal(usd.verified.amount, 0)
})

test('dismissed issues stay visible as unpaid money and are not counted as overdue-in-queue', () => {
  const [usd] = buildMoneyPosition({
    invoices: [inv('a', 100_000, 0), inv('d', 25_000, 0)],
    opportunities: [opp('a', 100_000, 30_000)],
    dismissed: [opp('d', 25_000, 7_500, undefined, 'USD', 'dismissed')],
    payments: [], verified: [],
  })
  assert.equal(usd.outstanding.amount, 125_000, 'dismissal never reduces the unpaid balance')
  assert.equal(usd.overdue.amount, 100_000)
  assert.equal(usd.dismissedUnpaid.amount, 25_000)
  assert.equal(usd.estimated.amount, 30_000, 'dismissed issues contribute no estimate')
})

test('currencies are never combined', () => {
  const rows = buildMoneyPosition({
    invoices: [inv('a', 100_000, 0), inv('e', 70_000, 0, 'EUR')],
    opportunities: [opp('a', 100_000, 30_000), opp('e', 70_000, 21_000, 20_000, 'EUR')],
    dismissed: [], payments: [{ invoiceId: 'e', amount: money(1_000, 'EUR'), receivedAt: '2026-10-10T00:00:00.000Z' }],
    verified: [money(1_000, 'EUR')],
  })
  assert.deepEqual(rows.map((r) => r.currency), ['EUR', 'USD'])
  assert.equal(rows[0].promised.amount, 20_000)
  assert.equal(rows[0].verified.amount, 1_000)
  assert.equal(rows[1].promised.amount, 0)
  assert.equal(rows[1].verified.amount, 0)
})

test('an empty workspace has no money position and fabricates nothing', () => {
  assert.deepEqual(buildMoneyPosition({ invoices: [], opportunities: [], dismissed: [], payments: [], verified: [] }), [])
})
