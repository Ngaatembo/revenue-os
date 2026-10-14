import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { buildOverdueOpportunities } from './domain/overdueInvoices'
import { parseInvoiceCsv, type CsvIssue } from './domain/invoiceCsv'
import { parsePaymentCsv } from './domain/paymentCsv'
import { addMoney, formatMoney, money } from './domain/money'
import type { InvoiceEvidence, RevenueOpportunity } from './domain/types'
import { createSalesLead, deleteSalesLead, loadInvoices, loadRecoveryRate, loadSalesLeads, persistInvoiceImport, saveRecoveryRate, sha256Hex, updateSalesLead, type RevenueOrganization, type SalesLead, type SupabaseSession, type RecoveryAction, type VerifiedOutcome, loadRecoveryActions, loadVerifiedOutcomes, persistPaymentImport, proposeInvoiceReminder, transitionRecoveryAction, verifyRecoveryOutcome } from './lib/supabaseRest'
import './App.css'

type Section = 'Overview' | 'Opportunities' | 'Lead Recovery' | 'Actions' | 'Outcomes' | 'Business Brain'

const sections: Section[] = ['Overview', 'Opportunities', 'Lead Recovery', 'Actions', 'Outcomes', 'Business Brain']
const invoiceCsvHeader = 'customer_id,customer_name,invoice_number,currency,total_amount,paid_amount,issued_at,due_at\n'

function downloadCsvTemplate() {
  const link = document.createElement('a')
  const url = URL.createObjectURL(new Blob([invoiceCsvHeader], { type: 'text/csv;charset=utf-8' }))
  link.href = url
  link.download = 'revenue-os-invoice-template.csv'
  link.click()
  URL.revokeObjectURL(url)
}


function downloadPaymentTemplate() {
  const anchor = document.createElement('a')
  const url = URL.createObjectURL(new Blob(['invoice_number,payment_reference,currency,amount,received_at\n'], { type: 'text/csv;charset=utf-8' }))
  anchor.href = url
  anchor.download = 'revenue-os-payment-template.csv'
  anchor.click()
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

type LeadRecord = SalesLead
type LeadStatus = SalesLead['status']

function App({ session, organization, onSignOut }: { session: SupabaseSession; organization: RevenueOrganization; onSignOut: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const paymentFileRef = useRef<HTMLInputElement>(null)
  const [activeSection, setActiveSection] = useState<Section>('Overview')
  const [invoices, setInvoices] = useState<InvoiceEvidence[]>([])
  const [issues, setIssues] = useState<CsvIssue[]>([])
  const [sourceName, setSourceName] = useState('')
  const [recoveryRate, setRecoveryRate] = useState('')
  const [error, setError] = useState('')
  const [importNote, setImportNote] = useState('')
  const [leads, setLeads] = useState<LeadRecord[]>([])
  const [leadLoading, setLeadLoading] = useState(true)
  const [leadError, setLeadError] = useState('')
  const [recoveryActions, setRecoveryActions] = useState<RecoveryAction[]>([])
  const [actionsLoading, setActionsLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [actionNoticeIsError, setActionNoticeIsError] = useState(false)
  const [verifiedOutcomes, setVerifiedOutcomes] = useState<VerifiedOutcome[]>([])
  const [outcomesLoading, setOutcomesLoading] = useState(true)
  const [paymentNotice, setPaymentNotice] = useState('')
  const [paymentNoticeIsError, setPaymentNoticeIsError] = useState(false)
  const [paymentIssues, setPaymentIssues] = useState<CsvIssue[]>([])

  useEffect(() => {
    let cancelled = false
    loadSalesLeads(session, organization.id)
      .then((records) => { if (!cancelled) setLeads(records) })
      .catch((cause) => { if (!cancelled) setLeadError(cause instanceof Error ? cause.message : 'Could not load saved leads.') })
      .finally(() => { if (!cancelled) setLeadLoading(false) })
    return () => { cancelled = true }
  }, [session, organization.id])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadInvoices(session, organization.id), loadRecoveryRate(session, organization.id)])
      .then(([records, savedRate]) => {
        if (cancelled) return
        setInvoices(records)
        setSourceName(records.length ? 'Saved Supabase invoice records' : '')
        if (savedRate !== null) setRecoveryRate((savedRate / 100).toString())
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load saved invoice records.')
      })
    return () => { cancelled = true }
  }, [session, organization.id])

  async function persistRecoveryRate() {
    const bps = parseRecoveryRate(recoveryRate)
    if (bps === null) return
    try {
      await saveRecoveryRate(session, organization, bps)
      setError('')
      setImportNote('Recovery-rate assumption saved to your workspace.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the recovery-rate assumption.')
    }
  }

  useEffect(() => {
    let cancelled = false
    loadRecoveryActions(session, organization.id)
      .then((records) => { if (!cancelled) setRecoveryActions(records) })
      .catch((cause) => { if (!cancelled) { setActionNotice(cause instanceof Error ? cause.message : 'Could not load recovery actions.'); setActionNoticeIsError(true) } })
      .finally(() => { if (!cancelled) setActionsLoading(false) })
    return () => { cancelled = true }
  }, [session, organization.id])

  async function handleProposeReminder(opportunity: RevenueOpportunity) {
    const invoice = opportunity.evidence[0]
    if (!invoice) return
    setActionBusy(invoice.id)
    setActionNotice('')
    setActionNoticeIsError(false)
    const dueDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))
    const message = 'Hello ' + invoice.customerName + ', our records show that invoice ' + invoice.invoiceNumber + ' for ' + formatMoney(opportunity.outstanding) + ' was due on ' + dueDate + '. Could you please let us know when we can expect payment? If payment has already been made, please share the confirmation so we can update our records. Thank you.'
    try {
      await proposeInvoiceReminder(session, organization.id, invoice.id, message)
      setRecoveryActions(await loadRecoveryActions(session, organization.id))
      setActiveSection('Actions')
      setActionNotice('Reminder draft saved. Review and approve it before sending manually.')
    } catch (cause) {
      setActionNotice(cause instanceof Error ? cause.message : 'Could not create the reminder draft.')
      setActionNoticeIsError(true)
    } finally { setActionBusy('') }
  }

  async function handleActionTransition(action: RecoveryAction, transition: 'approve' | 'mark_sent' | 'cancel') {
    setActionBusy(action.id)
    setActionNotice('')
    try {
      await transitionRecoveryAction(session, organization.id, action.id, transition)
      setRecoveryActions(await loadRecoveryActions(session, organization.id))
      setActionNotice(transition === 'approve' ? 'Reminder approved. It has not been sent.' : transition === 'mark_sent' ? 'Marked as manually sent. No message was sent by Revenue OS.' : 'Reminder draft cancelled.')
    } catch (cause) {
      setActionNotice(cause instanceof Error ? cause.message : 'Could not update this action.')
      setActionNoticeIsError(true)
    } finally { setActionBusy('') }
  }

  useEffect(() => {
    let cancelled = false
    loadVerifiedOutcomes(session, organization.id)
      .then((records) => { if (!cancelled) setVerifiedOutcomes(records) })
      .catch((cause) => { if (!cancelled) { setPaymentNotice(cause instanceof Error ? cause.message : 'Could not load verified outcomes.'); setPaymentNoticeIsError(true) } })
      .finally(() => { if (!cancelled) setOutcomesLoading(false) })
    return () => { cancelled = true }
  }, [session, organization.id])

  async function handleImportPayments(file?: File) {
    if (!file) return
    setPaymentNotice('')
    setPaymentNoticeIsError(false)
    setPaymentIssues([])
    try {
      const text = await file.text()
      const parsed = parsePaymentCsv(text)
      setPaymentIssues(parsed.issues)
      if (!parsed.payments.length) {
        setPaymentNotice('No valid payment rows were saved. Correct the row issues and try again.')
        setPaymentNoticeIsError(true)
        return
      }
      const result = await persistPaymentImport(session, organization, {
        sourceId: 'payments:' + file.name.trim().slice(0, 180),
        sourceName: file.name,
        contentHash: await sha256Hex(text),
        payments: parsed.payments,
        rejectedRows: parsed.issues.length,
      })
      setPaymentNotice(result.duplicate ? 'This exact payment file was already imported.' : result.acceptedRows + ' payment record(s) saved as evidence.' + (result.rejectedRows ? ' ' + result.rejectedRows + ' invalid row(s) were skipped.' : ''))
      setVerifiedOutcomes(await loadVerifiedOutcomes(session, organization.id))
    } catch (cause) {
      setPaymentNotice(cause instanceof Error ? cause.message : 'Could not import payment evidence.')
      setPaymentNoticeIsError(true)
    } finally {
      if (paymentFileRef.current) paymentFileRef.current.value = ''
    }
  }

  async function handleVerifyOutcome(action: RecoveryAction) {
    setActionBusy(action.id)
    setPaymentNotice('')
    try {
      const result = await verifyRecoveryOutcome(session, organization.id, action.id, 30)
      setVerifiedOutcomes(await loadVerifiedOutcomes(session, organization.id))
      setPaymentNotice(result.verified ? 'Matched ' + (result.paymentCount ?? 0) + ' payment record(s). The verified outcome is saved; timing does not prove the reminder caused payment.' : result.reason || 'No matching payment evidence was found.')
      setPaymentNoticeIsError(!result.verified)
    } catch (cause) {
      setPaymentNotice(cause instanceof Error ? cause.message : 'Could not verify payment evidence.')
      setPaymentNoticeIsError(true)
    } finally { setActionBusy('') }
  }

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
        updatedBy: organization.userId,
      },
      asOf: new Date().toISOString(),
    })
  }, [invoices, assumptionBps, organization.userId])

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
      const importedAt = new Date().toISOString()
      const sourceId = 'csv:' + file.name.trim().slice(0, 180)
      const result = parseInvoiceCsv(text, sourceId, importedAt)
      setIssues(result.issues)
      setSourceName(file.name)
      setActiveSection('Overview')
      if (result.invoices.length === 0) {
        setImportNote('No valid invoice rows were saved. Review the row issues below and correct the source file.')
        return
      }
      const outcome = await persistInvoiceImport(session, organization, {
        sourceId, sourceName: file.name, contentHash: await sha256Hex(text),
        invoices: result.invoices, rejectedRows: result.issues.length,
      })
      const savedInvoices = await loadInvoices(session, organization.id)
      setInvoices(savedInvoices)
      setImportNote(outcome.duplicate
        ? 'This exact file was already imported. No duplicate invoice records were created.'
        : outcome.acceptedRows + ' invoice record' + (outcome.acceptedRows === 1 ? '' : 's') + ' saved to Supabase.' + (outcome.rejectedRows ? ' ' + outcome.rejectedRows + ' invalid row(s) were skipped.' : ''))
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
          <span className="workspace-copy"><strong>{organization.name}</strong><small>Supabase workspace</small></span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav">
          {sections.map((section) => {
            const icon = section === 'Overview' ? 'grid' : section === 'Opportunities' ? 'spark' : section === 'Lead Recovery' ? 'check' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : 'brain'
            return <button key={section} className={`nav-item ${activeSection === section ? 'active' : ''}`} onClick={() => setActiveSection(section)}>
              <Icon name={icon} /><span>{section}</span>
              {section === 'Opportunities' && opportunities.length > 0 && <span className="nav-count">{opportunities.length}</span>}
            </button>
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-rule" />
          <div className="user-chip"><span className="user-avatar">{(session.user.email?.[0] || 'U').toUpperCase()}</span><span><strong>{session.user.email || 'Signed in'}</strong><small>Workspace member</small></span><span className="more">···</span></div>
        </div>
      </aside>

      <main className="main-area" id="overview">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-separator">/</span><strong>{activeSection}</strong></div>
          <div className="topbar-right"><span className="connection-state"><i /> Supabase connected</span><button className="button button-secondary" type="button" onClick={onSignOut}>Sign out</button><span className="topbar-avatar">{(session.user.email?.[0] || 'U').toUpperCase()}</span></div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div><p className="eyebrow">REVENUE OPERATIONS</p><h1>{title}</h1><p className="page-subtitle">Find, act on, and verify revenue opportunities from your business data.</p></div>
            <button className="button button-primary" onClick={() => fileRef.current?.click()}><Icon name="upload" />Import invoices</button>
            <input ref={fileRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(event) => void importFile(event.target.files?.[0])} />
          </div>

          <div className="preview-banner"><span className="preview-dot" />Workspace connected <span className="preview-divider">·</span> Leads, invoice imports and recovery assumptions sync to Supabase. Actions still require manual approval.</div>

          {error && <div className="alert alert-error" role="alert"><strong>Could not complete the operation.</strong> {error}</div>}
          {importNote && <div className="alert alert-success" role="status"><strong>Saved.</strong> {importNote}</div>}

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
                    <div className="assumption-prompt"><div className="assumption-icon"><Icon name="brain" /></div><div><h3>Set a recovery-rate assumption</h3><p>Estimates are calculated from outstanding invoice balances and this assumption. Choose a rate your team can support with evidence.</p><label htmlFor="recovery-rate">Expected recovery rate</label><div className="rate-input-wrap"><input id="recovery-rate" inputMode="decimal" placeholder="e.g. 25" value={recoveryRate} onChange={(event) => setRecoveryRate(event.target.value)} onBlur={() => void persistRecoveryRate()} aria-describedby="rate-help"/><span>%</span></div><small id="rate-help">Enter a percentage from 0 to 100. This will be labelled as an estimate.</small>{recoveryRate && parseRecoveryRate(recoveryRate) === null && <small className="field-error">Enter a valid percentage, such as 25 or 12.5.</small>}</div></div>
                  ) : opportunities.length === 0 ? (
                    <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No overdue balances matched</h3><p>{outstandingInvoiceCount ? 'There are outstanding invoices, but none meet the overdue rule as of today.' : 'Imported invoices show no unpaid balances.'}</p></div>
                  ) : (
                    <div className="opportunity-list">{opportunities.map((opportunity) => <OpportunityRow key={opportunity.id} opportunity={opportunity} onPropose={() => void handleProposeReminder(opportunity)} proposing={actionBusy === opportunity.evidence[0]?.id} />)}</div>
                  )}
                </div>

                <aside className="panel brain-panel">
                  <div className="panel-heading"><div><h2>Business Brain</h2><p>Facts and assumptions behind recommendations.</p></div><span className="brain-status">{invoices.length ? 'IN SESSION' : 'NOT CONNECTED'}</span></div>
                  <div className="brain-source"><span className="source-icon"><Icon name="brain" /></span><div><strong>{sourceName || 'No source data yet'}</strong><small>{invoices.length ? `${invoices.length} invoice records · saved in Supabase` : 'Import a CSV to add evidence'}</small></div></div>
                  <div className="brain-divider" />
                  <div className="assumption-row"><span><i className="assumption-dot" />Recovery rate</span><strong>{assumptionBps === null ? 'Not set' : `${(assumptionBps / 100).toFixed(2).replace(/\.00$/, '')}%`}</strong></div>
                  <p className="brain-note">Recommendations will show the records and assumptions used to calculate them.</p>
                </aside>
              </section>

              {issues.length > 0 && <section className="panel issues-panel"><div className="panel-heading"><div><h2>Rows needing attention</h2><p>These rows were skipped; correct the source file and re-import.</p></div><span className="issue-count">{issues.length}</span></div><ul>{issues.slice(0, 8).map((issue) => <li key={`${issue.row}-${issue.message}`}><strong>Row {issue.row}</strong><span>{issue.message}</span></li>)}</ul>{issues.length > 8 && <p className="more-issues">And {issues.length - 8} more row issues.</p>}</section>}
            </>
          ) : activeSection === 'Lead Recovery' ? <LeadRecovery leads={leads} setLeads={setLeads} session={session} organization={organization} loading={leadLoading} loadError={leadError} /> : activeSection === 'Actions' ? <RecoveryActions actions={recoveryActions} invoices={invoices} loading={actionsLoading} busyId={actionBusy} notice={actionNotice} onTransition={(action, transition) => void handleActionTransition(action, transition)} /> : activeSection === 'Outcomes' ? <RecoveryOutcomes actions={recoveryActions} invoices={invoices} outcomes={verifiedOutcomes} loading={outcomesLoading} busyId={actionBusy} notice={paymentNotice} issues={paymentIssues} fileRef={paymentFileRef} onImport={(file) => void handleImportPayments(file)} onVerify={(action) => void handleVerifyOutcome(action)} /> : (
            <section className="panel section-placeholder"><span className="empty-icon"><Icon name="brain" /></span><h2>Business Brain</h2><p>The Business Brain holds sourced facts, explicit assumptions, and import history. Current invoice estimates are derived from saved invoice records and the recovery-rate assumption.</p><div id="csv-format" className="format-box"><strong>Invoice CSV columns</strong><code>customer_id, customer_name, invoice_number, currency, total_amount, paid_amount, issued_at, due_at</code><small>Amounts use a decimal point and up to two decimal places. Currency must be a three-letter ISO code such as USD.</small></div></section>
          )}

          <footer className="page-footer"><span>Revenue OS</span><span>Estimates and verified revenue are kept separate.</span></footer>
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">{sections.map((section) => <button key={section} className={activeSection === section ? 'active' : ''} onClick={() => setActiveSection(section)} aria-label={section}><Icon name={section === 'Overview' ? 'grid' : section === 'Opportunities' ? 'spark' : section === 'Lead Recovery' ? 'check' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : 'brain'} /><span>{section}</span></button>)}</nav>
    </div>
  )
}

function OpportunityRow({ opportunity, onPropose, proposing }: { opportunity: RevenueOpportunity; onPropose: () => void; proposing: boolean }) {
  const invoice = opportunity.evidence[0]
  return <article className="opportunity-row"><span className="opportunity-indicator" /><div className="opportunity-main"><div className="opportunity-title"><strong>{invoice.customerName}</strong><span className="overdue-pill">Overdue</span></div><p>Invoice {invoice.invoiceNumber} <span>·</span> Due {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))}</p><small>Source record: {invoice.source.recordId}</small><button className="button button-secondary recovery-draft-button" type="button" onClick={onPropose} disabled={proposing}>{proposing ? 'Saving draft…' : 'Draft reminder'}</button></div><div className="opportunity-values"><strong>{formatMoney(opportunity.outstanding)}</strong><small>outstanding</small><span>Est. {formatMoney(opportunity.estimate.low)}</span></div></article>
}

function RecoveryActions({ actions, invoices, loading, busyId, notice, onTransition }: { actions: RecoveryAction[]; invoices: InvoiceEvidence[]; loading: boolean; busyId: string; notice: string; onTransition: (action: RecoveryAction, transition: 'approve' | 'mark_sent' | 'cancel') => void }) {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  return <section className="panel recovery-actions-panel">
    <div className="panel-heading"><div><h2>Recovery action queue</h2><p>Review the draft, approve it, then send it yourself outside Revenue OS.</p></div><span className="status-pill">{actions.filter((action) => action.status === 'proposed' || action.status === 'approved').length} pending</span></div>
    {notice && <div className={'alert ' + (actionNoticeIsError ? 'alert-error' : 'alert-success')} role={actionNoticeIsError ? 'alert' : 'status'}>{notice}</div>}
    {loading ? <div className="empty-state compact"><h3>Loading actions…</h3><p>Retrieving saved recovery drafts.</p></div> : actions.length === 0 ? <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No recovery drafts yet</h3><p>Go to Opportunities and choose Draft reminder for an overdue invoice.</p></div> : <div className="recovery-action-list">{actions.map((action) => {
      const invoice = invoiceById.get(action.invoiceId)
      const busy = busyId === action.id
      return <article className="recovery-action-card" key={action.id}>
        <div className="recovery-action-top"><div><strong>{invoice ? invoice.customerName : action.recipientCustomerId}</strong><small>{invoice ? 'Invoice ' + invoice.invoiceNumber : 'Invoice record unavailable'} · Created {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(action.proposedAt))}</small></div><span className={'action-status action-status-' + action.status}>{action.status.replace('_', ' ')}</span></div>
        <p className="recovery-message">{action.message}</p>
        <div className="recovery-action-controls">
          <button className="button button-secondary" type="button" onClick={() => { void navigator.clipboard?.writeText(action.message).catch(() => undefined) }}>Copy draft</button>
          {action.status === 'proposed' && <button className="button button-primary" type="button" disabled={busy} onClick={() => onTransition(action, 'approve')}>{busy ? 'Saving…' : 'Approve draft'}</button>}
          {action.status === 'approved' && <button className="button button-primary" type="button" disabled={busy} onClick={() => { if (window.confirm('Only confirm this after you have actually sent the reminder outside Revenue OS. Continue?')) onTransition(action, 'mark_sent') }}>I've sent it manually</button>}
          {(action.status === 'proposed' || action.status === 'approved') && <button className="button button-quiet" type="button" disabled={busy} onClick={() => onTransition(action, 'cancel')}>Cancel</button>}
        </div>
        {action.status === 'approved' && <small className="action-human-note">Approved, not sent. Copy the draft, send it through your normal channel, then record that it was sent.</small>}
        {action.status === 'executed' && <small className="action-human-note">Marked as sent manually. This is not proof of payment or recovered revenue.</small>}
      </article>
    })}</div>}
  </section>
}

export default App


function LeadRecovery({ leads, setLeads, session, organization, loading, loadError }: { leads: LeadRecord[]; setLeads: (updater: (current: LeadRecord[]) => LeadRecord[]) => void; session: SupabaseSession; organization: RevenueOrganization; loading: boolean; loadError: string }) {
  const [name, setName] = useState('')
  const [business, setBusiness] = useState('')
  const [contact, setContact] = useState('')
  const [source, setSource] = useState('WhatsApp')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [nextFollowUp, setNextFollowUp] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState<'all' | LeadStatus>('all')

  async function addLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const amount = value.trim() ? Number(value) : null
    if (!name.trim() || !business.trim() || (value.trim() && (amount === null || !Number.isFinite(amount) || amount < 0))) {
      setNotice('Enter a contact name, business, and a valid non-negative opportunity value.')
      return
    }
    const record: LeadRecord = {
      id: 'lead-' + crypto.randomUUID(),
      name: name.trim(), business: business.trim(), contact: contact.trim(), source,
      value: amount === null ? '' : amount.toFixed(2), currency, nextFollowUp, notes: notes.trim(),
      status: 'new', createdAt: new Date().toISOString(),
    }
    setSaving(true)
    setNotice('')
    try {
      const saved = await createSalesLead(session, organization, record)
      setLeads((current) => [saved, ...current])
      setName(''); setBusiness(''); setContact(''); setValue(''); setNotes('')
      setNotice('Lead saved to your workspace. No message has been sent.')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The lead could not be saved.')
    } finally { setSaving(false) }
  }

  async function updateStatus(id: string, status: LeadStatus) {
    const previous = leads.find((lead) => lead.id === id)
    if (!previous || previous.status === status) return
    try {
      await updateSalesLead(session, organization.id, id, { status })
      setLeads((current) => current.map((lead) => lead.id === id ? { ...lead, status } : lead))
      setNotice('Lead status saved.')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The status could not be saved.')
    }
  }

  async function removeLead(id: string) {
    try {
      await deleteSalesLead(session, organization.id, id)
      setLeads((current) => current.filter((lead) => lead.id !== id))
      setNotice('Lead removed from the workspace.')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The lead could not be removed.')
    }
  }

  const active = leads.filter((lead) => lead.status !== 'converted' && lead.status !== 'closed')
  const visible = leads.filter((lead) => filter === 'all' || lead.status === filter).sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp))
  const statusLabel: Record<LeadStatus, string> = { new: 'New', follow_up: 'Follow-up due', contacted: 'Contacted', converted: 'Converted', closed: 'Closed' }

  return <div className="lead-workspace">
    <section className="lead-intro panel"><div><p className="eyebrow">REVENUE RECOVERY</p><h2>Lead Recovery</h2><p>Capture enquiries, schedule follow-ups, and track which opportunities turn into revenue.</p></div><span className="lead-local-pill">SUPABASE SYNC</span></section>
    <section className="lead-metrics" aria-label="Lead recovery metrics">
      <article className="lead-metric"><span>Total leads</span><strong>{leads.length}</strong><small>Saved in your workspace</small></article>
      <article className="lead-metric"><span>Active pipeline</span><strong>{currencyTotals(leads.filter((lead) => lead.status !== 'converted' && lead.status !== 'closed'))}</strong><small>Potential value, not revenue</small></article>
      <article className="lead-metric"><span>Converted value</span><strong>{currencyTotals(leads.filter((lead) => lead.status === 'converted'))}</strong><small>Marked converted by you</small></article>
      <article className="lead-metric"><span>Follow-ups today / overdue</span><strong>{active.filter((lead) => lead.nextFollowUp <= new Date().toISOString().slice(0, 10)).length}</strong><small>Due-date check</small></article>
    </section>
    <section className="panel lead-form-panel"><div className="panel-heading"><div><h2>Add an opportunity</h2><p>Record a lead and its next action. Messages are not sent automatically.</p></div></div>
      <form className="lead-form" onSubmit={(event) => void addLead(event)}>
        <label>Contact name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="e.g. Tendai M." /></label>
        <label>Business name<input value={business} onChange={(e) => setBusiness(e.target.value)} required maxLength={160} placeholder="e.g. ABC Guest House" /></label>
        <label>Phone / email<input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={160} placeholder="Optional contact details" /></label>
        <label>Lead source<select value={source} onChange={(e) => setSource(e.target.value)}><option>WhatsApp</option><option>Phone call</option><option>Referral</option><option>Website</option><option>Email</option><option>Social media</option><option>Other</option></select></label>
        <label>Potential value<input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="e.g. 250" /></label>
        <label>Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>ZIG</option><option>ZAR</option><option>GBP</option><option>EUR</option></select></label>
        <label>Next follow-up date<input type="date" value={nextFollowUp} onChange={(e) => setNextFollowUp(e.target.value)} required /></label>
        <label className="lead-wide">Notes / next action<input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="e.g. Call to confirm website feedback" /></label>
        <div className="lead-form-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Add lead"}</button><span>Store only the contact information needed to follow up.</span></div>
      </form>
      {loadError && <p className="lead-notice lead-error" role="alert">{loadError}</p>}
      {notice && <p className="lead-notice" role="status">{notice}</p>}
    </section>
    <section className="panel lead-list-panel"><div className="panel-heading"><div><h2>Follow-up queue</h2><p>Sort by next follow-up date and update the status after each real interaction.</p></div><span className="status-pill">{active.length} active</span></div>
      <div className="lead-filter-row"><label htmlFor="lead-filter">Show</label><select id="lead-filter" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | LeadStatus)}><option value="all">All leads</option><option value="new">New</option><option value="follow_up">Follow-up due</option><option value="contacted">Contacted</option><option value="converted">Converted</option><option value="closed">Closed</option></select></div>
      {loading ? <div className="empty-state compact"><h3>Loading saved leads…</h3><p>Retrieving records for this workspace.</p></div> : visible.length === 0 ? <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No leads in this view</h3><p>Add a prospect above. Saved leads will be available when you sign in again.</p></div> : <div className="lead-list">{visible.map((lead) => {
        const due = lead.status !== 'converted' && lead.status !== 'closed' && lead.nextFollowUp <= new Date().toISOString().slice(0, 10)
        return <article className="lead-row" key={lead.id}><div className="lead-row-main"><div className="lead-row-title"><strong>{lead.business}</strong><span className={`lead-status lead-status-${lead.status}`}>{statusLabel[lead.status]}</span>{due && <span className="lead-due">Due</span>}</div><p>{lead.name}{lead.contact ? ` · ${lead.contact}` : ''} · Source: {lead.source}</p><small>Next follow-up: {lead.nextFollowUp}{lead.notes ? ` · ${lead.notes}` : ''}</small></div><div className="lead-row-side"><strong>{lead.currency} {Number(lead.value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><label>Status<select aria-label={`Status for ${lead.business}`} value={lead.status} onChange={(e) => void updateStatus(lead.id, e.target.value as LeadStatus)}><option value="new">New</option><option value="follow_up">Follow-up due</option><option value="contacted">Contacted</option><option value="converted">Converted</option><option value="closed">Closed</option></select></label><button type="button" className="template-link" onClick={() => void removeLead(lead.id)}>Remove</button></div></article>
      })}</div>}
      <p className="lead-disclaimer">Pipeline value is an estimate. Converted value is user-marked, not independently verified cash. Leads are stored in your Supabase workspace; this prototype does not send messages or connect to WhatsApp.</p>
    </section>
  </div>
}

function currencyTotals(records: LeadRecord[]) {
  const totals = new Map<string, number>()
  for (const record of records) totals.set(record.currency, (totals.get(record.currency) ?? 0) + Number(record.value || 0))
  if (!totals.size) return '—'
  return [...totals.entries()].map(([currency, amount]) => `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`).join(' · ')
}


function RecoveryOutcomes({ actions, invoices, outcomes, loading, busyId, notice, issues, fileRef, onImport, onVerify }: {
  actions: RecoveryAction[]
  invoices: InvoiceEvidence[]
  outcomes: VerifiedOutcome[]
  loading: boolean
  busyId: string
  notice: string
  issues: CsvIssue[]
  fileRef: { current: HTMLInputElement | null }
  onImport: (file?: File) => void
  onVerify: (action: RecoveryAction) => void
}) {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const outcomeByAction = new Map(outcomes.map((outcome) => [outcome.actionId, outcome]))
  const executedActions = actions.filter((action) => action.status === 'executed')
  return <div className="outcomes-workspace">
    <section className="panel outcomes-import-panel">
      <div className="panel-heading"><div><h2>Import payment evidence</h2><p>Use a payment export from your accounting or payment system. Revenue OS does not invent or infer payments.</p></div><span className="status-pill">Source records</span></div>
      <div className="payment-import-content">
        <p className="payment-csv-format"><strong>Required CSV columns</strong><code>invoice_number,payment_reference,currency,amount,received_at</code><small>Each payment reference should be unique within its source. Invoice number and currency must match one saved invoice. Amounts use decimal notation, for example 125.50.</small></p>
        <input ref={fileRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(event) => onImport(event.target.files?.[0])} />
        <div className="recovery-action-controls"><button className="button button-primary" type="button" onClick={() => fileRef.current?.click()}>Import payment CSV</button><button className="button button-secondary" type="button" onClick={downloadPaymentTemplate}>Download template</button></div>
        {notice && <div className={'alert ' + (paymentNoticeIsError ? 'alert-error' : 'alert-success')} role={paymentNoticeIsError ? 'alert' : 'status'}>{notice}</div>}
        {issues.length > 0 && <div className="payment-issues"><strong>Rows needing review ({issues.length})</strong><ul>{issues.slice(0, 12).map((issue) => <li key={issue.row}>Row {issue.row}: {issue.message}</li>)}</ul>{issues.length > 12 && <small>Showing first 12 issues.</small>}</div>}
      </div>
    </section>
    <section className="panel outcomes-list-panel">
      <div className="panel-heading"><div><h2>Verify sent reminders</h2><p>Only payment records received within 30 days after a manually sent reminder are matched. This is observed timing, not proof of causation.</p></div><span className="status-pill">{outcomes.length} verified</span></div>
      {loading ? <div className="empty-state compact"><h3>Loading verified outcomes…</h3></div> : executedActions.length === 0 ? <div className="empty-state compact"><h3>No sent reminders to verify yet</h3><p>Approve a draft in Actions, send it manually, and record that it was sent before checking for payment evidence.</p></div> : <div className="recovery-action-list">{executedActions.map((action) => {
        const invoice = invoiceById.get(action.invoiceId)
        const outcome = outcomeByAction.get(action.id)
        const busy = busyId === action.id
        return <article className="recovery-action-card" key={action.id}>
          <div className="recovery-action-top"><div><strong>{invoice ? invoice.customerName : action.recipientCustomerId}</strong><small>{invoice ? 'Invoice ' + invoice.invoiceNumber : 'Invoice record unavailable'} · Marked sent {action.executedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(action.executedAt)) : ''}</small></div><span className={outcome ? 'action-status action-status-executed' : 'action-status'}>{outcome ? 'Payment matched' : 'Awaiting evidence'}</span></div>
          {outcome ? <div className="verified-outcome-detail"><strong>{formatMoney(money(outcome.amountMinor, outcome.currency))}</strong><small>{outcome.id} · {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(outcome.recordedAt))}</small><p>Matched payment records within the measurement window. This amount is evidence-backed, but it is not proof the reminder caused the payment.</p></div> : <p className="recovery-message">No verified outcome has been recorded for this reminder yet. Import the matching payment export, then check again.</p>}
          <div className="recovery-action-controls"><button className="button button-secondary" type="button" disabled={busy} onClick={() => onVerify(action)}>{busy ? 'Checking…' : outcome ? 'Refresh payment match' : 'Check payment evidence'}</button></div>
        </article>
      })}</div>}
    </section>
  </div>
}
