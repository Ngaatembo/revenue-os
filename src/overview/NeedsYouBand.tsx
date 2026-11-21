import { useEffect, useRef, useState } from 'react'
import { formatAge } from '../connections/catalog'
import type { NeedsYouItem, NeedsYouTarget } from './needsYou'

type Props = {
  items: NeedsYouItem[]
  loading: boolean
  checkedAt: string | null
  /** Overdue invoices beyond the rows shown. */
  hiddenInvoices: number
  busyOpportunityId: string | null
  onGoto: (target: NeedsYouTarget) => void
  onDraft: (opportunityId: string) => void
  onSnooze: (opportunityId: string) => void
}

/** A short, prioritised action list. Evidence detail stays in the relevant work area. */
export function NeedsYouBand({ items, loading, checkedAt, hiddenInvoices, busyOpportunityId, onGoto, onDraft, onSnooze }: Props) {
  const visibleItems = items.slice(0, 3)

  return <section className="needs-you" aria-labelledby="needs-you-title" data-testid="needs-you">
    <div className="needs-you-head">
      <div>
        <p className="eyebrow">YOUR NEXT STEPS</p>
        <h2 id="needs-you-title">Needs your attention</h2>
        <p className="needs-you-promise">The most important invoices and customer follow-ups to act on next.</p>
      </div>
      <span className="needs-you-count">{loading ? 'Checking…' : items.length === 0 ? 'All clear' : `${items.length} to do`}</span>
    </div>
    {loading
      ? <div className="needs-you-skeleton" role="status" aria-label="Checking saved business records"><i /><i /><i /></div>
      : visibleItems.length === 0
        ? <p className="needs-you-clear" role="status">Nothing needs your attention right now. New overdue invoices and due follow-ups will appear here.</p>
        : <ul className="needs-you-list">{visibleItems.map((item) => <li key={item.id} className="needs-row" data-kind={item.kind}>
          <div className="needs-row-main">
            <div className="needs-row-line1">
              <strong className="needs-row-title">{item.title}</strong>
              {item.figure && <span className="money-figure">{item.figure}</span>}
            </div>
            <p className="needs-row-detail">{item.detail}</p>
          </div>
          <div className="needs-row-actions">
            {item.action.type === 'draft'
              ? <button type="button" className="button button-primary needs-primary" disabled={busyOpportunityId === item.action.opportunityId} onClick={() => onDraft(item.action.opportunityId)}>{busyOpportunityId === item.action.opportunityId ? 'Preparing…' : item.action.label}</button>
              : <button type="button" className="button button-secondary needs-primary" onClick={() => onGoto(item.action.target)}>{item.action.label}</button>}
            {item.snoozeOpportunityId && <RowMenu label={`More actions for ${item.title}`}
              items={[
                { label: 'Snooze 7 days', run: () => onSnooze(item.snoozeOpportunityId as string) },
                { label: 'Record a response or dismiss…', run: () => onGoto(item.detailsTarget) },
              ]} />}
          </div>
        </li>)}</ul>}
    {!loading && (hiddenInvoices > 0 || items.length > visibleItems.length) && <button type="button" className="needs-more" onClick={() => onGoto('Urgent')}>View the full attention queue</button>}
    {!loading && items.length > 0 && <p className="needs-you-updated">Based on your saved records · checked {formatAge(checkedAt)}</p>}
  </section>
}

function RowMenu({ label, items }: { label: string; items: Array<{ label: string; run: () => void }> }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') setOpen(false); return }
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])
  return <div className="row-menu" ref={root}>
    <button type="button" className="row-menu-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
    </button>
    {open && <div className="row-menu-list" role="menu">{items.map((entry) => <button key={entry.label} type="button" role="menuitem" onClick={() => { setOpen(false); entry.run() }}>{entry.label}</button>)}</div>}
  </div>
}
