import { useEffect, useRef, useState } from 'react'
import { formatAge } from '../connections/catalog.ts'
import type { NeedsYouItem, NeedsYouTarget } from './needsYou.ts'

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

/** The first thing on Overview: what needs the owner today, ranked. Each row has one primary action; the rest sit in a menu. */
export function NeedsYouBand({ items, loading, checkedAt, hiddenInvoices, busyOpportunityId, onGoto, onDraft, onSnooze }: Props) {
  return <section className="needs-you" aria-labelledby="needs-you-title" data-testid="needs-you">
    <div className="needs-you-head">
      <div><h2 id="needs-you-title">Needs you today</h2>
        <p className="needs-you-promise">You review everything first. Nothing is sent for you.</p></div>
      <span className="needs-you-count">{loading ? 'Checking…' : items.length === 0 ? 'All clear' : `${items.length} to do`}</span>
    </div>
    {loading ? <div className="needs-you-skeleton" role="status" aria-label="Checking saved business records"><i /><i /><i /></div>
      : items.length === 0 ? <p className="needs-you-clear" role="status">You’re clear for today. Last checked {formatAge(checkedAt)}.</p>
      : <ul className="needs-you-list">{items.map((item) => <li key={item.id} className="needs-row" data-kind={item.kind}>
        <div className="needs-row-main">
          <div className="needs-row-line1"><strong className="needs-row-title">{item.title}</strong>{item.figure && <span className="money-figure">{item.figure}</span>}</div>
          <p className="needs-row-detail">{item.detail}</p>
          <span className={item.basis === 'Observed' ? 'tag-observed' : 'tag-inferred'}>{item.basis}</span>
        </div>
        <div className="needs-row-actions">
          {item.action.type === 'draft'
            ? <button type="button" className="button button-primary needs-primary" disabled={busyOpportunityId === item.action.opportunityId} onClick={() => onDraft((item.action as { opportunityId: string }).opportunityId)}>{busyOpportunityId === item.action.opportunityId ? 'Saving…' : item.action.label}</button>
            : <button type="button" className="button button-primary needs-primary" onClick={() => onGoto((item.action as { target: NeedsYouTarget }).target)}>{item.action.label}</button>}
          {item.snoozeOpportunityId && <RowMenu label={`More actions for ${item.title}`}
            items={[
              { label: 'Snooze 7 days', run: () => onSnooze(item.snoozeOpportunityId as string) },
              { label: 'Record a response or dismiss…', run: () => onGoto(item.detailsTarget) },
            ]} />}
        </div>
      </li>)}</ul>}
    {!loading && hiddenInvoices > 0 && <button type="button" className="needs-more" onClick={() => onGoto('Urgent')}>and {hiddenInvoices} more overdue invoice{hiddenInvoices === 1 ? '' : 's'}</button>}
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
