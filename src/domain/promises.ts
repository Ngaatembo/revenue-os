import { addMoney, formatMoney, money } from './money.ts'
import { dateOnly } from './issueWorkflow.ts'
import type { Money } from './types.ts'

/** A payment record already saved as evidence (never an estimate or a promise). */
export type PaymentRecord = {
  invoiceId: string
  amount: Money
  receivedAt: string
}

export type PromiseStatus = 'kept' | 'partly_kept' | 'awaiting' | 'broken'

export type PromiseAssessment = {
  status: PromiseStatus
  promised: Money
  /** Payment evidence recorded on this invoice since the promise was recorded. */
  received: Money
  label: string
}

/**
 * Compares a customer's promise with payment evidence. Only saved payment records count as money;
 * the promise itself never does. Payments are counted only if they are in the promised currency,
 * belong to the same invoice and were received on or after the moment the promise was recorded.
 */
export function assessPromise(input: {
  invoiceId: string
  promised: Money
  promisedDate: string
  recordedAt: string
  payments: PaymentRecord[]
  asOf: string
}): PromiseAssessment {
  const since = Date.parse(input.recordedAt)
  if (!Number.isFinite(since)) throw new Error('The promise must have a valid recorded time.')
  let received = money(0, input.promised.currency)
  for (const payment of input.payments) {
    if (payment.invoiceId !== input.invoiceId) continue
    if (payment.amount.currency !== input.promised.currency) continue
    if (Date.parse(payment.receivedAt) < since) continue
    received = addMoney(received, payment.amount)
  }
  const datePassed = input.promisedDate < dateOnly(input.asOf)
  if (received.amount >= input.promised.amount) {
    return { status: 'kept', promised: input.promised, received, label: `Evidence of ${formatMoney(received)} received, covering the ${formatMoney(input.promised)} promised.` }
  }
  if (received.amount > 0) {
    return {
      status: 'partly_kept', promised: input.promised, received,
      label: `${formatMoney(received)} of the ${formatMoney(input.promised)} promised has been received${datePassed ? ' and the promised date has passed' : ''}.`,
    }
  }
  if (datePassed) {
    return { status: 'broken', promised: input.promised, received, label: `Nothing received by ${input.promisedDate}. The ${formatMoney(input.promised)} promise is not backed by payment evidence.` }
  }
  return { status: 'awaiting', promised: input.promised, received, label: `Promised for ${input.promisedDate}. No payment evidence yet.` }
}

/** Total payment evidence recorded per invoice, in the invoice currency only. */
export function paymentsByInvoice(payments: PaymentRecord[]): Map<string, Money[]> {
  const byInvoice = new Map<string, Map<string, Money>>()
  for (const payment of payments) {
    const currencies = byInvoice.get(payment.invoiceId) ?? new Map<string, Money>()
    const current = currencies.get(payment.amount.currency)
    currencies.set(payment.amount.currency, current ? addMoney(current, payment.amount) : payment.amount)
    byInvoice.set(payment.invoiceId, currencies)
  }
  return new Map([...byInvoice.entries()].map(([invoiceId, currencies]) => [invoiceId, [...currencies.values()]]))
}
