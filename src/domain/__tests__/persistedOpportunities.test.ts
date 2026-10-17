import assert from 'node:assert/strict'
import test from 'node:test'
import { money } from '../money.ts'
import { toRevenueOpportunities, type DbOpportunityRow } from '../persistedOpportunities.ts'
import type { InvoiceEvidence } from '../types.ts'

function inv(id: string, currency = 'USD'): InvoiceEvidence {
  return {
    id, customerId: 'c', customerName: 'Cust', invoiceNumber: 'N-' + id, currency: currency as never,
    total: money(100_000, currency), paid: money(0, currency), issuedAt: '2026-01-01T00:00:00.000Z', dueAt: '2026-02-01T00:00:00.000Z',
    source: { sourceId: 's', recordId: 'N-' + id, importedAt: '2026-10-17T00:00:00.000Z' },
  }
}
function row(id: string, over: Partial<DbOpportunityRow> = {}): DbOpportunityRow {
  return { id: 'overdue_invoice:' + id, kind: 'overdue_invoice', status: 'open', currency: 'USD', outstanding_minor: '100000', estimate_low_minor: 30_000, estimate_high_minor: 30_000, assumption_id: 'recovery-rate', detected_at: '2026-10-17T00:00:00.000Z', detection_reason: 'r', ...over }
}

test('saved open opportunities are rebuilt from their saved rows and source invoices', () => {
  const { opportunities, unresolvedIds } = toRevenueOpportunities([row('a')], [{ opportunity_id: 'overdue_invoice:a', invoice_id: 'a' }], [inv('a')])
  assert.equal(unresolvedIds.length, 0)
  assert.equal(opportunities[0].outstanding.amount, 100_000)
  assert.equal(opportunities[0].estimate.low.amount, 30_000)
  assert.equal(opportunities[0].evidence[0].id, 'a')
})

test('closed, dismissed and non-invoice opportunities are not shown', () => {
  const rows = [row('a', { status: 'closed' }), row('b', { status: 'dismissed' }), row('c', { kind: 'other' })]
  const evidence = ['a', 'b', 'c'].map((id) => ({ opportunity_id: 'overdue_invoice:' + id, invoice_id: id }))
  assert.equal(toRevenueOpportunities(rows, evidence, ['a', 'b', 'c'].map((id) => inv(id))).opportunities.length, 0)
})

test('an opportunity whose source invoice is missing or in another currency is reported, never fabricated', () => {
  const { opportunities, unresolvedIds } = toRevenueOpportunities(
    [row('a'), row('b'), row('c', { currency: 'EUR' })],
    [{ opportunity_id: 'overdue_invoice:a', invoice_id: 'missing' }, { opportunity_id: 'overdue_invoice:c', invoice_id: 'c' }],
    [inv('c', 'USD')],
  )
  assert.equal(opportunities.length, 0)
  assert.deepEqual(unresolvedIds.sort(), ['overdue_invoice:a', 'overdue_invoice:b', 'overdue_invoice:c'])
})

test('the saved estimate stays separate from outstanding and carries no verified amount', () => {
  const [opportunity] = toRevenueOpportunities([row('a', { estimate_low_minor: 5, estimate_high_minor: 9 })], [{ opportunity_id: 'overdue_invoice:a', invoice_id: 'a' }], [inv('a')]).opportunities
  assert.equal(opportunity.estimate.low.amount, 5)
  assert.equal(opportunity.estimate.high.amount, 9)
  assert.equal('verified' in opportunity, false)
})
