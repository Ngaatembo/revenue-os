import assert from 'node:assert/strict'
import test from 'node:test'
import { partitionCrossSourceDuplicates } from '../importDuplicates.ts'
import { money } from '../money.ts'
import type { InvoiceEvidence } from '../types.ts'

function inv(sourceId: string, number: string, currency = 'USD'): InvoiceEvidence {
  return {
    id: `${sourceId}:${number}`, customerId: 'c', customerName: 'Cust', invoiceNumber: number, currency: currency as never,
    total: money(100, currency), paid: money(0, currency), issuedAt: '2026-01-01T00:00:00.000Z', dueAt: '2026-02-01T00:00:00.000Z',
    source: { sourceId, recordId: number, importedAt: '2026-10-17T00:00:00.000Z' },
  }
}

test('an invoice already saved from a different file is not imported twice', () => {
  const { fresh, duplicates } = partitionCrossSourceDuplicates([inv('csv:b.csv', 'INV-1'), inv('csv:b.csv', 'INV-2')], [2, 3], [inv('csv:a.csv', 'INV-1')])
  assert.deepEqual(fresh.map((i) => i.invoiceNumber), ['INV-2'])
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].row, 2)
  assert.match(duplicates[0].message, /already saved from another file/)
})

test('re-importing the same source updates it instead of being treated as a duplicate', () => {
  const { fresh, duplicates } = partitionCrossSourceDuplicates([inv('csv:a.csv', 'INV-1')], [2], [inv('csv:a.csv', 'INV-1')])
  assert.equal(fresh.length, 1)
  assert.equal(duplicates.length, 0)
})

test('matching is by invoice number and currency, ignoring case and spacing; other currencies are distinct', () => {
  const existing = [inv('csv:a.csv', 'inv-1')]
  assert.equal(partitionCrossSourceDuplicates([inv('csv:b.csv', ' INV-1 ')], [2], existing).duplicates.length, 1)
  assert.equal(partitionCrossSourceDuplicates([inv('csv:b.csv', 'INV-1', 'EUR')], [2], existing).duplicates.length, 0)
})

test('with nothing saved yet every row is fresh', () => {
  const { fresh, duplicates } = partitionCrossSourceDuplicates([inv('csv:a.csv', 'INV-1')], [2], [])
  assert.equal(fresh.length, 1)
  assert.equal(duplicates.length, 0)
})
