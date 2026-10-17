import assert from 'node:assert/strict'
import test from 'node:test'
import { money } from '../money.ts'
import { rankOpportunities } from '../prioritization.ts'
import { buildRecommendation, validateRecommendation, type Recommendation } from '../recommendation.ts'
import type { InvoiceEvidence, RevenueOpportunity } from '../types.ts'

const ASOF = '2026-10-17T12:00:00.000Z'
const invoice: InvoiceEvidence = {
  id: 'csv:t.csv:INV-1', customerId: 'c1', customerName: 'Acme Ltd', invoiceNumber: 'INV-1', currency: 'USD' as never,
  total: money(100_000, 'USD'), paid: money(20_000, 'USD'), issuedAt: '2026-07-01T00:00:00.000Z', dueAt: '2026-09-17T00:00:00.000Z',
  source: { sourceId: 'csv:t.csv', recordId: 'INV-1', importedAt: ASOF },
}
const opportunity: RevenueOpportunity = {
  id: 'overdue_invoice:csv:t.csv:INV-1', kind: 'overdue_invoice', status: 'open', evidence: [invoice], outstanding: money(80_000, 'USD'),
  estimate: { low: money(24_000, 'USD'), high: money(24_000, 'USD'), assumptionId: 'recovery-rate', formula: 'outstanding_times_recovery_rate' }, detectedAt: ASOF,
}
const [ranked] = rankOpportunities([opportunity], ASOF)

test('a recommendation cites its source record and the invoice evidence it is built from', () => {
  const recommendation = buildRecommendation(ranked, 'none')
  assert.equal(recommendation.sourceRecord, 'csv:t.csv · INV-1')
  assert.deepEqual(recommendation.evidence.map((e) => e.label), ['Invoice', 'Due date', 'Total / paid', 'Outstanding'])
  assert.match(recommendation.summary, /Acme Ltd owes .*800\.00 on invoice INV-1, 30 days past due/)
  assert.deepEqual(validateRecommendation(recommendation), [])
})

test('every recommendation requires human approval and never sends or claims revenue', () => {
  for (const progress of ['none', 'proposed', 'approved', 'executed'] as const) {
    const recommendation = buildRecommendation(ranked, progress)
    assert.equal(recommendation.requiresHumanApproval, true)
    assert.equal(recommendation.sendsAutomatically, false)
    assert.equal(recommendation.estimateIsNotRevenue, true)
    assert.ok(recommendation.steps.length >= 1)
  }
})

test('next steps follow the action progress and keep sending manual', () => {
  assert.match(buildRecommendation(ranked, 'none').steps.join(' '), /Revenue OS sends nothing on its own/)
  assert.match(buildRecommendation(ranked, 'proposed').steps.join(' '), /Approve it only if/)
  assert.match(buildRecommendation(ranked, 'approved').steps.join(' '), /send it yourself/)
  assert.match(buildRecommendation(ranked, 'executed').steps.join(' '), /verified only when payment records match/)
})

test('an opportunity without a source invoice cannot be recommended', () => {
  const [orphan] = rankOpportunities([opportunity], ASOF)
  assert.throws(() => buildRecommendation({ ...orphan, opportunity: { ...opportunity, evidence: [] } }, 'none'), /no source invoice/)
})

test('validation rejects missing evidence, a missing source, disabled approval, auto-send and control characters', () => {
  const good = buildRecommendation(ranked, 'none')
  const bad = (change: Partial<Recommendation>) => validateRecommendation({ ...good, ...change } as Recommendation)
  assert.match(bad({ evidence: [] }).join(' '), /evidence/)
  assert.match(bad({ sourceRecord: ' ' }).join(' '), /source record/)
  assert.match(bad({ requiresHumanApproval: false as never }).join(' '), /Human approval/)
  assert.match(bad({ sendsAutomatically: true as never }).join(' '), /never send/)
  assert.match(bad({ estimateIsNotRevenue: false as never }).join(' '), /not revenue/)
  assert.match(bad({ steps: [] }).join(' '), /at least one step/)
  assert.match(bad({ summary: 'line\nbreak' }).join(' '), /control characters/)
})
