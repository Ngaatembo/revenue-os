import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePaymentCsv } from '../paymentCsv.ts'

test('parsePaymentCsv accepts valid payment evidence and converts money to minor units', () => {
  const result = parsePaymentCsv('invoice_number,payment_reference,currency,amount,received_at\nINV-12,REF-9,USD,125.50,2026-10-13T10:00:00Z')
  assert.equal(result.issues.length, 0)
  assert.deepEqual(result.payments[0], {
    invoiceNumber: 'INV-12',
    externalRecordId: 'REF-9',
    currency: 'USD',
    amountMinor: 12550,
    receivedAt: '2026-10-13T10:00:00.000Z',
    rowNumber: 2,
  })
})

test('parsePaymentCsv rejects duplicate references and invalid amounts', () => {
  const result = parsePaymentCsv('invoice_number,payment_reference,currency,amount,received_at\nINV-12,REF-9,USD,125.50,2026-10-13T10:00:00Z\nINV-13,REF-9,USD,-1,not-a-date')
  assert.equal(result.payments.length, 1)
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0].message, /Duplicate payment reference/)
})

test('parsePaymentCsv requires every required header', () => {
  assert.throws(() => parsePaymentCsv('invoice_number,payment_reference\nINV-1,REF-1'), /Missing required payment columns/)
})

test('parsePaymentCsv does not silently accept unterminated quoted fields', () => {
  assert.throws(() => parsePaymentCsv('invoice_number,payment_reference,currency,amount,received_at\n"INV-1,REF-1,USD,5.00,2026-10-13'), /unterminated quoted field/)
})
