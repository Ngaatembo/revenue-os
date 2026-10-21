import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
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
import { ConnectionsPage } from './connections/ConnectionsPage'
import { ConversationsPanel } from './connections/ConversationsPanel'
import { Welcome } from './connections/Welcome'
import { useConnectionStatus } from './connections/useConnectionStatus'
import { decideLanding, readWelcomeSeen, writeWelcomeSeen } from './connections/landing'
import { BILLING_STATUS, checkInvoiceImportSize, checkLeadCapacity, getPlan } from './domain/plans'
import type { InvoiceEvidence, RevenueOpportunity } from './domain/types'
import { getFreshSession, createSalesLead, deleteSalesLead, loadInvoices, loadRecoveryRate, loadSalesLeads, persistInvoiceImport, saveRecoveryRate, sha256Hex, updateSalesLead, type RevenueOrganization, type SalesLead, type SupabaseSession, type RecoveryAction, type VerifiedOutcome, loadRecoveryActions, loadVerifiedOutcomes, persistPaymentImport, proposeInvoiceReminder, transitionRecoveryAction, verifyRecoveryOutcome, loadOpenOpportunities, syncOverdueOpportunities, type OpportunitySyncResult, loadLeadActivities, recordLeadActivity, type LeadActivity, type LeadActivityType, loadInvoiceInteractions, loadPaymentEvidence, recordInvoiceResponse, setOpportunityState, type InvoiceInteraction, loadBrainFacts, loadAssumptionHistory, recordBrainFact, retractBrainFact, resolveBrainConflict, type AssumptionChange, loadEvaluationRuns, type EvaluationRun, assignActionOwner, rematchPaymentReview } from './lib/supabaseRest'
import { WorkRecords, QuotationRow, DepositRow, TaskRow, ReviewRow, type RecordsCtx } from './WorkRecords'
import { useBusinessRecords } from './useBusinessRecords'
import { BusinessBrain } from './BusinessBrain'
import { actionStatusLabel } from './domain/actions'
import { AttentionQueue } from './AttentionQueue'
import { evaluateAttention, summarizeAttention } from './domain/attention/engine'
import { overdueInvoiceSignals } from './domain/businessSignalAdapters'
import { resolveAllSettings } from './domain/businessBrain'
import { deriveRecordFacts, findRecordMismatches, type BrainFact, type StoredFactKind } from './domain/businessBrain'
import { IssueControls, type ResponseFormValues } from './IssueControls'
import { summarizeWorkflow } from './domain/issueWorkflow'
import { assessPromise, type PaymentRecord, type PromiseAssessment } from './domain/promises'
import { buildMoneyPosition, type MoneyPosition } from './domain/moneyPosition'
import type { IssueTransition } from './lib/opportunityQueries'
import './App.css'
import './design.css'
import './sourceReview.css'

type Section = 'Overview' | 'Urgent' | 'Follow-ups' | 'Opportunities' | 'Lead Recovery' | 'Actions' | 'Outcomes' | 'Business Brain' | 'Connections'

const sections: Section[] = ['Overview', 'Urgent', 'Follow-ups', 'Opportunities', 'Lead Recovery', 'Actions', 'Outcomes', 'Business Brain', 'Connections']
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
  /** Dismissed issues: out of the queue, but the invoices may still be unpaid. */
  dismissed: RevenueOpportunity[]
  syncing: boolean
  note: string
  noteIsError: boolean
  lastSync: OpportunitySyncResult | null
}

type LeadRecord = SalesLead
type LeadStatus = SalesLead['status']

type GoogleConnectionState = { status?: string; provider_account_email?: string | null; last_successful_sync_at?: string | null; last_error_code?: string | null }
type GoogleSpreadsheetOption = { id: string; name: string; modified_time: string | null; web_view_link: string | null }
type GoogleSheetTab = { title: string; suggested_range: string; headers: string[]; sample_row_count: number; invoice_header_match_count: number; likely_invoice_sheet: boolean }
type SourceReviewItem = {
  organization_id: string; source_key: string; source_range: string; invoice_id: string; last_seen_at: string;
  invoice: { id: string; invoice_number: string; customer_name: string; currency: string; total_minor: number; paid_minor: number; due_at: string } | null
}

function GoogleSheetsConnector({ session, organization, onSynced }: { session: SupabaseSession; organization: RevenueOrganization; onSynced: () => Promise<void> }) {
  const [connection, setConnection] = useState<GoogleConnectionState>({ status: 'loading' })
  const [reviewItems, setReviewItems] = useState<SourceReviewItem[]>([])
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, { resolution: string; note: string }>>({})
  const [reviewBusy, setReviewBusy] = useState('')
  const [reviewNotice, setReviewNotice] = useState('')
  const [spreadsheet, setSpreadsheet] = useState('')
  const [spreadsheets, setSpreadsheets] = useState<GoogleSpreadsheetOption[]>([])
  const [discoveryBusy, setDiscoveryBusy] = useState(false)
  const [sheetTabs, setSheetTabs] = useState<GoogleSheetTab[]>([])
  const [inspectBusy, setInspectBusy] = useState(false)
  const [range, setRange] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)

  async function discoverSpreadsheets() {
    setDiscoveryBusy(true)
    setNotice('')
    try {
      const current = await getFreshSession(session)
      const files: GoogleSpreadsheetOption[] = []
      let pageToken: string | null = null
      let pages = 0
      do {
        const query = new URLSearchParams({ organization_id: organization.id })
        if (pageToken) query.set('page_token', pageToken)
        const response = await fetch(`/api/integrations/google/discover?${query.toString()}`, {
          headers: { Authorization: `Bearer ${current.access_token}` },
        })
        const payload = await response.json().catch(() => ({})) as { files?: GoogleSpreadsheetOption[]; error?: string; message?: string; next_page_token?: string | null }
        if (!response.ok) {
          if (response.status === 409 && payload.error === 'google_drive_discovery_scope_missing') {
            throw new Error('Reconnect Google Sheets to enable automatic spreadsheet discovery. The requested permission is read-only.')
          }
          throw new Error(payload.message || payload.error || 'Could not discover Google spreadsheets.')
        }
        files.push(...(payload.files ?? []))
        pageToken = payload.next_page_token ?? null
        pages += 1
      } while (pageToken && pages < 20)
      setSpreadsheets(files)
      setSpreadsheet((currentId) => files.some((file) => file.id === currentId) ? currentId : '')
      if (files.length) {
        const selectionResponse = await fetch(`/api/integrations/google/source-selection?organization_id=${encodeURIComponent(organization.id)}`, {
          headers: { Authorization: `Bearer ${current.access_token}` },
        })
        const selectionPayload = await selectionResponse.json().catch(() => ({})) as { selection?: { source_config?: { spreadsheet_id?: string; range?: string; tab_title?: string } } | null }
        const saved = selectionPayload.selection?.source_config
        if (selectionResponse.ok && saved?.spreadsheet_id && saved.range && files.some((file) => file.id === saved.spreadsheet_id)) {
          await inspectSpreadsheet(saved.spreadsheet_id)
          setRange(saved.range)
          setNotice(`Restored saved source: ${files.find((file) => file.id === saved.spreadsheet_id)?.name ?? 'Google spreadsheet'} · ${saved.tab_title ?? saved.range}`)
          setNoticeError(false)
          return
        }
      }
      setNotice(files.length ? `Found ${files.length} spreadsheet(s). Choose the invoice source below.` : 'No Google spreadsheets were found in this account. Check sharing access or create a spreadsheet first.')
      setNoticeError(false)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Could not discover Google spreadsheets.')
      setNoticeError(true)
    } finally {
      setDiscoveryBusy(false)
    }
  }

  /** Choosing a different tab saves it as the source, so the automatic sync follows the owner's choice. */
  async function chooseTab(value: string) {
    setRange(value)
    const tab = sheetTabs.find((candidate) => candidate.suggested_range === value)
    const file = spreadsheets.find((candidate) => candidate.id === spreadsheet)
    if (!tab || !file) return
    try {
      const current = await getFreshSession(session)
      const response = await fetch('/api/integrations/google/source-selection', {
        method: 'POST', headers: { Authorization: `Bearer ${current.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organization.id, spreadsheet_id: spreadsheet, spreadsheet_name: file.name, tab_title: tab.title, range: value }),
      })
      if (!response.ok) throw new Error('save_failed')
      setNotice(`Saved “${tab.title}” as the invoice tab. Revenue OS will check it automatically.`)
      setNoticeError(false)
    } catch {
      setNotice('Could not save that tab as the source. Try choosing it again.')
      setNoticeError(true)
    }
  }

  async function inspectSpreadsheet(spreadsheetId: string) {
    setSpreadsheet(spreadsheetId)
    setSheetTabs([])
    setRange('')
    if (!spreadsheetId) return
    setInspectBusy(true)
    setNotice('Inspecting spreadsheet tabs and looking for invoice headers…')
    setNoticeError(false)
    try {
      const current = await getFreshSession(session)
      const query = new URLSearchParams({ organization_id: organization.id, spreadsheet_id: spreadsheetId })
      const response = await fetch(`/api/integrations/google/inspect?${query.toString()}`, {
        headers: { Authorization: `Bearer ${current.access_token}` },
      })
      const payload = await response.json().catch(() => ({})) as { sheets?: GoogleSheetTab[]; suggested_range?: string | null; title?: string | null; message?: string; error?: string }
      if (!response.ok) throw new Error(payload.message || payload.error || 'Could not inspect spreadsheet tabs.')
      const tabs = payload.sheets ?? []
      setSheetTabs(tabs)
      const suggested = tabs.find((tab) => tab.likely_invoice_sheet) ?? tabs[0]
      const selectedRange = suggested?.suggested_range ?? payload.suggested_range ?? ''
      setRange(selectedRange)
      setNotice(tabs.some((tab) => tab.likely_invoice_sheet)
        ? `Found invoice-like headers in “${suggested?.title ?? 'the selected tab'}”. Review the selected tab, then sync.`
        : 'No tab clearly matches the invoice fields. Choose the closest tab and check its header row before syncing.')
      setNoticeError(false)
      if (suggested && selectedRange) {
        const selectedFile = spreadsheets.find((file) => file.id === spreadsheetId)
        const saveResponse = await fetch('/api/integrations/google/source-selection', {
          method: 'POST',
          headers: { Authorization: `Bearer ${current.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization_id: organization.id, spreadsheet_id: spreadsheetId, spreadsheet_name: selectedFile?.name ?? String(payload.title ?? 'Google spreadsheet'), tab_title: suggested.title, range: selectedRange }),
        })
        const savePayload = await saveResponse.json().catch(() => ({})) as { message?: string; error?: string }
        if (!saveResponse.ok) throw new Error(savePayload.message || savePayload.error || 'Could not save the selected source.')
      }
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Could not inspect spreadsheet tabs.')
      setNoticeError(true)
    } finally {
      setInspectBusy(false)
    }
  }

  const loadStatus = useCallback(async () => {
    try {
      const current = await getFreshSession(session)
      const response = await fetch(`/api/integrations/google/status?organization_id=${encodeURIComponent(organization.id)}`, {
        headers: { Authorization: `Bearer ${current.access_token}` },
      })
      const payload = await response.json().catch(() => ({})) as { connection?: GoogleConnectionState; message?: string }
      if (!response.ok) throw new Error(payload.message || (response.status === 503 ? 'Google Sheets server configuration is missing.' : 'Could not check Google Sheets connection.'))
      setConnection(payload.connection ?? { status: 'disconnected' })
      if (payload.connection?.status === 'connected') void discoverSpreadsheets()
      if (payload.connection?.status === 'connected') {
        try {
          const current = await getFreshSession(session)
          const reviewResponse = await fetch(`/api/integrations/google/source-review?organization_id=${encodeURIComponent(organization.id)}`, { headers: { Authorization: `Bearer ${current.access_token}` } })
          if (reviewResponse.ok) {
            const reviewPayload = await reviewResponse.json() as { items?: SourceReviewItem[] }
            setReviewItems(reviewPayload.items ?? [])
          } else if (reviewResponse.status !== 403) {
            setReviewNotice('The source review queue could not be loaded. Try refreshing the connection status.')
          }
        } catch {
          setReviewNotice('The source review queue could not be loaded. Try refreshing the connection status.')
        }
      } else {
        setReviewItems([])
      }
    } catch (cause) {
      setConnection({ status: 'unavailable' })
      setNotice(cause instanceof Error ? cause.message : 'Could not check Google Sheets connection.')
      setNoticeError(true)
    }
  }, [session, organization.id])

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('google_sheets')
    if (result) {
      const url = new URL(window.location.href)
      url.searchParams.delete('google_sheets')
      window.history.replaceState(null, document.title, url.pathname + url.search + url.hash)
    }
    queueMicrotask(() => {
      void loadStatus()
      if (result === 'connected') {
        setNotice('Google authorisation succeeded. Discovering your spreadsheets…')
        setNoticeError(false)
      } else if (result === 'failed') {
        setNotice('Google authorisation did not complete. Check OAuth settings and try again.')
        setNoticeError(true)
      }
    })
  }, [loadStatus])

  async function connect() {
    setBusy('connect')
    setNotice('')
    try {
      const current = await getFreshSession(session)
      const response = await fetch(`/api/integrations/google/start?organization_id=${encodeURIComponent(organization.id)}`, {
        headers: { Authorization: `Bearer ${current.access_token}` },
      })
      const payload = await response.json().catch(() => ({})) as { authorization_url?: string; message?: string; error?: string }
      if (!response.ok || !payload.authorization_url) throw new Error(payload.message || (payload.error === 'google_sheets_not_configured' ? 'Google Sheets is not configured on the live Worker yet. Configure its Google OAuth and Supabase secrets first.' : 'Could not start Google authorisation.'))
      window.location.assign(payload.authorization_url)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Could not start Google authorisation.')
      setNoticeError(true)
      setBusy('')
    }
  }

  async function disconnect() {
    setBusy('disconnect')
    setNotice('')
    try {
      const current = await getFreshSession(session)
      const response = await fetch('/api/integrations/google/disconnect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${current.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organization.id }),
      })
      const payload = await response.json().catch(() => ({})) as { message?: string }
      if (!response.ok) throw new Error(payload.message || 'Could not disconnect Google Sheets.')
      setConnection({ status: 'disconnected' })
      setNotice('Google Sheets has been disconnected.')
      setNoticeError(false)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Could not disconnect Google Sheets.')
      setNoticeError(true)
    } finally {
      setBusy('')
    }
  }

  async function resolveSourceReview(item: SourceReviewItem) {
    const draft = reviewDrafts[item.invoice_id]
    if (!draft?.resolution || !draft.note.trim()) {
      setReviewNotice('Choose a decision and explain it in the note before saving.')
      return
    }
    setReviewBusy(item.invoice_id)
    setReviewNotice('')
    try {
      const current = await getFreshSession(session)
      const result = await fetch('/api/integrations/google/source-review', {
        method: 'POST',
        headers: { Authorization: `Bearer ${current.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organization.id, invoice_id: item.invoice_id, source_key: item.source_key, source_range: item.source_range, resolution: draft.resolution, note: draft.note.trim() }),
      })
      const payload = await result.json().catch(() => ({})) as { message?: string; error?: string }
      if (!result.ok) throw new Error(payload.message || payload.error || 'Could not save this review.')
      setReviewItems((items) => items.filter((row) => row.invoice_id !== item.invoice_id || row.source_key !== item.source_key || row.source_range !== item.source_range))
      setReviewNotice('Review saved. The invoice and its history were preserved. This decision does not mark it paid or automatically close an opportunity.')
    } catch (cause) {
      setReviewNotice(cause instanceof Error ? cause.message : 'Could not save this review.')
    } finally {
      setReviewBusy('')
    }
  }

  async function sync() {
    const match = spreadsheet.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)
    const spreadsheetId = match?.[1] ?? spreadsheet.trim()
    if (!spreadsheetId) {
      setNotice('Paste a Google Sheets URL or spreadsheet ID first.')
      setNoticeError(true)
      return
    }
    setBusy('sync')
    setNotice('')
    try {
      const current = await getFreshSession(session)
      const selectedFile = spreadsheets.find((file) => file.id === spreadsheetId)
      const selectedTab = sheetTabs.find((tab) => tab.suggested_range === range)
      if (selectedFile && selectedTab) {
        const selectionResponse = await fetch('/api/integrations/google/source-selection', {
          method: 'POST',
          headers: { Authorization: `Bearer ${current.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ organization_id: organization.id, spreadsheet_id: spreadsheetId, spreadsheet_name: selectedFile.name, tab_title: selectedTab.title, range }),
        })
        const selectionPayload = await selectionResponse.json().catch(() => ({})) as { message?: string; error?: string }
        if (!selectionResponse.ok) throw new Error(selectionPayload.message || selectionPayload.error || 'Could not save the selected source.')
      }
      const response = await fetch('/api/integrations/google/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${current.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organization.id, spreadsheet_id: spreadsheetId, range: range.trim() || 'A:H' }),
      })
      const payload = await response.json().catch(() => ({})) as { accepted_rows?: number; rejected_rows?: number; duplicate?: boolean; message?: string; error?: string }
      if (!response.ok) throw new Error(payload.message || payload.error || 'Google Sheets sync failed.')
      await onSynced()
      await loadStatus()
      setNotice(`Sync complete: ${payload.accepted_rows ?? 0} invoice row(s) accepted, ${payload.rejected_rows ?? 0} rejected.${payload.duplicate ? ' This data matched an existing import.' : ''}`)
      setNoticeError(false)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Google Sheets sync failed.')
      setNoticeError(true)
    } finally {
      setBusy('')
    }
  }

  const connected = connection.status === 'connected'
  return <article className="connection-source-card">
    <div className="connection-source-top"><span className="source-icon"><Icon name="grid" /></span><span className={connected && connection.last_error_code ? 'connection-pill' : connected && connection.last_successful_sync_at ? 'connection-pill connection-pill-ready' : 'connection-pill'}>{connection.status === 'loading' ? 'Checking…' : connection.status === 'unavailable' ? 'Status unavailable' : !connected ? 'Not connected' : connection.last_error_code ? 'Needs attention' : connection.last_successful_sync_at ? 'Synced' : 'Connected · not synced'}</span></div>
    <h3>Google Sheets</h3>
    <p>Read invoice rows from a spreadsheet into this workspace. Access is read-only; Revenue OS will not edit your sheet or send messages.</p>
    {connected && <small>Google account: {connection.provider_account_email || 'Connected account'}{connection.last_successful_sync_at ? ` · Last successful sync ${new Date(connection.last_successful_sync_at).toLocaleString()}` : ' · Authorization is complete, but no successful import is recorded yet'}{connection.last_error_code ? ` · Last sync error: ${connection.last_error_code}` : ''}</small>}
    {!connected ? <button className="button button-secondary" type="button" onClick={() => void connect()} disabled={busy !== '' || connection.status === 'loading'}>{busy === 'connect' ? 'Opening Google…' : 'Connect Google Sheets'}</button> : <>
      <div className="connection-source-actions">
        <button className="button button-secondary" type="button" onClick={() => void connect()} disabled={busy !== '' || discoveryBusy}>{busy === 'connect' ? 'Reconnecting Google…' : 'Reconnect Google permissions'}</button>
        <button className="button button-secondary" type="button" onClick={() => void discoverSpreadsheets()} disabled={busy !== '' || discoveryBusy}>{discoveryBusy ? 'Finding spreadsheets…' : 'Refresh spreadsheet list'}</button>
      </div>
      <label className="field-label" htmlFor="google-spreadsheet">Choose a spreadsheet</label>
      <select id="google-spreadsheet" value={spreadsheet} onChange={(event) => void inspectSpreadsheet(event.target.value)} disabled={discoveryBusy || inspectBusy}>
        <option value="">{discoveryBusy ? 'Discovering spreadsheets…' : 'Select a Google spreadsheet'}</option>
        {spreadsheets.map((file) => <option key={file.id} value={file.id}>{file.name}{file.modified_time ? ` · Updated ${new Date(file.modified_time).toLocaleDateString()}` : ''}</option>)}
      </select>
      {spreadsheet && <>
        <label className="field-label" htmlFor="google-sheet-tab">Invoice tab</label>
        <select id="google-sheet-tab" value={range} onChange={(event) => void chooseTab(event.target.value)} disabled={inspectBusy || sheetTabs.length === 0}>
          <option value="">{inspectBusy ? 'Inspecting tabs…' : 'Choose a tab'}</option>
          {sheetTabs.map((tab) => <option key={tab.title} value={tab.suggested_range}>{tab.title}{tab.likely_invoice_sheet ? ' · likely invoices' : ''}</option>)}
        </select>
        {sheetTabs.find((tab) => tab.suggested_range === range) && <small>Detected headers: {sheetTabs.find((tab) => tab.suggested_range === range)?.headers.join(', ') || 'No header row detected'}</small>}
      </>}
      <button className="button button-secondary" type="button" onClick={() => void sync()} disabled={busy !== '' || inspectBusy || !spreadsheet || !range}>{busy === 'sync' ? 'Syncing invoices…' : 'Sync invoices'}</button>
      <button className="template-link" type="button" onClick={() => void disconnect()} disabled={busy !== ''}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect Google'}</button>
    </>}
    {notice && <p className={noticeError ? 'field-error' : 'brain-note'} role={noticeError ? 'alert' : 'status'}>{notice}</p>}
    {connection.last_error_code && <p className="field-error" role="status">The last recorded sync error needs attention: {connection.last_error_code}. Reconnect permissions if access has changed, or retry the sync after checking the selected spreadsheet.</p>}
    {connected && reviewItems.length > 0 && <section className="source-review-queue" aria-labelledby="source-review-title">
      <div className="panel-heading"><div><h4 id="source-review-title">Rows missing from the sheet</h4><p>These invoices were present in an earlier successful sync but not in the latest complete snapshot. Absence is not proof of payment.</p></div><span className="status-pill">{reviewItems.length} to review</span></div>
      {reviewItems.map((item) => {
        const draft = reviewDrafts[item.invoice_id] ?? { resolution: 'keep_tracking', note: '' }
        const invoice = item.invoice
        return <article className="source-review-item" key={item.source_key + ':' + item.source_range + ':' + item.invoice_id}>
          <div><strong>{invoice?.invoice_number ?? item.invoice_id}</strong><small>{invoice?.customer_name ?? 'Invoice details unavailable'} · {item.source_range}</small></div>
          {invoice && <p>Outstanding: {invoice.currency} {((Number(invoice.total_minor) - Number(invoice.paid_minor)) / 100).toFixed(2)} · Due {invoice.due_at ? new Date(invoice.due_at).toLocaleDateString() : 'date unavailable'}</p>}
          <label className="field-label">Review decision</label>
          <select value={draft.resolution} onChange={(event) => setReviewDrafts((current) => ({ ...current, [item.invoice_id]: { ...draft, resolution: event.target.value } }))}>
            <option value="keep_tracking">Keep tracking this invoice</option>
            <option value="settled_elsewhere">Owner says settled elsewhere (not payment-verified)</option>
            <option value="voided">Invoice voided / cancelled</option>
            <option value="moved_out_of_range">Moved outside this sheet range</option>
          </select>
          <label className="field-label">Reason / notes</label>
          <textarea rows={2} maxLength={500} value={draft.note} onChange={(event) => setReviewDrafts((current) => ({ ...current, [item.invoice_id]: { ...draft, note: event.target.value } }))} placeholder="Record what you checked and why." />
          <button className="button button-secondary" type="button" disabled={reviewBusy !== ''} onClick={() => void resolveSourceReview(item)}>{reviewBusy === item.invoice_id ? 'Saving review…' : 'Save review'}</button>
        </article>
      })}
    </section>}
    {reviewNotice && <p className="brain-note" role="status">{reviewNotice}</p>}
  </article>
}

function App({ session, organization, onSignOut }: { session: SupabaseSession; organization: RevenueOrganization; onSignOut: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const paymentFileRef = useRef<HTMLInputElement>(null)
  const [activeSection, setActiveSection] = useState<Section>(() => {
    // Returning from a provider's authorization page must land on Connections so the result is shown.
    const params = new URLSearchParams(window.location.search)
    return params.has('connection') || params.has('google_sheets') ? 'Connections' : 'Overview'
  })
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [invoices, setInvoices] = useState<InvoiceEvidence[]>([])
  const [issues, setIssues] = useState<CsvIssue[]>([])
  const [sourceName, setSourceName] = useState('')
  const [recoveryRate, setRecoveryRate] = useState('')
  const [rateDraft, setRateDraft] = useState('')
  const [error, setError] = useState('')
  const [importNote, setImportNote] = useState('')
  const [pendingInvoiceImport, setPendingInvoiceImport] = useState<{ fileName: string; sourceId: string; contentHash: string; invoices: ReturnType<typeof parseInvoiceCsv>['invoices']; issues: CsvIssue[]; parsedCount: number } | null>(null)
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
  const [interactions, setInteractions] = useState<InvoiceInteraction[]>([])
  const [payments, setPayments] = useState<PaymentRecord[]>([])
  const [issueBusy, setIssueBusy] = useState('')
  const [leadActivityLog, setLeadActivityLog] = useState<LeadActivity[]>([])
  const [evaluationRuns, setEvaluationRuns] = useState<EvaluationRun[] | null>(null)
  const records = useBusinessRecords(session, organization.id)
  const conn = useConnectionStatus(session, organization.id)
  const [brainFacts, setBrainFacts] = useState<BrainFact[]>([])
  const [assumptionHistory, setAssumptionHistory] = useState<AssumptionChange[]>([])
  const [brainLoading, setBrainLoading] = useState(true)
  const [brainError, setBrainError] = useState('')
  const [brainBusy, setBrainBusy] = useState(false)
  const [brainNotice, setBrainNotice] = useState('')
  const [issueNotice, setIssueNotice] = useState('')
  const [invoicesLoading, setInvoicesLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [store, setStore] = useState<OpportunityStore>({ mode: 'live', opportunities: [], dismissed: [], syncing: false, note: '', noteIsError: false, lastSync: null })

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
      setStore({ mode: 'live', opportunities: [], dismissed: [], syncing: false, note: '', noteIsError: false, lastSync: null })
      return null
    }
    setStore((current) => ({ ...current, syncing: true }))
    try {
      const result = await syncOverdueOpportunities(session, organization.id)
      const loaded = await loadOpenOpportunities(session, organization.id, currentInvoices)
      setStore({
        mode: 'saved', opportunities: loaded.opportunities, dismissed: loaded.dismissed, syncing: false, lastSync: result,
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
          setStore({ mode: 'saved', opportunities: loaded.opportunities, dismissed: loaded.dismissed, syncing: false, lastSync: null, note: 'Your role can view saved opportunities but cannot refresh detection.', noteIsError: false })
          return null
        } catch { /* fall through to the live calculation below */ }
      }
      setStore({
        mode: 'live', opportunities: [], dismissed: [], syncing: false, lastSync: null,
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

  async function persistRecoveryRate(percent: string = recoveryRate) {
    const bps = parseRecoveryRate(percent)
    if (bps === null) return
    try {
      await saveRecoveryRate(session, organization, bps)
      setRecoveryRate(percent)
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

  const loadIssueEvidence = useCallback(async () => {
    try {
      const [loadedInteractions, loadedPayments] = await Promise.all([loadInvoiceInteractions(session, organization.id), loadPaymentEvidence(session, organization.id)])
      setInteractions(loadedInteractions)
      setPayments(loadedPayments)
    } catch (cause) {
      setIssueNotice(cause instanceof Error ? 'Could not load customer responses or payment evidence: ' + cause.message : 'Could not load customer responses or payment evidence.')
    }
  }, [session, organization.id])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadInvoiceInteractions(session, organization.id), loadPaymentEvidence(session, organization.id)])
      .then(([loadedInteractions, loadedPayments]) => { if (!cancelled) { setInteractions(loadedInteractions); setPayments(loadedPayments) } })
      .catch((cause) => { if (!cancelled) setIssueNotice(cause instanceof Error ? 'Could not load customer responses or payment evidence: ' + cause.message : 'Could not load customer responses or payment evidence.') })
    return () => { cancelled = true }
  }, [session, organization.id, invoices])

  const reloadBrain = useCallback(async () => {
    const [facts, history] = await Promise.all([loadBrainFacts(session, organization.id), loadAssumptionHistory(session, organization.id)])
    setBrainFacts(facts)
    setAssumptionHistory(history)
    setBrainError('')
  }, [session, organization.id])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadBrainFacts(session, organization.id), loadAssumptionHistory(session, organization.id)])
      .then(([facts, history]) => { if (!cancelled) { setBrainFacts(facts); setAssumptionHistory(history); setBrainError('') } })
      .catch((cause) => { if (!cancelled) setBrainError(cause instanceof Error ? 'The Business Brain could not be loaded: ' + cause.message + ' Settings fall back to built-in defaults, which are labelled as unconfirmed.' : 'The Business Brain could not be loaded.') })
      .finally(() => { if (!cancelled) setBrainLoading(false) })
    return () => { cancelled = true }
  }, [session, organization.id])

  useEffect(() => {
    let cancelled = false
    loadLeadActivities(session, organization.id)
      .then((loaded) => { if (!cancelled) setLeadActivityLog(loaded) })
      .catch(() => { /* attention falls back to lead dates only; the Lead Recovery page reports its own load errors */ })
    return () => { cancelled = true }
  }, [session, organization.id, leads])

  useEffect(() => {
    let cancelled = false
    loadEvaluationRuns(session, organization.id)
      .then((runs) => { if (!cancelled) setEvaluationRuns(runs) })
      .catch(() => { if (!cancelled) setEvaluationRuns(null) })
    return () => { cancelled = true }
  }, [session, organization.id])

  async function brainAction(run: () => Promise<string>): Promise<string | null> {
    setBrainBusy(true)
    setBrainNotice('')
    try {
      const message = await run()
      await reloadBrain()
      setBrainNotice(message)
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'That could not be saved.'
    } finally {
      setBrainBusy(false)
    }
  }

  const handleRecordFact = (input: { key: string; value: string; kind: StoredFactKind; sourceLabel: string; note?: string }) =>
    brainAction(async () => {
      const result = await recordBrainFact(session, { organizationId: organization.id, ...input })
      return result.duplicate ? 'That fact was already saved.' : result.conflict ? 'Saved. It disagrees with another recorded value, so this is now a conflict for you to resolve.' : 'Saved with its source. Earlier values are kept in the history.'
    })
  const handleRetractFact = (fact: BrainFact, reason: string) =>
    brainAction(async () => { await retractBrainFact(session, { organizationId: organization.id, factId: fact.id, reason }); return 'Retracted. The fact stays in the history.' })
  const handleResolveConflict = (key: string, keep: BrainFact, reason: string) =>
    brainAction(async () => { await resolveBrainConflict(session, { organizationId: organization.id, key, keepFactId: keep.id, reason }); return 'Conflict resolved. The other values are kept as history.' })
  const handleSaveRecoveryRate = (percent: string) =>
    brainAction(async () => {
      const bps = parseRecoveryRate(percent)
      if (bps === null) throw new Error('Enter a valid percentage from 0 to 100, such as 25 or 12.5.')
      await saveRecoveryRate(session, organization, bps)
      setRecoveryRate(String(bps / 100))
      const synced = await refreshOpportunities(invoices, true)
      return 'Assumption saved and logged.' + (synced ? ` ${synced.open} open issue${synced.open === 1 ? '' : 's'} re-estimated.` : '')
    })

  async function reloadIssues() {
    const loaded = await loadOpenOpportunities(session, organization.id, invoices)
    setStore((current) => ({ ...current, mode: 'saved', opportunities: loaded.opportunities, dismissed: loaded.dismissed }))
    await loadIssueEvidence()
  }

  /** Returns an error message for the form to show, or null on success. */
  async function handleRecordResponse(opportunity: RevenueOpportunity, values: ResponseFormValues): Promise<string | null> {
    setIssueBusy(opportunity.id)
    setIssueNotice('')
    try {
      const result = await recordInvoiceResponse(session, {
        organizationId: organization.id, opportunityId: opportunity.id, type: values.type, summary: values.summary,
        promisedAmount: values.promisedAmount, promisedDate: values.promisedDate, nextFollowUp: values.nextFollowUp,
      })
      await reloadIssues()
      setIssueNotice(result.duplicate ? 'That response was already saved.' : 'Response saved. The issue, its follow-up date and the audit trail are updated. Nothing was sent and no money was recorded.')
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not save this response.'
    } finally { setIssueBusy('') }
  }

  async function handleIssueTransition(opportunity: RevenueOpportunity, transition: IssueTransition, options?: { reason?: string; snoozeUntil?: string }): Promise<string | null> {
    setIssueBusy(opportunity.id)
    setIssueNotice('')
    try {
      await setOpportunityState(session, { organizationId: organization.id, opportunityId: opportunity.id, transition, ...options })
      await reloadIssues()
      setIssueNotice(transition === 'dismiss' ? 'Issue dismissed. The invoice is still unpaid in your records and is listed under dismissed issues.' : transition === 'reopen' ? 'Issue reopened.' : transition === 'snooze' ? 'Snoozed for 7 days. The unpaid balance is still counted.' : transition === 'unsnooze' ? 'Snooze ended.' : 'Issue acknowledged.')
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Could not update this issue.'
    } finally { setIssueBusy('') }
  }

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
      // Rows that match no invoice (or several) are NOT dropped: the database keeps them in the review queue.
      const allIssues = parsed.issues
      setPaymentIssues(allIssues)
      if (!parsed.payments.length) {
        setPaymentNotice('No payment rows could be read from this file. Correct the listed issues and try again.')
        setPaymentNoticeIsError(true)
        return
      }
      const result = await persistPaymentImport(session, organization, {
        sourceId: 'payments:' + file.name.trim().slice(0, 180),
        sourceName: file.name,
        contentHash: await sha256Hex(text),
        payments: parsed.payments,
        rejectedRows: allIssues.length,
      })
      setPaymentNotice(result.duplicate ? 'This exact payment file was already imported. Nothing was added twice.' : result.acceptedRows + ' payment(s) matched an invoice and were saved as evidence.' + (result.reviewRows ? ' ' + result.reviewRows + ' payment(s) could not be matched safely and are waiting for you under Follow-ups → Payments to review; none were discarded.' : '') + (result.rejectedRows ? ' ' + result.rejectedRows + ' unreadable row(s) were skipped.' : ''))
      records.reload()
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
  const workflowSummary = useMemo(() => summarizeWorkflow(opportunities, new Date().toISOString()), [opportunities])
  const moneyPosition = useMemo<MoneyPosition[]>(
    () => buildMoneyPosition({ invoices, opportunities, dismissed: store.dismissed, payments, verified: summary.verifiedByCurrency }),
    [invoices, opportunities, store.dismissed, payments, summary.verifiedByCurrency],
  )
  const promiseRows = useMemo(() => {
    const asOf = new Date().toISOString()
    return opportunities.flatMap((opportunity) => {
      const workflow = opportunity.workflow
      const latest = interactions.find((interaction) => interaction.opportunityId === opportunity.id && interaction.type === 'promised_to_pay')
      if (!workflow?.promisedAmount || !workflow.promisedDate || !latest) return []
      return [{ opportunity, assessment: assessPromise({ invoiceId: opportunity.evidence[0].id, promised: workflow.promisedAmount, promisedDate: workflow.promisedDate, recordedAt: latest.createdAt, payments, asOf }) }]
    })
  }, [opportunities, interactions, payments])
  const plan = getPlan(undefined)

  async function importFile(file?: File) {
    if (!file) return
    setError('')
    setImportNote('')
    setPendingInvoiceImport(null)
    try {
      const text = await file.text()
      const importedAt = new Date().toISOString()
      const sourceId = 'csv:' + file.name.trim().slice(0, 180)
      const result = parseInvoiceCsv(text, sourceId, importedAt)
      const { fresh, duplicates } = partitionCrossSourceDuplicates(result.invoices, result.rowNumbers, invoices)
      const allIssues = [...result.issues, ...duplicates].sort((a, b) => a.row - b.row)
      const limit = checkInvoiceImportSize(plan, fresh.length)
      if (!limit.allowed) { setError(limit.message); return }
      setIssues(allIssues)
      setSourceName(file.name)
      setPendingInvoiceImport({
        fileName: file.name,
        sourceId,
        contentHash: await sha256Hex(text),
        invoices: fresh,
        issues: allIssues,
        parsedCount: result.invoices.length,
      })
      setActiveSection('Opportunities')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be read. Choose a CSV export and try again.')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function confirmInvoiceImport() {
    const pending = pendingInvoiceImport
    if (!pending || pending.invoices.length === 0) return
    setError('')
    setImportNote('')
    try {
      const outcome = await persistInvoiceImport(session, organization, {
        sourceId: pending.sourceId,
        sourceName: pending.fileName,
        contentHash: pending.contentHash,
        invoices: pending.invoices,
        rejectedRows: pending.issues.length,
      })
      // Payments that were waiting for an invoice are matched now. Only exact, unambiguous matches are applied.
      await rematchPaymentReview(session, organization.id).then(() => records.reload()).catch(() => undefined)
      const savedInvoices = await loadInvoices(session, organization.id)
      setInvoices(savedInvoices)
      setLoadError('')
      const synced = await refreshOpportunities(savedInvoices, assumptionBps !== null)
      const saved = outcome.duplicate
        ? 'This exact file was already imported. No duplicate invoice records were created.'
        : outcome.acceptedRows + ' invoice record' + (outcome.acceptedRows === 1 ? '' : 's') + ' saved to Supabase.' + (outcome.rejectedRows ? ' ' + outcome.rejectedRows + ' row(s) were skipped (see below).' : '')
      const now = Date.now()
      const day = 24 * 60 * 60 * 1000
      const unpaid = pending.invoices.filter((invoice) => invoice.total.amount > invoice.paid.amount)
      const overdue = unpaid.filter((invoice) => Date.parse(invoice.dueAt) < now)
      const dueSoon = unpaid.filter((invoice) => {
        const dueAt = Date.parse(invoice.dueAt)
        return dueAt >= now && dueAt <= now + 7 * day
      })
      const paid = pending.invoices.length - unpaid.length
      const findings = ' From the new records: ' + unpaid.length + ' still have a balance, ' +
        overdue.length + ' are past their due date, ' + dueSoon.length + ' are due within 7 days, and ' +
        paid + ' are fully paid.'
      const detected = synced
        ? ' ' + synced.open + ' overdue recovery opportunit' + (synced.open === 1 ? 'y' : 'ies') + ' currently identified' + (synced.created ? ' (' + synced.created + ' new)' : '') + '.'
        : assumptionBps === null ? ' Set a recovery-rate assumption to calculate estimated recovery value.' : ''
      setImportNote(saved + findings + detected)
      setPendingInvoiceImport(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The records could not be saved. Your file has not been confirmed as imported; review the message and try again.')
    }
  }

  function cancelInvoiceImport() {
    setPendingInvoiceImport(null)
    setIssues([])
    setImportNote('')
    setError('')
  }

  const derivedFacts = useMemo(() => deriveRecordFacts({ invoices, payments, assumptionBps, asOf: new Date().toISOString() }), [invoices, payments, assumptionBps])
  const recordMismatches = useMemo(() => findRecordMismatches(brainFacts, invoices), [brainFacts, invoices])

  const staleRun = useMemo(() => evaluationRuns !== null && evaluationRuns.length > 0 && new Date().getTime() - Date.parse(evaluationRuns[0].startedAt) > 36 * 3_600_000, [evaluationRuns])
  const recordsCtx: RecordsCtx = { session, organizationId: organization.id, members: records.members, invoices, deposits: records.deposits, reload: records.reload }

  const attention = useMemo(() => {
    const asOf = new Date().toISOString()
    const businessSignals = overdueInvoiceSignals(invoices, organization.id, asOf)
    const evaluated = evaluateAttention({
      asOf,
      businessSignals,
      opportunities,
      progressByInvoiceId,
      reminderSentAt: new Map(recoveryActions.filter((action) => action.status === 'executed' && action.executedAt).flatMap((action) => {
        const opportunity = opportunities.find((candidate) => candidate.id === action.opportunityId)
        return opportunity ? [[opportunity.evidence[0].id, action.executedAt as string] as [string, string]] : []
      })),
      noReplyCounts: interactions.reduce((counts, interaction) => interaction.type === 'no_response' ? counts.set(interaction.opportunityId, (counts.get(interaction.opportunityId) ?? 0) + 1) : counts, new Map<string, number>()),
      leads: leads.map((lead) => ({ id: lead.id, name: lead.name, business: lead.business, status: lead.status, nextFollowUp: lead.nextFollowUp, value: lead.value, currency: lead.currency, createdAt: lead.createdAt })),
      leadActivities: leadActivityLog,
      settings: resolveAllSettings(brainFacts),
      records: {
        quotations: records.quotations, deposits: records.deposits, tasks: records.tasks, paymentReviews: records.reviews, rescheduleCounts: records.rescheduleCounts,
        openActions: recoveryActions.filter((action) => action.status === 'proposed' || action.status === 'approved').map((action) => {
          const invoice = invoices.find((candidate) => candidate.id === action.invoiceId)
          return { id: action.id, status: action.status as 'proposed' | 'approved', ownerId: records.actionOwners.get(action.id) ?? null, label: `Reminder for ${invoice ? invoice.customerName + ' · ' + invoice.invoiceNumber : 'an invoice'}` }
        }),
      },
    })
    return { ...evaluated, summary: summarizeAttention(evaluated.items) }
  }, [opportunities, progressByInvoiceId, recoveryActions, interactions, leads, leadActivityLog, brainFacts, records.quotations, records.deposits, records.tasks, records.reviews, records.rescheduleCounts, records.actionOwners, invoices, organization.id])

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

  const [welcomeSeen, setWelcomeSeen] = useState(() => readWelcomeSeen(session.user.id, organization.id))
  const landingDecided = useRef(false)
  const landing = decideLanding({ welcomeSeen, connections: conn.rows, hasRecords: invoices.length > 0 || leads.length > 0 || records.quotations.length > 0 || records.deposits.length > 0 || records.tasks.length > 0, recordsLoading: invoicesLoading || leadLoading || records.loading })
  useEffect(() => {
    // Decide once per visit where a signed-in owner starts. Later navigation is theirs to control.
    if (landing === 'loading' || landingDecided.current) return
    landingDecided.current = true
    const returning = new URLSearchParams(window.location.search).has('connection') || new URLSearchParams(window.location.search).has('google_sheets')
    if (!returning && landing === 'connections') queueMicrotask(() => setActiveSection('Connections'))
  }, [landing])

  // Background synchronization finished while the app is open: reload the saved invoices without a manual import.
  const sheetsSyncedAt = conn.rows?.find((row) => row.provider === 'google_sheets')?.last_successful_sync_at ?? null
  const seenSheetsSync = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (seenSheetsSync.current === undefined) { seenSheetsSync.current = sheetsSyncedAt; return }
    if (seenSheetsSync.current === sheetsSyncedAt) return
    seenSheetsSync.current = sheetsSyncedAt
    void (async () => {
      const loaded = await loadInvoices(session, organization.id)
      setInvoices(loaded); setInvoicesLoading(false)
      await refreshOpportunities(loaded, assumptionBps !== null)
    })().catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetsSyncedAt])

  const title = activeSection === 'Overview' ? 'Revenue overview' : activeSection

  return (
    <div className="app-shell">
      {landing === 'welcome' && !welcomeSeen && <Welcome onContinue={() => { writeWelcomeSeen(session.user.id, organization.id); setWelcomeSeen(true); setActiveSection('Connections') }} />}
      <aside className="sidebar" aria-label="Main navigation">
        <a className="brand" href="#overview" onClick={() => setActiveSection('Overview')}>
          <img className="brand-symbol" src="/revenue-os-mark.svg" alt="" />
          <span className="brand-wordmark">Revenue<span className="brand-light"> OS</span></span>
        </a>
        <div className="workspace-switcher">
          <span className="workspace-avatar">W</span>
          <span className="workspace-copy"><strong>{organization.name}</strong><small>{plan.name} plan · billing {BILLING_STATUS === 'not_connected' ? 'not connected' : 'active'}</small></span>
          <span className="chevron" aria-hidden="true">⌄</span>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="primary-nav">
          {sections.map((section) => {
            const icon = section === 'Overview' ? 'grid' : section === 'Urgent' ? 'clock' : section === 'Follow-ups' ? 'check' : section === 'Opportunities' ? 'spark' : section === 'Lead Recovery' ? 'check' : section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : section === 'Connections' ? 'plug' : 'brain'
            return <button key={section} className={`nav-item ${activeSection === section ? 'active' : ''}`} onClick={() => setActiveSection(section)}>
              <Icon name={icon} /><span>{section}</span>
              {section === 'Opportunities' && opportunities.length > 0 && <span className="nav-count">{opportunities.length}</span>}{section === 'Urgent' && attention.summary.needingAttention > 0 && <span className="nav-count">{attention.summary.needingAttention}</span>}
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
            <button className="button button-primary" onClick={() => fileRef.current?.click()}><Icon name="upload" />Add invoice records</button>
            <input ref={fileRef} className="visually-hidden" type="file" accept=".csv,text/csv" aria-label="Choose an invoice spreadsheet" onChange={(event) => void importFile(event.target.files?.[0])} />
          </div>

          <div className="preview-banner"><span className="preview-dot" />Workspace connected <span className="preview-divider">·</span> Leads, invoice imports and recovery assumptions sync to Supabase. Actions still require manual approval.</div>

          {error && <div className="alert alert-error" role="alert"><strong>Could not complete the operation.</strong> {error}</div>}
          {importNote && <div className="alert alert-success" role="status"><strong>Saved.</strong> {importNote}</div>}
          {pendingInvoiceImport && <section className="panel import-preview" aria-labelledby="import-preview-title">
            <div className="panel-heading"><div><p className="eyebrow">CHECK BEFORE SAVING</p><h2 id="import-preview-title">Here is what Revenue OS understood</h2><p>Nothing from this file has been saved yet. Review the summary and sample records before confirming.</p></div><span className="status-pill">Preview</span></div>
            <p><strong>{pendingInvoiceImport.fileName}</strong></p>
            <div className="metric-grid import-preview-metrics">
              <article className="metric-card"><span>Recognised invoice rows</span><strong className="metric-value">{pendingInvoiceImport.parsedCount}</strong></article>
              <article className="metric-card"><span>New records to save</span><strong className="metric-value">{pendingInvoiceImport.invoices.length}</strong></article>
              <article className="metric-card"><span>Rows to review</span><strong className="metric-value">{pendingInvoiceImport.issues.length}</strong></article>
            </div>
            {pendingInvoiceImport.invoices.length > 0 ? <>
              <p className="import-preview-help">Sample of up to five records. Balances are calculated from invoice amount minus amount paid.</p>
              <div className="table-scroll"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Currency</th><th>Balance</th><th>Due date</th></tr></thead><tbody>
                {pendingInvoiceImport.invoices.slice(0, 5).map((invoice) => <tr key={invoice.id}><td>{invoice.invoiceNumber}</td><td>{invoice.customerName}</td><td>{invoice.currency}</td><td>{(Math.max(0, invoice.total.amount - invoice.paid.amount) / 100).toFixed(2)} {invoice.currency}</td><td>{invoice.dueAt.slice(0, 10)}</td></tr>)}
              </tbody></table></div>
            </> : <div className="alert alert-info">No new valid invoice rows are ready to save. Review the row issues or choose a corrected file.</div>}
            {pendingInvoiceImport.issues.length > 0 && <div className="import-preview-help"><strong>Rows to check:</strong> {pendingInvoiceImport.issues.slice(0, 5).map((issue) => 'Row ' + issue.row + ': ' + issue.message).join(' · ')}{pendingInvoiceImport.issues.length > 5 ? ' · and ' + (pendingInvoiceImport.issues.length - 5) + ' more' : ''}</div>}
            <div className="recovery-action-controls"><button className="button button-primary" type="button" onClick={() => void confirmInvoiceImport()} disabled={pendingInvoiceImport.invoices.length === 0}>Confirm and save {pendingInvoiceImport.invoices.length} record{pendingInvoiceImport.invoices.length === 1 ? '' : 's'}</button><button className="button button-secondary" type="button" onClick={cancelInvoiceImport}>Cancel import</button></div>
          </section>}
          {loadError && <div className="alert alert-error" role="alert"><strong>Could not load your saved data.</strong> {loadError} Your records are not lost; reload the page to try again.</div>}
          {store.note && <div className={'alert ' + (store.noteIsError ? 'alert-error' : 'alert-info')} role={store.noteIsError ? 'alert' : 'status'}>{store.note}</div>}

          {activeSection === 'Overview' && <section className="owner-next-step" aria-labelledby="owner-next-step-title">
            {invoicesLoading || leadLoading || actionsLoading || records.loading ? <>
              <div><span className="owner-next-step-label">START HERE</span><h2 id="owner-next-step-title">Checking your saved records</h2><p>We’ll show the next step once your workspace data has loaded.</p></div>
            </> : loadError || leadError ? <>
              <div><span className="owner-next-step-label">START HERE</span><h2 id="owner-next-step-title">Some information needs checking</h2><p>We couldn't load all saved data. Review the error message before relying on these totals.</p></div>
            </> : attention.summary.needingAttention > 0 ? <>
              <div><span className="owner-next-step-label">START HERE</span><h2 id="owner-next-step-title">{attention.summary.needingAttention} {attention.summary.needingAttention === 1 ? 'item needs' : 'items need'} your attention</h2><p>Review the evidence and recommended next step before contacting anyone.</p></div>
              <button className="button button-primary" type="button" onClick={() => setActiveSection('Urgent')}>Review urgent items <Icon name="arrow-right" /></button>
            </> : invoices.length === 0 && leads.length === 0 && records.quotations.length === 0 && records.deposits.length === 0 && records.tasks.length === 0 ? <>
              <div><span className="owner-next-step-label">START HERE</span><h2 id="owner-next-step-title">Add your first business records</h2><p>Import an invoice CSV or connect a spreadsheet to discover what needs attention.</p></div>
              <button className="button button-primary" type="button" onClick={() => fileRef.current?.click()}><Icon name="upload" /> Add invoices</button>
            </> : <>
              <div><span className="owner-next-step-label">START HERE</span><h2 id="owner-next-step-title">No urgent issues found in the saved records</h2><p>This reflects the information currently available, not background monitoring of every business channel.</p></div>
              <button className="button button-secondary" type="button" onClick={() => setActiveSection('Follow-ups')}>Review follow-ups <Icon name="arrow-right" /></button>
            </>}
          </section>}

          {activeSection === 'Overview' || activeSection === 'Opportunities' || activeSection === 'Urgent' ? (
            <>
              {activeSection === 'Overview' && !invoicesLoading && !leadLoading && !actionsLoading && !records.loading && invoices.length === 0 && leads.length === 0 && records.quotations.length === 0 && records.deposits.length === 0 && records.tasks.length === 0 && records.reviews.length === 0 && <section className="panel first-run-panel" aria-labelledby="first-run-title">
            <div className="panel-heading"><div><p className="eyebrow">LET'S GET STARTED</p><h2 id="first-run-title">Welcome to Revenue OS</h2><p>Connect the information your business already uses. We’ll organise the records and show you what needs attention. Start with one source; you can add more later.</p></div><span className="status-pill">Setup · 1 of 3</span></div>
            <div className="first-run-steps">
              <article className="first-run-step"><span className="first-run-step-number">1</span><div><h3>Connect a data source</h3><p>Use Google Sheets or import an invoice CSV. Google Sheets access is read-only.</p><button className="button button-primary" type="button" onClick={() => setActiveSection('Connections')}>Choose a connection</button></div></article>
              <article className="first-run-step"><span className="first-run-step-number">2</span><div><h3>Review what we found</h3><p>Revenue OS will show the records it recognised and anything that needs correcting before data is saved.</p><button className="button button-secondary" type="button" onClick={() => fileRef.current?.click()}>Import invoice CSV</button></div></article>
              <article className="first-run-step"><span className="first-run-step-number">3</span><div><h3>See your priorities</h3><p>Once useful records are saved, your daily brief can highlight overdue balances, follow-ups and work waiting for a decision.</p><span className="first-run-capability">Available after data is added</span></div></article>
            </div>
            <div className="first-run-connectors" aria-label="Connection availability"><span><i className="connection-dot" /> Google Sheets · connector in app</span><span><i className="connection-dot connection-dot-muted" /> Email · planned</span><span><i className="connection-dot connection-dot-muted" /> WhatsApp · planned</span></div>
            <p className="brain-note">We’ll only describe a source as connected after authorization succeeds. Email and WhatsApp are not being read yet, and no customer messages are sent automatically.</p>
          </section>}
          {activeSection === 'Overview' && <section className="daily-brief panel" aria-labelledby="daily-brief-title">
                <div className="daily-brief-heading"><div><p className="eyebrow">YOUR BUSINESS AT A GLANCE</p><h2 id="daily-brief-title">Daily brief</h2><p>Built from the records currently saved in this workspace. It refreshes when you open Revenue OS; external services are not yet monitored in the background.</p></div><span className="daily-brief-date">{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date())}</span></div>
                {invoicesLoading || leadLoading || actionsLoading ? <p className="daily-brief-loading">Checking saved business records…</p> : <div className="daily-brief-grid">
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Money to review</span><strong>{opportunities.length} overdue opportunit{opportunities.length === 1 ? 'y' : 'ies'}</strong><p>{opportunities.length ? (rankedOpportunities[0] ? 'Top priority: ' + (rankedOpportunities[0].opportunity.evidence[0]?.customerName || 'customer record') + (rankedOpportunities[0].opportunity.evidence[0]?.invoiceNumber ? ' · invoice ' + rankedOpportunities[0].opportunity.evidence[0].invoiceNumber : '') + '.' : 'Review the overdue invoice list.') : invoices.length ? 'No overdue opportunities are currently detected from saved invoice data.' : 'Import invoice records to identify overdue money.'}</p><button type="button" className="template-link" onClick={() => setActiveSection('Opportunities')}>Review opportunities →</button></article>
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Customer follow-ups</span><strong>{leads.filter((lead) => !['converted', 'closed'].includes(lead.status) && lead.nextFollowUp <= new Date().toISOString().slice(0, 10)).length} due or overdue</strong><p>{leads.length ? 'Based on saved lead follow-up dates. Check the queue before contacting customers.' : 'Add leads and next-follow-up dates to see which enquiries need attention.'}</p><button type="button" className="template-link" onClick={() => setActiveSection('Lead Recovery')}>Open follow-up queue →</button></article>
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Waiting for your decision</span><strong>{summary.actionCounts.proposed} draft{summary.actionCounts.proposed === 1 ? '' : 's'} to review</strong><p>{summary.actionCounts.approved} approved reminder{summary.actionCounts.approved === 1 ? '' : 's'} waiting to be sent manually; {summary.awaitingEvidence} sent action{summary.awaitingEvidence === 1 ? '' : 's'} waiting for payment evidence.</p><button type="button" className="template-link" onClick={() => setActiveSection('Actions')}>Review actions →</button></article>
                  <article className="daily-brief-item"><span className="daily-brief-kicker">Promises and follow-ups</span><strong>{workflowSummary.brokenPromises} broken promise{workflowSummary.brokenPromises === 1 ? '' : 's'} · {workflowSummary.followUpsDue} follow-up{workflowSummary.followUpsDue === 1 ? '' : 's'} due</strong><p>{attention.summary.needingAttention ? attention.summary.needingAttention + ' item' + (attention.summary.needingAttention === 1 ? '' : 's') + ' need you (invoices, leads, quotations, deposits, tasks and payments). ' : 'Nothing needs you right now. '}{workflowSummary.promisesOutstanding.length ? 'Customers have promised ' + workflowSummary.promisesOutstanding.map((total) => formatMoney(total)).join(' · ') + ' (a promise is not money received). ' : ''}{workflowSummary.disputes ? workflowSummary.disputes + ' disputed.' : ''}</p><button type="button" className="template-link" onClick={() => setActiveSection('Urgent')}>Open urgent queue →</button></article>
                </div>}
                <div className="daily-brief-footnote"><span><i className={loadError || leadError ? 'connection-dot connection-dot-muted' : 'connection-dot'} />{loadError || leadError ? 'Some saved data could not be loaded; review the error notice in its section.' : 'Using saved workspace records'}</span><button type="button" className="template-link" onClick={() => setActiveSection('Connections')}>Manage data sources →</button></div>
              </section>}
              {activeSection === 'Overview' && <ConversationsPanel session={session} organizationId={organization.id} gmail={conn.rows?.find((row) => row.provider === 'gmail')} onOpenConnections={() => setActiveSection('Connections')} />}
              {aging.length > 0 && <AgingStrip aging={aging} />}
              <section className="metric-grid" aria-label="Revenue summary">
                <article className="metric-card"><div className="metric-top"><span>Open opportunities</span><span className="metric-icon teal"><Icon name="spark" /></span></div><strong className="metric-value">{invoicesLoading ? '…' : invoices.length && assumptionBps !== null ? opportunities.length : '—'}</strong><p>{invoicesLoading ? 'Loading saved invoices…' : invoices.length === 0 ? 'No invoices imported into this workspace yet' : assumptionBps === null ? 'Set a recovery-rate assumption to detect opportunities' : `${opportunities.length} ${store.mode === 'saved' ? 'saved' : 'calculated'} from imported invoice evidence`}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Estimated recovery</span><span className="metric-icon amber"><Icon name="chart" /></span></div><strong className="metric-value metric-money">{estimatedByCurrency.length === 1 ? formatMoney(estimatedByCurrency[0]) : estimatedByCurrency.length > 1 ? 'Multiple currencies' : '—'}</strong><p>{estimatedByCurrency.length ? <>{estimatedByCurrency.length > 1 && <span className="currency-breakdown">{estimatedByCurrency.map((total) => formatMoney(total)).join(' · ')}<br /></span>}Estimate only · not verified revenue</> : invoicesLoading ? 'Loading…' : invoices.length === 0 ? 'Needs imported invoices and a recovery rate' : assumptionBps === null ? 'Needs a recovery-rate assumption' : 'No overdue balances to estimate'}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Verified revenue</span><span className="metric-icon green"><Icon name="check" /></span></div><strong className="metric-value metric-money">{summary.verifiedByCurrency.length === 0 ? '—' : summary.verifiedByCurrency.length === 1 ? formatMoney(summary.verifiedByCurrency[0]) : 'Multiple currencies'}</strong><p>{summary.verifiedByCurrency.length > 1 && <span className="currency-breakdown">{summary.verifiedByCurrency.map((total) => formatMoney(total)).join(' · ')}<br /></span>}{summary.verifiedOutcomeCount ? summary.verifiedOutcomeCount + ' payment-matched outcome(s) · observed after a reminder, not proven caused by it' : 'Recorded only when payment evidence is matched'}</p></article>
                <article className="metric-card"><div className="metric-top"><span>Waiting on you</span><span className="metric-icon amber"><Icon name="check" /></span></div><strong className="metric-value">{actionsLoading ? '—' : summary.needsOwner}</strong><p>{actionsLoading ? 'Loading actions…' : summary.actionCounts.proposed + ' draft(s) to review · ' + summary.actionCounts.approved + ' approved to send · ' + summary.awaitingEvidence + ' sent, awaiting payment evidence'}</p></article>
              </section>

              <section className="work-grid">
                <div className="panel opportunity-panel">
                  <div className="panel-heading"><div><h2>{activeSection === 'Urgent' ? 'Urgent attention queue' : activeSection === 'Opportunities' ? 'Revenue opportunities' : 'Priority opportunities'}</h2><p>{activeSection === 'Urgent' ? 'Overdue invoices and leads that need you now, each with its evidence, why it matters and the next step. Snoozing hides an alert for a while, never the unpaid money.' : 'Based on imported records and your stated assumptions.'}</p></div>{store.syncing ? <span className="status-pill">Refreshing…</span> : (activeSection === 'Urgent' ? attention.summary.needingAttention > 0 : opportunities.length > 0) && <span className="status-pill">{activeSection === 'Urgent' ? attention.summary.needingAttention + ' need you' : opportunities.length + ' open'}</span>}</div>
                  {activeSection === 'Urgent' ? (
                    <AttentionQueue items={attention.items} summary={attention.summary} failedRules={attention.failedRules} loading={invoicesLoading || leadLoading || records.loading}
                      onOpenLeads={() => setActiveSection('Lead Recovery')}
                      renderRecord={(subject) => {
                        if (subject.type === 'quotation') { const q = records.quotations.find((x) => x.id === subject.id); return q ? <QuotationRow q={q} ctx={recordsCtx} compact /> : null }
                        if (subject.type === 'deposit') { const d = records.deposits.find((x) => x.id === subject.id); return d ? <DepositRow d={d} ctx={recordsCtx} compact /> : null }
                        if (subject.type === 'task') { const t = records.tasks.find((x) => x.id === subject.id); return t ? <TaskRow t={t} ctx={recordsCtx} compact /> : null }
                        if (subject.type === 'payment_review') { const p = records.reviews.find((x) => x.id === subject.id); return p ? <ReviewRow p={p} ctx={recordsCtx} compact /> : null }
                        return <div className="recovery-action-controls"><button className="button button-secondary" type="button" onClick={() => setActiveSection('Actions')}>Assign on the Actions page</button></div>
                      }}
                      renderInvoice={(opportunityId) => { const ranked = rankedOpportunities.find((candidate) => candidate.opportunity.id === opportunityId); return ranked ? <OpportunityRow ranked={ranked} rank={0} progress={progressByInvoiceId.get(ranked.opportunity.evidence[0]?.id) ?? 'none'} onPropose={() => void handleProposeReminder(ranked.opportunity)} onViewActions={() => setActiveSection('Actions')} proposing={actionBusy === ranked.opportunity.evidence[0]?.id} controls={<IssueControls opportunity={ranked.opportunity} interactions={interactions} payments={payments} canWrite={store.mode === 'saved'} busy={issueBusy === ranked.opportunity.id} onRecord={(values) => handleRecordResponse(ranked.opportunity, values)} onTransition={(transition, options) => handleIssueTransition(ranked.opportunity, transition, options)} />} /> : null }} />
                  ) : invoicesLoading ? (
                    <div className="empty-state compact" role="status"><h3>Loading your saved invoices…</h3><p>Checking this workspace for imported records.</p></div>
                  ) : loadError && invoices.length === 0 ? (
                    <div className="empty-state compact"><h3>Saved invoices could not be loaded</h3><p>Nothing is shown because the records could not be read, not because there are none. Reload the page to try again.</p></div>
                  ) : invoices.length === 0 ? (
                    <div className="empty-state"><span className="empty-icon"><Icon name="upload" /></span><h3>No invoices imported into this workspace yet</h3><p>Add your invoice spreadsheet to identify overdue balances. You do not need to understand the file format. For now, choose a spreadsheet exported as CSV; Revenue OS will explain any information it cannot recognise. Opportunities and recovery estimates appear when the records support them.</p><button className="button button-secondary" onClick={() => fileRef.current?.click()}>Choose invoice spreadsheet</button><button className="template-link" onClick={downloadCsvTemplate}>Download blank CSV template</button><a className="text-link" href="#csv-format" onClick={(event) => { event.preventDefault(); setActiveSection('Business Brain') }}>See what information is needed</a></div>
                  ) : assumptionBps === null ? (
                    <div className="assumption-prompt"><div className="assumption-icon"><Icon name="brain" /></div><div><h3>Set a recovery-rate assumption</h3><p>Estimates are calculated from outstanding invoice balances and this assumption. Choose a rate your team can support with evidence.</p><label htmlFor="recovery-rate">Expected recovery rate</label><form onSubmit={(event) => { event.preventDefault(); void persistRecoveryRate(rateDraft) }}><div className="rate-input-wrap"><input id="recovery-rate" inputMode="decimal" placeholder="e.g. 25" value={rateDraft} onChange={(event) => setRateDraft(event.target.value)} aria-describedby="rate-help"/><span>%</span></div><small id="rate-help">Enter a percentage from 0 to 100. This will be labelled as an estimate.</small>{rateDraft && parseRecoveryRate(rateDraft) === null && <small className="field-error">Enter a valid percentage, such as 25 or 12.5.</small>}<div className="recovery-action-controls"><button className="button button-primary" type="submit" disabled={parseRecoveryRate(rateDraft) === null}>Save rate</button></div></form></div></div>
                  ) : opportunities.length === 0 ? (
                    <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No overdue balances matched</h3><p>{outstandingInvoiceCount ? 'There are outstanding invoices, but none meet the overdue rule as of today.' : 'Imported invoices show no unpaid balances.'}</p></div>
                  ) : (
                    <div className="opportunity-list">{issueNotice && <div className="alert alert-info" role="status">{issueNotice}</div>}{rankedOpportunities.map((ranked, index) => <OpportunityRow key={ranked.opportunity.id} ranked={ranked} rank={index + 1} progress={progressByInvoiceId.get(ranked.opportunity.evidence[0]?.id) ?? 'none'} onPropose={() => void handleProposeReminder(ranked.opportunity)} onViewActions={() => setActiveSection('Actions')} proposing={actionBusy === ranked.opportunity.evidence[0]?.id} controls={<IssueControls opportunity={ranked.opportunity} interactions={interactions} payments={payments} canWrite={store.mode === 'saved'} busy={issueBusy === ranked.opportunity.id} onRecord={(values) => handleRecordResponse(ranked.opportunity, values)} onTransition={(transition, options) => handleIssueTransition(ranked.opportunity, transition, options)} />} />)}</div>
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

              {activeSection === 'Opportunities' && store.dismissed.length > 0 && <section className="panel" aria-labelledby="dismissed-title">
                <div className="panel-heading"><div><h2 id="dismissed-title">Dismissed issues, still unpaid</h2><p>These are out of your attention queue. Their invoices are still unpaid in your records, so the balances remain in your totals. Reopen one if the situation changes.</p></div><span className="status-pill">{store.dismissed.length}</span></div>
                <div className="recovery-action-list">{store.dismissed.map((dismissed) => <article className="recovery-action-card" key={dismissed.id}>
                  <div className="recovery-action-top"><div><strong>{dismissed.evidence[0].customerName}</strong><small>Invoice {dismissed.evidence[0].invoiceNumber} · {formatMoney(dismissed.outstanding)} outstanding</small></div><span className="action-status">Dismissed</span></div>
                  <p className="action-context"><strong>Reason:</strong> {dismissed.workflow?.dismissedReason ?? 'No reason recorded.'}</p>
                  {store.mode === 'saved' && <div className="recovery-action-controls"><button className="button button-secondary" type="button" disabled={issueBusy === dismissed.id} onClick={() => void handleIssueTransition(dismissed, 'reopen')}>Reopen issue</button></div>}
                </article>)}</div>
              </section>}

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
          ) : activeSection === 'Follow-ups' ? <WorkRecords session={session} organizationId={organization.id} records={records} invoices={invoices} reload={records.reload} canWrite /> : activeSection === 'Lead Recovery' ? <LeadRecovery leadCapacity={checkLeadCapacity(plan, leads.filter((lead) => lead.status !== 'converted' && lead.status !== 'closed').length)} leads={leads} setLeads={setLeads} session={session} organization={organization} loading={leadLoading} loadError={leadError} /> : activeSection === 'Actions' ? <RecoveryActions owners={records.actionOwners} members={records.members} onAssign={async (actionId, ownerId) => { try { await assignActionOwner(session, { organizationId: organization.id, actionId, ownerId }); records.reload(); return '' } catch (cause) { return cause instanceof Error ? cause.message : 'Owner not saved.' } }} actions={recoveryActions} invoices={invoices} loading={actionsLoading} busyId={actionBusy} notice={actionNotice} noticeIsError={actionNoticeIsError} onTransition={(action, transition) => void handleActionTransition(action, transition)} /> : activeSection === 'Outcomes' ? <RecoveryOutcomes actions={recoveryActions} invoices={invoices} outcomes={verifiedOutcomes} loading={outcomesLoading} busyId={actionBusy} notice={paymentNotice} noticeIsError={paymentNoticeIsError} issues={paymentIssues} moneyPosition={moneyPosition} promises={promiseRows} fileRef={paymentFileRef} onImport={(file) => void handleImportPayments(file)} onVerify={(action) => void handleVerifyOutcome(action)} /> : activeSection === 'Connections' ? (
            <div className="connections-workspace">
              <ConnectionsPage session={session} organizationId={organization.id} rows={conn.rows} statusError={conn.error} refresh={conn.refresh} invoiceCount={invoices.length}
                csvAction={<button className="button button-secondary" type="button" onClick={() => fileRef.current?.click()}>Import invoices</button>}
                sheetsControls={<GoogleSheetsConnector session={session} organization={organization} onSynced={async () => { const loaded = await loadInvoices(session, organization.id); setInvoices(loaded); setInvoicesLoading(false); await refreshOpportunities(loaded, assumptionBps !== null) }} />} />
              <section className="panel"><div className="panel-heading"><div><h2>Monitoring status</h2><p>Clear visibility into what Revenue OS can currently see.</p></div></div><div className="connection-status-list"><div><span><i className="connection-dot" />Workspace database</span><strong>Connected</strong></div><div><span><i className={invoices.length ? 'connection-dot' : 'connection-dot connection-dot-muted'} />Invoice data</span><strong>{invoices.length ? 'Available' : 'Waiting for import'}</strong></div><div><span><i className={leads.length ? 'connection-dot' : 'connection-dot connection-dot-muted'} />Lead data</span><strong>{leads.length ? `${leads.length} saved lead(s)` : 'No saved leads yet'}</strong></div><div><span><i className={evaluationRuns && evaluationRuns[0]?.status === 'ok' ? 'connection-dot' : 'connection-dot connection-dot-muted'} />Automatic overdue check</span><strong>{evaluationRuns === null ? 'Not available yet' : evaluationRuns.length === 0 ? 'Has not run yet' : `${evaluationRuns[0].status === 'ok' ? 'Last ran' : evaluationRuns[0].status === 'skipped' ? 'Skipped' : 'Failed'} ${new Date(evaluationRuns[0].startedAt).toLocaleString()}${evaluationRuns[0].status !== 'ok' && evaluationRuns[0].message ? ' · ' + evaluationRuns[0].message : ''}${staleRun ? ' · older than a day and a half: the daily check may not be running' : ''}`}</strong></div><div><span><i className="connection-dot connection-dot-muted" />Daily business brief</span><strong>Shown when you open the app; not sent</strong></div></div><p className="brain-note">Important: Revenue OS currently works from records already saved in your workspace and can import invoices from CSV. A Google Sheets connector is implemented in the app, but a successful live connection and sync still depend on valid Cloudflare Worker secrets and Google OAuth configuration. Email and WhatsApp are not connected and are not being read. The daily database job depends on the required database migration and hosted scheduling support; it re-checks saved overdue invoices and retries payment matching, but it sends no messages and contacts no customer. Quotation, deposit and task alerts are calculated when you open the app. We will only mark a source connected after authorization and a successful sync.</p></section>
            </div>
          ) : (
            <BusinessBrain facts={brainFacts} derived={derivedFacts} mismatches={recordMismatches} assumptionBps={assumptionBps} assumptionHistory={assumptionHistory}
              loading={brainLoading} loadError={brainError} busy={brainBusy} notice={brainNotice}
              onRecord={handleRecordFact} onRetract={handleRetractFact} onResolve={handleResolveConflict} onSaveRecoveryRate={handleSaveRecoveryRate} />
          )}

          <footer className="page-footer"><span>Revenue OS</span><span>Estimates and verified revenue are kept separate.</span></footer>
        </div>
      </main>

      {mobileMoreOpen && <div className="mobile-more-backdrop" onClick={() => setMobileMoreOpen(false)}>
        <nav className="mobile-more-menu" aria-label="More workspace sections" onClick={(event) => event.stopPropagation()}>
          <div className="mobile-more-heading"><strong>More sections</strong><button type="button" onClick={() => setMobileMoreOpen(false)} aria-label="Close menu">Close</button></div>
          {(['Opportunities', 'Lead Recovery', 'Actions', 'Outcomes', 'Business Brain', 'Connections'] as Section[]).map((section) => <button key={section} type="button" className={activeSection === section ? 'active' : ''} onClick={() => { setActiveSection(section); setMobileMoreOpen(false) }}><Icon name={section === 'Opportunities' ? 'spark' : section === 'Lead Recovery' || section === 'Actions' ? 'check' : section === 'Outcomes' ? 'chart' : section === 'Connections' ? 'plug' : 'brain'} /><span>{section}</span><span className="mobile-more-arrow">›</span></button>)}
        </nav>
      </div>}
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {(['Overview', 'Urgent', 'Follow-ups'] as Section[]).map((section) => <button key={section} type="button" className={activeSection === section ? 'active' : ''} onClick={() => { setActiveSection(section); setMobileMoreOpen(false) }} aria-label={section}><Icon name={section === 'Overview' ? 'grid' : section === 'Urgent' ? 'clock' : 'check'} /><span>{section}</span></button>)}
        <button type="button" className={['Opportunities', 'Lead Recovery', 'Actions', 'Outcomes', 'Business Brain', 'Connections'].includes(activeSection) ? 'active' : ''} onClick={() => setMobileMoreOpen((open) => !open)} aria-expanded={mobileMoreOpen} aria-label="More sections"><Icon name="grid" /><span>More</span></button>
      </nav>
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

function OpportunityRow({ ranked, rank, progress, onPropose, onViewActions, proposing, controls }: { ranked: RankedOpportunity; rank: number; progress: ActionProgress; onPropose: () => void; onViewActions: () => void; proposing: boolean; controls?: ReactNode }) {
  const { opportunity } = ranked
  const invoice = opportunity.evidence[0]
  const recommendation = (() => { try { return buildRecommendation(ranked, progress) } catch { return null } })()
  return <article className="opportunity-row"><span className="opportunity-indicator" /><div className="opportunity-main"><div className="opportunity-title">{rank > 0 && <span className="rank-badge" aria-label={'Priority ' + rank}>#{rank}</span>}<strong>{invoice.customerName}</strong><span className={'overdue-pill urgency-' + ranked.urgency}>{ranked.urgencyLabel}</span>{ranked.snoozed && <span className="overdue-pill">Snoozed</span>}</div><p>Invoice {invoice.invoiceNumber} <span>·</span> Due {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(invoice.dueAt))}</p>
    {rank > 0 && <details className="why-details"><summary>Why this needs attention</summary><ul>{ranked.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><small>{ranked.uncertainty}</small><small>Source record: {recommendation ? recommendation.sourceRecord : invoice.source.recordId}</small>{recommendation && <div className="recommendation"><strong>Recommended steps</strong><ol>{recommendation.steps.map((step) => <li key={step}>{step}</li>)}</ol><dl>{recommendation.evidence.map((item) => <Fragment key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></Fragment>)}</dl><small>Needs your approval first. Revenue OS never sends a message or contacts a customer by itself, and the estimate is not money collected.</small></div>}</details>}
    {rank > 0 && <p className="next-step"><strong>Next step:</strong> {ranked.nextAction}</p>}
    {progress === 'none' ? <button className="button button-secondary recovery-draft-button" type="button" onClick={onPropose} disabled={proposing}>{proposing ? 'Saving draft…' : 'Draft reminder'}</button> : <button className="button button-secondary recovery-draft-button" type="button" onClick={onViewActions}>View in Actions ({progress})</button>}{controls}</div><div className="opportunity-values"><strong>{formatMoney(opportunity.outstanding)}</strong><small>outstanding</small><span>Est. {formatMoney(opportunity.estimate.low)}</span></div></article>
}

const statusOrder: Record<RecoveryAction['status'], number> = { approved: 0, proposed: 1, executed: 2, failed: 3, cancelled: 4 }

function RecoveryActions({ owners, members, onAssign, actions, invoices, loading, busyId, notice, noticeIsError, onTransition }: { owners: Map<string, string | null>; members: { userId: string; email: string }[]; onAssign: (actionId: string, ownerId: string | null) => Promise<string>; actions: RecoveryAction[]; invoices: InvoiceEvidence[]; loading: boolean; busyId: string; notice: string; noticeIsError: boolean; onTransition: (action: RecoveryAction, transition: 'approve' | 'mark_sent' | 'cancel') => void }) {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  return <section className="panel recovery-actions-panel">
    <div className="panel-heading"><div><h2>Recovery action queue</h2><p>Review the draft, approve it, then send it yourself outside Revenue OS.</p></div><span className="status-pill">{actions.filter((action) => action.status === 'proposed' || action.status === 'approved').length} pending</span></div>
    {notice && <div className={'alert ' + (noticeIsError ? 'alert-error' : 'alert-success')} role={noticeIsError ? 'alert' : 'status'}>{notice}</div>}
    {loading ? <div className="empty-state compact"><h3>Loading actions…</h3><p>Retrieving saved recovery drafts.</p></div> : actions.length === 0 ? <div className="empty-state compact"><span className="empty-icon"><Icon name="check" /></span><h3>No recovery drafts yet</h3><p>Go to Opportunities and choose Draft reminder for an overdue invoice.</p></div> : <div className="recovery-action-list">{[...actions].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]).map((action) => {
      const invoice = invoiceById.get(action.invoiceId)
      const busy = busyId === action.id
      return <article className="recovery-action-card" key={action.id}>
        <div className="recovery-action-top"><div><strong>{invoice ? invoice.customerName : action.recipientCustomerId}</strong><small>{invoice ? 'Invoice ' + invoice.invoiceNumber : 'Invoice record unavailable'} · Created {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(action.proposedAt))}</small></div><span className={'action-status action-status-' + action.status}>{actionStatusLabel(action.status)}</span></div>
        {invoice && <p className="action-context">Outstanding {formatMoney(money(invoice.total.amount - invoice.paid.amount, invoice.total.currency))} of {formatMoney(invoice.total)} · {daysOverdue(invoice.dueAt, new Date().toISOString())} day(s) past due. <strong>Next step:</strong> {action.status === 'proposed' ? 'review the draft and approve it.' : action.status === 'approved' ? 'send it yourself, then record that it was sent.' : action.status === 'executed' ? 'import payment evidence in Outcomes and check for a match.' : 'no further step.'}</p>}
        <p className="recovery-message">{action.message}</p>
        <div className="recovery-action-controls">
          {(action.status === 'proposed' || action.status === 'approved') && <label className="inline-select"><span>Owner </span><select aria-label={`Owner of the reminder for ${invoice ? invoice.invoiceNumber : action.invoiceId}`} value={owners.get(action.id) ?? ''} onChange={(event) => void onAssign(action.id, event.target.value || null).then((message) => { if (message) window.alert(message) })}><option value="">Nobody yet</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.email}</option>)}</select></label>}
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


function RecoveryOutcomes({ actions, invoices, outcomes, loading, busyId, notice, noticeIsError, issues, moneyPosition, promises, fileRef, onImport, onVerify }: {
  actions: RecoveryAction[]
  invoices: InvoiceEvidence[]
  outcomes: VerifiedOutcome[]
  loading: boolean
  busyId: string
  notice: string
  noticeIsError: boolean
  issues: CsvIssue[]
  moneyPosition: MoneyPosition[]
  promises: { opportunity: RevenueOpportunity; assessment: PromiseAssessment }[]
  fileRef: { current: HTMLInputElement | null }
  onImport: (file?: File) => void
  onVerify: (action: RecoveryAction) => void
}) {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const outcomeByAction = new Map(outcomes.map((outcome) => [outcome.actionId, outcome]))
  const executedActions = actions.filter((action) => action.status === 'executed')
  return <div className="outcomes-workspace">
    <section className="panel money-position-panel" aria-labelledby="money-position-title">
      <div className="panel-heading"><div><h2 id="money-position-title">Where the money stands</h2><p>Each line means something different and they are never added together. Only payment records and matched outcomes are money actually received.</p></div></div>
      {moneyPosition.length === 0 ? <div className="empty-state compact"><h3>No financial records yet</h3><p>Import invoices and payment evidence to see outstanding, promised and received amounts here.</p></div> : moneyPosition.map((position) => <dl className="money-position" key={position.currency} aria-label={position.currency + ' money position'}>
        <div><dt>Outstanding <small>(from your invoice records)</small></dt><dd>{formatMoney(position.outstanding)}</dd></div>
        <div><dt>Overdue and being worked <small>(open issues)</small></dt><dd>{formatMoney(position.overdue)}</dd></div>
        <div><dt>Dismissed but still unpaid</dt><dd>{formatMoney(position.dismissedUnpaid)}</dd></div>
        <div><dt>Estimated recoverable <small>(assumption, not a prediction)</small></dt><dd>{formatMoney(position.estimated)}</dd></div>
        <div><dt>Promised by customers <small>(not money received)</small></dt><dd>{formatMoney(position.promised)}</dd></div>
        <div><dt>Payment evidence recorded <small>(imported payments)</small></dt><dd>{formatMoney(position.paymentEvidence)}</dd></div>
        <div><dt>Verified after a sent reminder <small>(observed, not proven caused)</small></dt><dd>{formatMoney(position.verified)}</dd></div>
      </dl>)}
    </section>
    <section className="panel promises-panel" aria-labelledby="promises-title">
      <div className="panel-heading"><div><h2 id="promises-title">Customer promises vs payment evidence</h2><p>A promise is only what the customer said. It is checked against imported payment records received after it was recorded.</p></div><span className="status-pill">{promises.length}</span></div>
      {promises.length === 0 ? <div className="empty-state compact"><h3>No open promises</h3><p>Record a promise from an issue in Urgent or Opportunities and it will be tracked here.</p></div> : <div className="recovery-action-list">{promises.map(({ opportunity, assessment }) => <article className="recovery-action-card" key={opportunity.id}>
        <div className="recovery-action-top"><div><strong>{opportunity.evidence[0].customerName}</strong><small>Invoice {opportunity.evidence[0].invoiceNumber}</small></div><span className={'action-status promise-status-' + assessment.status}>{assessment.status === 'kept' ? 'Evidence received' : assessment.status === 'partly_kept' ? 'Partly received' : assessment.status === 'broken' ? 'Not received' : 'Awaiting'}</span></div>
        <p className="action-context">{assessment.label}</p>
      </article>)}</div>}
    </section>
    <section className="panel outcomes-import-panel">
      <div className="panel-heading"><div><h2>Import payment evidence</h2><p>Use a payment export from your accounting or payment system. Revenue OS does not invent or infer payments.</p></div><span className="status-pill">Source records</span></div>
      <div className="payment-import-content">
        <p className="payment-csv-format"><strong>Required CSV columns</strong><code>invoice_number,payment_reference,currency,amount,received_at</code><small>Each payment reference should be unique within its source. Invoice number and currency should match one saved invoice; payments that do not are kept in a review queue (Follow-ups → Payments to review), never discarded. Amounts use decimal notation, for example 125.50.</small></p>
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
