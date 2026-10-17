import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOverdueOpportunities, sumOpportunityEstimates } from '../overdueInvoices.ts'
import { money } from '../money.ts'
import type { InvoiceEvidence, RevenueAssumption } from '../types.ts'

const ASOF = '2026-10-17T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.parse(ASOF) - days * DAY).toISOString()

function invoice(id: string, dueAt: string, total: number, paid: number, currency = 'USD'): InvoiceEvidence {
  return {
    id, customerId: 'c-' + id, customerName: 'Cust ' + id, invoiceNumber: 'INV-' + id, currency: currency as never,
    total: money(total, currency), paid: money(paid, currency), issuedAt: daysAgo(90), dueAt,
    source: { sourceId: 'csv:t.csv', recordId: 'INV-' + id, importedAt: ASOF },
  }
}
const rate = (valueBps: number): RevenueAssumption => ({ id: 'recovery-rate', key: 'recovery_rate', valueBps, updatedAt: ASOF, updatedBy: 'u' })
const detect = (invoices: InvoiceEvidence[], bps = 3000) => buildOverdueOpportunities({ invoices, assumption: rate(bps), asOf: ASOF })

test('only unpaid invoices at least one day past due become opportunities', () => {
  const found = detect([
    invoice('a', daysAgo(30), 100_000, 0),
    invoice('future', daysAgo(-20), 90_000, 0),
    invoice('paid', daysAgo(20), 10_000, 10_000),
    invoice('hours', new Date(Date.parse(ASOF) - 12 * 60 * 60 * 1000).toISOString(), 40_000, 0),
    invoice('exact', daysAgo(1), 5_000, 0),
  ])
  assert.deepEqual(found.map((o) => o.id).sort(), ['overdue_invoice:a', 'overdue_invoice:exact'])
})

test('estimates match the database rule: outstanding x rate, rounded half up, in minor units', () => {
  const [a, b, g] = detect([
    invoice('a', daysAgo(30), 100_000, 0),
    invoice('b', daysAgo(10), 50_000, 20_000),
    invoice('g', daysAgo(3), 12_345, 0),
  ])
  assert.equal(a.estimate.low.amount, 30_000)
  assert.equal(b.outstanding.amount, 30_000)
  assert.equal(b.estimate.low.amount, 9_000)
  assert.equal(g.estimate.low.amount, 3_704)
  assert.equal(g.estimate.high.amount, g.estimate.low.amount)
})

test('an estimate is labelled as an estimate and never exceeds the outstanding balance', () => {
  for (const bps of [0, 1, 2500, 9999, 10_000]) {
    for (const opportunity of detect([invoice('x', daysAgo(5), 99_999, 1)], bps)) {
      assert.equal(opportunity.estimate.formula, 'outstanding_times_recovery_rate')
      assert.ok(opportunity.estimate.low.amount <= opportunity.outstanding.amount)
      assert.equal(opportunity.status, 'open')
    }
  }
})

test('each opportunity carries its source invoice as evidence', () => {
  const [opportunity] = detect([invoice('a', daysAgo(30), 100_000, 0)])
  assert.equal(opportunity.evidence.length, 1)
  assert.deepEqual(opportunity.evidence[0].source, { sourceId: 'csv:t.csv', recordId: 'INV-a', importedAt: ASOF })
  assert.equal(opportunity.estimate.assumptionId, 'recovery-rate')
})

test('repeated processing is idempotent: same input, same ids, no duplicates', () => {
  const input = [invoice('a', daysAgo(30), 100_000, 0), invoice('b', daysAgo(10), 50_000, 20_000)]
  const first = detect(input)
  const second = detect(input)
  assert.deepEqual(first, second)
  assert.equal(new Set(first.map((o) => o.id)).size, first.length)
})

test('currencies are never mixed, and an estimate total is only for one currency', () => {
  const found = detect([invoice('u', daysAgo(30), 10_000, 0, 'USD'), invoice('e', daysAgo(30), 10_000, 0, 'EUR')])
  assert.deepEqual(found.map((o) => o.outstanding.currency).sort(), ['EUR', 'USD'])
  assert.throws(() => sumOpportunityEstimates(found), /Currency mismatch/)
  assert.equal(sumOpportunityEstimates([]), null)
})

test('no data means no opportunities, never invented ones', () => {
  assert.deepEqual(detect([]), [])
})

test('invalid inputs fail loudly instead of producing a guess', () => {
  assert.throws(() => detect([], 10_001), /basis points/)
  assert.throws(() => detect([], -1), /basis points/)
  assert.throws(() => buildOverdueOpportunities({ invoices: [], assumption: rate(3000), asOf: 'nope' }), /valid date/)
  assert.throws(() => detect([invoice('bad', daysAgo(30), 100, 200)]), /invalid total or paid/)
  assert.throws(() => detect([invoice('bad', 'not-a-date', 100, 0)]), /valid date/)
})
