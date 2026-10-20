import assert from 'node:assert/strict'
import test from 'node:test'
import { overdueInvoiceSignals } from '../businessSignalAdapters.ts'
import type { InvoiceEvidence } from '../types.ts'

const invoice = (overrides: Partial<InvoiceEvidence> = {}): InvoiceEvidence => ({
  id: 'invoice-1',
  customerId: 'customer-1',
  customerName: 'Example Customer',
  invoiceNumber: 'INV-001',
  currency: 'USD' as InvoiceEvidence['currency'],
  total: { amount: 10000 as InvoiceEvidence['total']['amount'], currency: 'USD' as InvoiceEvidence['total']['currency'] },
  paid: { amount: 2500 as InvoiceEvidence['paid']['amount'], currency: 'USD' as InvoiceEvidence['paid']['currency'] },
  issuedAt: '2026-09-01',
  dueAt: '2026-09-30',
  source: { sourceId: 'sheet-connection-1', recordId: 'row-42', importedAt: '2026-10-20T09:00:00.000Z' },
  ...overrides,
})

test('maps overdue unpaid invoice evidence to a source-linked confirmed signal', () => {
  const signals = overdueInvoiceSignals([invoice()], 'org-1', '2026-10-20T10:00:00.000Z')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].type, 'invoice_overdue')
  assert.equal(signals[0].customer.status, 'matched')
  assert.equal(signals[0].evidence.externalRecordId, 'row-42')
  assert.equal(signals[0].sourceId, 'sheet-connection-1')
  assert.equal(signals[0].reviewState, 'ready')
  assert.match(signals[0].summary, /INV-001/)
})

test('does not signal invoices that are not yet overdue or fully paid', () => {
  const notDue = invoice({ dueAt: '2026-10-21' })
  const paid = invoice({ paid: { amount: 10000 as InvoiceEvidence['paid']['amount'], currency: 'USD' as InvoiceEvidence['paid']['currency'] } })
  assert.deepEqual(overdueInvoiceSignals([notDue, paid], 'org-1', '2026-10-20T10:00:00.000Z'), [])
})

test('omits contradictory or incomplete invoice rows rather than inventing alerts', () => {
  const badPaid = invoice({ paid: { amount: -1 as InvoiceEvidence['paid']['amount'], currency: 'USD' as InvoiceEvidence['paid']['currency'] } })
  const badSource = invoice({ source: { sourceId: '', recordId: 'row-43', importedAt: '2026-10-20T09:00:00.000Z' } })
  assert.deepEqual(overdueInvoiceSignals([badPaid, badSource], 'org-1', '2026-10-20T10:00:00.000Z'), [])
})

test('rejects invalid organization and evaluation timestamps', () => {
  assert.throws(() => overdueInvoiceSignals([], '', '2026-10-20T10:00:00.000Z'), /organizationId/)
  assert.throws(() => overdueInvoiceSignals([], 'org-1', 'not-a-date'), /asOf/)
})
