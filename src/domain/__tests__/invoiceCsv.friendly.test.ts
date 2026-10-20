import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInvoiceCsv } from '../invoiceCsv.ts'

const importedAt = '2026-10-20T10:00:00.000Z'

test('accepts familiar spreadsheet column names and a missing internal customer ID', () => {
  const csv = [
    'Client,Invoice No,Currency,Amount,Paid,Invoice Date,Due Date',
    'Mupfumi Hardware,INV-104,USD,250,50,2026-09-01,2026-10-01',
  ].join('\n')

  const result = parseInvoiceCsv(csv, 'csv:client-invoices', importedAt)

  assert.equal(result.invoices.length, 1)
  assert.equal(result.issues.length, 0)
  assert.equal(result.invoices[0].customerName, 'Mupfumi Hardware')
  assert.equal(result.invoices[0].invoiceNumber, 'INV-104')
  assert.equal(result.invoices[0].total.amount, 25000)
  assert.equal(result.invoices[0].paid.amount, 5000)
  assert.equal(result.invoices[0].customerId, 'customer:mupfumi-hardware')
})

test('explains missing fields in business language', () => {
  const csv = [
    'Client,Invoice No,Amount',
    'Mupfumi Hardware,INV-104,250',
  ].join('\n')

  assert.throws(
    () => parseInvoiceCsv(csv, 'csv:client-invoices', importedAt),
    /couldn't identify.*currency.*paid amount.*issued at.*due at/i,
  )
})

test('normalizes spaces, hyphens, and capitalization in headers', () => {
  const csv = [
    'Customer Name,Invoice Number,Currency Code,Invoice Amount,Amount Paid,Issue Date,Payment Due Date',
    'Mupfumi Hardware,INV-105,USD,250,0,2026-09-01,2026-10-01',
  ].join('\n')

  const result = parseInvoiceCsv(csv, 'csv:client-invoices', importedAt)
  assert.equal(result.invoices.length, 1)
  assert.equal(result.invoices[0].invoiceNumber, 'INV-105')
})
