import assert from 'node:assert/strict'
import test from 'node:test'
import { attentionReasons, dateOnly, DEFAULT_WORKFLOW, isSnoozed, nextActionForWorkflow, summarizeWorkflow, type OpportunityWorkflow } from '../issueWorkflow.ts'
import { money } from '../money.ts'
import { rankOpportunities } from '../prioritization.ts'
import type { InvoiceEvidence, RevenueOpportunity } from '../types.ts'

const NOW = '2026-10-19T10:00:00.000Z'

function invoice(id: string, dueAt: string): InvoiceEvidence {
  return {
    id, customerId: 'c-' + id, customerName: 'Customer ' + id, invoiceNumber: 'INV-' + id, currency: 'USD' as never,
    total: money(100_000, 'USD'), paid: money(0, 'USD'), issuedAt: '2026-06-01T00:00:00.000Z', dueAt,
    source: { sourceId: 's', recordId: 'INV-' + id, importedAt: '2026-10-01T00:00:00.000Z' },
  }
}
function opp(id: string, dueAt: string, workflow?: Partial<OpportunityWorkflow>): RevenueOpportunity {
  return {
    id: 'overdue_invoice:' + id, kind: 'overdue_invoice', status: 'open', evidence: [invoice(id, dueAt)], outstanding: money(100_000, 'USD'),
    estimate: { low: money(30_000, 'USD'), high: money(30_000, 'USD'), assumptionId: 'recovery-rate', formula: 'outstanding_times_recovery_rate' },
    detectedAt: '2026-10-01T00:00:00.000Z', workflow: workflow ? { ...DEFAULT_WORKFLOW, ...workflow } : undefined,
  }
}
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString()

test('dateOnly returns the UTC calendar date and rejects invalid input', () => {
  assert.equal(dateOnly('2026-10-19T23:59:59.000Z'), '2026-10-19')
  assert.throws(() => dateOnly('not a date'), /valid ISO/)
})

test('a recent overdue invoice with no workflow has no attention reason', () => {
  assert.deepEqual(attentionReasons(opp('a', daysAgo(10)), 10, NOW), [])
})

test('a promise whose date has passed is a broken-promise alert and is never treated as money', () => {
  const o = opp('a', daysAgo(10), { state: 'promised', promisedAmount: money(50_000, 'USD'), promisedDate: '2026-10-15', nextFollowUp: '2026-10-16' })
  const reasons = attentionReasons(o, 10, NOW)
  assert.equal(reasons[0].code, 'broken_promise')
  assert.match(reasons[0].label, /still unpaid/)
  assert.equal(reasons.some((r) => r.code === 'follow_up_due'), false, 'one reason per cause: broken promise already covers the missed follow-up')
  assert.equal(o.outstanding.amount, 100_000, 'the outstanding balance is untouched by the promise')
})

test('a promise due in the future is not urgent', () => {
  const o = opp('a', daysAgo(10), { state: 'promised', promisedAmount: money(50_000, 'USD'), promisedDate: '2026-10-25', nextFollowUp: '2026-10-26' })
  assert.deepEqual(attentionReasons(o, 10, NOW), [])
  assert.match(nextActionForWorkflow(o.workflow, NOW) ?? '', /Wait for the promised payment \(due 2026-10-25\)/)
})

test('a follow-up date that has arrived raises an alert; one in the future does not', () => {
  assert.equal(attentionReasons(opp('a', daysAgo(10), { state: 'awaiting_response', nextFollowUp: '2026-10-19' }), 10, NOW)[0].code, 'follow_up_due')
  assert.equal(attentionReasons(opp('a', daysAgo(10), { state: 'awaiting_response', nextFollowUp: '2026-10-20' }), 10, NOW).length, 0)
})

test('disputes and payment claims need attention and explain why', () => {
  assert.equal(attentionReasons(opp('a', daysAgo(10), { state: 'disputed', nextFollowUp: '2026-10-30' }), 10, NOW)[0].code, 'disputed')
  const claimed = attentionReasons(opp('b', daysAgo(10), { state: 'payment_claimed', nextFollowUp: '2026-10-30' }), 10, NOW)[0]
  assert.equal(claimed.code, 'payment_claimed')
  assert.match(claimed.label, /no matching payment is recorded/)
})

test('severe lateness is still an attention reason', () => {
  assert.equal(attentionReasons(opp('a', daysAgo(45)), 45, NOW)[0].code, 'severely_overdue')
})

test('snoozing applies only until the snooze ends', () => {
  assert.equal(isSnoozed({ ...DEFAULT_WORKFLOW, snoozedUntil: '2026-10-22T00:00:00.000Z' }, NOW), true)
  assert.equal(isSnoozed({ ...DEFAULT_WORKFLOW, snoozedUntil: '2026-10-18T00:00:00.000Z' }, NOW), false)
  assert.equal(isSnoozed(undefined, NOW), false)
})

test('ranking puts a broken promise above a lateness-only invoice and marks snoozed issues', () => {
  const late = opp('late', daysAgo(40))
  const broken = opp('broken', daysAgo(9), { state: 'promised', promisedAmount: money(10_000, 'USD'), promisedDate: '2026-10-10', nextFollowUp: '2026-10-11' })
  const snoozed = opp('snoozed', daysAgo(50), { state: 'awaiting_response', nextFollowUp: '2026-10-18', snoozedUntil: '2026-10-25T00:00:00.000Z' })
  const ranked = rankOpportunities([late, broken, snoozed], NOW)
  assert.equal(ranked[0].opportunity.id, 'overdue_invoice:broken')
  assert.equal(ranked.find((r) => r.opportunity.id === 'overdue_invoice:snoozed')?.snoozed, true)
  assert.equal(ranked.find((r) => r.opportunity.id === 'overdue_invoice:late')?.snoozed, false)
  assert.match(ranked[0].nextAction, /promised date has passed/)
  assert.ok(ranked[0].reasons.some((reason) => /promised .* by 2026-10-10/.test(reason)))
})

test('workflow summary counts follow-ups, broken promises, disputes, snoozes and promised money per currency', () => {
  const summary = summarizeWorkflow([
    opp('a', daysAgo(10), { state: 'promised', promisedAmount: money(10_000, 'USD'), promisedDate: '2026-10-10', nextFollowUp: '2026-10-11' }),
    opp('b', daysAgo(10), { state: 'promised', promisedAmount: money(5_000, 'USD'), promisedDate: '2026-10-30', nextFollowUp: '2026-10-31' }),
    opp('c', daysAgo(10), { state: 'disputed', nextFollowUp: '2026-10-19' }),
    opp('d', daysAgo(10), { state: 'awaiting_response', nextFollowUp: '2026-11-01', snoozedUntil: '2026-10-30T00:00:00.000Z' }),
    opp('e', daysAgo(10)),
  ], NOW)
  assert.equal(summary.brokenPromises, 1)
  assert.equal(summary.disputes, 1)
  assert.equal(summary.followUpsDue, 2)
  assert.equal(summary.snoozed, 1)
  assert.equal(summary.promisesOutstanding.length, 1)
  assert.equal(summary.promisesOutstanding[0].amount, 15_000)
})
