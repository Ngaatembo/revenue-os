import type { BusinessSignal } from './businessSignals.ts'
import type { InvoiceEvidence } from './types.ts'
import type { Quotation, Task } from './records.ts'

/**
 * Translate saved workspace records into the provider-neutral business-signal contract.
 * Callers must load records through the existing organization-authorized data layer.
 * Name-only matches remain in review; a shared customer name is not a safe identity key.
 */
export function overdueInvoiceSignals(invoices: InvoiceEvidence[], organizationId: string, asOf: string): BusinessSignal[] {
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
    if (!dueAt || !issuedAt || !importedAt || !invoice.id.trim() || !invoice.customerId.trim()
      || !invoice.source.sourceId.trim() || !invoice.source.recordId.trim()
      || !Number.isFinite(total) || !Number.isFinite(paid) || total <= 0 || paid < 0 || paid >= total
      || invoice.total.currency !== invoice.paid.currency || !invoice.currency.trim()
      || invoice.total.currency !== invoice.currency) return []
    if (Date.parse(dueAt) >= asOfMs) return []
    return [{
      organizationId, sourceId: invoice.source.sourceId, provider: 'unknown', type: 'invoice_overdue',
      idempotencyKey: `invoice-overdue:${invoice.source.recordId}:${dueAt.slice(0, 10)}`,
      occurredAt: dueAt, observedAt: importedAt,
      customer: { status: 'matched', customerId: invoice.customerId, method: 'exact_identifier' },
      evidence: { externalRecordId: invoice.source.recordId, description: `Invoice ${invoice.invoiceNumber} is past due with ${invoice.currency} ${(outstanding / 100).toFixed(2)} outstanding in the imported invoice record.` },
      confidence: 1, reviewState: 'ready',
      summary: `Invoice ${invoice.invoiceNumber} is overdue in the connected records.`,
    } satisfies BusinessSignal]
  })
}

/** Sent quotations become timeline signals; customer identity stays review-only until confirmed. */
export function quotationSignals(quotations: Quotation[], organizationId: string, sourceId: string, observedAt: string): BusinessSignal[] {
  assertContext(organizationId, sourceId, observedAt)
  return quotations.flatMap((quotation) => {
    const occurredAt = normalizeTimestamp(quotation.sentOn)
    if (quotation.status !== 'sent' || !occurredAt || !quotation.id.trim() || !quotation.reference.trim()) return []
    if (!Number.isSafeInteger(quotation.amountMinor) || quotation.amountMinor < 0 || !quotation.currency.trim()) return []
    return [{
      organizationId, sourceId, provider: 'manual', type: 'quotation_sent',
      idempotencyKey: `quotation-sent:${quotation.id}:${occurredAt}`,
      occurredAt, observedAt: new Date(observedAt).toISOString(),
      customer: { status: 'unmatched', reason: 'Quotation has a customer name but no confirmed customer identity mapping.' },
      evidence: { externalRecordId: quotation.id, description: `Quotation ${quotation.reference} marked sent for ${quotation.currency} ${(quotation.amountMinor / 100).toFixed(2)}.` },
      confidence: 0.9, reviewState: 'needs_review',
      summary: `Quotation ${quotation.reference} was marked as sent; confirm the customer match before combining it with other source activity.`,
    } satisfies BusinessSignal]
  })
}

/** Open tasks with known due dates are signals, not proof that a customer was contacted. */
export function taskDueSignals(tasks: Task[], organizationId: string, sourceId: string, observedAt: string): BusinessSignal[] {
  assertContext(organizationId, sourceId, observedAt)
  return tasks.flatMap((task) => {
    const dueAt = normalizeTimestamp(task.dueDate)
    if (task.status !== 'open' || !dueAt || !task.id.trim() || !task.title.trim()) return []
    return [{
      organizationId, sourceId, provider: 'manual', type: 'follow_up_due',
      idempotencyKey: `task-due:${task.id}:${dueAt.slice(0, 10)}`,
      occurredAt: dueAt, observedAt: new Date(observedAt).toISOString(),
      customer: { status: 'unmatched', reason: task.relatedType && task.relatedId ? 'Task subject requires the linked record to establish customer identity.' : 'Task has no linked customer record.' },
      evidence: { externalRecordId: task.id, description: `Task “${task.title}” is open and has a due date of ${dueAt.slice(0, 10)}.` },
      confidence: 1, reviewState: 'needs_review',
      summary: `Task “${task.title}” is due; verify its linked business context before treating it as a customer follow-up.`,
    } satisfies BusinessSignal]
  })
}

function assertContext(organizationId: string, sourceId: string, observedAt: string): void {
  if (!organizationId.trim()) throw new Error('organizationId is required')
  if (!sourceId.trim()) throw new Error('sourceId is required')
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('observedAt must be a valid timestamp')
}

function normalizeTimestamp(value: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const candidate = /^\\d{4}-\\d{2}-\\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value
  const parsed = Date.parse(candidate)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}
