import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SupabaseSession } from '../lib/supabaseRest.ts'
import { disconnectProvider, startAuthorization, syncNow } from './api.ts'
import { describeConnection, formatAge, PROVIDERS, type ConnectionRow, type ProviderInfo } from './catalog.ts'

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
    {info.dependency && <p className="connection-dependency" role="note">{info.dependency}</p>}
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

export function ConnectionsPage({ session, organizationId, rows, statusError, refresh, sheetsControls, csvAction, invoiceCount }: Props) {
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeIsError, setNoticeIsError] = useState(false)
  const handledReturn = useRef(false)
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
    {statusError && <p className="connection-message" role="alert">Connection status could not be loaded: {statusError}</p>}
    {notice && <p className={noticeIsError ? 'connection-message' : 'connection-note'} role={noticeIsError ? 'alert' : 'status'}>{notice}</p>}
    <div className="connection-source-grid">
      {PROVIDERS.map((info) => {
        const row = info.id === 'gmail' || info.id === 'google_sheets' ? byProvider.get(info.id) : undefined
        if (info.id === 'csv') return <article className="connection-source-card" key={info.id} data-provider="csv" data-state="manual">
          <div className="connection-source-top"><h3>{info.name}</h3><span className={invoiceCount ? 'connection-pill connection-pill-ready' : 'connection-pill'}>{invoiceCount ? 'Data available' : 'Manual'}</span></div>
          <p>{info.summary}</p><small>{invoiceCount} invoice record(s) saved in this workspace.</small>{csvAction}</article>
        if (info.id === 'google_sheets') return <div key={info.id} className="connection-sheets-wrap" data-provider="google_sheets" data-state={describeConnection(byProvider.get('google_sheets')).state}>
          <SheetsAutomaticStatus row={byProvider.get('google_sheets')} busy={busy} onSync={() => void run('sync', async () => { await syncNow(session, organizationId, 'google_sheets'); say('Checking the spreadsheet now.') })} />
          {sheetsControls}</div>
        return <ProviderCard key={info.id} info={info} row={row} busy={busy}
          onConnect={() => void run('connect', async () => { window.location.assign(await startAuthorization(session, organizationId, info.id === 'gmail' ? 'gmail' : 'google_sheets')) })}
          onSync={() => void run('sync', async () => { await syncNow(session, organizationId, info.id); say('Synchronization started.') })}
          onDisconnect={() => { if (window.confirm('Disconnect Gmail? Revenue OS stops reading the mailbox and removes its stored access. Records already imported are kept.')) void run('disconnect', async () => { await disconnectProvider(session, organizationId, info.id); say('Gmail disconnected. Access was revoked at Google where possible.') }) }} />
      })}
    </div>
  </section>
}
