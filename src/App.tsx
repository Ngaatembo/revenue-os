import { useMemo, useRef, useState, type FormEvent } from 'react'
import StalledOpportunities from './components/StalledOpportunities'
import { buildOverdueOpportunities } from './domain/overdueInvoices'
import { parseInvoiceCsv, type CsvIssue } from './domain/invoiceCsv'
import { addMoney, formatMoney, money } from './domain/money'
import type { InvoiceEvidence, RevenueOpportunity } from './domain/types'
import './App.css'

type Section = 'Overview' | 'Opportunities' | 'Follow-ups' | 'Actions' | 'Outcomes' | 'Business Brain'

const sections: Section[] = ['Overview', 'Opportunities', 'Follow-ups', 'Actions', 'Outcomes', 'Business Brain']
const invoiceCsvHeader = 'customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at\n'

function downloadCsvTemplate() {
  const link = document.createElement('a')
  const url = URL.createObjectURL(new Blob([invoiceCsvHeader], { type: 'text/csv;charset=utf-8' }))
  link.href = url
  link.download = 'revenue-os-invoice-template.csv'
  link.click()
  URL.revokeObjectURL(url)
}

function Icon({ name }: { name: string }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  if (name === 'grid') return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
  if (name === 'spark') return <svg {...common}><path d="m12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></svg>
  if (name === 'check') return <svg {...common}><path d="M20 7 10 17l-5-5"/><circle cx="12" cy="12" r="9"/></svg>
  if (name === 'chart') return <svg {...common}><path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 6-7"/></svg>
  if (name === 'brain') return <svg {...common}><path d="M9 4a3 3 0 0 0-5 2 3 3 0 0 0-1 5 3.5 3.5 0 0 0 2 6 3 3 0 0 0 5 2V4Zm6 0a3 3 0 0 1 5 2 3 3 0 0 1 1 5 3.5 3.5 0 0 1-2 6 3 3 0 0 1-5 2V4Z"/><path d="M9 8H7m2 5H6m9-5h2m-2 5h3M12 4v16"/></svg>
  if (name === 'upload') return <svg {...common}><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>
  return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>
}

function parseRecoveryRate(value: string): number | null {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value.trim())) return null
  const percentage = Number(value)
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null
  return Math.round(percentage * 100)
}

function App() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [activeSection, setActiveSection] = useState<Section>('Overview')
  const [invoices, setInvoices] = useState<InvoiceEvidence[]>([])
  const [issues, setIssues] = useState<CsvIssue[]>([])
  const [sourceName, setSourceName] = useState('')
  const [recoveryRate, setRecoveryRate] = useState('')
  const [error, setError] = useState('')
  const [importNote, setImportNote] = useState('')

  const assumptionBps = parseRecoveryRate(recoveryRate)
  const opportunities = useMemo<RevenueOpportunity[]>(() => {
    if (!invoices.length || assumptionBps === null) return []
    return buildOverdueOpportunities({
      invoices,
      assumption: {
        id: 'session:recovery_rate',
        key: 'recovery_rate',
        valueBps: assumptionBps,
        updatedAt: new Date().toISOString(),
        updatedBy: 'local-session',
      },
      asOf: new Date().toISOString(),
    })
  }, [invoices, assumptionBps])

  const outstandingInvoiceCount = invoices.filter((invoice) => invoice.total.amount > invoice.paid.amount).length
  const estimatedByCurrency = useMemo(() => {
    const totals = new Map<string, ReturnType<typeof money>>()
    for (const opportunity of opportunities) {
      const estimate = opportunity.estimate.low
      totals.set(estimate.currency, totals.has(estimate.currency)
        ? addMoney(totals.get(estimate.currency)!, estimate)
        : estimate)
    }
    return [...totals.values()]
  }, [opportunities])

  async function importFile(file?: File) {
    if (!file) return
    setError('')
    setImportNote('')
    try {
      const text = await file.text()
      const result = parseInvoiceCsv(text, `browser:${file.name}`, new Date().toISOString())
      setInvoices(result.invoices)
      setIssues(result.issues)
      setSourceName(file.name)
      setActiveSection('Overview')
      setImportNote(`${result.invoices.length} invoice record${result.invoices.length === 1 ? '' : 's'} loaded for this browser session.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be imported.')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const title = activeSection === 'Overview' ? 'Revenue overview' : activeSection

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#overview" onClick={() => setActiveSection('Overview')}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span>Revenue<span className="brand-light">OS</span></span>
        </a>
        <div className="workspace-switcher">
          <span className="workspace-avatar">W</span>
          <span className="workspace-copy"><strong>Workspace</strong><small>Local preview</small></span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav">
          {sections.map((section) => {
            const icon = section === 'Overview' ? 'grid' : section === 'Opportunities' ? 'spark' : section === 'Follow-ups' ? 'clock' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : 'brain'
            return <button key={section} className={`nav-item ${activeSection === section ? 'active' : ''}`} onClick={() => setActiveSection(section)}>
              <Icon name={icon} /><span>{section}</span>
              {section === 'Opportunities' && opportunities.length > 0 && <span className="nav-count">{opportunities.length}</span>}
            </button>
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-rule" />
          <div className="user-chip"><span className="user-avatar">U</span><span><strong>Local session</strong><small>Not signed in</small></span><span className="more">···</span></div>
        </div>
      </aside>

      <main className="main-area" id="overview">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-separator">/</span><strong>{activeSection}</strong></div>
          <div className="topbar-right"><span className="connection-state"><i /> No data source connected</span><span className="topbar-avatar">U</span></div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">REVENUE OPERATIONS</p><h1>{title}</h1><p className="page-subtitle">Find, act on, and verify revenue opportunities from your business data.</p></div>
            <button className="button button-primary" onClick={() => fileRef.current?.click()}><Icon name="upload" />Import invoices</button>
            <input ref={fileRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(event) => void importFile(event.target.files?.[0])} />
          </div>

          <div className="preview-banner"><span className="preview-dot" />Local preview <span className="preview-divider">·</span> Imported data stays in this browser tab and is cleared when you leave.</div>

          {error && <div className="alert alert-error" role="alert"><strong>Import failed.</strong> {error}</div>}
          {importNote && <div className="alert alert-success" role="status"><strong>Import complete.</strong> {importNote}</div>}

          {activeSection === 'Overview' || activeSection === 'Opportunities' ? (
            <>
              <section className="metric-grid" aria-label="Revenue summary">
                <article className="metric-card"><div className="metric-top"><span>Open opportunities</span><span className="metric-icon teal"><Icon name="spark" /></span></div><strong className="metric-value">{invoices.length && assumptionBps !== null ? opportunities.length : '—'}</strong><p>{invoices.length ? `${opportunities.length} matched from imported invoice evidence` : 'Connect data to identify opportunities'}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Estimated recovery</span><span className="metric-icon amber"><Icon name="chart" /></span></div><strong className="metric-value metric-money">{estimatedByCurrency.length === 1 ? formatMoney(estimatedByCurrency[0]) : estimatedByCurrency.length > 1 ? 'Multiple currencies' : '—'}</strong><p>{estimatedByCurrency.length ? <>{estimatedByCurrency.length > 1 && <span className="currency-breakdown">{estimatedByCurrency.map((total) => formatMoney(total)).join(' · ')}<br /></span>}Estimate only · not verified revenue</> : 'Requires invoice data and an assumption'}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Verified revenue</span><span className="metric-icon green"><Icon name="check" /></span></div><strong className="metric-value">—</strong><p>Recorded only when payment evidence is matched</p></article>
              </section>

              <section className="work-grid">
                <div className="panel opportunity-panel">
                  <div className="panel-heading"><div><h2>{activeSection === 'Opportunities' ? 'Revenue opportunities' : 'Priority opportunities'}</h2><p>Based on imported records and your stated assumptions.</p></div>{opportunities.length > 0 && <span className="status-pill">{opportunities.length} open</span>}</div>
                  {invoices.length === 0 ? (
                    <div className="empty-state"><span className="empty-icon"><Icon name="upload" /></span><h3>Start with your invoice data</h3><p>Import a CSV to identify overdue invoices. Every opportunity will link back to its source record.</p><button className="button button-secondary" onClick={() => fileRef.current?.click()}>Choose invoice CSV</button><button className="template-link" onClick={downloadCsvTemplate}>Download blank CSV template</button><a className="text-link" href="#csv-format" onClick={(event) => { event.preventDefault(); setActiveSection('Business Brain') }}>View required columns</a></div>
                  ) : assumptionBps === null ? (
                    <div className="assumption-prompt"><div className="assumption-icon"><Icon name="brain" /></div><div><h3>Set a recovery-rate assumption</h3><p>Estimates are calculated from outstanding invoice balances and this assumption. Choose a rate your team can support with evidence.</p><label htmlFor="recovery-rate">Expected recovery rate</label><div className="rate-input-wrap"><input id="recovery-rate" inputMode="decimal" placeholder="e.g. 25" value={recoveryRate} onChange={(event) => setRecoveryRate(event.target.value)} aria-describedby="rate-help"/><span>%</span></div><small id="rate-help">Enter a percentage from 0 to 100. This will be labelled as an estimate.</small>{recoveryRate && parseRecoveryRate(recoveryRate) === null && <small className="field-error">Enter a valid percentage, such as 25 or 12.5.</small>}</div></div>
                  ) : opportunities.length === 0 ? (
                    <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No overdue balances matched</h3><p>{outstandingInvoiceCount ? 'There are outstanding invoices, but none meet the overdue rule as of today.' : 'Imported invoices show no unpaid balances.'}</p></div>
                  ) : (
                    <div className="opportunity-list">{opportunities.map((opportunity) => <OpportunityRow key={opportunity.id} opportunity={opportunity} />)}</div>
                  )}
                </div>

                <aside className="panel brain-panel">
                  <div className="panel-heading"><div><h2>Business Brain</h2><p>Facts and assumptions behind recommendations.</p></div><span className="brain-status">{invoices.length ? 'IN SESSION' : 'NOT CONNECTED'}</span></div>
                  <div className="brain-source"><span className="source-icon"><Icon name="brain" /></span><div><strong>{sourceName || 'No source data yet'}</strong><small>{invoices.length ? `${invoices.length} invoice records · imported for this tab` : 'Import a CSV to add evidence'}</small></div></div>
                  <div className="brain-divider" />
                  <div className="assumption-row"><span><i className="assumption-dot" />Recovery rate</span><strong>{assumptionBps === null ? 'Not set' : `${(assumptionBps / 100).toFixed(2).replace(/\.00$/, '')}%`}</strong></div>
                  <p className="brain-note">Recommendations will show the records and assumptions used to calculate them.</p>
                </aside>
              </section>

              {issues.length > 0 && <section className="panel issues-panel"><div className="panel-heading"><div><h2>Rows needing attention</h2><p>These rows were skipped; correct the source file and re-import.</p></div><span className="issue-count">{issues.length}</span></div><ul>{issues.slice(0, 8).map((issue) => <li key={`${issue.row}-${issue.message}`}><strong>Row {issue.row}</strong><span>{issue.message}</span></li>)}</ul>{issues.length > 8 && <p className="more-issues">And {issues.length - 8} more row issues.</p>}</section>}
            </>
          ) : activeSection === 'Follow-ups' ? <StalledOpportunities />
            : activeSection === 'Actions' ? <ActionCenter opportunities={opportunities} />
            : activeSection === 'Outcomes' ? <OutcomeRegister />
            : <BusinessBrain sourceName={sourceName} invoiceCount={invoices.length} issueCount={issues.length} recoveryRate={recoveryRate} setRecoveryRate={setRecoveryRate} assumptionBps={assumptionBps} onDownload={downloadCsvTemplate} />
          )}

          <footer className="page-footer"><span>Revenue OS</span><span>Estimates and verified revenue are kept separate.</span></footer>
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">{sections.map((section) => <button key={section} className={activeSection === section ? 'active' : ''} onClick={() => setActiveSection(section)} aria-label={section}><Icon name={section === 'Overview' ? 'grid' : section === 'Opportunities' ? 'spark' : section === 'Follow-ups' ? 'clock' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : 'brain'} /><span>{section}</span></button>)}</nav>
    </div>
  )
}

function OpportunityRow({ opportunity }: { opportunity: RevenueOpportunity }) {
  const invoice = opportunity.evidence[0]
  return <article className="opportunity-row"><span className="opportunity-indicator" /><div className="opportunity-main"><div className="opportunity-title"><strong>{invoice.customerName}</strong><span className="overdue-pill">Overdue</span></div><p>Invoice {invoice.invoiceNumber} <span>·</span> Due {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))}</p><small>Source record: {invoice.source.recordId}</small></div><div className="opportunity-values"><strong>{formatMoney(opportunity.outstanding)}</strong><small>outstanding</small><span>Est. {formatMoney(opportunity.estimate.low)}</span></div></article>
}

export default App


type ActionCenterProps = { opportunities: RevenueOpportunity[] }

function ActionCenter({ opportunities }: ActionCenterProps) {
  const [reviewed, setReviewed] = useState<string[]>([])
  const remaining = opportunities.filter((item) => !reviewed.includes(item.id))
  return (
    <section className="panel functional-panel">
      <div className="panel-heading"><div><h2>Action queue</h2><p>Review each overdue invoice before deciding what to do next.</p></div><span className="status-pill">{remaining.length} to review</span></div>
      {opportunities.length === 0 ? (
        <div className="empty-state"><span className="empty-icon"><Icon name="check" /></span><h3>No actions to review yet</h3><p>Import invoice data and set a recovery-rate assumption to generate review tasks.</p></div>
      ) : (
        <div className="functional-list">
          {opportunities.map((item) => {
            const invoice = item.evidence[0]
            const isReviewed = reviewed.includes(item.id)
            return <article className={'functional-row ' + (isReviewed ? 'is-complete' : '')} key={item.id}>
              <div className="functional-row-copy"><strong>{invoice.customerName} · Invoice {invoice.invoiceNumber}</strong><p>Outstanding {formatMoney(item.outstanding)} · estimated recovery {formatMoney(item.estimate.low)}</p><small>Next action: review the invoice and decide whether to contact the customer.</small></div>
              <button className={isReviewed ? 'button button-secondary' : 'button button-primary'} type="button" onClick={() => setReviewed((current) => isReviewed ? current.filter((id) => id !== item.id) : [...current, item.id])}>{isReviewed ? 'Reopen review' : 'Mark reviewed'}</button>
            </article>
          })}
        </div>
      )}
      <p className="functional-note">These are manual review tasks only. Revenue OS does not contact customers or send payments from this screen.</p>
    </section>
  )
}

type OutcomeRecord = { id: string; reference: string; amount: string; currency: string; date: string; evidence: string }

function OutcomeRegister() {
  const [records, setRecords] = useState<OutcomeRecord[]>([])
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [evidence, setEvidence] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  function submitOutcome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const numericAmount = Number(amount)
    if (!reference.trim() || !evidence.trim() || !date || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      setFormError('Enter a reference, a positive amount, a date, and a note describing the payment evidence.')
      return
    }
    setRecords((current) => [{ id: 'outcome-' + Date.now(), reference: reference.trim(), amount: numericAmount.toFixed(2), currency, date, evidence: evidence.trim() }, ...current])
    setReference('')
    setAmount('')
    setEvidence('')
    setFormError('')
    setNotice('Outcome recorded in this tab. It is awaiting independent verification.')
  }

  return (
    <section className="panel functional-panel">
      <div className="panel-heading"><div><h2>Outcome register</h2><p>Record a claimed payment or recovery and the evidence that should be checked.</p></div><span className="brain-status">LOCAL ONLY</span></div>
      <form className="functional-form" onSubmit={submitOutcome}>
        <label className="functional-field">Invoice or customer reference<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="e.g. INV-1042" required maxLength={120} /></label>
        <label className="functional-field">Amount received<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" placeholder="e.g. 150.00" required /></label>
        <label className="functional-field">Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}><option>USD</option><option>ZIG</option><option>ZWL</option><option>ZAR</option><option>GBP</option><option>EUR</option></select></label>
        <label className="functional-field">Payment date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <label className="functional-field functional-field-wide">Evidence note<input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="e.g. receipt number or bank statement reference" required maxLength={240} /></label>
        <div className="functional-form-actions"><button className="button button-primary" type="submit">Record outcome</button><span>Recording does not mean verification is complete.</span></div>
      </form>
      {formError && <p className="functional-error" role="alert">{formError}</p>}
      {notice && <p className="functional-note" role="status">{notice}</p>}
      <div className="panel-heading functional-list-heading"><div><h2>Recorded outcomes</h2><p>Entries remain in memory for this page session only.</p></div><span className="status-pill">{records.length} recorded</span></div>
      {records.length === 0 ? <div className="empty-state compact"><h3>No outcomes recorded</h3><p>Add a payment reference above when you have evidence to review.</p></div> : (
        <div className="functional-list">{records.map((record) => <article className="functional-row" key={record.id}>
          <div className="functional-row-copy"><strong>{record.reference}</strong><p>{record.currency} {record.amount} · {record.date}</p><small>{record.evidence}</small><span className="outcome-pending">Awaiting verification</span></div>
          <button className="button button-secondary" type="button" onClick={() => setRecords((current) => current.filter((item) => item.id !== record.id))}>Remove</button>
        </article>)}</div>
      )}
      <p className="functional-note">No bank, payment-provider, or invoice-system connection is active. Entries are user-reported and are not counted as verified revenue.</p>
    </section>
  )
}

type BusinessBrainProps = {
  sourceName: string
  invoiceCount: number
  issueCount: number
  recoveryRate: string
  setRecoveryRate: (value: string) => void
  assumptionBps: number | null
  onDownload: () => void
}

function BusinessBrain({ sourceName, invoiceCount, issueCount, recoveryRate, setRecoveryRate, assumptionBps, onDownload }: BusinessBrainProps) {
  return (
    <section className="panel functional-panel">
      <div className="panel-heading"><div><h2>Business Brain</h2><p>Inspect the evidence and assumptions used by this local preview.</p></div><span className="brain-status">{invoiceCount ? 'IN SESSION' : 'NO SOURCE'}</span></div>
      <div className="brain-detail-grid">
        <article><span>Imported source</span><strong>{sourceName || 'No CSV imported'}</strong><small>{invoiceCount} invoice record(s) loaded</small></article>
        <article><span>Rows needing attention</span><strong>{issueCount}</strong><small>Skipped during the most recent import</small></article>
        <article><span>Recovery assumption</span><strong>{assumptionBps === null ? 'Not set' : (assumptionBps / 100).toFixed(2).replace(/\.00$/, '') + '%'}</strong><small>Used for estimates only</small></article>
      </div>
      <div className="functional-settings">
        <h3>Recovery-rate assumption</h3>
        <p>Set a percentage from 0 to 100. This changes estimated recovery values; it does not change the amount outstanding.</p>
        <div className="functional-inline-field"><label htmlFor="brain-recovery-rate">Expected recovery rate (%)</label><input id="brain-recovery-rate" inputMode="decimal" value={recoveryRate} onChange={(event) => setRecoveryRate(event.target.value)} placeholder="e.g. 25" /></div>
        {recoveryRate && parseRecoveryRate(recoveryRate) === null && <small className="functional-error">Enter a valid percentage between 0 and 100.</small>}
      </div>
      <div className="format-box"><strong>Required invoice CSV columns</strong><code>customer_id, customer_name, invoice_number, currency, total_amount, paid_amount, issued_at, due_at</code><small>Amounts use a decimal point and up to two decimal places. Currency must be a three-letter code such as USD.</small><div><button className="button button-secondary" type="button" onClick={onDownload}>Download CSV template</button></div></div>
      <p className="functional-note">This page describes the current browser session only. There is no connected database, persistent history, or automatic recommendation execution.</p>
    </section>
  )
}
