import type { ReactNode } from 'react'
import { explainRanking, type AttentionSummary } from './domain/attention/engine'
import type { AttentionItem, Subject } from './domain/attention/types'
import { formatMoney } from './domain/money'

type Props = {
  items: AttentionItem[]
  summary: AttentionSummary
  failedRules: string[]
  /** Renders the interactive invoice row (response, snooze, dismiss controls) for an invoice item. */
  renderInvoice: (opportunityId: string) => ReactNode
  /** Renders the controls for quotation, deposit, task, payment and action items. */
  renderRecord: (subject: Subject) => ReactNode
  onOpenLeads: () => void
  loading: boolean
}

const money = (list: AttentionSummary['knownExposure']) => list.map((item) => formatMoney(item)).join(' · ')

export function AttentionQueue({ items, summary, failedRules, renderInvoice, renderRecord, onOpenLeads, loading }: Props) {
  if (loading) return <div className="empty-state compact" role="status"><h3>Checking what needs you…</h3></div>
  const active = items.filter((item) => !item.snoozed)
  const snoozed = items.filter((item) => item.snoozed)
  return <div className="attention-queue">
    {failedRules.length > 0 && <div className="alert alert-error" role="alert">{failedRules.length} check{failedRules.length === 1 ? '' : 's'} could not run ({failedRules.join(', ')}). Other results are shown; this list may be incomplete.</div>}
    <p className="brain-note">
      {summary.knownExposure.length ? <>Unpaid money behind these items, per your records: <strong>{money(summary.knownExposure)}</strong>. </> : null}
      {summary.pipeline.length ? <>Possible value of leads in the list: <strong>{money(summary.pipeline)}</strong> (not owed and not revenue). </> : null}
      Checked each time you open this page, using the records saved in your workspace. A separate daily background check only refreshes overdue invoices; it sends no messages.
    </p>
    {active.length === 0 && <div className="empty-state compact"><h3>Nothing needs you right now</h3><p>No broken promises, due follow-ups, disputes, stalled leads or unanswered enquiries were found in the records you have saved.{snoozed.length ? ` ${snoozed.length} snoozed item${snoozed.length === 1 ? ' is' : 's are'} listed below; snoozing never removes the unpaid money from your totals.` : ''}</p></div>}
    <div className="opportunity-list">
      {active.map((item, index) => <AttentionCard key={item.id} item={item} rank={index + 1} renderInvoice={renderInvoice} renderRecord={renderRecord} onOpenLeads={onOpenLeads} />)}
    </div>
    {snoozed.length > 0 && <details className="why-details"><summary>Snoozed ({snoozed.length}), still counted</summary>
      <div className="opportunity-list">{snoozed.map((item) => <AttentionCard key={item.id} item={item} rank={0} renderInvoice={renderInvoice} renderRecord={renderRecord} onOpenLeads={onOpenLeads} />)}</div></details>}
  </div>
}

function AttentionCard({ item, rank, renderInvoice, renderRecord, onOpenLeads }: { item: AttentionItem; rank: number; renderInvoice: Props['renderInvoice']; renderRecord: Props['renderRecord']; onOpenLeads: () => void }) {
  const f = item.headline
  const money = item.knownMoney ? `${formatMoney(item.knownMoney)} unpaid` : item.speculativeMoney ? `${formatMoney(item.speculativeMoney)} possible (not owed, not revenue)` : null
  return <article className="attention-card">
    <header><strong>{rank > 0 ? `${rank}. ` : ''}{item.subject.label}</strong>{money && <span className="brain-tag">{money}</span>}{item.snoozedUntil && <span className="brain-tag brain-tag-muted">Snoozed</span>}</header>
    <p><strong>{f.what}</strong></p>
    <p><strong>Why it matters:</strong> {f.why}</p>
    <p><strong>Next step:</strong> {f.nextStep}</p>
    <details className="why-details"><summary>Evidence and ranking</summary>
      <ul>{item.findings.flatMap((finding) => [finding.what, ...finding.evidence]).filter((text, i, all) => all.indexOf(text) === i).map((text) => <li key={text}>{text}</li>)}</ul>
      <p className="issue-note">{explainRanking(item)}</p>
      <ul>{item.ranking.map((part) => <li key={part.name}><strong>{part.name}:</strong> {part.note}</li>)}</ul>
    </details>
    {item.subject.type === 'invoice' ? renderInvoice(item.subject.id) : item.subject.type === 'lead' ? <div className="recovery-action-controls"><button className="button button-secondary" type="button" onClick={onOpenLeads}>Open in Lead Recovery</button></div> : renderRecord(item.subject)}
  </article>
}
