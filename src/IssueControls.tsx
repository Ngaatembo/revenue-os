import { useState, type FormEvent } from 'react'
import { WORKFLOW_LABELS, dateOnly, isSnoozed } from './domain/issueWorkflow'
import { formatMoney } from './domain/money'
import { assessPromise, type PaymentRecord } from './domain/promises'
import type { RevenueOpportunity } from './domain/types'
import type { InvoiceInteraction } from './lib/supabaseRest'
import { RESPONSE_TYPES, type InvoiceResponseType, type IssueTransition } from './lib/opportunityQueries'

export type ResponseFormValues = {
  type: InvoiceResponseType
  summary: string
  promisedAmount: string
  promisedDate: string
  nextFollowUp: string
}

type Props = {
  opportunity: RevenueOpportunity
  interactions: InvoiceInteraction[]
  payments: PaymentRecord[]
  /** False when opportunities are only calculated live and not yet saved: nothing can be recorded against them. */
  canWrite: boolean
  busy: boolean
  onRecord: (values: ResponseFormValues) => Promise<string | null>
  onTransition: (transition: IssueTransition, options?: { reason?: string; snoozeUntil?: string }) => Promise<string | null>
}

const fmtDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value.length === 10 ? value + 'T00:00:00Z' : value))
const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const typeLabel = (type: InvoiceResponseType) => RESPONSE_TYPES.find((item) => item.type === type)?.label ?? type

export function IssueControls({ opportunity, interactions, payments, canWrite, busy, onRecord, onTransition }: Props) {
  const [mode, setMode] = useState<'none' | 'respond' | 'dismiss'>('none')
  const [form, setForm] = useState<ResponseFormValues>({ type: 'customer_replied', summary: '', promisedAmount: '', promisedDate: '', nextFollowUp: plusDays(3) })
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const workflow = opportunity.workflow
  const mine = interactions.filter((interaction) => interaction.opportunityId === opportunity.id)
  const latestPromise = mine.find((interaction) => interaction.type === 'promised_to_pay')
  const asOf = new Date().toISOString()
  const assessment = workflow?.promisedAmount && workflow.promisedDate && latestPromise
    ? assessPromise({ invoiceId: opportunity.evidence[0].id, promised: workflow.promisedAmount, promisedDate: workflow.promisedDate, recordedAt: latestPromise.createdAt, payments, asOf })
    : null
  const recorded = payments.filter((payment) => payment.invoiceId === opportunity.evidence[0].id && payment.amount.currency === opportunity.outstanding.currency)
  const recordedTotal = recorded.reduce((sum, payment) => sum + payment.amount.amount, 0)
  const snoozedUntil = workflow?.snoozedUntil && isSnoozed(workflow, asOf) ? workflow.snoozedUntil : null

  async function submitResponse(event: FormEvent) {
    event.preventDefault()
    setError('')
    const message = await onRecord(form)
    if (message) { setError(message); return }
    setMode('none')
    setForm({ type: 'customer_replied', summary: '', promisedAmount: '', promisedDate: '', nextFollowUp: plusDays(3) })
  }

  async function run(transition: IssueTransition, options?: { reason?: string; snoozeUntil?: string }) {
    setError('')
    const message = await onTransition(transition, options)
    if (message) setError(message)
    else { setMode('none'); setReason('') }
  }

  return <div className="issue-controls">
    {workflow && <p className="issue-state">
      <span className={'issue-pill issue-pill-' + workflow.state}>{WORKFLOW_LABELS[workflow.state]}</span>
      {workflow.nextFollowUp && <span>Next follow-up {fmtDate(workflow.nextFollowUp)}</span>}
      {snoozedUntil && <span>Snoozed until {fmtDate(snoozedUntil)}</span>}
    </p>}
    {assessment && <p className={'issue-promise issue-promise-' + assessment.status}>
      <strong>Promise (not money received):</strong> {assessment.label}
    </p>}
    {recordedTotal > 0 && <p className="issue-evidence">
      Payment evidence recorded on this invoice: <strong>{formatMoney({ amount: recordedTotal, currency: opportunity.outstanding.currency } as typeof opportunity.outstanding)}</strong>. The invoice balance above still comes from your last invoice import; re-import invoices to reconcile it.
    </p>}
    {canWrite ? <div className="recovery-action-controls issue-buttons">
      <button className="button button-secondary" type="button" aria-expanded={mode === 'respond'} onClick={() => { setMode(mode === 'respond' ? 'none' : 'respond'); setError('') }}>Record response</button>
      {(!workflow || workflow.state === 'new') && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run('acknowledge')}>Acknowledge</button>}
      {snoozedUntil
        ? <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run('unsnooze')}>End snooze</button>
        : <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run('snooze', { snoozeUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() })}>Snooze 7 days</button>}
      <button className="button button-quiet" type="button" aria-expanded={mode === 'dismiss'} onClick={() => { setMode(mode === 'dismiss' ? 'none' : 'dismiss'); setError('') }}>Dismiss…</button>
    </div> : <small className="issue-note">Responses can be recorded once this issue is saved to your workspace.</small>}

    {mode === 'respond' && <form className="issue-form" onSubmit={(event) => void submitResponse(event)}>
      <label>What happened
        <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as InvoiceResponseType })}>
          {RESPONSE_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
        </select>
      </label>
      <label>Details (what was said, by whom, how)
        <textarea required minLength={3} maxLength={1000} rows={3} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} />
      </label>
      {form.type === 'promised_to_pay' && <div className="issue-form-row">
        <label>Amount promised ({opportunity.outstanding.currency})
          <input required inputMode="decimal" placeholder="e.g. 250.00" value={form.promisedAmount} onChange={(event) => setForm({ ...form, promisedAmount: event.target.value })} />
        </label>
        <label>Promised by
          <input required type="date" min={dateOnly(asOf)} value={form.promisedDate} onChange={(event) => setForm({ ...form, promisedDate: event.target.value })} />
        </label>
      </div>}
      {form.type !== 'note' && form.type !== 'paid_claimed' && form.type !== 'promised_to_pay' && <label>Follow up on
        <input required type="date" min={dateOnly(asOf)} value={form.nextFollowUp} onChange={(event) => setForm({ ...form, nextFollowUp: event.target.value })} />
      </label>}
      <small className="issue-note">A promise or a claim of payment is recorded as what the customer said. It does not change the invoice or count as revenue; only imported payment evidence does.</small>
      <div className="recovery-action-controls">
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save response'}</button>
        <button className="button button-quiet" type="button" onClick={() => setMode('none')}>Cancel</button>
      </div>
    </form>}

    {mode === 'dismiss' && <form className="issue-form" onSubmit={(event) => { event.preventDefault(); void run('dismiss', { reason }) }}>
      <label>Why is this not a real problem?
        <input required minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Related party, settled outside the system" />
      </label>
      <small className="issue-note">Dismissing removes it from your attention queue. The invoice stays unpaid in your records and remains listed under dismissed issues, where you can reopen it.</small>
      <div className="recovery-action-controls">
        <button className="button button-primary" type="submit" disabled={busy}>Dismiss with reason</button>
        <button className="button button-quiet" type="button" onClick={() => setMode('none')}>Cancel</button>
      </div>
    </form>}

    {error && <div className="alert alert-error" role="alert">{error}</div>}

    {mine.length > 0 && <details className="why-details">
      <summary>Conversation history ({mine.length})</summary>
      <ul className="issue-history">{mine.map((interaction) => <li key={interaction.id}>
        <strong>{typeLabel(interaction.type)}</strong> · {fmtDate(interaction.createdAt)}
        {interaction.promisedAmountMinor !== null && interaction.promisedDate && <> · promised {formatMoney({ amount: interaction.promisedAmountMinor, currency: opportunity.outstanding.currency } as typeof opportunity.outstanding)} by {fmtDate(interaction.promisedDate)}</>}
        <br />{interaction.summary}
      </li>)}</ul>
    </details>}
  </div>
}
