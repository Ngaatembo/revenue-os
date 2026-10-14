import { formatMoney } from './money.ts'
import type { RevenueOpportunity } from './types.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export type UrgencyBand = 1 | 2 | 3 | 4

export type RankedOpportunity = {
  opportunity: RevenueOpportunity
  daysOverdue: number
  urgency: UrgencyBand
  urgencyLabel: string
  /** Plain-language reasons, each derived only from saved invoice fields. */
  reasons: string[]
  /** What we do not know; shown next to every estimate. */
  uncertainty: string
  nextAction: string
}

/** Whole days past due, never negative. Deterministic for a given asOf. */
export function daysOverdue(dueAt: string, asOf: string): number {
  const due = Date.parse(dueAt)
  const now = Date.parse(asOf)
  if (!Number.isFinite(due) || !Number.isFinite(now)) throw new Error('Dates must be valid ISO timestamps.')
  return Math.max(0, Math.floor((now - due) / DAY_MS))
}

export function urgencyFor(days: number): { band: UrgencyBand; label: string } {
  if (days > 60) return { band: 4, label: 'Critical · 60+ days overdue' }
  if (days > 30) return { band: 3, label: 'High · 31–60 days overdue' }
  if (days > 7) return { band: 2, label: 'Medium · 8–30 days overdue' }
  return { band: 1, label: 'Low · up to 7 days overdue' }
}

export type ActionProgress = 'none' | 'proposed' | 'approved' | 'executed'

function nextActionFor(progress: ActionProgress): string {
  if (progress === 'proposed') return 'Review and approve the saved reminder draft.'
  if (progress === 'approved') return 'Send the approved reminder yourself, then record that you sent it.'
  if (progress === 'executed') return 'Import payment evidence and check whether a payment was observed.'
  return 'Draft a polite reminder for your review.'
}

/**
 * Orders opportunities: most urgent band first, then by currency (amounts in
 * different currencies are never compared), then larger outstanding balance, then id.
 */
export function rankOpportunities(
  opportunities: RevenueOpportunity[],
  asOf: string,
  progressByInvoiceId: ReadonlyMap<string, ActionProgress> = new Map(),
): RankedOpportunity[] {
  const ranked = opportunities.map((opportunity) => {
    const invoice = opportunity.evidence[0]
    const days = daysOverdue(invoice.dueAt, asOf)
    const { band, label } = urgencyFor(days)
    const dueText = invoice.dueAt.slice(0, 10)
    const reasons = [
      `Invoice ${invoice.invoiceNumber} was due on ${dueText} and is ${days} day${days === 1 ? '' : 's'} past due.`,
      invoice.paid.amount > 0
        ? `${formatMoney(invoice.paid)} of ${formatMoney(invoice.total)} has been recorded as paid, leaving ${formatMoney(opportunity.outstanding)}.`
        : `No payment is recorded against this ${formatMoney(invoice.total)} invoice.`,
    ]
    return {
      opportunity,
      daysOverdue: days,
      urgency: band,
      urgencyLabel: label,
      reasons,
      uncertainty: 'The estimate is the outstanding balance times your stated recovery rate. It is an assumption, not a prediction or a payment.',
      nextAction: nextActionFor(progressByInvoiceId.get(invoice.id) ?? 'none'),
    }
  })
  return ranked.sort((a, b) =>
    b.urgency - a.urgency
    || a.opportunity.outstanding.currency.localeCompare(b.opportunity.outstanding.currency)
    || b.opportunity.outstanding.amount - a.opportunity.outstanding.amount
    || a.opportunity.id.localeCompare(b.opportunity.id))
}
