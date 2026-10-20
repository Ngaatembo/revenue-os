import assert from 'node:assert/strict'
import test from 'node:test'
import { attachBusinessSignalEvidence } from '../attention/engine.ts'
import type { AttentionFinding } from '../attention/types.ts'
import type { BusinessSignal } from '../businessSignals.ts'
import type { RevenueOpportunity } from '../types.ts'

const finding = (subjectId = 'opportunity-1'): AttentionFinding => ({
  ruleId: 'invoice.severely_overdue',
  subject: { type: 'invoice', id: subjectId, label: 'Example Customer · invoice INV-001' },
  what: 'Invoice is overdue.',
  evidence: ['Invoice INV-001 is past due.'],
  why: 'Cash collection needs attention.',
  nextStep: 'Contact the customer.',
  strength: 'confirmed',
  urgency: 0.7,
  likelihood: 0.6,
  effort: 0.3,
  knownMoney: { amount: 7500 as never, currency: 'USD' as never },
  severity: 3,
})

const opportunity = {
  id: 'opportunity-1',
  status: 'open',
  evidence: [{
    id: 'invoice-1', customerId: 'customer-1', customerName: 'Example Customer', invoiceNumber: 'INV-001',
    currency: 'USD', total: { amount: 10000, currency: 'USD' }, paid: { amount: 2500, currency: 'USD' },
    issuedAt: '2026-09-01', dueAt: '2026-09-30',
    source: { sourceId: 'sheet-connection-1', recordId: 'row-42', importedAt: '2026-10-20T09:00:00.000Z' },
  }],
} as unknown as RevenueOpportunity

const signal: BusinessSignal = {
  organizationId: 'org-1',
  sourceId: 'sheet-connection-1',
  provider: 'accounting',
  type: 'invoice_overdue',
  idempotencyKey: 'invoice-overdue:row-42:2026-09-30',
  occurredAt: '2026-09-30T00:00:00.000Z',
  observedAt: '2026-10-20T09:00:00.000Z',
  customer: { status: 'matched', customerId: 'customer-1', method: 'exact_identifier' },
  evidence: { externalRecordId: 'row-42', description: 'Imported invoice evidence' },
  confidence: 1,
  reviewState: 'ready',
  summary: 'Invoice INV-001 is overdue in the connected records.',
}

test('enriches the existing invoice finding with source provenance without creating another finding', () => {
  const result = attachBusinessSignalEvidence([finding()], [opportunity], [signal])
  assert.equal(result.length, 1)
  assert.ok(result[0].evidence.some((entry) => entry.includes('record row-42')))
  assert.ok(result[0].evidence.some((entry) => entry.includes('observed 2026-10-20T09:00:00.000Z')))
})

test('does not attach a signal when customer and source record do not match', () => {
  const result = attachBusinessSignalEvidence([finding()], [opportunity], [{ ...signal, sourceId: 'different-source' }])
  assert.deepEqual(result, [finding()])
})

test('does not attach invoice signals to lead findings', () => {
  const leadFinding = { ...finding(), subject: { type: 'lead', id: 'lead-1', label: 'Example lead' } } as AttentionFinding
  const result = attachBusinessSignalEvidence([leadFinding], [opportunity], [signal])
  assert.deepEqual(result, [leadFinding])
})
