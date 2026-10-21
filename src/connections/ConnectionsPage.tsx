import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseSession } from '../lib/supabaseRest.ts'
import { disconnectProvider, loadReadiness, startAuthorization, syncNow, type ReadinessReport } from './api.ts'
import { describeConnection, formatAge, PROVIDERS, type ConnectionRow, type ProviderInfo } from './catalog.ts'
import { setupInProgress } from './landing.ts'

type Props = {
  session: SupabaseSession
  organizationId: string
  rows: ConnectionRow[] | null
  statusError: string
  refresh: () => Promise<ConnectionRow[] | null>
  /** The existing spreadsheet-specific controls (pick sheet, invoice tab, review queue). */
  sheetsControls: ReactNode
  csvAction: ReactNode
  invoiceCount: number
  onOpenOverview: () => void
}

function ProviderCard({ info, row, busy, onConnect, onSync, onDisconnect, extra }: {
  info: ProviderInfo; row: ConnectionRow | undefined; busy: string
  onConnect: () => void; onSync: () => void; onDisconnect: () => void; extra?: ReactNode
}) {
  const view = describeConnection(row)
  const unavailable = info.availability === 'external_approval_required'
  const manual = info.availability === 'manual'
  const pill = unavailable ? 'Needs provider approval' : manual ? 'Manual' : view.label
  const tone = view.state === 'connected' ? 'connection-pill connection-pill-ready' : 'connection-pill'
  return <article className="connection-source-card" data-provider={info.id} data-state={unavailable ? 'unavailable' : manual ? 'manual' : view.state}>
    <div className="connection-source-top"><h3>{info.name}</h3><span className={tone}>{pill}</span></div>
    <p>{info.summary}</p>
    <details className="connection-details"><summary>What it reads and what it is used for</summary>
      <strong>Revenue OS can read</strong><ul>{info.access.map((a) => <li key={a}>{a}</li>)}</ul>
      <strong>It is used to</strong><ul>{info.usedFor.map((u) => <li key={u}>{u}</li>)}</ul>
    </details>
    {info.dependency && <details className="connection-dependency-details" open={unavailable}><summary>{unavailable ? 'Why this is not available yet' : 'Requirements and limits'}</summary><p>{info.dependency}</p></details>}
    {!unavailable && !manual && view.state !== 'not_connected' && <>
      {row?.provider_account_email && <small>Account: {row.provider_account_email}</small>}
      {view.stage && <div className="sync-stage" role="status" aria-live="polite">
        <span>{view.stage}</span>
        {view.state === 'syncing' && <div className="sync-bar" role="progressbar" aria-label={view.stage ?? 'Synchronizing'}><span className="sync-bar-indeterminate" /></div>}
        {view.state === 'syncing' && Number(row?.records_synced) > 0 && <small>{Number(row?.records_synced).toLocaleString()} record{Number(row?.records_synced) === 1 ? '' : 's'} stored so far</small>}
      </div>}
      <small>Last successful sync: {formatAge(row?.last_successful_sync_at ?? null)}{row?.next_sync_at && view.state === 'connected' ? ' · next automatic check shortly' : ''}</small>
      {view.message && <p className="connection-message" role="alert">{view.message}</p>}
    </>}
    {extra}
    <div className="connection-actions">
      {unavailable && <button className="button button-secondary" type="button" disabled>Not available yet</button>}
      {manual && info.id === 'csv' && null}
      {!unavailable && !manual && (view.action === 'connect' || view.action === 'reconnect') && <button className="button button-primary" type="button" disabled={busy !== ''} onClick={onConnect}>{busy === 'connect' ? 'Opening Google…' : view.action === 'reconnect' ? `Reconnect ${info.name.split(' ')[0]}` : `Connect ${info.name.split(' ')[0]}`}</button>}
      {!unavailable && !manual && view.action === 'sync_now' && info.id === 'gmail' && <button className="button button-secondary" type="button" disabled={busy !== ''} onClick={onSync}>{busy === 'sync' ? 'Starting…' : 'Sync now'}</button>}
      {!unavailable && !manual && view.state !== 'not_connected' && info.id === 'gmail' && <button className="template-link" type="button" disabled={busy !== ''} onClick={onDisconnect}>Disconnect</button>}
    </div>
  </article>
}

function SheetsAutomaticStatus({ row, busy, onSync }: { row: ConnectionRow | undefined; busy: string; onSync: () => void }) {
  const view = describeConnection(row)
  if (view.state === 'not_connected') return null
  return <div className="sync-stage sheets-auto-status" role="status" aria-live="polite" data-testid="sheets-auto-status">
    <strong>Automatic sync</strong>
    <span>{view.stage ?? view.label}</span>
    {view.state === 'syncing' && <div className="sync-bar" role="progressbar" aria-label={view.stage ?? 'Synchronizing'}><span className="sync-bar-indeterminate" /></div>}
    <small>Last successful check: {formatAge(row?.last_successful_sync_at ?? null)}. Once a tab is chosen, Revenue OS re-checks the sheet by itself and only re-imports when it changed.</small>
    {view.message && <p className="connection-message" role="alert">{view.message}</p>}
    {(view.action === 'sync_now') && <button className="template-link" type="button" disabled={busy !== ''} onClick={onSync}>Check now</button>}
  </div>
}

/** Three honest steps. Each is marked done only from recorded state; step 3 unlocks only after a synchronization really completed. */
function SetupSteps({ rows, onOpenOverview }: { rows: ConnectionRow[] | null; onOpenOverview: () => void }) {
  const views = (rows ?? []).map(describeConnection)
  const connected = views.some((v) => v.state !== 'not_connected')
  const syncing = views.some((v) => v.state === 'syncing' && !v.initialSyncDone)
  const synced = views.some((v) => v.initialSyncDone)
  const step = (n: number, title: string, text: string, done: boolean, active: boolean) => <li className={done ? 'done' : active ? 'active' : ''} aria-current={active ? 'step' : undefined}>
    <span className="setup-step-number" aria-hidden="true">{done ? '✓' : n}</span><div><strong>{title}</strong><small>{text}</small></div></li>
  return <section className="setup-steps" aria-label="Setup progress" data-testid="setup-steps">
    <ol>
      {step(1, 'Connect', 'Choose Gmail or your invoice spreadsheet and approve access.', connected, !connected)}
      {step(2, 'First synchronization', syncing ? 'Running now. You can leave this page; it continues.' : synced ? 'Complete.' : 'Starts as soon as a source is connected.', synced, connected && !synced)}
      {step(3, 'See your Overview', synced ? 'Ready: your Overview now shows what was synchronized.' : 'Unlocks when the first synchronization completes.', false, synced)}
    </ol>
    {synced && <button className="button button-primary" type="button" onClick={onOpenOverview}>Open your Overview</button>}
  </section>
}

const CHECK_LABELS: Record<string, string> = {
  google_client_id: 'Google client ID is set', google_client_secret: 'Google client secret is set', token_encryption_key_valid: 'Token encryption key is set and valid (64 hex characters)',
  app_origin_matches_this_request: 'APP_ORIGIN matches this site', supabase_url: 'Supabase URL is set', supabase_anon_key: 'Supabase publishable key is set', supabase_service_role_key: 'Supabase service key is set (server only)',
}
const BACKGROUND_TEXT: Record<ReadinessReport['background_sync']['status'], string> = {
  no_connection_to_observe: 'Cannot be checked yet: connect a source first.', waiting_for_first_sync: 'Waiting for the first synchronization to finish.',
  running: 'Running: a connected source was checked recently without anyone opening the app.', not_observed_recently: 'Not observed recently: check that the Cloudflare cron trigger is deployed (Worker → Settings → Triggers).',
}
/** For the person setting up the product: what the deployed server has configured, without ever showing a secret. */
function SetupCheck({ session, organizationId }: { session: SupabaseSession; organizationId: string }) {
  const [report, setReport] = useState<ReadinessReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function run() { setBusy(true); setError(''); try { setReport(await loadReadiness(session, organizationId)) } catch (cause) { setError(cause instanceof Error ? cause.message : 'The setup check failed.') } finally { setBusy(false) } }
  return <details className="connection-details setup-check"><summary>Server setup check (for the person setting this up)</summary>
    <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Run setup check'}</button>
    {error && <p className="connection-message" role="alert">{error}</p>}
    {report && <div data-testid="setup-check-report">
      <ul>{Object.entries(report.checks).map(([key, ok]) => <li key={key} data-ok={ok}>{ok ? '✓' : '✗'} {CHECK_LABELS[key] ?? key}</li>)}</ul>
      <p>Register this exact redirect URI in Google Cloud: <code>{report.google_redirect_uri_to_register}</code></p>
      <p>Checks every {report.sync_interval_minutes} min · up to {report.message_budget_per_run} emails per run</p>
      <p>Background sync: {BACKGROUND_TEXT[report.background_sync.status]}{report.background_sync.newest_successful_sync_minutes_ago !== null ? ` (last success ${report.background_sync.newest_successful_sync_minutes_ago} min ago)` : ''}</p>
    </div>}
  </details>
}

export function ConnectionsPage({ session, organizationId, rows, statusError, refresh, sheetsControls, csvAction, invoiceCount, onOpenOverview }: Props) {
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeIsError, setNoticeIsError] = useState(false)
  const handledReturn = useRef(false)
  // Remember, for this visit, whether setup was unfinished when the page first loaded, so the steps stay visible through completion.
  const [startedIncomplete, setStartedIncomplete] = useState<boolean | null>(null)
  useEffect(() => { if (startedIncomplete === null && rows !== null) queueMicrotask(() => setStartedIncomplete(setupInProgress(rows))) }, [rows, startedIncomplete])
  const byProvider = new Map((rows ?? []).map((row) => [row.provider, row]))

  const say = (text: string, error = false) => { setNotice(text); setNoticeIsError(error) }

  // Returning from Google: confirm what actually happened, then start the first synchronization.
  useEffect(() => {
    if (handledReturn.current) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('connection') !== 'gmail') return
    handledReturn.current = true
    const result = params.get('result')
    window.history.replaceState({}, '', window.location.pathname)
    void (async () => {
      await Promise.resolve()
      if (result !== 'connected') { say('Gmail authorization did not complete, so nothing was connected. You can try again.', true); return }
      say('Gmail authorization succeeded. Starting the first synchronization…')
      try { await refresh(); await syncNow(session, organizationId, 'gmail'); say('Synchronization started. You can leave this page — it continues in the background.') }
      catch (cause) { say(cause instanceof Error ? cause.message : 'Could not start synchronization.', true) }
      finally { await refresh() }
    })()
  }, [session, organizationId, refresh])

  async function run(name: string, task: () => Promise<void>) {
    setBusy(name); say('')
    try { await task() } catch (cause) { say(cause instanceof Error ? cause.message : 'That did not work.', true) } finally { setBusy(''); await refresh() }
  }

  return <section className="panel connections-page" aria-labelledby="connections-title">
    <div className="panel-heading"><div><h2 id="connections-title">Connect your business once</h2>
      <p>Revenue OS reads the tools you already use, keeps them up to date, and shows what needs your attention. A source only shows as connected after you authorize it, and nothing is sent to your customers.</p></div></div>
    {startedIncomplete && <SetupSteps rows={rows} onOpenOverview={onOpenOverview} />}
    {statusError && <p className="connection-message" role="alert">Connection status could not be loaded: {statusError}</p>}
    {notice && <p className={noticeIsError ? 'connection-message' : 'connection-note'} role={noticeIsError ? 'alert' : 'status'}>{notice}</p>}
    <div className="connection-source-grid">
      {PROVIDERS.map((info) => {
        const row = info.id === 'gmail' || info.id === 'google_sheets' ? byProvider.get(info.id) : undefined
        if (info.id === 'csv') return null
        if (info.id === 'google_sheets') return <div key={info.id} className="connection-sheets-wrap" data-provider="google_sheets" data-state={describeConnection(byProvider.get('google_sheets')).state}>
          <SheetsAutomaticStatus row={byProvider.get('google_sheets')} busy={busy} onSync={() => void run('sync', async () => { await syncNow(session, organizationId, 'google_sheets'); say('Checking the spreadsheet now.') })} />
          {sheetsControls}</div>
        return <ProviderCard key={info.id} info={info} row={row} busy={busy}
          onConnect={() => void run('connect', async () => { window.location.assign(await startAuthorization(session, organizationId, info.id === 'gmail' ? 'gmail' : 'google_sheets')) })}
          onSync={() => void run('sync', async () => { await syncNow(session, organizationId, info.id); say('Synchronization started.') })}
          onDisconnect={() => { if (window.confirm('Disconnect Gmail? Revenue OS stops reading the mailbox and removes its stored access. Records already imported are kept.')) void run('disconnect', async () => { await disconnectProvider(session, organizationId, info.id); say('Gmail disconnected. Access was revoked at Google where possible.') }) }} />
      })}
    </div>
    <section className="fallback-import" aria-labelledby="fallback-title" data-provider="csv" data-state="manual">
      <h3 id="fallback-title">No account to connect?</h3>
      <p>Upload an invoice file instead. This is a manual fallback: it is read once and does not update by itself, so connecting a source above is better.</p>
      <small>{invoiceCount} invoice record(s) saved in this workspace.</small>
      {csvAction}
    </section>
    <SetupCheck session={session} organizationId={organizationId} />
  </section>
}
