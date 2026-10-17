import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyPaymentOutcome } from '../attribution.ts'
import { money } from '../money.ts'
import type { InvoiceEvidence, PaymentEvidence, RevenueAction, RevenueOpportunity } from '../types.ts'

const SENT = '2026-10-01T00:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(Date.parse(SENT) + days * DAY).toISOString()
const invoice: InvoiceEvidence = {
  id: 'inv-1', customerId: 'c', customerName: 'Acme', invoiceNumber: 'INV-1', currency: 'USD' as never,
  total: money(100_000, 'USD'), paid: money(0, 'USD'), issuedAt: '2026-06-01T00:00:00.000Z', dueAt: '2026-08-01T00:00:00.000Z',
  source: { sourceId: 's', recordId: 'INV-1', importedAt: SENT },
}
const opportunity: RevenueOpportunity = {
  id: 'overdue_invoice:inv-1', kind: 'overdue_invoice', status: 'open', evidence: [invoice], outstanding: money(100_000, 'USD'),
  estimate: { low: money(30_000, 'USD'), high: money(30_000, 'USD'), assumptionId: 'recovery-rate', formula: 'outstanding_times_recovery_rate' }, detectedAt: SENT,
}
const action = (over: Partial<RevenueAction> = {}): RevenueAction => ({
  id: 'act-1', opportunityId: opportunity.id, kind: 'payment_reminder', status: 'executed', proposedAt: SENT, approvedAt: SENT, approvedBy: 'u',
  executedAt: SENT, executedBy: 'u', executionMode: 'manual', payload: { recipientCustomerId: 'c', invoiceIds: ['inv-1'], message: 'Please pay' }, ...over,
})
const payment = (id: string, amount: number, receivedAt: string, invoiceId = 'inv-1', currency = 'USD'): PaymentEvidence => ({
  id, invoiceId, amount: money(amount, currency), receivedAt, source: { sourceId: 'pay', recordId: id, importedAt: receivedAt },
})
const verify = (payments: PaymentEvidence[], over: Partial<RevenueAction> = {}, windowDays = 30) =>
  verifyPaymentOutcome({ action: action(over), opportunity, payments, windowDays })

test('verified revenue is exactly the sum of matched payment records inside the window', () => {
  const outcome = verify([payment('p1', 40_000, at(1)), payment('p2', 20_000, at(10))])
  assert.equal(outcome?.amount.amount, 60_000)
  assert.equal(outcome?.state, 'verified')
  assert.equal(outcome?.method, 'matched_payment_record')
  assert.equal(outcome?.paymentEvidence.length, 2)
})

test('the outcome never claims the reminder caused the payment', () => {
  assert.equal(verify([payment('p1', 1, at(1))])?.causalClaim, 'observed_after_action_not_proven_causal')
})

test('no matching payment evidence means no verified revenue (null), not zero and not an estimate', () => {
  assert.equal(verify([]), null)
  assert.equal(verify([payment('p1', 5_000, at(-2)), payment('p2', 5_000, at(31))]), null)
})

test('payments before the action, after the window, in another currency or for another invoice are excluded', () => {
  const outcome = verify([payment('before', 9_000, at(-1)), payment('late', 9_000, at(31)), payment('eur', 9_000, at(2), 'inv-1', 'EUR'), payment('other', 9_000, at(2), 'inv-2'), payment('ok', 7_000, at(2))])
  assert.equal(outcome?.amount.amount, 7_000)
})

test('the window is inclusive of its end and bounded between 1 and 365 days', () => {
  assert.equal(verify([payment('edge', 100, at(30))])?.amount.amount, 100)
  assert.throws(() => verify([], {}, 0), /1 to 365/)
  assert.throws(() => verify([], {}, 366), /1 to 365/)
})

test('only manually executed actions can be verified', () => {
  for (const status of ['proposed', 'approved', 'cancelled', 'failed'] as const) {
    assert.throws(() => verify([payment('p', 1, at(1))], { status }), /after an action was executed/)
  }
  assert.throws(() => verify([payment('p', 1, at(1))], { executedAt: undefined }), /after an action was executed/)
})

test('matched payments above the outstanding balance require review instead of inflating revenue', () => {
  assert.throws(() => verify([payment('p1', 100_001, at(1))]), /exceed the outstanding/)
})

test('non-positive payment amounts never count', () => {
  assert.equal(verify([payment('zero', 0, at(1))]), null)
})
