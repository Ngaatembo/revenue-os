import type { BusinessSignal } from './businessSignals.ts'
import type { InvoiceEvidence } from './types.ts'

/**
 * Translate existing invoice evidence into the provider-neutral signal contract.
 * This is deliberately a pure mapper: callers must load organization-scoped records
 * through the existing authorized data-access layer before invoking it.
 *
 * InvoiceEvidence currently carries a source ID but not its provider kind. Keep the
 * provider explicitly unknown until the source connection model can supply that
 * fact; never label a Google Sheets/CSV record as an accounting integration by guess.
 */
export function overdueInvoiceSignals(
  invoices: InvoiceEvidence[],
  organizationId: string,
  asOf: string,
): BusinessSignal[] {
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(asOfMs)) throw new Error('asOf must be a valid timestamp')
  if (!organizationId.trim()) throw new Error('organizationId is required')

  return invoices.flatMap((invoice) => {
    const dueAt = normalizeTimestamp(invoice.dueAt)
    const issuedAt = normalizeTimestamp(invoice.issuedAt)
    const importedAt = normalizeTimestamp(invoice.source.importedAt)
    const total = invoice.total.amount
    const paid = invoice.paid.amount
    const outstanding = total - paid

    // Incomplete or contradictory records are omitted instead of generating false alerts.
    if (!dueAt || !issuedAt || !importedAt || !invoice.id.trim() || !invoice.customerId.trim()
      || !invoice.source.sourceId.trim() || !invoice.source.recordId.trim()
      || !Number.isFinite(total) || !Number.isFinite(paid) || total <= 0 || paid < 0 || paid >= total
      || invoice.total.currency !== invoice.paid.currency || !invoice.currency.trim()
      || invoice.total.currency !== invoice.currency) return []

    if (Date.parse(dueAt) >= asOfMs) return []

    return [{
      organizationId,
      sourceId: invoice.source.sourceId,
      provider: 'unknown',
      type: 'invoice_overdue',
      idempotencyKey: `invoice-overdue:${invoice.source.recordId}:${dueAt.slice(0, 10)}`,
      occurredAt: dueAt,
      observedAt: importedAt,
      customer: { status: 'matched', customerId: invoice.customerId, method: 'exact_identifier' },
      evidence: {
        externalRecordId: invoice.source.recordId,
        description: `Invoice ${invoice.invoiceNumber} is past due with ${invoice.currency} ${(outstanding / 100).toFixed(2)} outstanding in the imported invoice record.`,
      },
      confidence: 1,
      reviewState: 'ready',
      summary: `Invoice ${invoice.invoiceNumber} is overdue in the connected records.`,
    } satisfies BusinessSignal]
  })
}

function normalizeTimestamp(value: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const candidate = /^\\d{4}-\\d{2}-\\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value
  const parsed = Date.parse(candidate)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}
