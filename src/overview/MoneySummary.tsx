import { formatMoney } from '../domain/money'
import type { agingSummary } from '../domain/prioritization'
import type { Money } from '../domain/types'

type Aging = ReturnType<typeof agingSummary>

type Props = {
  aging: Aging
  invoicesLoaded: boolean
  hasInvoices: boolean
  estimated: Money[]
  verified: Money[]
  recoveryRateKnown: boolean
  onOpen: () => void
}

/** "Owed to you": one hero amount per currency, a labelled list of how late it is, then verified and estimated money kept apart. */
export function MoneySummary({ aging, invoicesLoaded, hasInvoices, estimated, verified, recoveryRateKnown, onOpen }: Props) {
  if (!invoicesLoaded) return <section className="money" aria-label="Owed to you" aria-busy="true"><h2 className="section-title">Owed to you</h2><div className="needs-you-skeleton"><i /><i /></div></section>
  if (!hasInvoices) return null
  return <section className="money" aria-labelledby="owed-title" data-testid="money-summary">
    <div className="section-label"><h2 id="owed-title" className="section-title">Owed to you</h2><button type="button" className="template-link" onClick={onOpen}>See who owes you</button></div>
    {aging.length === 0 && <p className="money-clear">Nothing is overdue. Every unpaid invoice is still within its due date.</p>}
    {aging.map((group) => <div className="money-group" key={group.currency}>
      <p className="money-hero"><span className="money-hero-figure">{formatMoney(group.total)}</span><span className="money-hero-note">overdue · {group.count} invoice{group.count === 1 ? '' : 's'}</span></p>
      <ul className="aging-rows" aria-label={`How late the ${group.currency} balances are`}>
        {group.bands.map((band) => {
          const none = band.amount.amount === 0
          return <li key={band.band} className={none ? 'aging-row is-none' : 'aging-row'}>
            <button type="button" onClick={onOpen} disabled={none}>
              <i className={'aging-dot aging-' + band.band} aria-hidden="true" />
              <span className="aging-label">{band.label}</span>
              <span className="money-figure">{none ? 'None' : formatMoney(band.amount)}</span>
            </button>
          </li>
        })}
      </ul>
    </div>)}
    <dl className="money-lines">
      <div><dt><svg className="verified-check" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="11" /><path d="M7 12.5l3.2 3.2L17 9" /></svg>Verified revenue</dt>
        <dd>{verified.length === 0 ? <span className="money-muted">Nothing confirmed yet</span> : verified.map((total) => <span className="money-figure" key={total.currency}>{formatMoney(total)}</span>)}</dd></div>
      <div><dt><span className="est-mark" aria-hidden="true">Est.</span>Estimated recovery</dt>
        <dd>{estimated.length > 0 ? estimated.map((total) => <span className="money-figure" key={total.currency}>~{formatMoney(total)}</span>) : <span className="money-muted">{recoveryRateKnown ? 'No overdue balances to estimate' : 'Set a recovery rate to see an estimate'}</span>}</dd></div>
    </dl>
    <p className="money-note">Estimates are not revenue and are never added to verified revenue.</p>
  </section>
}
