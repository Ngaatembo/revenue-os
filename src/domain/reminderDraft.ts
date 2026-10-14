import { formatMoney } from './money.ts'
import type { InvoiceEvidence, Money } from './types.ts'

/** Imported text is untrusted: strip control characters and cap length before it enters a draft. */
export function sanitizeForDraft(value: string, max = 120): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * Deterministic, polite follow-up. Built only from saved invoice fields.
 * It never claims a payment was made or promised, and never threatens.
 * The owner reviews and sends it manually.
 */
export function draftReminderMessage(invoice: InvoiceEvidence, outstanding: Money): string {
  const customer = sanitizeForDraft(invoice.customerName) || 'there'
  const number = sanitizeForDraft(invoice.invoiceNumber, 60)
  const due = invoice.dueAt.slice(0, 10)
  const partial = invoice.paid.amount > 0
    ? ` We have recorded ${formatMoney(invoice.paid)} received so far, leaving a balance of ${formatMoney(outstanding)}.`
    : ` The outstanding amount is ${formatMoney(outstanding)}.`
  return `Hello ${customer}, our records show that invoice ${number} was due on ${due}.${partial} Could you please let us know when we can expect payment? If payment has already been made, please share the confirmation so we can update our records. Thank you.`
}
