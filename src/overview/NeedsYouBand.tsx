import { formatAge } from '../connections/catalog.ts'
import type { NeedsYouItem, NeedsYouTarget } from './needsYou.ts'

/** The first thing on Overview: what needs the owner today, ranked, each row one tap from its list. */
export function NeedsYouBand({ items, loading, checkedAt, onOpen }: {
  items: NeedsYouItem[]; loading: boolean; checkedAt: string | null; onOpen: (target: NeedsYouTarget) => void
}) {
  return <section className="needs-you" aria-labelledby="needs-you-title" data-testid="needs-you">
    <div className="needs-you-head"><h2 id="needs-you-title">Needs you today</h2>
      <span className="needs-you-count">{loading ? 'Checking…' : items.length === 0 ? 'All clear' : `${items.length} item${items.length === 1 ? '' : 's'}`}</span></div>
    {loading ? <p className="needs-you-clear" role="status">Checking saved business records…</p>
      : items.length === 0 ? <p className="needs-you-clear" role="status">Nothing needs you right now. Last checked {formatAge(checkedAt)}.</p>
      : <ol className="needs-you-list">{items.map((item) => <li key={item.id}>
        <button type="button" className="needs-you-row" data-kind={item.kind} onClick={() => onOpen(item.target)}>
          <span className="needs-you-body"><strong>{item.title}</strong><small>{item.detail}</small></span>
          <span className={item.basis === 'Observed' ? 'tag-observed' : 'tag-inferred'}>{item.basis}</span>
          <span className="needs-you-go" aria-hidden="true">›</span>
        </button></li>)}</ol>}
  </section>
}
