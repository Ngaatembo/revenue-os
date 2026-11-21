import { formatMoney, money } from '../domain/money'
import type { InvoiceEvidence } from '../domain/types'

type Props = {
  invoices: InvoiceEvidence[]
  invoicesLoaded: boolean
  onOpen: () => void
}

/** A plain-language collections snapshot calculated directly from invoice records, never from a recovery-rate assumption. */
export function MoneySummary({ invoices, invoicesLoaded, onOpen }: Props) {
  if (!invoicesLoaded) {
    return <section className="money" aria-label="Money overdue" aria-busy="true">
      <div className="needs-you-skeleton"><i /><i /></div>
    </section>
  }
  if (invoices.length === 0) return null

  const now = Date.now()
  const totals = new Map<string, { amount: number; count: number }>()
  for (const invoice of invoices) {
    const outstanding = Math.max(0, invoice.total.amount - invoice.paid.amount)
    const dueAt = Date.parse(invoice.dueAt)
    if (outstanding === 0 || Number.isNaN(dueAt) || dueAt >= now) continue
    const current = totals.get(invoice.currency) ?? { amount: 0, count: 0 }
    totals.set(invoice.currency, { amount: current.amount + outstanding, count: current.count + 1 })
  }

  const rows = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
  const invoiceCount = rows.reduce((sum, [, value]) => sum + value.count, 0)

  return <section className="money" aria-labelledby="overdue-money-title" data-testid="money-summary">
    <div className="money-heading">
      <div>
        <p className="eyebrow">COLLECTIONS</p>
        <h2 id="overdue-money-title" className="section-title">Money overdue</h2>
        <p className="money-description">Invoices past their due date that still have an unpaid balance.</p>
      </div>
      <button type="button" className="button button-secondary" onClick={onOpen}>View overdue invoices</button>
    </div>
    {rows.length === 0
      ? <p className="money-clear">No overdue invoices were found in your saved records.</p>
      : <div className="money-overdue-grid">
        {rows.map(([currency, value]) => <div className="money-overdue-item" key={currency}>
          <strong className="money-overdue-amount">{formatMoney(money(value.amount, currency))}</strong>
          <span>{value.count} overdue invoice{value.count === 1 ? '' : 's'} · {currency}</span>
        </div>)}
      </div>}
    <p className="money-note">Calculated from invoice totals, recorded payments and due dates. This is money still owed, not a recovery estimate.</p>
  </section>
}
