import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyBusinessSignalBatch, validateBusinessSignal, type BusinessSignal } from '../businessSignals.ts'

const base = (overrides: Partial<BusinessSignal> = {}): BusinessSignal => ({
  organizationId: 'org-a',
  sourceId: 'gmail-connection-a',
  provider: 'gmail',
  type: 'inbound_enquiry',
  idempotencyKey: 'gmail:message-123:inbound',
  occurredAt: '2026-10-20T09:00:00.000Z',
  observedAt: '2026-10-20T09:01:00.000Z',
  customer: { status: 'matched', customerId: 'customer-1', method: 'exact_identifier' },
  evidence: { externalRecordId: 'message-123', sourceUrl: 'https://mail.example/thread/123', description: 'Inbound email in a connected thread' },
  confidence: 0.98,
  reviewState: 'ready',
  summary: 'A customer sent a new enquiry.',
  ...overrides,
})

test('accepts a well-formed, source-linked business signal', () => {
  assert.deepEqual(validateBusinessSignal(base()), [])
  assert.equal(classifyBusinessSignalBatch([base()]).accepted.length, 1)
})

test('rejects invalid timestamps, confidence, missing evidence and unconfirmed customer matches marked ready', () => {
  const invalid = base({
    occurredAt: 'not-a-date',
    confidence: 1.2,
    evidence: { externalRecordId: '', description: '' },
    customer: { status: 'candidate', candidateCustomerIds: ['customer-1', 'customer-2'], reason: 'Similar business name' },
  })
  const errors = validateBusinessSignal(invalid)
  assert.ok(errors.some((error) => error.includes('occurredAt')))
  assert.ok(errors.some((error) => error.includes('confidence')))
  assert.ok(errors.some((error) => error.includes('externalRecordId')))
  assert.ok(errors.some((error) => error.includes('needs_review')))
})

test('candidate and unmatched customers must remain in review', () => {
  assert.ok(validateBusinessSignal(base({
    customer: { status: 'unmatched', reason: 'No reliable contact identifier' },
    reviewState: 'ready',
  })).some((error) => error.includes('needs_review')))

  assert.deepEqual(validateBusinessSignal(base({
    customer: { status: 'candidate', candidateCustomerIds: ['customer-1'], reason: 'Similar email display name' },
    reviewState: 'needs_review',
  })), [])
})

test('identical source events are idempotent within a batch', () => {
  const signal = base()
  const result = classifyBusinessSignalBatch([signal, { ...signal }])
  assert.equal(result.accepted.length, 1)
  assert.deepEqual(result.duplicates, [signal.idempotencyKey])
  assert.deepEqual(result.conflicts, [])
})

test('conflicting content that reuses an idempotency key is quarantined', () => {
  const result = classifyBusinessSignalBatch([
    base(),
    base({ summary: 'A different event was observed under the same source key.' }),
  ])
  assert.equal(result.accepted.length, 1)
  assert.equal(result.conflicts.length, 1)
  assert.match(result.conflicts[0].reason, /conflicting signal content/)
})

test('same provider key from separate organizations does not collide', () => {
  const result = classifyBusinessSignalBatch([
    base({ organizationId: 'org-a' }),
    base({ organizationId: 'org-b' }),
  ])
  assert.equal(result.accepted.length, 2)
  assert.deepEqual(result.duplicates, [])
})

test('invalid rows are rejected without blocking valid rows in the same batch', () => {
  const result = classifyBusinessSignalBatch([
    base(),
    base({ confidence: -0.1 }),
    base({ idempotencyKey: 'another-message', evidence: { externalRecordId: 'message-456', description: 'A different inbound email' } }),
  ])
  assert.equal(result.accepted.length, 2)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].index, 1)
})
