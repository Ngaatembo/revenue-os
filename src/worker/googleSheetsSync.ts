export type SheetInvoiceRow = {
  id: string
  invoiceNumber: string
  customerId: string
  customerName: string
  currency: string
  totalMinor: number
  paidMinor: number
  issuedAt: string
  dueAt: string
  importedAt: string
}

export type SheetInvoiceParseResult = { rows: SheetInvoiceRow[]; rejectedRows: number }

const REQUIRED = ['customer_id', 'customer_name', 'invoice_number', 'currency', 'total_amount', 'paid_amount', 'issued_at', 'due_at'] as const
const MAX_ROWS = 50000
const MAX_MINOR = 100_000_000_000

function amountMinor(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim())
  if (!match) throw new Error('invalid_amount')
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  if (minor > BigInt(MAX_MINOR)) throw new Error('amount_too_large')
  return Number(minor)
}

function isoDate(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('invalid_date')
  // Google Sheets UNFORMATTED_VALUE returns dates as serial day numbers.
  const serial = /^\\d{4,6}(?:\\.\\d+)?$/.test(normalized) ? Number(normalized) : NaN
  const timestamp = Number.isFinite(serial) ? Math.round((serial - 25569) * 86_400_000) : Date.parse(normalized)
  if (!Number.isFinite(timestamp)) throw new Error('invalid_date')
  return new Date(timestamp).toISOString()
}

/** Converts a Google Sheets values matrix using the same required columns as the CSV importer. */
export function parseSheetInvoiceValues(values: unknown[][], sourceId: string, importedAt: string): SheetInvoiceParseResult {
  if (!Array.isArray(values) || values.length < 2) throw new Error('sheet_needs_header_and_rows')
  if (values.length > MAX_ROWS + 1) throw new Error('sheet_too_many_rows')
  const headers = values[0].map((value) => String(value ?? '').trim().toLowerCase())
  if (new Set(headers).size !== headers.length) throw new Error('duplicate_sheet_headers')
  const missing = REQUIRED.filter((header) => !headers.includes(header))
  if (missing.length) throw new Error('missing_columns:' + missing.join(','))
  const indexes = new Map(headers.map((header, index) => [header, index]))
  const rows: SheetInvoiceRow[] = []
  const seen = new Set<string>()
  let rejectedRows = 0
  for (const valuesRow of values.slice(1)) {
    if (valuesRow.every((cell) => String(cell ?? '').trim() === '')) continue
    try {
      const get = (field: typeof REQUIRED[number]) => String(valuesRow[indexes.get(field)!] ?? '').trim()
      const customerId = get('customer_id')
      const customerName = get('customer_name')
      const invoiceNumber = get('invoice_number')
      const currency = get('currency').toUpperCase()
      if (!customerId || !customerName || !invoiceNumber) throw new Error('missing_identity')
      if (!/^[A-Z]{3,8}$/.test(currency)) throw new Error('invalid_currency')
      const id = sourceId + ':' + invoiceNumber
      if (seen.has(id)) throw new Error('duplicate_invoice')
      const totalMinor = amountMinor(get('total_amount'))
      const paidMinor = amountMinor(get('paid_amount'))
      if (paidMinor > totalMinor) throw new Error('paid_exceeds_total')
      seen.add(id)
      rows.push({
        id, invoiceNumber, customerId, customerName, currency, totalMinor, paidMinor,
        issuedAt: isoDate(get('issued_at')), dueAt: isoDate(get('due_at')), importedAt,
      })
    } catch {
      rejectedRows += 1
    }
  }
  if (rows.length === 0) throw new Error('no_valid_invoice_rows')
  return { rows, rejectedRows }
}
