import { money } from './money'
import type { CurrencyCode, InvoiceEvidence } from './types'

export type CsvIssue = { row: number; field?: string; message: string }
export type InvoiceCsvResult = { invoices: InvoiceEvidence[]; issues: CsvIssue[] }

const REQUIRED_HEADERS = [
  'customer_id',
  'customer_name',
  'invoice_number',
  'currency',
  'total_amount',
  'paid_amount',
  'issued_at',
  'due_at',
] as const

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_ROWS = 50_000
const MAX_AMOUNT_MINOR = 100_000_000_000 // 1 billion major currency units

function parseRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') {
      if (cell.length !== 0) throw new Error('Unexpected quote in an unquoted CSV field.')
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      cell = ''
      if (rows.length > MAX_ROWS + 1) throw new Error(`CSV may contain at most ${MAX_ROWS} data rows.`)
    } else {
      cell += char
    }
  }

  if (quoted) throw new Error('CSV contains an unterminated quoted field.')
  row.push(cell)
  if (row.some((value) => value.length > 0)) rows.push(row)
  if (rows.length > MAX_ROWS + 1) throw new Error(`CSV may contain at most ${MAX_ROWS} data rows.`)
  return rows
}

function parseAmount(value: string, field: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new Error(`${field} must be a non-negative amount with up to 2 decimal places.`)
  const whole = BigInt(match[1])
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0'))
  const minor = whole * 100n + fraction
  if (minor > BigInt(MAX_AMOUNT_MINOR)) throw new Error(`${field} exceeds the import limit.`)
  return Number(minor)
}

function validDate(value: string, field: string): string {
  const parsed = Date.parse(value)
  if (!value.trim() || !Number.isFinite(parsed)) throw new Error(`${field} must be a valid date.`)
  return new Date(parsed).toISOString()
}

export function parseInvoiceCsv(
  text: string,
  sourceId: string,
  importedAt: string,
): InvoiceCsvResult {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) {
    throw new Error('CSV file exceeds the 10 MB import limit.')
  }
  if (!sourceId.trim()) throw new Error('A source identifier is required.')
  const importedTimestamp = Date.parse(importedAt)
  if (!Number.isFinite(importedTimestamp)) throw new Error('Import timestamp must be a valid date.')

  let rows: string[][]
  try {
    rows = parseRows(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'CSV could not be read.')
  }
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one data row.')

  const headers = rows[0].map((value) => value.trim().toLowerCase())
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header))
  if (missing.length) throw new Error(`Missing required CSV columns: ${missing.join(', ')}.`)
  if (new Set(headers).size !== headers.length) throw new Error('CSV header names must be unique.')
  const indexes = new Map(headers.map((header, index) => [header, index]))
  const invoices: InvoiceEvidence[] = []
  const issues: CsvIssue[] = []
  const seenInvoiceIds = new Set<string>()

  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2
    const value = (field: (typeof REQUIRED_HEADERS)[number]) => row[indexes.get(field)!]?.trim() ?? ''
    try {
      if (row.length !== headers.length) throw new Error('Column count does not match the header.')
      const customerId = value('customer_id')
      const customerName = value('customer_name')
      const invoiceNumber = value('invoice_number')
      if (!customerId || !customerName || !invoiceNumber) {
        throw new Error('Customer ID, customer name, and invoice number are required.')
      }
      const id = `${sourceId}:${invoiceNumber}`
      if (seenInvoiceIds.has(id)) throw new Error('Duplicate invoice number in this file.')
      seenInvoiceIds.add(id)

      const currency = value('currency').toUpperCase() as CurrencyCode
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter ISO code.')
      const total = parseAmount(value('total_amount'), 'total_amount')
      const paid = parseAmount(value('paid_amount'), 'paid_amount')
      if (total <= 0) throw new Error('total_amount must be greater than zero.')
      if (paid > total) throw new Error('paid_amount cannot exceed total_amount.')

      invoices.push({
        id,
        customerId,
        customerName,
        invoiceNumber,
        currency,
        total: money(total, currency),
        paid: money(paid, currency),
        issuedAt: validDate(value('issued_at'), 'issued_at'),
        dueAt: validDate(value('due_at'), 'due_at'),
        source: {
          sourceId,
          recordId: invoiceNumber,
          importedAt: new Date(importedTimestamp).toISOString(),
        },
      })
    } catch (error) {
      issues.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : 'Invalid row.',
      })
    }
  })

  return { invoices, issues }
}
