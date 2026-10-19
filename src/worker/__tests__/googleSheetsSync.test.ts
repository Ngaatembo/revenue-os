import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSheetInvoiceValues } from '../googleSheetsSync.ts'

const header = ['customer_id', 'customer_name', 'invoice_number', 'currency', 'total_amount', 'paid_amount', 'issued_at', 'due_at']

test('maps valid spreadsheet rows to the invoice import shape', () => {
  const result = parseSheetInvoiceValues([
    header,
    ['c-1', 'Example Customer', 'INV-1', 'USD', '120.50', '20', '2026-01-01', '2026-02-01'],
  ], 'gsheet:abc', '2026-10-19T00:00:00.000Z')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].totalMinor, 12050)
  assert.equal(result.rows[0].paidMinor, 2000)
  assert.equal(result.rows[0].id, 'gsheet:abc:INV-1')
  assert.equal(result.rejectedRows, 0)
})

test('rejects invalid rows without discarding valid rows', () => {
  const result = parseSheetInvoiceValues([
    header,
    ['c-1', 'Good', 'INV-1', 'USD', '10', '0', '2026-01-01', '2026-02-01'],
    ['c-2', 'Bad', 'INV-2', 'USD', '10', '11', '2026-01-01', '2026-02-01'],
    ['c-3', 'Bad', 'INV-3', 'USD', 'oops', '0', '2026-01-01', '2026-02-01'],
  ], 'gsheet:abc', '2026-10-19T00:00:00.000Z')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rejectedRows, 2)
})

test('requires the same invoice columns as CSV imports', () => {
  assert.throws(() => parseSheetInvoiceValues([['invoice_number'], ['INV-1']], 'gsheet:abc', '2026-10-19T00:00:00.000Z'), /missing_columns/)
})

test('rejects duplicate invoice numbers in one sheet range', () => {
  assert.throws(() => parseSheetInvoiceValues([
    header,
    ['c-1', 'Good', 'INV-1', 'USD', '10', '0', '2026-01-01', '2026-02-01'],
    ['c-2', 'Good 2', 'INV-1', 'USD', '12', '0', '2026-01-01', '2026-02-01'],
  ], 'gsheet:abc', '2026-10-19T00:00:00.000Z'), /no_valid_invoice_rows|/)
})
