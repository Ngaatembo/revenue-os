import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { buildOverdueOpportunities } from './domain/overdueInvoices'
import { parseInvoiceCsv, type CsvIssue } from './domain/invoiceCsv'
import { parsePaymentCsv } from './domain/paymentCsv'
import { addMoney, formatMoney, money } from './domain/money'
import { agingSummary, rankOpportunities, daysOverdue, type ActionProgress, type RankedOpportunity } from './domain/prioritization'
import { draftReminderMessage } from './domain/reminderDraft'
import { buildDashboardSummary } from './domain/dashboardSummary'
import { partitionCrossSourceDuplicates } from './domain/importDuplicates'
import { detectStalledLeads } from './domain/stalledLeads'
import { buildRecommendation } from './domain/recommendation'
import { classifySyncFailure } from './lib/opportunityQueries'
import { BILLING_STATUS, checkInvoiceImportSize, checkLeadCapacity, getPlan } from './domain/plans'
import type { InvoiceEvidence, RevenueOpportunity } from './domain/types'
import { createSalesLead, deleteSalesLead, loadInvoices, loadRecoveryRate, loadSalesLeads, persistInvoiceImport, saveRecoveryRate, sha256Hex, updateSalesLead, type RevenueOrganization, type SalesLead, type SupabaseSession, type RecoveryAction, type VerifiedOutcome, loadRecoveryActions, loadVerifiedOutcomes, persistPaymentImport, proposeInvoiceReminder, transitionRecoveryAction, verifyRecoveryOutcome, loadOpenOpportunities, syncOverdueOpportunities, type OpportunitySyncResult, loadLeadActivities, recordLeadActivity, type LeadActivity, type LeadActivityType } from './lib/supabaseRest'
import './App.css'
import './design.css'

type Section = 'Overview' | 'Urgent' | 'Opportunities' | 'Lead Recovery' | 'Actions' | 'Outcomes' | 'Business Brain' | 'Connections'

const sections: Section[] = ['Overview', 'Urgent', 'Opportunities', 'Lead Recovery', 'Actions', 'Outcomes', 'Business Brain', 'Connections']
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
  if (name === 'plug') return <svg {...common}><path d="M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-10 0V7Z"/><path d="M12 16v5"/></svg>
  return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>
}

function parseRecoveryRate(value: string): number | null {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value.trim())) return null
  const percentage = Number(value)
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null
  return Math.round(percentage * 100)
}

type OpportunityStore = {
  /** 'saved' = read from Supabase after server-side detection; 'live' = calculated in the browser (fallback). */
  mode: 'live' | 'saved'
  opportunities: RevenueOpportunity[]
  syncing: boolean
  note: string
  noteIsError: boolean
  lastSync: OpportunitySyncResult | null
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
  const [invoicesLoading, setInvoicesLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [store, setStore] = useState<OpportunityStore>({ mode: 'live', opportunities: [], syncing: false, note: '', noteIsError: false, lastSync: null })

  useEffect(() => {
    let cancelled = false
    loadSalesLeads(session, organization.id)
      .then((records) => { if (!cancelled) setLeads(records) })
      .catch((cause) => { if (!cancelled) setLeadError(cause instanceof Error ? cause.message : 'Could not load saved leads.') })
      .finally(() => { if (!cancelled) setLeadLoading(false) })
    return () => { cancelled = true }
  }, [session, organization.id])

  const refreshOpportunities = useCallback(async (currentInvoices: InvoiceEvidence[], hasSavedRate: boolean): Promise<OpportunitySyncResult | null> => {
    if (!hasSavedRate || currentInvoices.length === 0) {
      setStore({ mode: 'live', opportunities: [], syncing: false, note: '', noteIsError: false, lastSync: null })
      return null
    }
    setStore((current) => ({ ...current, syncing: true }))
    try {
      const result = await syncOverdueOpportunities(session, organization.id)
      const loaded = await loadOpenOpportunities(session, organization.id, currentInvoices)
      setStore({
        mode: 'saved', opportunities: loaded.opportunities, syncing: false, lastSync: result,
        note: loaded.unresolvedIds.length ? loaded.unresolvedIds.length + ' saved opportunity record(s) are hidden because their source invoice could not be found.' : '',
        noteIsError: loaded.unresolvedIds.length > 0,
      })
      return result
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ''
      const kind = classifySyncFailure(message)
      if (kind === 'no_permission') {
        try {
          const loaded = await loadOpenOpportunities(session, organization.id, currentInvoices)
          setStore({ mode: 'saved', opportunities: loaded.opportunities, syncing: false, lastSync: null, note: 'Your role can view saved opportunities but cannot refresh detection.', noteIsError: false })
          return null
        } catch { /* fall through to the live calculation below */ }
      }
      setStore({
        mode: 'live', opportunities: [], syncing: false, lastSync: null,
        note: kind === 'not_available'
          ? 'Saving opportunities is not enabled on this database yet, so this is a live calculation from your saved invoices. Nothing is lost.'
          : 'Opportunities could not be saved right now, so this is a live calculation from your saved invoices. ' + message,
        noteIsError: kind === 'failed',
      })
      return null
    }
  }, [session, organization.id])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadInvoices(session, organization.id), loadRecoveryRate(session, organization.id)])
      .then(async ([records, savedRate]) => {
        if (cancelled) return
        setInvoices(records)
        setSourceName(records.length ? 'Saved Supabase invoice records' : '')
        if (savedRate !== null) setRecoveryRate((savedRate / 100).toString())
        setLoadError('')
        setInvoicesLoading(false)
        await refreshOpportunities(records, savedRate !== null)
      })
      .catch((cause) => {
        if (cancelled) return
        setLoadError(cause instanceof Error ? cause.message : 'Could not load saved invoice records.')
        setInvoicesLoading(false)
      })
    return () => { cancelled = true }
  }, [session, organization.id, refreshOpportunities])

  async function persistRecoveryRate() {
    const bps = parseRecoveryRate(recoveryRate)
    if (bps === null) return
    try {
      await saveRecoveryRate(session, organization, bps)
      setError('')
      const synced = await refreshOpportunities(invoices, true)
      setImportNote('Recovery-rate assumption saved to your workspace.' + (synced ? ' ' + synced.open + ' open opportunit' + (synced.open === 1 ? 'y' : 'ies') + ' now saved.' : ''))
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
    const message = draftReminderMessage(invoice, opportunity.outstanding)
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
    setActionNoticeIsError(false)
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
      const matchingIssues: CsvIssue[] = []
      const validPayments = parsed.payments.filter((payment) => {
        const matches = invoices.filter((invoice) => invoice.invoiceNumber === payment.invoiceNumber && invoice.currency === payment.currency)
        if (matches.length === 1) return true
        matchingIssues.push({
          row: payment.rowNumber,
          message: matches.length === 0
            ? 'Invoice number and currency do not match a saved invoice.'
            : 'Invoice number and currency match multiple saved invoices; make invoice numbers unique before importing.',
        })
        return false
      })
      const allIssues = [...parsed.issues, ...matchingIssues]
      setPaymentIssues(allIssues)
      if (!validPayments.length) {
        setPaymentNotice('No matching payment rows were saved. Correct the listed issues and try again.')
        setPaymentNoticeIsError(true)
        return
      }
      const result = await persistPaymentImport(session, organization, {
        sourceId: 'payments:' + file.name.trim().slice(0, 180),
        sourceName: file.name,
        contentHash: await sha256Hex(text),
        payments: validPayments,
        rejectedRows: allIssues.length,
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
    setPaymentNoticeIsError(false)
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
  const liveOpportunities = useMemo<RevenueOpportunity[]>(() => {
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
  const opportunities = store.mode === 'saved' ? store.opportunities : liveOpportunities

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

  const progressByInvoiceId = useMemo(() => {
    const rank: Record<ActionProgress, number> = { none: 0, proposed: 1, approved: 2, executed: 3 }
    const map = new Map<string, ActionProgress>()
    for (const action of recoveryActions) {
      if (action.status !== 'proposed' && action.status !== 'approved' && action.status !== 'executed') continue
      const current = map.get(action.invoiceId) ?? 'none'
      if (rank[action.status] > rank[current]) map.set(action.invoiceId, action.status)
    }
    return map
  }, [recoveryActions])
  const rankedOpportunities = useMemo<RankedOpportunity[]>(
    () => rankOpportunities(opportunities, new Date().toISOString(), progressByInvoiceId),
    [opportunities, progressByInvoiceId],
  )
  const aging = useMemo(() => agingSummary(opportunities, new Date().toISOString()), [opportunities])
  const summary = useMemo(() => buildDashboardSummary(recoveryActions, verifiedOutcomes), [recoveryActions, verifiedOutcomes])
  const plan = getPlan(undefined)

  async function importFile(file?: File) {
    if (!file) return
    setError('')
    setImportNote('')
    try {
      const text = await file.text()
      const importedAt = new Date().toISOString()
      const sourceId = 'csv:' + file.name.trim().slice(0, 180)
      const result = parseInvoiceCsv(text, sourceId, importedAt)
      const { fresh, duplicates } = partitionCrossSourceDuplicates(result.invoices, result.rowNumbers, invoices)
      const allIssues = [...result.issues, ...duplicates].sort((a, b) => a.row - b.row)
      setIssues(allIssues)
      setSourceName(file.name)
      setActiveSection('Opportunities')
      const limit = checkInvoiceImportSize(plan, fresh.length)
      if (!limit.allowed) { setError(limit.message); return }
      if (fresh.length === 0) {
        setImportNote(duplicates.length && !result.issues.length ? 'No new invoices were saved: every valid row is already saved from another file.' : 'No valid invoice rows were saved. Review the row issues below and correct the source file.')
        return
      }
      const outcome = await persistInvoiceImport(session, organization, {
        sourceId, sourceName: file.name, contentHash: await sha256Hex(text),
        invoices: fresh, rejectedRows: allIssues.length,
      })
      const savedInvoices = await loadInvoices(session, organization.id)
      setInvoices(savedInvoices)
      setLoadError('')
      const synced = await refreshOpportunities(savedInvoices, assumptionBps !== null)
      const saved = outcome.duplicate
        ? 'This exact file was already imported. No duplicate invoice records were created.'
        : outcome.acceptedRows + ' invoice record' + (outcome.acceptedRows === 1 ? '' : 's') + ' saved to Supabase.' + (outcome.rejectedRows ? ' ' + outcome.rejectedRows + ' row(s) were skipped (see below).' : '')
      const detected = synced
        ? ' ' + synced.open + ' open overdue opportunit' + (synced.open === 1 ? 'y' : 'ies') + ' saved' + (synced.created ? ' (' + synced.created + ' new)' : '') + '.'
        : assumptionBps === null ? ' Set a recovery-rate assumption to turn overdue balances into estimates.' : ''
      setImportNote(saved + detected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be imported.')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const brain = (() => {
    if (invoicesLoading) return { status: 'LOADING', title: 'Loading workspace data…', detail: 'Checking for saved invoices', note: 'Figures appear once saved records have been read.' }
    if (loadError && invoices.length === 0) return { status: 'ERROR', title: 'Source data could not be loaded', detail: 'The read failed, so this does not mean there is no data', note: 'Reload the page to try again. Nothing was changed.' }
    if (invoices.length === 0) return { status: 'NOT CONNECTED', title: 'No source data yet', detail: 'No invoices have been imported into this workspace', note: 'Opportunities, estimated recovery and verified revenue remain empty until real invoice records are imported. Nothing is estimated without source records.' }
    const saved = store.mode === 'saved' ? ` · ${opportunities.length} open opportunit${opportunities.length === 1 ? 'y' : 'ies'} saved` : ''
    const status = assumptionBps === null ? 'NEEDS ASSUMPTION' : store.mode === 'saved' ? 'SAVED' : 'IN SESSION'
    const note = assumptionBps === null
      ? 'Invoices are saved, but no recovery-rate assumption is set, so no estimate is calculated yet.'
      : 'Each recommendation lists the saved invoice and the assumption it was calculated from. Estimates are not revenue.'
    return { status, title: sourceName || 'Saved Supabase invoice records', detail: `${invoices.length} invoice record${invoices.length === 1 ? '' : 's'} · saved in Supabase${saved}`, note }
  })()

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
          <span className="workspace-copy"><strong>{organization.name}</strong><small>{plan.name} plan · billing {BILLING_STATUS === 'not_connected' ? 'not connected' : 'active'}</small></span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav">
          {sections.map((section) => {
            const icon = section === 'Overview' ? 'grid' : section === 'Urgent' ? 'clock' : section === 'Opportunities' ? 'spark' : section === 'Lead Recovery' ? 'check' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : section === 'Connections' ? 'plug' : 'brain'
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
          {loadError && <div className="alert alert-error" role="alert"><strong>Could not load your saved data.</strong> {loadError} Your records are not lost; reload the page to try again.</div>}
          {store.note && <div className={'alert ' + (store.noteIsError ? 'alert-error' : 'alert-info')} role={store.noteIsError ? 'alert' : 'status'}>{store.note}</div>}

          {activeSection === 'Overview' || activeSection === 'Opportunities' || activeSection === 'Urgent' ? (
            <>
              {activeSection === 'Overview' && <section className="daily-brief panel" aria-labelledby="daily-brief-title">
                <div className="daily-brief-heading"><div><p className="eyebrow">YOUR BUSINESS AT A GLANCE</p><h2 id="daily-brief-title">Daily brief</h2><p>Built from the records currently saved in this workspace. It refreshes when you open Revenue OS; external services are not yet monitored in the background.</p></div><span className="daily-brief-date">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date())}</span></div>
                {invoicesLoading || leadLoading || actionsLoading ? <p className="daily-brief-loading">Checking saved business records…</p> : <div className="daily-brief-grid">
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Money to review</span><strong>{opportunities.length} overdue opportunit{opportunities.length === 1 ? 'y' : 'ies'}</strong><p>{opportunities.length ? (rankedOpportunities[0] ? 'Top priority: ' + (rankedOpportunities[0].opportunity.evidence[0]?.customerName || 'customer record') + (rankedOpportunities[0].opportunity.evidence[0]?.invoiceNumber ? ' · invoice ' + rankedOpportunities[0].opportunity.evidence[0].invoiceNumber : '') + '.' : 'Review the overdue invoice list.') : invoices.length ? 'No overdue opportunities are currently detected from saved invoice data.' : 'Import invoice records to identify overdue money.'}</p><button type="button" className="template-link" onClick={() => setActiveSection('Opportunities')}>Review opportunities →</button></article>
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Customer follow-ups</span><strong>{leads.filter((lead) => !['converted', 'closed'].includes(lead.status) && lead.nextFollowUp <= new Date().toISOString().slice(0, 10)).length} due or overdue</strong><p>{leads.length ? 'Based on saved lead follow-up dates. Check the queue before contacting customers.' : 'Add leads and next-follow-up dates to see which enquiries need attention.'}</p><button type="button" className="template-link" onClick={() => setActiveSection('Lead Recovery')}>Open follow-up queue →</button></article>
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Waiting for your decision</span><strong>{summary.actionCounts.proposed} draft{summary.actionCounts.proposed === 1 ? '' : 's'} to review</strong><p>{summary.actionCounts.approved} approved reminder{summary.actionCounts.approved === 1 ? '' : 's'} waiting to be sent manually; {summary.awaitingEvidence} sent action{summary.awaitingEvidence === 1 ? '' : 's'} waiting for payment evidence.</p><button type="button" className="template-link" onClick={() => setActiveSection('Actions')}>Review actions →</button></article>
                </div>}
                <div className="daily-brief-footnote"><span><i className={loadError || leadError ? 'connection-dot connection-dot-muted' : 'connection-dot'} />{loadError || leadError ? 'Some saved data could not be loaded; review the error notice in its section.' : 'Using saved workspace records'}</span><button type="button" className="template-link" onClick={() => setActiveSection('Connections')}>Manage data sources →</button></div>
              </section>}
              {aging.length > 0 && <AgingStrip aging={aging} />}
              <section className="metric-grid" aria-label="Revenue summary">
                <article className="metric-card"><div className="metric-top"><span>Open opportunities</span><span className="metric-icon teal"><Icon name="spark" /></span></div><strong className="metric-value">{invoicesLoading ? '…' : invoices.length && assumptionBps !== null ? opportunities.length : '—'}</strong><p>{invoicesLoading ? 'Loading saved invoices…' : invoices.length === 0 ? 'No invoices imported into this workspace yet' : assumptionBps === null ? 'Set a recovery-rate assumption to detect opportunities' : `${opportunities.length} ${store.mode === 'saved' ? 'saved' : 'calculated'} from imported invoice evidence`}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Estimated recovery</span><span className="metric-icon amber"><Icon name="chart" /></span></div><strong className="metric-value metric-money">{estimatedByCurrency.length === 1 ? formatMoney(estimatedByCurrency[0]) : estimatedByCurrency.length > 1 ? 'Multiple currencies' : '—'}</strong><p>{estimatedByCurrency.length ? <>{estimatedByCurrency.length > 1 && <span className="currency-breakdown">{estimatedByCurrency.map((total) => formatMoney(total)).join(' · ')}<br /></span>}Estimate only · not verified revenue</> : invoicesLoading ? 'Loading…' : invoices.length === 0 ? 'Needs imported invoices and a recovery rate' : assumptionBps === null ? 'Needs a recovery-rate assumption' : 'No overdue balances to estimate'}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Verified revenue</span><span className="metric-icon green"><Icon name="check" /></span></div><strong className="metric-value metric-money">{summary.verifiedByCurrency.length === 0 ? '—' : summary.verifiedByCurrency.length === 1 ? formatMoney(summary.verifiedByCurrency[0]) : 'Multiple currencies'}</strong><p>{summary.verifiedByCurrency.length > 1 && <span className="currency-breakdown">{summary.verifiedByCurrency.map((total) => formatMoney(total)).join(' · ')}<br /></span>}{summary.verifiedOutcomeCount ? summary.verifiedOutcomeCount + ' payment-matched outcome(s) · observed after a reminder, not proven caused by it' : 'Recorded only when payment evidence is matched'}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Waiting on you</span><span className="metric-icon amber"><Icon name="check" /></span></div><strong className="metric-value">{actionsLoading ? '—' : summary.needsOwner}</strong><p>{actionsLoading ? 'Loading actions…' : summary.actionCounts.proposed + ' draft(s) to review · ' + summary.actionCounts.approved + ' approved to send · ' + summary.awaitingEvidence + ' sent, awaiting payment evidence'}</p></article>
              </section>

              <section className="work-grid">
                <div className="panel opportunity-panel">
                  <div className="panel-heading"><div><h2>{activeSection === 'Urgent' ? 'Urgent attention queue' : activeSection === 'Opportunities' ? 'Revenue opportunities' : 'Priority opportunities'}</h2><p>{activeSection === 'Urgent' ? 'Critical and high-priority overdue invoices, ranked by how late they are.' : 'Based on imported records and your stated assumptions.'}</p></div>{store.syncing ? <span className="status-pill">Refreshing…</span> : opportunities.length > 0 && <span className="status-pill">{opportunities.length} open</span>}</div>
                  {invoicesLoading ? (
                    <div className="empty-state compact" role="status"><h3>Loading your saved invoices…</h3><p>Checking this workspace for imported records.</p></div>
                  ) : loadError && invoices.length === 0 ? (
                    <div className="empty-state compact"><h3>Saved invoices could not be loaded</h3><p>Nothing is shown because the records could not be read, not because there are none. Reload the page to try again.</p></div>
                  ) : invoices.length === 0 ? (
                    <div className="empty-state"><span className="empty-icon"><Icon name="upload" /></span><h3>No invoices imported into this workspace yet</h3><p>Import an invoice CSV to identify overdue invoices. Opportunities, estimated recovery and verified revenue stay empty until real records are imported, and every opportunity links back to its source record.</p><button className="button button-secondary" onClick={() => fileRef.current?.click()}>Choose invoice CSV</button><button className="template-link" onClick={downloadCsvTemplate}>Download blank CSV template</button><a className="text-link" href="#csv-format" onClick={(event) => { event.preventDefault(); setActiveSection('Business Brain') }}>View required columns</a></div>
                  ) : assumptionBps === null ? (
                    <div className="assumption-prompt"><div className="assumption-icon"><Icon name="brain" /></div><div><h3>Set a recovery-rate assumption</h3><p>Estimates are calculated from outstanding invoice balances and this assumption. Choose a rate your team can support with evidence.</p><label htmlFor="recovery-rate">Expected recovery rate</label><div className="rate-input-wrap"><input id="recovery-rate" inputMode="decimal" placeholder="e.g. 25" value={recoveryRate} onChange={(event) => setRecoveryRate(event.target.value)} onBlur={() => void persistRecoveryRate()} aria-describedby="rate-help"/><span>%</span></div><small id="rate-help">Enter a percentage from 0 to 100. This will be labelled as an estimate.</small>{recoveryRate && parseRecoveryRate(recoveryRate) === null && <small className="field-error">Enter a valid percentage, such as 25 or 12.5.</small>}</div></div>
                  ) : activeSection === 'Urgent' && !rankedOpportunities.some((ranked) => ranked.urgency >= 3) ? (
                    <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No critical or high-priority invoices</h3><p>There are no overdue invoices in the urgent queue right now. Lower-priority overdue items remain available under Opportunities.</p></div>
                  ) : opportunities.length === 0 ? (
                    <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No overdue balances matched</h3><p>{outstandingInvoiceCount ? 'There are outstanding invoices, but none meet the overdue rule as of today.' : 'Imported invoices show no unpaid balances.'}</p></div>
                  ) : (
                    <div className="opportunity-list">{(activeSection === 'Urgent' ? rankedOpportunities.filter((ranked) => ranked.urgency >= 3) : rankedOpportunities).map((ranked, index) => <OpportunityRow key={ranked.opportunity.id} ranked={ranked} rank={index + 1} progress={progressByInvoiceId.get(ranked.opportunity.evidence[0]?.id) ?? 'none'} onPropose={() => void handleProposeReminder(ranked.opportunity)} onViewActions={() => setActiveSection('Actions')} proposing={actionBusy === ranked.opportunity.evidence[0]?.id} />)}</div>
                  )}
                </div>

                <aside className="panel brain-panel">
                  <div className="panel-heading"><div><h2>Business Brain</h2><p>Facts and assumptions behind recommendations.</p></div><span className="brain-status">{brain.status}</span></div>
                  <div className="brain-source"><span className="source-icon"><Icon name="brain" /></span><div><strong>{brain.title}</strong><small>{brain.detail}</small></div></div>
                  <div className="brain-divider" />
                  <div className="assumption-row"><span><i className="assumption-dot" />Recovery rate</span><strong>{assumptionBps === null ? 'Not set' : `${(assumptionBps / 100).toFixed(2).replace(/\.00$/, '')}%`}</strong></div>
                  <p className="brain-note">{brain.note}</p>
                </aside>
              </section>

              {activeSection === 'Opportunities' && <section className="panel invoice-register-panel" aria-labelledby="invoice-register-title">
                <div className="panel-heading"><div><h2 id="invoice-register-title">Imported invoice register</h2><p>Open any saved invoice to inspect its source details, amounts and dates. These records are loaded from your workspace database.</p></div><span className="status-pill">{invoices.length} saved</span></div>
                {invoicesLoading ? <div className="empty-state compact"><h3>Loading saved invoices…</h3></div> : invoices.length === 0 ? <div className="empty-state compact"><h3>No saved invoices yet</h3><p>Import a CSV to create your first invoice records.</p><button className="button button-secondary" type="button" onClick={() => fileRef.current?.click()}>Import invoices</button></div> : <div className="recovery-action-list">{[...invoices].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map((invoice) => {
                  const outstanding = Math.max(0, invoice.total.amount - invoice.paid.amount)
                  const overdue = outstanding > 0 && Date.parse(invoice.dueAt) < Date.parse(new Date().toISOString())
                  const state = outstanding === 0 ? 'Paid' : overdue ? 'Overdue' : 'Outstanding'
                  return <article className="recovery-action-card" key={invoice.id}>
                    <div className="recovery-action-top"><div><strong>{invoice.customerName}</strong><small>Invoice {invoice.invoiceNumber} · Due {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))}</small></div><span className={'action-status ' + (outstanding === 0 ? 'action-status-executed' : overdue ? 'action-status-proposed' : 'action-status-approved')}>{state}</span></div>
                    <p className="action-context">Total {formatMoney(invoice.total)} · Paid {formatMoney(invoice.paid)} · Outstanding {formatMoney(money(outstanding, invoice.currency))}</p>
                    <details className="why-details"><summary>Open invoice details</summary><dl>
                      <dt>Customer ID</dt><dd>{invoice.customerId}</dd>
                      <dt>Invoice number</dt><dd>{invoice.invoiceNumber}</dd>
                      <dt>Issued</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.issuedAt))}</dd>
                      <dt>Due date</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))}</dd>
                      <dt>Source</dt><dd>{invoice.source.sourceId}</dd>
                      <dt>Source record</dt><dd>{invoice.source.recordId}</dd>
                      <dt>Imported</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invoice.source.importedAt))}</dd>
                    </dl></details>
                  </article>
                })}</div>}
              </section>}

              {issues.length > 0 && <section className="panel issues-panel"><div className="panel-heading"><div><h2>Rows needing attention</h2><p>These rows were skipped; correct the source file and re-import.</p></div><span className="issue-count">{issues.length}</span></div><ul>{issues.slice(0, 8).map((issue) => <li key={`${issue.row}-${issue.message}`}><strong>Row {issue.row}</strong><span>{issue.message}</span></li>)}</ul>{issues.length > 8 && <p className="more-issues">And {issues.length - 8} more row issues.</p>}</section>}
            </>
          ) : activeSection === 'Lead Recovery' ? <LeadRecovery leadCapacity={checkLeadCapacity(plan, leads.filter((lead) => lead.status !== 'converted' && lead.status !== 'closed').length)} leads={leads} setLeads={setLeads} session={session} organization={organization} loading={leadLoading} loadError={leadError} /> : activeSection === 'Actions' ? <RecoveryActions actions={recoveryActions} invoices={invoices} loading={actionsLoading} busyId={actionBusy} notice={actionNotice} noticeIsError={actionNoticeIsError} onTransition={(action, transition) => void handleActionTransition(action, transition)} /> : activeSection === 'Outcomes' ? <RecoveryOutcomes actions={recoveryActions} invoices={invoices} outcomes={verifiedOutcomes} loading={outcomesLoading} busyId={actionBusy} notice={paymentNotice} noticeIsError={paymentNoticeIsError} issues={paymentIssues} fileRef={paymentFileRef} onImport={(file) => void handleImportPayments(file)} onVerify={(action) => void handleVerifyOutcome(action)} /> : activeSection === 'Connections' ? (
            <div className="connections-workspace">
              <section className="panel"><div className="panel-heading"><div><h2>Connect your business once</h2><p>Choose the systems Revenue OS should read. A connection is only active after authorization and a successful sync.</p></div><span className="status-pill">Connection centre</span></div>
                <div className="connection-source-grid">
                  <article className="connection-source-card"><div className="connection-source-top"><span className="source-icon"><Icon name="upload" /></span><span className={invoices.length ? 'connection-pill connection-pill-ready' : 'connection-pill'}>{invoices.length ? 'Data available' : 'No data yet'}</span></div><h3>Invoice CSV</h3><p>Current supported source. Import records to detect overdue balances and estimate possible recovery.</p><small>{invoices.length} invoice record(s) currently loaded · saved records are used where available.</small><button className="button button-secondary" type="button" onClick={() => fileRef.current?.click()}>Import invoices</button></article>
                  <article className="connection-source-card"><div className="connection-source-top"><span className="source-icon"><Icon name="grid" /></span><span className="connection-pill">Not connected</span></div><h3>Google Sheets / Drive</h3><p>Planned first live connector for business spreadsheets and selected files.</p><small>Requires a dedicated Google OAuth integration and approved scopes. Google sign-in alone does not grant data access.</small><button className="button button-secondary" type="button" disabled>Connect Google data · coming next</button></article>
                  <article className="connection-source-card"><div className="connection-source-top"><span className="source-icon"><Icon name="check" /></span><span className="connection-pill">Not connected</span></div><h3>Email and enquiries</h3><p>Future source for detecting unanswered enquiries and commitments that need follow-up.</p><small>No mailbox is currently being read and no messages are sent automatically.</small><button className="button button-secondary" type="button" disabled>Connect email · planned</button></article>
                </div>
              </section>
              <section className="panel"><div className="panel-heading"><div><h2>Monitoring status</h2><p>Clear visibility into what Revenue OS can currently see.</p></div></div><div className="connection-status-list"><div><span><i className="connection-dot" />Workspace database</span><strong>Connected</strong></div><div><span><i className={invoices.length ? 'connection-dot' : 'connection-dot connection-dot-muted'} />Invoice data</span><strong>{invoices.length ? 'Available' : 'Waiting for import'}</strong></div><div><span><i className={leads.length ? 'connection-dot' : 'connection-dot connection-dot-muted'} />Lead data</span><strong>{leads.length ? `${leads.length} saved lead(s)` : 'No saved leads yet'}</strong></div><div><span><i className="connection-dot connection-dot-muted" />Background synchronization</span><strong>Not configured</strong></div><div><span><i className="connection-dot connection-dot-muted" />Daily business brief</span><strong>Not yet automated</strong></div></div><p className="brain-note">Important: Revenue OS does not yet monitor external services in the background. This page reports current capabilities honestly; the next engineering step is to implement a real Google data connection, secure token storage, and scheduled synchronization before marking a source connected.</p></section>
            </div>
          ) : (
            <section className="panel section-placeholder"><span className="empty-icon"><Icon name="brain" /></span><h2>Business Brain</h2><p>The Business Brain holds sourced facts, explicit assumptions, and import history. Current invoice estimates are derived from saved invoice records and the recovery-rate assumption.</p><p><strong>Status:</strong> {brain.title}. {brain.detail}. {brain.note}</p><div id="csv-format" className="format-box"><strong>Invoice CSV columns</strong><code>customer_id, customer_name, invoice_number, currency, total_amount, paid_amount, issued_at, due_at</code><small>Amounts use a decimal point and up to two decimal places. Currency must be a three-letter ISO code such as USD.</small></div></section>
          )}

          <footer className="page-footer"><span>Revenue OS</span><span>Estimates and verified revenue are kept separate.</span></footer>
        </div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">{sections.map((section) => <button key={section} className={activeSection === section ? 'active' : ''} onClick={() => setActiveSection(section)} aria-label={section}><Icon name={section === 'Overview' ? 'grid' : section === 'Urgent' ? 'clock' : section === 'Opportunities' ? 'spark' : section === 'Lead Recovery' ? 'check' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : section === 'Connections' ? 'plug' : 'brain'} /><span>{section}</span></button>)}</nav>
    </div>
  )
}

function AgingStrip({ aging }: { aging: ReturnType<typeof agingSummary> }) {
  return <section className="aging" aria-label="Overdue money by how late it is">
    {aging.map((group) => {
      const total = group.total.amount || 1
      return <div className="aging-group" key={group.currency}>
        <div className="aging-head"><h2>{formatMoney(group.total)} overdue</h2><p>{group.count} invoice{group.count === 1 ? '' : 's'} with an unpaid balance. These are balances, not predictions.</p></div>
        <div className="aging-bar" role="img" aria-label={group.bands.map((band) => band.label + ': ' + formatMoney(band.amount)).join(', ')}>
          {group.bands.filter((band) => band.amount.amount > 0).map((band) => <span key={band.band} className={'aging-seg aging-' + band.band} style={{ flexGrow: Math.max(band.amount.amount / total, 0.04) }} />)}
        </div>
        <dl className="aging-legend">{group.bands.map((band) => <div key={band.band} className={band.amount.amount === 0 ? 'is-empty' : ''}><dt><i className={'aging-key aging-' + band.band} />{band.label}</dt><dd>{formatMoney(band.amount)}</dd></div>)}</dl>
      </div>
    })}
  </section>
}

function OpportunityRow({ ranked, rank, progress, onPropose, onViewActions, proposing }: { ranked: RankedOpportunity; rank: number; progress: ActionProgress; onPropose: () => void; onViewActions: () => void; proposing: boolean }) {
  const { opportunity } = ranked
  const invoice = opportunity.evidence[0]
  const recommendation = (() => { try { return buildRecommendation(ranked, progress) } catch { return null } })()
  return <article className="opportunity-row"><span className="opportunity-indicator" /><div className="opportunity-main"><div className="opportunity-title"><span className="rank-badge" aria-label={'Priority ' + rank}>#{rank}</span><strong>{invoice.customerName}</strong><span className={'overdue-pill urgency-' + ranked.urgency}>{ranked.urgencyLabel}</span></div><p>Invoice {invoice.invoiceNumber} <span>·</span> Due {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))}</p>
    <details className="why-details"><summary>Why this needs attention</summary><ul>{ranked.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><small>{ranked.uncertainty}</small><small>Source record: {recommendation ? recommendation.sourceRecord : invoice.source.recordId}</small>{recommendation && <div className="recommendation"><strong>Recommended steps</strong><ol>{recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol><dl>{recommendation.evidence.map((item) => <Fragment key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></Fragment>)}</dl><small>Needs your approval first. Revenue OS never sends a message or contacts a customer by itself, and the estimate is not money collected.</small></div>}</details>
    <p className="next-step"><strong>Next step:</strong> {ranked.nextAction}</p>
    {progress === 'none' ? <button className="button button-secondary recovery-draft-button" type="button" onClick={onPropose} disabled={proposing}>{proposing ? 'Saving draft…' : 'Draft reminder'}</button> : <button className="button button-secondary recovery-draft-button" type="button" onClick={onViewActions}>View in Actions ({progress})</button>}</div><div className="opportunity-values"><strong>{formatMoney(opportunity.outstanding)}</strong><small>outstanding</small><span>Est. {formatMoney(opportunity.estimate.low)}</span></div></article>
}

const statusOrder: Record<RecoveryAction['status'], number> = { approved: 0, proposed: 1, executed: 2, failed: 3, cancelled: 4 }

function RecoveryActions({ actions, invoices, loading, busyId, notice, noticeIsError, onTransition }: { actions: RecoveryAction[]; invoices: InvoiceEvidence[]; loading: boolean; busyId: string; notice: string; noticeIsError: boolean; onTransition: (action: RecoveryAction, transition: 'approve' | 'mark_sent' | 'cancel') => void }) {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  return <section className="panel recovery-actions-panel">
    <div className="panel-heading"><div><h2>Recovery action queue</h2><p>Review the draft, approve it, then send it yourself outside Revenue OS.</p></div><span className="status-pill">{actions.filter((action) => action.status === 'proposed' || action.status === 'approved').length} pending</span></div>
    {notice && <div className={'alert ' + (noticeIsError ? 'alert-error' : 'alert-success')} role={noticeIsError ? 'alert' : 'status'}>{notice}</div>}
    {loading ? <div className="empty-state compact"><h3>Loading actions…</h3><p>Retrieving saved recovery drafts.</p></div> : actions.length === 0 ? <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No recovery drafts yet</h3><p>Go to Opportunities and choose Draft reminder for an overdue invoice.</p></div> : <div className="recovery-action-list">{[...actions].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]).map((action) => {
      const invoice = invoiceById.get(action.invoiceId)
      const busy = busyId === action.id
      return <article className="recovery-action-card" key={action.id}>
        <div className="recovery-action-top"><div><strong>{invoice ? invoice.customerName : action.recipientCustomerId}</strong><small>{invoice ? 'Invoice ' + invoice.invoiceNumber : 'Invoice record unavailable'} · Created {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(action.proposedAt))}</small></div><span className={'action-status action-status-' + action.status}>{action.status.replace('_', ' ')}</span></div>
        {invoice && <p className="action-context">Outstanding {formatMoney(money(invoice.total.amount - invoice.paid.amount, invoice.total.currency))} of {formatMoney(invoice.total)} · {daysOverdue(invoice.dueAt, new Date().toISOString())} day(s) past due. <strong>Next step:</strong> {action.status === 'proposed' ? 'review the draft and approve it.' : action.status === 'approved' ? 'send it yourself, then record that it was sent.' : action.status === 'executed' ? 'import payment evidence in Outcomes and check for a match.' : 'no further step.'}</p>}
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


function LeadRecovery({ leadCapacity, leads, setLeads, session, organization, loading, loadError }: { leadCapacity: ReturnType<typeof checkLeadCapacity>; leads: LeadRecord[]; setLeads: (updater: (current: LeadRecord[]) => LeadRecord[]) => void; session: SupabaseSession; organization: RevenueOrganization; loading: boolean; loadError: string }) {
  const [activities, setActivities] = useState<LeadActivity[]>([])
  const [activityLeadId, setActivityLeadId] = useState<string | null>(null)
  const [activityType, setActivityType] = useState<LeadActivityType>('follow_up_sent')
  const [activitySummary, setActivitySummary] = useState('')
  const [activityNextFollowUp, setActivityNextFollowUp] = useState(() => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10))
  const [activitySaving, setActivitySaving] = useState(false)

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

  useEffect(() => {
    let cancelled = false
    loadLeadActivities(session, organization.id)
      .then((records) => { if (!cancelled) setActivities(records) })
      .catch((cause) => { if (!cancelled) setNotice(cause instanceof Error ? cause.message : 'Could not load lead activity history.') })
    return () => { cancelled = true }
  }, [session, organization.id])

  async function addLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!leadCapacity.allowed) { setNotice(leadCapacity.message); return }
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

  async function saveActivity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activityLeadId) return
    if (activitySummary.trim().length < 3) {
      setNotice('Describe what happened in at least 3 characters.')
      return
    }
    setActivitySaving(true)
    setNotice('')
    try {
      await recordLeadActivity(session, organization.id, {
        leadId: activityLeadId,
        type: activityType,
        summary: activitySummary.trim(),
        nextFollowUp: activityType === 'not_interested' ? null : activityNextFollowUp,
      })
      const [freshLeads, freshActivities] = await Promise.all([
        loadSalesLeads(session, organization.id),
        loadLeadActivities(session, organization.id),
      ])
      setLeads(() => freshLeads)
      setActivities(freshActivities)
      setActivityLeadId(null)
      setActivitySummary('')
      setNotice('Interaction saved. Lead status and next follow-up were updated together.')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The interaction could not be saved.')
    } finally {
      setActivitySaving(false)
    }
  }

  async function removeLead(id: string) {
    if (activities.some((activity) => activity.leadId === id)) {
      setNotice('This lead has a saved interaction history. Close it instead of deleting it so the audit trail is preserved.')
      return
    }
    try {
      await deleteSalesLead(session, organization.id, id)
      setLeads((current) => current.filter((lead) => lead.id !== id))
      setNotice('Lead removed from the workspace.')
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The lead could not be removed.')
    }
  }

  const active = leads.filter((lead) => lead.status !== 'converted' && lead.status !== 'closed')
  const stalledResult = useMemo(() => detectStalledLeads(leads, new Date().toISOString().slice(0, 10)), [leads])
  const stalledById = new Map(stalledResult.stalled.map((entry) => [entry.lead.id, entry]))
  const visible = leads.filter((lead) => filter === 'all' || lead.status === filter).sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp))
  const statusLabel: Record<LeadStatus, string> = { new: 'New', follow_up: 'Follow-up due', contacted: 'Contacted', converted: 'Converted', closed: 'Closed' }

  return <div className="lead-workspace">
    <section className="lead-intro panel"><div><p className="eyebrow">REVENUE RECOVERY</p><h2>Lead Recovery</h2><p>Capture enquiries, schedule follow-ups, and track which opportunities turn into revenue.</p></div><span className="lead-local-pill">SUPABASE SYNC</span></section>
    <section className="lead-metrics" aria-label="Lead recovery metrics">
      <article className="lead-metric"><span>Total leads</span><strong>{leads.length}</strong><small>Saved in your workspace</small></article>
      <article className="lead-metric"><span>Active pipeline</span><strong>{currencyTotals(leads.filter((lead) => lead.status !== 'converted' && lead.status !== 'closed'))}</strong><small>Potential value, not revenue</small></article>
      <article className="lead-metric"><span>Converted value</span><strong>{currencyTotals(leads.filter((lead) => lead.status === 'converted'))}</strong><small>Marked converted by you</small></article>
      <article className="lead-metric"><span>Follow-ups today / overdue</span><strong>{active.filter((lead) => lead.nextFollowUp <= new Date().toISOString().slice(0, 10)).length}</strong><small>{stalledResult.stalled.length} stalled (follow-up 7+ days late){stalledResult.skippedIds.length ? ` · ${stalledResult.skippedIds.length} with an unreadable date` : ''}</small></article>
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
        return <article className="lead-row" key={lead.id}><div className="lead-row-main"><div className="lead-row-title"><strong>{lead.business}</strong><span className={`lead-status lead-status-${lead.status}`}>{statusLabel[lead.status]}</span>{due && <span className="lead-due">Due</span>}{stalledById.has(lead.id) && <span className="lead-due" title={stalledById.get(lead.id)?.reason}>Stalled {stalledById.get(lead.id)?.daysStalled}d</span>}</div><p>{lead.name}{lead.contact ? ` · ${lead.contact}` : ''} · Source: {lead.source}</p><small>Next follow-up: {lead.nextFollowUp}{lead.notes ? ` · ${lead.notes}` : ''}</small>{activityLeadId === lead.id && <form className="lead-activity-form" onSubmit={(event) => void saveActivity(event)}>
          <strong>Record interaction</strong>
          <label>What happened<select value={activityType} onChange={(event) => setActivityType(event.target.value as LeadActivityType)}>
            <option value="follow_up_sent">Follow-up sent</option><option value="no_response">No response</option><option value="interested">Interested</option><option value="meeting_booked">Meeting booked</option><option value="not_interested">Not interested / close lead</option><option value="note">Add note only</option>
          </select></label>
          <label>Interaction notes<textarea value={activitySummary} onChange={(event) => setActivitySummary(event.target.value)} required minLength={3} maxLength={1000} rows={3} placeholder="e.g. Spoke with the owner; asked for a revised quote by Friday." /></label>
          {activityType !== 'not_interested' && <label>Next follow-up date<input type="date" min={new Date().toISOString().slice(0, 10)} value={activityNextFollowUp} onChange={(event) => setActivityNextFollowUp(event.target.value)} required /></label>}
          <div className="lead-form-actions"><button className="button button-primary" type="submit" disabled={activitySaving}>{activitySaving ? 'Saving…' : 'Save interaction'}</button><button className="button button-secondary" type="button" disabled={activitySaving} onClick={() => setActivityLeadId(null)}>Cancel</button></div>
        </form>}
        </div>
        <div className="lead-row-side"><strong>{lead.currency} {Number(lead.value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          {lead.status !== 'converted' && lead.status !== 'closed' && <button type="button" className="button button-secondary lead-log-button" onClick={() => { setActivityLeadId(activityLeadId === lead.id ? null : lead.id); setActivityType('follow_up_sent'); setActivitySummary(''); setActivityNextFollowUp(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)) }}>{activityLeadId === lead.id ? 'Close form' : stalledById.has(lead.id) ? 'Recover lead' : 'Log interaction'}</button>}
          <label>Status<select aria-label={`Status for ${lead.business}`} value={lead.status} onChange={(e) => void updateStatus(lead.id, e.target.value as LeadStatus)}><option value="new">New</option><option value="follow_up">Follow-up due</option><option value="contacted">Contacted</option><option value="converted">Converted</option><option value="closed">Closed</option></select></label><button type="button" className="template-link" onClick={() => void removeLead(lead.id)}>Remove</button></div></article>
      })}</div>}
      {activities.length > 0 && <section className="lead-activity-history" aria-label="Recent lead interactions">
        <div className="lead-activity-history-heading"><strong>Recent interactions</strong><span>Latest 12 recorded events</span></div>
        {activities.slice(0, 12).map((activity) => {
          const lead = leads.find((item) => item.id === activity.leadId)
          const labels: Record<LeadActivityType, string> = {
            follow_up_sent: 'Follow-up sent', no_response: 'No response', interested: 'Interested',
            meeting_booked: 'Meeting booked', not_interested: 'Not interested', note: 'Note',
          }
          return <article className="lead-activity-event" key={activity.id}>
            <div><strong>{lead?.business ?? 'Lead'}</strong><span>{labels[activity.type]}</span></div>
            <p>{activity.summary}</p>
            <small>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activity.createdAt))}{activity.nextFollowUp ? ' · Next follow-up ' + activity.nextFollowUp : ''}</small>
          </article>
        })}
      </section>}
      <p className="lead-disclaimer">Pipeline value is an estimate. Converted value is user-marked, not independently verified cash. Interactions are recorded in your workspace; Revenue OS does not send messages or connect to WhatsApp automatically.</p>
    </section>
  </div>
}

function currencyTotals(records: LeadRecord[]) {
  const totals = new Map<string, number>()
  for (const record of records) totals.set(record.currency, (totals.get(record.currency) ?? 0) + Number(record.value || 0))
  if (!totals.size) return '—'
  return [...totals.entries()].map(([currency, amount]) => `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`).join(' · ')
}


function RecoveryOutcomes({ actions, invoices, outcomes, loading, busyId, notice, noticeIsError, issues, fileRef, onImport, onVerify }: {
  actions: RecoveryAction[]
  invoices: InvoiceEvidence[]
  outcomes: VerifiedOutcome[]
  loading: boolean
  busyId: string
  notice: string
  noticeIsError: boolean
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
        {notice && <div className={'alert ' + (noticeIsError ? 'alert-error' : 'alert-success')} role={noticeIsError ? 'alert' : 'status'}>{notice}</div>}
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
