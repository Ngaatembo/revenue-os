import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { formatMoney, money } from './domain/money'
import { parseAmountToMinor, totalsByCurrency, type Deposit, type PaymentReviewItem, type Quotation, type Task, type WorkspaceMember } from './domain/records'
import type { InvoiceEvidence } from './domain/types'
import { assignQuotation, createDeposit, createQuotation, createTask, newRecordId, recordQuotationEvent, resolvePaymentReview, updateDeposit, updateTask, type SupabaseSession } from './lib/supabaseRest'
import type { BusinessRecords } from './useBusinessRecords'

export type RecordsCtx = { session: SupabaseSession; organizationId: string; members: WorkspaceMember[]; invoices: InvoiceEvidence[]; deposits: Deposit[]; reload: () => void }

const today = () => new Date().toISOString().slice(0, 10)
const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const fmtDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value + 'T00:00:00Z')) : 'none'
const who = (members: WorkspaceMember[], id: string | null) => id ? (members.find((m) => m.userId === id)?.email ?? 'a former member') : 'Nobody (unowned)'

/** Runs a change once at a time, shows a plain error if it fails, and refreshes every list afterwards. */
function useChange(reload: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function run(change: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false
    setBusy(true); setError('')
    try { await change(); reload(); return true } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change was not saved.'); return false } finally { setBusy(false) }
  }
  return { busy, error, run }
}
const ErrorLine = ({ error }: { error: string }) => error ? <div className="alert alert-error" role="alert">{error}</div> : null
const OwnerSelect = ({ members, value, onChange, label = 'Owner' }: { members: WorkspaceMember[]; value: string; onChange: (v: string) => void; label?: string }) =>
  <label>{label}<select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Nobody yet</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.email} ({m.role})</option>)}</select></label>

// ------------------------------------------------------------------ quotations
export function QuotationRow({ q, ctx, compact = false }: { q: Quotation; ctx: RecordsCtx; compact?: boolean }) {
  const { busy, error, run } = useChange(ctx.reload)
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<'follow_up_sent' | 'customer_replied' | 'rescheduled' | 'accepted' | 'declined' | 'withdrawn' | 'reopened' | 'note'>(q.status === 'sent' ? 'follow_up_sent' : 'reopened')
  const [summary, setSummary] = useState('')
  const [next, setNext] = useState(plusDays(3))
  const closed = q.status !== 'sent'
  const needsDate = ['follow_up_sent', 'customer_replied', 'rescheduled', 'reopened'].includes(type)
  const options = closed ? [['reopened', 'Reopen (customer came back)'], ['note', 'Add a note']] : [['follow_up_sent', 'I followed up'], ['customer_replied', 'Customer replied'], ['rescheduled', 'Move the follow-up date'], ['accepted', 'Customer accepted'], ['declined', 'Customer declined'], ['withdrawn', 'We withdrew it'], ['note', 'Add a note']]
  async function submit(event: FormEvent) {
    event.preventDefault()
    const ok = await run(() => recordQuotationEvent(ctx.session, { organizationId: ctx.organizationId, quotationId: q.id, type, summary, nextFollowUp: needsDate ? next : undefined }))
    if (ok) { setSummary(''); setOpen(false) }
  }
  return <article className={compact ? 'record-compact' : 'attention-card'} data-testid={`quotation-${q.id}`}>
    {!compact && <>
    <header><strong>{q.customerName} · {q.reference}</strong><span className="brain-tag">{formatMoney(money(q.amountMinor, q.currency))}</span><span className="brain-tag brain-tag-muted">{q.status === 'sent' ? 'Open' : q.status}</span></header>
    <p>Sent {fmtDate(q.sentOn)}{q.validUntil ? ` · valid until ${fmtDate(q.validUntil)}` : ''} · {closed ? 'closed' : `follow up ${fmtDate(q.followUpDate)}`} · last contact {fmtDate(q.lastContactOn)}</p>
    <p className="issue-note">Owner: {who(ctx.members, q.ownerId)}. A quotation is a possible sale, not money owed.</p>
    </>}
    <div className="recovery-action-controls">
      <button className="button button-secondary" type="button" onClick={() => setOpen(!open)}>{open ? 'Close' : closed ? 'Reopen or add note' : 'Record what happened'}</button>
      <label className="inline-select"><span className="sr-only">Assign quotation owner</span><select aria-label={`Owner of quotation ${q.reference}`} value={q.ownerId ?? ''} disabled={busy} onChange={(e) => void run(() => assignQuotation(ctx.session, { organizationId: ctx.organizationId, quotationId: q.id, ownerId: e.target.value || null }))}><option value="">Nobody yet</option>{ctx.members.map((m) => <option key={m.userId} value={m.userId}>{m.email}</option>)}</select></label>
    </div>
    {open && <form className="issue-form" onSubmit={(e) => void submit(e)}>
      <label>What happened<select value={type} onChange={(e) => setType(e.target.value as typeof type)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label>Details<input required minLength={3} maxLength={500} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Called, they will decide by Friday" /></label>
      {needsDate && <label>Follow up on<input required type="date" min={today()} value={next} onChange={(e) => setNext(e.target.value)} /></label>}
      <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>}
    <ErrorLine error={error} />
  </article>
}

function NewQuotation({ ctx }: { ctx: RecordsCtx }) {
  const { busy, error, run } = useChange(ctx.reload)
  const blank = { reference: '', customer: '', currency: 'USD', amount: '', sentOn: today(), validUntil: '', followUp: plusDays(7), owner: '' }
  const [f, setF] = useState(blank)
  const [local, setLocal] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocal('')
    const minor = parseAmountToMinor(f.amount)
    if (minor === null) { setLocal('Enter the amount as a positive number such as 1500 or 1500.50.'); return }
    if (!/^[A-Za-z]{3}$/.test(f.currency)) { setLocal('Currency must be a three-letter code such as USD.'); return }
    const ok = await run(() => createQuotation(ctx.session, { organizationId: ctx.organizationId, id: newRecordId('q'), reference: f.reference.trim(), customerName: f.customer.trim(), currency: f.currency.toUpperCase(), amountMinor: minor, sentOn: f.sentOn, validUntil: f.validUntil || undefined, followUpDate: f.followUp, ownerId: f.owner || undefined }))
    if (ok) setF(blank)
  }
  return <form className="issue-form" onSubmit={(e) => void submit(e)} aria-label="Add a quotation">
    <strong>Add a quotation you have sent</strong>
    <div className="issue-form-row"><label>Customer<input required maxLength={160} value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} /></label><label>Quotation reference<input required maxLength={80} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label></div>
    <div className="issue-form-row"><label>Amount<input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1500.00" /></label><label>Currency<input required maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></label></div>
    <div className="issue-form-row"><label>Sent on<input required type="date" max={today()} value={f.sentOn} onChange={(e) => setF({ ...f, sentOn: e.target.value })} /></label><label>Valid until (optional)<input type="date" min={f.sentOn} value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label></div>
    <div className="issue-form-row"><label>Follow up on<input required type="date" min={f.sentOn} value={f.followUp} onChange={(e) => setF({ ...f, followUp: e.target.value })} /></label><OwnerSelect members={ctx.members} value={f.owner} onChange={(owner) => setF({ ...f, owner })} /></div>
    <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save quotation'}</button></div>
    <ErrorLine error={local || error} />
  </form>
}

// ------------------------------------------------------------------ deposits
const DEPOSIT_LABEL: Record<Deposit['status'], string> = { promised: 'Promised, not received', received_unverified: 'You say received, not verified', received_verified: 'Verified by payment record', cancelled: 'Cancelled' }

export function DepositRow({ d, ctx, compact = false }: { d: Deposit; ctx: RecordsCtx; compact?: boolean }) {
  const { busy, error, run } = useChange(ctx.reload)
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<'reschedule' | 'cancel' | 'reopen' | 'confirm_received' | 'note'>(d.status === 'promised' ? 'reschedule' : 'reopen')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(plusDays(3))
  const [amount, setAmount] = useState(String(d.amountMinor / 100))
  const [local, setLocal] = useState('')
  const finished = d.status === 'received_verified' || d.status === 'cancelled'
  const options = d.status === 'promised' ? [['reschedule', 'Move the promised date'], ['confirm_received', 'It arrived (I am telling you; not verified)'], ['cancel', 'Cancel'], ['note', 'Add a note']] : d.status === 'received_unverified' ? [['reopen', 'It did not actually arrive'], ['note', 'Add a note']] : d.status === 'cancelled' ? [['reopen', 'Reopen']] : []
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocal('')
    let receivedMinor: number | undefined
    if (action === 'confirm_received') { const parsed = parseAmountToMinor(amount); if (parsed === null) { setLocal('Enter the amount you received as a positive number.'); return } receivedMinor = parsed }
    const ok = await run(() => updateDeposit(ctx.session, { organizationId: ctx.organizationId, depositId: d.id, action, note, promisedDate: action === 'reschedule' || action === 'reopen' ? date : undefined, receivedMinor, receivedOn: action === 'confirm_received' ? today() : undefined }))
    if (ok) { setNote(''); setOpen(false) }
  }
  return <article className={compact ? 'record-compact' : 'attention-card'} data-testid={`deposit-${d.id}`}>
    {!compact && <>
    <header><strong>{d.customerName} · deposit</strong><span className="brain-tag">{formatMoney(money(d.amountMinor, d.currency))}</span><span className="brain-tag brain-tag-muted">{DEPOSIT_LABEL[d.status]}</span></header>
    <p>{d.status === 'promised' ? `Promised for ${fmtDate(d.promisedDate)}.` : d.status === 'received_unverified' ? `You confirmed ${formatMoney(money(d.ownerConfirmedMinor ?? 0, d.currency))} on ${fmtDate(d.ownerConfirmedOn)}. It becomes verified when an imported payment record covers it.` : d.status === 'received_verified' ? 'A payment record covers this deposit.' : 'No longer expected.'}</p>
    </>}
    {!finished && options.length > 0 || d.status === 'cancelled' ? <div className="recovery-action-controls"><button className="button button-secondary" type="button" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Update this deposit'}</button></div> : null}
    {open && <form className="issue-form" onSubmit={(e) => void submit(e)}>
      <label>What changed<select value={action} onChange={(e) => setAction(e.target.value as typeof action)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      {action === 'confirm_received' && <label>Amount received<input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
      {(action === 'reschedule' || action === 'reopen') && <label>Promised for<input required type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} /></label>}
      <label>Note<input required minLength={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or what the customer said" /></label>
      <small className="issue-note">Saying a deposit arrived does not make it revenue. Only an imported payment record verifies it.</small>
      <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>}
    <ErrorLine error={local || error} />
  </article>
}

function NewDeposit({ ctx, quotations }: { ctx: RecordsCtx; quotations: Quotation[] }) {
  const { busy, error, run } = useChange(ctx.reload)
  const blank = { quotationId: '', customer: '', currency: 'USD', amount: '', date: plusDays(7), note: '' }
  const [f, setF] = useState(blank)
  const [local, setLocal] = useState('')
  const quote = quotations.find((q) => q.id === f.quotationId)
  async function submit(event: FormEvent) {
    event.preventDefault(); setLocal('')
    const minor = parseAmountToMinor(f.amount)
    if (minor === null) { setLocal('Enter the amount as a positive number such as 300 or 300.50.'); return }
    const ok = await run(() => createDeposit(ctx.session, { organizationId: ctx.organizationId, id: newRecordId('d'), quotationId: f.quotationId || undefined, customerName: quote ? undefined : f.customer.trim(), currency: quote ? undefined : f.currency.toUpperCase(), amountMinor: minor, promisedDate: f.date, note: f.note || undefined }))
    if (ok) setF(blank)
  }
  return <form className="issue-form" onSubmit={(e) => void submit(e)} aria-label="Record a promised deposit">
    <strong>Record a deposit a customer has promised</strong>
    <label>For quotation (optional)<select value={f.quotationId} onChange={(e) => setF({ ...f, quotationId: e.target.value })}><option value="">Not linked to a quotation</option>{quotations.filter((q) => q.status !== 'declined' && q.status !== 'withdrawn').map((q) => <option key={q.id} value={q.id}>{q.customerName} · {q.reference} · {formatMoney(money(q.amountMinor, q.currency))}</option>)}</select></label>
    {!quote && <div className="issue-form-row"><label>Customer<input required maxLength={160} value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} /></label><label>Currency<input required maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></label></div>}
    <div className="issue-form-row"><label>Amount promised{quote ? ` (${quote.currency})` : ''}<input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label><label>Promised for<input required type="date" min={today()} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label></div>
    <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save deposit'}</button></div>
    <ErrorLine error={local || error} />
  </form>
}

// ------------------------------------------------------------------ tasks
export function TaskRow({ t, ctx, compact = false }: { t: Task; ctx: RecordsCtx; compact?: boolean }) {
  const { busy, error, run } = useChange(ctx.reload)
  const [mode, setMode] = useState<'none' | 'reschedule' | 'complete' | 'reopen' | 'cancel'>('none')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(plusDays(2))
  const overdue = t.status === 'open' && t.dueDate < today()
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'none') return
    const ok = await run(() => updateTask(ctx.session, { organizationId: ctx.organizationId, taskId: t.id, action: mode, note, dueDate: mode === 'reschedule' || mode === 'reopen' ? date : undefined }))
    if (ok) { setMode('none'); setNote('') }
  }
  return <article className={compact ? 'record-compact' : 'attention-card'} data-testid={`task-${t.id}`}>
    {!compact && <>
    <header><strong>{t.title}</strong><span className="brain-tag brain-tag-muted">{t.status === 'open' ? (overdue ? 'Overdue' : 'Open') : t.status}</span></header>
    <p>Due {fmtDate(t.dueDate)} · Owner: {who(ctx.members, t.ownerId)}{t.detail ? ` · ${t.detail}` : ''}</p>
    </>}
    <div className="recovery-action-controls">
      {t.status === 'open' ? <>
        <button className="button button-secondary" type="button" onClick={() => setMode('complete')}>Done</button>
        <button className="button button-quiet" type="button" onClick={() => setMode('reschedule')}>Move date</button>
        <button className="button button-quiet" type="button" onClick={() => setMode('cancel')}>Cancel task</button>
        <label className="inline-select"><span className="sr-only">Assign task owner</span><select aria-label={`Owner of task ${t.title}`} value={t.ownerId ?? ''} disabled={busy || !ctx.members.length} onChange={(e) => e.target.value && void run(() => updateTask(ctx.session, { organizationId: ctx.organizationId, taskId: t.id, action: 'assign', ownerId: e.target.value }))}><option value="">Assign to…</option>{ctx.members.map((m) => <option key={m.userId} value={m.userId}>{m.email}</option>)}</select></label>
      </> : <button className="button button-secondary" type="button" onClick={() => setMode('reopen')}>Reopen</button>}
    </div>
    {mode !== 'none' && <form className="issue-form" onSubmit={(e) => void submit(e)}>
      <label>{mode === 'complete' ? 'What was done' : mode === 'reschedule' ? 'Why is the date moving' : mode === 'cancel' ? 'Why is it cancelled' : 'Why is it reopened'}<input required minLength={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {(mode === 'reschedule' || mode === 'reopen') && <label>New due date<input required type="date" min={today()} value={date} onChange={(e) => setDate(e.target.value)} /></label>}
      <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button className="button button-quiet" type="button" onClick={() => setMode('none')}>Back</button></div>
    </form>}
    <ErrorLine error={error} />
  </article>
}

function NewTask({ ctx }: { ctx: RecordsCtx }) {
  const { busy, error, run } = useChange(ctx.reload)
  const blank = { title: '', detail: '', due: plusDays(2), owner: '' }
  const [f, setF] = useState(blank)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const ok = await run(() => createTask(ctx.session, { organizationId: ctx.organizationId, id: newRecordId('t'), title: f.title.trim(), detail: f.detail || undefined, dueDate: f.due, ownerId: f.owner || undefined }))
    if (ok) setF(blank)
  }
  return <form className="issue-form" onSubmit={(e) => void submit(e)} aria-label="Add a task">
    <strong>Add a task</strong>
    <label>What needs doing<input required minLength={3} maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
    <div className="issue-form-row"><label>Due<input required type="date" min={today()} value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label><OwnerSelect members={ctx.members} value={f.owner} onChange={(owner) => setF({ ...f, owner })} /></div>
    <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save task'}</button></div>
    <ErrorLine error={error} />
  </form>
}

// ------------------------------------------------------------------ payment review
export function ReviewRow({ p, ctx, compact = false }: { p: PaymentReviewItem; ctx: RecordsCtx; compact?: boolean }) {
  const { busy, error, run } = useChange(ctx.reload)
  const [mode, setMode] = useState<'none' | 'to_invoice' | 'to_deposit' | 'dismiss'>('none')
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const invoiceChoices = useMemo(() => ctx.invoices.filter((i) => i.currency === p.currency && (p.candidateInvoiceIds.length === 0 || p.candidateInvoiceIds.includes(i.id))), [ctx.invoices, p])
  const depositChoices = ctx.deposits.filter((d) => d.currency === p.currency && (d.status === 'promised' || d.status === 'received_unverified'))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'none') return
    const ok = await run(() => resolvePaymentReview(ctx.session, { organizationId: ctx.organizationId, itemId: p.id, action: mode, targetId: mode === 'dismiss' ? undefined : target, note }))
    if (ok) { setMode('none'); setNote('') }
  }
  const amount = formatMoney(money(p.amountMinor, p.currency))
  return <article className={compact ? 'record-compact' : 'attention-card'} data-testid={`review-${p.externalRecordId}`}>
    {!compact && <>
    <header><strong>Payment {p.externalRecordId} · {amount}</strong><span className="brain-tag brain-tag-muted">{p.status === 'pending' ? 'Waiting for you' : p.status}</span></header>
    <p>Received {fmtDate(p.receivedAt.slice(0, 10))} · names invoice “{p.invoiceNumber}”. {p.reason === 'invoice_ambiguous' ? `That number matches ${p.candidateInvoiceIds.length} saved invoices.` : 'No saved invoice has that number in this currency.'}</p>
    </>}
    {p.status === 'pending' && <div className="recovery-action-controls">
      <button className="button button-secondary" type="button" onClick={() => { setMode('to_invoice'); setTarget('') }}>Put on an invoice</button>
      <button className="button button-quiet" type="button" onClick={() => { setMode('to_deposit'); setTarget('') }}>It is a deposit</button>
      <button className="button button-quiet" type="button" onClick={() => setMode('dismiss')}>Not ours / ignore</button>
    </div>}
    {mode !== 'none' && <form className="issue-form" onSubmit={(e) => void submit(e)}>
      {mode === 'to_invoice' && <label>Which invoice<select required value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{invoiceChoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber} · {i.customerName} · {formatMoney(i.total)} (source {i.source.sourceId})</option>)}</select></label>}
      {mode === 'to_deposit' && <label>Which deposit<select required value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{depositChoices.map((d) => <option key={d.id} value={d.id}>{d.customerName} · {formatMoney(money(d.amountMinor, d.currency))}</option>)}</select></label>}
      <label>{mode === 'dismiss' ? 'Why is this being ignored' : 'Note (optional)'}<input required={mode === 'dismiss'} minLength={mode === 'dismiss' ? 3 : 0} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <small className="issue-note">{mode === 'to_invoice' ? 'This records the payment as evidence for that invoice. It does not edit the invoice itself.' : mode === 'to_deposit' ? 'A deposit becomes verified once its payments add up to the promised amount.' : 'The payment stays on file as dismissed, with your reason.'}</small>
      <div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save decision'}</button><button className="button button-quiet" type="button" onClick={() => setMode('none')}>Back</button></div>
    </form>}
    <ErrorLine error={error} />
  </article>
}

// ------------------------------------------------------------------ page
type Tab = 'quotations' | 'deposits' | 'tasks' | 'payments'
export function WorkRecords({ session, organizationId, records, invoices, reload, canWrite }: { session: SupabaseSession; organizationId: string; records: BusinessRecords; invoices: InvoiceEvidence[]; reload: () => void; canWrite: boolean }) {
  const [tab, setTab] = useState<Tab>('quotations')
  const ctx: RecordsCtx = { session, organizationId, members: records.members, invoices, deposits: records.deposits, reload }
  if (records.loading) return <div className="empty-state compact" role="status"><h3>Loading your records…</h3></div>
  if (!records.available) return <div className="empty-state compact"><h3>Quotations, deposits and tasks are not switched on yet</h3><p>They need a database update that has not been applied to this workspace. Nothing is lost; this page works as soon as it is applied.</p></div>
  if (records.error) return <div className="alert alert-error" role="alert"><strong>Could not load these records.</strong> {records.error} Reload the page to try again. This does not mean there are none.</div>
  const pendingReviews = records.reviews.filter((r) => r.status === 'pending')
  const openQuotes = records.quotations.filter((q) => q.status === 'sent')
  const tabs: [Tab, string, number][] = [['quotations', 'Quotations', openQuotes.length], ['deposits', 'Deposits', records.deposits.filter((d) => d.status === 'promised' || d.status === 'received_unverified').length], ['tasks', 'Tasks', records.tasks.filter((t) => t.status === 'open').length], ['payments', 'Payments to review', pendingReviews.length]]
  const section = (children: ReactNode) => <div className="work-records">{children}</div>
  return <section className="panel" aria-label="Quotations, deposits, tasks and payments">
    <div className="panel-heading"><div><h2>Follow-ups and cash</h2><p>Quotations, promised deposits, tasks and payments that could not be matched. The urgent queue reads from here.</p></div></div>
    <div className="work-tabs" role="tablist">{tabs.map(([id, label, count]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'button button-primary' : 'button button-quiet'} type="button" onClick={() => setTab(id)}>{label}{count > 0 ? ` (${count})` : ''}</button>)}</div>
    {tab === 'quotations' && section(<>
      {openQuotes.length > 0 && <p className="brain-note">Open quotations: <strong>{totalsByCurrency(openQuotes).map((m) => formatMoney(m)).join(' · ')}</strong> (possible sales, not money owed).</p>}
      {canWrite && <NewQuotation ctx={ctx} />}
      {records.quotations.length === 0 ? <div className="empty-state compact"><h3>No quotations yet</h3><p>Add the quotations you have sent so Revenue OS can tell you when one goes quiet.</p></div> : <div className="opportunity-list">{records.quotations.map((q) => <QuotationRow key={q.id} q={q} ctx={ctx} />)}</div>}
    </>)}
    {tab === 'deposits' && section(<>
      <p className="brain-note">Promised: <strong>{totalsByCurrency(records.deposits.filter((d) => d.status === 'promised')).map((m) => formatMoney(m)).join(' · ') || 'nothing'}</strong> · Verified by payment records: <strong>{totalsByCurrency(records.deposits.filter((d) => d.status === 'received_verified')).map((m) => formatMoney(m)).join(' · ') || 'nothing'}</strong>. These are never added together.</p>
      {canWrite && <NewDeposit ctx={ctx} quotations={records.quotations} />}
      {records.deposits.length === 0 ? <div className="empty-state compact"><h3>No deposits recorded</h3></div> : <div className="opportunity-list">{records.deposits.map((d) => <DepositRow key={d.id} d={d} ctx={ctx} />)}</div>}
    </>)}
    {tab === 'tasks' && section(<>
      {canWrite && <NewTask ctx={ctx} />}
      {records.tasks.length === 0 ? <div className="empty-state compact"><h3>No tasks yet</h3></div> : <div className="opportunity-list">{records.tasks.map((t) => <TaskRow key={t.id} t={t} ctx={ctx} />)}</div>}
    </>)}
    {tab === 'payments' && section(<>
      <p className="brain-note">Payments land here when their invoice number is missing from your records or matches more than one invoice. They are saved, never dropped, and are not applied to anything until you decide.</p>
      {records.reviews.length === 0 ? <div className="empty-state compact"><h3>No payments are waiting</h3></div> : <div className="opportunity-list">{records.reviews.map((p) => <ReviewRow key={p.id} p={p} ctx={ctx} />)}</div>}
    </>)}
  </section>
}
