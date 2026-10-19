import type { Money } from './types.ts'
import { money } from './money.ts'

export type QuotationStatus = 'sent' | 'accepted' | 'declined' | 'withdrawn'
export type Quotation = {
  id: string; reference: string; customerName: string; currency: string; amountMinor: number
  status: QuotationStatus; sentOn: string; validUntil: string | null; followUpDate: string | null; lastContactOn: string | null
  ownerId: string | null; notes: string | null
}
export type DepositStatus = 'promised' | 'received_unverified' | 'received_verified' | 'cancelled'
export type Deposit = {
  id: string; quotationId: string | null; customerName: string; currency: string; amountMinor: number
  status: DepositStatus; promisedDate: string; ownerConfirmedMinor: number | null; ownerConfirmedOn: string | null
}
export type TaskRelatedType = 'opportunity' | 'quotation' | 'deposit' | 'lead' | 'action' | 'payment_review'
export type Task = {
  id: string; title: string; detail: string | null; dueDate: string; status: 'open' | 'done' | 'cancelled'
  ownerId: string | null; relatedType: TaskRelatedType | null; relatedId: string | null
}
export type PaymentReviewReason = 'invoice_not_found' | 'invoice_ambiguous'
export type PaymentReviewItem = {
  id: string; externalRecordId: string; invoiceNumber: string; currency: string; amountMinor: number; receivedAt: string
  reason: PaymentReviewReason; candidateInvoiceIds: string[]; status: 'pending' | 'resolved' | 'dismissed'; createdAt: string
}
export type WorkspaceMember = { userId: string; email: string; role: string }

/** Whole days from `from` to `to` (date-only strings, UTC). Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10) + 'T00:00:00Z') - Date.parse(from.slice(0, 10) + 'T00:00:00Z')) / 86_400_000)
}

export const quotationMoney = (q: Quotation): Money => money(q.amountMinor, q.currency)
export const depositMoney = (d: Deposit): Money => money(d.amountMinor, d.currency)

/** Integer percentage of an amount in minor units, rounded half up. No floating point. */
export function percentOfMinor(amountMinor: number, percent: number): number {
  if (!Number.isInteger(amountMinor) || amountMinor < 0 || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('Invalid amount or percentage')
  const basisPoints = BigInt(Math.round(percent * 100))
  return Number((BigInt(amountMinor) * basisPoints + 5_000n) / 10_000n)
}

/** Totals per currency; currencies are never mixed. */
export function totalsByCurrency(items: { amountMinor: number; currency: string }[]): Money[] {
  const totals = new Map<string, number>()
  for (const item of items) totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amountMinor)
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => money(amount, currency))
}

/** Parses a money amount typed by a person ("1500", "1,500.50") into minor units. Returns null when it is not a clean positive amount. */
export function parseAmountToMinor(raw: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw.trim().replace(/,/g, ''))
  if (!match) return null
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return minor > 0n && minor <= 9_000_000_000_000_000n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null
}
