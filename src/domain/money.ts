import type { CurrencyCode, MinorUnits, Money } from './types'

const SAFE_MAX = Number.MAX_SAFE_INTEGER

export function currencyCode(value: string): CurrencyCode {
  const normalized = value.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error('Currency must be a three-letter ISO code.')
  }
  return normalized as CurrencyCode
}

export function minorUnits(value: number): MinorUnits {
  if (!Number.isSafeInteger(value) || Math.abs(value) > SAFE_MAX) {
    throw new Error('Money must be a safe integer number of minor units.')
  }
  return value as MinorUnits
}

export function money(amount: number, currency: string): Money {
  return { amount: minorUnits(amount), currency: currencyCode(currency) }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right)
  return money(left.amount + right.amount, left.currency)
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right)
  return money(left.amount - right.amount, left.currency)
}

export function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new Error(`Currency mismatch: ${left.currency} and ${right.currency}.`)
  }
}

export function formatMoney(value: Money, locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
  }).format(value.amount / 100)
}

/** Exact rounded multiplication by basis points, without floating-point currency. */
export function multiplyByBps(value: Money, bps: number): Money {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('Basis points must be an integer from 0 to 10,000.')
  }
  const product = BigInt(value.amount) * BigInt(bps)
  const rounded = (product + 5_000n) / 10_000n
  const result = Number(rounded)
  return money(result, value.currency)
}
