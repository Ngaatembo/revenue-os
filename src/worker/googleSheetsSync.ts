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

const HEADER_ALIASES: Record<typeof REQUIRED[number], string[]> = {
  customer_id: ['customer_id', 'customerid', 'client_id', 'clientid', 'account_id', 'accountid'],
  customer_name: ['customer_name', 'customername', 'client_name', 'clientname', 'customer', 'client', 'account_name', 'accountname', 'name'],
  invoice_number: ['invoice_number', 'invoicenumber', 'invoice_no', 'invoiceno', 'invoice_num', 'invoicenum', 'invoice', 'invoice_id', 'invoiceid', 'reference', 'ref'],
  currency: ['currency', 'currency_code', 'currencycode', 'ccy'],
  total_amount: ['total_amount', 'totalamount', 'invoice_amount', 'invoiceamount', 'amount_due', 'amountdue', 'total', 'gross_amount', 'grossamount'],
  paid_amount: ['paid_amount', 'paidamount', 'amount_paid', 'amountpaid', 'amount_received', 'amountreceived', 'paid', 'payments_received'],
  issued_at: ['issued_at', 'issuedat', 'issue_date', 'issuedate', 'invoice_date', 'invoicedate', 'date_issued', 'dateissued'],
  due_at: ['due_at', 'dueat', 'due_date', 'duedate', 'payment_due_date', 'paymentduedate', 'deadline'],
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function mapHeaders(values: unknown[]): Map<typeof REQUIRED[number], number> {
  const normalized = values.map(normalizeHeader)
  const mapped = new Map<typeof REQUIRED[number], number>()
  const seen = new Set<string>()
  for (const header of normalized) {
    if (!header) continue
    if (seen.has(header)) throw new Error('duplicate_sheet_headers')
    seen.add(header)
  }
  normalized.forEach((header, index) => {
    if (!header) return
    const field = REQUIRED.find((candidate) => HEADER_ALIASES[candidate].some((alias) => normalizeHeader(alias) === header))
    if (!field) return
    if (mapped.has(field)) throw new Error('ambiguous_sheet_headers:' + field)
    mapped.set(field, index)
  })
  const missing = REQUIRED.filter((field) => !mapped.has(field))
  if (missing.length) throw new Error('missing_columns:' + missing.join(','))
  return mapped
}

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
  const serial = /^\d{4,6}(?:\.\d+)?$/.test(normalized) ? Number(normalized) : NaN
  const timestamp = Number.isFinite(serial) ? Math.round((serial - 25569) * 86_400_000) : Date.parse(normalized)
  if (!Number.isFinite(timestamp)) throw new Error('invalid_date')
  return new Date(timestamp).toISOString()
}

/** Maps common spreadsheet header names to the invoice import shape without changing source data. */
export function parseSheetInvoiceValues(values: unknown[][], sourceId: string, importedAt: string): SheetInvoiceParseResult {
  if (!Array.isArray(values) || values.length < 2) throw new Error('sheet_needs_header_and_rows')
  if (values.length > MAX_ROWS + 1) throw new Error('sheet_too_many_rows')
  const indexes = mapHeaders(values[0])
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
