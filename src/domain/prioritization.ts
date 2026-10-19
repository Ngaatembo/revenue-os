import { addMoney, formatMoney, money } from './money.ts'
import { attentionReasons, isSnoozed, nextActionForWorkflow, type AttentionReason } from './issueWorkflow.ts'
import type { Money, RevenueOpportunity } from './types.ts'

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
  /** Rules that put this issue in the Urgent queue. Empty means it can wait. */
  attention: AttentionReason[]
  /** Snoozed issues are hidden from Urgent until the snooze ends; the unpaid balance is never hidden. */
  snoozed: boolean
  /** Higher sorts first: the strongest attention rule, or the lateness band when no rule fires. */
  priority: number
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
    const attention = attentionReasons(opportunity, days, asOf)
    const reasons = [
      `Invoice ${invoice.invoiceNumber} was due on ${dueText} and is ${days} day${days === 1 ? '' : 's'} past due.`,
      invoice.paid.amount > 0
        ? `${formatMoney(invoice.paid)} of ${formatMoney(invoice.total)} has been recorded as paid, leaving ${formatMoney(opportunity.outstanding)}.`
        : `No payment is recorded against this ${formatMoney(invoice.total)} invoice.`,
      ...attention.filter((reason) => reason.code !== 'severely_overdue').map((reason) => reason.label),
    ]
    return {
      opportunity,
      daysOverdue: days,
      urgency: band,
      urgencyLabel: label,
      reasons,
      uncertainty: 'The estimate is the outstanding balance times your stated recovery rate. It is an assumption, not a prediction or a payment.',
      nextAction: nextActionForWorkflow(opportunity.workflow, asOf) ?? nextActionFor(progressByInvoiceId.get(invoice.id) ?? 'none'),
      attention,
      snoozed: isSnoozed(opportunity.workflow, asOf),
      priority: Math.max(band, ...attention.map((reason) => reason.rank)),
    }
  })
  return ranked.sort((a, b) =>
    b.priority - a.priority
    || b.urgency - a.urgency
    || a.opportunity.outstanding.currency.localeCompare(b.opportunity.outstanding.currency)
    || b.opportunity.outstanding.amount - a.opportunity.outstanding.amount
    || a.opportunity.id.localeCompare(b.opportunity.id))
}

export type AgingBand = { band: UrgencyBand; label: string; amount: Money; count: number }
export type AgingSummary = { currency: string; total: Money; count: number; bands: AgingBand[] }

const BAND_LABELS: Record<UrgencyBand, string> = { 1: '1–7 days', 2: '8–30 days', 3: '31–60 days', 4: '60+ days' }

/**
 * Overdue outstanding balances grouped by how late they are, one summary per currency.
 * Currencies are never added together. Every band is present (possibly zero) so the strip is stable.
 */
export function agingSummary(opportunities: RevenueOpportunity[], asOf: string): AgingSummary[] {
  const byCurrency = new Map<string, Map<UrgencyBand, { amount: Money; count: number }>>()
  for (const opportunity of opportunities) {
    const currency = opportunity.outstanding.currency
    const { band } = urgencyFor(daysOverdue(opportunity.evidence[0].dueAt, asOf))
    const bands = byCurrency.get(currency) ?? new Map<UrgencyBand, { amount: Money; count: number }>()
    const current = bands.get(band) ?? { amount: money(0, currency), count: 0 }
    bands.set(band, { amount: addMoney(current.amount, opportunity.outstanding), count: current.count + 1 })
    byCurrency.set(currency, bands)
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, bands]) => {
      const list = ([1, 2, 3, 4] as UrgencyBand[]).map((band) => ({
        band, label: BAND_LABELS[band],
        amount: bands.get(band)?.amount ?? money(0, currency), count: bands.get(band)?.count ?? 0,
      }))
      return {
        currency,
        total: list.reduce((sum, item) => addMoney(sum, item.amount), money(0, currency)),
        count: list.reduce((sum, item) => sum + item.count, 0),
        bands: list,
      }
    })
}
