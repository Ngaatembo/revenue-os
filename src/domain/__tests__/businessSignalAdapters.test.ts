import assert from 'node:assert/strict'
import test from 'node:test'
import { overdueInvoiceSignals, quotationSignals, taskDueSignals } from '../businessSignalAdapters.ts'
import { validateBusinessSignal } from '../businessSignals.ts'
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

test('maps overdue unpaid invoice evidence to a source-linked signal without guessing provider kind', () => {
  const signals = overdueInvoiceSignals([invoice()], 'org-1', '2026-10-20T10:00:00.000Z')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].type, 'invoice_overdue')
  assert.equal(signals[0].provider, 'unknown')
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

import type { Quotation, Task } from '../records.ts'

const quotation = (overrides: Partial<Quotation> = {}): Quotation => ({
  id: 'quote-1', reference: 'Q-104', customerName: 'Moyo Events', currency: 'USD', amountMinor: 12500,
  status: 'sent', sentOn: '2026-10-19', validUntil: '2026-11-19', followUpDate: '2026-10-22',
  lastContactOn: '2026-10-19', ownerId: null, notes: null, ...overrides,
})
const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1', title: 'Follow up on quotation', detail: null, dueDate: '2026-10-20',
  status: 'open', ownerId: null, relatedType: 'quotation', relatedId: 'quote-1', ...overrides,
})
const observedAt = '2026-10-21T10:00:00.000Z'

test('sent quotation becomes a signal without guessing customer identity', () => {
  const [signal] = quotationSignals([quotation()], 'org-a', 'manual-records', observedAt)
  assert.equal(signal.type, 'quotation_sent')
  assert.equal(signal.customer.status, 'unmatched')
  assert.equal(signal.reviewState, 'needs_review')
  assert.match(signal.evidence.description, /Q-104/)
  assert.deepEqual(validateBusinessSignal(signal), [])
})

test('unsent or malformed quotations do not create sent signals', () => {
  assert.deepEqual(quotationSignals([quotation({ status: 'accepted' }), quotation({ id: 'quote-2', status: 'withdrawn' })], 'org-a', 'manual-records', observedAt), [])
  assert.deepEqual(quotationSignals([quotation({ sentOn: 'not-a-date' })], 'org-a', 'manual-records', observedAt), [])
})

test('open task becomes a due signal but does not assert customer contact', () => {
  const [signal] = taskDueSignals([task()], 'org-a', 'manual-records', observedAt)
  assert.equal(signal.type, 'follow_up_due')
  assert.equal(signal.customer.status, 'unmatched')
  assert.equal(signal.reviewState, 'needs_review')
  assert.deepEqual(validateBusinessSignal(signal), [])
})

test('completed tasks are not emitted as due work', () => {
  assert.deepEqual(taskDueSignals([task({ status: 'done' })], 'org-a', 'manual-records', observedAt), [])
})

test('record adapters require explicit tenant, source, and observation time', () => {
  assert.throws(() => quotationSignals([], '', 'manual-records', observedAt), /organizationId/)
  assert.throws(() => taskDueSignals([], 'org-a', '', observedAt), /sourceId/)
  assert.throws(() => taskDueSignals([], 'org-a', 'manual-records', 'bad-time'), /observedAt/)
})
