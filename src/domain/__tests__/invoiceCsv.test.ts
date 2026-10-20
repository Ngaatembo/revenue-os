import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInvoiceCsv } from '../invoiceCsv.ts'

const HEADER = 'customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at'
const NOW = '2026-10-17T10:00:00.000Z'
const parse = (rows: string[], header = HEADER) => parseInvoiceCsv([header, ...rows].join('\n'), 'csv:test.csv', NOW)

test('a valid row becomes a sourced invoice in integer minor units', () => {
  const result = parse(['c1,Acme Ltd,INV-1,usd,1000.50,250,2026-08-01,2026-09-01'])
  assert.equal(result.issues.length, 0)
  const [invoice] = result.invoices
  assert.equal(invoice.id, 'csv:test.csv:INV-1')
  assert.equal(invoice.currency, 'USD')
  assert.equal(invoice.total.amount, 100050)
  assert.equal(invoice.paid.amount, 25000)
  assert.deepEqual(invoice.source, { sourceId: 'csv:test.csv', recordId: 'INV-1', importedAt: NOW })
  assert.deepEqual(result.rowNumbers, [2])
})

test('missing required columns are named in the error', () => {
  assert.throws(() => parse(['c1,Acme,INV-1,USD,10,0,2026-01-01,2026-02-01'], 'customer_id,customer_name,invoice_number'), /couldn't identify.*currency.*total amount.*paid amount.*issued at.*due at/i)
})

test('header-only and empty files are rejected, duplicate headers are rejected', () => {
  assert.throws(() => parseInvoiceCsv(HEADER, 's', NOW), /header and at least one data row/)
  assert.throws(() => parseInvoiceCsv('', 's', NOW), /header and at least one data row/)
  assert.throws(() => parse(['c1,A,INV-1,USD,10,0,2026-01-01,2026-02-01,x'], HEADER + ',due_at'), /unique/)
})

test('invalid rows are skipped with a row-specific reason; valid rows still import', () => {
  const result = parse([
    'c1,Acme,INV-1,USD,100,0,2026-01-01,2026-02-01',
    'c2,Beta,INV-2,USD,100.123,0,2026-01-01,2026-02-01',
    'c3,Gamma,INV-3,US,100,0,2026-01-01,2026-02-01',
    'c4,Delta,INV-4,USD,100,150,2026-01-01,2026-02-01',
    'c5,Eps,INV-5,USD,0,0,2026-01-01,2026-02-01',
    'c6,Zeta,INV-6,USD,100,0,not-a-date,2026-02-01',
    'c7,Eta,INV-7,USD,-5,0,2026-01-01,2026-02-01',
    'c8,Theta,INV-8,USD,1,000,0,2026-01-01,2026-02-01',
    ',NoId,INV-9,USD,100,0,2026-01-01,2026-02-01',
    'c10,Iota,INV-10,USD,100,0,2026-01-01',
  ])
  assert.deepEqual(result.invoices.map((invoice) => invoice.invoiceNumber), ['INV-1', 'INV-9'])
  assert.deepEqual(result.issues.map((issue) => issue.row), [3, 4, 5, 6, 7, 8, 9, 11])
  assert.match(result.issues[0].message, /2 decimal places/)
  assert.match(result.issues[1].message, /three-letter/)
  assert.match(result.issues[2].message, /cannot exceed/)
  assert.match(result.issues[3].message, /greater than zero/)
  assert.match(result.issues[4].message, /valid date/)
  assert.match(result.issues[6].message, /Column count/)
  assert.match(result.issues[8].message, /Column count/)
})

test('duplicate invoice numbers inside one file keep the first and flag the rest', () => {
  const result = parse([
    'c1,Acme,INV-1,USD,100,0,2026-01-01,2026-02-01',
    'c1,Acme,INV-1,USD,999,0,2026-01-01,2026-02-01',
  ])
  assert.equal(result.invoices.length, 1)
  assert.equal(result.invoices[0].total.amount, 10000)
  assert.deepEqual(result.issues, [{ row: 3, message: 'Duplicate invoice number in this file.' }])
})

test('quoted commas, BOM and Windows line endings are handled; stray quotes are an error, not silently accepted', () => {
  const text = '﻿' + HEADER + '\r\nc1,"Acme, Ltd",INV-1,USD,10,0,2026-01-01,2026-02-01\r\n'
  const result = parseInvoiceCsv(text, 's', NOW)
  assert.equal(result.invoices[0].customerName, 'Acme, Ltd')
  assert.throws(() => parseInvoiceCsv(HEADER + '\nc1,Ac"me,INV-1,USD,10,0,2026-01-01,2026-02-01', 's', NOW), /quote/)
  assert.throws(() => parseInvoiceCsv(HEADER + '\nc1,"Acme,INV-1,USD,10,0,2026-01-01,2026-02-01', 's', NOW), /unterminated/)
})

test('values are never silently coerced: amounts need a plain decimal form', () => {
  const result = parse([
    'c1,A,INV-1,USD,1e3,0,2026-01-01,2026-02-01',
    'c2,B,INV-2,USD,$100,0,2026-01-01,2026-02-01',
    'c3,C,INV-3,USD,.5,0,2026-01-01,2026-02-01',
    'c4,D,INV-4,USD,007,0,2026-01-01,2026-02-01',
  ])
  assert.equal(result.invoices.length, 0)
  assert.equal(result.issues.length, 4)
})

test('a source identifier and a valid import timestamp are required', () => {
  assert.throws(() => parseInvoiceCsv(HEADER + '\nx', '  ', NOW), /source identifier/)
  assert.throws(() => parseInvoiceCsv(HEADER + '\nx', 's', 'nope'), /Import timestamp/)
})
