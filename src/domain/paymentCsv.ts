import type { CsvIssue } from './invoiceCsv'

export type PaymentCsvRow = {
  invoiceNumber: string
  externalRecordId: string
  currency: string
  amountMinor: number
  receivedAt: string
  rowNumber: number
}
export type PaymentCsvResult = { payments: PaymentCsvRow[]; issues: CsvIssue[] }

const REQUIRED = ['invoice_number', 'payment_reference', 'currency', 'amount', 'received_at'] as const
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_ROWS = 50_000
const MAX_AMOUNT_MINOR = 9_000_000_000_000_000

function parseRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1 }
      else if (char === '"') quoted = false
      else cell += char
      continue
    }
    if (char === '"') {
      if (cell.length) throw new Error('Unexpected quote in an unquoted CSV field.')
      quoted = true
    } else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      if (row.some((value) => value.length)) rows.push(row)
      row = []; cell = ''
      if (rows.length > MAX_ROWS + 1) throw new Error('Payment CSV exceeds 50,000 data rows.')
    } else cell += char
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.')
  row.push(cell)
  if (row.some((value) => value.length)) rows.push(row)
  if (rows.length > MAX_ROWS + 1) throw new Error('Payment CSV exceeds 50,000 data rows.')
  return rows
}

function parseAmount(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new Error('amount must be a positive amount with up to 2 decimal places.')
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  if (minor <= 0n || minor > BigInt(MAX_AMOUNT_MINOR)) throw new Error('amount is outside the supported range.')
  return Number(minor)
}

export function parsePaymentCsv(text: string): PaymentCsvResult {
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error('Payment CSV exceeds the 10 MB import limit.')
  const rows = parseRows(text.replace(/^\uFEFF/, ''))
  if (rows.length < 2) throw new Error('Payment CSV must contain a header and at least one data row.')
  const headers = rows[0].map((value) => value.trim().toLowerCase())
  const missing = REQUIRED.filter((header) => !headers.includes(header))
  if (missing.length) throw new Error('Missing required payment columns: ' + missing.join(', ') + '.')
  if (new Set(headers).size !== headers.length) throw new Error('Payment CSV header names must be unique.')
  const indexes = new Map(headers.map((header, index) => [header, index]))
  const payments: PaymentCsvRow[] = []
  const issues: CsvIssue[] = []
  const seen = new Set<string>()
  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2
    const value = (field: (typeof REQUIRED)[number]) => row[indexes.get(field)!]?.trim() ?? ''
    try {
      if (row.length !== headers.length) throw new Error('Column count does not match the header.')
      const invoiceNumber = value('invoice_number')
      const externalRecordId = value('payment_reference')
      const currency = value('currency').toUpperCase()
      if (!invoiceNumber || !externalRecordId) throw new Error('Invoice number and payment reference are required.')
      if (externalRecordId.length > 240) throw new Error('Payment reference exceeds 240 characters.')
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter ISO code.')
      if (seen.has(externalRecordId)) throw new Error('Duplicate payment reference in this file.')
      const received = Date.parse(value('received_at'))
      if (!value('received_at') || !Number.isFinite(received)) throw new Error('received_at must be a valid date.')
      const amountMinor = parseAmount(value('amount'))
      seen.add(externalRecordId)
      payments.push({ invoiceNumber, externalRecordId, currency, amountMinor, receivedAt: new Date(received).toISOString(), rowNumber })
    } catch (error) {
      issues.push({ row: rowNumber, message: error instanceof Error ? error.message : 'Invalid payment row.' })
    }
  })
  return { payments, issues }
}
